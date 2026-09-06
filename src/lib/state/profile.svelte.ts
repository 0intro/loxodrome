/* Which airspaces the vertical profiles plot. Applied at this single
 * chokepoint so every profile (AltitudeProfile, MapProfileModal) and the
 * right-click action agree:
 *   - aerial-activity zones (the 'activity' category) are always dropped:
 *     small, numerous recreational areas (paragliding / parachute / balloon /
 *     glider) that clutter the altitude stack;
 *   - the active altitude filter always applies (out-of-band airspaces are
 *     never plotted, matching the map);
 *   - the global all-vs-on-map toggle (display.profileAllAirspaces) then
 *     restricts to map-visible airspaces when it is off.
 * Reads of display / layers / filter here are tracked when these run inside a
 * component $derived. */

import type { Airspace } from '$lib/data/airspaces';
import { bandIntersects } from '$lib/vertical/limits';
import { layers } from './layers.svelte';
import { display } from './display.svelte';
import { activeAltitudeBand } from './filter.svelte';

/** True when the airspace's category and publisher are both enabled in the
 *  Layers menu, i.e. it is currently drawn on the map. */
export function airspaceShownOnMap(a: Airspace): boolean {
	return layers.airspace[a.category] && layers.publisher[a.source];
}

/** Does the airspace's vertical extent overlap the altitude band? Mirrors the
 *  map's filter (airspaceLayer's entryPassesAltitude): datum-aware and
 *  conservative, a missing side is unbounded. */
export function airspaceInBand(
	a: Airspace,
	band: { floor: number; ceiling: number },
): boolean {
	return bandIntersects(a.vLower, a.vUpper, band);
}

/** The airspaces a vertical profile should plot. Aerial-activity zones are
 *  always excluded (recreational clutter); the active altitude filter always
 *  applies; the global all-vs-on-map toggle additionally restricts to
 *  airspaces shown on the map when it is off. AltitudeProfile still re-adds
 *  the airspace a panel highlights, so viewing an activity zone's own detail
 *  keeps it on its profile. */
export function profileAirspaces(list: Airspace[]): Airspace[] {
	let out = list.filter((a) => a.category !== 'activity');
	const band = activeAltitudeBand();
	if (band) {
		out = out.filter((a) => airspaceInBand(a, band));
	}
	if (!display.profileAllAirspaces) {
		out = out.filter(airspaceShownOnMap);
	}
	return out;
}
