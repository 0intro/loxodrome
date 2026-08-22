/* The alert tier of one volume: the ACTION the airspace requires of the
 * pilot, computed from (flight-rules profile x classification x activation
 * state), never a static zone-type list. The regulatory mapping and its
 * citations are the contract in docs/nav-alerts.md; the avoid tier matches
 * the route profile's verified isForbiddenCrossing taxonomy
 * (route/routeProfile.ts), so the live banner and the briefed profile
 * crossings can never disagree about what is forbidden.
 *
 * Actions:
 *  - avoid: entry is prohibited for this flight (P, ZIT, QRP NOTAM, active
 *    RTBA / TSA, an R whose published condition for this flight's traffic
 *    category is avoidance, Class A under VFR).
 *  - clearance: entry is lawful only with an ATC clearance or under the
 *    published conditions (Class B/C/D, ATZ, ZRT, temporary-restricted
 *    NOTAMs, active TRA).
 *  - radio / transponder: an equipment or comms requirement, not a
 *    clearance (SERA.6005 RMZ / TMZ).
 *  - caution: hazard information the pilot should weigh (D areas, activity
 *    zones, warnings-family NOTAMs, unknown-schedule zones).
 *  - none: never alert (Class E under VFR per SERA.6001, F/G, cold zones).
 *
 * Pure; the reactive wiring resolves the activation state and the profile. */

import { zoneEntryAction } from '$lib/data/airspaceEntry';
import type { AlertVolume } from './alertVolumes';

export type AlertAction =
	| 'avoid'
	| 'clearance'
	| 'radio'
	| 'transponder'
	| 'caution'
	| 'none';

/** Resolved hotness of a volume over the evaluation interval. */
export type ActivityState = 'active' | 'cold' | 'unknown';

export interface AlertProfile {
	/** VFR flight (routeSettings.vfr). IFR suppresses the clearance and
	 *  equipment tiers: an IFR flight in the system is under ATC clearance
	 *  and equipped by definition, and boundary chatter on airways trains
	 *  the pilot to mute the channel. */
	vfr: boolean;
}

/** Severity order for picking the dominant alert; higher outranks. */
export const ACTION_RANK: Record<AlertAction, number> = {
	avoid: 5,
	clearance: 4,
	radio: 3,
	transponder: 3,
	caution: 2,
	none: 0,
};

/** The preference toggle an action answers to (the Navigation-tab tier
 *  checkboxes; radio and transponder share the equipment toggle). */
export type AlertTierPref = 'avoid' | 'clearance' | 'equipment' | 'caution';

export function tierPref(action: AlertAction): AlertTierPref | null {
	switch (action) {
		case 'avoid':
			return 'avoid';
		case 'clearance':
			return 'clearance';
		case 'radio':
		case 'transponder':
			return 'equipment';
		case 'caution':
			return 'caution';
		default:
			return null;
	}
}

function classifySupaip(v: AlertVolume, act: ActivityState, p: AlertProfile): AlertAction {
	if (act === 'cold' || (v.supIfrOnly && p.vfr)) {
		return 'none';
	}
	if (act === 'unknown') {
		return 'caution';
	}
	switch (v.supKind) {
		case 'zit':
		case 'forbidden':
			return 'avoid';
		case 'zrt':
		case 'conditional':
			return 'clearance';
		default:
			return 'caution';
	}
}

function classifyNotam(v: AlertVolume, act: ActivityState): AlertAction {
	if (act === 'cold') {
		return 'none';
	}
	switch (v.qSubject) {
		// RP = prohibited area, RR = restricted area: an in-force NOTAM of
		// either states a restriction that is hot, the active-R doctrine.
		case 'RP':
		case 'RR':
			return 'avoid';
		// RT = temporary restricted area, the NOTAM form of a ZRT: entry
		// under the published conditions.
		case 'RT':
			return 'clearance';
		default:
			// RD danger, RA reservations, RM MOA and the warnings family
			// (parachuting, UAS, fireworks...) are hazard information.
			return 'caution';
	}
}

