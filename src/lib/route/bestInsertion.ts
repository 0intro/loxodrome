/* Where a point picked off the map's furniture (a town's panel) joins a
 * route: on the leg it lengthens least, the cheapest-insertion rule. Only
 * between two existing waypoints: the departure and the destination stay
 * what they are. Pure. */

import { equirectangularDistanceM } from '$lib/notam/geometry';
import type { LatLon } from '$lib/notam/types';

/** The index of the waypoint after which `p` adds the least distance, or
 *  null for a route of fewer than two waypoints, which has no leg (the
 *  caller appends). Ties go to the earlier leg. */
export function bestInsertionIndex(wps: readonly LatLon[], p: LatLon): number | null {
	if (wps.length < 2) {
		return null;
	}
	let best = 0;
	let bestCost = Infinity;
	for (let i = 0; i + 1 < wps.length; i++) {
		const a = wps[i];
		const b = wps[i + 1];
		const cost =
			equirectangularDistanceM(a.lat, a.lon, p.lat, p.lon) +
			equirectangularDistanceM(p.lat, p.lon, b.lat, b.lon) -
			equirectangularDistanceM(a.lat, a.lon, b.lat, b.lon);
		if (cost < bestCost) {
			best = i;
			bestCost = cost;
		}
	}
	return best;
}
