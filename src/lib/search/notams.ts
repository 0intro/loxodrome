/* NOTAMs on the search engine: by id, then by an A) location, one row per
 * source NOTAM, in the briefing's own order within a tier (docs/search.md
 * "The palette"). Pure. */

import type { IndexedNotam } from '$lib/state/notam.svelte';
import { NO_MATCH, TIER } from './match';
import type { PreparedQuery } from './query';
import { CLASS, compareHits, KIND, type Hit, type Ranked } from './rank';

function notamTier(item: IndexedNotam, qi: string): number {
	const id = item.notam.id.toUpperCase();
	if (id === qi) {
		return TIER.IDENT_EXACT;
	}
	if (id.startsWith(qi)) {
		return TIER.IDENT_PREFIX;
	}
	let best = NO_MATCH;
	for (const code of item.notam.icaoCodes) {
		const c = code.toUpperCase();
		if (c === qi) {
			return TIER.ALT_IDENT_EXACT;
		}
		if (c.startsWith(qi)) {
			best = TIER.ALT_IDENT_PREFIX;
		}
	}
	return best;
}

export function rankNotams(items: readonly IndexedNotam[], q: PreparedQuery, cap: number): Ranked<IndexedNotam> {
	const qi = q.upper;
	if (qi === '') {
		return { hits: [], total: 0 };
	}
	// A NOTAM over several areas is several items sharing its id: one row.
	const seen = new Set<string>();
	const hits: Hit<IndexedNotam>[] = [];
	items.forEach((item, i) => {
		if (seen.has(item.notam.id)) {
			return;
		}
		const tier = notamTier(item, qi);
		if (tier === NO_MATCH) {
			return;
		}
		seen.add(item.notam.id);
		hits.push({ item, tier, cls: CLASS.OPEN, dist: Infinity, kind: KIND.notam, order: String(i).padStart(7, '0') });
	});
	hits.sort(compareHits);
	return { hits: hits.slice(0, cap), total: hits.length };
}
