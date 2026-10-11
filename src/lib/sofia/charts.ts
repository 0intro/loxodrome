/* SOFIA-Briefing TEMSI / WINTEM chart catalog: build the Sling catalog
 * operations, unwrap the envelope (client.ts's unwrapSofiaMessage) and
 * shape each chart into a dated, directly downloadable link. Transport is
 * the same worker relay as the route-NOTAM fetch (loxodrome-proxy handleSofia:
 * anonymous JSESSIONID handshake + verbatim form body); the catalog
 * operations were verified live (`:operation=postTemsi&zone=FRANCE`, and
 * postWintem with a level filter the response ignores in favour of every
 * level for the zone).
 *
 * The returned links point at aviation.meteo.fr and are SELF-AUTHENTICATING
 * and EXPIRING (a login= token in the query): list them fresh, never
 * persist or rehost them, and let the browser download each PDF directly
 * from Meteo-France (verified: anonymous GET serves application/pdf). The
 * one exception is the printed flight dossier: aviation.meteo.fr sends no
 * CORS headers, so weather/tripCharts.ts relays the selected PDFs through
 * the worker (GET /sofia/chart) at print time only, still uncached and
 * never rehosted. Contract notes: docs/sofia-charts.md. */

import { unwrapSofiaMessage } from './client';
import {
	clearerFailure,
	fetchFailure,
	httpFailure,
	payloadFailure,
	retryBudget,
	SofiaError,
	type SofiaFailure,
} from './failure';
import { humanErrorDetail } from '$lib/autorouter/errorDetail';
import { uniqueBy } from '$lib/data/dedup';

const METEO_BASE = 'https://aviation.meteo.fr';

/** One catalog POST's budget. INVARIANT (the briefing's, fetch.ts): it
 *  outlasts the worker's worst case for the same POST, the inline session
 *  handshake plus the SOFIA call (loxodrome-proxy/worker.js FETCH_TIMEOUT_MS,
 *  10 + 35 s), so the worker always answers first and its framed diagnostic
 *  reaches the pilot instead of a bare timeout. Pinned by
 *  tests/sofiaTimeouts.spec.ts. At 15 s it once lost both charts of a printed
 *  dossier while SOFIA itself answered in 0.2 s. */
const CATALOG_TIMEOUT_MS = 50_000;

/** The pause before the one retry (the briefing's SOFIA_RETRY_PAUSE_MS). */
const RETRY_PAUSE_MS = 4000;

export type SofiaChartProduct = 'TEMSI' | 'WINTEM';

/** Both products, in the order they are asked for and printed. */
export const SOFIA_CHART_PRODUCTS: readonly SofiaChartProduct[] = ['TEMSI', 'WINTEM'];

/** Zone vocabulary exactly as the SOFIA search pages offer it (their
 *  <option> values); FRANCE and EUROC lead, the rest follow the pages'
 *  order. */
export const SOFIA_ZONES = [
	'FRANCE',
	'EUROC',
	'EUR',
	'EURAFI',
	'NAT',
	'NORTH_ATL',
	'ANTILLES',
	'ANTIL_GUY',
	'DIRAG_ATL',
	'ATLANTIQUE',
	'GUYANE',
	'MASCAREIG',
	'INDOC',
	'SIO',
	'EURASIA',
	'ASIA_SOUTH',
	'MEA',
	'MID',
	'AMERIQUES',
	'PACIF',
	'PACIFIC',
	'PAC_EST',
	'PAC_OUEST',
	'POLYNESIE',
	'NORTH_PAC',
	'SOUTH_POL',
	'EURSAM_B',
	'EURSAM_B1',
] as const;
export type SofiaZone = (typeof SOFIA_ZONES)[number];

/** The two official SOFIA chart pages (the always-works fallback links). */
export const SOFIA_TEMSI_PAGE =
	'https://sofia-briefing.aviation-civile.gouv.fr/sofia/pages/meteosearchtemsi.html';
export const SOFIA_WINTEM_PAGE =
	'https://sofia-briefing.aviation-civile.gouv.fr/sofia/pages/meteosearchwintem.html';

