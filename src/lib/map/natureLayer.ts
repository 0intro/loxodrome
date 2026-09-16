/* natureLayer.ts renders the French "zones naturelles" (PRN parcs / réserves)
 * and sensitive-site overflight zones (SUR) as the AIP "site with special
 * marking of prohibited low overflying" bullseye on a shared canvas, mirroring
 * navaidLayer.ts: one custom L.Layer + an r-tree for viewport queries and
 * hit-testing, direct draws per redraw, no per-feature marker objects. The SIA
 * export gives only a point for most of these zones, so each is a single symbol
 * carrying its minimum overflight altitude (shown in the detail panel). One
 * Layers-tab toggle controls the whole overlay. The glyph lives in
 * natureSymbols.ts; the shared layer skeleton in pointLayerFactory.ts (no
 * cue rings and no publisher channel here, so the config skips both). */

import type L from 'leaflet';
import type { Nature, NatureType } from '$lib/data/nature';
import { drawNatureSymbol, natureSymbolSize } from './natureSymbols';
import { createPointLayer } from './pointLayerFactory';
import { GATE_GLYPH } from './airspaceSymbology';

const PANE = 'nature';
// Pane z-index 395 sits between navaids (390) and airports (400): nature
// symbols stay above navaids but below airport markers.
const PANE_Z = '395';
// The bullseye glyphs come in with the SIA activity pictograms (natureLayer
// covers the SUR / PRN activity rows, so the two must appear together); below
// this nothing draws and the search / hit-test is skipped.
const MIN_ZOOM = GATE_GLYPH;

// Per-category visibility (each a Layers-tab toggle).
const visibility: Record<NatureType, boolean> = { NATURE: false, SENSITIVE: false, BIRD: false };

const inst = createPointLayer<Nature>({
	pane: PANE,
	paneZ: PANE_Z,
	canvasClass: 'leaflet-nature-canvas',
	keyOf: (n) => n.id,
	posOf: (n) => ({ lat: n.lat, lon: n.lon }),
	bulkVisible: (zoom) => zoom >= MIN_ZOOM,
	drawnAt: (n) => visibility[n.type],
	anyVisible: () => visibility.NATURE || visibility.SENSITIVE || visibility.BIRD,
	drawSymbol: (ctx, n, x, y, o) => {
		drawNatureSymbol(ctx, n.type, x, y, natureSymbolSize() + (o.highlight ? 3 : 0), o.highlight);
	},
	interactZoomOk: (zoom) => zoom >= MIN_ZOOM,
	hitWindowPx: 14,
	hitRadiusPx: () => natureSymbolSize() + 6,
	onClear: () => {
		visibility.NATURE = false;
		visibility.SENSITIVE = false;
		visibility.BIRD = false;
	},
});

/** Build the nature layer once from the loaded dataset. Idempotent. */
export function buildNatureLayer(map: L.Map, natures: Nature[]): void {
	inst.build(map, natures);
	// Attached to the map by setNatureVisible / updateNaturePane.
}

/** Toggle one category (NATURE / SENSITIVE); below MIN_ZOOM nothing draws. */
export function setNatureVisible(map: L.Map, type: NatureType, v: boolean): void {
	visibility[type] = v;
	inst.sync(map);
}

/** Reconcile the canvas layer's presence on the map and redraw. */
export function updateNaturePane(map: L.Map): void {
	inst.sync(map);
}

/** Detach the layer; buildNatureLayer must rebuild (HMR teardown). */
export function clearNatures(map: L.Map): void {
	inst.clear(map);
}

/** Highlight the selected zone, or clear with null. */
export function highlightNature(id: string | null): void {
	inst.highlight(id);
}

/** Bounding-box hit-test: every zone within radiusM of (lat, lon). For the
 *  right-click context menu. */
export function naturesAt(map: L.Map, lat: number, lon: number, radiusM = 500): Nature[] {
	return inst.at(map, lat, lon, radiusM);
}

/** Pixel-distance hit-test for left-click: the zone whose symbol is under the
 *  cursor (nearest within tolerance), or null. */
export function natureHit(map: L.Map, lat: number, lon: number): Nature | null {
	return inst.hit(map, lat, lon);
}
