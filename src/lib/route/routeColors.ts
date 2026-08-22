/* Distinct colours for the drawn routes, by position in the route list. Index 0
 * keeps the original single-route magenta so one route looks unchanged from before
 * multi-route support. */

import { orderedTrips } from '$lib/aircraft/trips';

export const ROUTE_COLORS = ['#c2185b', '#1565c0', '#2e7d32', '#e65100', '#6a1b9a', '#00838f'];

/** Colour for the route at list position `i` (wraps when there are more routes
 *  than hues; tolerates negatives). */
export function routeColor(i: number): string {
	const n = ROUTE_COLORS.length;
	return ROUTE_COLORS[((i % n) + n) % n];
}

/** Route id -> display colour. Trips take sequential palette hues by trip index;
 *  an alternate shares its parent trip's hue, so a trip and its diversion read as
 *  one colour (solid vs dashed on the map). Orphan alternates fall back to their
 *  own list-position hue. With no alternates this is identical to `routeColor(i)`
 *  per route, so ordinary routes keep their colours. */
export function routeColorMap(
	list: readonly { id: string; alternate?: boolean | undefined }[],
): Map<string, string> {
	const colors = new Map<string, string>();
	for (const t of orderedTrips(list)) {
		const c = routeColor(t.index);
		colors.set(t.route.id, c);
		if (t.alternate) {
			colors.set(t.alternate.id, c);
		}
	}
	list.forEach((r, i) => {
		if (!colors.has(r.id)) {
			colors.set(r.id, routeColor(i));
		}
	});
	return colors;
}
