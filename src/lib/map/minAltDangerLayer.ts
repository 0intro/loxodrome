/* minAltDangerLayer.ts: translucent red patches over the parts of the active
 * route's minimum-altitude (MSA) corridor where the terrain / obstacle minimum
 * safe altitude is HIGHER than the planned leg altitude, i.e. exactly where
 * flying the planned level busts the 500 ft clearance floor. Driven by the Route
 * tab's "Highlight terrain above route" toggle; the offending cells are computed
 * in $lib/route/minAltitude (computeMinAltDangerCells) and handed here as
 * geographic quads.
 *
 * A direct-draw canvas (DirectDrawLayer) rather than per-cell Leaflet polygons:
 * the cells are lat/lon, so the layer re-projects itself on pan / zoom with no
 * recompute (the effect in MapView recomputes only on route / altitude / width /
 * toggle change). All quads are one path filled ONCE, so overlapping cells never
 * darken. Drawn in the shared route-analysis pane (z 444), where the canvas
 * appends AFTER the corridor bands' <svg> (routeAnalysisPane.ts), so the tint
 * composites above the amber corridor band but below the NOTAM areas (450)
 * and the route line (455). interactive:false. */

import L from 'leaflet';
import type { DangerCell } from '$lib/route/minAltitude';
import { DirectDrawLayer } from './directDrawLayer';
import { ensureRouteAnalysisPane, ROUTE_ANALYSIS_PANE } from './routeAnalysisPane';

const PANE = ROUTE_ANALYSIS_PANE;
// Fixed danger red (map overlays use fixed hex, not theme tokens), distinct from
// the amber MSA corridor band (#e08a00).
const FILL = 'rgba(224, 48, 30, 0.35)';

let layer: MinAltDangerCanvasLayer | null = null;
let cells: DangerCell[] = [];

class MinAltDangerCanvasLayer extends DirectDrawLayer {
	protected override readonly canvasClass = 'leaflet-minalt-danger-canvas';
	protected override readonly paneName = PANE;

	override onAdd(map: L.Map): this {
		super.onAdd(map);
		// leaflet.css z-orders `svg` (200) OVER `canvas` (100) among a pane's
		// children, so inside the shared route-analysis pane the corridor SVG
		// would paint over this tint regardless of DOM order. Lift the canvas
		// above it to keep the old three-pane stacking (tint over bands).
		if (this._canvas) {
			this._canvas.style.zIndex = '300';
		}
		return this;
	}

	protected override _draw(): void {
		const canvas = this._canvas;
		const ctx = this._ctx;
		const map = this._map;
		if (!canvas || !ctx || !map) {
			return;
		}
		const dpr = window.devicePixelRatio || 1;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.scale(dpr, dpr);
		if (cells.length === 0) {
			return;
		}
		// One path for every quad, filled once: overlapping cells composite as a
		// single fill, so no seam darkens.
		ctx.beginPath();
		for (const cell of cells) {
			const corners = cell.corners;
			const first = map.latLngToContainerPoint([corners[0].lat, corners[0].lon]);
			ctx.moveTo(first.x, first.y);
			for (let i = 1; i < corners.length; i++) {
				const p = map.latLngToContainerPoint([corners[i].lat, corners[i].lon]);
				ctx.lineTo(p.x, p.y);
			}
			ctx.closePath();
		}
		ctx.fillStyle = FILL;
		ctx.fill();
	}
}

/** Show / refresh the danger patches for the active route, or hide them (pass an
 *  empty array). Builds the layer lazily and reconciles its presence on the map,
 *  mirroring syncMinAltCorridor. */
export function syncMinAltDanger(m: L.Map, next: DangerCell[]): void {
	cells = next;
	ensureRouteAnalysisPane(m);
	if (!layer) {
		layer = new MinAltDangerCanvasLayer();
	}
	const has = m.hasLayer(layer);
	if (cells.length > 0 && !has) {
		layer.addTo(m);
	} else if (cells.length === 0 && has) {
		m.removeLayer(layer);
	} else if (has) {
		layer.redraw();
	}
}

/** Detach the overlay and drop refs (HMR / unmount teardown). State is
 *  session-scoped and rebuilds via syncMinAltDanger. */
export function clearMinAltDangerLayer(m: L.Map): void {
	if (layer && m.hasLayer(layer)) {
		m.removeLayer(layer);
	}
	layer = null;
	cells = [];
}
