/**
 * Sustained-load driver for the pre.dev browser-agent prod API.
 *
 * Holds a TARGET concurrency continuously (worker-pool: the instant one
 * task finishes, the next is submitted) rather than firing a burst that
 * drains. Measures CLIENT-observed end-to-end latency + submit latency +
 * error class; cross-check the SERVER truth via PostHog browser_agent_task.
 *
 * Uses a dedicated keepAlive https agent with maxSockets >> concurrency so
 * client-side socket exhaustion never masquerades as a server failure
 * (the known bench↔api choke). Distinguishes http/submit errors, 429s,
 * client timeouts, and real server task-failures.
 *
 *   node loadtest.mjs --concurrency 100 --total 300
 *   node loadtest.mjs --concurrency 200 --total 400 --taskTimeout 120
 */
import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';

// ── config ──
const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const CONCURRENCY = parseInt(arg('concurrency', '100'), 10);
const TOTAL = parseInt(arg('total', '300'), 10);
const TASK_TIMEOUT_MS = parseInt(arg('taskTimeout', '180'), 10) * 1000;
const POLL_MS = 1500;

// load PREDEV_API_KEY from .env
let KEY = process.env.PREDEV_API_KEY;
if (!KEY && existsSync('.env')) {
	for (const line of readFileSync('.env', 'utf8').split('\n')) {
		const m = line.match(/^\s*PREDEV_API_KEY\s*=\s*(.*)$/);
		if (m) KEY = m[1].replace(/^['"](.*)['"]$/, '$1').trim();
	}
}
if (!KEY) { console.error('PREDEV_API_KEY not set'); process.exit(1); }
const API = process.env.PREDEV_API_URL || 'https://api.pre.dev';

// dedicated keep-alive pool, well above concurrency so the CLIENT is never the bottleneck
const agent = new https.Agent({ keepAlive: true, maxSockets: CONCURRENCY + 64, maxFreeSockets: 64 });

// realistic, bounded-latency task pool: SSR + JSON + light-SPA. No anti-bot
// frontier (that's a separate axis); this measures throughput on normal work.
const TASK_POOL = [
	{ url: 'https://news.ycombinator.com/', instruction: 'Extract the top 3 story titles. Return JSON: { "stories": [{ "title": string }] }' },
	{ url: 'https://en.wikipedia.org/wiki/Python_(programming_language)', instruction: 'From the infobox, extract the designer and the year it first appeared. Return JSON: { "designer": string, "firstAppeared": string }' },
	{ url: 'https://pypi.org/project/requests/', instruction: 'Extract the package name and latest version. Return JSON: { "name": string, "version": string }' },
	{ url: 'https://pokeapi.co/api/v2/pokemon/pikachu', instruction: 'From this JSON extract the name and first type. Return JSON: { "name": string, "type": string }' },
	{ url: 'https://quotes.toscrape.com/', instruction: 'Extract the first 3 quotes and their authors. Return JSON: { "quotes": [{ "text": string, "author": string }] }' },
	{ url: 'https://books.toscrape.com/', instruction: 'Extract the titles and prices of the first 3 books. Return JSON: { "books": [{ "title": string, "price": string }] }' },
	{ url: 'https://github.com/facebook/react', instruction: 'Extract the repo description and primary language. Return JSON: { "description": string, "language": string }' },
	{ url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map', instruction: 'Summarize in one sentence what Array.map does. Return JSON: { "summary": string }' },
	{ url: 'https://jsonplaceholder.typicode.com/users', instruction: 'Extract the names of the first 3 users. Return JSON: { "users": [{ "name": string }] }' },
	{ url: 'https://www.scrapethissite.com/pages/simple/', instruction: 'Extract the first 3 country names and capitals. Return JSON: { "countries": [{ "name": string, "capital": string }] }' },
	{ url: 'https://lobste.rs/', instruction: 'Extract the first 3 story titles. Return JSON: { "stories": [{ "title": string }] }' },
	{ url: 'https://hn.algolia.com/api/v1/search?query=rust&tags=story&hitsPerPage=3', instruction: 'From this JSON extract the first 3 story titles. Return JSON: { "stories": [{ "title": string }] }' },
];

function req(method, path, body) {
	return new Promise((resolve) => {
		const data = body ? JSON.stringify(body) : null;
		const u = new URL(API + path);
		const r = https.request({
			method, hostname: u.hostname, path: u.pathname + u.search, agent,
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
			timeout: 30000,
		}, (res) => {
			let buf = '';
			res.on('data', (c) => (buf += c));
			res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, json: j, raw: buf }); });
		});
		r.on('error', (e) => resolve({ status: 0, err: e.message }));
		r.on('timeout', () => { r.destroy(); resolve({ status: 0, err: 'client-timeout' }); });
		if (data) r.write(data);
		r.end();
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOne(task) {
	const t0 = Date.now();
	// submit (retry 429 a few times with short jittered backoff)
	let id = '', submitErr = '', status429 = 0;
	for (let a = 0; a < 5; a++) {
		const res = await req('POST', '/browser-agent', { tasks: [task], concurrency: 1, async: true });
		if (res.status === 200 && res.json?.id) { id = res.json.id; break; }
		if (res.status === 429) {
			status429++;
			// distinguish the two 429s: in-flight cap (graceful backpressure) vs rate limit (abuse guard)
			const body = (res.raw || res.json?.error || '').toString();
			submitErr = /in-flight cap/i.test(body) ? 'cap' : /rate limit/i.test(body) ? 'ratelimit' : '429';
			await sleep(2000 + Math.random() * 4000); continue;
		}
		submitErr = res.err || `submit ${res.status}: ${(res.raw || '').slice(0, 80)}`;
		break;
	}
	const submitMs = Date.now() - t0;
	if (!id) return { ok: false, cls: status429 ? `429-${submitErr === 'cap' ? 'inflight-cap' : submitErr === 'ratelimit' ? 'rate-limit' : 'unknown'}` : 'submit-error', detail: submitErr || '429', submitMs, e2eMs: Date.now() - t0 };
	// poll
	const deadline = t0 + TASK_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await sleep(POLL_MS);
		const res = await req('GET', `/browser-agent/${id}`);
		if (res.status === 0) continue; // transient; keep polling
		const st = res.json?.status;
		if (st === 'completed' || st === 'failed') {
			const r = (res.json.results || [])[0] || {};
			const success = r.status === 'SUCCESS';
			return { ok: success, cls: success ? 'success' : `task-${r.status || st}`, submitMs, e2eMs: Date.now() - t0, credits: res.json.totalCreditsUsed };
		}
	}
	return { ok: false, cls: 'client-timeout-wait', submitMs, e2eMs: Date.now() - t0 };
}

function pct(arr, p) {
	if (!arr.length) return 0;
	const s = [...arr].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

(async () => {
	console.log(`LOADTEST c=${CONCURRENCY} total=${TOTAL} api=${API} taskTimeout=${TASK_TIMEOUT_MS / 1000}s`);
	const results = [];
	let submitted = 0;
	const tStart = Date.now();
	let lastLog = Date.now();

	async function worker(wi) {
		while (submitted < TOTAL) {
			const n = submitted++;
			if (n >= TOTAL) break;
			const task = TASK_POOL[n % TASK_POOL.length];
			const r = await runOne(task);
			results.push(r);
			if (Date.now() - lastLog > 5000) {
				lastLog = Date.now();
				const done = results.length;
				const okN = results.filter((x) => x.ok).length;
				const elapsed = (Date.now() - tStart) / 1000;
				console.log(`  ${done}/${TOTAL} done | ${okN} ok | ${(done / elapsed).toFixed(1)} tasks/s | inflight≈${Math.min(CONCURRENCY, TOTAL - done)}`);
			}
		}
	}
	await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));

	const elapsed = (Date.now() - tStart) / 1000;
	const e2e = results.filter((r) => r.cls === 'success').map((r) => r.e2eMs);
	const submit = results.map((r) => r.submitMs).filter((x) => x > 0);
	const byClass = {};
	for (const r of results) byClass[r.cls] = (byClass[r.cls] || 0) + 1;
	const okN = results.filter((r) => r.ok).length;

	console.log(`\n=== RESULT c=${CONCURRENCY} ===`);
	console.log(`tasks: ${results.length} | success: ${okN} (${(100 * okN / results.length).toFixed(1)}%) | wall: ${elapsed.toFixed(1)}s | throughput: ${(results.length / elapsed).toFixed(1)} tasks/s (${(results.length / elapsed * 60).toFixed(0)}/min)`);
	console.log(`e2e latency (success): p50 ${(pct(e2e, 50) / 1000).toFixed(1)}s | p90 ${(pct(e2e, 90) / 1000).toFixed(1)}s | p95 ${(pct(e2e, 95) / 1000).toFixed(1)}s | p99 ${(pct(e2e, 99) / 1000).toFixed(1)}s | max ${(Math.max(0, ...e2e) / 1000).toFixed(1)}s`);
	console.log(`submit latency: p50 ${pct(submit, 50)}ms | p95 ${pct(submit, 95)}ms | max ${Math.max(0, ...submit)}ms`);
	console.log(`outcome breakdown: ${JSON.stringify(byClass)}`);
})();
