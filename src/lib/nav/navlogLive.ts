/* Live nav-log core (pure): the in-flight plog derived from the recorded
 * trace and the planned route. Two independent folds: the MOTION fold over
 * the trace points (takeoff detection by sustained ground speed, its landing
 * mirror, the block times), which belongs to the outing; and the CROSSING
 * fold over the along-route progress checkpoints (the ATO column), which
 * belongs to one leg and reads no trace point, so a plan of several
 * consecutive legs folds each from its own start against one motion answer.
 * Then the assembly at a live/replay instant: passed / current / target rows,
 * planned ETO re-based on the actual takeoff, live-revised ETO, plan delta.
 * Every actual fact is a deterministic fold over the trace prefix (the
 * routeProgress contract), and the display filters it by the playhead
 * instant, so live recording and replay scrubbing answer identically. No
 * Svelte, no I/O (tests/navlogLive.spec.ts); contract: docs/nav-live.md. */

import { deriveMotion, type TrackPoint } from './trace';
import {
	BACKTRACK_NM,
	progressDistNM,
	progressOffM,
	type RouteProgressPoint,
} from './routeProgress';
import { legCumulativeMinutes, timeAtNM } from '$lib/route/legWind';

/** Ground speed (kt) at/above which the aircraft is considered departing;
 *  the EFB "instant plog" convention (SkyDemon's takeoff-speed setting is
 *  40 kt by default). */
export const TAKEOFF_KT = 40;
/** The speed must hold this long (ms) for takeoff to commit; a single
 *  spurious fast fix while taxiing never starts the log. */
export const TAKEOFF_SUSTAIN_MS = 5000;
/** Ground speed (kt) under which the aircraft is no longer flying, and how
 *  long it must hold for the landing to commit. Far under any approach speed
 *  and under the ground speed even a strong headwind leaves, so only the
 *  rollout and the taxi qualify, and a touch-and-go never does. */
export const LANDING_KT = 20;
export const LANDING_SUSTAIN_MS = 60_000;
/** Ground speed (kt) at/above which the aircraft counts as moving: the block
 *  times bracket the first and last fix at or above it (chocks off to chocks
 *  on, as far as GPS can tell). */
export const MOVE_KT = 3;
/** A forward jump (NM) between consecutive checkpoints larger than this is a
 *  re-seed / GPS gap, not flight over the boundary: the watermark advances
 *  but no ATO is fabricated by interpolating across it. */
export const CROSS_JUMP_NM = 5;
/** No-stamp zone (NM) above the INITIAL seed: a projection identity fresh
 *  out of the seed is unproven (a closed route's departure projects at the
 *  route END and would stamp the destination during the takeoff roll), so
 *  boundaries this close above the seed pass without an ATO. The first
 *  backward re-seed clears the guard: the fold has corrected itself and
 *  genuine crossings may then stamp anywhere. */
export const SEED_GUARD_NM = 3;
/** Slack (NM) short of the route's total length at which the flight counts
 *  as arrived (landing rarely overflies the destination reference point). */
export const ARRIVAL_EPS_NM = 0.5;
/** Lateral offset (NM) beyond which the readout shows the off-route badge. */
export const OFF_ROUTE_NM = 2;

/** The incremental motion fold: takeoff, landing and block times over the
 *  trace points. Per TRACE, not per leg: an outing has one takeoff, one
 *  landing and one pair of block times however many planned legs it flies,
 *  and the junction of two chained legs is commonly a touch-and-go, which
 *  the landing rule deliberately does not see. Extend-in-place; extension
 *  point by point equals one batch fold (the extendRouteProgress
 *  determinism contract). */
