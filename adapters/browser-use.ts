/**
 * browser-use Cloud adapter (cloud.browser-use.com).
 *
 * Uses the official `browser-use-sdk` v3 client. Returns authoritative
 * cost numbers (totalCostUsd, llmCostUsd, browserCostUsd, totalInput/Output
 * Tokens) so we don't have to estimate.
 *
 * Default model `bu-mini` (= gemini-3-flash) keeps the comparison fair —
 * we benchmark cheap-tier vs cheap-tier across all three tools.
 *
 * Env:
 *   BROWSER_USE_API_KEY
 */

import { BrowserUse } from 'browser-use-sdk/v3';
import type { BenchmarkResult, BenchmarkTask } from '../types.js';

const TOOL = 'browser-use-cloud' as const;
const DEFAULT_MODEL = 'bu-mini';

export interface BrowserUseConfig {
	configId: string;
	model?: string;
}

export async function runBrowserUse(
	task: BenchmarkTask,
	cfg: BrowserUseConfig,
): Promise<BenchmarkResult> {
	const t0 = Date.now();
	const apiKey = process.env.BROWSER_USE_API_KEY;
	const model = cfg.model || DEFAULT_MODEL;
	if (!apiKey) {
		return errorResult(task, cfg, model, t0, 'BROWSER_USE_API_KEY not set');
	}

	const client = new BrowserUse({ apiKey });
	const fullTask = `${task.instruction}\n\nStart by navigating to: ${task.url}`;
	let sessionId: string | null = null;

	// Rate-limit backoff — browser-use Cloud 429s under concurrent fan-out.
	// Wait until a slot opens so we don't half-ass the benchmark by marking
	// rate-limited tasks as errored.
	const RATE_LIMIT_RE = /\b429\b|rate.?limit|too many|quota|concurrent/i;
	const timeoutMs = task.timeoutMs ?? 240_000;

	let response: any = null;
	let error: string | undefined;
	const deadline = Date.now() + timeoutMs;
	let backoff = 2_000;
	while (true) {
		try {
			const remaining = deadline - Date.now();
			if (remaining <= 0) { error = 'TIMEOUT'; break; }
			// Pass the task's JSON Schema as outputSchema so browser-use
			// returns structured data matching the same contract pre.dev
			// receives. Without this, pre.dev gets schema-guided extraction
			// while browser-use doesn't — which is the kind of asymmetry a
			// head-to-head bench must avoid.
			const runOptions: any = { llm: model };
			if (task.output) runOptions.outputSchema = task.output;
			const runHandle: any = (client as any).run(fullTask, runOptions);
			response = await Promise.race([
				runHandle,
				new Promise((_, rej) =>
					setTimeout(() => rej(new Error('TIMEOUT')), remaining),
				),
			]);
			sessionId = runHandle.sessionId ?? response?.sessionId ?? null;
			break;
		} catch (err: any) {
			const msg = err?.message || String(err);
			if (!RATE_LIMIT_RE.test(msg) || Date.now() >= deadline) {
				error = msg;
				break;
			}
			const wait = Math.min(backoff, deadline - Date.now());
			if (wait <= 0) { error = msg; break; }
			console.log(`  [browser-use] rate-limited (${msg.slice(0,80)}); waiting ${wait}ms`);
			await new Promise((r) => setTimeout(r, wait));
			backoff = Math.min(backoff * 1.5, 15_000);
		}
	}

	// Capture the per-step trace (agent messages + screenshots) before
	// screenshotUrls expire. Official SDK: client.sessions.messages(sessionId).
	// Screenshot URLs are presigned and valid for 5 minutes, so we download
	// them now and inline as base64 in the saved trace.
	let trace: any[] = [];
	if (sessionId) {
		try {
			trace = await fetchBrowserUseTrace(client, sessionId);
		} catch (err: any) {
			console.log(`  [browser-use] trace fetch failed (non-fatal): ${err?.message || err}`);
		}
	}

	const wallTimeMs = Date.now() - t0;

	const llmCostUsd = Number(response?.llmCostUsd ?? 0);
	const browserCostUsd = Number(response?.browserCostUsd ?? 0);
	const proxyCostUsd = Number(response?.proxyCostUsd ?? 0);
	const totalCostUsd = Number(
		response?.totalCostUsd ?? llmCostUsd + browserCostUsd + proxyCostUsd,
	);

	let data: any;
	if (response?.output) {
		data = parseOutput(response.output);
	}

	const checked = task.successCheck
		? task.successCheck({
				configId: cfg.configId,
				tool: TOOL,
				model,
				taskName: task.name,
				taskUrl: task.url,
				success: !error && data != null,
				wallTimeMs,
				data,
				totalCostUsd,
			})
		: null;

	return {
		configId: cfg.configId,
		tool: TOOL,
		model,
		taskName: task.name,
		taskUrl: task.url,
		success: checked ? checked.success : !error && data != null,
		successReason: checked?.reason,
		wallTimeMs,
		data,
		error,
		inputTokens: Number(response?.totalInputTokens ?? 0),
		outputTokens: Number(response?.totalOutputTokens ?? 0),
		totalCostUsd,
		trace,
	};
}

