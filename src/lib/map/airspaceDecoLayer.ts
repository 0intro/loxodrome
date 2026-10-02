/* airspaceDecoLayer.ts: the airspaces on the map, their boundary lines and
 * the SIA 1:500 000 symbology beside them, one painting made by
 * decoPaint.ts.
 *
 * A BitmapDrawLayer (bitmapDrawLayer.ts): one canvas on its own pane,
 * repainted at rest (moveend / zoomend / viewreset / resize) and transformed
 * during zoom animation, each painting made on an OffscreenCanvas and shown
 * whole where the platform allows, on the canvas directly where it does not;
 * this class hands the paint its frame and zones. Where paintings are made
 * off screen, a worker makes them (decoWorkerClient.ts) once it says it can,
 * the page painting until then and for good once the worker fails, both with
 * the same painter on the same kind of canvas, so which of them painted
 * never shows. While the worker paints, the layer also paints as the map
 * moves, each painting reaching ahead of the view (paintsInMotion), so a
 * drag shows the airspaces where the map has gone rather than an empty
 * strip. The zones are airspaceLayer's rows for the rectangle the
 * painting covers (airspacesToPaint: the filters and the categories through
 * one chokepoint, entryShown), so a boundary and its decorations show and
 * hide together, being one painting; the hovered / selected airspace is
 * painted unconditionally, bypassing every gate, like the other canvas
 * layers' highlight passes, and the ones a selected NOTAM affects take the
 * emphasis stroke. */

import L from 'leaflet';
import type { Airspace } from '$lib/data/airspaces';
import {
	airspacesToPaint,
	highlightedAirspaces,
	linkedAirspaceKeys,
	setAirspaceRepaintListener,
} from '$lib/map/airspaceLayer';
import { BitmapDrawLayer } from './bitmapDrawLayer';
import { containerBounds } from './containerProjection';
import { CLIP_PAD, DecoPainter, paintsNothing, scratchOver, type DecoFrame, type Scratch } from './decoPaint';
import { DecoWorkerClient, startDecoWorker } from './decoWorkerClient';
import { decoZoneOf, resetDecoZones, type DecoZone } from './decoZone';
import { ensurePane, type CanvasTarget } from './directDrawLayer';
import type { Paint2D } from './symbolBase';

const PANE = 'airspaces-deco';
// 355 sits between airspaces (350) and supaip (360): just above the airspace
// outlines, below the SUP AIP and activation overlays (and the airport /
// navaid symbols, which overprint airspace lettering like on the paper chart).
const PANE_Z = '355';
let layer: AirspaceDecoLayer | null = null;
// Designator-label visibility (the Layers-tab toggle), read at draw time.
let labelsVisible = true;

/** The page's scratch for the paint, never attached to the document: an
 *  OffscreenCanvas like the worker's where the platform has one, so the page
 *  and the worker paint alike to the pixel (scratchOver), else a canvas. */
function pageScratch(width: number, height: number): Scratch | null {
	if (typeof OffscreenCanvas === 'function') {
		const off = new OffscreenCanvas(width, height);
		const ctx = off.getContext('2d');
		if (ctx) {
			return scratchOver(off, ctx);
		}
	}
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	return ctx ? scratchOver(canvas, ctx) : null;
}

class AirspaceDecoLayer extends BitmapDrawLayer {
	protected override readonly canvasClass = 'leaflet-airspace-deco-canvas';
	// The base class resolves the pane by NAME in onAdd (never through
	// options.pane), placing the canvas at z 355: below the SUP AIP /
	// activation overlays and the NOTAM areas, with the airport / navaid
	// symbols overprinting the labels like on the paper chart.
	protected override readonly paneName = PANE;
	// The follow-mode margin (directDrawLayer setDrawOverscan): this is the
	// canvas a re-centre in flight used to repaint in full, ~1 s a time on a
	// phone-class CPU.
	protected override readonly overscanned = true;

	private readonly _painter = new DecoPainter(pageScratch);
	// The worker that paints off the main thread once it says it can; null
	// before the layer is on a map, where the platform offers none, and after
	// it went down, when the page paints.
	private _worker: DecoWorkerClient | null = null;
	// The views of the paintings the worker holds, by painting number.
	private readonly _sent = new Map<number, CanvasTarget>();
	// The rows last painted and their zones: the same rows (airspacesToPaint
	// hands back the same array while nothing changed) keep the same zone
	// list, which the worker client then names by the same numbers.
	private _rows: readonly Airspace[] | null = null;
	private _rowZones: DecoZone[] = [];

	override onAdd(map: L.Map): this {
		super.onAdd(map);
		if (this.mode === 'bitmap' && !this._worker) {
			const worker = startDecoWorker();
			if (worker) {
				this._worker = new DecoWorkerClient(worker, {
					frame: (seq, bitmap) => {
						this._landed(seq, bitmap);
					},
					down: () => {
						this._workerDown();
					},
				});
			}
		}
		return this;
	}

	/** The worker paints: a painting costs the page nothing, so the layer
	 *  paints while the map moves. The page, painting on the main thread,
	 *  would take the frames the move needs. */
	protected override paintsInMotion(): boolean {
		return this._worker?.ready === true;
	}

	override onRemove(map: L.Map): this {
		if (this._worker) {
			this._worker.dispose();
			this._worker = null;
			// The zones it was sent took their arrays with them: the next
			// worker, or the page, needs them whole.
			resetDecoZones();
		}
		this._sent.clear();
		this._rows = null;
		this._rowZones = [];
		return super.onRemove(map);
	}

