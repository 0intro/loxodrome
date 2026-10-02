/* Match an imported trace to the plan it flew, automatically, for the
 * flights library's batch importer (docs/flights-library.md): candidate
 * plans are parsed route files built STANDALONE (never through the live
 * route registry), each trace is folded through the route-assignment fold
 * against every plausible plan, and the best fit wins only when it is
 * clearly flown (lateral gate) and clearly ahead (tie rule). "Never claim
 * a route you didn't fly": an unmatched or ambiguous trace files with an
 * empty Route rather than a guess.
 *
 * Pure (no Svelte, no I/O; tests/planMatch.spec.ts). The year for the
 * magnetic model of dead-reckoned name-only waypoints is injectable, the
 * loadRoutes idiom. */

import type { LatLon } from '$lib/notam/types';
import { reconstructPositions } from '$lib/route/reconstruct';
import { decimalYearFromDate } from '$lib/route/magnetic';
import type { LoadedWaypoint, ParsedRoutesDoc } from '$lib/route/yaml';
import type { Waypoint, WaypointAnchor } from '$lib/state/route.svelte';
import { equirectangularDistanceM, pointToSegmentDistanceM } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import { detectTouchAndGoes, splitFlights } from './logbook';
import type { MotionFold } from './navlogLive';
import {
	assignRouteSegments,
	MATCH_MAX_OFF_NM,
	type AssignRoute,
	type RouteSegment,
} from './routeAssign';
import { positionAt, type TrackPoint } from './trace';

/** The flown share of the airborne time a winning plan must cover: a plan
 *  holding only the first of two legs sits near 0.5 and is rejected (it is
 *  not THE plan, however well its half fits). */
export const MIN_COVERAGE = 0.6;
/** How close the trace's LAST fix must be to the matched plan's own end
 *  (the last flown route's final waypoint) for the flight to count as
 *  having ended where the plan ends. JUNCTION_CLEAR_NM's figure: past it
 *  the flight has left for good. */
export const MATCH_END_NM = 5;
/** The mirror: how close the trace's FIRST fix must sit to the first
 *  matched route's own first waypoint. Same figure as MATCH_END_NM and
 *  for the same reason; separate so the two ends stay readable.
 *
 *  Without it a flight that merely JOINS a route halfway claims the whole
 *  of it: the real 2025-10-16 LFQA -> LFPL flight began 2.2 NM off the
 *  Sedan plan's Rethel-Sezanne leg, flew it home inside the lateral gate
 *  (4.4 NM mean, coverage 0.92) and was filed as "LFSJ -> LFPL", a
 *  departure from Sedan 40 NM away that never happened. Every legitimate
 *  partial day departs a plan waypoint instead, planVariants already
 *  offering a path that starts at each trip. */
export const MATCH_START_NM = 5;
/** A runner-up within BOTH windows of the best, fitting DIFFERENT
 *  geometry, cannot be separated: the trace files without a plan and the
 *  candidates are reported. Above TIE_OFF_NM the closer fit wins: on
 *  real GPS a median-offset gap past 0.1 NM is the dogleg the other file
 *  plans and this flight did not fly. */
export const TIE_COVERAGE = 0.05;
export const TIE_OFF_NM = 0.1;
/** Runner-ups within these of the best fit the SAME flown geometry (the
 *  user's workspaces byte-copy common legs across files, offsets
 *  identical to the meter): the route claim is established either way,
 *  so the ranking's utilization key picks the file most ABOUT this
 *  flight instead of flagging an arbitrary-file ambiguity. */
export const SAME_FIT_COV = 0.02;
export const SAME_FIT_OFF_NM = 0.05;
/** The no-arrival path (a lesson flying the plan's corridor out and back
 *  without reaching the far waypoint) is admitted only TIGHT on the
 *  corridor and only when the flight ranged a meaningful part of the
 *  route out; a circuit fails the excursion, a wandering sector session
 *  the offset. */
export const NO_ARRIVAL_MAX_OFF_NM = 2;
export const NO_ARRIVAL_EXCURSION = 0.25;
/** The abridged-day branch (multi-trip plan, no arrival, home to a trip
 *  endpoint) demands the flight DEEP into the open route: the real
 *  abridged Brienne day ranged 69% of trip 1 out, while a 40-minute
 *  sector lesson ranges ~25% and must not claim the plan whose corridor
 *  it warmed up in. */