/** Fetch the session's full message list (paginated) and reshape it
 *  into our TraceEntry[] format. Screenshots are downloaded in parallel
 *  while their presigned URLs are still valid (5-min window). */
async function fetchBrowserUseTrace(client: any, sessionId: string): Promise<any[]> {
	const all: any[] = [];
	let cursor: string | undefined;
	for (let i = 0; i < 20; i++) {
		const page = await client.sessions.messages(sessionId, cursor ? { after: cursor, limit: 100 } : { limit: 100 });
		const msgs = page?.messages ?? [];
		all.push(...msgs);
		if (!page?.hasMore || msgs.length === 0) break;
		cursor = msgs[msgs.length - 1].id;
	}
	// Filter noise: drop the initial user-message + hidden system messages.
	// The rest (browser_action, browser_action_result, planning, completion)
	// map to our trace types.
	const interesting = all.filter(
		(m) => !m.hidden && m.messageType !== 'user_message',
	);
	// Download screenshots (5-min presigned URLs) now, store inline b64.
	const withShots = await Promise.all(
		interesting.map(async (m, idx) => {
			let screenshot: { mimeType: string; base64: string } | undefined;
			if (m.screenshotUrl) {
				try {
					const res = await fetch(m.screenshotUrl);
					if (res.ok) {
						const buf = Buffer.from(await res.arrayBuffer());
						screenshot = { mimeType: res.headers.get('content-type') || 'image/png', base64: buf.toString('base64') };
					}
				} catch {}
			}
			const typeMap: Record<string, string> = {
				browser_action: 'action',
				browser_action_result: 'action',
				browser_action_error: 'action',
				planning: 'plan',
				completion: 'done',
				assistant_message: 'plan',
			};
			const mappedType = typeMap[m.messageType] || m.messageType || 'step';
			const title = (m.summary || m.content || '').slice(0, 160);
			return {
				t: m.createdAt ? new Date(m.createdAt).getTime() : idx,
				type: mappedType,
				title: title || m.messageType,
				detail: (!m.summary && m.content) ? String(m.content).slice(0, 400) : undefined,
				screenshot,
			};
		}),
	);
	return withShots;
}

function parseOutput(output: any): any {
	if (typeof output === 'object') return output;
	if (typeof output !== 'string') return output;
	const trimmed = output.trim();
	try {
		return JSON.parse(trimmed);
	} catch {}
	const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) {
		try {
			return JSON.parse(fence[1].trim());
		} catch {}
	}
	const objMatch = trimmed.match(/\{[\s\S]*\}/);
	if (objMatch) {
		try {
			return JSON.parse(objMatch[0]);
		} catch {}
	}
	return output;
}

function errorResult(
	task: BenchmarkTask,
	cfg: BrowserUseConfig,
	model: string,
	t0: number,
	error: string,
): BenchmarkResult {
	return {
		configId: cfg.configId,
		tool: TOOL,
		model,
		taskName: task.name,
		taskUrl: task.url,
		success: false,
		successReason: error,
		wallTimeMs: Date.now() - t0,
		error,
		totalCostUsd: 0,
	};
}
