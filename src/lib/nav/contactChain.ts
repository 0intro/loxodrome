/* The radio-contact chain of a flight: departure aerodrome -> airspace units
 * -> destination aerodrome, the order the units are actually called in and the
 * order a pilot's frequency card lists them. The airspace half is resolved by
 * route/airspaces (tier + recency + nesting); this is the rule that brackets it
 * with the two fields, kept pure so it can be pinned (tests/navContact.spec.ts).
 * No Svelte, no I/O; contract: docs/nav-live.md. */

import type { AirspaceRadio } from '$lib/data/airspaces';
import { contactLines, type ContactLine } from '$lib/format/radio';

/** One unit of the chain, ready for display. */
export interface NavContactUnit {
	kind: 'airspace' | 'aerodrome';
	/** Airspace row key (airspaceByKey resolves the polygon for the map
	 *  clones); null for an aerodrome, which has no polygon of its own. */
	key: string | null;
	/** "CTR MELUN" / "SIV SEINE 4" / "LFPL LOGNES EMERAINVILLE". */
	label: string;
	/** Effective radios (frequency-change NOTAMs applied): RAI-narrowed for an
	 *  airspace, the aerodrome's full voice list otherwise. Both datasets carry
	 *  the same freq / unit / call shape. */
	radio: AirspaceRadio[];
	/** ICAO ident of the aerodrome, so a surface showing the unit can open its
	 *  panel; null for an airspace, which is addressed by `key` instead. */
	ident: string | null;
	/** A visible frequency-change NOTAM could not be tied to any published
	 *  row, so the list above may be stale in a way this unit cannot show. The
	 *  aerodrome panel carries the reasons. */
	freqFlagged: boolean;
	/** Set when this unit is the contact BECAUSE a service-closure NOTAM
	 *  removed the unit that would otherwise outrank it (a closed SIV handing
	 *  the corridor to the FIC underneath): the sector that closed and the
	 *  NOTAM, for the band's marker and its tooltip. Display provenance only;
	 *  the resolution itself already happened in the span build. */
	closedBy?: { notamId: string; closedLabel: string };
}

/** A unit's voice services, the one to CALL first (format/radio): what the
 *  band shows (its first line) and unfolds, and what the sheet's ink names,
 *  one function so the two cannot pick different channels. An airspace
 *  unit's label is its zone ("CTA PEPZE CTA 11"), what a channel naming no
 *  station is called after. */
export function unitLines(u: NavContactUnit): ContactLine[] {
	return contactLines(u.radio, u.kind, u.label);
}

/** The nav log's live contact ink (NavlogLiveDisplay's contact fields): the
 *  current and next AIRSPACE units' keys, an aerodrome having no enroute
 *  line to bold, and the channel the band sets for each, its first contact
 *  line (unitLines). None while the flight is off the route (`planOnly`):
 *  the band and the schedule mute there, and the sheet bolded the contact
 *  line at full confidence. */
export function contactInk(
	current: NavContactUnit | null,
	next: NavContactUnit | null,
	planOnly: boolean,
): { contactKey: string | null; contactFreq: string | null; nextContactKey: string | null; nextContactFreq: string | null } {
	const ink = (u: NavContactUnit | null): { key: string | null; freq: string | null } =>
		!planOnly && u?.kind === 'airspace'
			? { key: u.key, freq: unitLines(u)[0]?.freq ?? null }
			: { key: null, freq: null };
	const cur = ink(current);
	const nxt = ink(next);
	return { contactKey: cur.key, contactFreq: cur.freq, nextContactKey: nxt.key, nextContactFreq: nxt.freq };
}

/** A unit's identity: its airspace row key, else its aerodrome ident. Never its
 *  label for an airspace: two rows can carry one name (SIV STRASBOURG 4 is two
 *  rows split at FL075, on different channels), and a surface keyed on it
 *  takes one for the other. The label is the last resort of a unit that has
 *  neither, which the chain never builds. */
export function contactUnitId(u: Pick<NavContactUnit, 'key' | 'ident' | 'label'>): string {
	return u.key ?? u.ident ?? u.label;
}

/** Distance (NM) along the route within which the DEPARTURE aerodrome keeps
 *  the contact after takeoff: at an A/A or tower field you stay with the field
 *  until clear of the circuit, and the FIS watch underneath is not who you are
 *  talking to. A field inside a CTR needs no rule, since the CTR is itself the
 *  first airspace contact and any unit above the FIS watch pre-empts this. */
export const DEPARTURE_HANDOVER_NM = 3;

