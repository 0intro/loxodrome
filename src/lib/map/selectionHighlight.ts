/* selectionHighlight.ts: one switch for the "Selection and hover always
 * highlight" invariant. syncSelectionHighlight(detail) fans the current
 * detail-panel selection out to every per-feature highlight setter (each of
 * which draws its feature even with its layer off and no-ops on an
 * unchanged value), replacing the per-kind one-line effects MapView carried;
 * hoverFeature / clearHover are the panels' transient hover pair, where
 * clearHover re-applies the selection so leaving a hovered row always
 * restores the panel's own highlight (the restoreHighlight copies each list
 * hand-wrote).
 *
 * The airspace case is deliberately a DOUBLE call: the base-polygon
 * highlight (highlightAirspace, which also draws the hidden-layer clone)
 * and the activation-hatch widening (highlightActivation) act together, so
 * a NOTAM-activated airspace reads as selected even when only its stripe
 * overlay is on screen.
 *
 * A HOVER additionally applies the pin rule (anchoringWaypointId): an airport
 * or navaid that a waypoint of the active route is anchored to is covered
 * whole by that pin, so the pin carries the flash instead of the symbol
 * nobody can see. Selection does not, ui.detail's own panel being the lasting
 * answer there. */

import { highlightAirport } from './airportLayer';
import { highlightAirspace, highlightAirspaces } from './airspaceLayer';
import { highlightActivation } from './activationLayer';
import { highlightNature } from './natureLayer';
import { highlightNavaid } from './navaidLayer';
import { highlightNotam } from './notamLayer';
import { highlightObstacle } from './obstacleLayer';
import { highlightSupActivation } from './supaipActivationLayer';
import { highlightWaypoint } from './routeLayer';
import { activeRoute } from '$lib/state/route.svelte';
import { supZoneKey } from '$lib/state/supaipLinks.svelte';
import { ui, type DetailTarget } from '$lib/state/ui.svelte';

/** Apply the selection highlight for `detail` to every feature layer (and
 *  clear the others'). Every setter no-ops on an unchanged value, so calling
 *  the whole fan on any selection change costs nothing extra. */
export function syncSelectionHighlight(detail: DetailTarget | null): void {
	// Highlight the selected airspace's outline and, when it is activated
	// by a NOTAM, widen its stripe overlay (see the header).
	const airspaceKey = detail?.kind === 'airspace' ? detail.key : null;
	highlightAirspace(airspaceKey);
	highlightActivation(airspaceKey);
	highlightNotam(detail?.kind === 'notam' ? detail.index : null);
	highlightAirport(detail?.kind === 'airport' ? detail.id : null);
	highlightObstacle(detail?.kind === 'obstacle' ? detail.id : null);
	highlightNavaid(detail?.kind === 'navaid' ? detail.id : null);
	highlightNature(detail?.kind === 'nature' ? detail.id : null);
	// A whole-supplement selection (no zone) has no single hatch to widen,
	// so it clears.
	highlightSupActivation(
		detail?.kind === 'supaip' && detail.zone !== undefined
			? supZoneKey(detail.id, detail.zone)
			: null,
	);
	// A route waypoint is never a DetailTarget: the route keeps its own
	// selection (selectedWaypointId, the pin's amber ring) outside ui.detail.
	// So the waypoint pin is the one hover with no selection to fall back to,
	// and leaving a hovered row always drops it.
	highlightWaypoint(null);
}

/** The kinds a panel row can flash on hover. The supaip / sigmet hovers are
 *  different mechanisms (transient geometry overlays, not the per-feature
 *  highlight setters) and keep their own pair. 'waypoint' is route furniture
 *  rather than a dataset feature, and is here because a waypoint list must
 *  flash the PIN: an anchored waypoint sits exactly on its aerodrome / navaid
 *  symbol and the pin is drawn far above it, so highlighting the feature there
 *  is invisible (see highlightWaypoint in map/routeLayer.ts). */
export type HoverKind = 'airport' | 'airspace' | 'navaid' | 'obstacle' | 'nature' | 'waypoint';

/** The active route's waypoint anchored to this feature, if any. Such a pin is
 *  CONCENTRIC with the feature symbol (routeIcons' centred anchor) and drawn
 *  255 pane-points above it, same size or bigger, so highlighting the symbol
 *  there is invisible by construction; the pin is the only mark that can carry
 *  the flash. Markers exist only for the ACTIVE route, so no other route
 *  qualifies, and a merely NEARBY feature (a VOR on an aerodrome's field, up to
 *  ON_FIELD_VOR_RADIUS_NM away) is not anchored and keeps its own symbol. */
function anchoringWaypointId(kind: HoverKind, id: string): string | null {
	if (kind !== 'airport' && kind !== 'navaid') {
		return null;
	}
	// Airport refIds are upper-case ICAO and callers pass a raw ident; navaid
	// ids are opaque and compare exactly.
	const wanted = kind === 'airport' ? id.toUpperCase() : id;
	const wp = activeRoute().waypoints.find(
		(w) => w.kind === kind && w.refId != null && (kind === 'airport' ? w.refId.toUpperCase() : w.refId) === wanted,
	);
	return wp?.id ?? null;
}

export function hoverFeature(kind: 'notam', id: number): void;
export function hoverFeature(kind: HoverKind, id: string): void;
export function hoverFeature(kind: HoverKind | 'notam', id: string | number): void {
	if (kind === 'notam') {
		highlightNotam(id as number);
		return;
	}
	hoverFeatures(kind, [id as string]);
}

/** Hover a row that names SEVERAL features at once. Only airspaces can be
 *  plural today: one nav-log enroute frequency line merges every sector
 *  sharing that frequency. The other kinds take the first id, having no
 *  plural form. */
export function hoverFeatures(kind: HoverKind, ids: readonly string[]): void {
	const id = ids[0] ?? '';
	switch (kind) {
		case 'airport':
		case 'navaid': {
			// The pin rule: a routed feature is covered by its own waypoint pin.
			const wpId = anchoringWaypointId(kind, id);
			if (wpId) {
				highlightWaypoint(wpId);
			} else if (kind === 'airport') {
				highlightAirport(id);
			} else {
				highlightNavaid(id);
			}
			break;
		}
		case 'airspace':
			highlightAirspaces(ids);
			break;
		case 'obstacle':
			highlightObstacle(id);
			break;
		case 'nature':
			highlightNature(id);
			break;
		case 'waypoint':
			highlightWaypoint(id);
			break;
	}
}

/** Leaving a hovered row restores the highlight to the panel's current
 *  selection (or clears it): the whole selection fan re-applies, and every
 *  non-hovered kind no-ops on its unchanged value. */
export function clearHover(): void {
	syncSelectionHighlight(ui.detail);
}