export interface MotionFold {
	/** Points consumed (extension cursor). */
	idx: number;
	/** Start of the current >= TAKEOFF_KT streak; null while below. Only
	 *  meaningful until takeoff commits. */
	aboveSinceMs: number | null;
	/** Committed takeoff instant: the streak START (stable however late the
	 *  sustain confirms it). Never revised once set. */
	takeoffMs: number | null;
	/** Start of the current below-LANDING_KT streak while airborne; null while
	 *  faster. The mirror of aboveSinceMs. */
	belowSinceMs: number | null;
	/** Start of the current at-or-above-TAKEOFF_KT streak once a landing has
	 *  been committed: sustained, it re-arms the detector. */
	fastSinceMs: number | null;
	/** Committed landing instant (the streak START), cleared when the aircraft
	 *  gets airborne again, so a stop-and-go leaves the LAST landing standing
	 *  and the trace's flight time spans the whole outing. */
	landingMs: number | null;
	/** First and last fix at or above MOVE_KT: the block times. */
	firstMoveMs: number | null;
	lastMoveMs: number | null;
	/** EVERY committed takeoff instant, in order: the first commit plus each
	 *  post-landing re-arm (the sustained fast streak's start). Monotone
	 *  append, never truncated; the logbook's per-flight splitter pairs it
	 *  with landingsMs. */
	takeoffsMs: number[];
	/** EVERY committed landing instant, in order: full stops and stop-and-gos
	 *  as the GPS sees them (a touch-and-go commits none, by design; the
	 *  re-arm clears landingMs but never this record). The count is the
	 *  logbook's landings figure; the last element equals landingMs while one
	 *  stands. */
	landingsMs: number[];
}

/** The incremental crossing fold: first-crossing times over ONE leg's
 *  progress checkpoints (the ATO column). Per leg, and it reads no trace
 *  point at all: the checkpoints carry their own instants, so a leg folded
 *  from its own segment start needs no index alignment with the trace.
 *  Extend-in-place, same determinism contract. */
export interface CrossingFold {
	/** Checkpoints consumed; pinned at 0 until the gate instant is known
	 *  (nothing crosses while taxiing), then fast-forwarded. */
	idx: number;
	/** Max along-route progress folded so far (NM); null before the seed
	 *  checkpoint (the first one at/after the gate). */
	watermarkNM: number | null;
	/** First boundary index not yet accounted; boundaries are ascending, so
	 *  crossings consume them in order. A backward re-seed rewinds it (and
	 *  the watermark), reopening UNSTAMPED boundaries; existing stamps are
	 *  ink and never rewritten. */
	nextB: number;
	/** Top (NM) of the initial seed's no-stamp zone (SEED_GUARD_NM above the
	 *  seed); null once a backward re-seed clears it. */
	guardTopNM: number | null;
	/** crossMs[k] = first time over boundariesNM[k] (waypoint k+1); null =
	 *  not reached, behind the seed (mid-route join), inside the seed guard,
	 *  or crossed inside a jump segment (passed without an ATO). */
	crossMs: (number | null)[];
}

/** A fresh motion fold. */
export function newMotionFold(): MotionFold {
	return {
		idx: 0,
		aboveSinceMs: null,
		takeoffMs: null,
		belowSinceMs: null,
		fastSinceMs: null,
		landingMs: null,
		firstMoveMs: null,
		lastMoveMs: null,
		takeoffsMs: [],
		landingsMs: [],
	};
}

/** A fresh crossing fold for a leg with these boundaries (legs[k].cumNM, or
 *  the schedule's ascending atNMs). */
export function newCrossingFold(boundariesNM: readonly number[]): CrossingFold {
	return {
		idx: 0,
		watermarkNM: null,
		nextB: 0,
		guardTopNM: null,
		crossMs: Array.from(boundariesNM, () => null),
	};
}

/** Extend the motion fold IN PLACE over the points beyond its cursor, and
 *  return it: takeoff (first sustained >= TAKEOFF_KT streak, committed at the
 *  streak start), landing (its mirror below LANDING_KT, re-armed by a later
 *  takeoff so a stop-and-go leaves the last one standing) and the block times
 *  (first / last fix at or above MOVE_KT). Speed missing from the device is
 *  backfilled from the hop off the previous fix, the live-ingest rule. The
 *  caller hands a fresh fold whenever the trace is replaced rather than
 *  appended (the extendRouteProgress reset rule); a shrunk trace restarts
 *  defensively. */
