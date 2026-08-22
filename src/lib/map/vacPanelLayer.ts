/* vacPanelLayer.ts draws the French VAC panels over the map: the SIA's own
 * approach and landing charts, in place, under the app's symbology.
 *
 * A canvas layer rather than an L.ImageOverlay per panel. Three reasons, in
 * order of weight: the panels are clipped rectangles that must be drawn in
 * a decided order where they overlap (the landing sheet over the approach
 * one), a canvas gets the zoom-animation handling every other direct-draw
 * layer here already has, and an image overlay per aerodrome would put a
 * DOM node's lifetime on the same clock as a pan.
 *
 * The pane sits at 300: above the stacked chart tiles (250 plus the stack
 * position, so 266 at the most with every chart checked) and below the
 * airspaces at 350. A VAC panel details the chart under it and is detailed
 * in turn by the airspace, NOTAM, weather and route symbology over it,
 * which is the whole point of putting it here rather than on top.
 *
 * No catalogs (docs/i18n.md rule 8): a canvas repaints on pan and zoom, so
 * baked translated text goes stale. This layer draws no text of its own;
 * every word on it is the SIA's, engraved in the plate. */

import L from 'leaflet';

import { panelAt, type VacPanel, type VacPanelKind } from '$lib/data/vacgeo';
import { DirectDrawLayer, ensurePane } from './directDrawLayer';

const PANE = 'vac-panels';
const PANE_Z = '300';

/** Where the panels overlap, the closer-in sheet wins. */
const ORDER: Record<VacPanelKind, number> = { APP: 0, GMC: 1, ATT: 2 };

/** A hairline round the panel, so the eye can see where the chart stops.
 *  Several plates draw no neatline of their own, and a chart that fades
 *  into the map with no edge reads as part of it. */
const EDGE = 'rgba(0, 0, 0, 0.35)';

/** What the layer needs to paint one panel: where it goes and, when it is
 *  drawn, what it looks like. Supplied by the caller so this module stays
 *  free of the render queue and its pdf.js import. */
export interface VacPanelDraw {
	panel: VacPanel;
	canvas: HTMLCanvasElement | null;
}

let layer: VacPanelLayer | null = null;
let layerMap: L.Map | null = null;
let visible = false;
let items: VacPanelDraw[] = [];

class VacPanelLayer extends DirectDrawLayer {
	protected readonly canvasClass = 'leaflet-vac-canvas';
	protected readonly paneName = PANE;

	protected _draw(): void {
		const ctx = this._ctx;
		const map = this._map;
		if (!ctx || !map || !this._canvas) {
			return;
		}
		const dpr = window.devicePixelRatio || 1;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		if (!visible) {
			return;
		}
		for (const it of items) {
			if (!it.canvas) {
				continue;
			}
			// The panel is placed by its own three corners rather than by a
			// north-up box: a ground-movement chart is rotated, often
			// heavily, and an axis-aligned blit would draw it square to the
			// map with its runway pointing the wrong way.
			const p = it.panel;
			const [x0, y0, x1, y1] = p.clip;
			const topLeft = corner(map, p, x0, y1);
			const topRight = corner(map, p, x1, y1);
			const bottomLeft = corner(map, p, x0, y0);
			const w = it.canvas.width;
			const h = it.canvas.height;
			if (w <= 0 || h <= 0) {
				continue;
			}
			ctx.save();
			ctx.transform(
				(topRight.x - topLeft.x) / w,
				(topRight.y - topLeft.y) / w,
				(bottomLeft.x - topLeft.x) / h,
				(bottomLeft.y - topLeft.y) / h,
				topLeft.x,
				topLeft.y,
			);
			ctx.drawImage(it.canvas, 0, 0);
			ctx.restore();
			ctx.strokeStyle = EDGE;
			ctx.lineWidth = 1;
			ctx.beginPath();
			const bottomRight = corner(map, p, x1, y0);
			ctx.moveTo(topLeft.x, topLeft.y);
			ctx.lineTo(topRight.x, topRight.y);
			ctx.lineTo(bottomRight.x, bottomRight.y);
			ctx.lineTo(bottomLeft.x, bottomLeft.y);
			ctx.closePath();
			ctx.stroke();
		}
	}
}

/** One page point as a container point, through the panel's own affine. */
function corner(map: L.Map, p: VacPanel, x: number, y: number): L.Point {
	const [lat, lon] = panelAt(p, x, y);
	return map.latLngToContainerPoint([lat, lon]);
}

/** Create the layer once. Idempotent. */
export function buildVacPanelLayer(map: L.Map): void {
	if (layer) {
		return;
	}
	ensurePane(map, PANE, PANE_Z);
	layer = new VacPanelLayer();
	layerMap = map;
}

/** Hand the layer the panels to paint, in draw order. */
export function setVacPanelData(draws: VacPanelDraw[]): void {
	items = [...draws].sort((a, b) => ORDER[a.panel.kind] - ORDER[b.panel.kind]);
}

/** Attach or detach the layer and repaint, the three-branch reconcile every
 *  canvas layer here uses. */
export function syncVacPanelLayer(map: L.Map, on: boolean): void {
	visible = on;
	if (!layer) {
		return;
	}
	const should = on && items.some((i) => i.canvas);
	const has = map.hasLayer(layer);
	if (should && !has) {
		layer.addTo(map);
	} else if (!should && has) {
		map.removeLayer(layer);
	} else if (has) {
		layer.redraw();
	}
}

/** Repaint without changing what is on the map, for a render that landed. */
export function redrawVacPanels(): void {
	if (layer && layerMap?.hasLayer(layer)) {
		layer.redraw();
	}
}

/** Detach and forget; buildVacPanelLayer must rebuild (HMR teardown). */
export function clearVacPanels(map: L.Map): void {
	if (layer && map.hasLayer(layer)) {
		map.removeLayer(layer);
	}
	layer = null;
	layerMap = null;
	items = [];
	visible = false;
}
