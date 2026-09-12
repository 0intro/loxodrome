/* navaidLayer.ts renders the FR + UK + ES AIXM navaid datasets (~7.9 k
 * features combined) as ICAO Annex 4 chart symbols on a single shared
 * canvas, mirroring obstacleLayer.ts: one custom L.Layer, an r-tree for
 * viewport queries + hit-testing, and direct draws per redraw with NO
 * per-navaid L.marker objects.
 *
 * Three visibility channels feed the Layers tab: `navaids` (the radio
 * navaids: VOR / VOR-DME / VORTAC / DME / TACAN / NDB), `ils` (ILS /
 * ILS-DME / LOC), and `waypoints` (the ~86% RNAV designated-point
 * majority). A per-publisher channel hides whole countries. Each group
 * has its own minimum zoom: radio navaids are sparse and appear early;
 * waypoints are dense and only draw when zoomed well in.
 *
 * The symbol shapes live in navaidSymbols.ts; the shared layer skeleton
 * in pointLayerFactory.ts (this module keeps the group zoom ladder, the
 * visibility flags, the unserviceable set and the painter). */

import type L from 'leaflet';
import type { Navaid } from '$lib/data/navaids';
import { navaidGroup } from '$lib/data/navaids';
import type { NavaidGroup, Publisher } from '$lib/state/layers.svelte';
import { drawNavaidSymbol, navaidSymbolSize } from './navaidSymbols';
import { createPointLayer } from './pointLayerFactory';
import { drawCue } from './symbolBase';

const PANE = 'navaids';
// Pane z-index 390 sits between obstacles (380) and airports (400) so
// navaids stay above obstacle dots but below airport markers.
const PANE_Z = '390';

/** Per-group minimum zoom. Radio navaids are sparse (~1 k across Europe)
 *  so they appear early; ILS aids cluster around airports; waypoints are
 *  dense (~6.8 k) and only draw when zoomed well in. */
const MIN_ZOOM: Record<NavaidGroup, number> = {
	navaids: 6,
	ils: 8,
	waypoints: 9,
	reporting: 9,
};
// The lowest of the three; below it nothing draws and the search is skipped.
const MIN_ZOOM_ANY = 6;

// Navaids an active NOTAM marks unserviceable; drawn dimmed / greyed.
const unserviceableIds = new Set<string>();
// What's CURRENTLY visible per group, set by setNavaidGroupVisible.
const visibility: Record<NavaidGroup, boolean> = {
	navaids: false,
	ils: false,
	waypoints: false,
	reporting: false,
};
// Per-publisher visibility. Navaids come from FR / UK / ES; pruatlas and
// FAA contribute none, so their entries are present only for symmetry.
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

/** Is this navaid currently drawable: group toggle on, publisher on, and
 *  the map zoomed past the group's threshold. */
function navaidShown(n: Navaid, zoom: number): boolean {
	const group = navaidGroup(n.type);
	return (
		visibility[group] &&
		publisherVisible[n.source] &&
		zoom >= MIN_ZOOM[group]
	);
}

const inst = createPointLayer<Navaid>({
	pane: PANE,
	paneZ: PANE_Z,
	canvasClass: 'leaflet-navaid-canvas',
	keyOf: (n) => n.id,
	posOf: (n) => ({ lat: n.lat, lon: n.lon }),
	// Bulk draw only above the lowest group threshold; the retina scale
	// happens first in the factory, so a selected/hovered navaid can still
	// be highlighted when zoomed out past it.
	bulkVisible: (zoom) => zoom >= MIN_ZOOM_ANY,
	drawnAt: navaidShown,
	anyVisible: () =>
		visibility.navaids || visibility.ils || visibility.waypoints || visibility.reporting,
	drawSymbol: (ctx, n, x, y, o) => {
		const size = navaidSymbolSize(n.type) + (o.highlight ? 3 : 0);
		// Keep the dim when selected so a clicked unserviceable navaid
		// still reads as greyed; the +3 size + cue ring mark selection.
		drawNavaidSymbol(ctx, n.type, x, y, size, o.highlight, unserviceableIds.has(n.id));
		if (o.cued) {
			drawCue(ctx, x, y, size);
		}
	},
	interactZoomOk: (zoom) => zoom >= MIN_ZOOM_ANY,
	// Window covers the largest glyph (size 8 + 6 px tolerance) in lat/lon.
	hitWindowPx: 14,
	hitRadiusPx: (n) => navaidSymbolSize(n.type) + 6,
	onClear: () => {
		unserviceableIds.clear();
		visibility.navaids = false;
		visibility.ils = false;
		visibility.waypoints = false;
		visibility.reporting = false;
	},
});

/** Build the navaid layer once from the loaded dataset. Idempotent. */
export function buildNavaidLayer(map: L.Map, navaids: Navaid[]): void {
	inst.build(map, navaids);
	// Added to the map by setNavaidGroupVisible below; that fires moveend
	// on add and triggers the first paint.
}

/** Toggle a single group. Below the group's MIN_ZOOM nothing draws. */
export function setNavaidGroupVisible(
	map: L.Map,
	group: NavaidGroup,
	visible: boolean,
): void {
	visibility[group] = visible;
	inst.sync(map);
}

/** Show or hide every navaid from a single publisher. */
export function setNavaidPublisher(
	map: L.Map,
	publisher: Publisher,
	visible: boolean,
): void {
	void map;
	publisherVisible[publisher] = visible;
	inst.redraw();
}

/** Reconcile the canvas layer's presence on the map and redraw. */
export function updateNavaidPane(map: L.Map): void {
	inst.sync(map);
}

/** Detach the navaid layer; buildNavaidLayer must rebuild (HMR teardown). */
export function clearNavaids(map: L.Map): void {
	inst.clear(map);
}

/** Sync the "has active NOTAM" cue rings to the given navaid ids. */
export function setNavaidCues(ids: Set<string>): void {
	inst.setCues(ids);
}

/** Sync the set of navaids drawn dimmed / greyed (unserviceable). */
export function setUnserviceableNavaids(ids: Set<string>): void {
	unserviceableIds.clear();
	for (const id of ids) {
		unserviceableIds.add(id);
	}
	inst.redraw();
}

/** Highlight the selected navaid, or clear with null. */
export function highlightNavaid(id: string | null): void {
	inst.highlight(id);
}

/** Bounding-box hit-test: every navaid within radiusM metres of (lat, lon).
 *  Used by the right-click context menu. */
export function navaidsAt(
	map: L.Map,
	lat: number,
	lon: number,
	radiusM = 500,
): Navaid[] {
	return inst.at(map, lat, lon, radiusM);
}

/** Pixel-distance hit-test for left-click: returns the navaid whose symbol
 *  is under the cursor (nearest within tolerance), or null. */
export function navaidHit(
	map: L.Map,
	lat: number,
	lon: number,
): Navaid | null {
	return inst.hit(map, lat, lon);
}

/** Nearest navaid within `radiusM` of (lat, lon), IGNORING the group /
 *  publisher / zoom gates navaidsAt honours. For route waypoint snapping,
 *  which must snap even with the navaid layers off. Returns null when none in
 *  range or the index isn't built. */
export function nearestNavaidUngated(
	lat: number,
	lon: number,
	radiusM: number,
): { navaid: Navaid; distM: number } | null {
	const r = inst.nearestUngated(lat, lon, radiusM);
	return r ? { navaid: r.item, distM: r.distM } : null;
}
