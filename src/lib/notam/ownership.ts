/* NOTAM ownership: which feature a NOTAM is filed under.
 *
 * ICAO PANS-AIM (Doc 10066) Appendix 3 and EUROCONTROL OPADD Ed 4.1 define
 * the rule: Item A) carries either ONE aerodrome location indicator or up to
 * seven FIR indicators, and the Q-line scope qualifier says which. Scope
 * A / AE / AW: aerodrome in A). Scope E / W: FIR(s) in A). Scope K: a
 * checklist (Q-code QKKKK, FIR(s) in A), administrative only. Real briefings
 * deviate, so classification is data-driven with scope as the tiebreaker:
 *
 *  - French P-series obstacle NOTAMs file under the FIR while keeping an
 *    aerodrome-family scope ("Q) LFMM/QOBCE/IV/M/A/..." + "A) LFMM"), so a
 *    scope-A NOTAM whose A) resolves only as a FIR is FIR-owned.
 *  - An airport ident can equal a FIR id (UAAA Almaty, UWWW Samara); scope
 *    decides which panel owns the NOTAM.
 *  - FAA domestic NOTAMs carry no Q-line; the A) ident alone decides.
 *
 * The resolvers are injected so the module stays pure: state wires them to
 * the loaded airport / FIR datasets, tests use literal sets.
 */

import { equirectangularDistanceM } from './geometry';
import { NM_TO_METERS } from './units';
import type { LatLon, Notam } from './types';

export type NotamOwner =
	| { kind: 'aerodrome'; ident: string }
	| { kind: 'fir'; firs: string[] }
	| { kind: 'checklist'; firs: string[] }
	| { kind: 'unknown' };

export interface OwnerResolvers {
	/** True when `ident` is a known aerodrome location indicator. */
	isAirport(ident: string): boolean;
	/** True when `ident` is a known FIR / UIR / ARTCC location indicator. */
	isFir(ident: string): boolean;
}

/** Classify which feature owns this NOTAM, per the Item A) / scope rule.
 *  A FIR briefing is keyed by the raw A) ident strings, not by the resolver,
 *  so a FIR we carry no polygon for still yields a 'fir' owner; the resolvers
 *  only power the deviation overrides and the no-Q-line fallback. */
export function classifyOwner(notam: Notam, r: OwnerResolvers): NotamOwner {
	const codes = notam.icaoCodes.map((c) => c.toUpperCase()).filter(Boolean);
	if (codes.length === 0) {
		return { kind: 'unknown' };
	}
	const scope = (notam.qualifier?.scope ?? '').toUpperCase();
	if (scope.includes('K') || notam.qCode === 'QKKKK') {
		return { kind: 'checklist', firs: codes };
	}
	if (scope.includes('A')) {
		// Aerodrome scope (A / AE / AW): A) is the aerodrome. When no code
		// resolves as an airport but one is a known FIR, this is the
		// file-under-the-FIR deviation (French P-series); otherwise trust
		// the scope even for idents we don't carry.
		const airport = codes.find((c) => r.isAirport(c));
		if (airport) {
			return { kind: 'aerodrome', ident: airport };
		}
		if (codes.some((c) => r.isFir(c))) {
			return { kind: 'fir', firs: codes };
		}
		return { kind: 'aerodrome', ident: codes[0] };
	}
	if (scope.includes('E') || scope.includes('W')) {
		// En-route / warning scope: A) lists the FIR(s). Mirror deviation:
		// when nothing resolves as a FIR but every code is a known airport,
		// the scope is malformed and the data wins.
		if (!codes.some((c) => r.isFir(c)) && codes.every((c) => r.isAirport(c))) {
			return { kind: 'aerodrome', ident: codes[0] };
		}
		return { kind: 'fir', firs: codes };
	}
	// No usable scope (missing Q-line / FAA domestic format): data-driven.
	if (r.isAirport(codes[0])) {
		return { kind: 'aerodrome', ident: codes[0] };
	}
	if (codes.some((c) => r.isFir(c))) {
		return { kind: 'fir', firs: codes };
	}
	return { kind: 'unknown' };
}

/** How close a NOTAM's own position has to be to an aerodrome's reference
 *  point to count as ON the field.
 *
 *  3 NM, for the reason already written beside route/radial.ts's
 *  ON_FIELD_VOR_RADIUS_NM: a large platform puts a feature well away from the
 *  point a NOTAM anchors to, while 3 stays tight enough not to claim a
 *  neighbour. Restated rather than imported because notam/ is the PURE parser
 *  core and radial.ts pulls the magnetic model and the navaid tables in behind
 *  it; both apps already reach route/ elsewhere, so the viewer's bundle is not
 *  the argument.
 *  Measured over the 2026-09-21 corpus of 7,548 NOTAMs across 22 States,
 *  3,319 of them aerodrome-owned Q-line pins: 2,972 sit within 1 NM of the
 *  reference point, 3,154 within 3, and the 165 beyond it are navaid
 *  outages, zone activations, TMA changes and FIS closures, i.e. NOTAMs
 *  about somewhere else entirely. */
export const ON_FIELD_NM = 3;

/** Does this NOTAM's drawn position sit ON the aerodrome that owns it?
 *
 *  Only a Q-LINE position is asked about, because only that one is a
 *  fallback: the Q-line centre is a radius of influence's centre, which for
 *  most aerodrome NOTAMs IS the reference point (and then the airport symbol
 *  with its cue ring says everything the pin would) but for an en-route or
 *  warning-scope one is the navaid, the zone or the sector the NOTAM is
 *  really about, tens of NM away. A parsed PSN is the NOTAM's own statement
 *  of where it is and is never redundant.
 *
 *  `pos` is the owner aerodrome's position, or null when the datasets do not
 *  carry it; an unresolvable owner is never on the field, since nothing is
 *  drawn there to stand in for the pin. */
export function ownerPinOnField(
	notam: Notam,
	owner: NotamOwner,
	pos: LatLon | null,
): boolean {
	if (owner.kind !== 'aerodrome' || !pos) {
		return false;
	}
	const q = notam.coordinates.find((c) => c.type === 'qualifierLine');
	if (!q) {
		return false;
	}
	return (
		equirectangularDistanceM(pos.lat, pos.lon, q.lat, q.lon) <=
		ON_FIELD_NM * NM_TO_METERS
	);
}

/** Index FIR-owned items by FIR ident, checklists separately: the per-FIR
 *  briefing a FIR detail panel lists. A multi-FIR NOTAM (A) up to 7 FIRs)
 *  is inserted under every ident it is filed with. Generic over the item
 *  shape so state can pass IndexedNotam without this module importing it. */
export function firOwnershipIndex<T extends { notam: Notam }>(
	items: T[],
	r: OwnerResolvers,
): { briefing: Map<string, T[]>; checklists: Map<string, T[]> } {
	const briefing = new Map<string, T[]>();
	const checklists = new Map<string, T[]>();
	const push = (m: Map<string, T[]>, key: string, item: T) => {
		const arr = m.get(key);
		if (arr) {
			arr.push(item);
		} else {
			m.set(key, [item]);
		}
	};
	for (const item of items) {
		const owner = classifyOwner(item.notam, r);
		if (owner.kind === 'fir') {
			for (const f of owner.firs) {
				push(briefing, f, item);
			}
		} else if (owner.kind === 'checklist') {
			for (const f of owner.firs) {
				push(checklists, f, item);
			}
		}
	}
	return { briefing, checklists };
}
