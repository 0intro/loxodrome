/* French plural rule; the English twin lives in ../en/plural.ts. French
 * keeps 0 singular ("0 jour", "0 aérodrome"), so the boundary is n < 2. */

export function plural(n: number, one: string, other: string): string {
	return n < 2 ? one : other;
}
