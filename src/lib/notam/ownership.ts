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

import type { Notam } from './types';

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
