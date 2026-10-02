/* Which planned leg navigation mode is following. A plan of several
 * consecutive routes is flown one leg at a time, so the live surfaces need
 * their own selection: the fold in nav/routeAssign cuts the trace into one
 * segment per leg flown and this module memoises it, answers which leg the
 * playhead is on, and carries the pilot's manual pin.
 *
 * It also carries the pilot's other manual answer, one level down: which
 * SEGMENT of a route is being flown (the leg pins below), which is an input
 * to the projection fold rather than to the assignment.
 *
 * It is a SEPARATE selection from routes.activeId on purpose. The active
 * route is what the planning surfaces edit, and a pilot reading another
 * leg's nav log mid-flight must not have it pulled away; the live surfaces
 * meanwhile must never show a leg the flight is not on. The active route
 * FOLLOWS the flown leg until the user pages elsewhere, and resumes when
 * they page back (the map's follow-mode idiom).
 *
 * Reactive reads happen BEFORE the cache check, the notamCorridor idiom, so
 * callers track appends, trace resets and route edits. Contract:
 * docs/nav-live.md. */

import { nav } from './navRecording.svelte';
import { traceMotion } from './navMotion';
import { routes, setActiveRoute } from './route.svelte';
import { orderedTrips } from '$lib/aircraft/trips';
import {
	assignRouteSegments,
	extendRouteAssignment,
	segmentAt,
	type AssignRoute,
	type RouteSegment,
} from '$lib/nav/routeAssign';
import type { LegPin } from '$lib/nav/routeProgress';
import type { TrackPoint } from '$lib/nav/trace';

/** The leg pins made on ONE trace: the instant of its first fix identifies
 *  it, so a cleared, replaced or front-spliced trace makes every pin stale at
 *  once. A pin is an instant, and an instant from another flight would
 *  re-anchor the new one from its very first fix. */
interface LegPinSet {
	traceMs: number;
	byRoute: Record<string, LegPin[]>;
}

/** Session-only navigation-mode route state: the pilot's manual pins and
 *  whether the active route is still following the flown leg. None of it
 *  persists: a pin is a recovery for the flight in progress, and the follow
 *  is re-armed by every reload. */
export const navRoute = $state<{
	pin: string | null;
	follow: boolean;
	legs: LegPinSet | null;
}>({
	pin: null,
	follow: true,
	legs: null,
});

interface SegmentMemo {
	points: TrackPoint[];
	len: number;
	routesKey: string;
	pin: string | null;
	segments: RouteSegment[];
}
let segmentMemo: SegmentMemo | null = null;

/** Every geometry input the assignment reads, as one key. */
function routesKeyOf(list: readonly AssignRoute[]): string {
	return list
		.map(
			(r) =>
				`${r.id}:${r.alternate ? 'a' : 't'}:${r.waypoints.map((w) => `${w.lat},${w.lon}`).join(';')}`,
		)
		.join('|');
}

/** The trace cut into one segment per leg flown, memoised and extended per
 *  appended fix. Empty without a trace, or when the flight matches no leg.
 *  Call inside $derived / $effect. */
export function navSegments(): RouteSegment[] {
	const points = nav.points;
	const len = points.length;
	const list = routes.list;
	const routesKey = routesKeyOf(list);
	const pin = navRoute.pin;
	if (
		segmentMemo &&
		segmentMemo.points === points &&
		segmentMemo.routesKey === routesKey &&
		segmentMemo.pin === pin &&
		segmentMemo.len <= len
	) {
		if (segmentMemo.len < len) {
			segmentMemo.segments = extendRouteAssignment(segmentMemo.segments, points, list, pin);
			segmentMemo.len = len;
		}
		return segmentMemo.segments;
	}
	segmentMemo = {
		points,
		len,
		routesKey,
		pin,
		segments: assignRouteSegments(points, list, pin),
	};
	return segmentMemo.segments;
}

/** The segment being flown at the playhead; null with no trace or no match. */
export function navSegment(): RouteSegment | null {
	return segmentAt(navSegments(), nav.playheadMs);
}

/** The leg navigation mode is following. Falls back to the active route, so
 *  a plan with no trace briefs exactly as it did before there were legs to
 *  choose between. */
export function navRouteId(): string {
	return navSegment()?.routeId ?? routes.activeId;
}

/** This route's segment, when it is one the flight flew. */
export function segmentForRoute(routeId: string): RouteSegment | null {
	const segs = navSegments();
	// The last one, so a leg flown twice reports the current pass.
	for (let i = segs.length - 1; i >= 0; i--) {
		if (segs[i].routeId === routeId) {
			return segs[i];
		}
	}
	return null;
}

/** The leg the flight being RECORDED is on, or is about to fly, and the
 *  instant the flight reached its start: the last segment of the assignment,
 *  and once that has arrived with the junction not yet left (the ground at
 *  the next field, a touch-and-go still inside its ring), the NEXT trip,
 *  which the fold only opens on leaving the junction. A leg met at a
 *  junction is reached at the ARRIVAL there, never at the ring's exit the
 *  segment opens at. Null when nothing is recorded. */
