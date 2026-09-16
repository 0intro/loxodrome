/* Which planned leg the recorded trace is flying, and where it hands over to
 * the next one. A saved plan is usually several consecutive routes, one per
 * touchdown or stopover, each with its optional alternate; this fold cuts the
 * trace into one segment per leg flown, so every downstream answer (the plog,
 * the contact chain, the schedule) is asked of the right leg.
 *
 * The handover is triggered by ARRIVAL, not by landing: the junction of two
 * chained legs is commonly a touch-and-go, which the landing rule
 * deliberately does not see (nav/navlogLive), while the arrival test reads
 * the same for a touch-and-go and for a full stop.
 *
 * The successor is the NEXT TRIP, by default and immediately. Scoring the
 * successors geometrically instead picks the alternate: over the first miles
 * after a junction the climb-out turn sits closer to the alternate's bearing
 * than to the trip's, and the trip only wins past about 15 NM, thinly. An
 * alternate is a contingency, so it takes over only on decisive, sustained
 * evidence of a diversion (the trip's own projection off-route while the
 * alternate fits), the "override when sure, else flag" discipline.
 *
 * The candidate set does most of the work: an alternate is a candidate ONLY
 * as the successor of its own trip. Two routes of one plan often share their
 * whole first leg (a trip departing the field its last alternate departs), so
 * no geometry could separate them; the trip chain can.
 *
 * A segment is closed at the leg's arrival and the next opens at the LAST fix
 * still inside the junction, so circuits at a junction are charged to the
 * arrival and the onward leg's elapsed time is its own. The two therefore
 * overlap on purpose: a playhead inside the junction window still reads the
 * leg that arrived.
 *
 * Deterministic over the trace prefix like the other folds, so replay
 * scrubbing answers identically, and extendable: a closed segment is final,
 * so only the open one is re-derived as fixes arrive. No Svelte, no I/O
 * (tests/navRouteAssign.spec.ts); contract: docs/nav-live.md. */

import { equirectangularDistanceM } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import { orderedTrips, type RouteLike } from '$lib/aircraft/trips';
import { computeRouteProgress, type RouteProgressPoint } from './routeProgress';
import { ARRIVAL_EPS_NM } from './navlogLive';
import type { TrackPoint } from './trace';
import type { Waypoint } from '$lib/state/route.svelte';

/** How close the first fix must be to a leg's departure for that leg to be
 *  seeded by position rather than by geometry. Wide enough for a fix taken
 *  on the apron of a large field or on the climb-out, tight enough that a
 *  neighbouring aerodrome is never mistaken for the departure. */
export const DEPARTURE_RADIUS_NM = 3;
/** The ring around a junction inside which the aircraft counts as still at
 *  it. Calibrated on a recorded LFPL - LFFN - LFGP - LFPL flight, whose
 *  circuits at both junctions stay inside 2 NM. */
export const JUNCTION_RADIUS_NM = 2;
/** Once this far beyond the junction ring, the flight has left for good and
 *  the scan stops: a plan that comes back past its own junction later must
 *  not drag the onward leg's start with it. */
export const JUNCTION_CLEAR_NM = 5;
/** Median lateral offset (NM) beyond which a leg is not the one being flown.
 *  The seed refuses a match above it; a chained leg is still assigned (the
 *  trip-default rule) and reports the figure instead. */
export const MATCH_MAX_OFF_NM = 5;
/** Ground flown (NM) over which the seed's geometric fallback is scored. */
export const MATCH_WINDOW_NM = 10;
/** A diversion needs the alternate to fit this closely while the trip is
 *  beyond MATCH_MAX_OFF_NM. */
export const DIVERT_FIT_NM = 2;
/** ...and it must hold over this much ground before the leg is reassigned:
 *  one wide circuit or a weather deviation is not a diversion. */
export const DIVERT_SUSTAIN_NM = 8;

/** A drawn route, as much of it as the assignment reads. */
export interface AssignRoute extends RouteLike {
	id: string;
	waypoints: readonly Waypoint[];
}

