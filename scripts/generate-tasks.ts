/**
 * One-time generator: convert the canonical browser-tasks suite to a
 * self-contained `tasks.json` so this repo can be cloned and run without
 * the sibling browser-tasks repo.
 *
 * Usage (only when the upstream task suite changes):
 *   tsx scripts/generate-tasks.ts
 *
 * Requires `../browser-tasks` to be cloned at the same parent level (only
 * during regeneration — not during normal benchmark runs).
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TASKS as RAW_TASKS } from '../../browser-tasks/benchmarks/tasks/index.js';

function zodToJsonSchema(schema: any): any {
	if (!schema || typeof schema !== 'object') return undefined;
	// Zod v4: schema.def.type is a string like 'object', 'string', etc.
	const t = schema.def?.type ?? schema._def?.type;
	if (t === 'object') {
		const shape = schema.shape || schema.def?.shape || {};
		const properties: Record<string, any> = {};
		const required: string[] = [];
		for (const [key, val] of Object.entries(shape)) {
			const v: any = val;
			const innerType = v?.def?.type ?? v?._def?.type;
			const isOptional = innerType === 'optional' || innerType === 'nullable';
			const inner = isOptional
				? v.def?.innerType ?? v._def?.innerType ?? v
				: v;
			properties[key] = zodToJsonSchema(inner);
			if (!isOptional) required.push(key);
		}
		return { type: 'object', properties, ...(required.length ? { required } : {}) };
	}
	if (t === 'array') {
		const itemType = schema.def?.element ?? schema._def?.element ?? schema.def?.type;
		return { type: 'array', items: zodToJsonSchema(itemType) };
	}
	if (t === 'string') return { type: 'string' };
	if (t === 'number') return { type: 'number' };
	if (t === 'boolean') return { type: 'boolean' };
	if (t === 'any' || t === 'unknown') return {};
	if (t === 'union') {
		const opts = schema.def?.options ?? schema._def?.options;
		return zodToJsonSchema(opts?.[0]);
	}
	if (t === 'literal') {
		return { const: schema.def?.value ?? schema._def?.value };
	}
	if (t === 'optional' || t === 'nullable') {
		return zodToJsonSchema(schema.def?.innerType ?? schema._def?.innerType);
	}
	if (t === 'enum') {
		return { enum: schema.def?.entries ?? schema._def?.values };
	}
	return {};
}

const out = (RAW_TASKS as any[]).map((t) => ({
	name: t.name,
	url: t.url,
	instruction: t.instruction,
	input: t.variables || t.input,
	output: t.output ? zodToJsonSchema(t.output) : t.schema ? zodToJsonSchema(t.schema) : undefined,
	timeoutMs: t.timeoutMs,
	// successCheck is a function — we serialize a stringified body so the
	// runner can rebuild it via `new Function`. The function takes a single
	// `result` object and returns { success: boolean, reason: string }.
	successCheckSrc: t.successCheck ? t.successCheck.toString() : undefined,
}));

const path = join(import.meta.dirname || '.', '..', 'tasks.json');
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(`Wrote ${path} — ${out.length} tasks`);
