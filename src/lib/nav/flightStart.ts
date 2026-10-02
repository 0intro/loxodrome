/* What the flight button does with the trace that is loaded
 * (docs/nav-live.md, "In-flight ergonomics"). How the trace ENDED decides it,
 * never its age alone: a recording stopped in the air is the same flight
 * cut short (a crashed page, a Stop pressed by mistake), so one tap resumes
 * it; a landed flight is over, so the tap starts the next one; a trace that
 * never took off, or that ended slow somewhere no known field confirms, is
 * ambiguous, and the pilot is asked. A replayed library flight, an imported
 * file and anything of unknown origin are never resumed: appending a flight
 * to one would rewrite a record that is not this recording's.
 *
 * The other half of every answer is what a NEW flight would drop. A trace
 * the flights library holds loses nothing when it is replaced; one it does
 * not hold (no takeoff, no wall clock, a failed or unavailable store, an
 * answer not in yet) is discarded, and the caller asks first.
 *
 * Pure over its inputs: the motion fold and the field lookups are the
 * caller's (state/flightAction.svelte.ts), the clock a parameter. */

import { trailingLandingMs, type SummaryDeps } from './logbook';
import type { MotionFold } from './navlogLive';
import { OUTING_MS } from './outing';
import { hasAbsoluteTime, type TrackPoint } from './trace';

/** A recording stopped in flight resumes without a question within this of
 *  its last fix: the cockpit case, one tap. Past it the gap is asked about,
 *  since resuming records the whole gap as flown. */
export const RESUME_SILENT_MS = 30 * 60_000;
/** A last fix this far AHEAD of the device clock is a skewed clock, not a
 *  fresh fix (a native fix carries the GNSS time): asked, never resumed. */
export const CLOCK_SKEW_MS = 2 * 60_000;

/** Where the live trace came from: this device's own recording, an
 *  imported file, a flights-library row loaded for replay, or a crash copy
 *  written by a build that did not say. */
export type TraceOrigin = 'recording' | 'import' | 'library' | 'unknown';

/** How a stopped trace ended. `slow` is an open flight that ends under the
 *  landing speed where no known field confirms a landing: an unlisted strip,
 *  or a recording that died slow in the air (a hover). */
export type TraceEnd = 'ground' | 'landed' | 'slow' | 'airborne';

/** Why a new flight would drop the loaded trace: the library refuses it
 *  (no wall clock, or no committed takeoff: archiveOuting's own gates, in
 *  its order), or it is a flight the library has not taken (the store
 *  failed or is unavailable, or has not answered yet). */
export type DiscardReason = 'noClock' | 'noTakeoff' | 'unsaved';

export type EndDeps = Pick<SummaryDeps, 'altMslFt' | 'fieldElevFt'>;

/** A flight is open: a takeoff committed and no landing standing since it
 *  (the navRoute rule). What the Stop confirm asks about while recording. */
export function flightOpen(motion: MotionFold): boolean {
	return motion.takeoffMs != null && motion.landingMs == null;
}

/** What replacing the loaded trace would drop, or null when the flights
 *  library holds it as it stands (or nothing is loaded), or when the
 *  replacement moves the flight aside rather than drop it (`setAside`: a
 *  shared computer's found flight, which the outbox keeps for the library,
 *  state/navRecording.svelte.ts foundTraceGoesAside). */
export function discardReason(
	points: readonly TrackPoint[],
	motion: MotionFold,
	filed: boolean,
	setAside = false,
): DiscardReason | null {
	if (filed || points.length === 0) {
		return null;
	}
	if (!hasAbsoluteTime(points)) {
		return 'noClock';
	}
	if (motion.takeoffMs == null) {
		return 'noTakeoff';
	}
	return setAside ? null : 'unsaved';
}

/** How a stopped trace ended, over its motion fold. */
export function traceEnd(
	points: readonly TrackPoint[],
	motion: MotionFold,
	deps: EndDeps,
): TraceEnd {
	if (motion.takeoffMs == null) {
		return 'ground';
	}
	if (motion.landingMs != null || trailingLandingMs(points, motion, deps) != null) {
		return 'landed';
	}
	return motion.belowSinceMs != null ? 'slow' : 'airborne';
}

export interface FlightStartInput {
	points: readonly TrackPoint[];
	motion: MotionFold;
	deps: EndDeps;
	origin: TraceOrigin | null;
	/** The flights library holds this trace as it stands. */
	filed: boolean;
	nowMs: number;
	/** The trace is not this session's to extend, whatever recorded it: a
	 *  shared computer's sign-in found it (sync/found.ts), so it is the
	 *  device's, not the signed-in pilot's. */
	foreign?: boolean;
	/** A new flight moves the trace aside rather than drop it (see
	 *  discardReason). */
	setAside?: boolean;
}

export interface FlightDecision {
	/** `new`: start a fresh trace; `resume`: append to this one, no
	 *  question; `ask`: Resume or New flight is the pilot's choice. */
	kind: 'new' | 'resume' | 'ask';
	/** How the loaded trace ended; null with no trace. */
	end: TraceEnd | null;
	lastFixMs: number | null;
	/** When a `landed` trace landed: its standing committed landing, else the
	 *  rollout the trailing rule closed. Null for every other end. */
	landedMs: number | null;
	/** What a new flight would drop, or null when it drops nothing the
	 *  library does not hold. */
	discard: DiscardReason | null;
	/** "Add to this trace" is offered: this device's recording, landed,
	 *  inside the outing window. */
	appendable: boolean;
}

/** The one decision every entry point reads. */
export function flightDecision(input: FlightStartInput): FlightDecision {
	const { points, motion } = input;
	if (points.length === 0) {
		return { kind: 'new', end: null, lastFixMs: null, landedMs: null, discard: null, appendable: false };
	}
	const lastFixMs = points[points.length - 1].timeMs;
	const end = traceEnd(points, motion, input.deps);
	const landedMs =
		end === 'landed' ? (motion.landingMs ?? trailingLandingMs(points, motion, input.deps)) : null;
	const discard = discardReason(points, motion, input.filed, input.setAside === true);
	const gap = input.nowMs - lastFixMs;
	const own = input.origin === 'recording' && input.foreign !== true;
	const outing = gap < OUTING_MS;
	const base = { end, lastFixMs, landedMs, discard };
	if (!own || !outing) {
		return { ...base, kind: 'new', appendable: false };
	}
	switch (end) {
		case 'landed':
			return { ...base, kind: 'new', appendable: true };
		case 'airborne':
			return {
				...base,
				kind: gap >= -CLOCK_SKEW_MS && gap < RESUME_SILENT_MS ? 'resume' : 'ask',
				appendable: false,
			};
		default:
			return { ...base, kind: 'ask', appendable: false };
	}
}
