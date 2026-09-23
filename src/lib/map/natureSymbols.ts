/* natureSymbols.ts draws the prohibited-low-overflight point glyphs, in the
 * same canvas style as the navaid symbols (white halo for basemap contrast).
 * All use the SIA 500k chart red; the SHAPE distinguishes the category:
 *
 *   NATURE (PRN)     an OPEN ring + centre dot ("park or nature reserve").
 *   SENSITIVE (SUR)  a FILLED square + white circle + centre dot ("site with
 *                    special marking of prohibited low overflying").
 *   BIRD             Belgian eAIP ENR 5.6 bird concentration areas:
 *                    INTENTIONALLY reuses the NATURE bullseye (no dedicated
 *                    chart glyph; the Layers toggle separates the family). */

import type { NatureType } from '$lib/data/nature';
import { SIA } from './palette';
import { haloStroke, HALO } from './symbolBase';

/** The SIA 500k chart red (SIA.zone, the same ink as the airspace R / D
 *  boundaries): the Legende2026 legend prints the parc/reserve bullseye in
 *  the chart red #E30613, while AIP France GEN 2.3 prints it magenta
 *  #DF0051. Two official sources disagree; DECISION: the 500k chart red
 *  wins (recorded in docs/airspace-symbology.md). All families share it;
 *  the glyph SHAPE, not the colour, tells them apart. */
export const NATURE_COLOR: Record<NatureType, string> = {
	NATURE: SIA.zone,
	SENSITIVE: SIA.zone,
	BIRD: SIA.zone,
};

/** Glyph half-extent (px), for drawing and hit-testing. */
export function natureSymbolSize(): number {
	return 8;
}

/** Draw the glyph centred at (x, y). `s` is the half-extent; `selected`
 *  thickens it (the caller also enlarges `s` for the selection). */
export function drawNatureSymbol(
	ctx: CanvasRenderingContext2D,
	type: NatureType,
	x: number,
	y: number,
	s: number,
	selected = false,
): void {
	const color = NATURE_COLOR[type];
	ctx.lineJoin = 'round';

	if (type === 'SENSITIVE') {
		// Filled chart-red square (haloed for basemap contrast) + white circle
		// + chart-red centre dot.
		const h = s * 0.92;
		const square = new Path2D();
		square.rect(x - h, y - h, h * 2, h * 2);
		ctx.strokeStyle = HALO;
		ctx.lineWidth = selected ? 3 : 2;
		ctx.stroke(square);
		ctx.fillStyle = color;
		ctx.fill(square);
		const white = new Path2D();
		white.arc(x, y, s * 0.64, 0, Math.PI * 2);
		ctx.fillStyle = '#fff';
		ctx.fill(white);
		const dot = new Path2D();
		dot.arc(x, y, s * 0.24, 0, Math.PI * 2);
		ctx.fillStyle = color;
		ctx.fill(dot);
		return;
	}

	// NATURE: an open chart-red bullseye - ring outline + filled centre dot.
	const lw = selected ? 2.6 : 1.8;
	const ring = new Path2D();
	ring.arc(x, y, s * 0.85, 0, Math.PI * 2);
	haloStroke(ctx, ring, color, lw);
	const dot = new Path2D();
	dot.arc(x, y, s * 0.32, 0, Math.PI * 2);
	ctx.strokeStyle = HALO;
	ctx.lineWidth = 2;
	ctx.stroke(dot);
	ctx.fillStyle = color;
	ctx.fill(dot);
}
