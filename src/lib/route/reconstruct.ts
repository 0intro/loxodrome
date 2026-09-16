/* Dead-reckon an approximate position for a name-only route waypoint (one with a
 * name but no ident and no lat/lon, e.g. a VFR reporting point from a legacy nav
 * library) from a neighbouring known waypoint, using the saved per-leg magnetic
 * course + distance. Inverts the nav-log course computation (magneticFromTrue):
 * true = magnetic + declination, sampling declination at the known seed (the far
 * end isn't placed yet; the error over a short leg is negligible), then projects
 * on a sphere with destinationPoint. Pure (year injected) and unit-tested.
 *
 * leg.course / leg.distance live on waypoint i and describe the hop i -> i+1, so:
 *   - forward  (place i from a known i-1): wps[i-1].course / .distance
 *   - backward (place i from a known i+1): wps[i].course / .distance, bearing + 180 */

import { destinationPoint } from '$lib/notam/geometry';
import type { LatLon } from '$lib/notam/types';
import { NM_TO_METERS } from '$lib/notam/units';
import { magneticDeclinationDeg } from '$lib/route/magnetic';
import type { LoadedWaypoint } from '$lib/route/yaml';

/** Project from a known point along a saved magnetic course for distanceNM. When
 *  reverse, travel the opposite way (the saved course describes the hop leaving
 *  the still-unknown fix toward this seed). */
export function deadReckon(
	from: LatLon,
	magCourseDeg: number,
	distanceNM: number,
	reverse: boolean,
	year: number,
): LatLon {
	const trueDeg = magCourseDeg + magneticDeclinationDeg(from.lat, from.lon, year);
	const bearing = (((reverse ? trueDeg + 180 : trueDeg) % 360) + 360) % 360;
	return destinationPoint(from.lat, from.lon, bearing, distanceNM * NM_TO_METERS);
}

/** A name-only waypoint: no ident and no explicit coordinates, so its position
 *  must be reconstructed. (Anchored idents and free lat/lon points are not.) */
function isTarget(w: LoadedWaypoint): boolean {
	return !w.ident && w.lat === undefined && w.lon === undefined;
}

function usable(n: number | undefined): n is number {
	return typeof n === 'number' && Number.isFinite(n);
}

/** Fill the positions of name-only waypoints by dead reckoning from resolved
 *  neighbours. `known[i]` is the resolved position of waypoint i (an anchored
 *  ident's coords or a free point's lat/lon), or null when unknown. Returns a new
 *  array with reconstructed positions filled in where reachable; targets that
 *  can't be reached (no usable neighbour, or a missing course/distance) stay null.
 *  A dropped ident (known[i] === null but not a target) is a barrier: never a seed
 *  source for, nor a target of, reconstruction. */
export function reconstructPositions(
	wps: LoadedWaypoint[],
	known: (LatLon | null)[],
	year: number,
): (LatLon | null)[] {
	const pos = known.slice();
	// Fixed point: a chain of name-only points needs at most wps.length passes.
	for (let pass = 0; pass < wps.length; pass++) {
		let changed = false;
		for (let i = 0; i < wps.length; i++) {
			if (pos[i] || !isTarget(wps[i])) {
				continue;
			}
			// forward from the previous fix, using its outbound leg (i-1 -> i)
			const prev = i > 0 ? pos[i - 1] : null;
			const pc = i > 0 ? wps[i - 1].course : undefined;
			const pd = i > 0 ? wps[i - 1].distance : undefined;
			if (prev && usable(pc) && usable(pd)) {
				const p = deadReckon(prev, pc, pd, false, year);
				if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
					pos[i] = p;
					changed = true;
					continue;
				}
			}
			// backward from the next fix, using this fix's outbound leg (i -> i+1)
			const next = i < wps.length - 1 ? pos[i + 1] : null;
			const c = wps[i].course;
			const d = wps[i].distance;
			if (next && usable(c) && usable(d)) {
				const p = deadReckon(next, c, d, true, year);
				if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
					pos[i] = p;
					changed = true;
					continue;
				}
			}
		}
		if (!changed) {
			break;
		}
	}
	return pos;
}