export const NO_ARRIVAL_DEEP_EXCURSION = 0.5;
/** Bounding-box prefilter margin: a plan whose waypoint box misses the
 *  trace box by more than this was flown elsewhere; the fold never runs.
 *  Antimeridian-naive (a documented residual, like traceBounds itself). */
export const BBOX_MARGIN_NM = 10;
/** How close a wheels-down position must sit to the plan's own geometry
 *  (any route's polyline, alternates included) for the plan to EXPLAIN
 *  that touch. A touchdown is the one instant a flight is definitively
 *  AT a place, the anti-slack to the coverage gate's 40% allowance: a
 *  corridor claim can survive every geometric gate while the flight's
 *  actual objective lives in the uncovered part (the real 2026-05-28
 *  LFOX day matched an LFPN file this way). Waypoint-or-leg proximity
 *  on purpose: an improvised touch at a field under the route stays
 *  explained. */
export const TOUCH_EXPLAIN_NM = 5;

/** One route of a candidate plan: what the fold reads (AssignRoute) plus
 *  the name, so the labels helper (flownRouteLabelsFor) reads it too. */
export interface CandidateRoute extends AssignRoute {
	name: string | null;
	waypoints: Waypoint[];
}

/** A standalone plan parsed from one picked routes file. */
export interface CandidatePlan {
	/** The picked file's name, the notice label. */
	name: string;
	/** The catalog entry this candidate came from (or was stored under),
	 *  when known: the lineage the archive freezes beside the yaml, and
	 *  the stable half of `sortKey` below. */
	catalogId?: string | undefined;
	/** The ORIGINAL file text: the archived snapshot keeps legs / info /
	 *  flight_prep exactly as saved, unlike the live capture's lean form. */
	yaml: string;
	/** flight_prep's aircraft registration, when the file carries one. */
	aircraftKey: string | null;
	routes: CandidateRoute[];
}

export type PlanMatch =
	| { kind: 'match'; plan: CandidatePlan; segments: RouteSegment[] }
	| { kind: 'ambiguous'; candidates: CandidatePlan[] }
	| { kind: 'none' };

// The loadRoutes rule: a saved free point whose name is its own printed
// coordinates carries no label.
const COORD_NAME_RE = /^-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?$/;

/** Build a candidate plan from a parsed routes doc, replicating the
 *  loadRoutes resolution (anchors via the injected resolve, free lat/lon
 *  kept, name-only waypoints dead-reckoned via reconstructPositions) with
 *  a lite waypoint build: synthetic ids, alt 0 / altAuto true (the fold
 *  and the labels read neither). Unresolvable idents drop like loadRoutes
 *  drops them; a route left under 2 waypoints is unusable; null when no
 *  route is usable. */
export function buildCandidatePlan(
	name: string,
	text: string,
	parsed: ParsedRoutesDoc,
	resolve: (token: string) => WaypointAnchor | null,
	yearOverride?: number,
): CandidatePlan | null {
	const year = yearOverride ?? decimalYearFromDate(new Date());
	const routes: CandidateRoute[] = [];
	for (let ri = 0; ri < parsed.routes.length; ri++) {
		const sr = parsed.routes[ri];
		const anchors: (WaypointAnchor | null)[] = sr.waypoints.map((sw) =>
			sw.ident ? resolve(sw.ident) : null,
		);
		const known: (LatLon | null)[] = sr.waypoints.map((sw, i) => {
			const a = anchors[i];
			if (a) {
				return { lat: a.lat, lon: a.lon };
			}
			return sw.lat !== undefined && sw.lon !== undefined ? { lat: sw.lat, lon: sw.lon } : null;
		});
		const pos = reconstructPositions(sr.waypoints, known, year);
		const waypoints: Waypoint[] = [];
		for (let i = 0; i < sr.waypoints.length; i++) {
			const sw: LoadedWaypoint = sr.waypoints[i];
			const a = anchors[i];
			const label = sw.name && !COORD_NAME_RE.test(sw.name) ? sw.name : undefined;
			if (a) {
				waypoints.push({
					id: `c${ri}-${i}`,
					lat: a.lat,
					lon: a.lon,
					kind: a.kind,
					refId: a.refId,
					ident: a.ident,
					label: a.label,
					freq: a.freq,
					alt: 0,
					altAuto: true,
				});
			} else if (sw.ident) {
				continue; // unresolvable ident: dropped
			} else {
				const p = pos[i];
				if (!p) {
					continue; // name-only waypoint that could not be placed
				}
				waypoints.push({
					id: `c${ri}-${i}`,
					lat: p.lat,
					lon: p.lon,
					kind: 'free',
					label,
					alt: 0,
					altAuto: true,
				});
			}
		}
		if (waypoints.length >= 2) {
			routes.push({
				id: `cr${ri}`,
				name: sr.name,
				waypoints,
				alternate: sr.alternate,
			});
		}
	}
	if (routes.length === 0) {
		return null;
	}
	return {
		name,
		yaml: text,
		aircraftKey: parsed.flightPrep?.aircraft ?? null,
		routes,
	};
}

