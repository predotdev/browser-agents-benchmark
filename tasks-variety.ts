/**
 * VARIETY benchmark tier — real-world breadth.
 *
 * The easy `tasks.json` is 64% single-page extraction concentrated on
 * developer / purpose-built-for-scraping sites (toscrape, herokuapp,
 * scrapethissite). The `--hard` tier is the anti-bot frontier. This tier
 * fills the gap between them: REAL, accessible public sites across the
 * verticals + task types people actually point browser agents at —
 *
 *   - SaaS pricing pages (competitive-intel: the #1 real ask)
 *   - package registries (pypi / crates) — SSR + SPA
 *   - academic / research (arxiv)
 *   - open data / reference (openlibrary, wiktionary, real wiki infoboxes/tables)
 *   - job boards
 *   - docs / API reference
 *   - JSON API endpoints
 *   - multi-step navigation on real sites
 *   - computation / filtering / counting over extracted data
 *   - varied output shapes (boolean, nested, numeric-aggregate)
 *
 * These are deliberately NOT the Akamai/DataDome frontier — a failure here
 * is a real product gap on a normal task, not an anti-bot arms-race loss.
 * successChecks are STRICT and content-based (known-stable ground truth, or
 * plausible-range + non-empty for time-varying lists) so a schema-valid but
 * hallucinated/empty payload FAILS.
 */

import type { BenchmarkTask, BenchmarkResult } from './types.js';

// ── scoring helpers (mirror tasks-hard.ts) ───────────────────────────────
function findArray(obj: any): any[] | null {
	if (Array.isArray(obj)) return obj;
	if (obj && typeof obj === 'object') {
		for (const v of Object.values(obj)) {
			const found = findArray(v);
			if (found) return found;
		}
	}
	return null;
}
function hay(data: any): string {
	return JSON.stringify(data ?? {}).toLowerCase();
}
function allNumbers(obj: any): number[] {
	const out: number[] = [];
	const walk = (v: any) => {
		if (typeof v === 'number' && isFinite(v)) out.push(v);
		else if (typeof v === 'string') {
			const m = v.replace(/[, ]/g, '').match(/-?\d+(\.\d+)?/g);
			if (m) for (const n of m) out.push(parseFloat(n));
		} else if (v && typeof v === 'object') {
			for (const x of Object.values(v)) walk(x);
		}
	};
	walk(obj);
	return out;
}
function isEmptyPayload(data: any): boolean {
	if (data == null) return true;
	const h = hay(data);
	if (h === '{}' || h === '[]' || h === 'null' || h === '""') return true;
	if (/\b(blocked|access denied|captcha|forbidden|403|are you a robot|verify you are human|enable javascript|no_target|not found|unavailable)\b/.test(h)
		&& h.length < 400) return true;
	return false;
}
const ok = (reason = 'ok') => ({ success: true, reason });
const no = (reason: string) => ({ success: false, reason });
/** strict: payload non-empty AND every needle present somewhere in it. */
function needs(r: BenchmarkResult, ...needles: string[]) {
	if (isEmptyPayload(r.data)) return no('empty/blocked payload');
	const h = hay(r.data);
	for (const n of needles) if (!h.includes(n.toLowerCase())) return no(`missing "${n}"`);
	return ok();
}
/** strict: a JSON array of >= n items somewhere in the payload. */
function arrayAtLeast(r: BenchmarkResult, n: number) {
	if (isEmptyPayload(r.data)) return no('empty/blocked payload');
	const arr = findArray(r.data);
	if (!arr) return no('no array in payload');
	if (arr.length < n) return no(`array has ${arr.length} < ${n}`);
	return ok(`${arr.length} items`);
}

