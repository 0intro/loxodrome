/* Aerodromes on the search engine: the Airports tab's list, the palette's
 * group and the route field's suggestions rank them through this one
 * provider (docs/search.md "Aerodromes"). Pure. */

import type { Airport } from '$lib/data/airports';
import { frame } from './fold';
import { keyCache } from './keys';
import type { PreparedQuery } from './query';
import { CLASS, distFrom, KIND, rankRows, type RankOptions, type Ranked } from './rank';

/** An aerodrome is matched on its ICAO ident, then its IATA code, its name,
 *  and its city with the names a national dataset replaced (the worldwide
 *  baseline's "Munich Airport" under DFS's MUENCHEN). */
export const airportKey = keyCache((a: Airport) => ({
	id: [a.ident.toUpperCase()],
	altId: a.iata ? [a.iata.toUpperCase()] : [],
	name: frame([a.name]),
	altName: frame([a.city, ...(a.altNames ?? [])]),
}));

/** An airfield above a heliport, a seaplane or balloon base, a closed field
 *  last: what the type says the place is good for. */
export function airportClass(a: Airport): number {
	switch (a.type) {
		case 'closed':
			return CLASS.CLOSED;
		case 'heliport':
		case 'seaplane_base':
		case 'balloonport':
			return CLASS.MINOR;
		default:
			return CLASS.OPEN;
	}
}

export function rankAirports(rows: readonly Airport[], q: PreparedQuery, opts: RankOptions<Airport>): Ranked<Airport> {
	const { ref } = opts;
	return rankRows(
		rows,
		q,
		{
			key: airportKey,
			kind: KIND.airport,
			cls: airportClass,
			dist: (a) => distFrom(ref, a.lat, a.lon),
			order: (a) => a.ident,
			keep: opts.keep,
		},
		opts.cap,
	);
}
