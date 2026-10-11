/* directDrawLayer.ts: the shared lifecycle of the direct-draw canvas
 * overlays (the airport / navaid / obstacle / nature points of
 * pointLayerFactory, the airspace decorations, METAR, wind, radar, terrain,
 * VAC panels and the minimum-altitude danger patches). Each paints one
 * screen-space canvas placed at the viewport corner (less the overscan margin
 * below), repainted on moveend / zoomend / viewreset / resize (coalesced to
 * one paint per task, since one zoom fires three of those), and transformed
 * through zoom animations via canvasZoomEvents (see canvasZoom.ts for why).
 *
 * Subclasses own _draw() entirely, including the setTransform / clearRect
 * prologue (_beginPaint for a layer that draws a margin) and their own zoom
 * gates: airportLayer draws nothing at zoom <= 3 (the documented accepted
 * floor, so no highlight shows below it), while the navaid / obstacle /
 * nature layers only gate the bulk loop, so a lone highlight still draws at
 * any zoom.
 *
 * A layer that opts in (paintsInMotion) also paints while the map moves, so
 * a drag never shows an empty strip where the map has gone. Each `move`
 * samples the view's velocity (from the movement's `movestart`, over 8 ms at
 * least), and asks for a painting as soon as the newest one would stop
 * covering the view before a painting asked for now could show, at most once
 * per MOTION_INTERVAL_MS, a timer catching the last move. Such a painting
 * reaches ahead of the view on the side it moves toward, far enough to cover
 * it until its successor can show (canvasPlacement.leadMargins): the speed
 * times the latency measured here, send to show, plus the gap between two
 * sends, which is the interval or, when paintings take longer, the latency
 * again (one is on its way at a time), with room to spare; and while the
 * movement keeps going that way, no less far than the painting before it
 * (keptLead), so a speed that wavers from one sample to the next does not
 * size the canvas anew painting after painting. A settle repaints
 * only when the newest painting no longer covers the view, and makes that
 * painting at rest (a key pan's settle each half viewport aside: its glide
 * goes on); a zoom holds, and measures no velocity across it. This base
 * paints at once, in the task that asked, so its latency is its paint;
 * bitmapDrawLayer.ts sends its paintings away and measures them there. */

import L from 'leaflet';
import { coversView, hasMargin, keptLead, leadMargins, NO_MARGIN, overscanFor, sameMargin, widerMargin, type Margin } from './canvasPlacement';
import { canvasZoomEvents, type CanvasDrawState } from './canvasZoom';
import { isKeyPanEvent } from './keyPan';

/** Create the named map pane once with the given z-index. */
export function ensurePane(map: L.Map, name: string, zIndex: string): void {
	if (!map.getPane(name)) {
		map.createPane(name).style.zIndex = zIndex;
	}
}

/* ---- overscan: a margin drawn around the viewport, while following ----
 *
 * In follow mode the map re-centres on the aircraft every few seconds by a
 * few pixels, and each re-centre is a moveend, which repainted every canvas
 * in full: the decoration layer alone took ~1 s per re-centre on a
 * phone-class CPU (docs/performance-2026-09.md). A layer that opts in
 * (`overscanned`) draws that margin beyond each side of the viewport while
 * follow is engaged, and a moveend that leaves the view inside what was
 * drawn repaints nothing: the canvas sits in layer space and rides the pan.
 * The margin is only drawn while following (navLayer sets it), because an
 * ordinary drag is wider than any affordable margin and would pay for the
 * extra pixels on every repaint for nothing. */
let overscanPx = 0;

/** The margin (CSS px each side) the opted-in layers draw beyond the
 *  viewport; 0 draws the viewport exactly. Taken up by the next paint, never
 *  forcing one: the caller sets it just before the pan that settles into it,
 *  so a repaint here would be a second one. */
export function setDrawOverscan(px: number): void {
	overscanPx = Math.max(0, Math.round(px));
}

