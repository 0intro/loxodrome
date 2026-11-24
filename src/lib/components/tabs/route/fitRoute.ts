/* Fit the map to the whole active route (or fly to a lone waypoint), clear
 * of the open detail panel and of the map's band and foot, as every fit is.
 * Shared by RouteTextField (called live as the route is typed, so it never
 * collapses the sidebar: you are still editing, and it does not fire on
 * map-click edits) and RouteTab's file load. */

import { mapState } from '$lib/state/map.svelte';
import { fitBoundsClear, flyToVisible } from '$lib/map/focus';
import { activeRoute } from '$lib/state/route.svelte';

export function fitRoute(): void {
	const m = mapState.map;
	if (!m) {
		return;
	}
	if (activeRoute().waypoints.length >= 2) {
		fitBoundsClear(
			m,
			activeRoute().waypoints.map((w) => [w.lat, w.lon] as [number, number]),
			40,
		);
	} else if (activeRoute().waypoints.length === 1) {
		const w = activeRoute().waypoints[0];
		flyToVisible({ lat: w.lat, lng: w.lon }, Math.max(m.getZoom() ?? 10, 10));
	}
}
