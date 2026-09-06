/* English plural rule; the French twin lives in ../fr/plural.ts. One helper
 * per language keeps the rule in exactly one place: English pluralises
 * everything but exactly one ("0 days"), French keeps 0 singular ("0 jour"). */

export function plural(n: number, one: string, other: string): string {
	return n === 1 ? one : other;
}