/** The margin set now (setDrawOverscan): more than none while the map follows
 *  the aircraft in small steps. */
export function drawOverscan(): number {
	return overscanPx;
}

/* ---- painting while the map moves ---- */

/** At most one painting sent per this while the map moves: the lead's
 *  interval term too. */
export const MOTION_INTERVAL_MS = 80;
/** A layer painting on the page paints while the map moves while its recent
 *  paints average no more than this, ms (_paintsCheaply): on the main thread,
 *  a paint takes from the frames the move needs. Half a frame at 60 Hz. On the
 *  Redmi the airports at Paris z9 take 1.4 to 3.5 ms a paint back to back and
 *  2 to 11 alone (the clocks down, the GPU to wait on), so a gate on the last
 *  paint at 4 held them to the settles in most drags, while 24 drags painting
 *  them throughout missed no more frames; the obstacles drawn as vectors, 17
 *  to 19 ms there, stay at the settles. */
export const MOTION_PAINT_BUDGET_MS = 8;
/** A painting's latency, send to show, until one has been measured. */
const LATENCY_GUESS_MS = 50;
/** A painting slower than this counts as this much: one slow painting (a
 *  zoom's first, which makes the lines it holds at that zoom) must not set
 *  the pace of the drags after it. */
const LATENCY_CAP_MS = 250;
/** Each paint moves the recent paints' average this share of the way to its
 *  own cost: one slow paint among cheap ones leaves it cheap, a layer whose
 *  paints stay dear gets there within a few. */
const PAINT_AVG_WEIGHT = 0.25;
/** The lead covers this much more than the latency and the interval. */
const LEAD_FACTOR = 1.25;
/** The lead's rounding, CSS px: a steady glide keeps one canvas size, so
 *  no canvas is reallocated from one painting to the next. */
const LEAD_STEP = 32;
/** The lead never draws more than this share of the viewport on its axis. */
const LEAD_CAP = 0.5;
/** Below this speed, CSS px per ms, the view is at rest. */
const MIN_SPEED = 0.05;
/** A velocity sample older than this is no speed at all. */
export const STALE_MS = 120;
/** A velocity is measured over this long at least: Leaflet's drag fires a
 *  `move` per pointer event, which Android hands over in bursts, and two
 *  moves a millisecond apart measure a jump, not a speed. */
const MIN_SAMPLE_MS = 8;
/** How many latencies of travel the newest painting must still cover ahead
 *  of the view, or another is asked for. */
const NEED_LATENCIES = 1.5;

/** The view's last sample while the map moves: where its corner was, in
 *  layer points, when, and the velocity so far, CSS px per ms (none until a
 *  sample 8 ms on measures one). */
export interface MotionSample {
	t: number;
	x: number;
	y: number;
	v: { x: number; y: number } | null;
}

/** The geometry of a paint made for the current view (DirectDrawLayer._target). */
export interface CanvasTarget {
	zoom: number;
	/** Map pixel origin. */
	origin: L.Point;
	/** The map pane's offset (the pan since the last view reset). */
	pane: L.Point;
	/** The viewport's top-left, in layer points. */
	viewTopLeft: L.Point;
	/** The canvas corner, in layer points: viewTopLeft less the left and top
	 *  margins. */
	topLeft: L.Point;
	/** The viewport, CSS px. */
	size: L.Point;
	margin: Margin;
	/** What of the margin reaches ahead of a moving view: none at rest. */
	lead: Margin;
	dpr: number;
	/** The extent the canvas covers, CSS px, and its backing store, device
	 *  px (deviceSize); its CSS box is the latter over the ratio (cssBox). */
	cssW: number;
	cssH: number;
	w: number;
	h: number;
}

/** What a paint covers: its rectangle in layer points (CSS px) and its view. */
export interface DrawnRect {
	x: number;
	y: number;
	w: number;
	h: number;
	dpr: number;
	zoom: number;
	origin: L.Point;
	margin: Margin;
}

