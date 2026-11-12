/* The palette's groups in the order their best results deserve (docs/search.md
 * "The palette"): a group leads when its first row is the best answer, so
 * Enter takes it. Pure. */

import { compareHits, type Ranked } from './rank';

export interface Group {
	readonly ranked: Ranked<unknown>;
	/** A group kept at the head (a typed position) or the tail (countries)
	 *  whatever its results. */
	readonly place?: 'first' | 'last' | undefined;
}

function placeRank(g: Group): number {
	return g.place === 'first' ? 0 : g.place === 'last' ? 2 : 1;
}

/** The groups with results, the pinned ones at their end, the rest by their
 *  best hit; a tie keeps the order given. */
export function orderGroups<G extends Group>(groups: readonly G[]): G[] {
	return groups
		.filter((g) => g.ranked.hits.length > 0)
		.sort((a, b) => placeRank(a) - placeRank(b) || compareHits(a.ranked.hits[0], b.ranked.hits[0]));
}
