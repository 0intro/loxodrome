/* NOTAMs on the search engine: by id, then by an A) location, one row per
 * source NOTAM, in the briefing's own order within a tier, the NOTAMs
 * outside the period after the period's own (docs/search.md "The
 * palette"). Pure. */

import { bareNotamId } from '$lib/notam/splice';
import type { IndexedNotam } from '$lib/state/notam.svelte';
import { NO_MATCH, TIER } from './match';
import type { PreparedQuery } from './query';
import { CLASS, compareHits, KIND, type Hit, type Ranked } from './rank';

function notamTier(item: IndexedNotam, qi: string): number {
	const id = item.notam.id.toUpperCase();
	// Its own number too, without the location a pasted bulletin or the
	// parser's collision label writes before it (LOWS-A0958/26).
	const bare = bareNotamId(id);
	if (id === qi || bare === qi) {
		return TIER.IDENT_EXACT;
	}
	if (id.startsWith(qi) || bare.startsWith(qi)) {
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

/** `items` are the NOTAMs in the period and `outside` the ones it leaves
 *  out, which the NOTAMs tab lists demoted: found all the same, each after
 *  the period's own at its match. */
export function rankNotams(
	items: readonly IndexedNotam[],
	q: PreparedQuery,
	cap: number,
	outside: readonly IndexedNotam[] = [],
): Ranked<IndexedNotam> {
	const qi = q.upper;
	if (qi === '') {
		return { hits: [], total: 0 };
	}
	// A NOTAM over several areas is several items sharing its id: one row.
	const seen = new Set<string>();
	const hits: Hit<IndexedNotam>[] = [];
	const add = (item: IndexedNotam, order: string): void => {
		if (seen.has(item.notam.id)) {
			return;
		}
		const tier = notamTier(item, qi);
		if (tier === NO_MATCH) {
			return;
		}
		seen.add(item.notam.id);
		hits.push({ item, tier, cls: CLASS.OPEN, dist: Infinity, kind: KIND.notam, order });
	};
	items.forEach((item, i) => add(item, '0' + String(i).padStart(7, '0')));
	outside.forEach((item, i) => add(item, '1' + String(i).padStart(7, '0')));
	hits.sort(compareHits);
	return { hits: hits.slice(0, cap), total: hits.length };
}
