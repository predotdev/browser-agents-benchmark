// Regenerate the pre.dev SIDE of the canonical head-to-head from a fresh
// accuracy_bench run, keeping the Browser Use Cloud 2026-05-08 baseline
// untouched. Writes a new results dir so the original snapshot is preserved.
// Usage: node regen_predev_side.mjs <runDumpJson> <newDirName>
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';

const dump = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const newDir = process.argv[3];
const SRC = 'results/2026-05-08T14-48-59';
const tasks = JSON.parse(readFileSync('tasks.json', 'utf8'));
const TASKS = (Array.isArray(tasks) ? tasks : tasks.tasks);
const nameById = new Map(TASKS.map((t, i) => [i + 1, t.name]));

// Fresh per-task results keyed by taskName. credits → client $ at 0.1 $/credit.
const fresh = new Map();
for (const x of dump) {
	const name = nameById.get(x.id);
	const credits = x.creditsUsed || 0;
	fresh.set(name, {
		success: !!x.grade?.success,
		successReason: x.grade?.reason || '',
		wallTimeMs: x.durationMs || 0,
		creditsUsed: credits,
		totalCostUsd: credits * 0.1,
		data: x.data,
	});
}

const summary = JSON.parse(readFileSync(join(SRC, 'summary.json'), 'utf8'));
let patched = 0;
for (const r of summary.results) {
	if (r.configId !== 'predev') continue; // keep BU baseline as-is
	const f = fresh.get(r.taskName);
	if (!f) { console.warn('no fresh result for', r.taskName); continue; }
	r.success = f.success;
	r.successReason = f.successReason;
	r.wallTimeMs = f.wallTimeMs;
	r.creditsUsed = f.creditsUsed;
	r.totalCostUsd = f.totalCostUsd;
	r.data = f.data;
	patched++;
}
summary.runStamp = '2026-06-22 · pre.dev refresh';
summary.predevRefreshedAt = '2026-06-22';
summary.browserUseBaseline = '2026-05-08';

// New dir: copy the whole source (keeps BU per-task files), then overwrite
// predev summary + predev per-task files with fresh data.
const dir = join('results', newDir);
mkdirSync(dir, { recursive: true });
cpSync(SRC, dir, { recursive: true });
writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));

for (const r of summary.results) {
	if (r.configId !== 'predev') continue;
	const perTask = {
		configId: 'predev', tool: 'predev', model: r.model,
		taskName: r.taskName, taskUrl: r.taskUrl,
		success: r.success, successReason: r.successReason,
		wallTimeMs: r.wallTimeMs, data: r.data,
		creditsUsed: r.creditsUsed, totalCostUsd: r.totalCostUsd, trace: [],
	};
	writeFileSync(join(dir, 'predev', `${r.taskName}.json`), JSON.stringify(perTask, null, 2));
}

const pd = summary.results.filter(r => r.configId === 'predev');
const pass = pd.filter(r => r.success).length;
const avgT = pd.reduce((s, r) => s + r.wallTimeMs, 0) / pd.length / 1000;
const totC = pd.reduce((s, r) => s + r.totalCostUsd, 0);
console.log(`patched ${patched} predev entries → ${dir}`);
console.log(`predev: ${pass}/100  avg=${avgT.toFixed(1)}s  $/task=$${(totC / pd.length).toFixed(4)}  $total=$${totC.toFixed(2)}`);
