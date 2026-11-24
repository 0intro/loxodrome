/* Towns on the search engine (docs/search.md "Towns"): a French commune or
 * a GeoNames town, found by its name as the charts print it and by the
 * names a pilot types for it ("Munich" for München), ranked under the same
 * match on an aerodrome or a navaid and above the next one, and nearer for
 * being larger. Pure. */

import type { Place } from '$lib/data/places';
import type { LatLon } from '$lib/notam/types';
import { frame } from './fold';
import { keyCache } from './keys';
import { TIER, type SearchKey } from './match';
import type { PreparedQuery } from './query';
import { CLASS, distFrom, KIND, rankRows, type Hit, type RankOptions, type Ranked } from './rank';

/** Where a town stands against the same match on an aerodrome or a navaid,
 *  which is what a pilot searches the most: under it, and above the next
 *  match. "Wien" typed whole is the city before Dierdorf-Wienau, which it
 *  merely begins. */
export const TOWN_TIER_SHIFT = 0.5;

/** A town's other names ("Munich", "Vienna") are names of the town itself,
 *  not a secondary attribute as an aerodrome's city is: matched as its
 *  names, so "Vienna" typed whole is Wien's exact name and outranks
 *  Viennay, which it merely begins. */
export const placeKey = keyCache(
	(p: Place): SearchKey => ({
		id: [],
		altId: [],
		name: frame([p.name, ...(p.alt ? p.alt.split('|') : [])]),
		altName: '',
	}),
);

/** How much nearer a town reads for its size, 1 + log10(1 + pop / 1000): a
 *  city of a million four times nearer than its distance, a village of a
 *  thousand 1.3 times; an unknown population counts as none. */
export function sizeFactor(pop: number | null): number {
	return 1 + Math.log10(1 + (pop ?? 0) / 1000);
}

export function rankPlaces(rows: readonly Place[], q: PreparedQuery, opts: RankOptions<Place>): Ranked<Place> {
	const { ref } = opts;
	return rankRows(
		rows,
		q,
		{
			key: placeKey,
			kind: KIND.place,
			cls: () => CLASS.TOWN,
			dist: (p) => distFrom(ref, p.lat, p.lon) / sizeFactor(p.pop),
			order: (p) => p.name,
			tierShift: TOWN_TIER_SHIFT,
			keep: opts.keep,
		},
		opts.cap,
	);
}

/** The town a query names: the best one whose name the query is, or whose
 *  words the query's words all begin. A town the query is only inside
 *  ("ampes" in Étampes) is named by nothing, nor is any for no match. */
export function namedTown(rows: readonly Place[], q: PreparedQuery, ref: LatLon | null): Hit<Place> | null {
	const hit = rankPlaces(rows, q, { ref, cap: 1 }).hits[0];
	if (!hit) {
		return null;
	}
	const t = hit.tier - TOWN_TIER_SHIFT;
	return t === TIER.NAME_EXACT || t === TIER.NAME_PREFIX ? hit : null;
}
