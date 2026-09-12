/* Along-route progress of a recorded trace: for each trace point, the distance
 * (NM) reached along the PLANNED route's polyline, computed as a deterministic
 * fold over the trace prefix. Checkpoint i depends only on points[0..i] and the
 * waypoints, never on query order, so replay scrubbing (the playhead jumping
 * either way) always answers identically: a playhead query is a binary search +
 * lerp over the checkpoints (progressDistNM). The cumulative axis uses the same
 * leg math as sampleRoute (equirectangular metres), so a progress value is
 * directly comparable to the airspace schedule's atNM.
 *
 * The fold is monotonic-ish: each fix projects onto every route leg (cos-lat
 * planar, the traceProfile idiom) and admits only candidates that neither
 * backtrack more than BACKTRACK_NM behind the previous progress nor claim more
 * route than the aircraft flew since the previous fix (the reachability
 * budget), breaking lateral near-ties toward the previous progress, so
 * geometrically overlapping out-and-back legs resolve to the leg being flown.
 * It re-seeds to the globally nearest point when no admissible candidate exists
 * (first fix, joining mid-route, a GPS gap), or when the global best is
 * RESEED_GAIN_M nearer AND is either forward (a direct-to) or still inside the
 * SEED_LOCK_NM window (a seed that read the wrong leg). Each checkpoint also
 * carries the chosen projection's lateral distance (offM), the live nav-log's
 * off-route cue.
 *
 * The fold may start at any trace index (fromIdx), which is how a plan of
 * consecutive legs gives each leg its own axis: checkpoint j answers for
 * point fromIdx + j, and the hop still reaches back into the trace, so the
 * seed of a chained leg reads the track the aircraft actually had leaving
 * the junction.
 *
 * The pilot's own answer overrides all of it: a LegPin forces the projection
 * onto one leg at one instant (nav/routeProgress is where it lands because it
 * is an INPUT to the fold, never a bypass of it, so a scrubbed playhead still
 * reconstructs the same state). No Svelte, no I/O
 * (tests/navRouteProgress.spec.ts). */

import { equirectangularDistanceM, M_PER_DEG } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import type { TrackPoint } from './trace';
import type { Waypoint } from '$lib/state/route.svelte';

/** Along-route progress reached at one trace point's instant. */
export interface RouteProgressPoint {
	timeMs: number;
	distNM: number;
	/** Lateral distance (m) from the fix to its chosen on-route projection:
	 *  the off-route cue. Optional so pre-existing checkpoint fixtures stay
	 *  valid; the fold always emits it. */
	offM?: number;
	/** Distance (NM) flown since the fold last seeded an identity: the window
	 *  in which a decisively nearer leg may still take over (SEED_LOCK_NM).
	 *  Optional like offM; absent reads as established. */
	sinceSeedNM?: number;
}

/** A pilot's recalage of the projection: "the leg being flown is this one".
 *  At the FIRST fix at or after `sinceMs` the fold projects onto leg `legIdx`
 *  and onto nothing else, then carries on automatically from that identity,
 *  which counts as established at once (an identity the pilot asserted needs
 *  no seed window to prove itself). Everything before the instant is
 *  untouched: a correction states what is being flown NOW, and rewriting the
 *  flight behind it would move times already stamped. */
export interface LegPin {
	/** Leg index (waypoint i -> i + 1); out-of-range pins are ignored. */
	legIdx: number;
	/** Instant (ms UTC) the pilot asserted it: the displayed one, which is
	 *  the live tip while recording and the playhead in a replay. */
	sinceMs: number;
}

/** Max admissible backtrack (NM) behind the previous progress. */
export const BACKTRACK_NM = 2;
/** Lateral near-tie width (m): candidates this close to the best admissible
 *  one compete on progress continuity instead of pure distance. */
export const TIE_EPS_M = 50;
/** Re-seed threshold (m): when the best admissible candidate is this much
 *  farther from the fix than the global best, trust the global best. */
export const RESEED_GAIN_M = 1852;
/** Along-route advance a fix may claim, as a multiple of the distance actually
 *  flown since the previous fix: the aircraft cannot have covered more route
 *  than it covered ground. */
export const REACH_FACTOR = 1.5;
/** Slack (NM) added to that budget: GPS jitter, and a route that bends inside
 *  one hop (a dogleg is longer than the straight line across it). */
export const REACH_SLACK_NM = 0.5;
/** Distance (NM) the fold may fly after seeding before its identity counts as
 *  established. Inside the window a decisively nearer leg may take over in any
 *  direction (the seed had one fix to go on, and a parking spot under the
 *  arrival leg's inbound line seeds on the wrong one); beyond it only a forward
 *  correction may (a direct-to), so a route passing near its own earlier leg
 *  can never un-fly what was flown. */
