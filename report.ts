/**
 * Generate REPORT.md (text) AND report.html (rich, with bar charts) from a
 * run's summary.json + optional judgements.json. The HTML version is
 * self-contained — no JS framework, no external CSS. ASCII-esque
 * monochrome styling on black background with white ink + pre.dev
 * branding baked in.
 *
 * Three metrics — QUALITY (0-100 judge score), SPEED (avg s/task),
 * COST ($/task). Composite score = quality × 0.60 + speed_norm × 0.20
 * + cost_norm × 0.20. The tl;dr ranks configs by the composite so
 * quality wins the weight but speed+cost still matter.
 *
 * Usage:
 *   tsx report.ts <runStamp>
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { BenchmarkResult, RunSummary, TraceEntry } from "./types.js";

// Load tasks.json once so per-task drilldowns can show the original
// instruction + expected output schema the judge validated against.
const TASKS: Array<{ name: string; url: string; instruction: string; output?: any }> =
	JSON.parse(readFileSync('tasks.json', 'utf-8'));
const TASK_BY_NAME = new Map(TASKS.map((t) => [t.name, t]));

interface JudgeEntry {
	taskName: string;
	instruction: string;
	scores: Record<string, { score: number; reason: string; success: boolean }>;
}
interface JudgeFile {
	runStamp: string;
	judgeMode?: string;
	judgements: JudgeEntry[];
	leaderboard: Array<{
		config: string;
		avgScore: number;
		wins: number;
		judged: number;
	}>;
}

interface ConfigStats {
	id: string;
	total: number;
	avgTimeS: number;
	avgCostUsd: number;
	totalCostUsd: number;
	// Quality = pass-rate %, where pass means judge score == 100.
	quality: number;
	qualitySource: "judge" | "runner-pass";
	passCount: number;
	judgedCount: number;
}

function statsByConfig(
	summary: RunSummary,
	judge: JudgeFile | null,
): ConfigStats[] {
	// Quality is now strictly pass/fail: a task "passes" when the judge
	// gives it a perfect 100 (all schema/count/field checks satisfied).
	// If no judge ran, fall back to the runner's own success flag.
	const base = summary.configIds.map((id) => {
		const cfgResults = summary.results.filter((r) => r.configId === id);
		const total = cfgResults.length;
		const avgT =
			cfgResults.reduce((s, r) => s + r.wallTimeMs, 0) / total / 1000;
		const totalCost = cfgResults.reduce((s, r) => s + r.totalCostUsd, 0);
		const avgCost = totalCost / total;
		let passCount = 0;
		let judgedCount = 0;
		let qualitySource: "judge" | "runner-pass" = "runner-pass";
		if (judge) {
			for (const j of judge.judgements) {
				const s = j.scores[id];
				if (!s) continue;
				judgedCount++;
				if (s.score >= 100) passCount++;
			}
			qualitySource = 'judge';
		}
		if (qualitySource === "runner-pass" || judgedCount === 0) {
			passCount = cfgResults.filter((r) => r.success).length;
			judgedCount = total;
			qualitySource = 'runner-pass';
		}
		const quality = judgedCount > 0 ? (passCount / judgedCount) * 100 : 0;
		return {
			id,
			total,
			avgTimeS: avgT,
			avgCostUsd: avgCost,
			totalCostUsd: totalCost,
			quality,
			qualitySource,
			passCount,
			judgedCount,
		};
	});

	// Rank by quality. Ties broken by lower cost, then faster time.
	return base.sort((a, b) => {
		if (b.quality !== a.quality) return b.quality - a.quality;
		if (a.avgCostUsd !== b.avgCostUsd) return a.avgCostUsd - b.avgCostUsd;
		return a.avgTimeS - b.avgTimeS;
	});
}

function loadPerTask(
	dir: string,
	configId: string,
	taskName: string,
): BenchmarkResult | null {
	const p = join(dir, configId, `${taskName}.json`);
	if (!existsSync(p)) return null;
	try {
		return JSON.parse(readFileSync(p, "utf-8")) as BenchmarkResult;
	} catch {
		return null;
	}
}

function main() {
	const runStamp = process.argv[2];
	if (!runStamp) {
		console.error("Usage: tsx report.ts <runStamp>");
		process.exit(1);
	}
	const dir = join("results", runStamp);
	const summary: RunSummary = JSON.parse(
		readFileSync(join(dir, "summary.json"), "utf-8"),
	);
	const judgePath = join(dir, "judgements.json");
	const judge: JudgeFile | null = existsSync(judgePath)
		? JSON.parse(readFileSync(judgePath, "utf-8"))
		: null;
	const stats = statsByConfig(summary, judge);
	// Preload per-task detail (data + trace) for every (config, task).
	// Done once so the HTML renderer doesn't re-read files per row.
	const perTaskFull: Record<string, Record<string, BenchmarkResult>> = {};
	const taskNames = Array.from(
		new Set(summary.results.map((r) => r.taskName)),
	).sort();
	for (const t of taskNames) {
		perTaskFull[t] = {};
		for (const c of summary.configIds) {
			const full = loadPerTask(dir, c, t);
			if (full) perTaskFull[t][c] = full;
		}
	}

	writeFileSync(join(dir, "REPORT.md"), renderMarkdown(summary, stats, judge));
	console.log(`Wrote ${dir}/REPORT.md`);

	writeFileSync(
		join(dir, "report.html"),
		renderHtml(summary, stats, judge, perTaskFull),
	);
	console.log(`Wrote ${dir}/report.html`);
}

// ── MARKDOWN ──────────────────────────────────────────────────

function renderMarkdown(
	summary: RunSummary,
	stats: ConfigStats[],
	judge: JudgeFile | null,
): string {
	const leader = stats[0] ?? null;
	const lines: string[] = [];
	lines.push(`# Benchmark Report — ${summary.runStamp}`);
	lines.push("");
	lines.push(`- **Tasks**: ${summary.taskCount}`);
	lines.push(`- **Configurations**: ${summary.configIds.join(", ")}`);
	lines.push(
		`- **Started**: ${summary.startedAt}  ·  **Finished**: ${summary.finishedAt}`,
	);
	lines.push(
		`- **Judge**: ${judge?.judgeMode || "runner-pass (no judge run)"}`,
	);
	lines.push("");

	lines.push("## Leaderboard (ranked by quality)");
	lines.push("");
	lines.push("| Config | Quality | Avg time/task | $/task | $ total |");
	lines.push("|---|---:|---:|---:|---:|");
	for (const s of stats) {
		const isLeader = leader && s.id === leader.id;
		const name = isLeader ? `**${s.id}** 🏆` : s.id;
		lines.push(
			`| ${name} | ${s.quality.toFixed(1)} | ${s.avgTimeS.toFixed(1)}s | $${s.avgCostUsd.toFixed(4)} | $${s.totalCostUsd.toFixed(2)} |`,
		);
	}
	lines.push("");

	if (judge) {
		lines.push("## Per-task scores");
		lines.push("");
		lines.push("| Task | " + summary.configIds.join(" | ") + " |");
		lines.push("|---" + summary.configIds.map(() => "|---:").join("") + "|");
		const byName = new Map(judge.judgements.map((j) => [j.taskName, j]));
		const taskNames = Array.from(
			new Set(summary.results.map((r) => r.taskName)),
		).sort();
		for (const name of taskNames) {
			const j = byName.get(name);
			const cells = summary.configIds
				.map((id) => {
					const s = j?.scores[id];
					return s ? `${s.score}` : "—";
				})
				.join(" | ");
			lines.push(`| ${name} | ${cells} |`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────
// HTML (black bg, white ink, ASCII-esque)
// ────────────────────────────────────────────────────────────────

function renderHtml(
	summary: RunSummary,
	stats: ConfigStats[],
	judge: JudgeFile | null,
	perTaskFull: Record<string, Record<string, BenchmarkResult>>,
): string {
	const leader = stats[0] ?? null;
	const leaderId = leader?.id;
	const taskCount = summary.taskCount;

	const radar = renderRadar(stats, leaderId);
	const headlineTable = renderHeadlineTable(stats, leaderId);
	const perTaskDrill = renderTaskDrilldowns(
		summary,
		judge,
		perTaskFull,
		leaderId,
	);

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>browser-agents-benchmark · ${esc(summary.runStamp)}</title>
  <link rel="icon" href="https://pre.dev/favicon.ico" />
  <style>
    :root { --ink:#f5f5f4; --paper:#000; --mute:#888; --rule:#f5f5f4; --dim:#1a1a1a; --accent:#f5f5f4; }
    * { box-sizing: border-box; }
    html, body { background: var(--paper); color: var(--ink); }
    body {
      margin: 0; padding: 36px 24px 80px;
      font: 13.5px/1.55 "JetBrains Mono", "SF Mono", "IBM Plex Mono", ui-monospace, Menlo, monospace;
      -webkit-font-smoothing: antialiased;
    }
    main { max-width: 1080px; margin: 0 auto; }
    a { color: var(--ink); }

    /* pre.dev branded header */
    .brand {
      display: flex; align-items: center; justify-content: space-between;
      border-top: 2px solid var(--ink); border-bottom: 1px solid var(--ink);
      padding: 14px 0; margin-bottom: 28px;
    }
    .brand .left { display: flex; align-items: center; gap: 14px; }
    .brand img { height: 26px; display: block; filter: invert(0); }
    .brand .title { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--mute); }
    .brand .right { font-size: 11px; color: var(--mute); letter-spacing: 0.1em; text-transform: uppercase; }

    h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }
    h2 { font-size: 11px; font-weight: 600; margin: 36px 0 14px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--ink); border-bottom: 1px solid var(--rule); padding-bottom: 6px; }
    p, li { color: var(--ink); }

    .meta { color: var(--mute); margin-bottom: 18px; font-size: 12px; }
    .meta code { background: var(--dim); padding: 2px 6px; border: 1px solid #2a2a2a; }


    table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e1e1e; vertical-align: middle; }
    th { color: var(--mute); font-weight: 500; text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.12em; border-bottom: 2px solid var(--ink); }
    th.num { text-align: right; }
    td.num, th.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.num { text-align: right; }
    tr.leader td { background: #131313; font-weight: 600; }

    .provider { display: inline-flex; align-items: center; gap: 10px; line-height: 1; }
    .provider .providerName { white-space: nowrap; }
    .providerMark { width: 18px; height: 18px; display: block; object-fit: contain; flex: 0 0 18px; border-radius: 2px; background: #111; }
    .providerMark.placeholder { background: #222; }
    /* Headline table: tight column widths for the numerics, provider
       column flexes to fill remaining space so the logo+name sits on
       the left and numbers pack tightly on the right. */
    table.headline { table-layout: auto; }
    table.headline th:first-child, table.headline td:first-child { width: 100%; }
    table.headline th:not(:first-child), table.headline td:not(:first-child) { padding-left: 28px; white-space: nowrap; }
    .methodology { color: var(--mute); font-size: 12px; margin: 14px 0 0; max-width: 760px; line-height: 1.55; }

    /* radar sits centred, borderless, below the leaderboard. No
       surrounding card/frame — the ascii/ink aesthetic prefers the
       chart to breathe in the background. */
    .radarSection { margin: 24px auto 8px; display: flex; justify-content: center; }
    .radarInner { display: flex; flex-direction: column; align-items: center; gap: 4px; }
    .radarSvg { display: block; width: 100%; max-width: 560px; height: auto; }
    .radarLegendRow { display: flex; flex-wrap: wrap; gap: 16px; font-size: 10.5px; color: var(--ink); justify-content: center; letter-spacing: 0.03em; margin-bottom: 4px; }
    .radarLegendItem { display: inline-flex; align-items: center; gap: 6px; }
    .radarDot { width: 12px; height: 3px; display: inline-block; border-radius: 1px; }


    details.drill { border: 1px solid #1e1e1e; margin-bottom: 6px; }
    details.drill[open] { border-color: var(--ink); }
    details.drill summary { cursor: pointer; padding: 8px 12px; font-size: 12px; display: flex; justify-content: space-between; gap: 12px; list-style: none; }
    details.drill summary::-webkit-details-marker { display: none; }
    details.drill summary::before { content: "[+]"; color: var(--mute); font-size: 10px; }
    details.drill[open] summary::before { content: "[−]"; }
    details.drill .body { padding: 10px 16px 14px; border-top: 1px dotted #2a2a2a; font-size: 12px; background: #0a0a0a; }
    details.drill .body dl { margin: 0; display: grid; grid-template-columns: 170px 1fr; row-gap: 6px; column-gap: 16px; }
    details.drill .body dt { color: var(--mute); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; }
    details.drill .body dd { margin: 0; }

    .foot { margin-top: 48px; padding-top: 14px; border-top: 1px solid var(--ink); color: var(--mute); font-size: 11px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 12px; letter-spacing: 0.08em; text-transform: uppercase; }

    /* per-task drilldowns */
    details.taskDrill { border: 1px solid #1e1e1e; margin-bottom: 6px; background: #050505; }
    details.taskDrill[open] { border-color: var(--ink); }
    details.taskDrill summary { cursor: pointer; padding: 10px 14px; font-size: 12px; list-style: none; display: flex; justify-content: space-between; gap: 16px; align-items: center; flex-wrap: wrap; }
    details.taskDrill summary::-webkit-details-marker { display: none; }
    details.taskDrill summary::before { content: "[+]"; color: var(--mute); font-size: 10px; margin-right: 6px; }
    details.taskDrill[open] summary::before { content: "[−]"; }
    .drillName { font-weight: 600; white-space: nowrap; }

    /* Task drill layout: compact spec on top (URL+instruction inline,
       schema hidden in a nested details), agent cards stacked below.
       Keeps the drawer tight regardless of schema size. */
    .taskInside { padding: 12px 14px 16px; border-top: 1px dotted #222; display: flex; flex-direction: column; gap: 12px; }
    .taskSpec { background: #060606; padding: 10px 12px; border: 1px solid #1a1a1a; display: flex; flex-direction: column; gap: 6px; font-size: 11.5px; }
    .taskSpecRow { display: grid; grid-template-columns: 90px 1fr; gap: 10px; align-items: baseline; }
    .taskSpecKey { color: var(--mute); text-transform: uppercase; letter-spacing: 0.1em; font-size: 10.5px; }
    .taskSpecVal { color: var(--ink); word-break: break-word; }
    .taskSpecVal a { color: var(--ink); text-decoration: underline; text-decoration-color: #555; }
    details.schemaDetails > summary { cursor: pointer; color: var(--mute); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.1em; list-style: none; }
    details.schemaDetails > summary::-webkit-details-marker { display: none; }
    details.schemaDetails > summary::before { content: "[+] expected output"; }
    details.schemaDetails[open] > summary::before { content: "[−] expected output"; }
    details.schemaDetails .code { margin-top: 6px; max-height: 260px; }

    .taskBody { display: grid; gap: 8px; align-content: start; }

    /* Compact provider pills in each task row summary. Stacked so each
       one fits on its own line on narrow screens. */
    .pillGroup { display: inline-flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; max-width: 100%; }
    .resultPill { display: inline-flex; align-items: center; gap: 8px; padding: 5px 10px; background: #0a0a0a; border: 1px solid #222; border-radius: 2px; font-size: 11.5px; white-space: nowrap; }
    .resultPill.pass { border-color: #2e2e2e; }
    .resultPill.fail { border-color: #402020; }
    .resultPill.dash { opacity: 0.6; }
    .pillName { color: var(--ink); }
    .pillBadge { font-size: 10px; padding: 1px 6px; letter-spacing: 0.06em; border: 1px solid currentColor; }
    .pillBadge.pass { color: var(--ink); }
    .pillBadge.fail { color: #e88; }
    .pillBadge.dash { color: #666; border-color: #333; }
    .pillMeta { color: var(--mute); font-size: 11px; font-variant-numeric: tabular-nums; }

    details.agentCard { border: 1px solid #222; background: #0a0a0a; }
    details.agentCard[open] { border-color: var(--ink); }
    details.agentCard > summary { display: flex; justify-content: space-between; gap: 12px; padding: 8px 12px; font-size: 12px; align-items: center; flex-wrap: wrap; cursor: pointer; list-style: none; }
    details.agentCard > summary::-webkit-details-marker { display: none; }
    details.agentCard > summary::before { content: "[+]"; color: var(--mute); font-size: 10px; margin-right: 4px; }
    details.agentCard[open] > summary::before { content: "[−]"; }
    details.agentCard[open] > summary { border-bottom: 1px solid #222; }
    details.agentCard .agentName { font-weight: 600; }
    details.agentCard .agentBadges { display: inline-flex; gap: 6px; align-items: center; }
    .badge { font-size: 10px; padding: 2px 6px; border: 1px solid #333; letter-spacing: 0.06em; }
    .badge.ok { border-color: var(--ink); color: var(--ink); }
    .badge.fail { border-color: #6a2a2a; color: #c88; }
    .badge.judge { border-color: #555; color: #ccc; }
    .meta { color: var(--mute); font-size: 11px; }
    .agentBody { padding: 10px 12px 14px; font-size: 12px; }
    .subhead { color: var(--mute); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.12em; margin: 8px 0 4px; }
    .code { background: #000; border: 1px solid #222; padding: 8px; font-size: 11.5px; white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; color: var(--ink); }
    .code.err { border-color: #5a2020; color: #e88; }
    .judgeReason { padding: 6px 8px; background: #111; border: 1px dashed #333; font-size: 11.5px; color: var(--ink); }
    .traceEmpty { color: #666; font-size: 11.5px; padding: 6px 0; font-style: italic; }

    ol.traceList { list-style: none; padding: 0; margin: 0; counter-reset: evt; }
    ol.traceList > li { counter-increment: evt; padding: 6px 8px 8px 32px; border-bottom: 1px dotted #1a1a1a; position: relative; }
    ol.traceList > li::before { content: counter(evt, decimal-leading-zero); position: absolute; left: 8px; top: 8px; color: #666; font-size: 10.5px; }
    .evtHead { display: flex; gap: 10px; align-items: baseline; font-size: 11.5px; }
    .evtHead .evtTs { color: #666; font-size: 10.5px; min-width: 44px; font-variant-numeric: tabular-nums; }
    .evtHead .evtType { color: var(--mute); font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; min-width: 80px; }
    .evtHead .evtTitle { color: var(--ink); }
    .evtDetail { margin: 4px 0 0; padding: 6px 8px; background: #000; border: 1px solid #1e1e1e; font-size: 11px; white-space: pre-wrap; color: #bbb; }
    img.evtShot { display: block; margin-top: 6px; max-width: 100%; border: 1px solid var(--ink); }
    .evt-error .evtTitle { color: #e88; }
  </style>
</head>
<body>
  <main>
    <header class="brand">
      <div class="left">
        <img src="https://pre.dev/predev_logo_name.png" alt="pre.dev" />
        <span class="title">browser-agents-benchmark</span>
      </div>
      <div class="right">run ${esc(summary.runStamp)}</div>
    </header>

    <h1>head-to-head · ${summary.taskCount} browser tasks</h1>

    <h2>leaderboard</h2>
    ${headlineTable}
    <p class="methodology">Browser agents are stochastic — individual runs on cheap-tier models vary by a few tasks per suite. The full per-task JSON and trace for this run is committed so the data can be re-scored independently.</p>

    <div class="radarSection">${radar}</div>

    <h2>per-task analysis</h2>
    <div>${perTaskDrill}</div>

    <footer class="foot">
      <div>pre.dev labs · <a href="https://pre.dev/labs/browser-agents">browser-agents</a> · <a href="https://github.com/predotdev/browser-agents-benchmark">reproduce this run</a></div>
    </footer>
  </main>
</body>
</html>`;
}

function renderHeadlineTable(
	stats: ConfigStats[],
	leaderId: string | undefined,
): string {
	const thead = `<thead><tr><th>Provider</th><th class="num">Pass rate</th><th class="num">Avg time/task</th><th class="num">$/task</th><th class="num">$ total</th></tr></thead>`;
	const tbody = stats
		.map((s) => {
			const cls = s.id === leaderId ? "leader" : "norm";
			return `<tr class="${cls}"><td>${providerCell(s.id)}</td><td class="num">${s.passCount}/${s.judgedCount} (${s.quality.toFixed(0)}%)</td><td class="num">${s.avgTimeS.toFixed(1)}s</td><td class="num">$${s.avgCostUsd.toFixed(4)}</td><td class="num">$${s.totalCostUsd.toFixed(2)}</td></tr>`;
		})
		.join("");
	return `<table class="headline">${thead}<tbody>${tbody}</tbody></table>`;
}

function renderTaskDrilldowns(
	summary: RunSummary,
	judge: JudgeFile | null,
	perTaskFull: Record<string, Record<string, BenchmarkResult>>,
	leaderId: string | undefined,
): string {
	const taskNames = Array.from(
		new Set(summary.results.map((r) => r.taskName)),
	).sort();
	const byName = judge
		? new Map(judge.judgements.map((j) => [j.taskName, j]))
		: null;
	// Find instruction + expected output schema for each task. Prefer
	// the judge file (always writes these) then fall back to any full
	// per-task result.
	const meta = new Map<string, { instruction?: string; output?: any; url?: string }>();
	if (judge) {
		for (const j of judge.judgements) {
			meta.set(j.taskName, { instruction: j.instruction });
		}
	}
	for (const t of taskNames) {
		const existing = meta.get(t) || {};
		const sample = summary.results.find((r) => r.taskName === t);
		meta.set(t, { ...existing, url: sample?.taskUrl });
	}

	return taskNames
		.map((name) => {
			const judgeEntry = byName?.get(name);
			const m = meta.get(name);
			const heading = renderTaskDrillHeading(
				name,
				summary,
				judgeEntry || null,
				leaderId,
			);
			const taskSpec = renderTaskSpec(name, m, perTaskFull[name]);
			const perAgent = summary.configIds
				.map((id) =>
					renderAgentCard(
						id,
						name,
						perTaskFull[name]?.[id],
						judgeEntry || null,
						id === leaderId,
					),
				)
				.join("");
			return `<details class="taskDrill"><summary>${heading}</summary><div class="taskInside">${taskSpec}<div class="taskBody">${perAgent}</div></div></details>`;
		})
		.join("");
}

function renderTaskSpec(
	taskName: string,
	meta: { instruction?: string; url?: string } | undefined,
	_perConfig: Record<string, BenchmarkResult> | undefined,
): string {
	const t = TASK_BY_NAME.get(taskName);
	const instruction = meta?.instruction || t?.instruction;
	const url = meta?.url || t?.url;
	const outputSchema = t?.output;
	const urlBlock = url
		? `<div class="taskSpecRow"><span class="taskSpecKey">url</span><span class="taskSpecVal"><a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(url)}</a></span></div>`
		: '';
	const instrBlock = instruction
		? `<div class="taskSpecRow"><span class="taskSpecKey">instruction</span><span class="taskSpecVal">${esc(instruction)}</span></div>`
		: '';
	// Schema gets its own collapsible section — it's the tallest element
	// and dominates vertical space when always visible.
	const schemaBlock = outputSchema
		? `<details class="schemaDetails"><summary></summary><pre class="code">${esc(JSON.stringify(outputSchema, null, 2))}</pre></details>`
		: '';
	if (!instrBlock && !urlBlock && !schemaBlock) return '';
	return `<div class="taskSpec">${urlBlock}${instrBlock}${schemaBlock}</div>`;
}

function renderTaskDrillHeading(
	taskName: string,
	summary: RunSummary,
	judgeEntry: JudgeEntry | null,
	_leaderId: string | undefined,
): string {
	const pills = summary.configIds
		.map((id) => {
			const d = providerDisplay(id);
			const logo = d.logo
				? `<img class="providerMark" src="${esc(d.logo)}" alt="" />`
				: '<span class="providerMark placeholder"></span>';
			const r = summary.results.find(
				(rr) => rr.configId === id && rr.taskName === taskName,
			);
			let pass = !!r?.success;
			if (judgeEntry) {
				const s = judgeEntry.scores[id];
				if (s) pass = s.score >= 100;
				else if (!r) return `<span class="resultPill dash">${logo}<span class="pillName">${esc(d.name)}</span><span class="pillBadge dash">—</span></span>`;
			}
			const time = r ? `${(r.wallTimeMs / 1000).toFixed(1)}s` : '—';
			const cost = r ? `$${(r.totalCostUsd || 0).toFixed(4)}` : '—';
			return `<span class="resultPill ${pass ? 'pass' : 'fail'}" title="${esc(d.name)}">
				${logo}
				<span class="pillBadge ${pass ? 'pass' : 'fail'}">${pass ? 'PASS' : 'FAIL'}</span>
				<span class="pillMeta">${time} · ${cost}</span>
			</span>`;
		})
		.join('');
	return `<span class="drillName">${esc(taskName)}</span><span class="pillGroup">${pills}</span>`;
}

function renderAgentCard(
	configId: string,
	taskName: string,
	full: BenchmarkResult | undefined,
	judgeEntry: JudgeEntry | null,
	isLeader: boolean,
): string {
	const lead = isLeader ? "lead" : "";
	const providerHdr = providerCell(configId);
	if (!full) {
		return `<section class="agentCard ${lead}"><header>${providerHdr}</header><div class="agentBody"><em>no result file</em></div></section>`;
	}

	// PASS/FAIL + time + cost are already shown in the task-row pills
	// at the parent level. We intentionally omit them from this inner
	// summary to avoid duplication; the summary just announces which
	// provider this expandable section belongs to.
	const judgeScore = judgeEntry?.scores[configId]?.score;
	const pass = judgeScore !== undefined ? judgeScore >= 100 : !!full.success;

	const dataBlock =
		full.data !== undefined
			? `<div class="subhead">extracted</div><pre class="code">${esc(JSON.stringify(full.data, null, 2))}</pre>`
			: "";

	const errorBlock = full.error
		? `<div class="subhead">error</div><pre class="code err">${esc(full.error)}</pre>`
		: "";

	const reasonBit = judgeEntry?.scores[configId]?.reason && !pass
		? `<div class="subhead">why this failed</div><div class="judgeReason">${esc(judgeEntry.scores[configId].reason)}</div>`
		: '';

	const traceBlock = renderTrace(full.trace);

	return `<details class="agentCard ${lead}">
  <summary>${providerHdr}</summary>
  <div class="agentBody">
    ${reasonBit}
    ${dataBlock}
    ${errorBlock}
    ${traceBlock}
  </div>
</details>`;
}

const REPORT_TRACE_TYPES = new Set([
	'sandbox', 'navigation', 'screenshot', 'plan', 'action', 'validation', 'done',
	// browser-use message types
	'step',
]);

function renderTrace(trace: TraceEntry[] | undefined): string {
	if (!trace || trace.length === 0) {
		return '<div class="subhead">trace</div><div class="traceEmpty">provider did not expose step-level events</div>';
	}
	// Filter here too so older result files (written before the adapter
	// started filtering) don't show sandbox/fallback/infra events.
	trace = trace.filter((e) => REPORT_TRACE_TYPES.has(e.type));
	// Collapse runs of consecutive 'waiting' events into one — the CF
	// clearance loop emits one per poll, which adds 20-30 redundant
	// rows per task. Keep the first, suppress the rest, append count.
	const collapsed: TraceEntry[] = [];
	let pendingWait: TraceEntry | null = null;
	let waitCount = 0;
	for (const e of trace) {
		if (e.type === 'waiting') {
			if (!pendingWait) pendingWait = { ...e };
			waitCount++;
		} else {
			if (pendingWait) {
				pendingWait.title = `${pendingWait.title || 'waiting'} · ${waitCount}×`;
				collapsed.push(pendingWait);
				pendingWait = null;
				waitCount = 0;
			}
			collapsed.push(e);
		}
	}
	if (pendingWait) {
		pendingWait.title = `${pendingWait.title || 'waiting'} · ${waitCount}×`;
		collapsed.push(pendingWait);
	}
	trace = collapsed;
	// Show relative timestamps from the first event so readers can see the
	// cadence of the run (e.g. +0.0s, +1.6s, +9.0s) without having to
	// subtract epoch millis by hand.
	const t0 = trace.find((e) => e.t)?.t;
	const rows = trace
		.map((e) => {
			const typeClass = `evt evt-${esc(e.type)}`;
			const ts = t0 && e.t ? `T+${((e.t - t0) / 1000).toFixed(1)}s` : '';
			const cleanTitle = String(e.title || '').replace(/\s*\(chunk[^)]*\)/i, '');
			const detail = e.detail
				? `<pre class="evtDetail">${esc(e.detail)}</pre>`
				: '';
			const screenshot = e.screenshot
				? `<img class="evtShot" src="data:${esc(e.screenshot.mimeType)};base64,${e.screenshot.base64}" alt="screenshot" loading="lazy" />`
				: e.screenshotUrl
					? `<img class="evtShot" src="${esc(e.screenshotUrl)}" alt="screenshot" loading="lazy" />`
					: '';
			return `<li class="${typeClass}"><div class="evtHead"><span class="evtTs">${esc(ts)}</span><span class="evtType">${esc(e.type)}</span><span class="evtTitle">${esc(cleanTitle)}</span></div>${detail}${screenshot}</li>`;
		})
		.join('');
	return `<div class="subhead">trace (${trace.length} events)</div><ol class="traceList">${rows}</ol>`;
}

function renderDrilldowns(
	judge: JudgeFile,
	configIds: string[],
	leaderId: string | undefined,
): string {
	const sorted = [...judge.judgements].sort((a, b) =>
		a.taskName.localeCompare(b.taskName),
	);
	return sorted
		.map((j) => {
			const summaryBits = configIds
				.map((id) => {
					const s = j.scores[id];
					if (!s) return `<span style="color:#444">${esc(id)}:—</span>`;
					const mark = id === leaderId ? "▣" : "";
					const color = s.score >= 70 ? "var(--ink)" : "#888";
					return `<span style="color:${color}">${mark} ${esc(id)} ${s.score}</span>`;
				})
				.join("  ·  ");
			const body = configIds
				.map((id) => {
					const s = j.scores[id];
					if (!s) return "";
					return `<dt>${esc(id)}</dt><dd><strong>${s.score}/100</strong> · ${esc(s.reason)}</dd>`;
				})
				.join("");
			return `<details class="drill"><summary><span>${esc(j.taskName)}</span><span>${summaryBits}</span></summary><div class="body"><dl><dt>instruction</dt><dd>${esc(j.instruction)}</dd>${body}</dl></div></details>`;
		})
		.join("");
}

// ────────────────────────────────────────────────────────────────
// Radar chart — one shape per config, three axes (quality, speed,
// cost). All axes are normalised 0–100 with "higher = better" so the
// shape expands outward as the config gets closer to ideal.
//
//   quality  = quality score as-is (already 0–100)
//   speed    = 100 × (min_time / my_time)     (fastest = 100)
//   cost     = 100 × (min_cost / my_cost)     (cheapest = 100)
//
// Axes drawn as straight lines from the centre at 90°, 210°, 330°
// (quality on top, cost bottom-right, speed bottom-left). Rings at
// 25/50/75/100. The leader config gets a solid fill; the rest are
// hollow with dashed strokes.
// ────────────────────────────────────────────────────────────────

function renderRadar(stats: ConfigStats[], leaderId: string | undefined): string {
	if (stats.length === 0) return '<div class="traceEmpty">no data</div>';
	const size = 520;
	const pad = 80;
	const cx = size / 2;
	const cy = size / 2;
	const r = (size - pad * 2) / 2;
	// Best (lowest) wall-time and cost across providers — these are the
	// reference points that sit at the outer 100 ring so the axis labels
	// can show viewers what "100 = X" actually means.
	const bestTime = Math.min(...stats.map((s) => s.avgTimeS), Infinity);
	const bestCost = Math.min(
		...stats.map((s) => s.avgCostUsd).filter((c) => c > 0),
		Infinity,
	);
	const bestQuality = Math.max(...stats.map((s) => s.quality), 0);
	const axes = [
		{
			label: 'quality',
			sub: `best ${bestQuality.toFixed(1)}`,
			angle: -Math.PI / 2,
			norm: (s: ConfigStats) => s.quality,
		},
		{
			label: 'cost',
			sub: isFinite(bestCost) ? `best $${bestCost.toFixed(4)}/task` : '—',
			angle: -Math.PI / 2 + (2 * Math.PI) / 3,
			norm: (s: ConfigStats) =>
				s.avgCostUsd > 0 ? (bestCost / s.avgCostUsd) * 100 : 100,
		},
		{
			label: 'speed',
			sub: isFinite(bestTime) ? `best ${bestTime.toFixed(1)}s/task` : '—',
			angle: -Math.PI / 2 + (4 * Math.PI) / 3,
			norm: (s: ConfigStats) =>
				s.avgTimeS > 0 ? (bestTime / s.avgTimeS) * 100 : 100,
		},
	];
	const axisPt = (angle: number, pct: number) => {
		const dist = (r * pct) / 100;
		return { x: cx + Math.cos(angle) * dist, y: cy + Math.sin(angle) * dist };
	};
	const labelPt = (angle: number) => {
		const dist = r + 30;
		return { x: cx + Math.cos(angle) * dist, y: cy + Math.sin(angle) * dist };
	};

	// grid rings at 25/50/75/100
	const rings = [25, 50, 75, 100]
		.map((pct) => {
			const pts = axes.map((a) => axisPt(a.angle, pct));
			const d = pts
				.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
				.join(' ') + ' Z';
			return `<path d="${d}" fill="none" stroke="#2a2a2a" stroke-width="1" />`;
		})
		.join('');
	// axis spokes + labels (label + "best X" subtext on a second line)
	const spokes = axes
		.map((a) => {
			const p = axisPt(a.angle, 100);
			const l = labelPt(a.angle);
			return `<line x1="${cx}" y1="${cy}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" stroke="#3a3a3a" stroke-width="1" />
<text x="${l.x.toFixed(1)}" y="${l.y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" fill="#f5f5f4" font-size="11" letter-spacing="1.5">${a.label.toUpperCase()}</text>
<text x="${l.x.toFixed(1)}" y="${(l.y + 14).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" fill="#7a7a7a" font-size="10">${esc(a.sub)}</text>`;
		})
		.join('');

	// ring percentage labels along the top (quality) axis
	const ringLabels = [25, 50, 75, 100]
		.map((pct) => {
			const p = axisPt(axes[0].angle, pct);
			return `<text x="${p.x + 4}" y="${p.y + 3}" fill="#555" font-size="9">${pct}</text>`;
		})
		.join('');

	// polygons — leader last so it overlays the others
	const ordered = [...stats].sort((a, b) =>
		a.id === leaderId ? 1 : b.id === leaderId ? -1 : 0,
	);
	const polys = ordered
		.map((s) => {
			const pts = axes.map((a) =>
				axisPt(a.angle, Math.max(0, Math.min(100, a.norm(s)))),
			);
			const d = pts
				.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
				.join(' ') + ' Z';
			const isLeader = s.id === leaderId;
			const color = providerDisplay(s.id).color;
			const dots = pts
				.map(
					(p) =>
						`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${isLeader ? 3.5 : 2.8}" fill="${color}" />`,
				)
				.join('');
			return `<g>
<path d="${d}" fill="${color}" fill-opacity="${isLeader ? 0.14 : 0.06}" stroke="${color}" stroke-width="${isLeader ? 2 : 1.5}" stroke-linejoin="round" />
${dots}
</g>`;
		})
		.join('');

	// Legend under the chart so readers can map colors → providers.
	const legendItems = stats
		.map((s) => {
			const d = providerDisplay(s.id);
			return `<span class="radarLegendItem"><span class="radarDot" style="background:${d.color}"></span>${esc(d.name)}</span>`;
		})
		.join('');

	return `<div class="radarInner">
<div class="radarLegendRow">${legendItems}</div>
<svg viewBox="0 0 ${size} ${size}" class="radarSvg" preserveAspectRatio="xMidYMid meet">
  ${rings}
  ${spokes}
  ${ringLabels}
  ${polys}
</svg>
</div>`;
}

/** Human-facing provider label + square mark/favicon + a distinct
 *  accent color so the radar polygons / per-task pills stay readable
 *  on the black canvas. Leader always stays white-ink for contrast;
 *  others get a muted distinct hue. */
function providerDisplay(id: string): { name: string; logo: string | null; color: string } {
	switch (id) {
		case 'predev':
			return { name: 'pre.dev browser agent', logo: 'https://pre.dev/predevlogosquare.png', color: '#f5f5f4' };
		case 'browser-use-cloud':
			return { name: 'browser use cloud', logo: 'https://www.google.com/s2/favicons?domain=cloud.browser-use.com&sz=64', color: '#38bdf8' };
		default:
			return { name: id, logo: null, color: '#9ca3af' };
	}
}

/** Inline logo + name for a provider cell. All marks render at the
 *  same 18px square so rows line up. */
function providerCell(id: string, extraClass = ''): string {
	const p = providerDisplay(id);
	const img = p.logo
		? `<img src="${esc(p.logo)}" alt="" class="providerMark" />`
		: '<span class="providerMark placeholder"></span>';
	return `<span class="provider ${extraClass}">${img}<span class="providerName">${esc(p.name)}</span></span>`;
}

function esc(s: string): string {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

main();
