/* Canonical NOTAM ordering: reproduce the French DSNA/SIA SOFIA-Briefing PIB
 * order for EVERY NOTAM source (SOFIA, autorouter, paste / upload), so the
 * NOTAMs tab and the detail-panel "n / XX" stepper share one sequence.
 *
 * A SOFIA "route etroite" bulletin groups NOTAMs by OWNER first and by ICAO
 * Q-code SUBJECT second: its `listnotams` tree is ADDep (departure aerodrome),
 * ADDes (destination), the aerodromes overflown or held as alternates, then FIR
 * (en-route), then Other; each block internally split by subject theme. Both
 * dimensions are recoverable from parsed ICAO fields, so the same order applies
 * to autorouter and pasted NOTAMs that never carry SOFIA's tree:
 *  - owner   = classifyOwner (Item A) + Q-line scope), see notam/ownership.ts;
 *  - subject = firSubjectGroup (Q-code 2nd/3rd letters), see notam/qcode.ts.
 * State wires the live resolvers and the routes' aerodrome sequence
 * (state/notamOrder.svelte.ts); this module is the pure total order.
 */

import type { Notam } from './types';
import type { NotamOwner } from './ownership';
import { firSubjectGroup } from './qcode';

export interface CanonicalOrderContext {
	/** Owner of a NOTAM (aerodrome ident / FIR list / checklist / unknown),
	 *  per the ICAO Item A) + Q-line scope rule (classifyOwner). */
	ownerOf: (n: Notam) => NotamOwner;
	/** Position of an aerodrome ICAO ident along the drawn routes, 0 = the first
	 *  route's departure, counting up through every route's airport waypoints in
	 *  order; idents on no route are absent. Anchors the aerodrome-block order to
	 *  the route the way SOFIA orders ADDep -> overflown -> ADDes. */
	aerodromeRank: ReadonlyMap<string, number>;
}

// Owner tiers, ascending. SOFIA's ADDep / ADDes / ... / FIR / Other structure,
// generalised: routed aerodromes (ordered along the route), then aerodromes off
// every route (an over-route field picked up by area), then en-route / FIR, then
// checklists (QKKKK; SOFIA omits them, paste / autorouter carry them), then the
// unclassifiable remainder.
const TIER_ROUTE_AD = 0;
const TIER_OTHER_AD = 1;
const TIER_FIR = 2;
const TIER_CHECKLIST = 3;
const TIER_UNKNOWN = 4;

interface OrderKey {
	tier: number;
	/** Route position for a routed aerodrome; 0 for every other tier. */
	rank: number;
	/** The owning aerodrome / FIR ident, so a tier's blocks stay grouped and
	 *  ordered (route rank first, then ident for off-route / FIR blocks). */
	ownerKey: string;
	/** firSubjectGroup order (restrictions 0 ... other 7) within a block. */
	subject: number;
	/** NOTAM id, a stable tie-break within a subject. */
	id: string;
	/** Source index: only separates the several areas of one multi-area NOTAM
	 *  (same id), keeping the sort total and stable. */
	index: number;
}

/** Owner block key for a NOTAM, locale-free: `AD <ident>`, `FIR <ident>`,
 *  `CHK <ident>`, or `?`. The NOTAMs tab maps this to a localized section
 *  heading; kept here so the block boundaries match the sort exactly. */
export function notamOwnerBlockKey(owner: NotamOwner): string {
	switch (owner.kind) {
		case 'aerodrome':
			return 'AD ' + owner.ident.toUpperCase();
		case 'fir':
			return 'FIR ' + firsKey(owner.firs);
		case 'checklist':
			return 'CHK ' + firsKey(owner.firs);
		default:
			return '?';
	}
}

/** The first FIR of a (usually single) FIR list, sorted so a multi-FIR NOTAM
 *  keys deterministically to one block. */
function firsKey(firs: string[]): string {
	let min = '';
	for (const f of firs) {
		const u = f.toUpperCase();
		if (min === '' || u < min) {
			min = u;
		}
	}
	return min;
}

function orderKey(notam: Notam, index: number, ctx: CanonicalOrderContext): OrderKey {
	const owner = ctx.ownerOf(notam);
	const subject = firSubjectGroup(notam.qCode).order;
	const id = notam.id ?? '';
	if (owner.kind === 'aerodrome') {
		const ident = owner.ident.toUpperCase();
		const rank = ctx.aerodromeRank.get(ident);
		if (rank !== undefined) {
			return { tier: TIER_ROUTE_AD, rank, ownerKey: ident, subject, id, index };
		}
		return { tier: TIER_OTHER_AD, rank: 0, ownerKey: ident, subject, id, index };
	}
	if (owner.kind === 'fir') {
		return { tier: TIER_FIR, rank: 0, ownerKey: firsKey(owner.firs), subject, id, index };
	}
	if (owner.kind === 'checklist') {
		return { tier: TIER_CHECKLIST, rank: 0, ownerKey: firsKey(owner.firs), subject, id, index };
	}
	return { tier: TIER_UNKNOWN, rank: 0, ownerKey: '', subject, id, index };
}

function cmpStr(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function compareKeys(a: OrderKey, b: OrderKey): number {
	return (
		a.tier - b.tier ||
		a.rank - b.rank ||
		cmpStr(a.ownerKey, b.ownerKey) ||
		a.subject - b.subject ||
		cmpStr(a.id, b.id) ||
		a.index - b.index
	);
}

/** Sort a COPY of `items` into the canonical SOFIA-PIB order. Membership is
 *  unchanged (every filter already applied upstream); only the sequence
 *  differs. Stable and total. */
export function sortNotamsCanonical<T extends { notam: Notam; index: number }>(
	items: readonly T[],
	ctx: CanonicalOrderContext,
): T[] {
	return items
		.map((it) => ({ it, key: orderKey(it.notam, it.index, ctx) }))
		.sort((a, b) => compareKeys(a.key, b.key))
		.map((x) => x.it);
}
