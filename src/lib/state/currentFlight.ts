/* The flight being flown, for the readouts that time it live: the toolbar
 * pill's elapsed, the Flight page's recording chip and its summary card
 * while recording (docs/nav-live.md). A trace can hold several flights, an
 * "Add to this trace" recording the next leg at the end of the landed one, so
 * neither the trace's first fix nor the fold's first takeoff says when the
 * flight in hand began. splitFlights cuts the outing properly but walks the
 * whole trace, too much once a second; the last flight's block-off depends
 * only on the fixes before its takeoff, so it is kept per trace and per
 * takeoff count, and the rest is the motion fold's own instants. A stopped
 * trace's card reads the logbook's summary instead, whose trailing rule can
 * close a rollout this live reading keeps open. */

import { lastFlightBlockOffMs } from '$lib/nav/logbook';
import type { TrackPoint } from '$lib/nav/trace';
import { traceMotion } from './navMotion';
import { nav, recordingResumedAfterMs } from './navRecording.svelte';

/** The trace's last flight off the fold's instants (splitFlights' last
 *  slice, less the distance walk). */
export interface LastFlight {
	/** 1-based; `count` flights in the trace, so the last one's index. */
	index: number;
	count: number;
	blockOffMs: number;
	takeoffMs: number;
	landingMs: number | null;
	blockOnMs: number | null;
	/** Whether the trace saw the block-off and the takeoff: false only for
	 *  a first flight the trace opened already moving or fast in (the
	 *  fold's own flags), every later one being seen by construction. */
	blockOutObserved: boolean;
	takeoffObserved: boolean;
}

let memo: { points: readonly TrackPoint[]; takeoffs: number; blockOffMs: number | null } | null =
	null;

/** The live trace's last flight; null without a committed takeoff. */
export function liveLastFlight(): LastFlight | null {
	const points = nav.points;
	const motion = traceMotion(points);
	const T = motion.takeoffsMs;
	const k = T.length - 1;
	if (k < 0) {
		return null;
	}
	if (!memo || memo.points !== points || memo.takeoffs !== T.length) {
		memo = { points, takeoffs: T.length, blockOffMs: lastFlightBlockOffMs(points, motion) };
	}
	const landingMs = k < motion.landingsMs.length ? motion.landingsMs[k] : null;
	return {
		index: T.length,
		count: T.length,
		blockOffMs: memo.blockOffMs ?? T[k],
		takeoffMs: T[k],
		landingMs,
		blockOnMs: landingMs != null ? motion.lastMoveMs : null,
		blockOutObserved: k > 0 || motion.blockOutObserved,
		takeoffObserved: k > 0 || motion.takeoffObserved,
	};
}

/** The first fix after `ms`, or null when none has come in yet. */
function firstFixAfter(points: readonly TrackPoint[], ms: number): number | null {
	let lo = 0;
	let hi = points.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (points[mid].timeMs <= ms) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo < points.length ? points[lo].timeMs : null;
}

/** When the flight being flown began, for the elapsed readouts; null before
 *  the first fix, so no 0:00 is shown while the GPS is still finding one.
 *  A later flight counts from its own block-off; the first from the trace's
 *  first fix, as the readout always has, so the clock does not jump back at
 *  the takeoff; and a flight that landed BEFORE this recording started (an
 *  add, the next takeoff not committed yet) is not the one being flown: the
 *  clock counts from this recording's first fix. */
export function currentFlightStartMs(): number | null {
	const points = nav.points;
	if (points.length === 0) {
		return null;
	}
	const flight = liveLastFlight();
	if (flight == null) {
		return points[0].timeMs;
	}
	const after = recordingResumedAfterMs();
	if (flight.landingMs != null && after != null && flight.landingMs <= after) {
		return firstFixAfter(points, after);
	}
	return flight.index > 1 ? flight.blockOffMs : points[0].timeMs;
}
