/* The map's follow re-arms by itself after a pan (docs/nav-ux-review.md
 * finding 7b): a pilot who drags the chart to look ahead should not have to
 * find the recentre control with the aircraft moving off screen. Only while
 * a recording runs, and only once the pan has ENDED for this long. Pure;
 * pinned by tests/followRearm.spec.ts. */

/** Seconds of stillness after a pan before follow re-arms: long enough to
 *  read what was panned to, short enough that the aircraft is still on the
 *  screen at 100 kt (25 NM of chart at a flying zoom). */
export const FOLLOW_REARM_MS = 15_000;

/** True once `nowMs` is FOLLOW_REARM_MS (or `ms`) past the pan's end. */
export function followRearmDue(panEndMs: number | null, nowMs: number, ms = FOLLOW_REARM_MS): boolean {
	return panEndMs != null && nowMs - panEndMs >= ms;
}
