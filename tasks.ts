/**
 * Loads the bundled task suite from `tasks.json`.
 *
 * The original `successCheck` arrow functions from the source repo are
 * serialized as strings (`successCheckSrc`) and rehydrated here via
 * `new Function`. That keeps this repo self-contained and reproducible —
 * no external repo dependencies at run time.
 *
 * Regenerate `tasks.json` only when the upstream suite changes:
 *   tsx scripts/generate-tasks.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchmarkTask } from './types.js';

interface RawTask {
	name: string;
	url: string;
	instruction: string;
	input?: Record<string, string>;
	output?: any;
	timeoutMs?: number;
	successCheckSrc?: string;
}

const here = fileURLToPath(import.meta.url);
const dir = here.replace(/[^/]+$/, '');
const raw: RawTask[] = JSON.parse(
	readFileSync(join(dir, 'tasks.json'), 'utf-8'),
);

/** Helpers referenced by the upstream successCheck closures. We inject
 *  them into each rehydrated function's scope so the original arrow-fn
 *  source compiles cleanly. Keep in sync with browser-tasks/benchmarks/
 *  tasks/index.ts. */
const HELPERS_SRC = `
function findArray(obj) {
  if (Array.isArray(obj)) return obj;
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) {
      const found = findArray(v);
      if (found) return found;
    }
  }
  return null;
}
function findValue(obj, predicate) {
  if (predicate(obj)) return obj;
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) {
      const found = findValue(v, predicate);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
function findStr(obj, sub) {
  return findValue(obj, (v) => typeof v === 'string' && v.toLowerCase().includes(sub.toLowerCase()));
}
`;

function rehydrateCheck(src?: string) {
	if (!src) return undefined;
	try {
		const fn = new Function(
			'result',
			`${HELPERS_SRC}\nreturn (${src})(result);`,
		) as (r: any) => { success: boolean; reason: string };
		return fn;
	} catch {
		return undefined;
	}
}

export const TASKS: BenchmarkTask[] = raw.map((t) => ({
	name: t.name,
	url: t.url,
	instruction: t.instruction,
	input: t.input,
	output: t.output,
	timeoutMs: t.timeoutMs,
	successCheck: rehydrateCheck(t.successCheckSrc),
}));