export const SEED_LOCK_NM = 2;
/** Lateral band (m) within which the SEED takes the EARLIEST point on the
 *  route rather than the nearest. With no motion behind it, a fix consistent
 *  with both the departure and a later leg is a departure: a closed route
 *  parked at its own field sits metres from leg 0's start AND on the last
 *  leg's inbound line, and seeding on the latter would report the whole flight
 *  flown before it starts. */
export const SEED_TIE_M = 500;
/** Ground speed (kt) below which a fix's own track says nothing about which
 *  leg is being flown (taxi, a stationary jitter walk). */
export const COURSE_MIN_KT = 30;
/** Cosine floor between the fix's track and a leg's course for that leg to be
 *  PREFERRED while another candidate agrees: a leg more than 90 degrees off
 *  the track is not the leg being flown. It is what separates the two
 *  directions of one corridor, which a route out and back through the same
 *  gate shares metre for metre. Never a veto on its own: when no candidate
 *  agrees (a circuit, a procedure turn, the takeoff roll of a route leaving
 *  the other way), the fold keeps tracking what it had. */
export const COURSE_COS_MIN = 0;

interface RouteLeg {
	aLat: number;
	aLon: number;
	bLat: number;
	bLon: number;
	/** Cumulative NM at the leg's start. */
	cumNM: number;
	legNM: number;
}

function routeLegs(waypoints: readonly Waypoint[]): RouteLeg[] {
	const legs: RouteLeg[] = [];
	let cumNM = 0;
	for (let i = 0; i + 1 < waypoints.length; i++) {
		const a = waypoints[i];
		const b = waypoints[i + 1];
		const legNM = equirectangularDistanceM(a.lat, a.lon, b.lat, b.lon) / NM_TO_METERS;
		legs.push({ aLat: a.lat, aLon: a.lon, bLat: b.lat, bLon: b.lon, cumNM, legNM });
		cumNM += legNM;
	}
	return legs;
}

/** Perpendicular distance (m) from P to segment A-B, plus the clamped
 *  projection parameter t in [0, 1] (cos-lat planar; traceProfile's idiom). */
function projectToSegment(
	pLat: number,
	pLon: number,
	aLat: number,
	aLon: number,
	bLat: number,
	bLon: number,
): { distM: number; t: number } {
	const cosLat = Math.cos((pLat * Math.PI) / 180);
	const ax = (aLon - pLon) * cosLat;
	const ay = aLat - pLat;
	const bx = (bLon - pLon) * cosLat;
	const by = bLat - pLat;
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
	const cx = ax + t * dx;
	const cy = ay + t * dy;
	return { distM: Math.sqrt(cx * cx + cy * cy) * M_PER_DEG, t };
}

/** One fold step: the progress after a fix at (lat, lon), given the previous
 *  progress (null on the first fix), the previous fix, the distance (NM)
 *  actually flown since it, the elapsed time and the distance flown since the
 *  fold last seeded, plus the chosen candidate's lateral distance (the
 *  off-route cue) and whether this step seeded an identity rather than
 *  continuing one. */
