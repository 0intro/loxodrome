/* directDrawLayer.ts: the shared lifecycle of the direct-draw canvas
 * overlays (airport / navaid / obstacle / nature layers). Each paints one
 * screen-space canvas pinned to the viewport corner, repainted on moveend /
 * zoomend / viewreset / resize (coalesced to one paint per task, since one
 * zoom fires three of those), and transformed through zoom animations via
 * canvasZoomEvents (see canvasZoom.ts for why).
 *
 * Subclasses own _draw() entirely, including the setTransform / clearRect
 * prologue and their own dpr-scale-vs-zoom-gate ordering: airportLayer
 * returns BEFORE scaling at zoom <= 3 (the documented accepted floor, so no
 * highlight shows below it), while the navaid / obstacle / nature layers
 * scale first and only gate the bulk loop, so a lone highlight still draws
 * at any zoom. */

import L from 'leaflet';
import {
	canvasDrawState,
	canvasZoomEvents,
	type CanvasDrawState,
} from './canvasZoom';

/** Create the named map pane once with the given z-index. */
export function ensurePane(map: L.Map, name: string, zIndex: string): void {
	if (!map.getPane(name)) {
		map.createPane(name).style.zIndex = zIndex;
	}
}

export abstract class DirectDrawLayer extends L.Layer {
	protected _canvas: HTMLCanvasElement | null = null;
	protected _ctx: CanvasRenderingContext2D | null = null;
	/** The view snapshot of the last paint (canvasZoom.ts). Protected: the
	 *  airspace deco layer reads origin + topLeft in its _draw for the
	 *  map-anchored hatch phase (decoGeometry.hatchPhase). */
	protected _drawState: CanvasDrawState | null = null;

	/** CSS class for the canvas; 'leaflet-zoom-animated' is added beside it
	 *  (it carries Leaflet's zoom-transition styling, see canvasZoom.ts). */
	protected abstract readonly canvasClass: string;

	/** Name of the layer's own map pane (created by ensurePane at build
	 *  time). Resolved by name in onAdd: L.Layer's getPane() reads
	 *  options.pane, which these layers never set, so it silently fell
	 *  back to Leaflet's overlayPane; the named panes sat empty and the
	 *  pane-level display toggle (updateAirportPane's zoom floor) and the
	 *  documented obstacle < navaid < nature < airport z-order were
	 *  inoperative. */
	protected abstract readonly paneName: string;

	/** Repaint the canvas. Subclasses own the full body: guards, the
	 *  clear + retina-scale prologue, their zoom gates, and the
	 *  highlight-drawn-last ordering. */
	protected abstract _draw(): void;

	override onAdd(map: L.Map): this {
		const canvas = L.DomUtil.create(
			'canvas',
			`${this.canvasClass} leaflet-zoom-animated`,
		);
		canvas.style.position = 'absolute';
		// Don't intercept mouse events; hit-tests run via the r-tree from
		// MapView's onMapClick / onMapMouseMove.
		canvas.style.pointerEvents = 'none';
		this._canvas = canvas;
		this._ctx = canvas.getContext('2d');
		map.getPane(this.paneName)?.appendChild(canvas);
		this._reset();
		return this;
	}

	override onRemove(_map: L.Map): this {
		if (this._canvas?.parentNode) {
			this._canvas.parentNode.removeChild(this._canvas);
		}
		this._canvas = null;
		this._ctx = null;
		return this;
	}

	// Leaflet calls these on the events listed below the same way it hooks
	// renderers into the lifecycle.
	override getEvents(): { [name: string]: L.LeafletEventHandlerFn } {
		return {
			moveend: this._reset.bind(this),
			zoomend: this._reset.bind(this),
			viewreset: this._reset.bind(this),
			resize: this._reset.bind(this),
			...canvasZoomEvents(() =>
				this._canvas && this._map && this._drawState
					? { map: this._map, canvas: this._canvas, state: this._drawState }
					: null,
			),
		};
	}

	redraw(): void {
		this._reset();
	}

	/** Paint once per task, not once per event.
	 *
	 *  One zoom fires zoomend, moveend AND viewreset from inside a single
	 *  Map._resetView call, so each of these canvases repainted three times per
	 *  step; the imperative setters (cues, highlight, group toggles) stack up
	 *  the same way when several land together. A MICROTASK is the right
	 *  grain: it runs after the current task and before the browser paints, so
	 *  the duplicates collapse without the canvas ever showing a frame of the
	 *  previous view at the new position (which a requestAnimationFrame defer
	 *  would allow at zoomend, where setPosition has already dropped the
	 *  animation's scale). The geometry in _reset stays synchronous. */
	private _drawQueued = false;

	private _scheduleDraw(): void {
		if (this._drawQueued) {
			return;
		}
		this._drawQueued = true;
		queueMicrotask(() => {
			this._drawQueued = false;
			if (this._canvas && this._map) {
				this._draw();
			}
		});
	}

	protected _reset(): void {
		if (!this._canvas || !this._map) {
			return;
		}
		const map = this._map;
		const size = map.getSize();
		const dpr = window.devicePixelRatio || 1;
		// Keep the canvas's upper-left at container (0, 0): compute the
		// matching layer point and setPosition to it so the canvas always
		// aligns with the viewport, regardless of how the pane transform has
		// drifted during pans.
		const topLeftLayer = map.containerPointToLayerPoint([0, 0]);
		L.DomUtil.setPosition(this._canvas, topLeftLayer);
		this._drawState = canvasDrawState(map, topLeftLayer);
		// Assigning width/height reallocates and clears the backing store, so
		// only do it when the size actually changed; _draw clears for itself.
		const w = Math.round(size.x * dpr);
		const h = Math.round(size.y * dpr);
		if (this._canvas.width !== w || this._canvas.height !== h) {
			this._canvas.width = w;
			this._canvas.height = h;
			this._canvas.style.width = size.x + 'px';
			this._canvas.style.height = size.y + 'px';
		}
		this._scheduleDraw();
	}
}
