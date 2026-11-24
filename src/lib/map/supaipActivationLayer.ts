/* Map overlay that hatches the SUP AIP zones active over the viewed time, on
 * a NOTAM, their own published period or the pilot's note
 * (state/supaip.svelte.ts supHatchZones), whatever the layer's toggle, the
 * SUP-AIP counterpart of activationLayer.ts. Sits on its
 * own SVG pane (so we can use an SVG <pattern> fill, which the canvas renderer
 * can't) at z 365: above the base SUP AIP overlay (360) and below the activated
 * AIRSPACE hatch (370), matching the existing supaip-below-airspace precedence.
 *
 * Reconciled from that set by renderSupActivations() through the shared
 * emphasis-clone reconcile (emphasisClones.ts): a hatch is added for a zone
 * newly active, removed for one no longer active, left alone otherwise.
 * The hatch is NON-interactive: clicks fall
 * through to the map and are picked up by supaipAt() on the base overlay, so
 * the manual hit-test precedence (airports / navaids / obstacles above a SUP
 * zone) is preserved. A single magenta stripe, since a temporary zone has no
 * per-category colour the way airspaces do. */

import type L from 'leaflet';
import type { SupAipZone } from '$lib/data/supaip';
import { createCloneLayer } from './emphasisClones';
import { makeSupZoneLayer } from './supaipLayer';

const PANE = 'supaip-activated';
const PANE_Z = '365';

interface ActivatedZone {
	key: string;
	zone: SupAipZone;
}

// Keyed by supZoneKey for O(1) reconciliation; that same key is what
// highlightSupActivation widens by, so a selected zone's hatch can be found.
const clones = createCloneLayer<ActivatedZone>({
	pane: PANE,
	paneZ: PANE_Z,
	keyOf: (it) => it.key,
	// makeSupZoneLayer handles polygon / multipolygon / circle and a
	// zone's holes; the factory hands the assembled pane + renderer + style
	// options through. The reconcile filters geometry-less zones, so the
	// assertion holds.
	geometryOf: (it, opts) => makeSupZoneLayer(it.zone, opts)!,
	styleOf: () => ({
		// #c2185b mirrors the --supaip token (theme.css); canvas can't
		// read CSS variables.
		color: '#c2185b',
		weight: 2,
		fillOpacity: 1, // the pattern carries its own opacity via the stripe colour
	}),
	// Leaflet's SVG renderer paints fill via the path element's fill
	// attribute; override it to point at the inline <pattern> HatchDefs
	// defines. Runs after addTo so getElement() returns the real path;
	// Leaflet doesn't rewrite fill on pan/zoom (only `d`).
	onAttach: (_it, layer) => {
		((layer as L.Path).getElement() as SVGElement | null)?.setAttribute('fill', 'url(#hatch-supaip)');
	},
});

/** Reconcile the overlay: a hatch for each zone key in `active`.
 *  `zonesByKey` resolves a key to its geometry. */
export function renderSupActivations(
	map: L.Map,
	active: ReadonlySet<string>,
	zonesByKey: ReadonlyMap<string, SupAipZone>,
): void {
	const items: ActivatedZone[] = [];
	for (const key of active) {
		const zone = zonesByKey.get(key);
		if (zone?.geometry) {
			items.push({ key, zone });
		}
	}
	clones.sync(map, items);
}

/** Drop every hatch. Called when the map is torn down. */
export function clearSupActivations(map: L.Map): void {
	clones.clear(map);
}

/** Bold the activated zone whose key matches the selected one, restoring the
 *  previously highlighted hatch. Widening the stroke (2 -> 3) is the selected
 *  signal; this is what makes a NOTAM-activated SUP zone read as selected even
 *  with the SUP layer toggled off (only the stripe overlay is on screen, not
 *  the base zone). No-op when the selected zone isn't activated. */
export function highlightSupActivation(key: string | null): void {
	clones.setEmphasis(key);
}
