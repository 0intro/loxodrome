/* bitmapDrawLayer.ts: a DirectDrawLayer whose paintings are made away from the
 * canvas that shows them, on an OffscreenCanvas, and shown whole through a
 * `bitmaprenderer` context, one ImageBitmap at a time.
 *
 * What that buys is a canvas that always shows a finished painting, placed for
 * the view it was made for. While the next one is made, the current one stays,
 * placed for wherever the map has gone: a pan needs nothing, the canvas riding
 * the pane; a zoom or a view reset places it the way Leaflet places a tile
 * level (canvasPlacement.ts), and past four times either way it hides. A
 * painting shows in one task: the canvas sized to it, the bitmap transferred,
 * its view recorded, and it placed for the current one. What is sent and what
 * is shown is paintScheduler.ts's business, held from a zoom's start to its
 * settle.
 *
 * The painting is made here, on the page, by the subclass's _paintTarget; a
 * worker can make it instead, which is what the split is for. Where the
 * platform lacks what this needs (OffscreenCanvas with transferToImageBitmap,
 * a bitmaprenderer context), the layer is the DirectDrawLayer it extends and
 * _paintTarget paints the canvas itself: `direct` mode.
 *
 * A layer whose paintings are made off the main thread (paintsInMotion,
 * bitmap mode only) paints while the map moves as directDrawLayer.ts says:
 * its request goes to the scheduler, its newest painting (on its way or on
 * screen) is what covers the view, and its latency is measured from the send
 * to the show.
 *
 * On a screen denser than MOTION_RATIO (a phone's 2.75), a painting made
 * while the view moves fast is made at that ratio: half the pixels, so the
 * first painting that reaches ahead of a flick shows that much sooner. The
 * view never comes to rest on one. A slower view takes paintings at the full
 * ratio again (the last of a flick's inertia among them), a settle repaints
 * a lighter painting still on screen, and so does a drag held still once
 * the view has stopped. */

import L from 'leaflet';
import { paintingOffset, paintingUsable } from './canvasPlacement';
import { cssBox, deviceSize, DirectDrawLayer, drawnRect, setCssSize, STALE_MS, type CanvasTarget } from './directDrawLayer';
import { PaintScheduler } from './paintScheduler';
import type { Paint2D } from './symbolBase';

export type PaintMode = 'bitmap' | 'direct';

/** The ratio a painting made while the view moves fast is made at, on a
 *  denser screen. */
const MOTION_RATIO = 2;
/** Above this speed, CSS px per ms, the view moves fast: slower, a painting
 *  at the full ratio keeps up on the phone (no strip at 500 px/s). */
const FAST_SPEED = 0.6;

/** A painting that landed: its bitmap (null for a painting that draws
 *  nothing, or a canvas with no area) and the view it was made for. */
export interface Painting {
	bitmap: ImageBitmap | null;
	target: CanvasTarget;
}

/** Whether the platform can make paintings off screen and show them whole. */
export function bitmapPaintingSupported(): boolean {
	return (
		typeof OffscreenCanvas === 'function' &&
		typeof OffscreenCanvas.prototype.transferToImageBitmap === 'function' &&
		typeof ImageBitmapRenderingContext === 'function'
	);
}