export const VARIETY_TASKS: BenchmarkTask[] = [
	// ─────────────── package registries (SSR + SPA) ───────────────
	{
		name: 'v01-pypi-package-meta',
		url: 'https://pypi.org/project/requests/',
		instruction: 'Extract the package name, the latest version number, and the license. Return JSON: { "name": string, "version": string, "license": string }',
		output: { type: 'object', properties: { name: { type: 'string' }, version: { type: 'string' }, license: { type: 'string' } }, required: ['name', 'version'] },
		successCheck: (r) => needs(r, 'requests', 'apache'),
	},
	{
		name: 'v02-pypi-search',
		url: 'https://pypi.org/search/?q=http+client',
		instruction: 'Extract the names of the first 3 packages in the search results. Return JSON: { "packages": [{ "name": string }] }',
		output: { type: 'object', properties: { packages: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } } }, required: ['packages'] },
		successCheck: (r) => arrayAtLeast(r, 3),
	},
	{
		name: 'v03-crates-io-spa',
		url: 'https://crates.io/crates/serde',
		instruction: 'Extract the crate name and its all-time download count (a large number). Return JSON: { "name": string, "downloads": string }',
		output: { type: 'object', properties: { name: { type: 'string' }, downloads: { type: 'string' } }, required: ['name', 'downloads'] },
		successCheck: (r) => {
			const m = needs(r, 'serde'); if (!m.success) return m;
			const big = allNumbers(r.data).some((n) => n > 1_000_000);
			return big ? ok() : no('no >1M download count found');
		},
	},

	// ─────────────── academic / research ───────────────
	{
		name: 'v04-arxiv-abstract',
		url: 'https://arxiv.org/abs/1706.03762',
		instruction: 'Extract the paper title and the name of the first author. Return JSON: { "title": string, "firstAuthor": string }',
		output: { type: 'object', properties: { title: { type: 'string' }, firstAuthor: { type: 'string' } }, required: ['title', 'firstAuthor'] },
		successCheck: (r) => needs(r, 'attention is all you need', 'vaswani'),
	},
	{
		name: 'v05-arxiv-list',
		url: 'https://arxiv.org/list/cs.AI/recent',
		instruction: 'Extract the titles of the first 3 papers in the recent listing. Return JSON: { "papers": [{ "title": string }] }',
		output: { type: 'object', properties: { papers: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } } } } }, required: ['papers'] },
		successCheck: (r) => arrayAtLeast(r, 3),
	},

	// ─────────────── open data / reference ───────────────
	{
		name: 'v06-openlibrary-work',
		url: 'https://openlibrary.org/works/OL45804W',
		instruction: 'Extract the book title and the author name. Return JSON: { "title": string, "author": string }',
		output: { type: 'object', properties: { title: { type: 'string' }, author: { type: 'string' } }, required: ['title', 'author'] },
		// ground truth verified via openlibrary.org/works/OL45804W.json: "Fantastic Mr Fox" / Roald Dahl.
		successCheck: (r) => needs(r, 'fantastic mr fox', 'dahl'),
	},
	{
		name: 'v07-wiktionary-define',
		url: 'https://en.wiktionary.org/wiki/serendipity',
		instruction: 'Extract the part of speech and the first English definition of this word. Return JSON: { "partOfSpeech": string, "definition": string }',
		output: { type: 'object', properties: { partOfSpeech: { type: 'string' }, definition: { type: 'string' } }, required: ['partOfSpeech', 'definition'] },
		successCheck: (r) => needs(r, 'noun'),
	},
	{
		name: 'v08-wikipedia-infobox',
		url: 'https://en.wikipedia.org/wiki/Python_(programming_language)',
		instruction: 'From the infobox, extract who designed the language and the year it first appeared. Return JSON: { "designer": string, "firstAppeared": string }',
		output: { type: 'object', properties: { designer: { type: 'string' }, firstAppeared: { type: 'string' } }, required: ['designer', 'firstAppeared'] },
		successCheck: (r) => {
			const m = needs(r, 'van rossum'); if (!m.success) return m;
			return allNumbers(r.data).includes(1991) ? ok() : no('1991 not found');
		},
	},
	{
		name: 'v09-wikipedia-big-table',
		url: 'https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population',
		instruction: 'Extract the top 3 entries by population from the table, with their populations. Return JSON: { "countries": [{ "name": string, "population": string }] }',
		output: { type: 'object', properties: { countries: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, population: { type: 'string' } } } } }, required: ['countries'] },
		successCheck: (r) => {
			const a = arrayAtLeast(r, 3); if (!a.success) return a;
			const h = hay(r.data);
			return (h.includes('india') || h.includes('china')) ? ok() : no('top-population countries (india/china) absent');
		},
	},

	// ─────────────── SaaS pricing (competitive intel) ───────────────
	{
		name: 'v10-render-pricing',
		url: 'https://render.com/pricing',
		instruction: 'Extract the names of the pricing plans/tiers shown and any monthly price for each. Return JSON: { "plans": [{ "name": string, "price": string }] }',
		output: { type: 'object', properties: { plans: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'string' } } } } }, required: ['plans'] },
		successCheck: (r) => arrayAtLeast(r, 2),
	},
	{
		name: 'v11-vercel-pricing',
		url: 'https://vercel.com/pricing',
		instruction: 'Extract the pricing plan names and the monthly price of each (e.g. the Pro plan price). Return JSON: { "plans": [{ "name": string, "price": string }] }',
		output: { type: 'object', properties: { plans: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'string' } } } } }, required: ['plans'] },
		successCheck: (r) => {
			const a = arrayAtLeast(r, 2); if (!a.success) return a;
			return hay(r.data).includes('pro') ? ok() : no('Pro plan absent');
		},
	},
	{
		name: 'v12-supabase-pricing',
		url: 'https://supabase.com/pricing',
		instruction: 'Extract the pricing plan names and their monthly prices. Return JSON: { "plans": [{ "name": string, "price": string }] }',
		output: { type: 'object', properties: { plans: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'string' } } } } }, required: ['plans'] },
		successCheck: (r) => arrayAtLeast(r, 2),
	},

	// ─────────────── job boards ───────────────
	{
		name: 'v13-weworkremotely-jobs',
		url: 'https://weworkremotely.com/categories/remote-programming-jobs',
		instruction: 'Extract the first 3 job listings with their job title and the company name. Return JSON: { "jobs": [{ "title": string, "company": string }] }',
		output: { type: 'object', properties: { jobs: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, company: { type: 'string' } } } } }, required: ['jobs'] },
		successCheck: (r) => arrayAtLeast(r, 3),
	},
	{
		name: 'v14-remoteok-json',
		url: 'https://remoteok.com/api',
		instruction: 'This is a JSON feed of remote jobs. Extract the position title and company for the first 3 real job entries. Return JSON: { "jobs": [{ "position": string, "company": string }] }',
		output: { type: 'object', properties: { jobs: { type: 'array', items: { type: 'object', properties: { position: { type: 'string' }, company: { type: 'string' } } } } }, required: ['jobs'] },
		successCheck: (r) => arrayAtLeast(r, 3),
	},

	// ─────────────── docs / API reference ───────────────
	{
		name: 'v15-mdn-array-map',
		url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map',
		instruction: 'Extract a one-sentence summary of what Array.prototype.map() does, and its return value description. Return JSON: { "summary": string, "returns": string }',
		output: { type: 'object', properties: { summary: { type: 'string' }, returns: { type: 'string' } }, required: ['summary'] },
		successCheck: (r) => needs(r, 'array'),
	},
	{
		name: 'v16-caniuse-grid',
		url: 'https://caniuse.com/css-grid',
		instruction: 'Does this page indicate that CSS Grid Layout is widely/generally supported across browsers? Extract the feature name and a yes/no support summary. Return JSON: { "feature": string, "widelySupported": boolean }',
		output: { type: 'object', properties: { feature: { type: 'string' }, widelySupported: { type: 'boolean' } }, required: ['feature', 'widelySupported'] },
		successCheck: (r) => needs(r, 'grid'),
	},

	// ─────────────── JSON API endpoints ───────────────
	{
		name: 'v17-pokeapi-json',
		url: 'https://pokeapi.co/api/v2/pokemon/pikachu',
		instruction: 'From this JSON, extract the pokemon name, its base_experience number, and its first type. Return JSON: { "name": string, "baseExperience": number, "type": string }',
		output: { type: 'object', properties: { name: { type: 'string' }, baseExperience: { type: 'number' }, type: { type: 'string' } }, required: ['name', 'type'] },
		successCheck: (r) => needs(r, 'pikachu', 'electric'),
	},
	{
		name: 'v18-hn-algolia-api',
		url: 'https://hn.algolia.com/api/v1/search?query=rust&tags=story&hitsPerPage=5',
		instruction: 'From this JSON search response, extract the titles of the first 3 stories. Return JSON: { "stories": [{ "title": string }] }',
		output: { type: 'object', properties: { stories: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } } } } }, required: ['stories'] },
		successCheck: (r) => arrayAtLeast(r, 3),
	},

	// ─────────────── multi-step navigation on real sites ───────────────
	{
		name: 'v19-github-repo-meta',
		url: 'https://github.com/facebook/react',
		instruction: 'Extract the repository description, the primary programming language, and the license. Return JSON: { "description": string, "language": string, "license": string }',
		output: { type: 'object', properties: { description: { type: 'string' }, language: { type: 'string' }, license: { type: 'string' } }, required: ['description', 'language'] },
		successCheck: (r) => needs(r, 'javascript'),
	},
	{
		name: 'v20-github-latest-release',
		url: 'https://github.com/cli/cli/releases/latest',
		instruction: 'Extract the version tag of this latest release and the release title. Return JSON: { "version": string, "title": string }',
		output: { type: 'object', properties: { version: { type: 'string' }, title: { type: 'string' } }, required: ['version'] },
		successCheck: (r) => {
			if (isEmptyPayload(r.data)) return no('empty/blocked payload');
			// gh CLI releases are vN.N.N — assert a semver-ish token present.
			return /v?\d+\.\d+/.test(hay(r.data)) ? ok() : no('no version-like token');
		},
	},
	{
		name: 'v21-npm-to-repo',
		url: 'https://www.npmjs.com/package/express',
		instruction: 'Extract the package name, its latest version, and its weekly download count. Return JSON: { "name": string, "version": string, "weeklyDownloads": string }',
		output: { type: 'object', properties: { name: { type: 'string' }, version: { type: 'string' }, weeklyDownloads: { type: 'string' } }, required: ['name', 'version'] },
		successCheck: (r) => needs(r, 'express'),
	},

	// ─────────────── computation / filtering / counting ───────────────
	{
		name: 'v22-hn-points-filter',
		url: 'https://news.ycombinator.com/',
		instruction: 'Look at the front-page stories and return only those with MORE than 100 points, with their title and point count. Return JSON: { "stories": [{ "title": string, "points": number }] }',
		output: { type: 'object', properties: { stories: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, points: { type: 'number' } } } } }, required: ['stories'] },
		successCheck: (r) => {
			if (isEmptyPayload(r.data)) return no('empty/blocked payload');
			const arr = findArray(r.data) || [];
			if (!arr.length) return no('no stories');
			// every returned story must actually be >100 pts (tests the filter, not just extraction)
			const pts = arr.map((s: any) => Number(s?.points)).filter((n) => isFinite(n));
			if (!pts.length) return no('no numeric points');
			return pts.every((p) => p > 100) ? ok(`${pts.length} stories all >100`) : no('returned a story <=100 pts (filter wrong)');
		},
	},
	{
		name: 'v23-scrapethissite-count',
		url: 'https://www.scrapethissite.com/pages/simple/',
		instruction: 'Count how many countries are listed on this page and also return the name of the country with the largest population. Return JSON: { "countryCount": number, "mostPopulous": string }',
		output: { type: 'object', properties: { countryCount: { type: 'number' }, mostPopulous: { type: 'string' } }, required: ['countryCount', 'mostPopulous'] },
		successCheck: (r) => {
			if (isEmptyPayload(r.data)) return no('empty/blocked payload');
			// the page lists 250 countries; China/India are most populous.
			const cnt = allNumbers(r.data).some((n) => n >= 200 && n <= 260);
			const h = hay(r.data);
			const pop = h.includes('china') || h.includes('india');
			if (!cnt) return no('country count not ~250');
			return pop ? ok() : no('most-populous country wrong');
		},
	},

	// ─────────────── content aggregation ───────────────
	{
		name: 'v24-lobsters-tag',
		url: 'https://lobste.rs/t/rust',
		instruction: 'Extract the first 3 story titles tagged "rust" and their score/points. Return JSON: { "stories": [{ "title": string, "score": number }] }',
		output: { type: 'object', properties: { stories: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, score: { type: 'number' } } } } }, required: ['stories'] },
		successCheck: (r) => arrayAtLeast(r, 3),
	},
];
