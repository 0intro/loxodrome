/* Loader for the generated FAA d-TPP chart dataset
 * (public/data/us-adcharts.json, cmd/faa -only adcharts): per US airport,
 * the terminal-procedure charts as [code, title, pdf] tuples. Same panel
 * surface as fr-adcharts.json.
 *
 * The FAA publishes one cycle directory per 28-day period, numbered by
 * the ICAO AIRAC YYNN label, so the base is derivable and rebuilt here
 * against the cycle in force at load. A superseded cycle's charts stay
 * online for a while, but the dataset ships a .next twin (the FAA
 * publishes the next cycle ahead) so the app flips at the changeover. */

import type { AirportChart } from '$lib/data/airports';
import { airacYYNN } from '$lib/data/airac';

/** One stored chart tuple, matching chartFields in cmd/faa/adcharts.go. */
type ChartRow = readonly [code: string, title: string, pdf: string];

type AdChartsRow = readonly [icao: string, charts: readonly ChartRow[]];

interface RawAdCharts {
	fields: string[];
	chartFields: string[];
	cycle: string;
	base: string;
	rows: readonly AdChartsRow[];
}

/** The published chart set of one airport, URLs resolved. */
export interface AerodromeCharts {
	ident: string;
	charts: AirportChart[];
}

/** Current-cycle dataset URL. cmd/faa emits this file. */
export const US_ADCHARTS_URL = '/data/us-adcharts.json';

/** Next-cycle dataset URL (the FAA publishes cycles ahead). */
export const US_ADCHARTS_NEXT_URL = '/data/us-adcharts.next.json';

/** The d-TPP cycle directory for the AIRAC cycle in force at `now`. The
 *  FAA numbers its cycles with the same YYNN label as ICAO AIRAC. */
export function dtppBase(now: number = Date.now()): string {
	return `https://aeronav.faa.gov/d-tpp/${airacYYNN(now)}/`;
}

/** Absolute URL of one stored PDF name, against the cycle in force. */
export function usAdChartUrl(pdf: string, now: number = Date.now()): string {
	return dtppBase(now) + pdf;
}

/** Decode one dataset row, resolving each PDF name so the rows drop into
 *  the panel exactly like the French stored charts. */
export function rowToAerodromeCharts(r: AdChartsRow, now: number = Date.now()): AerodromeCharts {
	return {
		ident: r[0],
		charts: r[1].map((c) => ({ code: c[0], title: c[1], url: usAdChartUrl(c[2], now) })),
	};
}

/** Load the chart dataset. Fail-soft: an HTTP error OR a non-JSON 200
 *  (Vite dev's SPA fallback) returns [] so the US airport panel simply
 *  shows no chart row. */
export async function loadUsAdCharts(
	url: string = US_ADCHARTS_URL,
	now: number = Date.now(),
): Promise<AerodromeCharts[]> {
	const res = await fetch(url);
	if (!res.ok) {
		console.warn(`${url}: HTTP ${res.status}`);
		return [];
	}
	const ct = res.headers.get('content-type') ?? '';
	if (!ct.includes('json')) {
		console.warn(`${url}: not JSON (got ${ct || 'no content-type'})`);
		return [];
	}
	const data = (await res.json()) as RawAdCharts;
	return data.rows.map((r) => rowToAerodromeCharts(r, now));
}
