// Merge a fresh Browser Use Cloud run (run.ts --config browser-use-cloud) into
// the pre.dev refresh, producing a clean SAME-DAY 2026-06-22 head-to-head:
// pre.dev side from results/2026-06-22-predev-refresh (run E), BU side from the
// fresh run. Both graded by the identical per-task successCheck verifier.
// Usage: node merge_fresh_bu.mjs <freshBuRunDirName> <newDirName>
import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const freshBuDir = join('results', process.argv[2]);
const PREDEV_REFRESH = 'results/2026-07-08-predev-refresh';
const newDir = join('results', process.argv[3]);

const buSummary = JSON.parse(readFileSync(join(freshBuDir, 'summary.json'), 'utf8'));
const freshBu = buSummary.results.filter((r) => r.configId === 'browser-use-cloud');
if (freshBu.length === 0) throw new Error('no browser-use-cloud results in ' + freshBuDir);

const summary = JSON.parse(readFileSync(join(PREDEV_REFRESH, 'summary.json'), 'utf8'));
// Keep predev entries; replace BU entries with the fresh run, keyed by taskName.
const freshByName = new Map(freshBu.map((r) => [r.taskName, r]));
const predevEntries = summary.results.filter((r) => r.configId === 'predev');
const mergedBu = predevEntries.map((p) => freshByName.get(p.taskName)).filter(Boolean);
summary.results = [...predevEntries, ...mergedBu];
summary.runStamp = '2026-07-08 head-to-head';
delete summary.predevRefreshedAt;
delete summary.browserUseBaseline;
summary.headToHeadDate = '2026-07-08';

// New dir: start from the predev-refresh (keeps fresh predev per-task files),
// then overwrite the BU per-task files from the fresh run.
mkdirSync(newDir, { recursive: true });
cpSync(PREDEV_REFRESH, newDir, { recursive: true });
// wipe + repopulate browser-use-cloud per-task files from the fresh run
for (const f of readdirSync(join(freshBuDir, 'browser-use-cloud'))) {
	if (!f.endsWith('.json')) continue;
	cpSync(join(freshBuDir, 'browser-use-cloud', f), join(newDir, 'browser-use-cloud', f));
}
writeFileSync(join(newDir, 'summary.json'), JSON.stringify(summary, null, 2));

const stat = (id) => {
	const rs = summary.results.filter((r) => r.configId === id);
	const pass = rs.filter((r) => r.success).length;
	const avgT = rs.reduce((s, r) => s + r.wallTimeMs, 0) / rs.length / 1000;
	const totC = rs.reduce((s, r) => s + (r.totalCostUsd || 0), 0);
	return `${id}: ${pass}/${rs.length}  avg=${avgT.toFixed(1)}s  $/task=$${(totC / rs.length).toFixed(4)}  $total=$${totC.toFixed(2)}`;
};
console.log('merged →', newDir);
console.log(stat('predev'));
console.log(stat('browser-use-cloud'));
