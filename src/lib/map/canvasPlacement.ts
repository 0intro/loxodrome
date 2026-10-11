/* canvasPlacement.ts: where a painting made for one view goes under another,
 * and whether it still covers the view. The arithmetic behind the zoom
 * animation of every canvas layer (canvasZoom.ts), the follow-mode overscan
 * skip (directDrawLayer.ts), and the placement of a painting that arrives, or
 * waits, while the map has moved on (bitmapDrawLayer.ts). Pure. */

/** The view a painting was made for. */
export interface PaintedView {
	/** Map zoom at paint time. */
	zoom: number;
	/** Map pixel origin at paint time: set by a view reset or a zoom and left
	 *  alone by a pan, which moves the map pane instead. */
	origin: { x: number; y: number };
	/** The painting's corner in layer points, at that origin: the canvas corner
	 *  in projected pixels is origin + topLeft. */
	topLeft: { x: number; y: number };
}

/** The translate that puts a painting made for `painted` where Leaflet puts a
 *  tile level whose origin is the painting's corner (GridLayer.
 *  _setZoomTransform), under a view whose pixel origin is `origin` and at
 *  `scale` times the painting's zoom (map.getZoomScale(zoom, painted.zoom)).
 *  Unrounded, like Renderer._updateTransform. At the painted view itself (scale
 *  1, same origin) it is the painting's own corner. */
export function paintingOffset(
	painted: PaintedView,
	scale: number,
	origin: { x: number; y: number },
): { x: number; y: number } {
	return {
		x: (painted.origin.x + painted.topLeft.x) * scale - origin.x,
		y: (painted.origin.y + painted.topLeft.y) * scale - origin.y,
	};
}

/** Whether a drawn rectangle still covers the view (both in layer points):
 *  the test that lets a moveend skip its repaint. */
export function coversView(
	drawn: { x: number; y: number; w: number; h: number },
	view: { x: number; y: number; w: number; h: number },
): boolean {
	return (
		view.x >= drawn.x &&
		view.y >= drawn.y &&
		view.x + view.w <= drawn.x + drawn.w &&
		view.y + view.h <= drawn.y + drawn.h
	);
}

/** A rectangle by its corner and size. */
export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** The parts of `a` outside `b`, as up to four rectangles that do not
 *  overlap: the band above `b` and the band below it across all of `a`, then
 *  the bands left and right of it between those; `a` itself when they do not
 *  meet. What a painting that keeps the one before it, moved along, still
 *  has to paint. */
export function rectMinus(a: Rect, b: Rect): Rect[] {
	const x0 = Math.max(a.x, b.x);
	const y0 = Math.max(a.y, b.y);
	const x1 = Math.min(a.x + a.w, b.x + b.w);
	const y1 = Math.min(a.y + a.h, b.y + b.h);
	if (x0 >= x1 || y0 >= y1) {
		return [a];
	}
	const out: Rect[] = [];
	if (y0 > a.y) {
		out.push({ x: a.x, y: a.y, w: a.w, h: y0 - a.y });
	}
	if (y1 < a.y + a.h) {
		out.push({ x: a.x, y: y1, w: a.w, h: a.y + a.h - y1 });
	}
	if (x0 > a.x) {
		out.push({ x: a.x, y: y0, w: x0 - a.x, h: y1 - y0 });
	}
	if (x1 < a.x + a.w) {
		out.push({ x: x1, y: y0, w: a.x + a.w - x1, h: y1 - y0 });
	}
	return out;
}

/** What a painting draws beyond each side of the viewport, CSS px. */
export interface Margin {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export const NO_MARGIN: Readonly<Margin> = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 });

/** Whether a margin draws anything beyond the viewport. */
export function hasMargin(m: Margin): boolean {
	return m.left > 0 || m.top > 0 || m.right > 0 || m.bottom > 0;
}

export function sameMargin(a: Margin, b: Margin): boolean {
	return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

/** The larger of two margins, side by side. */
export function widerMargin(a: Margin, b: Margin): Margin {
	return {
		left: Math.max(a.left, b.left),
		top: Math.max(a.top, b.top),
		right: Math.max(a.right, b.right),
		bottom: Math.max(a.bottom, b.bottom),
	};
}

/** The margin actually drawn on every side: the requested one, capped at a
 *  quarter of the viewport on its axis, so a small view never paints more
 *  margin than map for the re-centres it saves. */
export function overscanFor(requestedPx: number, size: { x: number; y: number }): Margin {
	const x = Math.max(0, Math.min(requestedPx, Math.floor(size.x * 0.25)));
	const y = Math.max(0, Math.min(requestedPx, Math.floor(size.y * 0.25)));
	return { left: x, top: y, right: x, bottom: y };
}

/** The margin a painting made while the map moves draws on the sides the
 *  view moves toward, so that what it covers still holds the view when the
 *  next painting can replace it: the view's speed there (CSS px per ms, the
 *  view over the map, so a view going east has a positive x) times `leadMs`,
 *  at most `cap` of the viewport on its axis, rounded up to a whole number
 *  of `step` so a steady glide asks for the same canvas painting after
 *  painting. Nothing on a side the view moves away from, nor below
 *  `minSpeed`. Pure. */
export function leadMargins(
	velocity: { x: number; y: number },
	leadMs: number,
	size: { x: number; y: number },
	cap: number,
	step: number,
	minSpeed = 0,
): Margin {
	const side = (speed: number, span: number): number => {
		if (speed <= minSpeed) {
			return 0;
		}
		const px = Math.min(speed * leadMs, span * cap);
		return Math.min(Math.ceil(px / step) * step, Math.floor(span * cap));
	};
	return {
		left: side(-velocity.x, size.x),
		top: side(-velocity.y, size.y),
		right: side(velocity.x, size.x),
		bottom: side(velocity.y, size.y),
	};
}

/** The lead of a painting made while the view moves, given `cur`, what its
 *  speed asks for now, and `prev`, the lead of the newest painting of the
 *  same movement: on each side the view still goes toward, the larger of the
 *  two, so a speed that wavers from one sample to the next does not size the
 *  canvas anew painting after painting (a store that grows is reallocated,
 *  15 to 21 ms on the phone); on a side it no longer goes toward, none, so a
 *  reversal does not keep both. At most `cap` of the viewport on its axis,
 *  as leadMargins caps, the viewport having perhaps shrunk since. Pure. */
export function keptLead(prev: Margin | null, cur: Margin, size: { x: number; y: number }, cap: number): Margin {
	if (!prev) {
		return cur;
	}
	const side = (was: number, now: number, span: number): number => (now > 0 ? Math.min(Math.max(was, now), Math.floor(span * cap)) : 0);
	return {
		left: side(prev.left, cur.left, size.x),
		top: side(prev.top, cur.top, size.y),
		right: side(prev.right, cur.right, size.x),
		bottom: side(prev.bottom, cur.bottom, size.y),
	};
}

/** A painting shown scaled past this factor either way reads as noise, not as
 *  the map: better nothing until its successor lands. */
export const MAX_PAINTING_SCALE = 4;

/** Whether a painting made at `paintedZoom` may stand in at `zoom`. */
export function paintingUsable(paintedZoom: number, zoom: number): boolean {
	return Math.abs(zoom - paintedZoom) <= Math.log2(MAX_PAINTING_SCALE);
}
