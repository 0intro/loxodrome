/* The airborne watermark both position-referenced alert engines read (the
 * airspace alerts, state/airspaceAlert.svelte.ts, and the terrain alerts,
 * state/terrainAlert.svelte.ts): the route-free stand-in for the motion
 * fold's takeoff commit, so the two gate on the SAME instant. Lifted out of
 * the airspace module unchanged in its rule, plus the one extra fact the
 * terrain engine needs: when the departure phase ends (TSO-C151c 10.4,
 * 1 500 ft above the departure runway).
 *
 * Watermarked per trace ARRAY (a live recording appends in place, an
 * imported trace is a fresh array), scanned incrementally, and answered as
 * trace instants so a scrubbed replay reads them against its own playhead.
 * Plain .ts: module memo, no reactivity (the navMotion.ts shape). */

import { deriveMotion, type TrackPoint } from '$lib/nav/trace';
import { TAKEOFF_KT } from '$lib/nav/navlogLive';

let airWm: {
	points: readonly TrackPoint[] | null;
	scanned: number;
	firstIdx: number | null;
	slowSeen: boolean;
} = {
	points: null,
	scanned: 0,
	firstIdx: null,
	slowSeen: false,
};

/** Index of the first trace fix at or above the takeoff speed. A point
 *  without a device speed (a bare GPX import) gets one derived from its
 *  predecessor, so a replayed debrief still passes the airborne gate. */
export function firstAirborneIndex(points: readonly TrackPoint[]): number | null {
	if (airWm.points !== points) {
		airWm = { points, scanned: 0, firstIdx: null, slowSeen: false };
	}
	if (airWm.firstIdx == null) {
		for (let i = airWm.scanned; i < points.length; i++) {
			let kt = points[i].speedKt;
			if (kt == null && i > 0) {
				kt = deriveMotion(points[i - 1], points[i]).speedKt;
			}
			if ((kt ?? 0) >= TAKEOFF_KT) {
				airWm.firstIdx = i;
				break;
			}
			if (kt != null) {
				airWm.slowSeen = true;
			}
		}
		airWm.scanned = points.length;
	}
	return airWm.firstIdx;
}

/** Whether the trace saw its own takeoff: a fix below the takeoff speed
 *  before the first one at or above it. False for a trace that opens already
 *  fast (a recording started in flight, a file cut after the climb), whose
 *  airborne instant is inherited rather than observed, navlogLive's own
 *  `takeoffObserved`; null while the trace has not been airborne. */
export function takeoffObserved(points: readonly TrackPoint[]): boolean | null {
	return firstAirborneIndex(points) == null ? null : airWm.slowSeen;
}

/** First trace instant at or above the takeoff speed; the alert gate's
 *  route-free stand-in for the motion fold's takeoff commit. */
export function firstAirborneMs(points: readonly TrackPoint[]): number | null {
	const i = firstAirborneIndex(points);
	return i == null ? null : points[i].timeMs;
}

/** Height above the departure the departure phase ends at (TSO-C151c 10.4). */
export const DEPARTURE_END_FT = 1500;

let depWm: {
	points: readonly TrackPoint[] | null;
	scanned: number;
	baseFt: number | null;
	endMs: number | null;
} = { points: null, scanned: 0, baseFt: null, endMs: null };

/** The trace's own altitude at the airborne instant (the device's feet, on
 *  the trace's own datum: the first fix at or after it that carries one,
 *  since a recorder may interleave fixes without), and the first instant
 *  after it at which the trace stood DEPARTURE_END_FT above that: the end of
 *  the departure phase. The difference is taken between two readings on one
 *  datum, so the geoid offset cancels. Both null while the trace has given no
 *  altitude since takeoff; `endMs` null while the climb has not got there.
 *
 *  A trace that did not see its takeoff (takeoffObserved false) has no
 *  departure to measure from: the altitude it was joined at is a cruise
 *  level as often as not, and 1 500 ft above THAT would hold the departure's
 *  100 ft clearance over a whole IFR cruise. Its departure phase ends at the
 *  airborne instant. Once found, the end is final: a live recording
 *  appending fixes must not move it, or the replay of the same array would
 *  read another phase than the flight did. */
export function departureWatermark(points: readonly TrackPoint[]): { baseFt: number | null; endMs: number | null } {
	const first = firstAirborneIndex(points);
	if (depWm.points !== points) {
		depWm = { points, scanned: 0, baseFt: null, endMs: null };
	}
	if (first == null) {
		return { baseFt: null, endMs: null };
	}
	if (depWm.endMs != null) {
		return { baseFt: depWm.baseFt, endMs: depWm.endMs };
	}
	if (!airWm.slowSeen) {
		depWm.endMs = points[first].timeMs;
		depWm.scanned = points.length;
		return { baseFt: null, endMs: depWm.endMs };
	}
	if (depWm.scanned < first) {
		depWm.scanned = first;
	}
	for (let i = depWm.scanned; i < points.length; i++) {
		const a = points[i].altFt;
		depWm.scanned = i + 1;
		if (a == null) {
			continue;
		}
		if (depWm.baseFt == null) {
			depWm.baseFt = a;
		} else if (a >= depWm.baseFt + DEPARTURE_END_FT) {
			depWm.endMs = points[i].timeMs;
			break;
		}
	}
	if (depWm.endMs != null) {
		depWm.scanned = points.length;
	}
	return { baseFt: depWm.baseFt, endMs: depWm.endMs };
}
