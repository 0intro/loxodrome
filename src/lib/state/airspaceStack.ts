/* Every airspace containing a point, from the DATASET rather than the map.
 *
 * What the right-click "what is here?" menu lists. It is deliberately NOT
 * gated by the category or publisher toggles, the route-only filter or zoom:
 * those are display choices, and with every checkbox off the full stack over a
 * point is still one right-click away. Only the altitude filter, which is a
 * DATA filter, subsets it.
 *
 * Its own module because both maps ask it and neither should have to import
 * the other's hit-test to do so: map/interactions.ts reaches SIGMETs, METAR
 * stations and VAC panels, which the NOTAM Viewer has none of.
 *
 * One-shot per right-click, so the linear bbox-prefiltered scan is fine.
 */

import { airspacesOver, type Airspace } from '$lib/data/airspaces';
import { airspaceInBand } from './profile.svelte';
import { getAirspaces } from './data.svelte';
import { activeAltitudeBand } from './filter.svelte';

export function airspaceStackAt(lat: number, lon: number): Airspace[] {
	const all = getAirspaces();
	if (!all) {
		return [];
	}
	const stack = airspacesOver(all, lat, lon);
	const band = activeAltitudeBand();
	return band ? stack.filter((a) => airspaceInBand(a, band)) : stack;
}