function recordedLeg(): { routeId: string | null; sinceMs: number | null } | null {
	if (!nav.recording) {
		return null;
	}
	const segs = navSegments();
	const seg = segs.at(-1);
	if (!seg) {
		return { routeId: null, sinceMs: null };
	}
	if (seg.arrivalMs == null) {
		return { routeId: seg.routeId, sinceMs: segs.at(-2)?.arrivalMs ?? seg.fromMs };
	}
	const trips = orderedTrips(routes.list);
	const idx = trips.findIndex((t) => t.route.id === seg.routeId);
	// An arrival on an alternate is a diversion, which ends the plan.
	return { routeId: idx >= 0 ? (trips[idx + 1]?.route.id ?? null) : null, sinceMs: seg.arrivalMs };
}

/* The flight in progress as the forecast of its plan needs it, in two
 * module-level deriveds answering primitives: each is evaluated again per
 * fix, as its inputs are, but a reader re-runs only when the ANSWER moves (a
 * takeoff, a landing, a handover), never at an ordinary fix. */
const flownRouteId = $derived(recordedLeg()?.routeId ?? null);

const flownDepartureMs = $derived.by((): number | null => {
	const leg = recordedLeg();
	if (!leg) {
		return null;
	}
	// Airborne: a takeoff committed, and no landing standing since it.
	const motion = traceMotion(nav.points);
	const takeoff = motion.landingMs == null ? (motion.takeoffsMs.at(-1) ?? null) : null;
	if (takeoff == null) {
		return null;
	}
	// The leg departed at its takeoff, one after the flight reached it (a
	// full stop at its field), or, reached through a touch-and-go, which
	// takes off nothing of its own, at that junction.
	return leg.sinceMs == null ? takeoff : Math.max(takeoff, leg.sinceMs);
});

/** The flight being recorded, for the forecast its plan is timed to: the
 *  route it is on or about to fly (null when it follows none of the plan's),
 *  and the instant that route departed, null while on the ground, before its
 *  takeoff or after a landing. Null when nothing is recorded: planning and a
 *  replay time the plan as planned. Reads two derived primitives, so no fix
 *  re-runs a reader (docs/wind-aloft.md, "Offline"). */
export function flightInProgress(): { routeId: string | null; departureMs: number | null } | null {
	return nav.recording ? { routeId: flownRouteId, departureMs: flownDepartureMs } : null;
}

/** Pin the leg being flown, or release the pin (null). The pin is an input
 *  to the assignment, not a bypass, so a scrubbed playhead still answers
 *  identically. */
export function setNavRoutePin(id: string | null): void {
	navRoute.pin = id;
	navRoute.follow = true;
}

// --- Which segment of the route is being flown -----------------------------
// The route pin above says which route; these say which of its segments, and
// they are the recovery for the rare case the projection fold reads the wrong
// one (a turn-back the ink rule deliberately does not follow, a corridor the
// route shares with itself). Each is a RECALAGE at one instant, not a
// standing override: the fold re-anchors there and then sequences on by its
// own rules, which are the rules the pilot wants once the identity is right.

const NO_PINS: readonly LegPin[] = Object.freeze([]);

/** This route's leg pins, on the trace now loaded. Empty when they were made
 *  on another trace (see LegPinSet). Reads reactive state; call inside
 *  $derived / $effect. */
export function legPinsFor(routeId: string): readonly LegPin[] {
	const points = nav.points;
	const set = navRoute.legs;
	if (!set || points.length === 0 || points[0].timeMs !== set.traceMs) {
		return NO_PINS;
	}
	return set.byRoute[routeId] ?? NO_PINS;
}

/** Tell the log that THIS segment is the one being flown, from the displayed
 *  instant on (the live tip while recording, the playhead in a replay).
 *  Nothing to pin without a trace: the fold has no fix to re-anchor. */
export function setNavLegPin(routeId: string, legIdx: number): void {
	const points = nav.points;
	if (points.length === 0) {
		return;
	}
	const traceMs = points[0].timeMs;
	const sinceMs = nav.playheadMs;
	const set = navRoute.legs;
	const byRoute = set && set.traceMs === traceMs ? { ...set.byRoute } : {};
	// Two presses at one instant are one correction, the later one.
	const kept = (byRoute[routeId] ?? []).filter((p) => p.sinceMs !== sinceMs);
	byRoute[routeId] = [...kept, { legIdx, sinceMs }];
	navRoute.legs = { traceMs, byRoute };
}

/** Undo the most recent correction on this route, the mis-tap escape. Every
 *  earlier one stands: each is a fact of the flight, and dropping them all
 *  would re-derive the stamps they were made to get right. */
export function undoNavLegPin(routeId: string): void {
	const set = navRoute.legs;
	const list = set?.byRoute[routeId];
	if (!set || !list || list.length === 0) {
		return;
	}
	navRoute.legs = { traceMs: set.traceMs, byRoute: { ...set.byRoute, [routeId]: list.slice(0, -1) } };
}

/** The active route last written by the follow, so a change made anywhere
 *  else is recognisable as the user's own. */
let followedId: string | null = null;

/** Keep the active route on the leg being flown. The user's selection wins:
 *  paging elsewhere suspends the follow and paging back to the flown leg
 *  resumes it. Reads reactive state; call from an $effect (it converges,
 *  since the write it makes leaves the next pass with nothing to do). */
export function followNavRoute(): void {
	const flown = navRouteId();
	const active = routes.activeId;
	if (followedId !== null && active !== followedId) {
		navRoute.follow = active === flown;
	}
	if (navRoute.follow && flown !== active && routes.list.some((r) => r.id === flown)) {
		setActiveRoute(flown);
		followedId = flown;
		return;
	}
	followedId = active;
}
