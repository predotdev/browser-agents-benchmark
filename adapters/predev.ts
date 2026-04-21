/**
 * pre.dev REST API adapter.
 *
 *   POST /browser-agent            async: true → { id }
 *   GET  /browser-agent/:id/stream SSE; task_result fires when done
 *   GET  /browser-agent/:id        poll fallback if SSE is unavailable
 *
 * Env:
 *   PREDEV_API_KEY  — solo userId or enterprise org API key
 *   PREDEV_API_URL  — default https://api.pre.dev
 */

import type { BenchmarkResult, BenchmarkTask } from '../types.js';

const TOOL = 'predev' as const;
const MODEL = 'gemini-2.5-flash-lite';
const POLL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 180_000;

export interface PredevConfig {
	configId: string;
	apiUrl?: string;
}

export async function runPredev(
	task: BenchmarkTask,
	cfg: PredevConfig,
): Promise<BenchmarkResult> {
	const t0 = Date.now();
	const apiKey = process.env.PREDEV_API_KEY;
	const apiUrl = cfg.apiUrl || process.env.PREDEV_API_URL || 'https://api.pre.dev';
	if (!apiKey) return failure(task, cfg, t0, 'PREDEV_API_KEY not set');

	const headers = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${apiKey}`,
	};
	const timeoutMs = task.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const deadline = t0 + timeoutMs;

	// 1. Submit (async → returns batch id).
	let batchId: string;
	try {
		const res = await fetch(`${apiUrl}/browser-agent`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				tasks: [
					{
						url: task.url,
						instruction: task.instruction,
						input: task.input,
						output: task.output,
					},
				],
				concurrency: 1,
				async: true,
			}),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			return failure(task, cfg, t0, `submit ${res.status}: ${body.slice(0, 200)}`);
		}
		batchId = ((await res.json()) as any).id;
	} catch (err: any) {
		return failure(task, cfg, t0, err?.message || String(err));
	}

	// 2. Prefer SSE (task_result fires the instant the row hits `completed`
	//    in Mongo — which is now the runner's own doneAt timestamp, so
	//    there's no teardown-tail bleed). Fall back to polling if the
	//    stream never connects.
	const result =
		(await readSseResult(`${apiUrl}/browser-agent/${batchId}/stream`, headers, deadline)) ??
		(await pollResult(`${apiUrl}/browser-agent/${batchId}`, headers, deadline));

	const wallTimeMs = Date.now() - t0;
	if (!result) {
		return failure(task, cfg, t0, `timeout after ${timeoutMs}ms`, batchId);
	}

	const success = result.status === 'SUCCESS';
	const checked = task.successCheck?.({
		configId: cfg.configId,
		tool: TOOL,
		model: MODEL,
		taskName: task.name,
		taskUrl: task.url,
		success,
		wallTimeMs,
		data: result.data,
		totalCostUsd: 0,
	});

	return {
		configId: cfg.configId,
		tool: TOOL,
		model: MODEL,
		taskName: task.name,
		taskUrl: task.url,
		success: checked?.success ?? success,
		successReason: checked?.reason,
		wallTimeMs,
		data: result.data,
		error: success ? undefined : result.error ?? result.status,
		creditsUsed: result.creditsUsed ?? 0,
		totalCostUsd: (result.creditsUsed ?? 0) * 0.1, // 1 credit ≈ $0.10
		trace: normaliseEvents(result.events ?? []),
	};
}

// ── SSE reader ───────────────────────────────────────────────────────────

interface ResultPayload {
	status: string;
	data?: any;
	creditsUsed?: number;
	error?: string;
	events?: any[];
}

async function readSseResult(
	url: string,
	headers: Record<string, string>,
	deadline: number,
): Promise<ResultPayload | null> {
	const ac = new AbortController();
	const remaining = deadline - Date.now();
	if (remaining <= 0) return null;
	const timer = setTimeout(() => ac.abort(), remaining);

	try {
		const res = await fetch(url, {
			headers: { ...headers, Accept: 'text/event-stream' },
			signal: ac.signal,
		});
		if (!res.ok || !res.body) return null;

		for await (const ev of parseSseStream(res.body)) {
			if (ev.event === 'task_result' || ev.event === 'done') {
				const payload = safeJson(ev.data);
				if (!payload) continue;
				// `done` on an already-terminal batch carries just
				// { status: 'completed' } with no result — fall through to
				// poll in that case. `task_result` always carries the full
				// per-task payload.
				const r = payload.results?.[0] ?? payload;
				if (r && (r.status || r.data || r.error)) return r;
			}
		}
		return null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Async generator that yields { event, data } pairs from an SSE stream. */
async function* parseSseStream(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let event = '';
	let data = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) return;
		buf += decoder.decode(value, { stream: true });
		let nl: number;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (line.startsWith('event: ')) event = line.slice(7).trim();
			else if (line.startsWith('data: ')) data = line.slice(6);
			else if (line === '' && event && data) {
				yield { event, data };
				event = '';
				data = '';
			}
		}
	}
}

// ── Polling fallback (used only if SSE can't connect) ────────────────────

async function pollResult(
	url: string,
	headers: Record<string, string>,
	deadline: number,
): Promise<ResultPayload | null> {
	while (Date.now() < deadline) {
		await sleep(POLL_MS);
		const res = await fetch(url, { headers }).catch(() => null);
		if (!res?.ok) continue;
		const batch = (await res.json().catch(() => null)) as any;
		if (!batch) continue;
		if (batch.status === 'completed' || batch.status === 'failed') {
			return batch.results?.[0] ?? null;
		}
	}
	return null;
}

// ── Event trace ──────────────────────────────────────────────────────────

const TRACE_EVENT_TYPES = new Set([
	'sandbox',
	'navigation',
	'screenshot',
	'plan',
	'action',
	'validation',
	'done',
]);

function normaliseEvents(events: any[]): any[] {
	return events
		.filter((e) => TRACE_EVENT_TYPES.has(e.type))
		.map(formatEvent);
}

function formatEvent(e: any): any {
	const d = e.data || {};
	const out: any = { t: e.timestamp, type: e.type, iter: e.iteration };

	switch (e.type) {
		case 'sandbox':
			out.title = 'sandbox started';
			return out;
		case 'navigation':
			out.title = `navigate → ${d.url || 'page'}`;
			return out;
		case 'screenshot':
			out.title = 'screenshot';
			if (d.url) out.screenshotUrl = d.url;
			else if (d.base64) out.screenshot = { mimeType: d.mimeType || 'image/jpeg', base64: d.base64 };
			return out;
		case 'plan': {
			const actions = Array.isArray(d.actions) ? d.actions : [];
			const extractedKeys =
				d.extracted && typeof d.extracted === 'object' ? Object.keys(d.extracted) : [];
			const hasExtracted = extractedKeys.length > 0;
			const bits = [
				d.done ? 'done' : null,
				hasExtracted
					? `extracted {${extractedKeys.join(', ')}}`
					: d.done
						? 'EXTRACTED PAYLOAD EMPTY'
						: null,
				actions.length > 0 ? `${actions.length} actions` : null,
			].filter(Boolean);
			out.title = `plan · ${bits.join(' · ')}${d.notes ? `: ${d.notes}` : ''}`;
			const actionLines = actions.map(
				(a: any) =>
					`${a.type}${a.selector ? ` ${a.selector}` : ''}${
						a.value ? ` = ${JSON.stringify(a.value).slice(0, 60)}` : ''
					}`,
			);
			const extractedLine = hasExtracted
				? `extracted: ${JSON.stringify(d.extracted).slice(0, 400)}`
				: '';
			const detail = [extractedLine, ...actionLines].filter(Boolean).join('\n');
			if (detail) out.detail = detail;
			return out;
		}
		case 'action':
			out.title = `action: ${d.type || 'step'} ${d.selector || ''}`.trim();
			if (d.error) out.detail = `ERROR: ${d.error}`;
			return out;
		case 'validation':
			out.title = d.ok ? 'schema validated ✓' : 'schema validation failed';
			return out;
		case 'done':
			out.title = 'done';
			return out;
		default:
			out.title = e.type;
			return out;
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────

function safeJson(s: string): any {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function failure(
	task: BenchmarkTask,
	cfg: PredevConfig,
	t0: number,
	error: string,
	batchId?: string,
): BenchmarkResult {
	return {
		configId: cfg.configId,
		tool: TOOL,
		model: MODEL,
		taskName: task.name,
		taskUrl: task.url,
		success: false,
		successReason: error,
		wallTimeMs: Date.now() - t0,
		error,
		totalCostUsd: 0,
		...(batchId ? { batchId } : {}),
	};
}