export abstract class BitmapDrawLayer extends DirectDrawLayer {
	private _mode: PaintMode = 'direct';
	private _display: ImageBitmapRenderingContext | null = null;
	private _offscreen: { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | null = null;
	// When each painting was sent, for the latency.
	private readonly _sentAt = new WeakMap<CanvasTarget, number>();
	// Whether the view has stopped under a painting at the lighter ratio.
	private _restCheck: ReturnType<typeof setTimeout> | null = null;
	// The painting on screen draws nothing: the canvas holds a pixel, hidden,
	// until a painting that draws something shows.
	private _blank = false;
	protected readonly _scheduler = new PaintScheduler<Painting>({
		send: (seq) => {
			this._send(seq);
		},
		present: (p) => {
			this._present(p);
		},
		discard: (p) => {
			p.bitmap?.close();
		},
	});

	/** Paint the view `t` onto `ctx`, a canvas `t.w` x `t.h` device px: the
	 *  whole of it, cleared first. */
	protected abstract _paintTarget(ctx: Paint2D, canvas: { width: number; height: number }, t: CanvasTarget): void;

	/** Which way this layer paints, settled when it is added to a map. */
	get mode(): PaintMode {
		return this._mode;
	}

	/** Resolves once the painting asked for has shown: the scheduler's
	 *  business in bitmap mode. */
	protected override _paintIdle(): Promise<void> {
		return this._mode === 'bitmap' ? this._scheduler.whenIdle() : super._paintIdle();
	}

	protected override _initContext(canvas: HTMLCanvasElement): void {
		const display = bitmapPaintingSupported() ? canvas.getContext('bitmaprenderer') : null;
		if (display) {
			this._mode = 'bitmap';
			this._display = display;
			this._ctx = null;
			return;
		}
		this._mode = 'direct';
		super._initContext(canvas);
	}

	/** The scheduler lets go of its hold before the settle asks. */
	protected override _settle(e: L.LeafletEvent): void {
		this._scheduler.release();
		super._settle(e);
	}

	/** Nothing is sent or shown while a zoom runs. */
	protected override _zoomStart(): void {
		this._scheduler.hold();
		super._zoomStart();
		this._endRestCheck();
	}

	override onRemove(map: L.Map): this {
		this._endRestCheck();
		this._blank = false;
		this._scheduler.reset();
		this._display = null;
		this._offscreen = null;
		return super.onRemove(map);
	}

	/** Painting while the map moves: in bitmap mode only, the page never
	 *  making a painting of its own in a move's frames. */
	protected override _inMotionMode(): boolean {
		return this._mode === 'bitmap' && super._inMotionMode();
	}

	/** Asked through the scheduler in bitmap mode, and sent at once: the
	 *  worker starts on it while the page paints its own layers. */
	protected override _askPainting(): void {
		if (this._mode === 'bitmap') {
			this._scheduler.requestNow();
			return;
		}
		super._askPainting();
	}

	/** A painting at the full ratio holds; one at the lighter ratio only
	 *  while the view moves fast, so a view slowing down or stopped takes a
	 *  sharp one. */
	protected override _ratioHolds(ratio: number, v: { x: number; y: number }): boolean {
		return super._ratioHolds(ratio, v) || ratio === this._ratioFor(v);
	}

	/** The ratio a painting made for a view moving at `v` is made at. */
	private _ratioFor(v: { x: number; y: number }): number {
		const full = window.devicePixelRatio || 1;
		return full > MOTION_RATIO && this._inMotionMode() && Math.hypot(v.x, v.y) > FAST_SPEED ? MOTION_RATIO : full;
	}

	/** The view as a painting made now takes it: at the lighter ratio while
	 *  the view moves fast on a denser screen. */
	protected override _target(map: L.Map): CanvasTarget {
		const t = super._target(map);
		const ratio = this._ratioFor(this._velocity(performance.now()));
		return ratio === t.dpr ? t : { ...t, dpr: ratio, w: deviceSize(t.cssW, ratio), h: deviceSize(t.cssH, ratio) };
	}

	/** After a painting at the lighter ratio: once the view has stopped under
	 *  it (a drag held still, no `move` to say so), one at the full ratio. */
	private _armRestCheck(): void {
		this._endRestCheck();
		this._restCheck = setTimeout(() => {
			this._restCheck = null;
			const d = this._drawn;
			if (!this._map || !this._canvas || !d || d.dpr === (window.devicePixelRatio || 1) || this._scheduler.holding) {
				return;
			}
			const m = this._motion;
			if (m && performance.now() - m.t <= STALE_MS) {
				// Still moving: its moves decide.
				this._armRestCheck();
				return;
			}
			this._scheduler.request();
		}, STALE_MS + 10);
	}

	private _endRestCheck(): void {
		if (this._restCheck !== null) {
			clearTimeout(this._restCheck);
			this._restCheck = null;
		}
	}

	/** Covered by the newest painting, on its way or on screen, the view as
	 *  it stands; the base's own test in direct mode. */
	protected override _covered(t: CanvasTarget): boolean {
		const map = this._map;
		if (this._mode !== 'bitmap' || !map) {
			return super._covered(t);
		}
		return this._holdsView(map, { x: 0, y: 0 });
	}

	protected override _draw(): void {
		const ctx = this._ctx;
		const canvas = this._canvas;
		const t = this._applied;
		if (ctx && canvas && t) {
			this._paintTarget(ctx, canvas, t);
		}
	}

	protected override _reset(): void {
		if (this._mode !== 'bitmap') {
			super._reset();
			return;
		}
		const map = this._map;
		if (!this._canvas || !map) {
			return;
		}
		const force = this._forcePaint;
		this._forcePaint = false;
		const t = this._target(map);
		this._place(t);
		if (!force && this._covered(t)) {
			return;
		}
		this._scheduler.request();
	}

	/** Send painting `seq`: the view is taken now. */
	private _send(seq: number): void {
		const map = this._map;
		if (!map || !this._canvas) {
			this._scheduler.failed(seq);
			return;
		}
		const t = this._target(map);
		this._drawn = drawnRect(t);
		this._margin = t.margin;
		this._noteLead(t);
		this._noteSent();
		this._sentAt.set(t, performance.now());
		if (t.dpr !== (window.devicePixelRatio || 1)) {
			this._armRestCheck();
		}
		if (t.w <= 0 || t.h <= 0) {
			this._scheduler.arrived(seq, { bitmap: null, target: t });
			return;
		}
		this._paint(seq, t);
	}

	/** Make painting `seq` of `t` and hand it to the scheduler, landed or
	 *  failed. Here on the page, at once; a worker makes it later. */
	protected _paint(seq: number, t: CanvasTarget): void {
		const off = this._offscreenOf(t.w, t.h);
		if (!off) {
			this._scheduler.failed(seq);
			return;
		}
		try {
			this._paintTarget(off.ctx, off.canvas, t);
		} catch (err) {
			// A paint that throws must not leave its painting in flight for
			// ever, which would wedge the layer: it is owed again, and the
			// error still reaches the console.
			this._scheduler.failed(seq);
			throw err;
		}
		this._scheduler.arrived(seq, { bitmap: off.canvas.transferToImageBitmap(), target: t });
	}

	/** Show a painting, in one task: sized, transferred, recorded, placed. */
	private _present(p: Painting): void {
		const canvas = this._canvas;
		const display = this._display;
		const map = this._map;
		if (!canvas || !display || !map) {
			p.bitmap?.close();
			return;
		}
		const t = p.target;
		if (p.bitmap === null) {
			this._presentBlank(canvas, display, t);
			return;
		}
		const sentAt = this._sentAt.get(t);
		if (sentAt !== undefined) {
			this._noteShown(sentAt);
		}
		this._blank = false;
		L.DomUtil.setPosition(canvas, t.topLeft);
		// The canvas takes the bitmap's own size BEFORE the transfer (a size
		// write resets its output): html2canvas, the PDF export, reads a
		// canvas through its width and height.
		if (canvas.width !== t.w || canvas.height !== t.h) {
			canvas.width = t.w;
			canvas.height = t.h;
		}
		const box = cssBox(t);
		setCssSize(canvas, box.w, box.h);
		display.transferFromImageBitmap(p.bitmap);
		this._drawState = { zoom: t.zoom, origin: t.origin, topLeft: t.topLeft };
		this._place(this._target(map));
	}

	/** Show a painting that draws nothing: a canvas with no store, hidden.
	 *  A null transfer is answered with a transparent bitmap of the canvas's
	 *  size, a few megabytes at a view a lead widens, made, uploaded and
	 *  composited for nothing at every such painting: so the canvas is shrunk
	 *  to a pixel first, once, and only the view is recorded after that. It
	 *  took no time to make, so its latency is none of the average's. */
	private _presentBlank(canvas: HTMLCanvasElement, display: ImageBitmapRenderingContext, t: CanvasTarget): void {
		if (!this._blank) {
			this._blank = true;
			if (canvas.width !== 1 || canvas.height !== 1) {
				canvas.width = 1;
				canvas.height = 1;
			}
			display.transferFromImageBitmap(null);
		}
		canvas.style.visibility = 'hidden';
		this._drawState = { zoom: t.zoom, origin: t.origin, topLeft: t.topLeft };
	}

	/** Place the painting on screen for the view `t`; a blank one stays
	 *  hidden. */
	private _place(t: CanvasTarget): void {
		const canvas = this._canvas;
		const st = this._drawState;
		const map = this._map;
		if (!canvas || !st || !map) {
			return;
		}
		if (this._blank) {
			canvas.style.visibility = 'hidden';
			return;
		}
		if (st.zoom === t.zoom && st.origin.equals(t.origin)) {
			L.DomUtil.setPosition(canvas, st.topLeft);
			canvas.style.visibility = '';
			return;
		}
		if (!paintingUsable(st.zoom, t.zoom)) {
			canvas.style.visibility = 'hidden';
			return;
		}
		const scale = map.getZoomScale(t.zoom, st.zoom);
		const at = paintingOffset(st, scale, t.origin);
		L.DomUtil.setTransform(canvas, L.point(at.x, at.y), scale);
		canvas.style.visibility = '';
	}

	/** Let go of the page's own painting canvas, its store freed at once: a
	 *  worker paints in its place. A page painting after this makes it
	 *  again. */
	protected _releasePageCanvas(): void {
		if (this._offscreen) {
			this._offscreen.canvas.width = 0;
			this._offscreen.canvas.height = 0;
			this._offscreen = null;
		}
	}

	private _offscreenOf(w: number, h: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | null {
		if (!this._offscreen) {
			const canvas = new OffscreenCanvas(w, h);
			const ctx = canvas.getContext('2d');
			if (!ctx) {
				return null;
			}
			this._offscreen = { canvas, ctx };
		} else if (this._offscreen.canvas.width !== w || this._offscreen.canvas.height !== h) {
			this._offscreen.canvas.width = w;
			this._offscreen.canvas.height = h;
		}
		return this._offscreen;
	}
}
