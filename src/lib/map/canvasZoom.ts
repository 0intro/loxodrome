/* canvasZoom.ts: smooth zoom-animation support for the map's direct-draw
 * canvas overlays (airport / navaid / obstacle / prohibited / nature layers).
 *
 * Each of those layers paints one screen-space canvas: its upper-left is pinned
 * to the viewport corner and features are drawn at container points, repainted
 * only on moveend / zoomend. That is fine for a *pan*: Leaflet translates the
 * map pane and the canvas (a descendant of it) rides along. But a *zoom*
 * animation (flyTo, scroll-wheel, double-click, +/- buttons) is driven
 * per-frame through the `zoom` / `zoomanim` events with the map pane held
 * still while each layer transforms itself. A canvas that ignores those events
 * stays frozen at its last-drawn position and scale, so e.g. a centred airport
 * symbol stays glued to the screen centre while the basemap flies past
 * underneath, then snaps into place at the end.
 *
 * These helpers let such a layer transform its canvas during a zoom animation
 * the same way Leaflet's own vector renderer does (Renderer._updateTransform),
 * adapted to the container-point draw convention: scale by the zoom ratio and
 * translate by the pixel-origin delta, about the top-left. That last part needs
 * transform-origin 0 0, which the layers get by adding the `leaflet-zoom-animated`
 * class to their canvas; that class also carries Leaflet's transform transition,
 * so the single `zoomanim` target is eased while the per-frame flyTo `zoom`
 * updates (no transition active) track the curve directly.
 */

import L from 'leaflet';

/** The map view captured when the canvas was last painted: enough to re-place
 *  that painting under any animating (center, zoom). */
export interface CanvasDrawState {
	/** map zoom at draw time. */
	zoom: number;
	/** map pixel origin at draw time. Fixed at view reset and PAN-INVARIANT
	 *  (Leaflet's pan deltas cancel inside _getNewPixelOrigin); the viewport
	 *  top-left in projected pixels is origin + topLeft. */
	origin: L.Point;
	/** canvas element position, i.e. containerPointToLayerPoint([0, 0]). */
	topLeft: L.Point;
}

/** Snapshot the current view for a canvas just positioned at `topLeft`. Call
 *  this in the layer's _reset(), right after L.DomUtil.setPosition. */
export function canvasDrawState(map: L.Map, topLeft: L.Point): CanvasDrawState {
	return { zoom: map.getZoom(), origin: map.getPixelOrigin(), topLeft };
}

/** Scale + translate `canvas` so a painting made for `state` lines up with the
 *  view animating toward (center, zoom). At the draw view this reduces exactly
 *  to setPosition(state.topLeft) with scale 1 (origin === state.origin), so an
 *  animation starts with no jump. */
function transform(
	map: L.Map,
	canvas: HTMLElement,
	state: CanvasDrawState,
	center: L.LatLng,
	zoom: number,
): void {
	const scale = map.getZoomScale(zoom, state.zoom);
	// Pixel origin at the animating view; mirrors Map._getNewPixelOrigin so the
	// symbols line up with the tiles, which transform by the same delta.
	const origin = map
		.project(center, zoom)
		.subtract(map.getSize().divideBy(2))
		.round();
	const offset = state.origin
		.multiplyBy(scale)
		.subtract(origin)
		.add(state.topLeft);
	L.DomUtil.setTransform(canvas, offset, scale);
}

/** getEvents() entries that transform the canvas through a zoom animation.
 *  `ctx` returns the live canvas plus its last draw state, or null before the
 *  first paint. Spread the result into a layer's getEvents() alongside its
 *  moveend / zoomend / viewreset / resize repaint handlers. */
export function canvasZoomEvents(
	ctx: () => { map: L.Map; canvas: HTMLElement; state: CanvasDrawState } | null,
): Record<string, L.LeafletEventHandlerFn> {
	return {
		// flyTo / pinch: Map._move fires `zoom` every frame with the live view.
		zoom: () => {
			const c = ctx();
			if (c) {
				transform(c.map, c.canvas, c.state, c.map.getCenter(), c.map.getZoom());
			}
		},
		// scroll / double-click / +- : one `zoomanim` carrying the target view;
		// the leaflet-zoom-animated CSS transition eases the canvas to it.
		zoomanim: (e: L.LeafletEvent) => {
			const c = ctx();
			const z = e as L.ZoomAnimEvent;
			if (c) {
				transform(c.map, c.canvas, c.state, z.center, z.zoom);
			}
		},
	};
}
