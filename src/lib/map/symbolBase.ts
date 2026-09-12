/* symbolBase.ts holds the shared drawing primitives for the map's
 * cartographic point symbols (navaids in navaidSymbols.ts, airports in
 * airportSymbols.ts). Both families paint a white halo underneath a
 * coloured stroke/fill so the glyph stays legible on dark, satellite, and
 * topo basemaps, and share the same centre-dot reference mark. Keeping
 * these in one module guarantees the two symbol sets render in an
 * identical style. */

import { CUE_RING, HALO } from './palette';

// Re-exported so the point-symbol modules keep their established import.
export { HALO };

/** Stroke `path` with a white halo at `lw + 2`, then the colour at `lw`. */
export function haloStroke(
	ctx: CanvasRenderingContext2D,
	path: Path2D,
	color: string,
	lw: number,
): void {
	ctx.lineJoin = 'round';
	ctx.strokeStyle = HALO;
	ctx.lineWidth = lw + 2;
	ctx.stroke(path);
	ctx.strokeStyle = color;
	ctx.lineWidth = lw;
	ctx.stroke(path);
}

/** Outline `path` with a thin white halo, then fill it with `color`. */
export function haloFill(
	ctx: CanvasRenderingContext2D,
	path: Path2D,
	color: string,
): void {
	ctx.lineJoin = 'round';
	ctx.strokeStyle = HALO;
	ctx.lineWidth = 2;
	ctx.stroke(path);
	ctx.fillStyle = color;
	ctx.fill(path);
}

/** Filled reference dot at the glyph centre, sized from the glyph extent. */
export function centreDot(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	s: number,
	color: string,
): void {
	const p = new Path2D();
	const r = Math.max(1.1, s * 0.17);
	p.arc(x, y, r, 0, Math.PI * 2);
	ctx.fillStyle = color;
	ctx.fill(p);
}

/** Red "has active NOTAM" cue ring stroked around a symbol of the given
 *  half-extent, shared by the airport / navaid / obstacle layers. */
export function drawCue(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	baseSize: number,
): void {
	ctx.beginPath();
	ctx.arc(x, y, baseSize + 5, 0, Math.PI * 2);
	ctx.lineWidth = 2;
	ctx.strokeStyle = CUE_RING;
	ctx.stroke();
}
