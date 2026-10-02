/* Aircraft-tab fleet list view state: the search query (session-only) and
 * the expanded operator groups (persisted). Groups are keyed by the operator
 * name, '' for the no-operator group. Operator groups fold by default: the
 * set holds the groups the user has explicitly opened, so an untouched
 * (or newly appearing) flight-club group starts folded. */

import { readJson, writeJson } from './persist';

const EXPANDED_KEY = 'loxodrome:fleet-expanded';

interface StoredExpanded {
	v: 1;
	groups: string[];
}

function initialExpanded(): Record<string, true> {
	const stored = readJson<StoredExpanded>(EXPANDED_KEY);
	const out: Record<string, true> = {};
	if (stored && stored.v === 1 && Array.isArray(stored.groups)) {
		for (const g of stored.groups) {
			if (typeof g === 'string') {
				out[g] = true;
			}
		}
	}
	return out;
}

export const fleetView = $state({
	query: '',
	expanded: initialExpanded(),
});

/** Fold / unfold one operator group ('' = the no-operator group). Groups fold
 *  by default, so the stored set lists the ones explicitly opened. */
export function toggleFleetGroup(operator: string): void {
	if (fleetView.expanded[operator]) {
		delete fleetView.expanded[operator];
	} else {
		fleetView.expanded[operator] = true;
	}
	writeJson(EXPANDED_KEY, { v: 1, groups: Object.keys(fleetView.expanded) } satisfies StoredExpanded);
}
