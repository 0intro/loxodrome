/* The name a free point nobody named shows: the position reading at the
 * point, the band's own ("NW Étampes", "4 NM NE LFOX", nav/positionRef.ts),
 * so the plan and the band say the same thing over that point (docs/search.md
 * "Waypoint names"). A placeholder, never saved in the plan file; the
 * exports write it as a snapshot. Until the data around the point loads it
 * reads its coordinates, then the name fills in. Registered behind
 * route/navlog.ts `waypointLabel` at the flight app's boot. */

import { formatPositionRef, positionRef, type RefIndex } from '$lib/nav/positionRef';
import { setAutoWaypointNamer } from '$lib/route/navlog';
import { refIndex } from './navPositionRef.svelte';

// One answer per point and index: a nav log reads every label on each
// recompute, and the index changes only when a dataset publishes.
let memo: { index: RefIndex; names: Map<string, string | null> } | null = null;

function nameAt(lat: number, lon: number): string | null {
	const index = refIndex();
	if (memo?.index !== index) {
		memo = { index, names: new Map() };
	}
	const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
	let name = memo.names.get(key);
	if (name === undefined) {
		const r = positionRef(index, lat, lon);
		name = r ? formatPositionRef(r) : null;
		memo.names.set(key, name);
	}
	return name;
}

/** Register the automatic names. Call once, at the flight app's boot. */
export function registerAutoWaypointNames(): void {
	setAutoWaypointNamer((wp) => nameAt(wp.lat, wp.lon));
}
