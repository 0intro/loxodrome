/* Loader for the generated Austro Control aerodrome-link dataset
 * (public/data/at-adcharts.json, cmd/at -only adcharts): per AIP
 * aerodrome, the path of its AD 2 / AD 3 text section plus the chart PDFs
 * its charts page publishes, as [code, title, path] tuples.
 *
 * Paths are stored relative to one eAIP edition, whose base rides in the
 * artifact. Austro Control dates its edition directory by the edition's
 * own validity rather than the AIRAC date (the cycle effective
 * 2026-07-09 is published as edition 260710), so the base is carried
 * rather than recomputed the way the SIA one is in adcharts.ts. A
 * superseded edition is withdrawn, so the dataset ships a .next twin
 * built from the edition that follows: `pickActiveDataset` swaps to it on
 * its own effective date, which is the day the current one goes away. */

import type { AirportChart } from '$lib/data/airports';

/** One stored chart tuple, matching chartFields in cmd/at/adcharts.go. */
type ChartRow = readonly [code: string, title: string, path: string];

type AtAdChartsRow = readonly [icao: string, ad: string, charts: readonly ChartRow[]];

interface RawAtAdCharts {
	fields: string[];
	chartFields: string[];
	edition: string;
	base: string;
	rows: readonly AtAdChartsRow[];
}

/** The published AIP links of one Austrian aerodrome, URLs resolved. */
export interface AerodromeAipLinks {
	ident: string;
	/** The AD 2 / AD 3 text section PDF, published for every aerodrome. */
	adUrl: string;
	/** Its chart set; empty for the aerodromes that publish no charts page. */
	charts: AirportChart[];
}

/** Current-edition dataset URL. cmd/at emits this file. */
export const AT_ADCHARTS_URL = '/data/at-adcharts.json';

/** Next-edition dataset URL (the eAIP publishes ahead, so this is the
 *  normal state, not a pre-release window). */
export const AT_ADCHARTS_NEXT_URL = '/data/at-adcharts.next.json';

/** Decode one dataset row against the artifact's edition base, so the
 *  charts drop into the panel exactly like the Belgian stored charts and
 *  the French scraped ones. Exported for the spec. */
export function rowToAerodromeLinks(r: AtAdChartsRow, base: string): AerodromeAipLinks {
	return {
		ident: r[0],
		adUrl: base + r[1],
		charts: r[2].map((c) => ({ code: c[0], title: c[1], url: base + c[2] })),
	};
}

/** Load the aerodrome-link artefact. Fail-soft: an HTTP error OR a
 *  non-JSON 200 (Vite dev's SPA fallback) returns [] so the airport panel
 *  simply omits its chart row. */
export async function loadAtAdCharts(url: string = AT_ADCHARTS_URL): Promise<AerodromeAipLinks[]> {
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
	const data = (await res.json()) as RawAtAdCharts;
	return data.rows.map((r) => rowToAerodromeLinks(r, data.base));
}
