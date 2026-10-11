/* French plural rule; the English twin lives in ../en/plural.ts. French
 * keeps 0 singular ("0 jour", "0 aérodrome"), so the boundary is n < 2. */

export function plural(n: number, one: string, other: string): string {
	return n < 2 ? one : other;
}

/** "3", "3 et 4", "2, 3 et 5": a list read aloud. */
export function andList(items: readonly (string | number)[]): string {
	if (items.length <= 1) {
		return String(items[0] ?? '');
	}
	return `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`;
}
