/* Which of several overlapping AREAS a click selects.
 *
 * This is the rule half of docs/map-hit-testing.md's tier 2: the smallest
 * DRAWN shape under the point wins, whatever kind drew it, ties broken by the
 * pane the kind draws in. It is pure, Leaflet-free and knows nothing about
 * what is on the map; the GATHER (which kinds to ask, and how) is the caller's,
 * because the set of kinds differs per app and a parameterised gather would
 * allocate a closure per kind on every pointer move.
 *
 * Keeping the rule here is what lets a second gather exist without a second
 * rule: two maps can disagree about what is drawn on them and must not
 * disagree about which drawn thing a click means.
 */

/** Where each area kind draws, highest first: the tie-break when two shapes
 *  measure the same, since shapes of one size are told apart only by which is
 *  on top. It is also the order the whole ladder applied before the area tier
 *  learned to compare sizes, so a tie behaves exactly as it always did. */
export const AREA_PANE_Z = { notam: 450, sigmet: 435, supaip: 365, airspace: 350 };

/** How close counts as the same size. Not a rounding curiosity: a French ZRT
 *  activation routinely republishes the exact ring of the zone it activates,
 *  and two code paths measuring one ring differ in the last bits. A tenth of a
 *  percent is far below anything a pilot could aim at. */
export const AREA_TIE = 1e-3;

/** One drawn area under the point: what it would select, how big the shape
 *  that contained the point is, and which pane drew it. */
export interface AreaCandidate<H> {
	hit: H;
	areaM2: number;
	z: number;
}

/** A measureless shape ranks as the largest, so it loses to anything measured
 *  and still wins when it is the only thing under the point: drawn ink must
 *  never become unclickable. */
export function rankArea(areaM2: number): number {
	return Number.isFinite(areaM2) ? areaM2 : Infinity;
}

/** The smallest candidate, ties falling to the topmost pane. Null on an empty
 *  list. Order-independent: the caller may gather in any order. */
export function bestArea<H>(candidates: readonly AreaCandidate<H>[]): H | null {
	let best: AreaCandidate<H> | null = null;
	for (const c of candidates) {
		if (!best) {
			best = c;
			continue;
		}
		if (c.areaM2 < best.areaM2 * (1 - AREA_TIE)) {
			best = c;
		} else if (!(best.areaM2 < c.areaM2 * (1 - AREA_TIE)) && c.z > best.z) {
			best = c;
		}
	}
	return best?.hit ?? null;
}