export function drawnRect(t: CanvasTarget): DrawnRect {
	return {
		x: t.topLeft.x,
		y: t.topLeft.y,
		w: t.cssW,
		h: t.cssH,
		dpr: t.dpr,
		zoom: t.zoom,
		origin: t.origin,
		margin: t.margin,
	};
}

/** A canvas's size in device pixels for `css` CSS px at `dpr`: whole pixels,
 *  never short of the extent (a product a hair over a whole number, as
 *  floating point makes 1600 x 1.1, is that number). */
export function deviceSize(css: number, dpr: number): number {
	return Math.ceil(css * dpr - 1e-6);
}

/** The CSS box of a canvas painted for `t`: its backing store over the
 *  ratio, exactly, so the compositor copies the painting pixel for pixel. A
 *  box of the extent itself would be resampled wherever the extent times the
 *  ratio is not whole (1856 CSS px at 1.2 are 2227.2 device px), which blurs
 *  the painting and costs a software compositor every frame of a pan. */
export function cssBox(t: CanvasTarget): { w: number; h: number } {
	const exact = (device: number): number => Math.round((device / t.dpr) * 1e6) / 1e6;
	return { w: exact(t.w), h: exact(t.h) };
}

/** Write a canvas's CSS size, only where it changed. */
export function setCssSize(canvas: HTMLCanvasElement, w: number, h: number): void {
	const cssW = `${w}px`;
	const cssH = `${h}px`;
	if (canvas.style.width !== cssW) {
		canvas.style.width = cssW;
	}
	if (canvas.style.height !== cssH) {
		canvas.style.height = cssH;
	}
}

export abstract class DirectDrawLayer extends L.Layer {
	protected _canvas: HTMLCanvasElement | null = null;
	protected _ctx: CanvasRenderingContext2D | null = null;
	/** The view snapshot of the last paint (canvasZoom.ts). Protected: the
	 *  airspace deco layer reads origin + topLeft in its _draw for the
	 *  map-anchored hatch phase (decoGeometry.hatchPhase). topLeft is the
	 *  CANVAS corner, the viewport corner minus the overscan margin. */
	protected _drawState: CanvasDrawState | null = null;