function stepDistNM(
	lat: number,
	lon: number,
	legs: RouteLeg[],
	prevD: number | null,
	prevLat: number,
	prevLon: number,
	hopNM: number,
	dtMs: number,
	sinceSeedNM: number,
): { d: number; m: number; seeded: boolean } {
	const floor = prevD !== null ? prevD - BACKTRACK_NM : -Infinity;
	// The along-route step this fix may claim. Two legs meeting at a shared
	// point (a closed route's own field) or passing near each other (a loop
	// coming home across its outbound track) project equally well, and lateral
	// distance alone then picks either; only this budget tells them apart. It
	// widens on its own across a GPS gap or a coarsely sampled trace, where the
	// nearest leg is again the best answer.
	const reachNM = prevD !== null ? hopNM * REACH_FACTOR + REACH_SLACK_NM : Infinity;
	// The fix's own track, in the same cos-lat planar frame as the projections.
	// Below COURSE_MIN_KT it says nothing (a taxiing or parked aircraft walks
	// in circles), and then every leg passes the course test.
	const cosLat = Math.cos((lat * Math.PI) / 180);
	const hx = (lon - prevLon) * cosLat;
	const hy = lat - prevLat;
	const hLen = Math.hypot(hx, hy);
	const judge = dtMs > 0 && hLen > 0 && hopNM / (dtMs / 3_600_000) >= COURSE_MIN_KT;

	const cand: { d: number; m: number; along: boolean }[] = [];
	let anyAlong = false;
	for (const l of legs) {
		const { distM, t } = projectToSegment(lat, lon, l.aLat, l.aLon, l.bLat, l.bLon);
		const d = l.cumNM + t * l.legNM;
		const lx = (l.bLon - l.aLon) * cosLat;
		const ly = l.bLat - l.aLat;
		const lLen = Math.hypot(lx, ly);
		const along =
			!judge || lLen === 0 || (hx * lx + hy * ly) / (hLen * lLen) >= COURSE_COS_MIN;
		cand.push({ d, m: distM, along });
		anyAlong ||= along;
	}
	// A re-seed never lands on a leg the aircraft is flying against while one
	// it agrees with is on offer (the outbound track crossing the corridor it
	// will come home through).
	let globalD = 0;
	let globalM = Infinity;
	for (const c of cand) {
		if ((!anyAlong || c.along) && c.m < globalM) {
			globalM = c.m;
			globalD = c.d;
		}
	}
	if (prevD === null) {
		// The seed has no history to continue: among the candidates it cannot
		// tell apart, take the EARLIEST point on the route (SEED_TIE_M).
		let seedD = globalD;
		let seedM = globalM;
		for (const c of cand) {
			if ((!anyAlong || c.along) && c.m <= globalM + SEED_TIE_M && c.d < seedD) {
				seedD = c.d;
				seedM = c.m;
			}
		}
		return { d: seedD, m: seedM, seeded: true };
	}
	const admissible = (c: { d: number }): boolean =>
		c.d >= floor && Math.abs(c.d - prevD) <= reachNM;
	// Prefer an admissible candidate whose course agrees; fall back to the
	// admissible set as a whole, so the course test can never FORCE a re-seed
	// (a circuit at a waypoint, or a takeoff roll away from the first leg).
	let consM = Infinity;
	let consAlong = false;
	for (const c of cand) {
		if (admissible(c) && c.along && c.m < consM) {
			consM = c.m;
			consAlong = true;
		}
	}
	if (!consAlong) {
		for (const c of cand) {
			if (admissible(c) && c.m < consM) {
				consM = c.m;
			}
		}
	}
	if (consM === Infinity) {
		return { d: globalD, m: globalM, seeded: true };
	}
	// Among admissible candidates laterally near the admissible best, continue
	// the previous progress: out-and-back legs project equidistant, and the
	// one extending prevD is the leg being flown.
	let bestGap = Infinity;
	let bestD = globalD;
	let bestM = globalM;
	for (const c of cand) {
		if (admissible(c) && (!consAlong || c.along) && c.m <= consM + TIE_EPS_M) {
			const gap = Math.abs(c.d - prevD);
			if (gap < bestGap) {
				bestGap = gap;
				bestD = c.d;
				bestM = c.m;
			}
		}
	}
	// Re-seed onto a decisively nearer leg when the flight really is there:
	// forward of the floor (a direct-to, or rejoining ahead of the plan), or
	// still inside the seed window (the identity is not established yet).
	// Refused otherwise, so a route passing near its own earlier leg cannot
	// un-fly the distance flown.
	if (consM > globalM + RESEED_GAIN_M && (globalD >= floor || sinceSeedNM < SEED_LOCK_NM)) {
		return { d: globalD, m: globalM, seeded: true };
	}
	return { d: bestD, m: bestM, seeded: false };
}

/** The trace's progress checkpoints from `fromIdx` on (a fresh array). A plan
 *  of consecutive legs folds each leg from its own segment start, so the
 *  seed reads the leg's beginning instead of whatever part of its geometry
 *  happens to lie nearest the parked aircraft. `pins` are the pilot's
 *  recalages, in any order. */
export function computeRouteProgress(
	points: readonly TrackPoint[],
	waypoints: readonly Waypoint[],
	fromIdx = 0,
	pins: readonly LegPin[] = [],
): RouteProgressPoint[] {
	return extendRouteProgress([], points, waypoints, fromIdx, pins);
}

/** Extend a previously computed checkpoint array IN PLACE with the trace
 *  points beyond it, and return it. Checkpoint j answers for point
 *  fromIdx + j. Point-by-point extension equals one full
 *  computeRouteProgress over the same inputs (the determinism contract); the
 *  caller must reset (pass []) whenever the waypoints, fromIdx or pins change
 *  or the trace is replaced / spliced rather than appended. */
