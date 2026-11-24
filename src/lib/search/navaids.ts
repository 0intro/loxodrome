/* Navaids on the search engine: radio aids, VFR reporting points and RNAV
 * waypoints, for the palette's group and the route field's suggestions
 * (docs/search.md "Navaids"). Pure. */

import type { Navaid } from '$lib/data/navaids';
import type { VfrAerodrome } from '$lib/data/vfrAerodrome';
import { vrpLandmark } from '$lib/format/remark';
import { frame } from './fold';
import { keyCache } from './keys';
import type { SearchKey } from './match';
import type { PreparedQuery } from './query';
import { CLASS, distFrom, KIND, rankRows, type RankOptions, type Ranked } from './rank';

/** A radio aid ranks with the aerodromes, a reporting point or an RNAV
 *  waypoint under them at one match: an aerodrome's own points share its
 *  name (they match through it), and the field itself is what its name
 *  asks for; the waypoints are most of the rows and the least asked for. */
export function navaidClass(n: Navaid): number {
	return n.type === 'WAYPOINT' || n.type === 'VFR_REPORTING_POINT' ? CLASS.MINOR : CLASS.OPEN;
}

/** A navaid is matched on its ident and its name. A VFR reporting point is
 *  also matched on its aerodrome: the ICAO ranks just under an ident of its
 *  own, and the aerodrome's name counts as one of the point's names, so a
 *  nearby aerodrome's points float above a far namesake. Its landmark, where
 *  the AIP states one (France: "Neuville de Poitou" for BI-N), is a second
 *  name. */
function navaidKeyWith(n: Navaid, aero: VfrAerodrome | null): SearchKey {
	return {
		id: [n.ident.toUpperCase()],
		altId: aero ? [aero.ident.toUpperCase()] : [],
		name: frame([n.name, aero?.name]),
		altName: n.type === 'VFR_REPORTING_POINT' && n.rmk ? frame([vrpLandmark(n.rmk)]) : '',
	};
}

// One key cache per aerodrome map: the map is rebuilt when a dataset merges
// (waypointSearch's memo), and a point's aerodrome may change with it.
const caches = new WeakMap<ReadonlyMap<string, VfrAerodrome>, (n: Navaid) => SearchKey>();
const plainKey = keyCache((n: Navaid) => navaidKeyWith(n, null));

export function navaidKeyFor(aero: ReadonlyMap<string, VfrAerodrome> | null): (n: Navaid) => SearchKey {
	if (!aero) {
		return plainKey;
	}
	let k = caches.get(aero);
	if (!k) {
		k = keyCache((n: Navaid) => navaidKeyWith(n, aero.get(n.id) ?? null));
		caches.set(aero, k);
	}
	return k;
}

export function rankNavaids(
	rows: readonly Navaid[],
	q: PreparedQuery,
	opts: RankOptions<Navaid> & { readonly aero?: ReadonlyMap<string, VfrAerodrome> | null | undefined },
): Ranked<Navaid> {
	const { ref } = opts;
	return rankRows(
		rows,
		q,
		{
			key: navaidKeyFor(opts.aero ?? null),
			kind: KIND.navaid,
			cls: navaidClass,
			dist: (n) => distFrom(ref, n.lat, n.lon),
			order: (n) => n.ident,
			keep: opts.keep,
		},
		opts.cap,
	);
}
