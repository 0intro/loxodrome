/* Route-specific display formatters for the nav-log modal. Kept out of the
 * generic src/lib/format/ since they are only used by the route UI. */

import { navaidFreqLabel } from '$lib/data/navaids';
import { navaidById } from '$lib/state/data.svelte';
import type { Waypoint } from '$lib/state/route.svelte';

/** Track / heading in 3-digit degrees, north as 360 ("079°", "360°"). */
export function fmtTrack(deg: number): string {
	const d = ((Math.round(deg) % 360) + 360) % 360;
	return `${String(d === 0 ? 360 : d).padStart(3, '0')}°`;
}

/** Distance in NM: one decimal under 100, whole numbers at/above. */
export function fmtNM(nm: number): string {
	return nm >= 100 ? nm.toFixed(0) : nm.toFixed(1);
}

/** Altitude in feet as a plain integer string ("2000"). */
export function fmtAlt(ft: number): string {
	return String(Math.round(ft));
}

/** Wind as "247°/18 kt": the direction the wind blows FROM (degrees true,
 *  3-digit) and its speed in knots. */
export function fmtWind(dirDeg: number, speedKt: number): string {
	return `${fmtTrack(dirDeg)}/${Math.round(speedKt)} kt`;
}

/** True when a planned level sits above the transition altitude and is
 *  therefore flown, shown and edited as a flight level; a level equal to
 *  the TA stays an altitude (AIP France ENR 1.7.2.2). */
export function isFlightLevelAt(ft: number, taFt: number): boolean {
	return ft > taFt;
}

/** Planned cruising level for display: "FL 065" above the transition
 *  altitude (the shared SIA notation), bare feet ("4500") at or below. */
export function fmtLevel(ft: number, taFt: number): string {
	return isFlightLevelAt(ft, taFt)
		? `FL ${String(Math.round(ft / 100)).padStart(3, '0')}`
		: fmtAlt(ft);
}

/** Vertical-trend arrow for a leg climbing/level/descending fromFt -> toFt. */
export function vertArrow(fromFt: number, toFt: number): string {
	if (toFt > fromFt + 1) {
		return '↗'; // up-right
	}
	if (toFt < fromFt - 1) {
		return '↘'; // down-right
	}
	return '→'; // right
}

/** Epoch ms as an 'HH:MM' UTC clock stamp, the live nav-log ETO / ATO cell
 *  (Doc 8400 times are UTC; locale-invariant by decision). */
export function fmtClockUtc(ms: number): string {
	const d = new Date(ms);
	return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** The seconds-bearing sibling, 'HH:MM:SS' UTC: the replay transports' time
 *  of day, where a debrief correlates against clocks outside the app. */
export function fmtClockUtcSec(ms: number): string {
	const d = new Date(ms);
	return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

/** Duration as H:MM, or an en-dash when unknown. */
export function fmtEte(min: number | null): string {
	if (min == null) {
		return '–';
	}
	const total = Math.round(min);
	const h = Math.floor(total / 60);
	const m = total % 60;
	return `${h}:${String(m).padStart(2, '0')}`;
}

/** Duration in human words for prose contexts ("9 min", "1 h", "1 h 05 min");
 *  tables and labelled ETE chips keep fmtEte's H:MM. */
export function fmtDurationMin(min: number): string {
	const total = Math.round(min);
	const h = Math.floor(total / 60);
	const m = total % 60;
	if (h === 0) {
		return `${m} min`;
	}
	if (m === 0) {
		return `${h} h`;
	}
	return `${h} h ${String(m).padStart(2, '0')} min`;
}

/** "H:MM:SS" (or "M:SS" under an hour) from a duration in ms. */
export function fmtDurationMs(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const mm = String(m).padStart(2, '0');
	const ss = String(s).padStart(2, '0');
	return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** Navaid tuning frequency for an anchored navaid waypoint; "" otherwise
 *  (airports carry no frequency; free points have none). */
export function fmtFreq(wp: Waypoint): string {
	if (wp.kind !== 'navaid' || !wp.refId) {
		return '';
	}
	const n = navaidById(wp.refId);
	return n ? navaidFreqLabel(n) : (wp.freq ?? '');
}

/** Join the automatic frequency blocks (airport radios, then the leg's
 *  enroute lines) into the manual-editor seed text: one "LABEL: freq" per
 *  line, a BLANK LINE between the two blocks. The blank line is the text
 *  form of the cell's dotted airport / enroute separator, kept editable;
 *  freqDisplayLines maps it back to the rule. */
export function freqSeedText(
	airportLines: readonly string[],
	enrouteLines: readonly string[],
): string {
	const blocks: string[] = [];
	if (airportLines.length > 0) {
		blocks.push(airportLines.join('\n'));
	}
	if (enrouteLines.length > 0) {
		blocks.push(enrouteLines.join('\n'));
	}
	return blocks.join('\n\n');
}

/** Split manual frequency text into display lines: a blank line is not shown
 *  itself, it marks the NEXT line with the dotted separator rule (the
 *  automatic cell's airport / enroute split). Leading blanks draw nothing,
 *  consecutive blanks one rule. */
export function freqDisplayLines(text: string): { text: string; sep: boolean }[] {
	const out: { text: string; sep: boolean }[] = [];
	let sepPending = false;
	for (const line of text.split('\n')) {
		if (line.trim() === '') {
			sepPending = out.length > 0;
			continue;
		}
		out.push({ text: line, sep: sepPending });
		sepPending = false;
	}
	return out;
}
