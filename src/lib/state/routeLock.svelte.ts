/* routeLock.svelte.ts: the route locked on the map in flight. While a
 * recording runs, this app's definition of being in flight
 * (docs/nav-live.md), a pan that started on a pin moved the waypoint, follow
 * went on panning the map under the drag, and the move re-folded the live
 * log, the band, the contact chain and the alerts' softening and was filed
 * with the flight. SkyDemon, Air Navigation Pro and EasyVFR all lock the
 * route in flight, and so does this one, under a preference on by default
 * (Settings > Interface, display.lockRouteInFlight): the pins and the legs
 * take no drag on the map (map/routeLayer.ts setRouteLock), a press there is
 * the map's pan, and a long press opens the menu at once.
 *
 * The escape is worded: the menu's "Move waypoint" arms ONE pin for ONE drag
 * (`moveId`), lifted, and the drop, a press anywhere else or Escape locks it
 * again. The lock covers the map's direct manipulation only: every worded
 * action (the menu's rows, the Delete key, the Route tab) stays, each offered
 * back by the undo chip. Memory only: the lock is a rule, the arm a gesture. */

import { display } from './display.svelte';
import { nav } from './navRecording.svelte';

export const routeLock = $state<{ moveId: string | null }>({ moveId: null });

/** The route takes no drag on the map now. */
export function routeLocked(): boolean {
	return nav.recording && display.lockRouteInFlight;
}

/** Free one waypoint's pin for one drag (the menu's Move waypoint). */
export function armWaypointMove(id: string): void {
	routeLock.moveId = id;
}

/** The armed drag is over, or no longer wanted. */
export function endWaypointMove(): void {
	routeLock.moveId = null;
}