export interface SofiaChart {
	product: SofiaChartProduct;
	/** The levels the chart carries: the band as served ("FL20-150",
	 *  "FL20-100") or one level ("FL050"); see parseSofiaCharts. */
	level: string | null;
	zone: string;
	/** Validity label as served ("12 UTC"). */
	deadline: string;
	/** Validity instant parsed from the served date ("04 07 2026 12:00",
	 *  UTC); null when unparseable (the label still shows). */
	validAtMs: number | null;
	/** Absolute, tokenized, expiring download URL on aviation.meteo.fr. */
	url: string;
}

/** The x-www-form-urlencoded catalog request for one product + zone. */
export function chartsRequestBody(product: SofiaChartProduct, zone: SofiaZone): string {
	const p = new URLSearchParams();
	p.append(':operation', product === 'TEMSI' ? 'postTemsi' : 'postWintem');
	p.append('zone', zone);
	if (product === 'WINTEM') {
		// Required (SOFIA answers 500 without it), and its value ignored: the
		// response carries every sheet the zone has.
		p.append('level', '100');
	}
	return p.toString();
}

/** "04 07 2026 12:00" (SOFIA serves UTC) -> epoch ms, null when malformed. */
function parseSofiaDate(s: unknown): number | null {
	if (typeof s !== 'string') {
		return null;
	}
	const m = /^(\d{2}) (\d{2}) (\d{4}) (\d{2}):(\d{2})$/.exec(s.trim());
	if (!m) {
		return null;
	}
	return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]));
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Shape the unwrapped catalog into dated chart links, validity-sorted.
 *  Entries without a link are dropped; unknown fields pass through as
 *  labels untouched (SOFIA owns the vocabulary).
 *
 *  A WINTEM entry carries its zone's BAND in `level` ("FL20-100") and one
 *  level in its link's layer path (wintemp/fr/france/fl020). What the sheet
 *  holds depends on how many layers the band lists. One layer is a
 *  COMPOSITE sheet carrying the whole band (verified 2026-10-01: the one
 *  FRANCE sheet, layer fl020, prints FL020, FL050 and FL100; EUROC's
 *  FL50-100 prints FL050 and FL100), so it is named by the band. Several
 *  layers in one band are one sheet per level (the July 2026 FRANCE
 *  catalog's fl020 / fl050 / fl100), each named by its own level. */
export function parseSofiaCharts(payload: unknown, product: SofiaChartProduct): SofiaChart[] {
	const inner = unwrapSofiaMessage(payload);
	const zones = inner['zones'];
	const out: SofiaChart[] = [];
	if (!Array.isArray(zones)) {
		return out;
	}
	const key = product === 'TEMSI' ? 'temsi' : 'wintem';
	const parsed: { chart: SofiaChart; band: string | null; layer: string | null }[] = [];
	for (const z of zones) {
		if (!isRecord(z)) {
			continue;
		}
		const entries = z[key];
		if (!Array.isArray(entries)) {
			continue;
		}
		for (const e of entries) {
			if (!isRecord(e) || typeof e.link !== 'string' || e.link.length === 0) {
				continue;
			}
			const linkLevel = /\/fl(\d{2,3})(?:[&/]|$)/.exec(e.link.toLowerCase());
			const band = typeof e.level === 'string' && e.level ? e.level : null;
			parsed.push({
				band,
				layer: linkLevel ? `FL${linkLevel[1].padStart(3, '0')}` : null,
				chart: {
					product,
					level: band,
					zone:
						typeof e.zone === 'string' && e.zone
							? e.zone
							: typeof z.name === 'string'
								? z.name
								: '',
					deadline: typeof e.deadline === 'string' ? e.deadline : '',
					validAtMs: parseSofiaDate(e.date),
					url: `${METEO_BASE}${e.link.startsWith('/') ? '' : '/'}${e.link}`,
				},
			});
		}
	}
	// The distinct layers each zone's band lists, across its validities.
	const layersOf: Record<string, string[]> = {};
	for (const p of parsed) {
		if (p.layer) {
			const k = `${p.chart.zone}|${p.band ?? ''}`;
			const l = (layersOf[k] ??= []);
			if (!l.includes(p.layer)) {
				l.push(p.layer);
			}
		}
	}
	for (const p of parsed) {
		const layers = layersOf[`${p.chart.zone}|${p.band ?? ''}`] ?? [];
		if (p.layer && (p.band == null || layers.length > 1)) {
			p.chart.level = p.layer;
		}
		out.push(p.chart);
	}
	// One entry per chart: the Weather tab keys its list on the link, and a
	// catalogue listing one chart twice would otherwise be refused there.
	const charts = uniqueBy(out, (c) => c.url);
	charts.sort(
		(a, b) => (a.validAtMs ?? 0) - (b.validAtMs ?? 0) || (a.level ?? '').localeCompare(b.level ?? ''),
	);
	return charts;
}

export interface SofiaChartsFetchOptions {
	/** A JSESSIONID from session.ts, passed as ?session= so the worker skips
	 *  its homepage handshake; null or absent, the worker does its own. */
	session?: string | null | undefined;
	/** Stops the request (and a retry's pause). */
	signal?: AbortSignal | undefined;
}

/** Fetch one product's catalog through the worker relay. Every failure
 *  throws a SofiaError carrying its classified cause (failure.ts): the
 *  transport and the budget, the proxy's own refusals with their body kept,
 *  a body that is not JSON, and SOFIA's server messages. */
export async function fetchSofiaCharts(
	proxyBase: string,
	product: SofiaChartProduct,
	zone: SofiaZone,
	opts: SofiaChartsFetchOptions = {},
): Promise<SofiaChart[]> {
	const url = `${proxyBase}/sofia` + (opts.session ? `?session=${encodeURIComponent(opts.session)}` : '');
	const timeout = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
	let res: Response;
	let text: string;
	try {
		res = await fetch(url, {
			method: 'POST',
			// A CORS-safelisted content type, so the browser sends no preflight.
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: chartsRequestBody(product, zone),
			signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
		});
		// Inside the try: the signal aborts the body stream too, so a budget
		// spent while reading stays a classified timeout.
		text = await res.text();
	} catch (e) {
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new SofiaError(fetchFailure(e, proxyBase, 'SOFIA chart catalog'));
	}
	if (!res.ok) {
		throw new SofiaError(httpFailure(res, text));
	}
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new SofiaError({
			code: 'malformed',
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			detail: `SOFIA chart catalog is not JSON: ${humanErrorDetail(text)}`,
		});
	}
	try {
		return parseSofiaCharts(payload, product);
	} catch (e) {
		throw new SofiaError(payloadFailure(e));
	}
}