export function extendMotion(fold: MotionFold, points: readonly TrackPoint[]): MotionFold {
	if (fold.idx > points.length) {
		Object.assign(fold, newMotionFold());
	}
	const n = points.length;
	for (let i = fold.idx; i < n; i++) {
		const p = points[i];
		let speed = p.speedKt;
		if (speed == null || !Number.isFinite(speed)) {
			speed = i > 0 ? deriveMotion(points[i - 1], p).speedKt : null;
		}
		if (speed != null && speed >= MOVE_KT) {
			if (fold.firstMoveMs == null) {
				fold.firstMoveMs = p.timeMs;
			}
			fold.lastMoveMs = p.timeMs;
		}
		if (fold.takeoffMs == null) {
			if (speed != null && speed >= TAKEOFF_KT) {
				if (fold.aboveSinceMs == null) {
					fold.aboveSinceMs = p.timeMs;
				}
				if (p.timeMs - fold.aboveSinceMs >= TAKEOFF_SUSTAIN_MS) {
					fold.takeoffMs = fold.aboveSinceMs;
					fold.takeoffsMs.push(fold.aboveSinceMs);
				}
			} else {
				fold.aboveSinceMs = null;
			}
		} else if (fold.landingMs == null) {
			// Airborne: watch for the sustained slow streak that ends the flight.
			if (speed != null && speed < LANDING_KT) {
				if (fold.belowSinceMs == null) {
					fold.belowSinceMs = p.timeMs;
				}
				if (p.timeMs - fold.belowSinceMs >= LANDING_SUSTAIN_MS) {
					fold.landingMs = fold.belowSinceMs;
					fold.landingsMs.push(fold.belowSinceMs);
					fold.fastSinceMs = null;
				}
			} else {
				fold.belowSinceMs = null;
			}
		} else if (speed != null && speed >= TAKEOFF_KT) {
			// Landed, and moving fast again: a sustained streak means the outing
			// continues, so the landing stamp reopens for the real one.
			if (fold.fastSinceMs == null) {
				fold.fastSinceMs = p.timeMs;
			}
			if (p.timeMs - fold.fastSinceMs >= TAKEOFF_SUSTAIN_MS) {
				// The re-arm IS a committed takeoff: record its streak start
				// before the scalar state forgets the stop-and-go.
				fold.takeoffsMs.push(fold.fastSinceMs);
				fold.landingMs = null;
				fold.belowSinceMs = null;
				fold.fastSinceMs = null;
			}
		} else {
			fold.fastSinceMs = null;
		}
		fold.idx = i + 1;
	}
	return fold;
}

/** Extend the crossing fold IN PLACE over the checkpoints beyond its cursor,
 *  and return it. `gateMs` is the instant the leg starts being flown: the
 *  committed takeoff for the first leg of an outing, the segment start for a
 *  leg chained onto a preceding one. Null gates everything out, so a fold
 *  waiting on its takeoff simply stands still. `chained` says the leg begins
 *  where the preceding one arrived, which retires the seed guard: the guard
 *  exists because a fresh seed's identity is unproven, and at a known
 *  junction the aircraft really is at the leg's beginning, so a short first
 *  leg's waypoint must be allowed to stamp. The caller hands a fresh fold
 *  whenever the boundaries change or the checkpoints are replaced rather than
 *  appended; a length mismatch restarts defensively. */
