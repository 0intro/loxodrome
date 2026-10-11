/* The route's waypoint pins, handed to the shared selection highlight.
 *
 * map/selectionHighlight.ts owns the pin RULE (a hovered airport or navaid
 * that a waypoint sits on flashes the pin, which covers the symbol whole) but
 * not the answer to "is this one pinned", which is the route's. This module
 * is the answer, and it lives beside the layer that draws the pins rather than
 * in state/, because registering it means importing routeLayer and so Leaflet:
 * a state module that pulls Leaflet in cannot be read by a node-environment
 * spec, which is how this arrangement was found.
 *
 * Installed by MapView.svelte, the map that has pins to offer. A map without
 * routes never calls it, and the rule then simply does not apply.
 */

import { highlightWaypoint } from './routeLayer';
import { setWaypointPinner, type PinKind } from './selectionHighlight';
import { activeRoute } from '$lib/state/route.svelte';

/** The active route's waypoint anchored to this feature, if any. Markers exist
 *  only for the ACTIVE route, so no other route qualifies. Airport refIds are
 *  upper-case ICAO and callers pass a raw ident; navaid ids are opaque and
 *  compare exactly. */
function anchoringWaypointId(kind: PinKind, id: string): string | null {
	const wanted = kind === 'airport' ? id.toUpperCase() : id;
	const wp = activeRoute().waypoints.find(
		(w) =>
			w.kind === kind &&
			w.refId != null &&
			(kind === 'airport' ? w.refId.toUpperCase() : w.refId) === wanted,
	);
	return wp?.id ?? null;
}

/** Hand the pin rule its route. Idempotent; call once per map. */
export function installWaypointPins(): void {
	setWaypointPinner({ anchoring: anchoringWaypointId, highlight: highlightWaypoint });
}