/** One leg of the plan as actually flown: the slice of the trace on it. */
export interface RouteSegment {
	routeId: string;
	/** First trace index flown on this leg, and its instant. */
	fromIdx: number;
	fromMs: number;
	/** Index and instant of the arrival at the leg's last waypoint; null
	 *  while the leg is still being flown. */
	toIdx: number | null;
	arrivalMs: number | null;
	/** Median lateral offset (NM) over the segment: how far the flight ran
	 *  from the leg it was assigned to. */
	offNM: number;
	/** The leg begins where the preceding one arrived, so its identity is
	 *  proven by the junction rather than by its own seed (extendCrossings
	 *  takes this as its `chained` flag). */
	chained: boolean;
	/** The leg came from the pilot's manual pin, not from the fold. */
	pinned: boolean;
	/** fromIdx can no longer move: the flight left the junction that set it
	 *  (or there was none). It is the last fix INSIDE the junction, so it
	 *  depends on fixes after the preceding arrival; only a settled start may
	 *  be cached across an extension. */
	startFinal: boolean;
}

function distNM(
	a: { lat: number; lon: number },
	b: { lat: number; lon: number },
): number {
	return equirectangularDistanceM(a.lat, a.lon, b.lat, b.lon) / NM_TO_METERS;
}

/** A route's total length (NM) on the fold's own axis. */
function routeTotalNM(wps: readonly Waypoint[]): number {
	let total = 0;
	for (let i = 0; i + 1 < wps.length; i++) {
		total += distNM(wps[i], wps[i + 1]);
	}
	return total;
}

/** Median lateral offset (NM) over a fold's checkpoints; Infinity with none
 *  (no evidence either way, which the seed reads as "not this leg"). */
function medianOffNM(cps: readonly RouteProgressPoint[]): number {
	if (cps.length === 0) {
		return Infinity;
	}
	const offs = cps.map((c) => (c.offM ?? 0) / NM_TO_METERS).sort((a, b) => a - b);
	return offs[offs.length >> 1];
}

/** The first index at which the fold has reached the leg's end. */
function arrivalIdxOf(
	cps: readonly RouteProgressPoint[],
	fromIdx: number,
	totalNM: number,
): number | null {
	for (let j = 0; j < cps.length; j++) {
		if (cps[j].distNM >= totalNM - ARRIVAL_EPS_NM) {
			return fromIdx + j;
		}
	}
	return null;
}

/** The last index still inside the junction ring, scanning forward from the
 *  arrival and stopping once the flight is clear of it for good. `final` says
 *  the scan ended by leaving the junction rather than by running out of
 *  fixes: until then the answer may still move, so the segment it opens must
 *  not be cached as settled. */
function junctionStartIdx(
	points: readonly TrackPoint[],
	arrIdx: number,
	at: Waypoint,
): { idx: number; final: boolean } {
	let last = arrIdx;
	for (let i = arrIdx; i < points.length; i++) {
		const d = distNM(points[i], at);
		if (d <= JUNCTION_RADIUS_NM) {
			last = i;
		} else if (d > JUNCTION_RADIUS_NM + JUNCTION_CLEAR_NM) {
			return { idx: last, final: true };
		}
	}
	return { idx: last, final: false };
}

/** Whether the fold was ever beyond MATCH_MAX_OFF_NM: the necessary
 *  condition for a diversion, and the cheap half of the test. */
function everOffRoute(cps: readonly RouteProgressPoint[]): boolean {
	return cps.some((c) => (c.offM ?? 0) / NM_TO_METERS > MATCH_MAX_OFF_NM);
}

/** The index at which a diversion onto `alt` becomes decisive: the trip's
 *  projection beyond MATCH_MAX_OFF_NM while the alternate fits within
 *  DIVERT_FIT_NM, held over DIVERT_SUSTAIN_NM of ground. Null when it never
 *  is, which is the ordinary case. */
function divertsAt(
	points: readonly TrackPoint[],
	fromIdx: number,
	tripCps: readonly RouteProgressPoint[],
	altCps: readonly RouteProgressPoint[],
): number | null {
	let run = 0;
	const n = Math.min(tripCps.length, altCps.length);
	for (let j = 1; j < n; j++) {
		const tripOff = (tripCps[j].offM ?? 0) / NM_TO_METERS;
		const altOff = (altCps[j].offM ?? 0) / NM_TO_METERS;
		if (tripOff > MATCH_MAX_OFF_NM && altOff < DIVERT_FIT_NM) {
			run += distNM(points[fromIdx + j - 1], points[fromIdx + j]);
			if (run >= DIVERT_SUSTAIN_NM) {
				return fromIdx + j;
			}
		} else {
			run = 0;
		}
	}
	return null;
}