export function extendCrossings(
	fold: CrossingFold,
	checkpoints: readonly RouteProgressPoint[],
	boundariesNM: readonly number[],
	gateMs: number | null,
	chained = false,
): CrossingFold {
	if (fold.crossMs.length !== boundariesNM.length || fold.idx > checkpoints.length) {
		// Misuse guard (boundaries changed / checkpoints shrank without a reset).
		Object.assign(fold, newCrossingFold(boundariesNM));
	}
	// Consume only once the gate is final (a committed takeoff never changes,
	// and a segment start is fixed by the preceding leg's arrival), so
	// incremental == batch.
	if (gateMs == null) {
		return fold;
	}
	const n = checkpoints.length;
	while (fold.idx < n) {
		const c = checkpoints[fold.idx];
		if (c.timeMs < gateMs) {
			fold.idx++; // taxi, or a preceding leg: before the gate
			continue;
		}
		if (fold.watermarkNM == null) {
			// Seed: the first at/after-gate checkpoint. Boundaries at or below
			// its progress (mid-flight trace start, mid-route join) are
			// consumed without an ATO, and the ones just above it sit in the
			// no-stamp guard zone until a backward re-seed proves or corrects
			// the identity.
			fold.watermarkNM = c.distNM;
			fold.guardTopNM = chained ? null : c.distNM + SEED_GUARD_NM;
			while (fold.nextB < boundariesNM.length && boundariesNM[fold.nextB] <= fold.watermarkNM) {
				fold.nextB++;
			}
			fold.idx++;
			continue;
		}
		const dCur = c.distNM;
		const a = checkpoints[fold.idx - 1];
		if (dCur < a.distNM - BACKTRACK_NM) {
			// A backward RE-SEED: smooth backtracking never regresses more
			// than BACKTRACK_NM per step (the stepDistNM floor), so a larger
			// drop means the projection fold corrected a wrong identity (the
			// classic case: a closed route, whose departure projects at the
			// route END during the takeoff, then flips to the true outbound
			// position; the same flip happens again on landing). Rewind the
			// watermark and the boundary cursor so UNSTAMPED boundaries become
			// stampable by the genuine crossings to come; existing stamps are
			// ink, recorded while the projection was advancing consistently,
			// and survive (the landing flip must not erase the flight).
			fold.watermarkNM = dCur;
			while (fold.nextB > 0 && boundariesNM[fold.nextB - 1] > dCur) {
				fold.nextB--;
			}
			fold.guardTopNM = null;
		} else if (dCur > fold.watermarkNM) {
			// A big forward jump is a re-seed / GPS gap: the lerp across it
			// would fabricate crossing times, so those boundaries stay null.
			const jump = dCur - a.distNM > CROSS_JUMP_NM;
			while (fold.nextB < boundariesNM.length && boundariesNM[fold.nextB] <= dCur) {
				const b = boundariesNM[fold.nextB];
				const guarded = fold.guardTopNM != null && b <= fold.guardTopNM;
				if (!jump && !guarded && fold.crossMs[fold.nextB] == null) {
					const span = dCur - a.distNM;
					const f = span > 0 ? Math.max(0, Math.min(1, (b - a.distNM) / span)) : 1;
					fold.crossMs[fold.nextB] = a.timeMs + f * (c.timeMs - a.timeMs);
				}
				fold.nextB++;
			}
			fold.watermarkNM = dCur;
		}
		fold.idx++;
	}
	return fold;
}

/** One waypoint's live row state at the display instant. */
export interface LiveWptState {
	/** Actual time over (ms): the departure's takeoff, else the crossing
	 *  stamp; null when not (yet) reached at the instant. Rows behind a
	 *  stamped one count as passed even when their own stamp is missing. */
	atoMs: number | null;
	/** THE single current estimate (ms), the hand-kept plog chain: rows
	 *  behind the aircraft freeze at their recalage value (the previous
	 *  waypoint's actual + the planned leg minutes), the target waypoint
	 *  updates continuously at the revision ground speed, rows beyond chain
	 *  the planned leg minutes onto it; before departure the chain runs
	 *  from the explicit ETD. Null with no anchor or no cruise speed, and
	 *  always for the departure row. */
	etoMs: number | null;
	passed: boolean;
}

export interface LiveNavlogState {
	/** One entry per waypoint (legs.length + 1). */
	wpts: LiveWptState[];
	/** Absolute leg index containing the along-route position, never behind a
	 *  waypoint already stamped at the instant; null before takeoff, after
	 *  arrival, or without a position. */
	currentLegIdx: number | null;
	/** Fraction [0, 1] of the current leg already flown (the progress bar). */
	currentLegFrac: number | null;
	/** Along-route position (NM) and lateral offset (m) at the instant. */
	distNM: number | null;
	offM: number | null;
	/** The committed takeoff as visible at the instant (null when the
	 *  playhead sits before it). */
	takeoffMs: number | null;
	/** The committed landing, same playhead filter. Flight time is the pair. */
	landingMs: number | null;
	/** Block out / block in: the first and last fix under way, playhead-
	 *  filtered. Block in waits for the landing, since until then the last
	 *  movement is simply now. */
	blockOutMs: number | null;
	blockInMs: number | null;
	arrived: boolean;
	/** The ground speed (kt) the target estimate used; null when none
	 *  resolved. */
	gsUsedKt: number | null;
	/** Destination ETA (the last waypoint's current estimate). */
	etaMs: number | null;
	/** Minutes the flight is running BEHIND its own plan (negative = ahead):
	 *  the arrival, actual once it has landed and the estimate before, against
	 *  the same planned time flown from this leg's departure. Time gained or
	 *  lost IN THE AIR, so a late departure is not counted twice and the
	 *  figure exists without a planned ETD; null before departure or with no
	 *  planned time to compare against. */
	planDeltaMin: number | null;
}

