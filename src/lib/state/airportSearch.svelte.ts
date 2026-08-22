/* Airport search: the query box for the "Airports" sidebar tab plus a ranked,
 * capped lookup over the loaded airport dataset. Kept separate from
 * filter.query (the NOTAM free-text search) so the two never interfere. */

import type { Airport } from '$lib/data/airports';
import { getAirports, dataState } from '$lib/state/data.svelte';

/** Cap on rendered result rows. Generous enough that a country-prefix query
 *  (e.g. "LF" matches ~450 French aerodromes) shows them all in the scrolling
 *  panel, yet still guards against a 1-character query trying to render the
 *  whole ~41k dataset. The total is surfaced when results are truncated. */
export const RESULT_CAP = 500;

export const airportSearch = $state<{ query: string }>({ query: '' });

export interface AirportSearchResult {
	/** Ranked, best first, capped to RESULT_CAP. */
	results: Airport[];
	/** Total matches before the cap, for a "showing N of M" line. */
	total: number;
}

/** Match score; lower is better, -1 means no match. iata and city are often
 *  empty strings, so guard them before comparing. */
function score(a: Airport, qUpper: string, qLower: string): number {
	const ident = a.ident.toUpperCase();
	const iata = a.iata.toUpperCase();
	const name = a.name.toLowerCase();
	const city = a.city.toLowerCase();
	if (ident === qUpper) return 0; // exact ICAO
	if (iata && iata === qUpper) return 1; // exact IATA
	if (ident.startsWith(qUpper)) return 2; // ICAO prefix
	if (iata && iata.startsWith(qUpper)) return 3; // IATA prefix
	if (name.startsWith(qLower)) return 4; // name prefix
	if (city.startsWith(qLower)) return 5; // city prefix
	if (name.includes(qLower)) return 6; // name substring
	if (city.includes(qLower)) return 7; // city substring
	if (ident.includes(qUpper)) return 8; // ICAO substring (rare)
	return -1;
}

/** Tie-break by facility importance so a query like "lond" surfaces the major
 *  fields first and closed aerodromes sink to the bottom. */
function typeRank(a: Airport): number {
	switch (a.type) {
		case 'large_airport':
			return 0;
		case 'medium_airport':
			return 1;
		case 'small_airport':
			return 2;
		case 'closed':
			return 9;
		default:
			return 3; // heliport / seaplane_base / balloonport
	}
}

export function searchAirports(): AirportSearchResult {
	return searchAirportsFor(airportSearch.query);
}

/** The same ranked lookup for a caller-supplied query (the search palette),
 *  leaving the Airports tab's own box untouched. */
export function searchAirportsFor(query: string): AirportSearchResult {
	const q = query.trim();
	// getAirports() is a non-reactive ref; gate on the loaded flag so a
	// caller's $derived recomputes once the lazy load resolves (same idiom
	// as AirportDetail's `overhead`).
	const all = dataState.airportsLoaded ? getAirports() : null;
	if (!q || !all) {
		return { results: [], total: 0 };
	}
	const qUpper = q.toUpperCase();
	const qLower = q.toLowerCase();
	const scored: { a: Airport; s: number }[] = [];
	for (const a of all) {
		const s = score(a, qUpper, qLower);
		if (s >= 0) {
			scored.push({ a, s });
		}
	}
	scored.sort(
		(x, y) =>
			x.s - y.s ||
			typeRank(x.a) - typeRank(y.a) ||
			x.a.ident.localeCompare(y.a.ident),
	);
	return {
		results: scored.slice(0, RESULT_CAP).map((e) => e.a),
		total: scored.length,
	};
}
