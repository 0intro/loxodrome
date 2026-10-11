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
import { readDataJsonSoft } from '$lib/data/fetchData';

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

/** A stored path against the artifact's base; one already absolute (a
 *  file the publisher serves outside the edition's tree) is kept. */
function resolvePath(base: string, path: string): string {
	return /^https?:\/\//.test(path) ? path : base + path;
}

/** Decode one dataset row against the artifact's edition base, so the
 *  charts drop into the panel exactly like the Belgian stored charts and
 *  the French scraped ones. Exported for the spec. */
export function rowToAerodromeLinks(r: AtAdChartsRow, base: string): AerodromeAipLinks {
	return {
		ident: r[0],
		adUrl: resolvePath(base, r[1]),
		charts: r[2].map((c) => ({ code: c[0], title: c[1], url: resolvePath(base, c[2]) })),
	};
}

/** Load the aerodrome-link artefact. */
export function loadAtAdCharts(url: string = AT_ADCHARTS_URL): Promise<AerodromeAipLinks[]> {
	return loadAipLinks(url);
}

/** Load an artefact in this shape, Austro Control's or one of the eAIP
 *  chart indexes cmd/eaip writes ($lib/data/aipCharts). Fail-soft for what
 *  the deployment does not hold (an absent file, Vite dev's SPA fallback
 *  included), which returns [] so the airport panel simply omits its chart
 *  row; a failure worth asking again REJECTS (readDataJsonSoft), for its
 *  retry. */
export async function loadAipLinks(url: string): Promise<AerodromeAipLinks[]> {
	const data = await readDataJsonSoft<RawAtAdCharts>(url);
	if (!data) {
		return [];
	}
	return data.rows.map((r) => rowToAerodromeLinks(r, data.base));
}
