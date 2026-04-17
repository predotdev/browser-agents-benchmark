/**
 * pre.dev REST API adapter.
 *
 * Hits POST /browser-agent with `async: true`, then polls
 * GET /browser-agent/:id?includeEvents=true until completion.
 * Authenticates with `Authorization: Bearer <PREDEV_API_KEY>`.
 *
 * Env:
 *   PREDEV_API_KEY  — solo userId or enterprise org API key
 *   PREDEV_API_URL  — default: https://api.pre.dev
 */

import type { BenchmarkResult, BenchmarkTask } from '../types.js';

const TOOL = 'predev' as const;
const POLL_MS = 1500;

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
	if (!apiKey) {
		return errorResult(task, cfg, t0, 'PREDEV_API_KEY not set');
	}

	const headers = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${apiKey}`,
	};

	let batchId: string | undefined;
	let error: string | undefined;
	let data: any;
	let creditsUsed = 0;
	let durationMs = 0;
	let success = false;
	let successReason = '';
	let trace: any[] = [];

	try {
		const submitRes = await fetch(`${apiUrl}/browser-agent`, {
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
		if (!submitRes.ok) {
			const text = await submitRes.text().catch(() => '');
			throw new Error(`submit failed: ${submitRes.status} ${text.slice(0, 200)}`);
		}
		const submitJson = (await submitRes.json()) as any;
		batchId = submitJson.id as string;

		// Poll until done. Hard-cap by task.timeoutMs.
		const deadline = t0 + (task.timeoutMs ?? 120_000);
		while (true) {
			if (Date.now() > deadline) {
				error = `timeout after ${task.timeoutMs ?? 120_000}ms`;
				break;
			}
			await sleep(POLL_MS);
			const getRes = await fetch(
				`${apiUrl}/browser-agent/${batchId}?includeEvents=true`,
				{ headers },
			);
			if (!getRes.ok) {
				error = `poll failed: ${getRes.status}`;
				break;
			}
			const batch = (await getRes.json()) as any;
			if (batch.status === 'completed' || batch.status === 'failed') {
				const result = batch.results?.[0];
				if (result) {
					data = result.data;
					creditsUsed = result.creditsUsed || 0;
					durationMs = result.durationMs || 0;
					// Surface the runner's terminal status as part of error
					// when not SUCCESS so downstream retry logic can detect
					// BLOCKED/CAPTCHA without depending on a free-form
					// error string that may be null.
					if (result.error) error = result.error;
					else if (result.status && result.status !== 'SUCCESS') error = result.status;
					success = result.status === 'SUCCESS';
					if (Array.isArray(result.events)) trace = normaliseEvents(result.events);
				} else {
					error = batch.error || 'no result';
				}
				break;
			}
		}
	} catch (err: any) {
		error = err?.message || String(err);
	}

	const wallTimeMs = Date.now() - t0;

	const checked = task.successCheck
		? task.successCheck({
				configId: cfg.configId,
				tool: TOOL,
				model: 'gemini-2.5-flash-lite',
				taskName: task.name,
				taskUrl: task.url,
				success,
				wallTimeMs,
				data,
				totalCostUsd: 0,
			})
		: null;

	return {
		configId: cfg.configId,
		tool: TOOL,
		model: 'gemini-2.5-flash-lite',
		taskName: task.name,
		taskUrl: task.url,
		success: checked ? checked.success : success,
		successReason: checked?.reason,
		wallTimeMs,
		data,
		error,
		creditsUsed,
		// 1 credit ≈ $0.10 in pre.dev's standard pricing
		totalCostUsd: creditsUsed * 0.1,
		trace,
	};
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

/** Turn raw RunnerEvent[] into the compact trace shape consumed by the
 *  report: { t, type, iter, title, detail?, screenshot? }. Infrastructure
 *  lifecycle events (sandbox spin-up, fallback, error summaries) are
 *  filtered out — the trace is meant to show what the agent did, not
 *  how the host ran. */
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
		.map((e) => {
		const base: any = {
			t: e.timestamp,
			type: e.type,
			iter: e.iteration,
		};
		const d = e.data || {};
		if (e.type === 'sandbox') {
			base.title = 'sandbox started';
		} else if (e.type === 'navigation') {
			base.title = `navigate → ${d.url || 'page'}`;
		} else if (e.type === 'screenshot') {
			base.title = 'screenshot';
			if (d.url) base.screenshotUrl = d.url;
			else if (d.base64) base.screenshot = { mimeType: d.mimeType || 'image/jpeg', base64: d.base64 };
		} else if (e.type === 'plan') {
			const actionCount = Array.isArray(d.actions) ? d.actions.length : 0;
			const extractedKeys = d.extracted && typeof d.extracted === 'object' ? Object.keys(d.extracted) : [];
			const hasExtracted = extractedKeys.length > 0;
			const stateBits = [
				d.done ? 'done' : undefined,
				hasExtracted ? `extracted {${extractedKeys.join(', ')}}` : d.done ? 'EXTRACTED PAYLOAD EMPTY' : undefined,
				actionCount > 0 ? `${actionCount} actions` : undefined,
			].filter(Boolean);
			base.title = `plan · ${stateBits.join(' · ')}${d.notes ? `: ${d.notes}` : ''}`;
			const actionLines = Array.isArray(d.actions)
				? d.actions.map((a: any) =>
						`${a.type}${a.selector ? ` ${a.selector}` : ''}${a.value ? ` = ${JSON.stringify(a.value).slice(0, 60)}` : ''}`,
					)
				: [];
			const extractedLine = hasExtracted
				? `extracted: ${JSON.stringify(d.extracted).slice(0, 400)}`
				: '';
			const detail = [extractedLine, ...actionLines].filter(Boolean).join('\n');
			if (detail) base.detail = detail;
		} else if (e.type === 'action') {
			base.title = `action: ${d.type || 'step'} ${d.selector || ''}`.trim();
			if (d.error) base.detail = `ERROR: ${d.error}`;
		} else if (e.type === 'validation') {
			base.title = d.ok ? 'schema validated ✓' : 'schema validation failed';
		} else if (e.type === 'error') {
			base.title = `error: ${d.message || 'unknown'}`;
		} else if (e.type === 'done') {
			base.title = 'done';
		} else {
			base.title = e.type;
		}
		return base;
	});
}

function errorResult(
	task: BenchmarkTask,
	cfg: PredevConfig,
	t0: number,
	error: string,
): BenchmarkResult {
	return {
		configId: cfg.configId,
		tool: TOOL,
		model: 'gemini-2.5-flash-lite',
		taskName: task.name,
		taskUrl: task.url,
		success: false,
		successReason: error,
		wallTimeMs: Date.now() - t0,
		error,
		totalCostUsd: 0,
	};
}
