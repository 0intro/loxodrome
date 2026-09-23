/* The map's follow re-arms by itself after a pan (docs/nav-ux-review.md
 * finding 7b): a pilot who drags the chart to look ahead should not have to
 * find the recentre control with the aircraft moving off screen. Only while
 * a recording runs, and only once the pan has ENDED for this long.
 *
 * The interval alone lives here, since it is what MapView reads to arm the
 * behaviour (`setFollowAutoRearm`) and what docs/nav-live.md quotes. The
 * countdown itself is map state, so it is a timer restarted on every
 * `dragend` / `boxzoomend` in map/navLayer.ts rather than a clock compared
 * here; keeping a second expression of the same rule in a pure module only
 * gave it somewhere to drift. */

/** Seconds of stillness after a pan before follow re-arms: long enough to
 *  read what was panned to, short enough that the aircraft is still on the
 *  screen at 100 kt (25 NM of chart at a flying zoom). */
export const FOLLOW_REARM_MS = 15_000;
