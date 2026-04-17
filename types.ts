/** Core types for the head-to-head benchmark. */

export interface BenchmarkTask {
	name: string;
	url: string;
	instruction: string;
	/** Optional per-row inputs (for tasks like "search for {query}"). */
	input?: Record<string, string>;
	/** Optional JSON-Schema describing the structured output. Forwarded to
	 *  every adapter that supports schema-guided extraction (pre.dev via
	 *  the `output` field, browser-use via `outputSchema`). */
	output?: any;
	/** Per-task hard timeout. */
	timeoutMs?: number;
	/** Predicate used to score success once each adapter returns. */
	successCheck?: (result: BenchmarkResult) => { success: boolean; reason: string };
}

export type Tool = 'predev' | 'browser-use-cloud';

export interface BenchmarkResult {
	configId: string;
	tool: Tool;
	model: string;
	taskName: string;
	taskUrl: string;

	success: boolean;
	successReason?: string;

	wallTimeMs: number;
	llmCalls?: number;
	inputTokens?: number;
	outputTokens?: number;

	data?: any;
	error?: string;

	totalCostUsd: number;
	creditsUsed?: number; // pre.dev specific

	/** Per-step trace: plans, actions, screenshots. Optional — only
	 *  providers that expose step-level telemetry populate this (pre.dev,
	 *  some browser-use sessions). Others leave it undefined. */
	trace?: TraceEntry[];
}

export interface TraceEntry {
	t?: number;
	type: string;
	iter?: number;
	title: string;
	detail?: string;
	screenshot?: { mimeType: string; base64: string };
	screenshotUrl?: string; // remote URL variant
}

export interface RunSummary {
	runStamp: string;
	startedAt: string;
	finishedAt: string;
	taskCount: number;
	configIds: string[];
	results: BenchmarkResult[];
}