export interface LiveNavlogInput {
	/** computeNavLog legs (only legNM / cumNM are read). */
	legs: readonly { legNM: number; cumNM: number }[];
	checkpoints: readonly RouteProgressPoint[];
	/** The outing's takeoff / landing / block times (per trace). */
	motion: MotionFold;
	/** This leg's crossing stamps (per leg). */
	crossings: CrossingFold;
	/** The instant this leg was departed, which is the departure row's actual:
	 *  the outing's takeoff for the first leg, the junction departure for a
	 *  leg chained onto a preceding one. Omitted = the takeoff. */
	departureMs?: number | null;
	/** Display instant: the playhead (== the live tip while recording). */
	tMs: number;
	/** Live smoothed/pose ground speed, pre-gated >= MIN_VECTOR_KT, or null. */
	gsLiveKt: number | null;
	cruiseKt: number | null;
	/** Per-leg planned ground speeds (the sheet's wind recipe); null entries
	 *  fall back to still air inside legCumulativeMinutes. */
	legGsKt: readonly (number | null)[];
	/** The explicit planned departure (the dossier ETD chain), or null when
	 *  no ETD is set: a fabricated base must never fill the ETO column. */
	etdMs: number | null;
	/** Precomputed progressDistNM / progressOffM at tMs (the combined nav-live
	 *  selector projects the pose ONCE). undefined = compute internally; an
	 *  explicit null is honored as "no position". */
	distNM?: number | null;
	offM?: number | null;
	/** The segment the pilot asserted is being flown, and which the flight
	 *  has not sequenced past yet (state/navRoute's leg pins). It lifts the
	 *  INK FLOOR below: the log never re-targets a stamped waypoint on its
	 *  own, and an assertion made NOW is newer than the stamps, which is the
	 *  whole point of the correction (the turn back to an earlier waypoint
	 *  the floor exists to survive). The stamps stand either way; only what
	 *  the log points AT moves. */
	pinnedLegIdx?: number | null;
}

