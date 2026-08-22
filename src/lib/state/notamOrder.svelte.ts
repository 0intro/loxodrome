/* The canonical NOTAM order (SOFIA-Briefing PIB order) as a reactive derived
 * over visibleNotams(), every drawn route's aerodromes (in departure ->
 * destination sequence), and the live ownership resolvers. The NOTAMs tab and the
 * detail-panel stepper both read orderedVisibleNotams(), so they share ONE
 * sequence and the "n / XX" position always matches the visible list. The rule
 * itself is pure in notam/order.ts.
 */

import { visibleNotams, notamOwner, type IndexedNotam } from './notam.svelte';
import { routes } from './route.svelte';
import {
	notamOwnerBlockKey,
	sortNotamsCanonical,
	type CanonicalOrderContext,
} from '$lib/notam/order';
import type { NotamOwner } from '$lib/notam/ownership';

/** Map each route-aerodrome ICAO ident to its position along the routes: every
 *  route's airport-anchored waypoints, in order, all routes concatenated in tab
 *  order, the first occurrence winning. This is the aerodrome-block order SOFIA
 *  gives a bulletin (departure, overflown / alternates, destination), extended
 *  across all drawn routes. Reactive: reads routes.list and each waypoint. */
function routeAerodromeRank(): Map<string, number> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain index handed to the pure sorter, not reactive state
	const rank = new Map<string, number>();
	let n = 0;
	for (const route of routes.list) {
		for (const wp of route.waypoints) {
			if (wp.kind === 'airport' && wp.ident) {
				const ident = wp.ident.toUpperCase();
				if (!rank.has(ident)) {
					rank.set(ident, n++);
				}
			}
		}
	}
	return rank;
}

/** visibleNotams() reordered into the canonical SOFIA-PIB order: aerodrome
 *  NOTAMs first (grouped per aerodrome in route order, then off-route
 *  aerodromes), then en-route / FIR, then checklists, then the remainder; by
 *  subject theme within each block. Same set and same filters as
 *  visibleNotams(); only the sequence differs. Reactive: tracks the NOTAM set,
 *  every data filter, the ownership datasets, and every route's aerodromes. */
export function orderedVisibleNotams(): IndexedNotam[] {
	const ctx: CanonicalOrderContext = {
		ownerOf: notamOwner,
		aerodromeRank: routeAerodromeRank(),
	};
	return sortNotamsCanonical(visibleNotams(), ctx);
}

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
	const out: NotamOwnerSection[] = [];
	let current: NotamOwnerSection | null = null;
	for (const item of orderedVisibleNotams()) {
		const owner = notamOwner(item.notam);
		const key = notamOwnerBlockKey(owner);
		if (!current || current.key !== key) {
			current = { key, owner, items: [] };
			out.push(current);
		}
		current.items.push(item);
	}
	return out;
}
