/* SOFIA-Briefing TEMSI / WINTEM chart catalog: build the Sling catalog
 * operations, unwrap the envelope (client.ts's unwrapSofiaMessage) and
 * shape each chart into a dated, directly downloadable link. Transport is
 * the same worker relay as the route-NOTAM fetch (notam-proxy handleSofia:
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

const METEO_BASE = 'https://aviation.meteo.fr';

/** Hung requests must settle (the awc.ts convention). */
const FETCH_TIMEOUT_MS = 15_000;

export type SofiaChartProduct = 'TEMSI' | 'WINTEM';

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
	/** Level band exactly as served ("FL20-150", "FL20-100", "FL050"...). */
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
		// The SPA's initial filter; the response carries every level anyway.
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
 *  labels untouched (SOFIA owns the vocabulary). */
export function parseSofiaCharts(payload: unknown, product: SofiaChartProduct): SofiaChart[] {
	const inner = unwrapSofiaMessage(payload);
	const zones = inner['zones'];
	const out: SofiaChart[] = [];
	if (!Array.isArray(zones)) {
		return out;
	}
	const key = product === 'TEMSI' ? 'temsi' : 'wintem';
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
			// WINTEM entries all carry the zone's BAND in `level` (FL20-100)
			// while the actual per-chart level hides in the link's layer path
			// (wintemp/fr/france/fl020); prefer that when present so the rows
			// read "WINTEM FL020" rather than three identical bands.
			const linkLevel = /\/fl(\d{2,3})(?:[&/]|$)/.exec(e.link.toLowerCase());
			const band = typeof e.level === 'string' && e.level ? e.level : null;
			out.push({
				product,
				level: linkLevel ? `FL${linkLevel[1].padStart(3, '0')}` : band,
				zone:
					typeof e.zone === 'string' && e.zone
						? e.zone
						: typeof z.name === 'string'
							? z.name
							: '',
				deadline: typeof e.deadline === 'string' ? e.deadline : '',
				validAtMs: parseSofiaDate(e.date),
				url: `${METEO_BASE}${e.link.startsWith('/') ? '' : '/'}${e.link}`,
			});
		}
	}
	out.sort(
		(a, b) => (a.validAtMs ?? 0) - (b.validAtMs ?? 0) || (a.level ?? '').localeCompare(b.level ?? ''),
	);
	return out;
}

/** Fetch one product's catalog through the worker relay. Throws readable
 *  errors (HTTP, envelope, SOFIA server messages). */
export async function fetchSofiaCharts(
	proxyBase: string,
	product: SofiaChartProduct,
	zone: SofiaZone,
): Promise<SofiaChart[]> {
	const res = await fetch(`${proxyBase}/sofia`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: chartsRequestBody(product, zone),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) {
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new Error(`SOFIA catalog fetch failed: ${res.status}`);
	}
	return parseSofiaCharts((await res.json()) as unknown, product);
}
