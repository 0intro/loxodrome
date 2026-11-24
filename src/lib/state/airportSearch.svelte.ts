/* Airport search: the query box for the "Airports" sidebar tab, ranked by the
 * one search engine (src/lib/search, docs/search.md). Kept separate from
 * filter.query (the NOTAM free-text search) so the two never interfere. */

import type { Airport } from '$lib/data/airports';
import type { FuelType } from '$lib/aircraft/schema';
import type { Place } from '$lib/data/places';
import type { LatLon } from '$lib/notam/types';
import { NEAREST_LIMIT, nearestAerodromes, nearestCandidatesFor, type NearestAerodrome } from '$lib/nav/nearest';
import { getAirports, dataState } from '$lib/state/data.svelte';
import { getPlaces } from '$lib/state/places.svelte';
import { rankAirports } from '$lib/search/airports';
import { namedTown } from '$lib/search/places';
import { prepareQuery } from '$lib/search/query';
import { compareHits, type Hit } from '$lib/search/rank';

/** Cap on rendered result rows. Generous enough that a country-prefix query
 *  (e.g. "LF" matches ~450 French aerodromes) shows them all in the scrolling
 *  panel, yet still guards against a 1-character query trying to render the
 *  whole ~41k dataset. The total is surfaced when results are truncated. */
export const RESULT_CAP = 500;

/** How far a town's list reaches for its NEAREST_LIMIT aerodromes. UL91 is
 *  sold at 30 French fields: 25 NM finds a seller for 43% of the French
 *  towns of 5,000 people or more, 100 NM for 98%. */
export const TOWN_RADIUS_NM = 100;

export const airportSearch = $state<{ query: string; grades: FuelType[] }>({
	query: '',
	// Session-only, like every other view filter: a grade ticked to plan one
	// trip should not still be narrowing the list next week.
	grades: [],
});

/** The aerodromes nearest a town the query names. */
export interface TownGroup {
	/** The town (search/places.ts namedTown). */
	hit: Hit<Place>;
	/** Its nearest open aerodromes the filter passes, nearest first, the
	 *  bearing from the town. */
	near: NearestAerodrome[];
	/** Whether the group comes before the matches: its town is the better
	 *  answer (the palette's rule for groups, combine.ts orderGroups). */
	first: boolean;
	/** The matches the group does not list, to follow it when it leads. */
	others: Airport[];
}

export interface AirportSearchResult {
	/** Ranked, best first, capped to RESULT_CAP. */
	results: Airport[];
	/** Total matches before the cap, for a "showing N of M" line. */
	total: number;
	town: TownGroup | null;
}

/** The Airports tab's ranked lookup for `query`, the tab's box once its
 *  typing pauses. `ref` is the point the nearest come first from
 *  (state/searchRef.ts). Without one, the names order the list. */
export function searchAirportsFor(
	query: string,
	keep?: (a: Airport) => boolean,
	ref: LatLon | null = null,
): AirportSearchResult {
	// getAirports() is a non-reactive ref; gate on the loaded flag so a
	// caller's $derived recomputes once the lazy load resolves (same idiom
	// as AirportDetail's `overhead`). getPlaces() is tracked itself.
	const all = dataState.airportsLoaded ? getAirports() : null;
	if (!all) {
		return { results: [], total: 0, town: null };
	}
	return rankAirportList(all, getPlaces(), query, keep, ref);
}

/** The Airports tab's list over given datasets: the aerodromes `query`
 *  matches, and the ones nearest the town it names. Pure. */
export function rankAirportList(
	airports: readonly Airport[],
	places: readonly Place[] | null,
	query: string,
	keep?: (a: Airport) => boolean,
	ref: LatLon | null = null,
): AirportSearchResult {
	const q = prepareQuery(query);
	// The predicate runs BEFORE the cap, so a filter cannot be defeated by a
	// broad query whose first 500 matches happen not to pass it. Injected
	// rather than read here: this module stays free of the datasets a caller
	// filters on (the perfWxStops idiom).
	const r = rankAirports(airports, q, { ref, cap: RESULT_CAP, keep });
	const results = r.hits.map((h) => h.item);
	const hit = places ? namedTown(places, q, ref) : null;
	if (!hit) {
		return { results, total: r.total, town: null };
	}
	const near = nearestAerodromes(nearestCandidatesFor(airports), hit.item.lat, hit.item.lon, {
		limit: NEAREST_LIMIT,
		radiusNM: TOWN_RADIUS_NM,
		keep,
	});
	// A town and an aerodrome never tie, the town standing half a tier off.
	const first = r.hits.length === 0 || compareHits(hit, r.hits[0]) < 0;
	// The candidates are the same objects, filtered from this array.
	const others = results.filter((a) => !near.some((n) => n.airport === a));
	return { results, total: r.total, town: { hit, near, first, others } };
}
