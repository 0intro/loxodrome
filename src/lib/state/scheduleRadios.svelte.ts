/* The nav log's airspace schedule, with the frequency to SET resolved.
 *
 * One stage over computeAirspaceSchedule's events: each crossed airspace's
 * radio reads its CURRENT value (a frequency-change NOTAM moves SEINE 4/5
 * here exactly as it moves an aerodrome's tower), and a sector outside its
 * OWN PUBLISHED HOURS has its radio emptied, so the contact ladder falls back
 * to the unit underneath. SIV LE BOURGET is SAT-SUN, so Pontoise reads LE
 * BOURGET Information at a weekend and PARIS Information on a Monday
 * (docs/siv-frequencies.md).
 *
 * Split from freqOverride.svelte.ts, which owns the NOTAM -> radio overlay
 * itself and is what the detail panels read. This stage is the NAV LOG's
 * alone: it is the part that needs a route (the schedule is a route walk) and
 * a planned flight (the hours and the NOTAMs are judged over the flight's own
 * span, state/timeWindow.svelte.ts plannedFlightAt), and
 * keeping it here is what stops an aerodrome panel printing a published
 * frequency from dragging the trips, the nav log and the wind forecast in
 * behind it.
 *
 * Reads reactive state through freqOverride's resolvers, so the data filters
 * propagate. Call inside a $derived.
 */

import { narrowToRai, raiRadioIndex, type Airspace } from '$lib/data/airspaces';
import type { RouteAirspaceEvent } from '$lib/route/airspaces';
import { parseSectorHours, sectorActiveIn, type SectorHours } from '$lib/route/airspaceHours';
import { plannedFlightAt } from './timeWindow.svelte';
import {
	closureIdents,
	freqChangeIdents,
	resolveAirspaceRadios,
	type ResolveAt,
} from './freqOverride.svelte';

/** Does either season's closing time need a position to resolve? Only the
 *  CHEVREUSE sub-sectors do (three rows nationally, on "SS+30"), and asking
 *  first is what keeps every other sector off the ring walk below. */
function needsSunPosition(hours: SectorHours): boolean {
	return hours.winter.to.kind === 'sunset' || hours.summer.to.kind === 'sunset';
}

/** The position a sunset-relative closing time is resolved at: the sector's
 *  own ring centre. A sector is small enough that its centre and the crossing
 *  point differ by about a minute of sunset. Null when the row is not to hand
 *  or carries no ring, which leaves the schedule unresolved and so leaves the
 *  frequency alone. */
function ringCentre(a: Airspace | undefined): { lat: number; lon: number } | null {
	if (!a || a.ring.length === 0) {
		return null;
	}
	let lat = 0;
	let lon = 0;
	for (const [y, x] of a.ring) {
		lat += y;
		lon += x;
	}
	return { lat: lat / a.ring.length, lon: lon / a.ring.length };
}

/** A route's airspace schedule (from computeAirspaceSchedule) with frequency-change
 *  NOTAMs applied to each crossed airspace's radio, so the radio reads its current
 *  value (a SIV frequency NOTAM moves SEINE 4/5 here too), and with the radio of a
 *  sector outside its published hours withdrawn. Call inside a $derived.
 *
 *  BOTH ranges default to the planned flight (plannedFlightAt): the sector's
 *  hours and the NOTAMs' own validity alike, since which frequency to set is
 *  a question about the flight. The NOTAM range used to be the briefing window,
 *  unbounded by default, so an 8.33 kHz conversion effective next month moved
 *  the frequency the nav log printed for today's flight. The live selector
 *  passes its display instant for both.
 *
 *  Returns the schedule ARRAY ITSELF when nothing moved, not a fresh copy of it.
 *  navLive's span memo keys on that identity (`spanEntry.schedule !== resolved`)
 *  to keep buildContactSpans off the 1 Hz path, so a per-call allocation would
 *  rebuild the spans, the closed spans and the event index on EVERY fix. The
 *  common case is nothing moving: a visible frequency NOTAM elsewhere in France,
 *  or a route merely crossing a sector that publishes hours, must not cost that.
 *  A real change still hands back a fresh array, which is what makes the memo
 *  notice it. */
export function resolveScheduleRadios(
	schedule: RouteAirspaceEvent[],
	airspaces: Airspace[],
	at: ResolveAt = plannedFlightAt(),
	hoursAt: ResolveAt = at,
): RouteAirspaceEvent[] {
	const hasNotams = freqChangeIdents().size > 0 || closureIdents().size > 0;
	// The FIS sectors that publish a schedule this can read, which is 12 of the
	// 110 French rows (the other 46 non-permanent ones state no text and stay
	// unknown, i.e. assumed open). parseSectorHours is memoised on its two
	// strings, so this costs a map lookup per event rather than a parse.
	const hours = schedule.map((ev) =>
		ev.category === 'siv' ? parseSectorHours(ev.workHr, ev.rmkWorkHr) : null,
	);
	const hasHours = hours.some((h) => h != null && h !== 'always');
	if (!hasNotams && !hasHours) {
		return schedule;
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local lookup index, not reactive
	const byKey = new Map(airspaces.map((a) => [a.key, a]));
	let moved = false;
	const out = schedule.map((ev, i) => {
		// A sector off watch over the flight publishes no frequency to set, so
		// it yields no contact and does not suppress the FIR-level blanket
		// underneath: over Pontoise on a Monday, LE BOURGET Information is shut
		// (SAT-SUN) and PARIS Information is the FIS. Emptying the radio is all
		// it takes; every gate downstream already skips an event with none, and
		// 18 rows carried none at all until the <Activite> path filled them.
		// Unknown never withdraws anything (sectorActiveIn returns null).
		//
		// Judged on the EVENT's own published hours, so it stands whether or not
		// the airspace is still in the array; only a sunset-relative closing
		// time needs the row itself, for a position to resolve it at.
		const h = hours[i];
		if (h != null && h !== 'always') {
			const pos = needsSunPosition(h) ? ringCentre(byKey.get(ev.key)) : null;
			if (sectorActiveIn(h, hoursAt, pos) === false) {
				moved = true;
				return { ...ev, radio: [] };
			}
		}
		const a = byKey.get(ev.key);
		if (!hasNotams || !a) {
			return ev;
		}
		// Narrow to the RAI entry by its original index (resolveAirspaceRadios
		// preserves order), so an override on the RAI shows here while a change to
		// a non-RAI lumped frequency is ignored. ev.radio is already RAI-narrowed
		// by makeEvent, so the untouched branch returns it unchanged.
		const radios = narrowToRai(resolveAirspaceRadios(a, at).radios, raiRadioIndex(a));
		if (!radios.some((r) => r.override || r.closed)) {
			return ev;
		}
		moved = true;
		return { ...ev, radio: radios };
	});
	return moved ? out : schedule;
}