/** Wait, unless `signal` aborts first (fetch.ts's pause, which has the same
 *  reason to cut a retry's wait short). */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const done = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener('abort', done, { once: true });
	});
}

/** fetchSofiaCharts, retried once after a spaced pause when the failure is
 *  worth it (failure.ts retryBudget; `maxRetries` 0 spends no retry at all,
 *  the cache's circuit breaker once SOFIA has already failed a request). The
 *  retry goes WITHOUT the session, so a stale JSESSIONID cannot fail it
 *  twice. Throws the clearer of the two failures (clearerFailure). */
export async function fetchSofiaChartsRetrying(
	proxyBase: string,
	product: SofiaChartProduct,
	zone: SofiaZone,
	opts: SofiaChartsFetchOptions & { maxRetries?: 0 | 1 } = {},
): Promise<SofiaChart[]> {
	const maxRetries = opts.maxRetries ?? 1;
	let reported: SofiaFailure | null = null;
	for (let attempt = 0; ; attempt++) {
		if (attempt > 0) {
			await pause(RETRY_PAUSE_MS, opts.signal);
		}
		try {
			return await fetchSofiaCharts(proxyBase, product, zone, {
				session: attempt === 0 ? opts.session : null,
				signal: opts.signal,
			});
		} catch (e) {
			if (!(e instanceof SofiaError)) {
				throw e;
			}
			reported = reported ? clearerFailure(reported, e.failure) : e.failure;
			if (attempt >= Math.min(maxRetries, retryBudget(e.failure.code))) {
				throw new SofiaError(reported);
			}
		}
	}
}