/** The index MATCH_WINDOW_NM of ground beyond `fromIdx` (or the trace end). */
function windowEndIdx(points: readonly TrackPoint[], fromIdx: number): number {
	let flown = 0;
	let i = fromIdx;
	while (i + 1 < points.length && flown < MATCH_WINDOW_NM) {
		flown += distNM(points[i], points[i + 1]);
		i++;
	}
	return i;
}

/** Every route the assignment may consider: two waypoints and some length. */
function usable(routes: readonly AssignRoute[]): AssignRoute[] {
	return routes.filter((r) => r.waypoints.length >= 2 && routeTotalNM(r.waypoints) > ARRIVAL_EPS_NM);
}

/** Assign the whole trace (a fresh segment list). */
export function assignRouteSegments(
	points: readonly TrackPoint[],
	routes: readonly AssignRoute[],
	pin: string | null = null,
): RouteSegment[] {
	return extendRouteAssignment([], points, routes, pin);
}

/** Re-derive the assignment, keeping the segments already closed: a closed
 *  segment is final (a leg cannot un-arrive), so only the open one is folded
 *  again as fixes arrive, and the work per fix is the current leg's length
 *  rather than the whole trace. Pass [] whenever the trace is replaced or the
 *  routes change. Extending equals one batch run over the same inputs. */
export function extendRouteAssignment(
	prev: readonly RouteSegment[],
	points: readonly TrackPoint[],
	routes: readonly AssignRoute[],
	pin: string | null = null,
): RouteSegment[] {
	const cands = usable(routes);
	if (points.length === 0 || cands.length === 0) {
		return [];
	}
	const trips = orderedTrips(cands);

	/** Fold one leg from `fromIdx` and describe the segment it makes. */
	const segmentFor = (
		route: AssignRoute,
		start: { idx: number; final: boolean },
		chained: boolean,
		pinned: boolean,
	): { seg: RouteSegment; cps: RouteProgressPoint[] } => {
		const fromIdx = start.idx;
		const cps = computeRouteProgress(points, route.waypoints, fromIdx);
		const arrIdx = arrivalIdxOf(cps, fromIdx, routeTotalNM(route.waypoints));
		const upto = arrIdx != null ? cps.slice(0, arrIdx - fromIdx + 1) : cps;
		return {
			seg: {
				routeId: route.id,
				fromIdx,
				fromMs: points[fromIdx].timeMs,
				toIdx: arrIdx,
				arrivalMs: arrIdx != null ? points[arrIdx].timeMs : null,
				offNM: medianOffNM(upto),
				chained,
				pinned,
				startFinal: start.final,
			},
			cps,
		};
	};

	const byId = new Map(cands.map((r) => [r.id, r]));
	// A closed leg with a settled start is final: it cannot un-arrive, and its
	// own start no longer moves. Everything from the first leg that fails
	// either test is re-derived, so a route edit, a pin or a junction the
	// flight has not yet left all recompute honestly.
	const closed: RouteSegment[] = [];
	for (const s of prev) {
		if (s.toIdx == null || s.pinned || s.startFinal !== true || !byId.has(s.routeId)) {
			break;
		}
		closed.push(s);
	}
	const segments: RouteSegment[] = [...closed];

	let tripIdx: number;
	let start: { idx: number; final: boolean };
	let chained: boolean;
	if (closed.length > 0) {
		const last = closed[closed.length - 1];
		const lastRoute = byId.get(last.routeId);
		const lastTrip = trips.findIndex((t) => t.route.id === last.routeId);
		if (!lastRoute || lastTrip < 0 || last.toIdx == null) {
			return applyPin(segments, byId, segmentFor, pin);
		}
		const end = lastRoute.waypoints[lastRoute.waypoints.length - 1];
		start = junctionStartIdx(points, last.toIdx, end);
		tripIdx = lastTrip + 1;
		if (tripIdx >= trips.length || start.idx >= points.length - 1) {
			return applyPin(segments, byId, segmentFor, pin);
		}
		chained = distNM(trips[tripIdx].route.waypoints[0], end) <= JUNCTION_RADIUS_NM;
	} else {
		const seed = seedLeg(points, trips);
		if (seed == null) {
			return applyPin([], byId, segmentFor, pin);
		}
		tripIdx = seed;
		start = { idx: 0, final: true };
		chained = false;
	}

	// Walk the trip chain: each leg closes at its arrival, the next opens at
	// the far side of the junction. Bounded by the trip count, since the walk
	// only ever moves forward through it.
	for (let guard = 0; guard <= trips.length; guard++) {
		if (tripIdx < 0 || tripIdx >= trips.length) {
			break;
		}
		const trip = trips[tripIdx];
		let route = trip.route;
		const flown = segmentFor(route, start, chained, false);
		let seg = flown.seg;

		// A diversion reassigns the leg retroactively, from the same start. It
		// is only ever asked of a leg that has not arrived, and the sustained
		// run is a prefix property, so once it fires it keeps firing. The
		// trip's own worst offset is a necessary condition for the run, and a
		// prefix property too, so testing it first skips the alternate's fold
		// on every ordinary fix without changing the answer.
		if (trip.alternate && seg.toIdx == null && everOffRoute(flown.cps)) {
			const altCps = computeRouteProgress(points, trip.alternate.waypoints, start.idx);
			if (divertsAt(points, start.idx, flown.cps, altCps) != null) {
				route = trip.alternate;
				seg = segmentFor(route, start, chained, false).seg;
			}
		}
		segments.push(seg);
		if (seg.toIdx == null || route.alternate) {
			break; // still being flown, or a diversion ends the plan
		}
		const end = route.waypoints[route.waypoints.length - 1];
		const next = junctionStartIdx(points, seg.toIdx, end);
		tripIdx += 1;
		if (tripIdx >= trips.length || next.idx >= points.length - 1) {
			break;
		}
		chained = distNM(trips[tripIdx].route.waypoints[0], end) <= JUNCTION_RADIUS_NM;
		start = next;
	}

	return applyPin(segments, byId, segmentFor, pin);
}

