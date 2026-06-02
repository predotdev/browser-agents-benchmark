/**
 * HARD / ADVERSARIAL benchmark tier.
 *
 * The bundled `tasks.json` (100 tasks) is deliberately EASY — it targets
 * toscrape.com / wikipedia.org / scrapethissite.com, which is why every
 * provider scores ~100/100 and the suite no longer discriminates.
 *
 * This file is a separate, genuinely-HARD tier of real-world public
 * extraction tasks. All are EXTRACTION-ONLY: no login, no purchase, no
 * destructive action. They span the failure surfaces that actually break
 * cheap browser agents in production:
 *
 *   (a) heavy SPA dashboard / data-grid that only renders after JS
 *   (b) multi-page navigation → detail page → extract
 *   (c) anti-bot beyond Cloudflare — DataDome / PerimeterX / Akamai
 *   (d) cookie / consent-gated EU sites (must dismiss the wall first)
 *   (e) structured-data JSON-LD product / article
 *   (f) search → filter → extract
 *   (g) infinite-scroll / lazy-load up to a count
 *   (h) date / relative-time parsing
 *   (i) results only appear after a dropdown / form selection
 *
 * These are written as native TypeScript `BenchmarkTask`s (real
 * `successCheck` closures), so unlike `tasks.json` they don't go through
 * the string-rehydration path. The runner imports them directly when
 * invoked with `--hard` (or `--suite hard`).
 *
 * Each successCheck is STRICT: it asserts on the *content* of the
 * extraction (specific known-true facts, plausible value ranges, minimum
 * array lengths), not merely on schema-shape. A schema-valid but empty or
 * hallucinated payload must FAIL. The point of this tier is to surface
 * silent false-successes.
 */

import type { BenchmarkTask } from './types.js';