	protected override _paint(seq: number, t: CanvasTarget): void {
		const [zones, highlighted, outlined] = this._zones(t);
		// A painting that would draw nothing (no airspace shown, the default
		// until a category is ticked) is not made: no message to the worker,
		// no page paint, the canvas shown blank at once.
		if (paintsNothing(t.zoom, zones, highlighted)) {
			this._scheduler.arrived(seq, { bitmap: null, target: t });
			return;
		}
		const map = this._map;
		const worker = this._worker;
		if (map && worker?.ready) {
			// The page painted until now: its canvases, two of them the size
			// of the painting, are the worker's to hold from here.
			this._releasePageCanvas();
			this._painter.release();
			this._sent.set(seq, t);
			try {
				worker.paint(seq, this._frameOf(t), t.w, t.h, zones, highlighted, outlined);
			} catch (err) {
				// A message that cannot go across (a DataCloneError) would leave
				// the painting in flight for ever: the page paints from now on.
				console.warn(`[loxodrome] airspace decorations painted on the page: ${String(err)}`);
				worker.dispose();
				this._workerDown();
			}
			return;
		}
		super._paint(seq, t);
	}

	protected override _paintTarget(ctx: Paint2D, canvas: { width: number; height: number }, t: CanvasTarget): void {
		if (!this._map) {
			return;
		}
		this._painter.paint(ctx, canvas, this._frameOf(t), ...this._zones(t));
	}

	/** The view `t` as the paint takes it. */
	private _frameOf(t: CanvasTarget): DecoFrame {
		return {
			view: { zoom: t.zoom, originX: t.origin.x, originY: t.origin.y, paneX: t.pane.x, paneY: t.pane.y },
			topLeft: { x: t.topLeft.x, y: t.topLeft.y },
			size: { x: t.size.x, y: t.size.y },
			margin: { left: t.margin.left, top: t.margin.top, right: t.margin.right, bottom: t.margin.bottom },
			dpr: t.dpr,
			labels: labelsVisible,
			lines: true,
		};
	}

	/** What the paint draws for the view `t`: the rows shown in the rectangle
	 *  it covers, padded as the paint culls (CLIP_PAD), in stacking order;
	 *  the highlighted rows, drawn whatever the filters; and those of the
	 *  shown rows a selected NOTAM affects, stroked in the emphasis. */
	private _zones(t: CanvasTarget): [DecoZone[], DecoZone[], DecoZone[]] {
		const view = { zoom: t.zoom, originX: t.origin.x, originY: t.origin.y, paneX: t.pane.x, paneY: t.pane.y };
		const window = containerBounds(
			view,
			-t.margin.left - CLIP_PAD,
			-t.margin.top - CLIP_PAD,
			t.size.x + t.margin.right + CLIP_PAD,
			t.size.y + t.margin.bottom + CLIP_PAD,
		);
		const rows = airspacesToPaint(t.zoom, window);
		if (rows !== this._rows) {
			this._rows = rows;
			this._rowZones = rows.map(decoZoneOf);
		}
		const linked = linkedAirspaceKeys();
		const outlined = linked.size > 0 ? this._rowZones.filter((z) => linked.has(z.key)) : [];
		return [this._rowZones, highlightedAirspaces().map(decoZoneOf), outlined];
	}

	private _landed(seq: number, bitmap: ImageBitmap): void {
		const t = this._sent.get(seq);
		this._sent.delete(seq);
		if (!t) {
			bitmap.close();
			return;
		}
		this._scheduler.arrived(seq, { bitmap, target: t });
	}

	/** The worker is gone: the zones it was sent took their arrays with them,
	 *  and whatever it held is owed again, painted on the page. */
	private _workerDown(): void {
		this._worker = null;
		resetDecoZones();
		// Made before the reset: the next painting maps its rows afresh.
		this._rows = null;
		this._rowZones = [];
		for (const seq of this._sent.keys()) {
			this._scheduler.failed(seq);
		}
		this._sent.clear();
		this._scheduler.request();
	}
}

/* ----------------------------------------------------------------------
 * Public API.
 * ------------------------------------------------------------------- */

/** Build the painting layer once and attach it. It stays on the map and
 *  draws nothing when no airspace is shown (airspacesToPaint answers none).
 *  It repaints on its own view events, and whenever the airspace layer says
 *  what it draws changed (a filter, a category, a republished dataset, a
 *  hover, a selection, a NOTAM's linked set): nothing else asks it to.
 *  Idempotent until clearAirspaceDecoLayer. */
export function buildAirspaceDecoLayer(map: L.Map): void {
	if (layer) {
		return;
	}
	ensurePane(map, PANE, PANE_Z);
	layer = new AirspaceDecoLayer();
	layer.addTo(map);
	setAirspaceRepaintListener(() => layer?.redraw());
}

/** Take the layer down with its map: stop listening to the boundary layer,
 *  detach the canvas and forget the layer, so a remounted view builds a fresh
 *  one on its own map (buildAirspaceDecoLayer does nothing while one exists).
 *  Called from the views' teardown beside clearAirspaceLayer, before the map
 *  itself is removed. The labels choice survives, as a preference. */
export function clearAirspaceDecoLayer(): void {
	setAirspaceRepaintListener(null);
	layer?.remove();
	layer = null;
}

/** Resolves once the decorations on screen are the view as it stands: what
 *  the PDF export waits for before it captures the map. */
export function airspaceDecoIdle(): Promise<void> {
	return layer ? layer.whenIdle() : Promise.resolve();
}

/** Show / hide the designator labels (the Layers-tab toggle). */
export function setAirspaceLabelsVisible(on: boolean): void {
	labelsVisible = on;
	layer?.redraw();
}