export interface Bounds {
	minLat: number;
	maxLat: number;
	minLon: number;
	maxLon: number;
}

/** Bounding box over every route's waypoints; null on an empty plan. */
export function planBounds(plan: CandidatePlan): Bounds | null {
	let b: Bounds | null = null;
	for (const r of plan.routes) {
		for (const w of r.waypoints) {
			b = grow(b, w.lat, w.lon);
		}
	}
	return b;
}

function traceBounds(points: readonly TrackPoint[]): Bounds | null {
	let b: Bounds | null = null;
	for (const p of points) {
		b = grow(b, p.lat, p.lon);
	}
	return b;
}

function grow(b: Bounds | null, lat: number, lon: number): Bounds {
	if (!b) {
		return { minLat: lat, maxLat: lat, minLon: lon, maxLon: lon };
	}
	b.minLat = Math.min(b.minLat, lat);
	b.maxLat = Math.max(b.maxLat, lat);
	b.minLon = Math.min(b.minLon, lon);
	b.maxLon = Math.max(b.maxLon, lon);
	return b;
}

/** Whether `plan` intersects `trace` expanded by marginNM (lat NM/60, lon
 *  scaled at the trace's mid-latitude, cos floored off the poles). */
function boundsNear(trace: Bounds, plan: Bounds, marginNM: number): boolean {
	const latMargin = marginNM / 60;
	const midLat = (trace.minLat + trace.maxLat) / 2;
	const lonMargin = marginNM / (60 * Math.max(0.1, Math.cos((midLat * Math.PI) / 180)));
	return (
		plan.minLat <= trace.maxLat + latMargin &&
		plan.maxLat >= trace.minLat - latMargin &&
		plan.minLon <= trace.maxLon + lonMargin &&
		plan.maxLon >= trace.minLon - lonMargin
	);
}

function distNM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
	return equirectangularDistanceM(a.lat, a.lon, b.lat, b.lon) / NM_TO_METERS;
}

interface Interval {
	fromMs: number;
	toMs: number;
}

/** Union of intervals (merge overlaps), ascending. */
function mergeIntervals(spans: Interval[]): Interval[] {
	const sorted = spans
		.filter((s) => s.toMs > s.fromMs)
		.sort((a, b) => a.fromMs - b.fromMs);
	const out: Interval[] = [];
	for (const s of sorted) {
		const last = out[out.length - 1];
		if (last && s.fromMs <= last.toMs) {
			last.toMs = Math.max(last.toMs, s.toMs);
		} else {
			out.push({ ...s });
		}
	}
	return out;
}

function overlapMs(a: Interval, b: Interval): number {
	return Math.max(0, Math.min(a.toMs, b.toMs) - Math.max(a.fromMs, b.fromMs));
}

export interface ScoredPlan {
	plan: CandidatePlan;
	segments: RouteSegment[];
	coverage: number;
	offNM: number;
	/** Matched routes' distance over the plan's TRIP distance: how much of
	 *  the FILE this flight uses. The key that separates the file that IS
	 *  this nav from the files that merely carry one of its legs. */
	util: number;
	/** The match closed at least one route: STRONGER evidence than a
	 *  no-arrival relaxation, and a rank TIER above it. An open segment's
	 *  span reaches the trace end, so a corridor claim scores coverage
	 *  1.00 structurally and would otherwise outrank a genuine arrival
	 *  match covering 0.8 (the real LFGO flight lost to three overlapping
	 *  outbound-corridor files this way). */
	hasArrival: boolean;
	/** Intermediate wheels-down positions the plan does NOT explain
	 *  (TOUCH_EXPLAIN_NM): part of the rank TIER, so a plan explaining
	 *  fewer touches never ties one explaining more. */
	unexplained: number;
}

