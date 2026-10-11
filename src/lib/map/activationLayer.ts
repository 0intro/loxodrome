/* Map overlay that hatches the special-use airspaces currently activated by
 * at least one loaded NOTAM. Sits between the airspaces canvas (z 350) and
 * the airports canvas (z 400) on its own SVG pane so we can use SVG <pattern>
 * fills for the diagonal hatching; the canvas renderer can't do that.
 *
 * The layer is reconciled from a Map<airspaceId, IndexedNotam[]> by
 * renderActivations(): polygons are added for airspaces that are newly
 * activated, removed for ones no longer activated, and left alone for ones
 * that haven't changed. The polygons are NON-INTERACTIVE, like every other
 * filled overlay: a fill that took its own click would shadow whatever it
 * covers whatever its size. Clicks fall through to the map and are resolved
 * by featureAt, where airspaceAt keeps an activated row hit-testable with its
 * category toggled off (isActivationDrawn) and the area tier ranks it by size
 * against everything else under the point (docs/map-hit-testing.md). That also
 * ends an old coin flip: which answer you got used to depend on whether the
 * pointer landed on a painted stripe or in the gap between two. */

import L from 'leaflet';
import { airspaceIdOfKey, type Airspace } from '$lib/data/airspaces';
import type { AirspaceCategory } from '$lib/state/layers.svelte';
import { isRtba, RTBA_DASH } from './airspaceSymbology';
import { setPathStrokeWidth } from './emphasisClones';
import { ACTIVATION_STROKE } from './palette';

/** Stroke colour per category (the palette's dark companion of the
 *  category ink): matches the underlying airspace's outline so the hatch
 *  reads as "this same airspace, just activated". Slightly bolder than
 *  the default 1.5 weight so the overlay reads as a distinct signal
 *  without competing with the selected-state's 3-weight highlight. The
 *  annotation is the compile-time completeness check. */
const STROKES: Record<AirspaceCategory, string> = ACTIVATION_STROKE;

const PANE = 'airspaces-activated';

let renderer: L.SVG | null = null;
// Keyed by airspace id, which is what `activated` is keyed by and what the
// hatch MEANS: activation is a property of the id, and several rows can share
// one (a MOA parent and its exclusion rings). The selected row's key is
// resolved back to its id before it is matched here, so any row of an
// activated airspace bolds its stripes.
const polyById = new Map<string, L.Polygon>();
let highlightedId: string | null = null;

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
	// Remove polygons whose airspace is no longer activated. highlightedId
	// is the REQUESTED highlight and deliberately survives the removal: a
	// still-selected zone whose window closes and reopens (the minute-tick
	// re-render) gets its bold hatch back in the add path below, since the
	// ui.detail highlight effect never re-fires on an unchanged selection.
	for (const [id, poly] of polyById) {
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
			interactive: false,
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
			if (id === highlightedId) {
				el.setAttribute('stroke-width', '3');
			}
		}
		polyById.set(id, poly);
	}
}

/** Is this airspace's activation hatch currently DRAWN?
 *
 *  airspaceLayer's hit-test keeps an activated airspace clickable even with
 *  its category toggled off, and this is the question it actually means: the
 *  exception exists because the user can SEE the stripes and expects to reach
 *  them. Answering from the drawn polygons rather than re-deriving the
 *  activation set is what keeps the hit-test off that derivation, which was
 *  re-scanning every filtered NOTAM (and re-parsing their text) on every
 *  pointer move. MapView already computes the set once per change and feeds
 *  it to renderActivations, so this is a read of work already done.
 *
 *  A predicate rather than the sibling layers' keys() set: the membership
 *  here is a Map keyed by the shared airspace id, so `has` is the whole
 *  answer and no set has to be built per call. */
export function isActivationDrawn(id: string): boolean {
	return polyById.has(id);
}

/** Drop every polygon. Called when the map is torn down. */
export function clearActivations(map: L.Map): void {
	for (const poly of polyById.values()) {
		map.removeLayer(poly);
	}
	polyById.clear();
	highlightedId = null;
}

/** Bold the hatch of the selected airspace, restoring the previously
 *  highlighted one. The hatch already uses the highlight stroke colour, so
 *  widening it (from the default weight 2 to 3) is the selected signal. This
 *  is what makes a NOTAM-activated airspace read as selected even when its
 *  category layer is toggled off: only the stripe overlay is on screen, not
 *  the base polygon highlightAirspace restyles. No-op when the selected
 *  airspace isn't activated.
 *
 *  Takes the selected ROW key and matches on the id behind it, because the
 *  hatch is drawn once per id from whichever row the id index kept, while a
 *  selection names one row: a MOA parent and its exclusion rings share an id,
 *  and matching the stored row's key left the stripes unbolded whenever the
 *  two disagreed. */
export function highlightActivation(key: string | null): void {
	const id = key == null ? null : airspaceIdOfKey(key);
	if (id === highlightedId) {
		return;
	}
	setActivationWeight(highlightedId, '2');
	highlightedId = id;
	setActivationWeight(id, '3')?.bringToFront();
}

// setActivationWeight sets the SVG stroke-width of the activated hatch with
// that id and returns its polygon (null when none is drawn). The poke itself
// is the shared setPathStrokeWidth (element attribute, never setStyle, so
// Leaflet's _updateStyle can't overwrite the <pattern> fill with a solid
// colour).
function setActivationWeight(id: string | null, weight: string): L.Polygon | null {
	const poly = id === null ? undefined : polyById.get(id);
	if (!poly) {
		return null;
	}
	setPathStrokeWidth(poly, weight);
	return poly;
}
