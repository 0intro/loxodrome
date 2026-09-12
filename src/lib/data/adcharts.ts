/* Loader for the generated SIA aerodrome-chart-links dataset
 * (public/data/fr-adcharts.json, cmd/adcharts): per IFR aerodrome, the
 * chart PDFs its eAIP AD 2 / AD 3 page publishes, as [code, title, path]
 * tuples, plus every ident's Atlas VAC membership. Paths are stored
 * relative to the tree's html/eAIP/ directory (the SIA has no stable alias
 * like skeyes' eAIP_Main, and the dated segments are derivable), so
 * absolute URLs are rebuilt here against the AIRAC cycle in force at load;
 * the VAC plate URLs are derived the same way from the membership alone. */

import type { AirportChart, VacAtlas } from '$lib/data/airports';
import { siaEaipHtmlBase } from '$lib/data/airports';

/** One stored chart tuple, matching chartFields in cmd/adcharts. */
type ChartRow = readonly [code: string, title: string, path: string];

type AdChartsRow = readonly [
	icao: string,
	charts: readonly ChartRow[],
	vac?: VacAtlas | '',
];

interface RawAdCharts {
	fields: string[];
	chartFields: string[];
	rows: readonly AdChartsRow[];
}

/** The published chart set of one aerodrome, URLs resolved, plus which SIA
 *  Atlas VAC carries its plate. `charts` is empty for the many idents that
 *  have a plate and no eAIP page at all (most hélistations, and every VFR
 *  aerodrome), so the row is a chart list, a VAC membership, or both. */
export interface AerodromeCharts {
	ident: string;
	charts: AirportChart[];
	vac: VacAtlas | null;
}

/** Current-cycle dataset URL. cmd/adcharts emits this file. */
export const FR_ADCHARTS_URL = '/data/fr-adcharts.json';

/** Pre-release dataset URL (written during the SIA pre-release window). */
export const FR_ADCHARTS_NEXT_URL = '/data/fr-adcharts.next.json';

/** Absolute URL of one stored chart path, against the AIRAC cycle in
 *  force at `now` (the dataset stores html/eAIP-relative paths). */
export function frAdChartUrl(path: string, now: number = Date.now()): string {
	return siaEaipHtmlBase(now) + path;
}

/** Decode one dataset row, resolving each chart path to its absolute URL
 *  so the rows drop into the panel exactly like the Belgian stored
 *  charts. Exported for the spec. */
export function rowToAerodromeCharts(r: AdChartsRow, now: number = Date.now()): AerodromeCharts {
	return {
		ident: r[0],
		charts: r[1].map((c) => ({ code: c[0], title: c[1], url: frAdChartUrl(c[2], now) })),
		vac: r[2] ? r[2] : null,
	};
}

/** Load the chart-links artefact. Fail-soft: an HTTP error OR a non-JSON
 *  200 (Vite dev's SPA fallback) returns [] so the airport panel simply
 *  omits its chart list. */
export async function loadFrAdCharts(
	url: string = FR_ADCHARTS_URL,
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
