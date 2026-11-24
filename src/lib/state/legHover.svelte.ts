/* legHover.svelte.ts: the route LEG the user is pointing at, shared by the two
 * surfaces that draw one. Pointing at a leg row in the Route tab draws that
 * segment heavy on the map; resting the pointer on a segment of the map marks
 * its row in the panel and brings it into view. Both surfaces write this one
 * state and both read it back, which is why it is a module rather than the
 * component-local machine featureHover.svelte.ts gives the waypoint rows: there
 * the panel points at the map and nothing ever points back.
 *
 * A leg is identified by the waypoint it LEAVES, the per-leg model the whole app
 * uses (leg i flies at waypoints[i].alt, and WaypointRow draws leg i under
 * waypoint i), so the panel row and the map segment name it the same way.
 * Waypoint ids come from a monotonic counter and are never reused, so a hover
 * left behind by a row whose waypoint was deleted under the pointer can only
 * ever resolve to nothing: highlightLeg validates against the live route and
 * draws nothing, and no row matches. A row torn down with its waypoint alive
 * (the Route tab closed) lets go of its own hover (releasePanelLeg).
 * Session-only, never persisted. */

/** Which surface is pointing. Only a MAP-origin hover scrolls the panel's list:
 *  a row under the pointer is on screen by construction, and scrolling it would
 *  yank the list out from under the cursor. */
export type LegHoverSource = 'map' | 'panel';

export interface HoveredLeg {
	routeId: string;
	/** The waypoint the leg leaves. */
	fromId: string;
	source: LegHoverSource;
}

export const legHover = $state<{ leg: HoveredLeg | null }>({ leg: null });

/** Point at the leg leaving `fromId`. */
export function hoverLeg(routeId: string, fromId: string, source: LegHoverSource): void {
	const cur = legHover.leg;
	if (cur && cur.routeId === routeId && cur.fromId === fromId && cur.source === source) {
		return;
	}
	legHover.leg = { routeId, fromId, source };
}

/** Stop pointing at the leg leaving `fromId`; a no-op once the pointer has moved
 *  on to another leg. A clear NAMES its leg because the two surfaces interleave:
 *  tabbing into another row's altitude field points at that leg before the mouse
 *  leaves the row it was resting on, and an unnamed clear would then drop the
 *  newer hover. */
export function unhoverLeg(fromId: string): void {
	if (legHover.leg?.fromId === fromId) {
		legHover.leg = null;
	}
}

/** Let go of the PANEL's hover of the leg leaving `fromId`, as its Route-tab
 *  row is torn down: a row removed under a still pointer gets no mouseleave,
 *  and one removed with its altitude box focused gets no focusout in
 *  Firefox, while its waypoint lives on and the map would keep the leg
 *  heavy. The map pointing at that leg keeps it. Deferred a microtask: a
 *  teardown reads state as it stood before the flush removing the row, so a
 *  hover written in that flush would be judged on a stale reading. */
export function releasePanelLeg(fromId: string): void {
	queueMicrotask(() => {
		const cur = legHover.leg;
		if (cur && cur.fromId === fromId && cur.source === 'panel') {
			legHover.leg = null;
		}
	});
}
