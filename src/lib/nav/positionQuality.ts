/* How much the displayed position can be trusted right now.
 *
 * Every live surface (the instrument tiles, the ownship marker, the
 * trajectory vector, the estimate chain, the contact resolution) reads one
 * pose, and until this module existed a frozen fix rendered exactly like a
 * fresh one: a receiver dropout, a hangar or a backgrounded tab left a
 * confident, wrong picture on screen for as long as the pilot cared to look
 * at it. The EFBs all treat this as a state of its own (SkyDemon separates a
 * full loss, where the position is unknown, from a partial one, where only
 * the altitude is), so this says which of three states the fix is in and the
 * surfaces render accordingly.
 *
 * Recording only: a replay pose is an interpolation of a recorded fact, so it
 * has no live quality to report. Pure, no Svelte, no clock of its own (the
 * caller passes the instant, which is what makes it testable);
 * tests/navPositionQuality.spec.ts. */

export type PositionQuality = 'good' | 'degraded' | 'lost';

/** Fix age (ms) past which the position is no longer current. Two GPS
 *  reporting periods on any receiver that reports at 1 Hz, so a single
 *  skipped sample never trips it. */
export const STALE_MS = 5_000;
/** Fix age (ms) past which there is no usable position at all. Matches the
 *  watchPosition timeout, so the sensor's own error and this state arrive
 *  together rather than one before the other. */
export const LOST_MS = 15_000;
/** Reported horizontal accuracy (m) worse than this is a degraded fix. Well
 *  inside MAX_ACCURACY_M (the outright rejection threshold in the recorder),
 *  so the band between them shows as degraded instead of silently thinning
 *  the trace. */
export const DEGRADED_ACCURACY_M = 50;
/** Consecutive rejected fixes that count as degraded. The recorder drops
 *  anything coarser than MAX_ACCURACY_M, which otherwise stalls the trace
 *  with no visible cause at all. */
export const DEGRADED_REJECTS = 3;

export interface PositionQualityInput {
	/** Only a live watch has a quality; a replay pose is a recorded fact. */
	recording: boolean;
	/** Time of the last ACCEPTED fix (ms UTC), null before the first one. */
	lastFixMs: number | null;
	/** The instant to judge against (ms UTC). */
	nowMs: number;
	/** Reported horizontal accuracy of that fix (m), when the device gives one. */
	accuracyM: number | null;
	/** Fixes rejected since the last accepted one. */
	rejected: number;
}

/** The quality of the live position at `nowMs`. */
export function positionQualityAt(i: PositionQualityInput): PositionQuality {
	if (!i.recording) {
		return 'good';
	}
	if (i.lastFixMs == null) {
		return 'lost';
	}
	// A fix stamped in the future (device clock skew) is treated as current
	// rather than as impossibly fresh evidence of anything.
	const ageMs = Math.max(0, i.nowMs - i.lastFixMs);
	if (ageMs >= LOST_MS) {
		return 'lost';
	}
	if (
		ageMs >= STALE_MS ||
		(i.accuracyM != null && i.accuracyM > DEGRADED_ACCURACY_M) ||
		i.rejected >= DEGRADED_REJECTS
	) {
		return 'degraded';
	}
	return 'good';
}