// ── local scoring helpers (mirror tasks.ts HELPERS_SRC, typed) ───────────
// Native closures here can reference these directly.

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
function findValue(obj: any, predicate: (v: any) => boolean): any {
	if (predicate(obj)) return obj;
	if (obj && typeof obj === 'object') {
		for (const v of Object.values(obj)) {
			const found = findValue(v, predicate);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}
/** Flatten the whole payload to a lowercased string for substring asserts. */
function hay(data: any): string {
	return JSON.stringify(data ?? {}).toLowerCase();
}
/** Pull every number found anywhere in the payload. */
function allNumbers(obj: any): number[] {
	const out: number[] = [];
	const walk = (v: any) => {
		if (typeof v === 'number' && isFinite(v)) out.push(v);
		else if (typeof v === 'string') {
			// extract numerics from strings like "$63,210.50" / "1.2M"
			const m = v.replace(/[, ]/g, '').match(/-?\d+(\.\d+)?/g);
			if (m) for (const n of m) out.push(parseFloat(n));
		} else if (v && typeof v === 'object') {
			for (const x of Object.values(v)) walk(x);
		}
	};
	walk(obj);
	return out;
}
/** Did the agent come back genuinely empty / null / blocked? */
function isEmptyPayload(data: any): boolean {
	if (data == null) return true;
	const h = hay(data);
	if (h === '{}' || h === '[]' || h === 'null' || h === '""') return true;
	// honest "I was blocked" signals the agent sometimes returns in-band
	if (/\b(blocked|access denied|captcha|forbidden|403|are you a robot|verify you are human|enable javascript|no_target|not found)\b/.test(h)
		&& h.length < 400) return true;
	return false;
}

const ok = (reason: string) => ({ success: true, reason });
const no = (reason: string) => ({ success: false, reason });

// =========================================================================

export const HARD_TASKS: BenchmarkTask[] = [
	// ── (a) heavy SPA dashboard / data-grid ──────────────────────────────
	{
		name: 'h01-coingecko-spa-table',
		url: 'https://www.coingecko.com/',
		instruction:
			'On the CoinGecko homepage market table, extract the top 3 cryptocurrencies by market cap rank with their current USD price. Return JSON: { "coins": [{ "name": string, "priceUsd": number }] }',
		timeoutMs: 150_000,
		output: {
			type: 'object',
			properties: {
				coins: {
					type: 'array',
					items: {
						type: 'object',
						properties: { name: { type: 'string' }, priceUsd: { type: 'number' } },
						required: ['name', 'priceUsd'],
					},
				},
			},
			required: ['coins'],
		},
		successCheck: (r) => {
			if (isEmptyPayload(r.data)) return no('empty/blocked');
			const arr = findArray(r.data);
			if (!arr || arr.length < 3) return no(`only ${arr?.length ?? 0} rows`);
			const h = hay(r.data);
			// Bitcoin and/or Ethereum are always top-3 by mcap — strong content anchor.
			if (!/(bitcoin|btc)/.test(h) || !/(ethereum|eth)/.test(h))
				return no('top-3 missing BTC/ETH → likely wrong table or stale');
			// price sanity: BTC is 5–7 figures; at least one big number must exist.
			const nums = allNumbers(r.data);
			if (!nums.some((n) => n > 1000)) return no('no plausible BTC-scale price');
			return ok('top-3 with BTC+ETH and plausible prices');
		},
	},
	{
		name: 'h02-yahoo-finance-aapl-spa',
		url: 'https://finance.yahoo.com/quote/AAPL/',
		instruction:
			'Extract Apple Inc. (AAPL) current/last stock price and its market cap as shown on the quote page. Return JSON: { "symbol": string, "price": number, "marketCap": string }',
		timeoutMs: 150_000,
		output: {
			type: 'object',
			properties: {
				symbol: { type: 'string' },
				price: { type: 'number' },
				marketCap: { type: 'string' },
			},
			required: ['symbol', 'price'],
		},
		successCheck: (r) => {
			if (isEmptyPayload(r.data)) return no('empty/blocked');
			const h = hay(r.data);
			if (!/aapl|apple/.test(h)) return no('no AAPL/Apple anchor');
			const nums = allNumbers(r.data);
			// AAPL trades roughly $100–$400 in this era; reject hallucinated 0 or absurd values.
			if (!nums.some((n) => n >= 50 && n <= 1000))
				return no('no plausible AAPL share price (50–1000)');
			// market cap must show a trillion/billion scale. Accept both
			// digit-glued suffixes ("4.629T", "3,400B") and worded forms
			// ("3.4 trillion"), plus a raw 13-digit-ish comma-grouped number.
			if (!/\d\s*(t|b)\b|trillion|billion|\d,\d{3},\d{3},\d{3}/.test(h))
				return no('no market-cap scale token');
			return ok('AAPL price in plausible range + mcap scale');
		},
	},

	// ── (b) multi-page navigation → detail → extract ─────────────────────
	{
		name: 'h03-imdb-top-then-detail',
		url: 'https://www.imdb.com/chart/top/',
		instruction:
			'On the IMDb Top 250 chart, find the #1 ranked movie, then extract its title, release year, and IMDb rating. Return JSON: { "title": string, "year": number, "rating": number }',
		timeoutMs: 160_000,
		output: {
			type: 'object',
			properties: {
				title: { type: 'string' },
				year: { type: 'number' },
				rating: { type: 'number' },
			},
			required: ['title', 'rating'],
		},
		successCheck: (r) => {
			if (isEmptyPayload(r.data)) return no('empty/blocked');
			const h = hay(r.data);
			// #1 has been The Shawshank Redemption for years (year 1994, rating ~9.3).
			if (!/shawshank/.test(h)) return no('not Shawshank → wrong #1 or hallucinated');
			const nums = allNumbers(r.data);
			if (!nums.some((n) => n >= 9.0 && n <= 9.6))
				return no('rating not in 9.0–9.6 band');
			if (!nums.some((n) => n === 1994)) return no('year 1994 missing');
			return ok('Shawshank #1 with 1994 + ~9.3 rating');
		},
	},

	// ── (c) anti-bot beyond Cloudflare ───────────────────────────────────
	{
		name: 'h04-g2-datadome-listing',
		url: 'https://www.g2.com/categories/crm',
		instruction:
			'On the G2 "CRM Software" category page, extract the names of the top 3 listed CRM products. Return JSON: { "products": [{ "name": string }] }',
		timeoutMs: 150_000,
		output: {
			type: 'object',
			properties: {
				products: {
					type: 'array',
					items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
				},
			},
			required: ['products'],
		},
		successCheck: (r) => {
			if (isEmptyPayload(r.data)) return no('empty/blocked (DataDome wall)');
			const arr = findArray(r.data);
			if (!arr || arr.length < 3) return no(`only ${arr?.length ?? 0} products`);
			const h = hay(r.data);
			// Well-known CRMs that dominate G2's CRM category — at least one must appear.
			const known = ['salesforce', 'hubspot', 'zoho', 'pipedrive', 'monday', 'freshsales', 'dynamics', 'zendesk'];
			if (!known.some((k) => h.includes(k)))
				return no('no recognizable CRM brand → likely placeholder/hallucinated');
			return ok('3+ products incl. a known CRM brand');
		},
	},
	{
		name: 'h05-stockx-perimeterx-listing',
		url: 'https://stockx.com/sneakers',
		instruction:
			'On the StockX sneakers listing page, extract the names of the first 3 sneaker products shown and their lowest ask / price. Return JSON: { "sneakers": [{ "name": string, "price": number }] }',
		timeoutMs: 150_000,
		output: {
			type: 'object',
			properties: {
				sneakers: {
					type: 'array',
					items: {
						type: 'object',
						properties: { name: { type: 'string' }, price: { type: 'number' } },
						required: ['name'],
					},
				},
			},
			required: ['sneakers'],
		},
		successCheck: (r) => {
			if (isEmptyPayload(r.data)) return no('empty/blocked (PerimeterX wall)');
			const arr = findArray(r.data);
			if (!arr || arr.length < 3) return no(`only ${arr?.length ?? 0} sneakers`);
			const h = hay(r.data);
			// Sneaker listings are dominated by these brands.
			if (!/(nike|jordan|yeezy|adidas|new balance|dunk|air)/.test(h))
				return no('no sneaker-brand token → likely hallucinated');
			const nums = allNumbers(r.data);
			if (!nums.some((n) => n >= 30 && n <= 5000))
				return no('no plausible sneaker price (30–5000)');
			return ok('3+ sneakers with brand + plausible price');
		},
	},
	{
		name: 'h06-bestbuy-akamai-search',
		url: 'https://www.bestbuy.com/site/searchpage.jsp?st=laptop',
		instruction:
			'On the Best Buy search results for "laptop", extract the product name and price of the first 3 laptops shown. Return JSON: { "laptops": [{ "name": string, "price": number }] }',
		timeoutMs: 150_000,
		output: {
			type: 'object',
			properties: {
				laptops: {
					type: 'array',
					items: {
						type: 'object',
						properties: { name: { type: 'string' }, price: { type: 'number' } },
						required: ['name', 'price'],
					},
				},
			},
			required: ['laptops'],
		},
		successCheck: (r) => {
			if (isEmptyPayload(r.data)) return no('empty/blocked (Akamai bot manager)');
			const arr = findArray(r.data);
			if (!arr || arr.length < 3) return no(`only ${arr?.length ?? 0} laptops`);
			const h = hay(r.data);
			if (!/(laptop|hp|dell|lenovo|asus|acer|macbook|chromebook|msi)/.test(h))
				return no('no laptop-brand token');
			const nums = allNumbers(r.data);
			if (!nums.some((n) => n >= 99 && n <= 6000))
				return no('no plausible laptop price (99–6000)');
			return ok('3+ laptops with brand + plausible price');
		},
	},
	{
		name: 'h07-immoscout-antibot-eu',
		url: 'https://www.immobilienscout24.de/Suche/de/wohnung-mieten',
		instruction:
			'On ImmobilienScout24 apartment rental search results for Germany, extract the address/title and cold rent (Kaltmiete) of the first 3 listings. Return JSON: { "listings": [{ "title": string, "rentEur": number }] }',
		timeoutMs: 150_000,
		output: {
			type: 'object',
			properties: {
				listings: {
					type: 'array',
					items: {
						type: 'object',
						properties: { title: { type: 'string' }, rentEur: { type: 'number' } },
						required: ['title'],
					},
				},
			},
			required: ['listings'],
		},
		successCheck: (r) => {
			if (isEmptyPayload(r.data)) return no('empty/blocked (anti-bot 401 + consent)');
			const arr = findArray(r.data);
			if (!arr || arr.length < 3) return no(`only ${arr?.length ?? 0} listings`);
			const nums = allNumbers(r.data);
			// German cold rents realistically 200–5000 €/mo.
			if (!nums.some((n) => n >= 150 && n <= 8000))
				return no('no plausible Kaltmiete (150–8000)');
			return ok('3+ rental listings with plausible rent');
		},
	},

	// ── (d) cookie / consent-gated EU sites ──────────────────────────────
	{
		name: 'h08-spiegel-consent-headlines',
		url: 'https://www.spiegel.de/',
		instruction:
			'Dismiss the cookie/consent banner if present, then extract the 5 top news headlines from the Spiegel.de homepage. Return JSON: { "headlines": [string] }',
		timeoutMs: 150_000,
		output: {
			type: 'object',
			properties: { headlines: { type: 'array', items: { type: 'string' } } },
			required: ['headlines'],
		},
		successCheck: (r) => {
			if (isEmptyPayload(r.data)) return no('empty/blocked (consent wall)');
			const arr = findArray(r.data);
			if (!arr || arr.length < 5) return no(`only ${arr?.length ?? 0} headlines`);
			// Headlines should be real sentences, not the consent text itself.
			const strs = arr.filter((s) => typeof s === 'string' && s.length > 15);
			if (strs.length < 5) return no(`${strs.length} substantive headlines`);
			const consenty = strs.filter((s: string) =>
				/cookie|einwilligung|datenschutz|zustimmen|akzeptieren|privacy/i.test(s),
			).length;
			if (consenty >= 3) return no('captured consent-banner text, not headlines');
			return ok('5 substantive German headlines past the consent wall');
		},
	},
	{
		name: 'h09-idealo-consent-akamai',
		url: 'https://www.idealo.de/preisvergleich/MainSearchProductCategory/19116.html',
		instruction:
			'Dismiss any cookie/consent banner, then on this idealo.de smartphone price-comparison category, extract the first 3 product names and their lowest price in EUR. Return JSON: { "products": [{ "name": string, "priceEur": number }] }',
		timeoutMs: 150_000,
		output: {
			type: 'object',
			properties: {
				products: {
					type: 'array',
					items: {
						type: 'object',
						properties: { name: { type: 'string' }, priceEur: { type: 'number' } },
						required: ['name'],
					},
				},
			},
			required: ['products'],
		},
		successCheck: (r) => {
			if (isEmptyPayload(r.data)) return no('empty/blocked (Akamai 503 + consent)');
			const arr = findArray(r.data);
			if (!arr || arr.length < 3) return no(`only ${arr?.length ?? 0} products`);
			const h = hay(r.data);
			if (!/(apple|samsung|xiaomi|iphone|galaxy|google|pixel|oneplus|nothing|motorola)/.test(h))
				return no('no recognizable phone brand → likely placeholder');
			const nums = allNumbers(r.data);
			if (!nums.some((n) => n >= 50 && n <= 3000))
				return no('no plausible phone price (50–3000)');
			return ok('3+ phones with brand + plausible EUR price');
		},
	},

	// ── (e) structured-data JSON-LD product / article ────────────────────
	{
		name: 'h10-amazon-jsonld-pdp',
		url: 'https://www.amazon.com/dp/B07FZ8S74R',
		instruction:
			'On this Amazon product detail page, extract the exact product title and its current price in USD. Return JSON: { "title": string, "priceUsd": number }',
		timeoutMs: 150_000,
		output: {
			type: 'object',
			properties: { title: { type: 'string' }, priceUsd: { type: 'number' } },
			required: ['title'],
		},
		successCheck: (r) => {
			if (isEmptyPayload(r.data)) return no('empty/blocked (Amazon bot wall / dog page)');
			const h = hay(r.data);
			// ASIN B07FZ8S74R is the Echo Dot (3rd Gen). The agent must read the
			// ACTUAL product off the page, not hallucinate a generic item.
			if (!/echo dot/.test(h)) return no('title is not "Echo Dot" → wrong product / hallucinated');
			const nums = allNumbers(r.data);
			if (!nums.some((n) => n >= 5 && n <= 1000))
				return no('no plausible USD price (5–1000)');
			return ok('Echo Dot title + plausible price');
		},
	},
	{
		name: 'h11-verge-jsonld-article',
		url: 'https://www.theverge.com/tech',
		instruction:
			'From The Verge tech section, open the top/featured article and extract its headline, author, and publication date. Return JSON: { "headline": string, "author": string, "publishedDate": string }',
		timeoutMs: 150_000,
		output: {
			type: 'object',
			properties: {
				headline: { type: 'string' },
				author: { type: 'string' },
				publishedDate: { type: 'string' },
			},
			required: ['headline', 'publishedDate'],
		},
		successCheck: (r) => {
			if (isEmptyPayload(r.data)) return no('empty/blocked');
			const headline = findValue(r.data, (v) => typeof v === 'string' && v.length > 15);
			if (!headline) return no('no substantive headline');
			const h = hay(r.data);
			// publishedDate must look like a real timestamp. The Verge shows a
			// full date ("Jun 2, 2026") for older posts but a clock time
			// ("7:23 PM UTC") for same-day articles — both are valid here.
			const hasFullDate =
				/\b20\d{2}\b/.test(h) &&
				(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(h) ||
					/\d{4}-\d{2}-\d{2}/.test(h));
			const hasRelative = /\b(hour|minute|day|ago|today|yesterday)\b/.test(h);
			const hasClockTime = /\b\d{1,2}:\d{2}\s*(am|pm)?\b/i.test(h) && /\b(utc|gmt|edt|est|pdt|pst|et|pt)\b/i.test(h);
			if (!hasFullDate && !hasRelative && !hasClockTime)
				return no('publishedDate not a recognizable date/time');
			return ok('headline + parseable publish date/time');
		},
	},

	// ── (f) search → filter → extract ────────────────────────────────────
	{
		name: 'h12-sec-edgar-fulltext-search',
		url: 'https://efts.sec.gov/LATEST/search-index?q=%22climate+change%22',
		instruction:
			'Use SEC EDGAR full-text search at https://www.sec.gov/cgi-bin/srqsb to find filings. Navigate to https://efts.sec.gov/LATEST/search-index?q=%22artificial+intelligence%22&forms=10-K and extract the company name (display_names) and form type of the first 3 filing hits. Return JSON: { "filings": [{ "company": string, "form": string }] }',
		timeoutMs: 150_000,
		output: {
			type: 'object',
			properties: {
				filings: {
					type: 'array',
					items: {
						type: 'object',
						properties: { company: { type: 'string' }, form: { type: 'string' } },
						required: ['company'],
					},
				},
			},
			required: ['filings'],
		},
		successCheck: (r) => {
			if (isEmptyPayload(r.data)) return no('empty/blocked');
			const arr = findArray(r.data);
			if (!arr || arr.length < 3) return no(`only ${arr?.length ?? 0} filings`);
			const h = hay(r.data);
			// EDGAR filings reference real form types and have CIK-style company strings.
			if (!/10-k|10-q|8-k|s-1|def 14a|form/.test(h))
				return no('no SEC form-type token → likely not real filings');
			const named = arr.filter(
				(it) => it && (typeof it.company === 'string' || typeof it.name === 'string'),
			);
			if (named.length < 3) return no(`${named.length} named companies`);
			return ok('3+ filings with company + form token');
		},
	},

	// ── (g) infinite-scroll / lazy-load up to a count ────────────────────
	{
		name: 'h13-infinite-scroll-count',
		url: 'https://www.scrapingcourse.com/infinite-scrolling',
		instruction:
			'This page lazy-loads more product cards as you scroll down. Scroll until at least 30 products are loaded, then extract the names of the first 30 products. Return JSON: { "products": [{ "name": string }], "count": number }',
		timeoutMs: 170_000,
		output: {
			type: 'object',
			properties: {
				products: {
					type: 'array',
					items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
				},
				count: { type: 'number' },
			},
			required: ['products'],
		},
		successCheck: (r) => {
			if (isEmptyPayload(r.data)) return no('empty');
			const arr = findArray(r.data);
			// The whole point: without scrolling you only get the initial ~12.
			if (!arr || arr.length < 30)
				return no(`only ${arr?.length ?? 0} products (need 30 → did not scroll/lazy-load)`);
			const named = arr.filter(
				(it) =>
					(typeof it === 'string' && it.length > 1) ||
					(it && typeof it === 'object' && (it.name || it.title)),
			);
			if (named.length < 30) return no(`${named.length} named (< 30)`);
			return ok(`${named.length} products after infinite scroll`);
		},
	},

	// ── (h) date / relative-time parsing ─────────────────────────────────
	{
		name: 'h14-hn-relative-time-parse',
		url: 'https://news.ycombinator.com/newest',
		instruction:
			'On the Hacker News "newest" page, each story shows a relative time like "12 minutes ago". For the first 5 stories, extract the title and convert the relative time into an approximate number of MINUTES ago (an integer). Return JSON: { "stories": [{ "title": string, "minutesAgo": number }] }',
		timeoutMs: 150_000,
		output: {
			type: 'object',
			properties: {
				stories: {
					type: 'array',
					items: {
						type: 'object',
						properties: { title: { type: 'string' }, minutesAgo: { type: 'number' } },
						required: ['title', 'minutesAgo'],
					},
				},
			},
			required: ['stories'],
		},
		successCheck: (r) => {
			if (isEmptyPayload(r.data)) return no('empty');
			const arr = findArray(r.data);
			if (!arr || arr.length < 5) return no(`only ${arr?.length ?? 0} stories`);
			// minutesAgo must be present, numeric, and plausibly small (newest page).
			const withMins = arr.filter((it) => {
				const m =
					it &&
					(it.minutesAgo ?? it.minutes ?? it.minsAgo ?? findValue(it, (v) => typeof v === 'number'));
				return typeof m === 'number' && m >= 0 && m < 100000;
			});
			if (withMins.length < 5) return no(`${withMins.length} stories with a parsed minutesAgo`);
			// At least one should be genuinely recent (newest feed → minutes/hours, not days).
			const anyRecent = arr.some((it) => {
				const m = it && (it.minutesAgo ?? it.minutes ?? findValue(it, (v) => typeof v === 'number'));
				return typeof m === 'number' && m >= 0 && m <= 2880; // within ~2 days
			});
			if (!anyRecent) return no('no recent timestamp → relative-time parse looks wrong');
			return ok('5 stories with parsed minutesAgo, at least one recent');
		},
	},

	// ── (i) results only appear after a dropdown / form selection ────────
	{
		name: 'h15-nasdaq-dropdown-results',
		url: 'https://www.nasdaq.com/market-activity/stocks/screener',
		instruction:
			'On the Nasdaq stock screener, set/keep the Region filter to "North America" and the Exchange to NASDAQ, then read the resulting table. Extract the symbol and company name of the first 3 stocks shown in the screener results table. Return JSON: { "stocks": [{ "symbol": string, "name": string }] }',
		timeoutMs: 170_000,
		output: {
			type: 'object',
			properties: {
				stocks: {
					type: 'array',
					items: {
						type: 'object',
						properties: { symbol: { type: 'string' }, name: { type: 'string' } },
						required: ['symbol', 'name'],
					},
				},
			},
			required: ['stocks'],
		},
		successCheck: (r) => {
			if (isEmptyPayload(r.data)) return no('empty/blocked (results never rendered)');
			const arr = findArray(r.data);
			if (!arr || arr.length < 3) return no(`only ${arr?.length ?? 0} stocks`);
			const withSym = arr.filter((it) => {
				const sym = it && (it.symbol || it.ticker);
				// real tickers are 1–5 uppercase letters
				return typeof sym === 'string' && /^[A-Z]{1,6}$/.test(sym.trim());
			});
			if (withSym.length < 3) return no(`${withSym.length} rows with a valid ticker`);
			return ok('3+ screener rows with valid tickers (results rendered after filter)');
		},
	},
];
