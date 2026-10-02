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
 * overlay is on screen. The closed-sector clones need no third call: they
 * are keyed by the same row `key` as the hidden-layer clone, which already
 * draws the selection.
 *
 * A HOVER additionally applies the PIN RULE: an airport or navaid that a
 * waypoint of the active route is anchored to is covered whole by that pin
 * (concentric, and drawn 255 pane-points above the symbol), so the pin carries
 * the flash instead of the symbol nobody can see. Selection does not,
 * ui.detail's own panel being the lasting answer there.
 *
 * Which features are pinned is the ROUTE's answer, not this module's, so it
 * arrives through setWaypointPinner rather than an import: a map with no
 * routes drawn on it has no pins, and this module should not have to reach a
 * route layer to find that out. Unregistered, the rule simply does not apply
 * and every feature carries its own flash. */

import { highlightAirport } from './airportLayer';
import { highlightAirspace, highlightAirspaces } from './airspaceLayer';
import { highlightActivation } from './activationLayer';
import { highlightNature } from './natureLayer';
import { highlightNavaid } from './navaidLayer';
import { highlightNotam } from './notamLayer';
import { highlightObstacle } from './obstacleLayer';
import { highlightSupActivation } from './supaipActivationLayer';
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
	pinner?.highlight(null);
}

/** The kinds a panel row can flash on hover. The supaip / sigmet hovers are
 *  different mechanisms (transient geometry overlays, not the per-feature
 *  highlight setters) and keep their own pair. 'waypoint' is route furniture
 *  rather than a dataset feature, and is here because a waypoint list must
 *  flash the PIN: an anchored waypoint sits exactly on its aerodrome / navaid
 *  symbol and the pin is drawn far above it, so highlighting the feature there
 *  is invisible (see highlightWaypoint in map/routeLayer.ts). */
export type HoverKind = 'airport' | 'airspace' | 'navaid' | 'obstacle' | 'nature' | 'waypoint';

/** The two kinds a waypoint can be anchored to, and so the two the pin rule
 *  can apply to. */
export type PinKind = 'airport' | 'navaid';

/** How this module reaches the route's waypoint pins, when there are any. */
export interface WaypointPinner {
	/** The id of the pin covering this feature, or null when none does. A
	 *  merely NEARBY feature (a VOR on an aerodrome's field) is not anchored
	 *  and keeps its own symbol. */
	anchoring: (kind: PinKind, id: string) => string | null;
	/** Flash a pin by waypoint id, or clear the flash. */
	highlight: (id: string | null) => void;
}

let pinner: WaypointPinner | null = null;

/** Register the route's pins. A hook rather than an import, so this module
 *  never reads the route state (the setPaneCapHook pattern). Call once at
 *  boot; pass null to unregister. */
export function setWaypointPinner(p: WaypointPinner | null): void {
	pinner = p;
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
			const wpId = pinner?.anchoring(kind, id) ?? null;
			if (wpId) {
				pinner?.highlight(wpId);
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
			pinner?.highlight(id);
			break;
	}
}

/** Leaving a hovered row restores the highlight to the panel's current
 *  selection (or clears it): the whole selection fan re-applies, and every
 *  non-hovered kind no-ops on its unchanged value. */
export function clearHover(): void {
	syncSelectionHighlight(ui.detail);
}
