/* English plural rule; the French twin lives in ../fr/plural.ts. One helper
 * per language keeps the rule in exactly one place: English pluralises
 * everything but exactly one ("0 days"), French keeps 0 singular ("0 jour"). */

export function plural(n: number, one: string, other: string): string {
	return n === 1 ? one : other;
}

/** "3", "3 and 4", "2, 3 and 5": a list read aloud. */
export function andList(items: readonly (string | number)[]): string {
	if (items.length <= 1) {
		return String(items[0] ?? '');
	}
	return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