/** Did the trace come within MATCH_END_NM of `at`, at or after `fromMs`? The
 *  evidence a closed route's destination was really visited. */
function visited(
	points: readonly TrackPoint[],
	at: { lat: number; lon: number },
	fromMs: number,
): boolean {
	for (const p of points) {
		if (p.timeMs >= fromMs && distNM(p, at) <= MATCH_END_NM) {
			return true;
		}
	}
	return false;
}

function routeDistNM(r: CandidateRoute): number {
	let d = 0;
	for (let i = 0; i + 1 < r.waypoints.length; i++) {
		d += distNM(r.waypoints[i], r.waypoints[i + 1]);
	}
	return d;
}

/** The trace's INTERMEDIATE wheels-down positions, the matcher's touch
 *  evidence: every detected touch-and-go plus every stopover's committed
 *  landing, EXCLUDING the outing's final landing (where the trace ends
 *  is already the ends-there gate's judgement). The lookups are the
 *  summary fold's own (detectTouchAndGoes); offline they resolve
 *  nothing, the evidence is empty, and the matcher's touch gate stays
 *  inert, the offline-import posture. */
export function traceTouchEvidence(
	points: TrackPoint[],
	motion: MotionFold,
	altMslFt: (p: TrackPoint) => number | null,
	fieldElevFt: (lat: number, lon: number) => number | null,
): LatLon[] {
	const out: LatLon[] = detectTouchAndGoes(points, motion, altMslFt, fieldElevFt).map(
		(tg) => ({ lat: tg.lat, lon: tg.lon }),
	);
	const L = motion.landingsMs;
	const closed = L.length === motion.takeoffsMs.length;
	for (let i = 0; i < L.length; i++) {
		if (closed && i === L.length - 1) {
			continue;
		}
		const p = positionAt(points, L[i]);
		if (p) {
			out.push({ lat: p.lat, lon: p.lon });
		}
	}
	return out;
}

/** How many touch positions sit farther than TOUCH_EXPLAIN_NM from every
 *  leg of every route of the plan (alternates included: a diversion's
 *  touch is planned for). */
function unexplainedTouches(plan: CandidatePlan, touches: readonly LatLon[]): number {
	const maxM = TOUCH_EXPLAIN_NM * NM_TO_METERS;
	let n = 0;
	for (const t of touches) {
		let explained = false;
		for (const r of plan.routes) {
			for (let i = 0; i + 1 < r.waypoints.length; i++) {
				const a = r.waypoints[i];
				const b = r.waypoints[i + 1];
				if (pointToSegmentDistanceM(t.lat, t.lon, a.lat, a.lon, b.lat, b.lon) <= maxM) {
					explained = true;
					break;
				}
			}
			if (explained) {
				break;
			}
		}
		if (!explained) {
			n++;
		}
	}
	return n;
}

/** Two trips chain when one departs where the other arrived. */
export const CHAIN_JUNCTION_NM = 3;
const MAX_VARIANTS = 64;

/** The sub-chains of a plan one trace may cover: every simple PATH over
 *  the trips' junction graph (trip B follows trip A when B departs
 *  within CHAIN_JUNCTION_NM of A's arrival), each kept trip bringing its
 *  own trailing alternates, plus the file order itself. The saved
 *  workspaces list several ONWARD OPTIONS from a junction as plain
 *  routes (from the Compiegne file's LFAD: home via LFPK, or continue
 *  to LFJS); the fold chains the next trip IN FILE ORDER, so the wrong
 *  option's exploding offset killed the whole file even though every
 *  flown route was in it. Walking the junction graph folds each
 *  plausible option-chain instead; partial paths serve the half-flown
 *  days, and a path starting at every trip unsticks the seed when
 *  several routes share a departure aerodrome. */
