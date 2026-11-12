/* symbolSprites.ts: a point symbol painted once for each of its looks and
 * each pixel ratio, then stamped wherever it is drawn.
 *
 * A symbol drawn as vectors costs its paths at every paint, and on the phone
 * the GPU pays for every fill and stroke on a raster thread it shares with
 * the worker's airspace painting and the compositor: the airports at Paris z8
 * took 2.9 ms a paint on the Redmi drawn as vectors and 1.2 ms stamped, and
 * painted through a 2000 px/s flick they left the airspace painting a strip
 * in half as many frames stamped as drawn.
 *
 * A sprite is painted with its anchor on a device pixel's corner and stamped
 * with that corner on the one nearest the symbol's position, texel on device
 * pixel, so nothing is resampled (the rule directDrawLayer.ts's cssBox keeps
 * for the canvases): a symbol lands up to half a device pixel from where its
 * vectors would have drawn it. Sprites are painted on a surface the browser
 * keeps in memory rather than on the GPU (willReadFrequently), so a lost GPU
 * context cannot blank them, and each is uploaded once.
 *
 * The caller names each look by a key that must say everything its painter
 * reads, and says how far the symbol reaches from its anchor. Where the
 * platform has no OffscreenCanvas to paint one on, stamp answers false and
 * the caller draws the vectors, as before sprites. Nothing is touched before
 * the first stamp. */

import type { Margin } from './canvasPlacement';
import type { Paint2D } from './symbolBase';

/** A paint's transform: CSS (0, 0) falls on device (x, y) of the canvas, and
 *  `ratio` device px make a CSS px (DirectDrawLayer._beginPaint). */
export interface DeviceFrame {
	ratio: number;
	x: number;
	y: number;
}

interface Sprite {
	image: CanvasImageSource;
	/** Its size, device px. */
	w: number;
	h: number;
	/** The corner its symbol's anchor sits on, device px from its top-left. */
	ax: number;
	ay: number;
}

/** The looks painted so far for one pixel ratio, by key. */
type Looks = Map<string, Sprite>;

export class SymbolSprites {
	private readonly byRatio = new Map<number, Looks>();
	// Insertion order, for the cap: the oldest look goes first.
	private readonly order: { looks: Looks; key: string }[] = [];
	// The surface a sprite is painted on; undefined until first asked for,
	// null where the platform has none.
	private surface: { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | null | undefined;

	/** At most `max` looks are kept, all ratios together; past it the oldest
	 *  is dropped (never closed: a paint may still hold it) and painted again
	 *  if asked for. */
	constructor(private readonly max = 512) {}

	/** Draw the look `key` names on `ctx`, whose transform is `dev`, its
	 *  anchor at (x, y), CSS px; painted first by `paint`, its anchor at the
	 *  origin, if this ratio has not seen it. `reach` is how far the symbol
	 *  reaches from its anchor, CSS px. False when no sprite can be made here,
	 *  nothing drawn. */
	stamp(
		ctx: Paint2D,
		key: string,
		reach: Margin,
		paint: (c: Paint2D) => void,
		x: number,
		y: number,
		dev: DeviceFrame,
	): boolean {
		let looks = this.byRatio.get(dev.ratio);
		let sprite = looks?.get(key);
		if (!sprite) {
			const made = this.make(reach, paint, dev.ratio);
			if (!made) {
				return false;
			}
			sprite = made;
			if (!looks) {
				looks = new Map();
				this.byRatio.set(dev.ratio, looks);
			}
			if (this.order.length >= this.max) {
				const old = this.order.shift();
				old?.looks.delete(old.key);
			}
			looks.set(key, sprite);
			this.order.push({ looks, key });
		}
		// The device pixel corner nearest the position, less the anchor's
		// place in the sprite: its top-left, a whole device pixel, in CSS
		// px through the paint's transform.
		const px = Math.round(dev.ratio * x + dev.x) - sprite.ax;
		const py = Math.round(dev.ratio * y + dev.y) - sprite.ay;
		ctx.drawImage(
			sprite.image,
			(px - dev.x) / dev.ratio,
			(py - dev.y) / dev.ratio,
			sprite.w / dev.ratio,
			sprite.h / dev.ratio,
		);
		return true;
	}

	/** A sprite of `paint` at `ratio`: its anchor on a device pixel's corner
	 *  one pixel in from the reach, the antialiased fringe's room. */
	private make(reach: Margin, paint: (c: Paint2D) => void, ratio: number): Sprite | null {
		const s = this.surfaceOf();
		if (!s) {
			return null;
		}
		const ax = Math.ceil(reach.left * ratio) + 1;
		const ay = Math.ceil(reach.top * ratio) + 1;
		const w = ax + Math.ceil(reach.right * ratio) + 1;
		const h = ay + Math.ceil(reach.bottom * ratio) + 1;
		// A size write clears the surface and its state.
		s.canvas.width = w;
		s.canvas.height = h;
		s.ctx.setTransform(ratio, 0, 0, ratio, ax, ay);
		paint(s.ctx);
		return { image: s.canvas.transferToImageBitmap(), w, h, ax, ay };
	}

	private surfaceOf(): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | null {
		if (this.surface !== undefined) {
			return this.surface;
		}
		this.surface = null;
		try {
			if (typeof OffscreenCanvas === 'function' && typeof OffscreenCanvas.prototype.transferToImageBitmap === 'function') {
				const canvas = new OffscreenCanvas(1, 1);
				const ctx = canvas.getContext('2d', { willReadFrequently: true });
				if (ctx) {
					this.surface = { canvas, ctx };
				}
			}
		} catch {
			// No surface here: the caller draws the vectors.
		}
		return this.surface;
	}
}