	/** Opt in to the follow-mode overscan (see setDrawOverscan). A layer that
	 *  does draws through _beginPaint and culls to _paintExtent. */
	protected readonly overscanned: boolean = false;
	/** The margin of the last paint, CSS px. */
	protected _margin: Margin = NO_MARGIN;
	/** What the last paint covers: its rectangle in layer points and the view
	 *  it was made for (the overscan skip, _covered). */
	protected _drawn: DrawnRect | null = null;
	/** The target the canvas was last placed and sized for (_apply): what a
	 *  _draw paints. */
	protected _applied: CanvasTarget | null = null;
	protected _forcePaint = false;
	/** The view's last sample while the map moves. */
	protected _motion: MotionSample | null = null;
	/** Send to show, averaged over the paintings seen. */
	protected _latencyMs = LATENCY_GUESS_MS;
	/** The lead of the newest painting made while this movement goes on, none
	 *  once it ends (keptLead). */
	private _lead: Margin | null = null;
	/** What the recent paints on the page cost, ms: an average, none before
	 *  the first. A paint that sized the canvas is left out: it paid for the
	 *  store (a growth takes the phone 15 to 21 ms, the first paint from the
	 *  default 300 x 150 more), not for what it drew, and two of those in a row
	 *  would pass for a dear layer. So is one its _draw set aside. */
	protected _paintAvgMs: number | null = null;
	/** Set by a _draw whose cost says nothing of what the paintings of a
	 *  movement cost, for the average to leave it out (the terrain shading's
	 *  new reference altitude, every bitmap made again); cleared before each. */
	protected _paintAside = false;
	// Whether the paint queued sized the canvas (_apply).
	private _sized = false;
	private _lastSendAt = -Infinity;
	// A zoom runs: its moves are no view to paint.
	private _zooming = false;
	// The request waiting for the interval to pass, and the promise whenIdle
	// waits on while it does.
	private _trailing: ReturnType<typeof setTimeout> | null = null;
	private _trailingDone: Promise<void> | null = null;
	private _endTrailing: (() => void) | null = null;

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
		this._initContext(canvas);
		map.getPane(this.paneName)?.appendChild(canvas);
		this._drawn = null;
		this._reset();
		return this;
	}

	override onRemove(_map: L.Map): this {
		this._endTrailingRequest();
		this._motion = null;
		this._lead = null;
		this._zooming = false;
		if (this._canvas?.parentNode) {
			this._canvas.parentNode.removeChild(this._canvas);
		}
		this._canvas = null;
		this._ctx = null;
		this._drawn = null;
		this._applied = null;
		this._drawState = null;
		return this;
	}

	// Leaflet calls these on the events listed below the same way it hooks
	// renderers into the lifecycle.
	override getEvents(): { [name: string]: L.LeafletEventHandlerFn } {
		return {
			// A zoom ends with zoomend then moveend; either ends its hold, so a
			// zoom that never reports its end cannot hold for ever.
			moveend: (e) => {
				this._settle(e);
			},
			zoomend: (e) => {
				this._settle(e);
			},
			viewreset: this._reset.bind(this),
			resize: this._reset.bind(this),
			zoomstart: () => {
				this._zoomStart();
			},
			movestart: (e) => {
				this._onMoveStart(e);
			},
			move: () => {
				this._onMove();
			},
			...canvasZoomEvents(() =>
				this._canvas && this._map && this._drawState
					? { map: this._map, canvas: this._canvas, state: this._drawState }
					: null,
			),
		};
	}

	/** The view settles. It has stopped, so a painting the settle needs is
	 *  made at rest, at the full ratio and reaching no further than the view;
	 *  a key pan's settle each half viewport aside, its glide going on. */
	protected _settle(e: L.LeafletEvent): void {
		this._zooming = false;
		this._endTrailingRequest();
		if (!isKeyPanEvent(e)) {
			this._motion = null;
			this._lead = null;
		}
		this._reset();
	}

	/** A zoom starts: it moves the pixel origin, so no velocity across it,
	 *  and its moves are no view to paint. */
	protected _zoomStart(): void {
		this._zooming = true;
		this._endTrailingRequest();
		this._motion = null;
		this._lead = null;
	}

	/** Whether this layer paints while the map moves (an opt-in): a painting
	 *  costs the frames the move needs little enough. */
	protected paintsInMotion(): boolean {
		return false;
	}

	/** Whether this layer's recent paints average MOTION_PAINT_BUDGET_MS or
	 *  less, or none was measured yet: the average, not the last paint, since
	 *  the last before a drag is the settle of the one before, a paint alone,
	 *  which a phone makes at its slowest. */
	protected _paintsCheaply(): boolean {
		const avg = this._paintAvgMs;
		return avg === null || avg <= MOTION_PAINT_BUDGET_MS;
	}

	/** Painting now, while the map moves: opted in, and no zoom holds. */
	protected _inMotionMode(): boolean {
		return this.paintsInMotion() && !this._zooming;
	}

	/** Ask for a painting of the view as it stands: here, at once. */
	protected _askPainting(): void {
		this._forcePaint = true;
		this._reset();
	}

	/** Resolves once what is on screen is the view as it stands: a request
	 *  waiting for the interval is asked first. */
	whenIdle(): Promise<void> {
		const waiting = this._trailingDone;
		return waiting ? waiting.then(() => this.whenIdle()) : this._paintIdle();
	}

	/** Resolves once the painting asked for has shown: here the paint is a
	 *  microtask queued before this one. */
	protected _paintIdle(): Promise<void> {
		return new Promise((resolve) => {
			queueMicrotask(resolve);
		});
	}

	/** The view's velocity, CSS px per ms, none once the last sample is old. */
	protected _velocity(now: number): { x: number; y: number } {
		const m = this._motion;
		return m?.v && now - m.t <= STALE_MS ? m.v : { x: 0, y: 0 };
	}

	/** A movement starts (a drag, a glide, an animated pan): where the view
	 *  stands is its first sample, so its first `move` measures a velocity.
	 *  A new movement's velocity and lead owe nothing to the last one's; a
	 *  key pan's glide, which starts again after each of its settles, keeps
	 *  its lead. */
	private _onMoveStart(e: L.LeafletEvent): void {
		if (!isKeyPanEvent(e)) {
			this._lead = null;
		}
		const map = this._map;
		if (!map || !this._canvas || !this._inMotionMode()) {
			return;
		}
		const p = map.containerPointToLayerPoint([0, 0]);
		this._motion = { t: performance.now(), x: p.x, y: p.y, v: null };
	}

	/** One `move`: sample the view, and ask for a painting if the newest one
	 *  will not cover it long enough. O(1): the pane's position, the clock,
	 *  a rectangle test. */
	private _onMove(): void {
		const map = this._map;
		if (!map || !this._canvas || !this._inMotionMode()) {
			return;
		}
		const now = performance.now();
		const p = map.containerPointToLayerPoint([0, 0]);
		let m = this._motion;
		if (!m || now - m.t > STALE_MS) {
			m = { t: now, x: p.x, y: p.y, v: null };
		} else if (now - m.t >= MIN_SAMPLE_MS) {
			const dt = now - m.t;
			const v = { x: (p.x - m.x) / dt, y: (p.y - m.y) / dt };
			// Smoothed over the last frames, which arrive unevenly.
			m = { t: now, x: p.x, y: p.y, v: m.v ? { x: (m.v.x + v.x) / 2, y: (m.v.y + v.y) / 2 } : v };
		} else if (!m.v) {
			// Too soon after the movement's start to measure it: the jump a
			// drag makes as it begins stays out of its first speed.
			m = { t: now, x: p.x, y: p.y, v: null };
		}
		this._motion = m;
		// No velocity measured yet: a painting asked for now would reach
		// ahead of nothing, and hold back the one that does by the interval.
		if (!m.v || this._holdsView(map, this._velocity(now))) {
			return;
		}
		const wait = this._lastSendAt + MOTION_INTERVAL_MS - now;
		if (wait <= 0) {
			this._endTrailingRequest();
			this._askPainting();
			return;
		}
		if (this._trailing !== null) {
			return;
		}
		this._trailingDone = new Promise((resolve) => {
			this._endTrailing = resolve;
		});
		this._trailing = setTimeout(() => {
			this._trailing = null;
			const live = this._map;
			if (live && this._canvas && this._inMotionMode() && !this._holdsView(live, this._velocity(performance.now()))) {
				this._askPainting();
			}
			this._endTrailingRequest();
		}, wait);
	}

	/** Cancel the request waiting for the interval, if any, and let whenIdle
	 *  go on. */
	private _endTrailingRequest(): void {
		if (this._trailing !== null) {
			clearTimeout(this._trailing);
			this._trailing = null;
		}
		const end = this._endTrailing;
		this._endTrailing = null;
		this._trailingDone = null;
		end?.();
	}

	/** A painting was sent (made, here): the interval counts from it. */
	protected _noteSent(): void {
		this._lastSendAt = performance.now();
	}

	/** A painting sent at `sentAt` shows now: the latency average takes it. */
	protected _noteShown(sentAt: number): void {
		this._latencyMs += (Math.min(performance.now() - sentAt, LATENCY_CAP_MS) - this._latencyMs) / 5;
	}

	/** Whether a painting made at `ratio` may stand for a view moving at `v`:
	 *  here, only at the display's own. */
	protected _ratioHolds(ratio: number, _v: { x: number; y: number }): boolean {
		return ratio === (window.devicePixelRatio || 1);
	}

	/** Whether the newest painting covers the view now and, for a view moving
	 *  at `v`, as far ahead as it will go before a painting asked for now
	 *  could show. Its margins are not compared: a painting made ahead of a
	 *  glide covers the settle that ends it. */
	protected _holdsView(map: L.Map, v: { x: number; y: number }): boolean {
		const d = this._drawn;
		if (!d || !this._ratioHolds(d.dpr, v) || d.zoom !== map.getZoom() || !d.origin.equals(map.getPixelOrigin())) {
			return false;
		}
		const at = map.containerPointToLayerPoint([0, 0]);
		const size = map.getSize();
		const ahead = this._latencyMs * NEED_LATENCIES;
		const left = Math.max(0, -v.x) * ahead;
		const top = Math.max(0, -v.y) * ahead;
		return coversView(d, {
			x: at.x - left,
			y: at.y - top,
			w: size.x + left + Math.max(0, v.x) * ahead,
			h: size.y + top + Math.max(0, v.y) * ahead,
		});
	}

	redraw(): void {
		// An explicit repaint (a highlight, new data, a theme) always paints,
		// whatever the view.
		this._forcePaint = true;
		this._reset();
	}

	/** The paint prologue of a layer drawing a margin (the follow-mode
	 *  overscan, the lead ahead of a moving view): clear the whole canvas and
	 *  set the transform so container points draw where they belong (the
	 *  device pixel ratio, and the margin). */
	protected _beginPaint(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, dpr: number): void {
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.setTransform(dpr, 0, 0, dpr, this._margin.left * dpr, this._margin.top * dpr);
	}

	/** The container-point rectangle this paint covers: the viewport plus the
	 *  margin, for a layer's cull. */
	protected _paintExtent(map: L.Map): { x0: number; y0: number; x1: number; y1: number } {
		const size = map.getSize();
		return {
			x0: -this._margin.left,
			y0: -this._margin.top,
			x1: size.x + this._margin.right,
			y1: size.y + this._margin.bottom,
		};
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
			const sized = this._sized;
			this._sized = false;
			if (this._canvas && this._map) {
				this._paintAside = false;
				const start = performance.now();
				this._draw();
				const took = performance.now() - start;
				if (!sized && !this._paintAside) {
					const avg = this._paintAvgMs;
					this._paintAvgMs = avg === null ? took : avg + (took - avg) * PAINT_AVG_WEIGHT;
				}
				this._noteShown(this._lastSendAt);
			}
		});
	}

	/** Give the canvas its context. A subclass that presents bitmaps asks
	 *  for another kind. */
	protected _initContext(canvas: HTMLCanvasElement): void {
		this._ctx = canvas.getContext('2d');
	}

	/** The margin a paint made now draws beyond each side of a viewport of
	 *  `size`: the follow-mode overscan for a layer that opts in, else none,
	 *  widened by `lead`, what reaches ahead of a moving view (_leadFor). */
	protected _marginFor(size: L.Point, lead: Margin = NO_MARGIN): Margin {
		const rest = this.overscanned ? overscanFor(overscanPx, size) : NO_MARGIN;
		return hasMargin(lead) ? widerMargin(rest, lead) : rest;
	}

	/** While the map moves, what a paint made now reaches ahead of the view,
	 *  on the side it goes toward: as far as the view goes until the
	 *  painting's successor can show, and while the movement keeps going that
	 *  way, no less than the newest painting of it reached (keptLead). None at
	 *  rest. */
	protected _leadFor(size: L.Point): Margin {
		if (!this._inMotionMode()) {
			return NO_MARGIN;
		}
		const latency = this._latencyMs;
		const leadMs = (Math.max(latency, MOTION_INTERVAL_MS) + latency) * LEAD_FACTOR;
		const asked = leadMargins(this._velocity(performance.now()), leadMs, size, LEAD_CAP, LEAD_STEP, MIN_SPEED);
		return keptLead(this._lead, asked, size, LEAD_CAP);
	}

	/** A painting of `t` is being made: its lead is the newest (_leadFor). */
	protected _noteLead(t: CanvasTarget): void {
		this._lead = hasMargin(t.lead) ? t.lead : null;
	}

	/** The geometry a paint made now would have: the canvas corner at the
	 *  viewport's top-left less the margin, in layer points, whatever the pane
	 *  has drifted by during pans. Changes nothing: a placement takes it as
	 *  well as a painting, and only a painting notes its lead (_noteLead). */
	protected _target(map: L.Map): CanvasTarget {
		const size = map.getSize();
		const dpr = window.devicePixelRatio || 1;
		const viewTopLeft = map.containerPointToLayerPoint([0, 0]);
		const lead = this._leadFor(size);
		const margin = this._marginFor(size, lead);
		const cssW = size.x + margin.left + margin.right;
		const cssH = size.y + margin.top + margin.bottom;
		return {
			zoom: map.getZoom(),
			origin: map.getPixelOrigin(),
			pane: map.layerPointToContainerPoint([0, 0]),
			viewTopLeft,
			topLeft: viewTopLeft.subtract([margin.left, margin.top]),
			size,
			margin,
			lead,
			dpr,
			cssW,
			cssH,
			w: deviceSize(cssW, dpr),
			h: deviceSize(cssH, dpr),
		};
	}

	/** A pan that leaves the view inside the margin the last paint covers: the
	 *  canvas already sits in layer space under it, so nothing to paint. Same
	 *  zoom, pixel origin, size, ratio and margin, or it repaints. A layer
	 *  that paints while the map moves is covered by its newest painting, the
	 *  view as it stands (a view moving on asks at its next `move`), whatever
	 *  the margins: a painting made ahead of a glide covers the settle that
	 *  ends it. */
	protected _covered(t: CanvasTarget): boolean {
		const map = this._map;
		if (map && this.paintsInMotion()) {
			return this._holdsView(map, { x: 0, y: 0 });
		}
		const d = this._drawn;
		return (
			!!d &&
			hasMargin(t.margin) &&
			sameMargin(t.margin, d.margin) &&
			d.dpr === t.dpr &&
			d.zoom === t.zoom &&
			d.origin.equals(t.origin) &&
			d.w === t.cssW &&
			d.h === t.cssH &&
			coversView(d, { x: t.viewTopLeft.x, y: t.viewTopLeft.y, w: t.size.x, h: t.size.y })
		);
	}

	/** Place and size the canvas for a paint of `t`, and remember it. */
	protected _apply(canvas: HTMLCanvasElement, t: CanvasTarget): void {
		this._noteSent();
		this._noteLead(t);
		this._applied = t;
		L.DomUtil.setPosition(canvas, t.topLeft);
		this._drawState = { zoom: t.zoom, origin: t.origin, topLeft: t.topLeft };
		this._margin = t.margin;
		this._drawn = drawnRect(t);
		// Assigning width/height reallocates and clears the backing store, so
		// only when the size changed; _draw clears for itself. The CSS size is
		// compared apart: a browser zoom changes the ratio and the CSS size
		// together, and can leave the store as it was.
		if (canvas.width !== t.w || canvas.height !== t.h) {
			canvas.width = t.w;
			canvas.height = t.h;
			this._sized = true;
		}
		const box = cssBox(t);
		setCssSize(canvas, box.w, box.h);
	}

	protected _reset(): void {
		if (!this._canvas || !this._map) {
			return;
		}
		const force = this._forcePaint;
		this._forcePaint = false;
		const t = this._target(this._map);
		if (!force && this._covered(t)) {
			return;
		}
		this._apply(this._canvas, t);
		this._scheduleDraw();
	}
}
