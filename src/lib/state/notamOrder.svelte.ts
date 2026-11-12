/* The canonical NOTAM order (SOFIA-Briefing PIB order) as a reactive derived
 * over visibleNotams(), every drawn route's aerodromes (in departure ->
 * destination sequence), and the live ownership resolvers. The NOTAMs tab and the
 * detail-panel stepper both read orderedVisibleNotams(), so they share ONE
 * sequence and the "n / XX" position always matches the visible list. The rule
 * itself is pure in notam/order.ts.
 */

import { visibleNotams, notamOwner, ownerResolverToken, type IndexedNotam } from './notam.svelte';
import { planScope } from './planScope.svelte';
import {
	notamOwnerBlockKey,
	sortNotamsCanonical,
	type CanonicalOrderContext,
} from '$lib/notam/order';
import type { NotamOwner } from '$lib/notam/ownership';

/** The rank an app with no plan supplies. Shared and never written: the
 *  pure sorter only reads it. */
const NO_RANK: Map<string, number> = new Map();

/** visibleNotams() reordered into the canonical SOFIA-PIB order: aerodrome
 *  NOTAMs first (grouped per aerodrome in route order, then off-route
 *  aerodromes), then en-route / FIR, then checklists, then the remainder; by
 *  subject theme within each block. Same set and same filters as
 *  visibleNotams(); only the sequence differs. Reactive: tracks the NOTAM set,
 *  every data filter, the ownership datasets, and every route's aerodromes. */
export function orderedVisibleNotams(): IndexedNotam[] {
	// Reactive reads first, then the cache check. The sort is over the whole
	// visible briefing and the NOTAMs tab asks for it (and for the sections
	// below) on every render, including the minute tick, which moves the
	// window but usually not the set.
	const items = visibleNotams();
	// Null with no route workspace: the sort then degrades to its own
	// non-route ordering, which is what a briefing nobody planned deserves.
	const rank = planScope.aerodromeRank?.() ?? NO_RANK;
	const sig = [...rank.keys()].join(',');
	// The ownership resolvers are an input of the sort (ownerOf), and they
	// change when the airspace or airport dataset lands AFTER the first
	// sort of a boot: the visible set is the same array then, so without
	// this key the stale order (a FIR-owned NOTAM filed under an aerodrome
	// block) would stand until the window moved.
	const owners = ownerResolverToken();
	if (
		orderCache &&
		orderCache.items === items &&
		orderCache.sig === sig &&
		orderCache.owners === owners
	) {
		return orderCache.out;
	}
	const ctx: CanonicalOrderContext = { ownerOf: notamOwner, aerodromeRank: rank };
	const out = sortNotamsCanonical(items, ctx);
	orderCache = { items, sig, owners, out };
	return out;
}

// The rank signature is the aerodrome idents in route order, which is exactly
// what the sort reads out of the Map; comparing it avoids re-sorting when a
// route edit left the aerodrome chain alone (an altitude change, a free-point
// drag).
let orderCache: {
	items: IndexedNotam[];
	sig: string;
	owners: object;
	out: IndexedNotam[];
} | null = null;
let sectionCache: { ordered: IndexedNotam[]; out: NotamOwnerSection[] } | null = null;

/** A contiguous owner block of the canonically ordered list: the SOFIA-Briefing
 *  aerodrome / FIR / checklist grouping. */
export interface NotamOwnerSection {
	/** Stable block key, changing exactly at each owner boundary. */
	key: string;
	owner: NotamOwner;
	items: IndexedNotam[];
}

/** `orderedVisibleNotams()` cut into owner blocks (aerodrome / FIR / checklist /
 *  other), contiguous by construction because the sort keys owner before
 *  subject. The block key is the canonical `notamOwnerBlockKey`, the SAME one
 *  the sort orders by, so the sections cut at exactly the sort's boundaries
 *  (a per-FIR checklist run stays its own section, its `owner.firs` matching
 *  its heading). Shared by the NOTAMs tab's sections and the SOFIA-style print
 *  bulletin so the two never disagree. Reactive: reads the ordered list + the
 *  ownership resolvers. */
export function orderedNotamOwnerSections(): NotamOwnerSection[] {
	const ordered = orderedVisibleNotams();
	if (sectionCache && sectionCache.ordered === ordered) {
		return sectionCache.out;
	}
	const out: NotamOwnerSection[] = [];
	let current: NotamOwnerSection | null = null;
	for (const item of ordered) {
		const owner = notamOwner(item.notam);
		const key = notamOwnerBlockKey(owner);
		if (!current || current.key !== key) {
			current = { key, owner, items: [] };
			out.push(current);
		}
		current.items.push(item);
	}
	sectionCache = { ordered, out };
	return out;
}

/** Spend a row budget down the sections IN ORDER, so the first block comes out
 *  whole rather than every block being clipped. The canonical order puts the
 *  aerodrome blocks first, which is what a reader opens a briefing for.
 *
 *  Pure, and inert at an infinite budget: an app whose briefings are a
 *  corridor never reaches it, which is why Loxodrome's own list passes none
 *  (docs/performance-2026-08.md declined capping for it, on the grounds that
 *  it changes what the UI does). An app whose briefings are continental does
 *  reach it: a world dump shows 9 148 rows in the default period, 79 363 DOM
 *  nodes to build. */
export function budgetSections(
	sections: readonly NotamOwnerSection[],
	maxRows: number,
): { sections: NotamOwnerSection[]; hidden: number } {
	if (!Number.isFinite(maxRows)) {
		return { sections: [...sections], hidden: 0 };
	}
	let left = Math.max(0, maxRows);
	const out: NotamOwnerSection[] = [];
	let hidden = 0;
	for (const sec of sections) {
		if (left <= 0) {
			hidden += sec.items.length;
			continue;
		}
		if (sec.items.length <= left) {
			out.push(sec);
			left -= sec.items.length;
			continue;
		}
		out.push({ ...sec, items: sec.items.slice(0, left) });
		hidden += sec.items.length - left;
		left = 0;
	}
	return { sections: out, hidden };
}