/** Assemble the live nav-log state at one instant. Pure; O(legs). */
export function liveNavlogAt(a: LiveNavlogInput): LiveNavlogState {
	const nLegs = a.legs.length;
	const totalNM = nLegs > 0 ? a.legs[nLegs - 1].cumNM : 0;
	/** Cumulative NM at waypoint k (k = 0 .. nLegs). */
	const wptCum = (k: number): number => (k === 0 ? 0 : a.legs[k - 1].cumNM);

	const takeoffMs = a.motion.takeoffMs != null && a.motion.takeoffMs <= a.tMs ? a.motion.takeoffMs : null;
	const airborne = takeoffMs != null;
	// The departure row's actual is the leg's own: a leg chained onto a
	// preceding one departs the junction, hours after the outing's takeoff.
	const departure = a.departureMs !== undefined ? a.departureMs : a.motion.takeoffMs;
	const departureMs = departure != null && departure <= a.tMs ? departure : null;
	const landingMs = a.motion.landingMs != null && a.motion.landingMs <= a.tMs ? a.motion.landingMs : null;
	const blockOutMs =
		a.motion.firstMoveMs != null && a.motion.firstMoveMs <= a.tMs ? a.motion.firstMoveMs : null;
	const blockInMs =
		landingMs != null && a.motion.lastMoveMs != null && a.motion.lastMoveMs <= a.tMs
			? a.motion.lastMoveMs
			: null;
	const distNM = a.distNM !== undefined ? a.distNM : progressDistNM(a.checkpoints, a.tMs);
	const offM = a.offM !== undefined ? a.offM : progressOffM(a.checkpoints, a.tMs);

	// The ink rule applied to the display: a waypoint whose ATO is visible at
	// the instant is behind the aircraft, so the log never re-targets it. A
	// circuit or a hold AT a waypoint (a touch-and-go, a procedure turn) dips
	// the along-route position back across the boundary several times, and
	// without this floor the active leg, the target banner and the passed
	// checks flip with every dip.
	let stampedIdx = 0;
	for (let k = 1; k <= nLegs; k++) {
		const ms = a.crossings.crossMs[k - 1];
		if (ms != null && ms <= a.tMs) {
			stampedIdx = k;
		}
	}

	// A live pin is the pilot answering the question the floor guesses at, so
	// it outranks it: the destination staying stamped no longer means arrived,
	// and the displayed leg is the one the position is on.
	const pinned = a.pinnedLegIdx ?? null;
	const arrived =
		airborne &&
		nLegs > 0 &&
		((pinned == null && stampedIdx === nLegs) ||
			(distNM != null && distNM >= totalNM - ARRIVAL_EPS_NM));
	let currentLegIdx: number | null = null;
	let currentLegFrac: number | null = null;
	if (airborne && !arrived && distNM != null) {
		let idx = nLegs - 1;
		for (let i = 0; i < nLegs; i++) {
			if (distNM < a.legs[i].cumNM) {
				idx = i;
				break;
			}
		}
		currentLegIdx = pinned != null ? idx : Math.max(idx, stampedIdx);
		const leg = a.legs[currentLegIdx];
		const startNM = leg.cumNM - leg.legNM;
		currentLegFrac =
			leg.legNM > 0 ? Math.max(0, Math.min(1, (distNM - startNM) / leg.legNM)) : 1;
	}

	// Planned minutes per leg: the sheet's wind-corrected recipe (per-leg
	// still-air fallback is internal to legCumulativeMinutes; null only when
	// the cruise speed is unset).
	const bounds = legCumulativeMinutes(a.legs, a.cruiseKt, a.legGsKt);
	const plannedLegMs = (k: number): number | null =>
		bounds != null ? (timeAtNM(wptCum(k), bounds) - timeAtNM(wptCum(k - 1), bounds)) * 60000 : null;

	// Target-estimate ground speed: live first, else the current leg's
	// planned GS, else still-air cruise.
	let gsUsedKt: number | null = null;
	if (currentLegIdx != null) {
		const planned = a.legGsKt[currentLegIdx];
		gsUsedKt =
			a.gsLiveKt ??
			(planned != null && planned > 0
				? planned
				: a.cruiseKt != null && a.cruiseKt > 0
					? a.cruiseKt
					: null);
	}
	const targetIdx = currentLegIdx != null ? currentLegIdx + 1 : null;

	// The estimate chain, in waypoint order: each row anchors on the
	// previous row's actual when stamped (the recalage), else its estimate;
	// the departure anchors the chain at the takeoff, else the explicit ETD.
	const wpts: LiveWptState[] = [];
	for (let k = 0; k <= nLegs; k++) {
		const atoMs =
			k === 0
				? departureMs
				: a.crossings.crossMs[k - 1] != null && a.crossings.crossMs[k - 1]! <= a.tMs
					? a.crossings.crossMs[k - 1]
					: null;
		let etoMs: number | null = null;
		if (k > 0) {
			// The live target estimate never overrides an inked row: a stamped
			// waypoint keeps its frozen recalage value even when the
			// projection re-targets it (a closed route after landing).
			if (k === targetIdx && atoMs == null && distNM != null && gsUsedKt != null) {
				etoMs = a.tMs + ((wptCum(k) - distNM) / gsUsedKt) * 3600000;
			} else {
				const prev = wpts[k - 1];
				const anchor = prev.atoMs ?? prev.etoMs ?? (k === 1 ? a.etdMs : null);
				const legMs = plannedLegMs(k);
				etoMs = anchor != null && legMs != null ? anchor + legMs : null;
			}
		}
		const passed =
			atoMs != null ||
			(k > 0 && k <= stampedIdx) ||
			(airborne && distNM != null && wptCum(k) <= distNM);
		wpts.push({ atoMs, etoMs, passed });
	}

	// Against the plan: the arrival the log is holding (the actual once it is
	// stamped, else the estimate) minus the same plan flown from this leg's
	// own departure. The whole estimate chain exists to answer per row; this
	// is the one number the machinery adds up to.
	const arrivalMs = nLegs > 0 ? (wpts[nLegs].atoMs ?? wpts[nLegs].etoMs) : null;
	const plannedTotalMin = bounds != null ? timeAtNM(totalNM, bounds) : null;
	const planDeltaMin =
		arrivalMs != null && departureMs != null && plannedTotalMin != null
			? (arrivalMs - departureMs) / 60_000 - plannedTotalMin
			: null;

	return {
		wpts,
		currentLegIdx,
		currentLegFrac,
		distNM,
		offM,
		takeoffMs,
		landingMs,
		blockOutMs,
		blockInMs,
		arrived,
		gsUsedKt,
		etaMs: nLegs > 0 ? wpts[nLegs].etoMs : null,
		planDeltaMin,
	};
}

