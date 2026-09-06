/* Automatic stop of the live recording after landing (pure; no Svelte, no
 * I/O; wired by state/autoStop.svelte.ts, contract in docs/nav-live.md).
 * Landing-gated on purpose: the countdown arms only once the motion fold
 * has committed a landing, so a wait at the holding point can never end a
 * recording, and a recording that never flies runs until the pilot stops
 * it. What it ends is the flight that is over: the wake lock burning in
 * the flight bag, and the drive home whose sustained speed re-arms the
 * landing detector and rewrites the flight's record.
 *
 * The suppression carries the LANDING VALUE it answered, not a flag: a
 * later landing differs and re-arms on its own, and a value survives the
 * motion fold re-folding the same trace. It is stamped on the recording
 * and enable RISING EDGES as well as by "keep recording", because
 * Continue onto a landed trace (crash recovery, the second leg of a
 * stopover) and the preference ticked on while parked must both start
 * quiet rather than fire on the spot. */

/** Standstill after a committed landing (no fix at/above MOVE_KT) before
 *  the recording stops itself (ms). */
export const AUTO_STOP_GRACE_MS = 10 * 60_000;

export interface AutoStopFold {
	/** The previous reconcile's flags, for the rising edges. */
	recording: boolean;
	enabled: boolean;
	/** The committed landing the stop must not act on (see header). */
	suppressedLandingMs: number | null;
}

export interface AutoStopInput {
	recording: boolean;
	enabled: boolean;
	/** The motion fold's committed landing and last at/above-MOVE_KT fix
	 *  (nav/navlogLive.ts). */
	landingMs: number | null;
	lastMoveMs: number | null;
	/** Wall clock (the recorder's 1 Hz nav.nowMs, so a hangar with no GPS
	 *  still counts down; device-clock skew shifts the grace by the skew,
	 *  real-world seconds). */
	nowMs: number;
}

export interface AutoStopState {
	/** The armed countdown: when the stop fires, and the landing it
	 *  answers, which is what "keep recording" suppresses. Null while
	 *  disarmed. */
	pending: { stopAtMs: number; landingMs: number } | null;
	/** Due now: the caller stops the recording. */
	fire: boolean;
}

export function newAutoStopFold(): AutoStopFold {
	return { recording: false, enabled: false, suppressedLandingMs: null };
}

/** Advance the fold's edges and evaluate the stop at one instant. The
 *  deadline is the LATER of the landing and the last movement plus the
 *  grace: taxi-in keeps pushing it out, and an aircraft stopping dead on
 *  the runway still gets the full grace from its landing. A stop-and-go
 *  needs no case here: the motion fold clears its landing on the next
 *  sustained takeoff and the countdown vanishes with it. */
export function foldAutoStop(fold: AutoStopFold, a: AutoStopInput): AutoStopState {
	if ((a.recording && !fold.recording) || (a.enabled && !fold.enabled)) {
		fold.suppressedLandingMs = a.landingMs;
	}
	fold.recording = a.recording;
	fold.enabled = a.enabled;
	if (
		!a.recording ||
		!a.enabled ||
		a.landingMs == null ||
		a.landingMs === fold.suppressedLandingMs
	) {
		return { pending: null, fire: false };
	}
	const stopAtMs = Math.max(a.landingMs, a.lastMoveMs ?? a.landingMs) + AUTO_STOP_GRACE_MS;
	return { pending: { stopAtMs, landingMs: a.landingMs }, fire: a.nowMs >= stopAtMs };
}
