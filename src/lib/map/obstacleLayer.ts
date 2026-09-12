/* obstacleLayer.ts renders the FR + UK + ES AIXM obstacle datasets
 * (~200 k features combined) with the Legende2026 obstacle symbology
 * (obstacleSymbols.ts: caret / high tower / wind turbine / ground-light
 * star + lit ray marks + the italic CABLE word beside cable obstacles,
 * all in the legend's single obstacle ink). Two
 * visibility channels so the Layers-tab can hide wind turbines (the noisy
 * ~70 % majority) separately from the longer-tail pylons / chimneys
 * / masts / lighthouses / etc.; a per-publisher channel hides whole
 * countries.
 *
 * Architecture: one custom L.Layer with one shared canvas; each redraw
 * queries the r-tree for obstacles within the current viewport and draws
 * them in a single pass. There are NO per-obstacle L.circleMarker
 * objects -- materialising one per row cost 200 k JS allocations and
 * ~40 MB of resident memory on a dataset that's static post-load.
 * Hit-tests run against the same r-tree from MapView's onMapClick /
 * onMapMouseMove (obstacleHit / obstaclesAt).
 *
 * Below MIN_ZOOM the layer simply skips drawing; lower zooms paint
 * an empty canvas regardless of the toggle state. The shared skeleton
 * lives in pointLayerFactory.ts; this module keeps the two group flags,
 * the CABLE label ladder and the painter. */

import type L from 'leaflet';
import type { Obstacle } from '$lib/data/obstacles';
import { obstacleGroup } from '$lib/data/obstacles';
import { drawCableMark, drawObstacleSymbol, obstacleSymbolSize } from './obstacleSymbols';
import type { ObstacleGroup, Publisher } from '$lib/state/layers.svelte';
import { createPointLayer } from './pointLayerFactory';
import { drawCue } from './symbolBase';

const PANE = 'obstacles';
// Pane z-index 380 sits between airspaces (350) and airports (400) so
// obstacles can't shadow airport markers but stay above airspace fills.
const PANE_Z = '380';
// Below this zoom the layer hides entirely; ~200 k dots in a continental
// view would melt the canvas without contributing useful information.
const MIN_ZOOM = 9;
// The italic CABLE word beside cable obstacles (Legende2026) gates one
// step above the layer's own gate, the same laddering as the airspace
// glyphs (z8) vs their designator labels (z9); the selection highlight
// bypasses it like every other gate.
const CABLE_LABEL_MIN_ZOOM = 10;

// The drawn half-extent of every obstacle glyph (the selection highlight
// enlarges it like the airport / navaid layers do).
const SYMBOL_PX = obstacleSymbolSize();

// What's CURRENTLY visible per group, set by setObstacleGroupVisible.
const visibility: Record<ObstacleGroup, boolean> = {
	windturbines: false,
	other: false,
};
// Per-publisher visibility. Nine publishers ship obstacles today (FR /
// UK / ES / BE / DE / AT / FAA / CH / FI); the rest carry an entry so
// the record stays exhaustive over Publisher, which is what makes a
// newly added publisher a compile error here rather than a silently
// unfilterable overlay.
const publisherVisible: Record<Publisher, boolean> = {
	fr: true,
	uk: true,
	es: true,
	be: true,
	de: true,
	at: true,
	pruatlas: true,
	faa: true,
	sk: true,
	ie: true,
	rs: true,
	xk: true,
	ge: true,
	nl: true,
	ch: true,
	fi: true,
	it: true,
};