/** Lead time (minutes) before the next contact change at which a surface too
 *  narrow to carry the next unit permanently raises it: the window in which
 *  the call actually has to be made. A unit is contacted BEFORE its airspace
 *  is entered, never on crossing the boundary (SERA.6001 for the clearance
 *  tiers; SERA.6005 for an RMZ), and the FIS / SIV handovers that make up
 *  most of a VFR leg are the `none` tier of the alert evaluator by design,
 *  so nothing else announces them. Five minutes is the airspace-alert
 *  lookahead default, the same question asked of a hazard rather than of a
 *  frequency. */
export const HANDOVER_LEAD_MIN = 5;

/** The distance form of the same window, for when there is no ground speed to
 *  turn the boundary into minutes (parked, or a trace carrying no speed):
 *  10 NM is HANDOVER_LEAD_MIN at a light single's 120 kt. */
export const HANDOVER_LEAD_NM = 10;

/** Whether the next contact is close enough to be worth raising: EITHER
 *  measure of closeness, never the time alone.
 *
 *  The union is what makes the answer stable, and it was measured rather than
 *  reasoned: on the real LFAF approach of 2026-08-18 the time-only rule opened
 *  the window, shut it again for some fifty seconds and reopened it, because
 *  SLOWING DOWN pushes the ETE back up through the lead even while the
 *  distance keeps closing, and slowing down is precisely what an arrival is.
 *  Each flip moved the band (and the map under it) by 48 px. The distance to
 *  the boundary only ever decreases along the route, so gating on it too makes
 *  the window effectively one-way without any latch, which is what keeps this
 *  pure: a latch would be history, and a scrubbed replay must render from the
 *  playhead instant alone (docs/nav-live.md, "Route-referenced, by design").
 *
 *  False with neither figure: leaving the DEPARTURE field has no boundary
 *  distance (it happens when the pilot is clear of the circuit, not at a
 *  line), so there is no lead to count down and the line would simply stand
 *  for the whole departure phase instead of marking an event. */
export function handoverDue(toBoundaryNM: number | null, eteMin: number | null): boolean {
	if (toBoundaryNM != null && toBoundaryNM <= HANDOVER_LEAD_NM) return true;
	if (eteMin != null && eteMin <= HANDOVER_LEAD_MIN) return true;
	return false;
}

export interface ContactChainInput {
	/** The airspace contact in force at the position, and the one after the
	 *  next change (route/airspaces contactStateAt, already mapped to units). */
	airCurrent: NavContactUnit | null;
	airNext: NavContactUnit | null;
	/** contactTier of the airspace contact in force: 0 = FIS watch, 1 = RMZ,
	 *  2 = controlled. Anything above the watch is who you are talking to, so
	 *  it pre-empts the departure field. Negative with no airspace contact. */
	currentTier: number;
	/** The two bracketing aerodromes, null when the waypoint is not an airport
	 *  known to the dataset. */
	departure: NavContactUnit | null;
	destination: NavContactUnit | null;
	/** Along-route position (NM); null without a pose. */
	distNM: number | null;
	/** NM from the position to the next AIRSPACE contact change; null when
	 *  none is coming. */
	boundaryNM: number | null;
	/** NM still to fly to the destination; null without a pose. */
	remainingNM: number | null;
	arrived: boolean;
}

export interface ContactChainState {
	current: NavContactUnit | null;
	next: NavContactUnit | null;
	/** NM to the next change: the airspace boundary, or the distance still to
	 *  fly when the destination field is next. Null when the change has no
	 *  distance to it (leaving the departure field happens when the pilot is
	 *  clear of it, not at a boundary) and when nothing is next. */
	toBoundaryNM: number | null;
}

/** Resolve the chain at one position. Pure. */
export function contactChainAt(i: ContactChainInput): ContactChainState {
	if (i.arrived && i.destination) {
		return { current: i.destination, next: null, toBoundaryNM: null };
	}
	// The departure field holds the contact until DEPARTURE_HANDOVER_NM along
	// the route, unless a unit above the FIS watch applies. The test is on
	// POSITION, never on the takeoff stamp: a trace that starts in the air
	// (a device switched on late, an imported leg) never commits a takeoff, and
	// keying on it would leave the field as the contact for the whole flight.
	// No position at all is the pre-flight brief, where the field is right.
	const depHolds =
		i.departure != null &&
		!i.arrived &&
		i.currentTier <= 0 &&
		(i.distNM == null || i.distNM < DEPARTURE_HANDOVER_NM);
	if (depHolds) {
		return {
			current: i.departure,
			next: i.airCurrent ?? i.airNext ?? i.destination,
			toBoundaryNM: null,
		};
	}
	if (i.airNext == null && i.destination != null && !i.arrived) {
		return { current: i.airCurrent, next: i.destination, toBoundaryNM: i.remainingNM };
	}
	return { current: i.airCurrent, next: i.airNext, toBoundaryNM: i.boundaryNM };
}