/** The pilot's manual pin names the leg being flown, so it replaces the leg
 *  the fold has open (creating one when the fold found none) and the chain
 *  stops there until the pin is released. It is an INPUT to the assignment,
 *  never a bypass, so a scrubbed playhead still reconstructs the same state. */
function applyPin(
	segments: readonly RouteSegment[],
	byId: ReadonlyMap<string, AssignRoute>,
	segmentFor: (
		route: AssignRoute,
		start: { idx: number; final: boolean },
		chained: boolean,
		pinned: boolean,
	) => { seg: RouteSegment; cps: RouteProgressPoint[] },
	pin: string | null,
): RouteSegment[] {
	const route = pin != null ? byId.get(pin) : undefined;
	if (!route) {
		return [...segments];
	}
	const open = segments.length > 0 ? segments[segments.length - 1] : null;
	if (open?.routeId === route.id) {
		return [...segments.slice(0, -1), { ...open, pinned: true }];
	}
	const start = { idx: open ? open.fromIdx : 0, final: open ? open.startFinal : true };
	const chained = open ? open.chained : false;
	return [...segments.slice(0, -1), segmentFor(route, start, chained, true).seg];
}

/** The leg the trace starts on: the earliest trip departing where the first
 *  fix is, else the best geometric fit over the opening window, else none. */
function seedLeg(
	points: readonly TrackPoint[],
	trips: readonly { index: number; route: AssignRoute }[],
): number | null {
	const first = points[0];
	for (let i = 0; i < trips.length; i++) {
		if (distNM(trips[i].route.waypoints[0], first) <= DEPARTURE_RADIUS_NM) {
			return i;
		}
	}
	// Joined mid-chain, or a trace that starts in the air: score every trip
	// over the same window and take the best, if it is a match at all.
	const end = windowEndIdx(points, 0);
	let bestIdx = -1;
	let bestOff = Infinity;
	for (let i = 0; i < trips.length; i++) {
		const cps = computeRouteProgress(points.slice(0, end + 1), trips[i].route.waypoints);
		const off = medianOffNM(cps);
		if (off < bestOff) {
			bestOff = off;
			bestIdx = i;
		}
	}
	return bestIdx >= 0 && bestOff <= MATCH_MAX_OFF_NM ? bestIdx : null;
}

/** The segment being flown at an instant: the LAST one already started, so a
 *  playhead inside a junction window still reads the leg that arrived there.
 *  Null before the trace begins or with no segments. */
export function segmentAt(segments: readonly RouteSegment[], tMs: number): RouteSegment | null {
	let found: RouteSegment | null = null;
	for (const s of segments) {
		if (s.fromMs <= tMs) {
			found = s;
		}
	}
	return found ?? segments[0] ?? null;
}