function planVariants(routes: readonly CandidateRoute[]): CandidateRoute[][] {
	const trips: { trip: CandidateRoute; block: CandidateRoute[] }[] = [];
	for (const r of routes) {
		if (!r.alternate) {
			trips.push({ trip: r, block: [r] });
		} else if (trips.length > 0) {
			trips[trips.length - 1].block.push(r);
		}
	}
	const out: CandidateRoute[][] = [routes.slice()];
	if (trips.length === 0) {
		return out;
	}
	const seen = new Set<string>([routes.map((r) => r.id).join(',')]);
	const push = (path: number[]): void => {
		const list = path.flatMap((i) => trips[i].block);
		const key = list.map((r) => r.id).join(',');
		if (!seen.has(key)) {
			seen.add(key);
			out.push(list);
		}
	};
	const walk = (path: number[]): void => {
		if (out.length >= MAX_VARIANTS) {
			return;
		}
		push(path);
		const last = trips[path[path.length - 1]].trip;
		const end = last.waypoints[last.waypoints.length - 1];
		for (let j = 0; j < trips.length; j++) {
			if (path.includes(j)) {
				continue;
			}
			const start = trips[j].trip.waypoints[0];
			if (distNM(end, start) <= CHAIN_JUNCTION_NM) {
				walk([...path, j]);
			}
		}
	};
	for (let i = 0; i < trips.length; i++) {
		walk([i]);
	}
	return out;
}

/** Score one plan: its best-scoring variant (one file never competes
 *  with itself; ties are between FILES); null when every variant fails
 *  a gate. */
function scorePlan(
	points: readonly TrackPoint[],
	flightIntervals: Interval[],
	flownMs: number,
	maxRangeNM: number,
	plan: CandidatePlan,
): ScoredPlan | null {
	let best: ScoredPlan | null = null;
	for (const routes of planVariants(plan.routes)) {
		const s = scoreVariant(points, flightIntervals, flownMs, maxRangeNM, plan, routes);
		if (
			s &&
			(!best ||
				(s.hasArrival ? 1 : 0) - (best.hasArrival ? 1 : 0) > 0 ||
				(s.hasArrival === best.hasArrival &&
					(s.coverage > best.coverage ||
						(s.coverage === best.coverage &&
							(s.offNM < best.offNM || (s.offNM === best.offNM && s.util > best.util))))))
		) {
			best = s;
		}
	}
	return best;
}

