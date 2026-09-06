/* airportLayer.ts renders the OurAirports baseline (~80 k worldwide
 * rows) plus per-country AIXM enrichment from FR / UK / ES as ICAO
 * aerodrome chart symbols (airportSymbols.ts), in the same style as the
 * navaid symbols. Per-type zoom thresholds keep low zooms readable; a
 * cue ring is drawn around airports referenced by an active NOTAM.
 *
 * Architecture: one custom L.Layer with one shared canvas, painted
 * via direct Path2D draws. There are NO per-airport L.circleMarker
 * objects -- creating 80 k of them with click handlers triggered the
 * browser's "page unresponsive" warning on a cold toggle. Hit-tests
 * run against the rbush from MapView's onMapClick / onMapMouseMove
 * (airportHit) and onMapContextMenu (airportsAt).
 *
 * The shared skeleton (index, attach/detach reconcile, highlight-drawn-
 * last _draw, r-tree probes) lives in pointLayerFactory.ts; this module
 * keeps the airport config: the per-type zoom ladder, the groups flag,
 * the zoom <= 3 pane floor (which hides the highlight too, the
 * documented asymmetry), and the symbol painter. */

import type L from 'leaflet';
import type { Airport } from '$lib/data/airports';
import type { Publisher } from '$lib/state/layers.svelte';
import { airportSymbolSize, drawAirportSymbol } from './airportSymbols';
import { createPointLayer } from './pointLayerFactory';
import { drawCue } from './symbolBase';

// Each airport type renders only at this zoom level or above; keeps the map
// readable at low zoom without clustering.
const TYPE_MIN_ZOOM: Record<string, number> = {
	large_airport: 5,
	medium_airport: 6,
	small_airport: 8,
	heliport: 8,
	seaplane_base: 8,
	balloonport: 8,
	closed: 8,
};

const PANE = 'airports';
// Below Leaflet's default markerPane (z 600) so NOTAM markers stay on
// top; above the obstacles pane (z 380) so airport dots sit over
// nearby obstacles.
const PANE_Z = '400';

// Whether the user has an airport group enabled (driven by show/hideAirports).
// Distinct from "canvas attached", which is also true for a lone highlight.
let groupsVisible = false;

// Per-publisher visibility. AIXM-tagged airports (source non-null)
// disappear when their publisher is toggled off. OurAirports baseline
// airports (source = null) are always visible.
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

// Per-type visibility, keyed by the OurAirports `type`. Driven from the Layers
// tab's grouped airport checkboxes via setAirportType (the "Airports" group
// flips the three fixed-wing sizes together). Read at draw time, so toggling is
// just a redraw. Defaults mirror the Layers defaults: every kind on.
const typeVisible: Record<string, boolean> = {
	large_airport: true,
	medium_airport: true,
	small_airport: true,
	heliport: true,
	seaplane_base: true,
	balloonport: true,
	closed: true,
};

function airportVisible(a: Airport): boolean {
	return (
		(a.source == null || publisherVisible[a.source]) &&
		(typeVisible[a.type] ?? false)
	);
}

const inst = createPointLayer<Airport>({
	pane: PANE,
	paneZ: PANE_Z,
	canvasClass: 'leaflet-airport-canvas',
	keyOf: (a) => a.ident.toUpperCase(),
	posOf: (a) => ({ lat: a.lat, lon: a.lon }),
	// Bulk draw only when the user has an airport group enabled; a lone
	// highlight (selection / hover with airports off) skips the bulk loop
	// and draws just the selected symbol.
	bulkVisible: () => groupsVisible,
	drawnAt: (a, zoom) => {
		const minZ = TYPE_MIN_ZOOM[a.type];
		return minZ != null && zoom >= minZ && airportVisible(a);
	},
	anyVisible: () => groupsVisible,
	drawSymbol: (ctx, a, x, y, o) => {
		const size = airportSymbolSize() + (o.highlight ? 3 : 0);
		drawAirportSymbol(ctx, a, x, y, size);
		if (o.cued) {
			drawCue(ctx, x, y, size);
		}
	},
	// Match the historic "hide whole pane below zoom 3" behaviour. The pane
	// is also display:none at this zoom, so a selection can't show below
	// zoom 3 either (accepted floor; airports are on by default).
	zoomFloorHidesHighlight: 3,
	interactZoomOk: (zoom) => zoom > 3,
	interactRequiresLayer: true,
	// 14 px covers the glyph (uniform half-extent 7 + click tolerance 6,
	// rounded up).
	hitWindowPx: 14,
	// Symbol half-extent + 6 px tolerance.
	hitRadiusPx: () => airportSymbolSize() + 6,
	sortGather: true,
	onClear: () => {
		groupsVisible = false;
	},
	onAttach: (m) => updateAirportPane(m),
});

