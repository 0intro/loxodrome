/* How the packs pair the trips' loading sheets on their landscape sheets:
 * two trips side by side, each a column (its table over its chart), wherever
 * the PAIR fits the sheet, a trip alone otherwise (its table beside its
 * chart, the roomier layout). A pair's columns share their rows, so its
 * tables and its charts stand level and its height is the two columns'
 * together, taller than either alone where one says more above its table
 * and the other under its chart. Decided on each pair's MEASURED height
 * (mbMeasure.ts), the nav-log cards' rule: paper that outgrows its sheet is
 * split by measurement, never by estimate. Pure. */

/** The packs' landscape content box (A4 less the 12 mm sheet margins). */
export const PAIR_SHEET_MM = 273;
/** The gap between a pair's two columns. */
export const PAIR_GAP_MM = 8;
/** A pair column's width. */
export const PAIR_COLUMN_MM = (PAIR_SHEET_MM - PAIR_GAP_MM) / 2;
/** The height a pair may take: the 186 mm a landscape sheet's
 *  content holds inside its 12 mm margins, which both engines repeat on every
 *  page the sheet runs onto (box-decoration-break: clone; Gecko always, and
 *  Chromium too, measured on 151), less the 12 mm a pair block opening a page
 *  carries on top of them: 174 mm. Less 5 mm for what the measure cannot see,
 *  the paper's own rounding of the line boxes. The mixed six-trip plan's
 *  tallest pair prints 168.4 mm in Chromium. */
export const PAIR_BUDGET_MM = 169;
/** A pair column's chart height, viewBox units over its 480 width. */
export const PAIR_CHART_H = 200;

/** CSS pixels per millimetre (96 dpi). */
export const PX_PER_MM = 96 / 25.4;

/** Every trip on its own sheet: no measure, or a measure that failed. */
export function singleBlocks(n: number): number[][] {
	return Array.from({ length: n }, (_, k) => [k]);
}

/** Every pair two neighbours could make, the measure's own layout: trips k
 *  and k + 1 for each k, so a trip is measured beside each neighbour, its
 *  pair's height depending on both. */
export function candidatePairs(n: number): number[][] {
	return Array.from({ length: Math.max(0, n - 1) }, (_, k) => [k, k + 1]);
}

/** The `n` trips in order, two to a sheet where their pair fits `budgetPx`
 *  (`pairHeights[k]`: trips k and k + 1 measured side by side), a trip alone
 *  where its pair with the next does not. */
export function pairBlocks(n: number, pairHeights: readonly number[], budgetPx: number): number[][] {
	const out: number[][] = [];
	const fits = (k: number) => pairHeights[k] > 0 && pairHeights[k] <= budgetPx;
	for (let k = 0; k < n; ) {
		if (k + 1 < n && fits(k)) {
			out.push([k, k + 1]);
			k += 2;
		} else {
			out.push([k]);
			k += 1;
		}
	}
	return out;
}