export function extendRouteProgress(
	prev: RouteProgressPoint[],
	points: readonly TrackPoint[],
	waypoints: readonly Waypoint[],
	fromIdx = 0,
	pins: readonly LegPin[] = [],
): RouteProgressPoint[] {
	if (waypoints.length < 2) {
		return [];
	}
	if (prev.length > points.length - fromIdx) {
		// Misuse guard (the trace shrank without a cache reset): start over.
		return extendRouteProgress([], points, waypoints, fromIdx, pins);
	}
	const legs = routeLegs(waypoints);
	// Ascending, and only the legs this route has: an out-of-range pin (a
	// waypoint deleted since) is no assertion at all.
	const forced = pins
		.filter((p) => p.legIdx >= 0 && p.legIdx < legs.length)
		.sort((a, b) => a.sinceMs - b.sinceMs);
	let pinCursor = 0;
	let prevD: number | null = prev.length > 0 ? prev[prev.length - 1].distNM : null;
	// Absent on a hand-built checkpoint array: read as established.
	let sinceSeedNM = prev.length > 0 ? (prev[prev.length - 1].sinceSeedNM ?? Infinity) : 0;
	for (let i = fromIdx + prev.length; i < points.length; i++) {
		const p = points[i];
		// The hop reaches back into the points array, so resuming from `prev`
		// sees the same budget a batch run would (the determinism contract).
		const q = i > 0 ? points[i - 1] : p;
		const hopNM = equirectangularDistanceM(q.lat, q.lon, p.lat, p.lon) / NM_TO_METERS;
		const flownNM = sinceSeedNM + hopNM;
		// A pin fires at the first fix at or after its instant, measured
		// against the TRACE's own predecessor rather than this fold's start,
		// so resuming from `prev` fires each pin exactly once and a pin made
		// on an earlier leg of the plan never re-fires on the next one. Two
		// presses inside one fix interval are one correction: the later wins.
		const prevTimeMs = i > 0 ? q.timeMs : -Infinity;
		let pinnedLeg: number | null = null;
		while (pinCursor < forced.length && forced[pinCursor].sinceMs <= p.timeMs) {
			if (forced[pinCursor].sinceMs > prevTimeMs) {
				pinnedLeg = forced[pinCursor].legIdx;
			}
			pinCursor++;
		}
		if (pinnedLeg != null) {
			const l = legs[pinnedLeg];
			const { distM, t } = projectToSegment(p.lat, p.lon, l.aLat, l.aLon, l.bLat, l.bLon);
			prevD = l.cumNM + t * l.legNM;
			// Established at once: the fold's seed window exists to let a
			// decisively nearer leg correct an unproven identity, and there is
			// nothing to correct in one the pilot just asserted.
			sinceSeedNM = Infinity;
			prev.push({ timeMs: p.timeMs, distNM: prevD, offM: distM, sinceSeedNM });
			continue;
		}
		const { d, m, seeded } = stepDistNM(
			p.lat,
			p.lon,
			legs,
			prevD,
			q.lat,
			q.lon,
			hopNM,
			p.timeMs - q.timeMs,
			flownNM,
		);
		sinceSeedNM = seeded ? 0 : flownNM;
		prev.push({ timeMs: p.timeMs, distNM: d, offM: m, sinceSeedNM });
		prevD = d;
	}
	return prev;
}

/** Progress (NM) at an instant: clamped at the ends, time-interpolated between
 *  checkpoints. Null with no checkpoints. */
export function progressDistNM(progress: readonly RouteProgressPoint[], tMs: number): number | null {
	const n = progress.length;
	if (n === 0) {
		return null;
	}
	if (tMs <= progress[0].timeMs) {
		return progress[0].distNM;
	}
	if (tMs >= progress[n - 1].timeMs) {
		return progress[n - 1].distNM;
	}
	let lo = 0;
	let hi = n - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (progress[mid].timeMs <= tMs) {
			lo = mid;
		} else {
			hi = mid;
		}
	}
	const a = progress[lo];
	const b = progress[hi];
	const dt = b.timeMs - a.timeMs;
	if (dt <= 0) {
		return b.distNM;
	}
	return a.distNM + ((tMs - a.timeMs) / dt) * (b.distNM - a.distNM);
}

/** Lateral offset (m) at an instant: clamped at the ends, time-interpolated
 *  between checkpoints. Null with no checkpoints or when a bracketing
 *  checkpoint lacks offM (pre-existing data). */
export function progressOffM(progress: readonly RouteProgressPoint[], tMs: number): number | null {
	const n = progress.length;
	if (n === 0) {
		return null;
	}
	if (tMs <= progress[0].timeMs) {
		return progress[0].offM ?? null;
	}
	if (tMs >= progress[n - 1].timeMs) {
		return progress[n - 1].offM ?? null;
	}
	let lo = 0;
	let hi = n - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (progress[mid].timeMs <= tMs) {
			lo = mid;
		} else {
			hi = mid;
		}
	}
	const a = progress[lo];
	const b = progress[hi];
	if (a.offM == null || b.offM == null) {
		return a.offM ?? b.offM ?? null;
	}
	const dt = b.timeMs - a.timeMs;
	if (dt <= 0) {
		return b.offM;
	}
	return a.offM + ((tMs - a.timeMs) / dt) * (b.offM - a.offM);
}