/** The strings the display weaves; a parameter keeps this module free of the
 *  formatter home's state imports (the WindNoteWords idiom). */
export interface LiveNavlogFmt {
	/** Epoch ms -> 'HH:MM' UTC. */
	clock: (ms: number) => string;
}

/** One waypoint banner's display strings ('' = leave the slot blank). */
export interface LiveWptDisplay {
	/** The single current estimate. */
	eto: string;
	ato: string;
	passed: boolean;
	/** The waypoint currently navigated to (the current leg's end). */
	target: boolean;
}

export interface NavlogLiveDisplay {
	wpts: LiveWptDisplay[];
	currentLegIdx: number | null;
	currentLegFrac: number | null;
	arrived: boolean;
	/** Current / next radio-contact airspace keys, matched against the banner
	 *  frequency lines' EnrouteFreqLine.keys. Injected by the nav-live state
	 *  selector (toNavlogDisplay itself stays contact-free). */
	contactKey?: string | null;
	nextContactKey?: string | null;
}

/** One schedule row's live state (1:1 with the rendered schedule events,
 *  ABSOLUTE indices). */
export interface NavLiveScheduleRow {
	/** Behind the along-route position (or stamped): the dimmed prefix. */
	passed: boolean;
	/** Actual crossing time of this row's atNM (the schedule passage fold),
	 *  playhead-filtered; null when not (yet) crossed or unstampable. */
	atoMs: number | null;
}

/** The live overlay for NavLogSchedule, assembled by the nav-live state
 *  selector (state/navLive.svelte.ts). */
export interface NavLiveSchedule {
	rows: NavLiveScheduleRow[];
	/** Row index of the current contact's ENTER event (tier-resolved). */
	currentRowIdx: number | null;
	/** Row index of the next contact's ENTER event. */
	nextRowIdx: number | null;
	/** The next-contact-change countdown, pinned to the row where the change
	 *  happens (the next contact's enter, else the current one's leave). */
	chip: { rowIdx: number; toNM: number; eteMin: number | null } | null;
	/** The rows answer for the nearest point of a route the aircraft is not
	 *  on (off-route, or a route this flight never flew), so they are the
	 *  plan and not the position. The display says so rather than tinting at
	 *  full confidence. */
	planOnly: boolean;
}

/** Map the numeric state to display strings for NavLogSheet. */
export function toNavlogDisplay(s: LiveNavlogState, fmt: LiveNavlogFmt): NavlogLiveDisplay {
	const targetIdx = s.currentLegIdx != null ? s.currentLegIdx + 1 : null;
	return {
		wpts: s.wpts.map((w, k) => ({
			eto: w.etoMs != null ? fmt.clock(w.etoMs) : '',
			ato: w.atoMs != null ? fmt.clock(w.atoMs) : '',
			passed: w.passed,
			target: targetIdx === k,
		})),
		currentLegIdx: s.currentLegIdx,
		currentLegFrac: s.currentLegFrac,
		arrived: s.arrived,
	};
}
