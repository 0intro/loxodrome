/* Loader for the generated DFS aerodrome-link dataset
 * (public/data/de-adcharts.json, cmd/de -only adcharts): per German
 * aerodrome, a stable permalink into the DFS VFR eAIP.
 *
 * DFS renders each chart as an inline image on the aerodrome page rather
 * than a separate PDF, so there is no per-chart list to store; the
 * dataset is the aerodrome-to-permalink map alone. The permalink resolves
 * against a redirect stub DFS repoints to the current edition each cycle,
 * so the URL never rots and the dataset carries no AIRAC slot. */

import { readDataJsonSoft } from '$lib/data/fetchData';

/** One dataset row: ICAO plus the DFS permalink token. */
type DeAdChartsRow = readonly [icao: string, permalink: string];

interface RawDeAdCharts {
	fields: string[];
	base: string;
	rows: readonly DeAdChartsRow[];
}

/** The aerodrome-page link of one German aerodrome. */
export interface AerodromeAipLink {
	ident: string;
	url: string;
}

/** Dataset URL. cmd/de emits this file. */
export const DE_ADCHARTS_URL = '/data/de-adcharts.json';

/** Decode one row against the artifact's stub base. Exported for the spec. */
export function rowToAerodromeLink(r: DeAdChartsRow, base: string): AerodromeAipLink {
	return { ident: r[0], url: base + r[1] + '.html' };
}

/** Load the aerodrome-link artefact. Fail-soft for what the deployment
 *  does not hold (an absent file, Vite dev's SPA fallback included), which
 *  returns [] so the airport panel falls back to the generic DFS eAIP
 *  landing page; a failure worth asking again REJECTS (readDataJsonSoft),
 *  for its retry. */
export async function loadDeAdCharts(url: string = DE_ADCHARTS_URL): Promise<AerodromeAipLink[]> {
	const data = await readDataJsonSoft<RawDeAdCharts>(url);
	if (!data) {
		return [];
	}
	return data.rows.map((r) => rowToAerodromeLink(r, data.base));
}
