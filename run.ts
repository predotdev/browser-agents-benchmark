/**
 * Head-to-head benchmark runner.
 *
 * Runs the task suite × the configuration matrix and writes per-task JSON
 * + a summary file to results/<runStamp>/. After it finishes, run
 * `tsx report.ts <runStamp>` to generate REPORT.md + report.html.
 *
 * Usage:
 *   tsx run.ts                                  # all tasks, all configs
 *   tsx run.ts --limit 50                       # first 50 tasks
 *   tsx run.ts --task 01,02,03                  # specific task names (prefix match)
 *   tsx run.ts --config predev                  # specific config(s)
 *   tsx run.ts --parallel --concurrency 5       # 5 tasks at once per config
 *
 * Required env (load via .env or shell):
 *   PREDEV_API_KEY              — pre.dev API key (from pre.dev/projects/playground)
 *   BROWSER_USE_API_KEY         — cloud.browser-use.com API key
 *
 * Optional:
 *   PREDEV_API_URL              — default https://api.pre.dev
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Lightweight .env loader — no dotenv dep. Loads ./.env if present.
(() => {
	const envPath = join(process.cwd(), '.env');
	if (!existsSync(envPath)) return;
	const txt = readFileSync(envPath, 'utf-8');
	for (const line of txt.split('\n')) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
		if (!m) continue;
		const [, key, val] = m;
		if (process.env[key]) continue;
		process.env[key] = val.replace(/^['"](.*)['"]$/, '$1').trim();
	}
})();

import { TASKS } from './tasks.js';
import type { BenchmarkResult, RunSummary } from './types.js';
import { runPredev } from './adapters/predev.js';
import { runBrowserUse } from './adapters/browser-use.js';

type ConfigDef =
	| { id: string; tool: 'predev'; run: typeof runPredev; cfg: any }
	| { id: string; tool: 'browser-use'; run: typeof runBrowserUse; cfg: any };

const ALL_CONFIGS: ConfigDef[] = [
	{ id: 'predev', tool: 'predev', run: runPredev, cfg: { configId: 'predev' } },
	{
		id: 'browser-use-cloud',
		tool: 'browser-use',
		run: runBrowserUse,
		cfg: { configId: 'browser-use-cloud', model: 'bu-mini' },
	},
];

function getArg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
	return process.argv.includes(`--${name}`);
}

async function main() {
	const limit = parseInt(getArg('limit') || '0', 10);
	const taskFilter = getArg('task')?.split(',').map((s) => s.trim());
	const configFilter = getArg('config')?.split(',').map((s) => s.trim());
	const parallel = hasFlag('parallel');
	const concurrency = parseInt(getArg('concurrency') || '5', 10);

	let tasks = TASKS.slice();
	if (limit > 0) tasks = tasks.slice(0, limit);
	if (taskFilter?.length) {
		tasks = tasks.filter((t) =>
			taskFilter.some((f) => t.name.startsWith(f) || t.name === f),
		);
	}
	const configs = configFilter?.length
		? ALL_CONFIGS.filter((c) => configFilter.includes(c.id))
		: ALL_CONFIGS;

	if (tasks.length === 0) throw new Error('no tasks selected');
	if (configs.length === 0) throw new Error('no configs selected');

	const runStamp = new Date()
		.toISOString()
		.replace(/[:.]/g, '-')
		.slice(0, 19);
	const outDir = join('results', runStamp);
	mkdirSync(outDir, { recursive: true });

	console.log(
		`Run ${runStamp} — ${tasks.length} tasks × ${configs.length} configs = ${tasks.length * configs.length} runs`,
	);
	console.log(`Configs: ${configs.map((c) => c.id).join(', ')}`);
	console.log(`Mode: ${parallel ? `parallel (concurrency=${concurrency})` : 'sequential'}`);
	console.log('');

	const startedAt = new Date().toISOString();
	const results: BenchmarkResult[] = [];

	const runConfig = async (config: typeof configs[number]) => {
		mkdirSync(join(outDir, config.id), { recursive: true });
		const t0 = Date.now();
		console.log(`\n=== START ${config.id} ===`);

		const runOne = async (task: (typeof tasks)[number], idx: number) => {
			const start = Date.now();
			let r: BenchmarkResult;
			try {
				r = await (config.run as any)(task, config.cfg);
			} catch (err: any) {
				r = {
					configId: config.id,
					tool: config.id as any,
					model: 'unknown',
					taskName: task.name,
					taskUrl: task.url,
					success: false,
					successReason: err?.message,
					wallTimeMs: Date.now() - start,
					error: err?.message,
					totalCostUsd: 0,
				};
			}
			const elapsed = ((Date.now() - start) / 1000).toFixed(1);
			const mark = r.success ? '✓' : '✗';
			console.log(
				`  [${config.id}] [${idx + 1}/${tasks.length}] ${mark} ${task.name.padEnd(38)} ${elapsed.padStart(5)}s  $${r.totalCostUsd.toFixed(5)}  ${r.successReason || r.error || ''}`.slice(0, 180),
			);
			writeFileSync(
				join(outDir, config.id, `${task.name}.json`),
				JSON.stringify(r, null, 2),
			);
			results.push(r);
		};

		if (parallel) {
			const queue = tasks.map((t, i) => () => runOne(t, i));
			let next = 0;
			let active = 0;
			await new Promise<void>((resolve) => {
				const tick = () => {
					while (active < concurrency && next < queue.length) {
						const job = queue[next++];
						active++;
						job().finally(() => {
							active--;
							if (next >= queue.length && active === 0) resolve();
							else tick();
						});
					}
				};
				tick();
			});
		} else {
			for (let i = 0; i < tasks.length; i++) await runOne(tasks[i], i);
		}

		const okCount = results.filter(
			(r) => r.configId === config.id && r.success,
		).length;
		const totalUsd = results
			.filter((r) => r.configId === config.id)
			.reduce((s, r) => s + r.totalCostUsd, 0);
		const elapsedSec = Math.round((Date.now() - t0) / 1000);
		console.log(
			`=== DONE ${config.id}: ${okCount}/${tasks.length} pass, $${totalUsd.toFixed(4)}, ${elapsedSec}s wall ===`,
		);
	};

	await Promise.all(configs.map(runConfig));

	const summary: RunSummary = {
		runStamp,
		startedAt,
		finishedAt: new Date().toISOString(),
		taskCount: tasks.length,
		configIds: configs.map((c) => c.id),
		results: results.map(({ trace, ...rest }) => rest as any),
	};
	writeFileSync(
		join(outDir, 'summary.json'),
		JSON.stringify(summary, null, 2),
	);
	console.log(`\nWrote ${outDir}/summary.json`);
	console.log(`\nGenerate report: tsx report.ts ${runStamp}`);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error('Fatal:', err);
		process.exit(1);
	});
