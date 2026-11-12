/* Steering numbers to the active waypoint: what a pilot needs to fly the leg
 * rather than read about it afterwards. The bearing is the great-circle course
 * from the aircraft to the waypoint (the nav log's own magnetic conversion is
 * applied by the caller, sampled at the aircraft), the steer is the turn from
 * the track being flown onto it, and the cross-track is the projection fold's
 * lateral distance given the side it falls on. Pure geometry, no Svelte
 * (tests/navSteering.spec.ts). */

import { equirectangularDistanceM } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';

/** A route's polyline cut at the aircraft: what has been flown, and what is
 *  left of the leg being flown. Both share the cut point, so the two draw as
 *  one continuous line. */
export interface RouteSplit {
	/** Route start -> aircraft, inclusive of both. */
	flown: [number, number][];
	/** Aircraft -> the current leg's end waypoint. */
	activeLeg: [number, number][];
}

/** Cut the route at an along-route distance. The axis is the same
 *  equirectangular leg math as the progress fold and sampleRoute, so the cut
 *  lands where the fold says the aircraft is. Null for a degenerate route or a
 *  distance past the end (nothing left to fly). Pure. */
export function splitRouteAtNM(
	waypoints: readonly { lat: number; lon: number }[],
	distNM: number,
): RouteSplit | null {
	if (waypoints.length < 2 || !(distNM >= 0)) {
		return null;
	}
	const flown: [number, number][] = [[waypoints[0].lat, waypoints[0].lon]];
	let cum = 0;
	for (let i = 0; i + 1 < waypoints.length; i++) {
		const a = waypoints[i];
		const b = waypoints[i + 1];
		const legNM =
			equirectangularDistanceM(a.lat, a.lon, b.lat, b.lon) / NM_TO_METERS;
		if (legNM <= 0) {
			continue;
		}
		if (cum + legNM > distNM) {
			const f = (distNM - cum) / legNM;
			const cut: [number, number] = [a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f];
			flown.push(cut);
			return { flown, activeLeg: [cut, [b.lat, b.lon]] };
		}
		cum += legNM;
		flown.push([b.lat, b.lon]);
	}
	return null;
}

/** The turn that points the aircraft at the waypoint: the required bearing
 *  minus the track being flown, normalised to [-180, 180). POSITIVE IS A TURN
 *  RIGHT. Both angles must be on the same reference; the app's are magnetic
 *  throughout, since a true track shown beside a magnetic bearing is a trap.
 *
 *  This is the number a pilot actually flies, and it was the one figure the
 *  readout made them work out: the bearing and the track were both displayed,
 *  in cells that are not adjacent, and the difference between them was left
 *  as an exercise in the cockpit. */
export function steerDeg(bearingDeg: number, trackDeg: number): number {
	return (((bearingDeg - trackDeg) % 360) + 540) % 360 - 180;
}

/** Which side of the A -> B course the point lies on: +1 right, -1 left, 0 on
 *  it (or on a degenerate leg). Cos-lat planar, the projection fold's frame, so
 *  the sign agrees with the `offM` it qualifies. */
export function crossTrackSide(
	pLat: number,
	pLon: number,
	aLat: number,
	aLon: number,
	bLat: number,
	bLon: number,
): -1 | 0 | 1 {
	const cosLat = Math.cos((pLat * Math.PI) / 180);
	// x east, y north.
	const abx = (bLon - aLon) * cosLat;
	const aby = bLat - aLat;
	const apx = (pLon - aLon) * cosLat;
	const apy = pLat - aLat;
	const cross = abx * apy - aby * apx;
	if (cross === 0) {
		return 0;
	}
	// A positive cross product puts the point LEFT of the course (north of an
	// eastbound leg), which is a left cross-track error.
	return cross > 0 ? -1 : 1;
}
