/* pinDrag.svelte.ts: where a route pin being dragged will land, for the tip
 * MapView draws above it. routeLayer.ts writes it from the marker's drag
 * events (a plain .ts layer writing state, the way profilePointLayer.ts writes
 * the map profile's point) and clears it on the drop; MapView's template builds
 * the text from this datum rather than storing rendered lines, so a locale
 * switch mid-drag re-renders the tip. Memory only. */

import type { WaypointSnap } from './route.svelte';

export interface PinLanding {
	/** The landing in the map container's pixels: the pin's own centre, the
	 *  magnet applied. */
	x: number;
	y: number;
	lat: number;
	lon: number;
	/** What the drop will snap to, an aerodrome, a navaid or an existing
	 *  waypoint; null for a free point. */
	snap: WaypointSnap | null;
	/** The dragged waypoint's own name when it lands as a free point and keeps
	 *  it: moveWaypoint keeps a free point's label, while an anchored one drops
	 *  its anchor's name along with the anchor. */
	keptLabel?: string | undefined;
	/** Moved by a finger, which hides the pin and the ground round it: the tip
	 *  rides higher. */
	finger: boolean;
}

export const pinDrag = $state<{ landing: PinLanding | null }>({ landing: null });

/** A fresh object per move: one invalidation, and the tip's one read. */
export function setPinLanding(landing: PinLanding | null): void {
	pinDrag.landing = landing;
}