const CAUTION_ZONE_TYPES = new Set(['D', 'MOA', 'W', 'A', 'ADIZ', 'CBA']);
/** Major controlled types where a missing class still means a clearance
 *  boundary (a CTR with no published class is still a CTR). */
const CLEARANCE_TYPES_ANY_CLASS = new Set(['CTR', 'TMA', 'CTA']);

function classifyAirspace(v: AlertVolume, act: ActivityState, p: AlertProfile): AlertAction {
	if (v.category === 'fir' || v.category === 'siv') {
		return 'none';
	}
	// Unconditional prohibitions, the isForbiddenCrossing set: activity
	// cannot soften them.
	if (v.type === 'P') {
		return 'avoid';
	}
	if (p.vfr && v.airClass === 'A') {
		return 'avoid';
	}
	if (v.rtba || v.type === 'R' || v.type === 'TSA' || v.type === 'TFR') {
		// The zone's PUBLISHED requirement for this flight, read once and
		// shared with the route profile's forbidden-crossing tier
		// (zoneEntryAction), so the banner and the briefing cannot disagree.
		// An R that is permanently in force answers even when the activation
		// model calls it cold, which is what keeps LF-R 275 forbidden to a
		// VFR flight on a day with no NOTAM.
		switch (zoneEntryAction(v, { vfr: p.vfr, active: act === 'active' })) {
			case 'forbidden':
				return 'avoid';
			// An authorization gate is the clearance tier for both profiles
			// (the ZRT posture).
			case 'clearance':
				return 'clearance';
			// A contact requirement naming the unit to call binds both
			// profiles at the equipment tier (LF-R 275's "entry allowed when
			// radio contact established with one of the administrators").
			case 'radio':
				return 'radio';
			// A watch whose own text exempts aircraft already working an ATS
			// frequency asks nothing of an IFR flight (LF-R 324).
			case 'radio-ats':
				return p.vfr ? 'radio' : 'none';
			default:
				// Cold is silent because the windows are authoritative and say
				// so. Unknown means there are none to be authoritative: no
				// briefing is loaded, so the state is simply not known, and an
				// unknown schedule earns a caution rather than silence or a
				// false forbidden.
				return act === 'unknown' ? 'caution' : 'none';
		}
	}
	if (v.type === 'TRA') {
		if (act === 'active') {
			return 'clearance';
		}
		return act === 'unknown' ? 'caution' : 'none';
	}
	if (CAUTION_ZONE_TYPES.has(v.type)) {
		return act === 'cold' ? 'none' : 'caution';
	}
	if (v.category === 'trafficmgmt') {
		if (!p.vfr) {
			return 'none';
		}
		return v.type === 'TMZ' ? 'transponder' : 'radio';
	}
	if (v.category === 'activity') {
		return 'caution';
	}
	// The clearance tier is class-driven and VFR-only from here on.
	if (!p.vfr) {
		return 'none';
	}
	if (v.type === 'ATZ') {
		// An ATZ demands two-way contact whatever its class (the UK Rule 11
		// reality; class G ATZs are the common case).
		return 'clearance';
	}
	if (v.airClass === 'B' || v.airClass === 'C' || v.airClass === 'D') {
		return 'clearance';
	}
	if (v.airClass === '' && CLEARANCE_TYPES_ANY_CLASS.has(v.type)) {
		return 'clearance';
	}
	// Class E is free for VFR (SERA.6001); F / G and the advisory
	// constructs (TRSA, SATA, FRA) alert nobody.
	return 'none';
}

export function classifyVolume(
	v: AlertVolume,
	act: ActivityState,
	profile: AlertProfile,
): AlertAction {
	switch (v.source) {
		case 'supaip':
			return classifySupaip(v, act, profile);
		case 'notam':
			return classifyNotam(v, act);
		default:
			return classifyAirspace(v, act, profile);
	}
}
