/* The in-flight band's cells: the live figures no other module computes and
 * the tap-to-cycle rings (docs/nav-live.md "The in-flight strip"). Pure: no
 * Svelte, no I/O, so a scrubbed replay renders the same cell from the same
 * instant. Pinned by tests/navBand.spec.ts.
 *
 * The heading to steer is the one figure the band adds to what the nav log
 * already knows. The plog's MH is a PLANNED figure per leg (the leg's true
 * track corrected by the forecast wind at the planned TAS, the variation at
 * the leg midpoint). In flight the aircraft is rarely on the leg's line, so
 * the live figure starts from the bearing FROM THE POSE to the active
 * waypoint, corrects it by the same wind and TAS, and takes the variation at
 * the pose. Without a wind or a TAS there is no correction to apply, and the
 * cell then reads BRG rather than an MH that is not one: a label naming the
 * reading is the band's rule, "blank or honest, never wrong" the winds'. */

import { initialBearingDeg } from '$lib/notam/geometry';
import { windTriangle } from '$lib/route/wind';
import { legMagneticTrackDeg, magneticFromTrue } from '$lib/route/magnetic';

export interface LiveHeadingInput {
	pose: { lat: number; lon: number };
	/** The waypoint being navigated to (the current leg's end). */
	target: { lat: number; lon: number };
	/** The leg's effective wind (direction it blows FROM, degrees true; kt),
	 *  null when the plan has none for this leg. */
	wind: { dirDeg: number; speedKt: number } | null;
	/** True airspeed (kt) at the leg's altitude; null without a cruise speed. */
	tasKt: number | null;
	/** Decimal year for the variation (decimalYearFromDate). */
	timeYears: number;
}

export interface LiveHeading {
	/** 'mh' when the wind correction was applied; 'brg' when the figure is
	 *  the bare magnetic bearing (no wind, no TAS, or a wind the triangle
	 *  cannot solve at that airspeed). */
	kind: 'mh' | 'brg';
	/** Degrees magnetic, [0, 360). */
	deg: number;
	/** The wind correction applied (degrees, positive = right of the
	 *  bearing); 0 for a bearing. */
	wcaDeg: number;
}

/** The magnetic heading to steer from the pose to the active waypoint. */
export function liveHeadingMagDeg(i: LiveHeadingInput): LiveHeading {
	const trueBrg = initialBearingDeg(i.pose.lat, i.pose.lon, i.target.lat, i.target.lon);
	if (i.wind && i.tasKt != null && i.tasKt > 0) {
		const sol = windTriangle(trueBrg, i.tasKt, i.wind.dirDeg, i.wind.speedKt);
		if (sol) {
			return {
				kind: 'mh',
				deg: magneticFromTrue(trueBrg + sol.wcaDeg, i.pose.lat, i.pose.lon, i.timeYears),
				wcaDeg: sol.wcaDeg,
			};
		}
	}
	return { kind: 'brg', deg: magneticFromTrue(trueBrg, i.pose.lat, i.pose.lon, i.timeYears), wcaDeg: 0 };
}

/** The leg's planned magnetic course (the plog's MC), Garmin's DTK: the
 *  nav-log recipe, variation at the leg midpoint, so the band and the sheet
 *  print the same number. */
export function dtkMagDeg(
	trackTrueDeg: number,
	from: { lat: number; lon: number },
	to: { lat: number; lon: number },
	timeYears: number,
): number {
	return legMagneticTrackDeg(trackTrueDeg, from, to, timeYears);
}

/** Height above the ground under the pose (ft), rounded; null when either
 *  reading is missing. Never clamped: a negative figure over a terrain void
 *  is a datum question the pilot should see, not a zero. */
export function aglFt(altMslFt: number | null, groundFt: number | null): number | null {
	if (altMslFt == null || groundFt == null) {
		return null;
	}
	return Math.round(altMslFt - groundFt);
}

/** The plan-delta suffix beside the ETA clock: "+3" three minutes behind
 *  the plan, "-2" two ahead, '' on time or unknown. The sign convention is
 *  navlogLive's planDeltaMin (positive = late). */
export function planDeltaSuffix(planDeltaMin: number | null): string {
	if (planDeltaMin == null) {
		return '';
	}
	const r = Math.round(planDeltaMin);
	if (r === 0) {
		return '';
	}
	return r > 0 ? `+${r}` : `-${Math.abs(r)}`;
}

/** The cross-track figure in the TRK ring's five characters: "0.3R", "12L",
 *  "0" on course (under a tenth or no side), '' unknown. */
export function xtkCompact(xtkNM: number | null, side: -1 | 0 | 1): string {
	if (xtkNM == null) {
		return '';
	}
	if (side === 0 || xtkNM < 0.1) {
		return '0';
	}
	const v = xtkNM < 10 ? xtkNM.toFixed(1) : String(Math.round(xtkNM));
	return `${v}${side > 0 ? 'R' : 'L'}`;
}

/* ---- rings ------------------------------------------------------------ */

/** The ringed cells and their readings, primary first. A ring holds the
 *  readings a pilot asks for about ONE subject (the contact, the target, the
 *  heading, the track, the height, the arrival), so a tap answers the next
 *  question without a menu. */
export const RING_ENTRIES = {
	freq: ['current', 'next', 'over'],
	next: ['wpt', 'dest'],
	mh: ['mh', 'dtk'],
	trk: ['trk', 'brg', 'xtk'],
	alt: ['gps', 'agl', 'msa'],
	eta: ['eta', 'ete'],
} as const;

export type RingId = keyof typeof RING_ENTRIES;
export type RingEntry<R extends RingId> = (typeof RING_ENTRIES)[R][number];

/** A tap's memory: the position chosen and the subject it was chosen FOR.
 *  The subject key names what the cell is about (the contact identity, the
 *  route and leg, the arrival state); when it changes the cell falls back to
 *  its primary on its own, which is the event the pilot would want it to
 *  answer for anyway. Storing the key rather than watching for the event
 *  keeps the rule pure and replay-safe. */
export interface RingPos {
	pos: number;
	key: string;
}

/** The entry to render: the remembered one while its subject stands and the
 *  entry has data, else the first entry that has data (the primary when it
 *  does; the frequency cell's overflown field when there is no contact). */
export function resolveRingPos(
	ring: RingId,
	stored: RingPos | null,
	subjectKey: string,
	available: readonly boolean[],
): number {
	const n = RING_ENTRIES[ring].length;
	const first = available.findIndex(Boolean);
	const primary = first === -1 ? 0 : first;
	if (!stored || stored.key !== subjectKey) {
		return primary;
	}
	const p = stored.pos;
	if (p < 0 || p >= n || !available[p]) {
		return primary;
	}
	return p;
}

/** The next entry with data after `pos`, wrapping; `pos` itself when no
 *  other entry has any (a tap then changes nothing, and the cell wears no
 *  cue for it: see ringHasAlternate). */
export function advanceRing(ring: RingId, pos: number, available: readonly boolean[]): number {
	const n = RING_ENTRIES[ring].length;
	for (let k = 1; k <= n; k += 1) {
		const q = (pos + k) % n;
		if (available[q]) {
			return q;
		}
	}
	return pos;
}

/** Whether a tap would show something else: the caret cue's condition. */
export function ringHasAlternate(ring: RingId, pos: number, available: readonly boolean[]): boolean {
	return advanceRing(ring, pos, available) !== pos;
}
