/* Loader for the generated NATS aerodrome-chart-links dataset
 * (public/data/uk-adcharts.json, cmd/ukcharts): per UK aerodrome, the
 * chart PDFs its AD 2 / AD 3 page publishes, as [code, title, path]
 * tuples. Paths are stored relative to the AIRAC-root URL
 * (graphics/<n>.pdf); the NATS tree rotates every cycle with no stable
 * alias, so absolute URLs are rebuilt here against the cycle in force at
 * load, the same way adcharts.ts does for the SIA. */

import type { AirportChart } from '$lib/data/airports';
import { natsEaipBase } from '$lib/data/airports';

/** One stored chart tuple, matching chartFields in cmd/ukcharts. */
type ChartRow = readonly [code: string, title: string, path: string];

type AdChartsRow = readonly [icao: string, charts: readonly ChartRow[]];

interface RawAdCharts {
	fields: string[];
	chartFields: string[];
	base: string;
	rows: readonly AdChartsRow[];
}

/** The published chart set of one aerodrome, URLs resolved. */
export interface AerodromeCharts {
	ident: string;
	charts: AirportChart[];
}

/** Current-cycle dataset URL. cmd/ukcharts emits this file. */
export const UK_ADCHARTS_URL = '/data/uk-adcharts.json';

/** Pre-release dataset URL (written during the NATS pre-release window). */
export const UK_ADCHARTS_NEXT_URL = '/data/uk-adcharts.next.json';

/** Absolute URL of one stored chart path, against the AIRAC cycle in
 *  force at `now` (the dataset stores AIRAC-root-relative paths). */
export function ukAdChartUrl(path: string, now: number = Date.now()): string {
	return natsEaipBase(now) + path;
}

/** Decode one dataset row, resolving each chart path so the rows drop
 *  into the panel exactly like the French and Belgian stored charts. */
export function rowToAerodromeCharts(r: AdChartsRow, now: number = Date.now()): AerodromeCharts {
	return {
		ident: r[0],
		charts: r[1].map((c) => ({ code: c[0], title: c[1], url: ukAdChartUrl(c[2], now) })),
	};
}

/** Load the chart-links artefact. Fail-soft: an HTTP error OR a non-JSON
 *  200 (Vite dev's SPA fallback) returns [] so the airport panel keeps
 *  its plain AD 2 page link with no list. */
export async function loadUkAdCharts(
	url: string = UK_ADCHARTS_URL,
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
