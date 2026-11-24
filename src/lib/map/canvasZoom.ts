/* canvasZoom.ts: smooth zoom-animation support for the map's direct-draw
 * canvas overlays (every DirectDrawLayer: the airport / navaid / obstacle /
 * nature points, the airspace decorations, METAR, wind, radar, terrain, VAC
 * panels and the minimum-altitude danger patches).
 *
 * Each of those layers paints one screen-space canvas placed at the viewport
 * corner (less the overscan margin, directDrawLayer.ts) and draws features at
 * container points, repainted only on moveend / zoomend. That is fine for a
 * *pan*: Leaflet translates the map pane and the canvas (a descendant of it)
 * rides along. But a *zoom* animation (flyTo, scroll-wheel, double-click, +/-
 * buttons) is driven per-frame through the `zoom` / `zoomanim` events with the
 * map pane held still while each layer transforms itself. A canvas that
 * ignores those events stays frozen at its last-drawn position and scale, so
 * e.g. a centred airport symbol stays glued to the screen centre while the
 * basemap flies past underneath, then snaps into place at the end.
 *
 * These helpers let such a layer transform its canvas during a zoom animation
 * the way Leaflet places a tile level (GridLayer._setZoomTransform), with the
 * canvas corner as the level's origin: scale by the zoom ratio about the
 * top-left, and translate to where that corner lands under the animating
 * view. The top-left anchor needs transform-origin 0 0, which the layers get
 * by adding the `leaflet-zoom-animated` class to their canvas; that class also
 * carries Leaflet's transform transition, so the single `zoomanim` target is
 * eased while the per-frame flyTo `zoom` updates (no transition active) track
 * the curve directly.
 */

import L from 'leaflet';
import { paintingOffset } from './canvasPlacement';

/** The map view captured when the canvas was last painted: enough to re-place
 *  that painting under any animating (center, zoom). */
export interface CanvasDrawState {
	/** map zoom at draw time. */
	zoom: number;
	/** map pixel origin at draw time (getPixelOrigin). Set by a view reset or
	 *  a zoom and left alone by a pan, which moves the map PANE instead; the
	 *  canvas corner in projected pixels is origin + topLeft. */
	origin: L.Point;
	/** the canvas element's position in layer points: the viewport's top-left
	 *  (containerPointToLayerPoint([0, 0])) less the overscan margin. */
	topLeft: L.Point;
}

/** Scale + translate `canvas` so a painting made for `state` lines up with the
 *  view animating toward (center, zoom). At the draw view the new origin is
 *  the draw origin again (the pane offset cancels the pan), so this reduces
 *  exactly to setPosition(state.topLeft) with scale 1: an animation starts
 *  with no jump, whatever the map was panned by. */
function transform(
	map: L.Map,
	canvas: HTMLElement,
	state: CanvasDrawState,
	center: L.LatLng,
	zoom: number,
): void {
	const scale = map.getZoomScale(zoom, state.zoom);
	// The pixel origin Leaflet gives the animating view (Map._getNewPixelOrigin):
	// half a viewport before the target centre, PLUS the map pane's offset,
	// which a pan leaves in place until the next view reset. Without the pane
	// every canvas was placed off by the pan times the zoom scale, sliding
	// away through the animation and snapping back when it settled.
	const pane = map.layerPointToContainerPoint([0, 0]);
	const origin = map
		.project(center, zoom)
		.subtract(map.getSize().divideBy(2))
		.add(pane)
		.round();
	// The painting's corner in projected pixels at its own zoom, scaled to the
	// animating zoom, less that origin: where a tile level with that corner
	// as its origin would be placed (GridLayer._setZoomTransform), so the
	// symbols line up with the tiles. Unrounded, like Renderer._updateTransform.
	const at = paintingOffset(state, scale, origin);
	L.DomUtil.setTransform(canvas, L.point(at.x, at.y), scale);
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