/** Fold one variant of a plan and score it; null when it fails a gate. */
function scoreVariant(
	points: readonly TrackPoint[],
	flightIntervals: Interval[],
	flownMs: number,
	maxRangeNM: number,
	plan: CandidatePlan,
	routes: readonly CandidateRoute[],
): ScoredPlan | null {
	const segments = assignRouteSegments(points, routes);
	if (segments.length === 0) {
		return null;
	}
	// Lateral gate, re-checked over EVERY segment: the fold assigns chained
	// legs regardless of fit and only reports the figure, and a plan whose
	// second leg ran 20 NM off is not the plan that was flown.
	for (const s of segments) {
		if (s.offNM > MATCH_MAX_OFF_NM) {
			return null;
		}
	}
	// A match must ARRIVE: at least one route flown to its own end. A local
	// flight that never leaves the departure area sits inside the open
	// first leg of EVERY plan departing that field (small lateral offset,
	// full coverage), and without this gate a circuit ties them all.
	// ONE relaxation, for the lesson that flies the plan's corridor out
	// and back WITHOUT reaching the far waypoint (the progress watermark
	// then never arrives even though the flight ends on the plan's own
	// endpoint): no arrival is accepted when the flight ends at the open
	// route's end, stayed TIGHT on the corridor, and ranged a meaningful
	// fraction of the route out. A circuit fails the excursion test, a
	// one-way plan the endpoint test, a wandering session the offset.
	// The flight must START where the matched chain starts (MATCH_START_NM):
	// a route the flight only JOINED halfway is not a route it flew, however
	// well the rest of it fits.
	const firstRoute = plan.routes.find((x) => x.id === segments[0].routeId);
	const startW = firstRoute?.waypoints[0];
	if (!startW || distNM(points[0], startW) > MATCH_START_NM) {
		return null;
	}
	// ...and a closed route's destination must be a place the flight actually
	// VISITED. assignRouteSegments closes a segment when the PROJECTED
	// distance along the route reaches its end, which is the live-navigation
	// semantics and the right one there: a projection is what tells the nav
	// log you are on final. For MATCHING it is not enough, because a flight
	// that leaves the corridor before the last waypoint keeps projecting
	// forward and closes the route from miles abeam. The real 2025-07-17
	// LFPL -> LFLA flight flew the Moret plan's first leg to the metre,
	// turned for Auxerre at the MLN VOR, and was filed as "LFPL -> LFPU /
	// LFPU -> LFGK / LFGK -> LFPL": three route claims over two aerodromes
	// it never saw, its arrival at LFPU stamped 10 NM abeam and climbing
	// away.
	//
	// The test is EVER, not at the stamped instant: the fold's own
	// segmentation runs early where a flight approaches its destination
	// obliquely (the real 2025-12-09 Coulommiers day closed LFPL -> LFPK
	// 6 NM short and reached the field 34 minutes later, inside the NEXT
	// segment), and rejecting that would lose a flight that plainly flew the
	// plan. What cannot be waived is having been there at all, at some point
	// from the segment's start onwards.
	for (const s of segments) {
		if (s.arrivalMs == null) {
			continue;
		}
		const r = plan.routes.find((x) => x.id === s.routeId);
		const w = r?.waypoints[r.waypoints.length - 1];
		if (!w || !visited(points, w, s.fromMs)) {
			return null;
		}
	}
	const lastPt = points[points.length - 1];
	const endsNear = (routeId: string): boolean => {
		const r = plan.routes.find((x) => x.id === routeId);
		const w = r?.waypoints[r.waypoints.length - 1];
		return w != null && distNM(lastPt, w) <= MATCH_END_NM;
	};
	const lastSeg = segments[segments.length - 1];
	if (!segments.some((s) => s.arrivalMs != null)) {
		const open = plan.routes.find((x) => x.id === lastSeg.routeId);
		const openEndOk =
			open != null &&
			endsNear(lastSeg.routeId) &&
			maxRangeNM >= NO_ARRIVAL_EXCURSION * routeDistNM(open) &&
			segments.every((s) => s.offNM <= NO_ARRIVAL_MAX_OFF_NM);
		// The ABRIDGED multi-trip day: a stop skipped enroute (the real
		// LFPL-LFFN-LFQH-LFGP-LFPL flight that cut the LFQH corner) keeps
		// every route open, yet the flight departed on the plan, stayed
		// inside the lateral gate, ranged a meaningful part of the OPEN
		// route out, and came home to one of the plan's own trip endpoints
		// (any trip's: a saved workspace often lists auxiliary routes
		// unmarked, so "the last trip" means little). Two trips minimum: an
		// out-and-back on a one-way plan must keep failing.
		// Both excursion anchors, measured on the real catalog: the abridged
		// Brienne day ranged 79.5 NM (69% of its open trip, 36% of the plan
		// total) while the sector lessons that must not claim range 10 to
		// 20 NM. The plan-total anchor stops a short auxiliary route in a
		// big workspace from being the Trojan; the open-route anchor stops
		// a shallow out-and-back on a long trip.
		const trips = routes.filter((r) => !r.alternate);
		const planEndOk =
			trips.length >= 2 &&
			open != null &&
			maxRangeNM >= NO_ARRIVAL_DEEP_EXCURSION * routeDistNM(open) &&
			maxRangeNM >=
				NO_ARRIVAL_EXCURSION * trips.reduce((sum, r) => sum + routeDistNM(r), 0) &&
			trips.some((r) => {
				const w = r.waypoints[r.waypoints.length - 1];
				return distNM(lastPt, w) <= MATCH_END_NM;
			});
		if (!openEndOk && !planEndOk) {
			return null;
		}
	} else {
		// ...and the flight must END where the plan ends: the trace's last
		// fix near the last (or last closed) flown route's final waypoint.
		// A shared corridor to a nearby field passes the median-offset gate
		// while the flight continues 20 NM beyond the plan's destination;
		// this is what rejects it. The OPEN alternative keeps the
		// half-flown chained plan valid (the outbound day of an
		// out-and-back file ends at the junction the open next trip
		// departs). The HOME alternative accepts a flight that closed a
		// route and continued to the PLAN's own departure aerodrome: the
		// real chartres return closed its route at LFPK and flew the last
		// 15 NM home to LFPL, which the file only carries as a reversed
		// auxiliary; the coverage gate below still requires the plan to
		// explain the flight, so a stray closed aux route cannot ride this.
		const lastClosed = [...segments].reverse().find((s) => s.arrivalMs != null);
		const firstTrip = plan.routes.find((r) => !r.alternate) ?? plan.routes[0];
		const home = firstTrip.waypoints[0];
		if (
			!endsNear(lastSeg.routeId) &&
			!(lastClosed && endsNear(lastClosed.routeId)) &&
			distNM(lastPt, home) > MATCH_END_NM
		) {
			return null;
		}
	}
	const endMs = points[points.length - 1].timeMs;
	const spans = mergeIntervals(
		segments.map((s) => ({ fromMs: s.fromMs, toMs: s.arrivalMs ?? endMs })),
	);
	let coveredMs = 0;
	for (const span of spans) {
		for (const f of flightIntervals) {
			coveredMs += overlapMs(span, f);
		}
	}
	const coverage = coveredMs / flownMs;
	if (coverage < MIN_COVERAGE) {
		return null;
	}
	// Span-weighted mean lateral offset: the ranking's second key.
	let wSum = 0;
	let w = 0;
	for (const s of segments) {
		const span = Math.max(1, (s.arrivalMs ?? endMs) - s.fromMs);
		wSum += s.offNM * span;
		w += span;
	}
	const matchedIds = new Set(segments.map((s) => s.routeId));
	const tripDist = plan.routes
		.filter((r) => !r.alternate)
		.reduce((sum, r) => sum + routeDistNM(r), 0);
	const matchedDist = plan.routes
		.filter((r) => matchedIds.has(r.id))
		.reduce((sum, r) => sum + routeDistNM(r), 0);
	return {
		plan,
		segments,
		coverage,
		offNM: wSum / w,
		util: tripDist > 0 ? matchedDist / tripDist : 0,
		hasArrival: segments.some((s) => s.arrivalMs != null),
		// Plan-level, stamped by matchTraceToPlans (a variant never changes
		// what the FILE explains).
		unexplained: 0,
	};
}

