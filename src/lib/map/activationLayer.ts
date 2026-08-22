/* Map overlay that hatches the special-use airspaces currently activated by
 * at least one loaded NOTAM. Sits between the airspaces canvas (z 350) and
 * the airports canvas (z 400) on its own SVG pane so we can use SVG <pattern>
 * fills for the diagonal hatching; the canvas renderer can't do that.
 *
 * The layer is reconciled from a Map<airspaceId, IndexedNotam[]> by
 * renderActivations(): polygons are added for airspaces that are newly
 * activated, removed for ones no longer activated, and left alone for ones
 * that haven't changed. Each polygon is interactive: a click on a striped
 * polygon selects the underlying airspace, with stopPropagation so the
 * map-level airspace hit-test doesn't also fire (which would otherwise
 * resolve to whatever airspace happens to sit deepest under the cursor).
 * Clicks that miss the painted stripe pixels naturally fall through to the
 * map and are picked up by airspaceAt() on the airspaces canvas underneath,
 * so the activated airspace is fully clickable everywhere inside its
 * boundary. */

import L from 'leaflet';
import type { Airspace } from '$lib/data/airspaces';
import type { AirspaceCategory } from '$lib/state/layers.svelte';
import { isRtba, RTBA_DASH } from './airspaceSymbology';
import { setPathStrokeWidth } from './emphasisClones';
import { ACTIVATION_STROKE } from './palette';
import { selectAirspace } from '$lib/state/ui.svelte';

/** Stroke colour per category (the palette's dark companion of the
 *  category ink): matches the underlying airspace's outline so the hatch
 *  reads as "this same airspace, just activated". Slightly bolder than
 *  the default 1.5 weight so the overlay reads as a distinct signal
 *  without competing with the selected-state's 3-weight highlight. The
 *  annotation is the compile-time completeness check. */
const STROKES: Record<AirspaceCategory, string> = ACTIVATION_STROKE;

const PANE = 'airspaces-activated';

let renderer: L.SVG | null = null;
// Keyed by airspace id (what `activated` is keyed by) for O(1) reconciliation;
// each entry also carries the row `key` the click handler selects by, so
// highlightActivation can find the hatch for the selected airspace.
const polyById = new Map<string, { poly: L.Polygon; key: string }>();
let highlightedKey: string | null = null;

function ensurePane(map: L.Map): void {
	if (!map.getPane(PANE)) {
		// 370 sits between airspaces (350) and airports (400); above the
		// underlying polygon but below airport markers / NOTAM features.
		map.createPane(PANE).style.zIndex = '370';
	}
	if (!renderer) {
		renderer = L.svg({ pane: PANE });
	}
}

/** Reconcile the activated-airspace overlay against the given Map. Polygons
 *  for airspaces in the map but not yet drawn are added; polygons for
 *  airspaces no longer activated are removed. */
export function renderActivations(
	map: L.Map,
	activated: ReadonlyMap<string, unknown>,
	airspaceById: Map<string, Airspace>,
): void {
	ensurePane(map);
	// Remove polygons whose airspace is no longer activated. highlightedKey
	// is the REQUESTED highlight and deliberately survives the removal: a
	// still-selected zone whose window closes and reopens (the minute-tick
	// re-render) gets its bold hatch back in the add path below, since the
	// ui.detail highlight effect never re-fires on an unchanged selection.
	for (const [id, { poly }] of polyById) {
		if (!activated.has(id)) {
			map.removeLayer(poly);
			polyById.delete(id);
		}
	}
	// Add polygons for airspaces that just became activated.
	for (const id of activated.keys()) {
		if (polyById.has(id)) {
			continue;
		}
		const airspace = airspaceById.get(id);
		if (!airspace || airspace.ring.length < 3) {
			continue;
		}
		const poly = L.polygon(airspace.ring, {
			pane: PANE,
			renderer: renderer ?? undefined,
			interactive: true,
			color: STROKES[airspace.category],
			weight: 2,
			fillOpacity: 1, // the pattern carries its own opacity via the stripe colour
			// The stroke echoes the zone's own line language, not just its
			// colour: an RTBA zone keeps its GEN 2.3 pecked dash while
			// activated (identity above state); every other activatable
			// zone's base line is solid, so solid stays faithful there.
			...(isRtba(airspace.id) ? { dashArray: RTBA_DASH.join(' ') } : {}),
		});
		poly.addTo(map);
		// Leaflet's SVG renderer paints fill via the path element's fill
		// attribute. Override it to point at the inline <pattern> defined in
		// MapView.svelte. Done after addTo so getElement() returns the real
		// SVG path; Leaflet doesn't rewrite fill on pan/zoom (only `d`).
		const el = poly.getElement() as SVGElement | null;
		if (el) {
			el.setAttribute('fill', `url(#hatch-${airspace.category})`);
			// Re-apply the selected bold on re-add (see the removal comment).
			if (airspace.key === highlightedKey) {
				el.setAttribute('stroke-width', '3');
			}
		}
		// Click selects the airspace the hatch represents. stopPropagation
		// prevents the map's airspaceAt() hit-test from also firing and
		// replacing the selection with whatever airspace lies under the
		// click (which, given the ordering by smallest area, might be a
		// different sub-airspace inside the activated one). We address the
		// row by its per-row `key`, not the shared NOTAM-matching `id`.
		const key = airspace.key;
		poly.on('click', (e: L.LeafletMouseEvent) => {
			L.DomEvent.stopPropagation(e);
			selectAirspace(key);
		});
		polyById.set(id, { poly, key });
	}
}

/** Drop every polygon. Called when the map is torn down. */
export function clearActivations(map: L.Map): void {
	for (const { poly } of polyById.values()) {
		map.removeLayer(poly);
	}
	polyById.clear();
	highlightedKey = null;
}

/** Bold the activated airspace whose row `key` matches the selected one,
 *  restoring the previously highlighted hatch. The hatch already uses the
 *  highlight stroke colour, so widening it (from the default weight 2 to 3)
 *  is the selected signal. This is what makes a NOTAM-activated airspace
 *  read as selected even when its category layer is toggled off: only the
 *  stripe overlay is on screen, not the base polygon highlightAirspace
 *  restyles. No-op when the selected airspace isn't activated. */
export function highlightActivation(key: string | null): void {
	if (key === highlightedKey) {
		return;
	}
	setActivationWeight(highlightedKey, '2');
	highlightedKey = key;
	setActivationWeight(key, '3')?.bringToFront();
}

// setActivationWeight sets the SVG stroke-width of the activated hatch whose
// row key matches and returns its polygon (null when none matches). The poke
// itself is the shared setPathStrokeWidth (element attribute, never setStyle,
// so Leaflet's _updateStyle can't overwrite the <pattern> fill with a solid
// colour); only the row-key-inside-id-keyed-slots lookup is this module's.
function setActivationWeight(key: string | null, weight: string): L.Polygon | null {
	if (key === null) {
		return null;
	}
	for (const { poly, key: k } of polyById.values()) {
		if (k === key) {
			setPathStrokeWidth(poly, weight);
			return poly;
		}
	}
	return null;
}
