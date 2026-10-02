/* routeHit.ts: which pin or leg of the ACTIVE route a point on the map is
 * over, in pixels at the current view (Leaflet type-only, so the specs run
 * it in Node). The one definition behind the right-click menu's Remove and
 * Insert rows (map/interactions.ts contextFeaturesAt) and a leg dragged out
 * into a new waypoint (map/routeLayer.ts), so a leg the menu would insert
 * into is exactly a leg a drag can carry. Only the active route draws pins
 * and takes edits, so only its waypoints count. */

import type L from 'leaflet';
import { activeRoute, type Waypoint } from '$lib/state/route.svelte';

/** A pin is a 26 px disc: within this radius of its centre, a point is on
 *  it (a hair past the disc, so its edge counts). */
export const PIN_HIT_PX = 14;
/** How near a leg a press or a right-click must be to be on it. */
export const LEG_HIT_PX = 12;

/** Active-route waypoints whose pin sits under the point, nearest first. */
export function routeWaypointsAt(map: L.Map, lat: number, lon: number): Waypoint[] {
	const wps = activeRoute().waypoints;
	if (wps.length === 0) {
		return [];
	}
	const click = map.latLngToLayerPoint([lat, lon]);
	const hits: { wp: Waypoint; d2: number }[] = [];
	for (const wp of wps) {
		const p = map.latLngToLayerPoint([wp.lat, wp.lon]);
		const dx = p.x - click.x;
		const dy = p.y - click.y;
		const d2 = dx * dx + dy * dy;
		if (d2 <= PIN_HIT_PX * PIN_HIT_PX) {
			hits.push({ wp, d2 });
		}
	}
	hits.sort((a, b) => a.d2 - b.d2);
	return hits.map((h) => h.wp);
}

/** Squared pixel distance from (px,py) to segment (ax,ay)-(bx,by). */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
	const cx = ax + t * dx;
	const cy = ay + t * dy;
	return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/** Index of the active-route leg whose segment passes within `tolPx` of the
 *  point (nearest wins), as the insert-after position for
 *  insertWaypointAfter; null if none is close or the route has < 2
 *  waypoints. */
export function routeLegAt(map: L.Map, lat: number, lon: number, tolPx: number = LEG_HIT_PX): number | null {
	const wps = activeRoute().waypoints;
	if (wps.length < 2) {
		return null;
	}
	const click = map.latLngToLayerPoint([lat, lon]);
	let bestIdx = -1;
	let bestD2 = Infinity;
	for (let i = 0; i + 1 < wps.length; i++) {
		const a = map.latLngToLayerPoint([wps[i].lat, wps[i].lon]);
		const b = map.latLngToLayerPoint([wps[i + 1].lat, wps[i + 1].lon]);
		const d2 = segDist2(click.x, click.y, a.x, a.y, b.x, b.y);
		if (d2 < bestD2) {
			bestD2 = d2;
			bestIdx = i;
		}
	}
	return bestIdx >= 0 && bestD2 <= tolPx * tolPx ? bestIdx : null;
}

/** The leg a new waypoint would go into from this point: none on a pin (the
 *  pin's own actions win), else the nearest leg within `tolPx`. */
export function routeLegInsertAt(
	map: L.Map,
	lat: number,
	lon: number,
	tolPx: number = LEG_HIT_PX,
): number | null {
	return routeWaypointsAt(map, lat, lon).length > 0 ? null : routeLegAt(map, lat, lon, tolPx);
}