/** The last-resort ordering key, and it has to be the SAME one whoever
 *  built the candidates. The batch importer names a candidate after the
 *  picked FILE while the background link pass names it after the catalog
 *  ID, so ranking on `name` let the two paths disagree about which plan
 *  a trace flew whenever the decision came down to this key: the primed
 *  link and its own recomputation would differ. The catalog id is the
 *  identity both paths share; a candidate that has none (a file picked
 *  in a run that could not store it) falls back to its name.
 *
 *  A plain code-unit comparison, not localeCompare: this module is pure,
 *  and a locale-sensitive collation makes the same catalog rank
 *  differently for two users. */
function sortKey(plan: CandidatePlan): string {
	return plan.catalogId ?? plan.name;
}

function compareKeys(a: CandidatePlan, b: CandidatePlan): number {
	const ka = sortKey(a);
	const kb = sortKey(b);
	return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Every candidate that survives the prefilters and the gates, in the
 *  ranking's own order: closed-route evidence first (the arrival TIER),
 *  then the touch evidence (fewer unexplained wheels-downs), then how much
 *  of the FLIGHT is explained, then how tightly, then how much of the FILE
 *  the flight uses, then sortKey for determinism.
 *
 *  Split out of matchTraceToPlans, which is the one caller in the app, so
 *  an offline audit over a real trace corpus can read WHY a plan won or
 *  lost instead of only which one did. Same code, same order: a diagnostic
 *  that re-implemented the ranking would be evidence about itself. */
export function rankTraceAgainstPlans(
	points: readonly TrackPoint[],
	motion: MotionFold,
	plans: readonly CandidatePlan[],
	touches: readonly LatLon[] = [],
): ScoredPlan[] {
	if (points.length === 0 || plans.length === 0) {
		return [];
	}
	const endMs = points[points.length - 1].timeMs;
	const flightIntervals = mergeIntervals(
		splitFlights(points, motion).map((f) => ({
			fromMs: f.takeoffMs,
			toMs: f.landingMs ?? endMs,
		})),
	);
	const flownMs = flightIntervals.reduce((sum, f) => sum + (f.toMs - f.fromMs), 0);
	if (flownMs <= 0) {
		return [];
	}
	const seenYaml = new Set<string>();
	const tb = traceBounds(points);
	let maxRangeNM = 0;
	for (const p of points) {
		maxRangeNM = Math.max(maxRangeNM, distNM(points[0], p));
	}
	const scored: ScoredPlan[] = [];
	for (const plan of plans) {
		if (seenYaml.has(plan.yaml)) {
			continue;
		}
		seenYaml.add(plan.yaml);
		const pb = planBounds(plan);
		if (!tb || !pb || !boundsNear(tb, pb, BBOX_MARGIN_NM)) {
			continue;
		}
		// The touch gate, ahead of the fold (cheap): a plan explaining none
		// of the wheels-down evidence is out regardless of its corridor.
		const unexplained = unexplainedTouches(plan, touches);
		if (touches.length > 0 && unexplained === touches.length) {
			continue;
		}
		const s = scorePlan(points, flightIntervals, flownMs, maxRangeNM, plan);
		if (s) {
			s.unexplained = unexplained;
			scored.push(s);
		}
	}
	scored.sort(
		(a, b) =>
			(b.hasArrival ? 1 : 0) - (a.hasArrival ? 1 : 0) ||
			a.unexplained - b.unexplained ||
			b.coverage - a.coverage ||
			a.offNM - b.offNM ||
			b.util - a.util ||
			compareKeys(a.plan, b.plan),
	);
	return scored;
}

/** Match a trace against the candidate plans. The coverage denominator is
 *  the sum of the AIRBORNE intervals from splitFlights (takeoff to landing
 *  per flight, the open tail to the trace end): a two-leg day's ground
 *  stop sits between the plan's segments, and counting it against the
 *  plan would reject a correct match. Byte-equal plan texts dedupe first
 *  (the same file picked twice is one candidate, never a tie).
 *
 *  `touches` is the trace's intermediate wheels-down evidence
 *  (traceTouchEvidence): a plan explaining NONE of them while any exist
 *  is not flying this flight's mission and is rejected outright, however
 *  well its corridor fits; among survivors the unexplained count is a
 *  rank tier (under hasArrival, above coverage), so the plan that
 *  explains where the wheels came down beats the one that merely shares
 *  a corridor. One explained touch is enough to pass the gate on
 *  purpose: an improvised extra touch on the way home (the real
 *  2025-05-27 LFPK bonus 20 NM off its LFQB plan) must not unmatch the
 *  plan that was flown. */
export function matchTraceToPlans(
	points: readonly TrackPoint[],
	motion: MotionFold,
	plans: readonly CandidatePlan[],
	touches: readonly LatLon[] = [],
): PlanMatch {
	const scored = rankTraceAgainstPlans(points, motion, plans, touches);
	if (scored.length === 0) {
		return { kind: 'none' };
	}
	// Runner-ups fitting the SAME geometry as the leader are the same route
	// in other files; micro differences (an arrival a few fixes later
	// nudging coverage by 0.005) must not pick among them, so the group
	// re-picks its representative by utilization, then name. Only a
	// close-but-DIFFERENT fit IN THE SAME TIER is a real doubt: a corridor
	// claim never ties a closed-route match, and a plan explaining fewer
	// wheels-downs never ties one explaining more.
	const leader = scored[0];
	const sameFit = scored.filter(
		(s) =>
			s.hasArrival === leader.hasArrival &&
			s.unexplained === leader.unexplained &&
			leader.coverage - s.coverage <= SAME_FIT_COV &&
			Math.abs(s.offNM - leader.offNM) <= SAME_FIT_OFF_NM,
	);
	sameFit.sort((a, b) => b.util - a.util || compareKeys(a.plan, b.plan));
	const best = sameFit[0];
	const ties = scored.filter(
		(s) =>
			!sameFit.includes(s) &&
			s.hasArrival === best.hasArrival &&
			s.unexplained === best.unexplained &&
			best.coverage - s.coverage <= TIE_COVERAGE &&
			Math.abs(s.offNM - best.offNM) <= TIE_OFF_NM,
	);
	if (ties.length > 0) {
		return { kind: 'ambiguous', candidates: [best.plan, ...ties.map((s) => s.plan)] };
	}
	return { kind: 'match', plan: best.plan, segments: best.segments };
}