function build(map: L.Map, airports: Airport[]): void {
	// Skip types without a zoom threshold (unknown types), as the
	// pre-factory index did.
	inst.build(map, airports.filter((a) => !!TYPE_MIN_ZOOM[a.type]));
}

/** Show the airport overlay, building it from the data on first call. */
export function showAirports(map: L.Map, airports: Airport[]): void {
	if (!inst.built()) {
		build(map, airports);
	}
	groupsVisible = true;
	inst.sync();
}

export function hideAirports(): void {
	// Keep the canvas attached when a selection / hover highlight is active so
	// the lone highlighted airport stays visible; otherwise detach. No-op when
	// the layer hasn't been built yet (the factory sync guards on the layer).
	groupsVisible = false;
	inst.sync();
}

/** Detach the airport layer; showAirports must rebuild (HMR teardown).
 *  Mirrors clearNavaids / clearObstacles / clearNatures: without it a
 *  MapView remount left the captured map pointing at the removed one, and
 *  the next sync re-attached the canvas to that dead map and crashed in
 *  containerPointToLayerPoint. */
export function clearAirports(map: L.Map): void {
	inst.clear(map);
}

/** Trigger a redraw on zoom changes. The canvas itself draws only
 *  features that pass the per-type zoom threshold, so this is just a
 *  redraw call -- no per-type LayerGroup reconcile. */
export function refreshAirportZoom(_map: L.Map): void {
	inst.redraw();
}

/** Hide the whole airport pane at very low zoom. The redraw also
 *  short-circuits below zoom 3, but hiding the pane skips the
 *  canvas paint entirely. */
export function updateAirportPane(map: L.Map): void {
	const pane = map.getPane(PANE);
	if (pane) {
		pane.style.display = map.getZoom() <= 3 ? 'none' : '';
	}
}

/** Show or hide every airport from a single publisher. Publisher flag
 *  is read at draw time, so this is just a redraw. */
export function setAirportPublisher(publisher: Publisher, visible: boolean): void {
	publisherVisible[publisher] = visible;
	inst.redraw();
}

/** Show or hide every airport of one OurAirports type. Read at draw time, so
 *  this is just a flag set + redraw. The Layers tab's grouped "Airports"
 *  checkbox calls this for large/medium/small together. */
export function setAirportType(type: string, visible: boolean): void {
	typeVisible[type] = visible;
	inst.redraw();
}

/** Highlight the selected airport, or clear with null. */
export function highlightAirport(ident: string | null): void {
	inst.highlight(ident ? ident.toUpperCase() : null);
}

/** Update which airports show the "has NOTAMs" cue ring. With direct
 *  canvas drawing this is just a Set diff + redraw -- no per-airport
 *  marker creation. */
export function setAirportCues(idents: Set<string>): void {
	inst.setCues(idents);
}

/** Pixel-distance hit-test for left-click: returns the airport whose
 *  dot is under the cursor, or null. Honours the same zoom + publisher
 *  filters the draw loop honours. Used by MapView's onMapClick now
 *  that there are no per-airport marker click handlers. */
export function airportHit(map: L.Map, lat: number, lon: number): Airport | null {
	return inst.hit(map, lat, lon);
}

/** Every visible airport within `radiusM` of (lat, lon), nearest first.
 *  Honours the same gates the rendered dots honour:
 *
 *   - the airports layer must be on the map (the user's toggle is on);
 *   - the global low-zoom pane hide (zoom > 3);
 *   - the per-type zoom thresholds in TYPE_MIN_ZOOM.
 *
 *  Used by MapView's right-click handler so an airport sitting under a
 *  NOTAM marker (very common for aerodrome NOTAMs) is still reachable
 *  via the context-menu stack. */
export function airportsAt(
	map: L.Map,
	lat: number,
	lon: number,
	radiusM = 500,
): Airport[] {
	return inst.at(map, lat, lon, radiusM);
}

/** Build the airport spatial index (and the canvas-layer object) WITHOUT
 *  showing it. Route snapping needs the rbush even when the airport layer is
 *  toggled off. Idempotent; a later showAirports just attaches the canvas. */
export function ensureAirportIndex(map: L.Map, airports: Airport[]): void {
	if (!inst.built()) {
		build(map, airports);
	}
}

/** Nearest airport within `radiusM` of (lat, lon), IGNORING the visibility /
 *  zoom / publisher gates airportsAt honours. For route waypoint snapping,
 *  which must snap even with airports toggled off (mirrors the unconditional
 *  highlight draw). Returns null when none in range or the index isn't built. */
export function nearestAirportUngated(
	lat: number,
	lon: number,
	radiusM: number,
): { airport: Airport; distM: number } | null {
	const r = inst.nearestUngated(lat, lon, radiusM);
	return r ? { airport: r.item, distM: r.distM } : null;
}