const inst = createPointLayer<Obstacle>({
	pane: PANE,
	paneZ: PANE_Z,
	canvasClass: 'leaflet-obstacle-canvas',
	keyOf: (o) => o.id,
	posOf: (o) => ({ lat: o.lat, lon: o.lon }),
	// Bulk draw only above MIN_ZOOM; the retina scale happens first in the
	// factory, so a selected/hovered obstacle can still be highlighted when
	// zoomed out past the bulk-draw threshold.
	bulkVisible: (zoom) => zoom >= MIN_ZOOM,
	drawnAt: (o) => visibility[obstacleGroup(o.type)] && publisherVisible[o.source],
	anyVisible: () => visibility.windturbines || visibility.other,
	drawSymbol: (ctx, ob, x, y, o) => {
		const size = SYMBOL_PX + (o.highlight ? 3 : 0);
		drawObstacleSymbol(ctx, ob, x, y, size);
		// Transporter cables / captive balloons carry the chart's italic
		// CABLE word beside the symbol (Legende2026). The highlight bypasses
		// the zoom gate like every other gate: the mark identifies the
		// selected obstacle.
		if (ob.type === 'cable' && (o.highlight || o.zoom >= CABLE_LABEL_MIN_ZOOM)) {
			drawCableMark(ctx, x, y, size);
		}
		if (o.cued) {
			drawCue(ctx, x, y, size);
		}
	},
	interactZoomOk: (zoom) => zoom >= MIN_ZOOM,
	// The r-tree window covers the maximum hit zone (lit dot radius 5 +
	// canvas tolerance 6 = 11 px) in lat/lon space.
	hitWindowPx: 11,
	// Glyph half-extent + 4 px tolerance (the same effective click target
	// as the old dots).
	hitRadiusPx: () => SYMBOL_PX + 4,
	onClear: () => {
		visibility.windturbines = false;
		visibility.other = false;
	},
});

/** Build the obstacle layer once from the loaded dataset. Idempotent;
 *  subsequent calls (e.g. on toggle flip) are no-ops. */
export function buildObstacleLayer(map: L.Map, obstacles: Obstacle[]): void {
	inst.build(map, obstacles);
	// Layer is added to the map by setObstacleGroupVisible below; that
	// in turn fires moveend on add and triggers the first paint.
}

/** Toggle a single category. Below the MIN_ZOOM gate the layer paints
 *  nothing regardless of the flag. */
export function setObstacleGroupVisible(
	map: L.Map,
	group: ObstacleGroup,
	visible: boolean,
): void {
	visibility[group] = visible;
	inst.sync(map);
}

/** Show or hide every obstacle from a single publisher. With direct
 *  canvas drawing the toggle is a simple flag read at draw time -- no
 *  marker-by-marker reconcile loop. */
export function setObstaclePublisher(
	map: L.Map,
	publisher: Publisher,
	visible: boolean,
): void {
	void map;
	publisherVisible[publisher] = visible;
	inst.redraw();
}

/** Reconcile the canvas layer's presence on the map and trigger a
 *  redraw. Called on zoom changes and after buildObstacleLayer. */
export function updateObstaclePane(map: L.Map): void {
	inst.sync(map);
}

/** Detach the obstacle layer from the map; the buildObstacleLayer caller
 *  must rebuild from scratch (used on map teardown for HMR). */
export function clearObstacles(map: L.Map): void {
	inst.clear(map);
}

/** Sync the set of "has active NOTAM" cue rings to the given obstacle
 *  ids. With direct canvas drawing this is just two Set mutations and
 *  a redraw -- no per-obstacle marker creation. */
export function setObstacleCues(ids: Set<string>): void {
	inst.setCues(ids);
}

/** Highlight the selected obstacle, or clear with null. */
export function highlightObstacle(id: string | null): void {
	inst.highlight(id);
}

/** Bounding-box hit-test: every obstacle within radiusM metres of
 *  (lat, lon). Used by the right-click context menu to include obstacles
 *  in the stack list under the cursor. */
export function obstaclesAt(
	map: L.Map,
	lat: number,
	lon: number,
	radiusM = 200,
): Obstacle[] {
	return inst.at(map, lat, lon, radiusM);
}

/** Pixel-distance hit-test for left-click: returns the obstacle whose
 *  dot is under the cursor, or null. Returns the closest match so dense
 *  clusters (e.g. wind farms) pick the obstacle the user aimed at, not
 *  the first by iteration order. */
export function obstacleHit(
	map: L.Map,
	lat: number,
	lon: number,
): Obstacle | null {
	return inst.hit(map, lat, lon);
}
