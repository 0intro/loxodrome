/* The palette's actions on the search engine: a label, and the state word
 * beside it ("Chart shown"), so "chart" or "carte" finds the chart toggles
 * in either language. Registry order within a tier. Pure. */

import { frame } from './fold';
import { matchTier, NO_MATCH } from './match';
import type { PreparedQuery } from './query';
import { CLASS, compareHits, KIND, type Hit, type Ranked } from './rank';

export interface Labelled {
	readonly label: string;
	readonly state: string;
}

export function rankActions<T extends Labelled>(items: readonly T[], q: PreparedQuery, cap: number): Ranked<T> {
	const hits: Hit<T>[] = [];
	items.forEach((item, i) => {
		const tier = matchTier({ id: [], altId: [], name: frame([item.label]), altName: frame([item.state]) }, q);
		if (tier !== NO_MATCH) {
			hits.push({ item, tier, cls: CLASS.OPEN, dist: Infinity, kind: KIND.action, order: String(i).padStart(4, '0') });
		}
	});
	hits.sort(compareHits);
	return { hits: hits.slice(0, cap), total: hits.length };
}
