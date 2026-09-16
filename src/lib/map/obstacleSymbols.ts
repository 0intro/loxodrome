/* obstacleSymbols.ts draws the Legende2026 obstacle symbology onto a 2D
 * canvas context (the glyph outlines are contour traces of the legend's
 * lossless 600 dpi raster, generated into obstacleGlyphData.ts):
 *
 *   caret        obstacle 300-500 ft AGL: open chevron + base dot
 *   towerHigh    obstacle >= 500 ft AGL: the curved-flank tower + base dot
 *   turbine      wind turbine (mast + hub + three blades)
 *   groundLight  aeronautical ground light (the 5-point star with the
 *                white-centre knockout); keys on the `lighthouse` type
 *   rays         "balise de nuit" marks for lit obstacles: five dashes
 *                fanned over the glyph top (parametric; measured off the
 *                legend's lit samples)
 *
 * Everything prints in the legend's single obstacle ink, the chart navy
 * #164194 (the same flat sample as the radionav family and SIA.ctl). The
 * group-of-obstacles variants (two overlapped carets / towers) are NOT
 * drawn: the datasets carry individual point rows, so every obstacle draws
 * its own symbol (documented deviation). A white halo keeps the marks
 * legible on any basemap, like the other canvas symbol layers. */

import type { Obstacle } from '$lib/data/obstacles';
import { OBSTACLE_GLYPH_ART, type ObstacleGlyphKind } from './obstacleGlyphData';
import { OBSTACLE_INK } from './palette';
import { HALO } from './symbolBase';

// The legend's obstacle ink lives in palette.ts (identical to SIA.ctl);
// re-exported for the layer and specs.
export { OBSTACLE_INK };

/** Base glyph half-extent in px (the unit frame's larger half maps to
 *  this, scaled by the per-kind multiplier below). */
export function obstacleSymbolSize(): number {
	return 7;
}

/** The legend prints the high-obstacle tower and the wind turbine notably
 *  larger than the low caret (178 / 176 / 123 px tall at 600 dpi); the
 *  ground-light star is the smallest mark. */
const SIZE_MULT: Record<ObstacleGlyphKind, number> = {
	caret: 1,
	towerHigh: 1.3,
	turbine: 1.3,
	groundLight: 0.85,
};

/** AGL height (ft) from which the legend switches to the high-obstacle
 *  tower ("obstacles eleves, >= 500 AGL"). */
const HIGH_OBSTACLE_FT = 500;

/** Which glyph an obstacle row draws. */
export function obstacleGlyphKind(
	o: Pick<Obstacle, 'type' | 'hgt'>,
): ObstacleGlyphKind {
	if (o.type === 'windturbine') {
		return 'turbine';
	}
	if (o.type === 'lighthouse') {
		return 'groundLight';
	}
	return (o.hgt ?? 0) >= HIGH_OBSTACLE_FT ? 'towerHigh' : 'caret';
}

interface BuiltPart {
	path: Path2D;
	rule: CanvasFillRule;
}

// Unit-space Path2D objects, built once per kind on first draw (plain
// module-level cache; this is a .ts module, not reactive state).
const built = new Map<ObstacleGlyphKind, BuiltPart[]>();

function partsFor(kind: ObstacleGlyphKind): BuiltPart[] {
	let parts = built.get(kind);
	if (!parts) {
		parts = OBSTACLE_GLYPH_ART[kind].parts.map((p) => ({
			path: new Path2D(p.d),
			rule: (p.eo ? 'evenodd' : 'nonzero') satisfies CanvasFillRule,
		}));
		built.set(kind, parts);
	}
	return parts;
}

/** Extra stroke width (css px) of the white halo around the ink. */
const HALO_PX = 2;

/** The lit-obstacle ray marks, laid out exactly as the legend's "balise de
 *  nuit" samples (measured at 600 dpi, in fractions of the glyph height H):
 *  a vertical dash straight above the apex (0.17H..0.52H up), two 45-degree
 *  dashes leaving the apex flanks, and two horizontals at 0.22H below the
 *  apex flanking wide. `topY` is the glyph's top edge relative to the
 *  centre; `h` the glyph's full drawn height. */
function raysPath(x: number, y: number, topY: number, h: number): Path2D {
	const p = new Path2D();
	const ax = x;
	const ay = y + topY;
	// vertical
	p.moveTo(ax, ay - 0.17 * h);
	p.lineTo(ax, ay - 0.52 * h);
	for (const side of [-1, 1]) {
		// diagonal at 45 degrees from the apex flank
		p.moveTo(ax + side * 0.23 * h, ay);
		p.lineTo(ax + side * 0.52 * h, ay - 0.29 * h);
		// horizontal, level just below the apex
		p.moveTo(ax + side * 0.25 * h, ay + 0.22 * h);
		p.lineTo(ax + side * 0.6 * h, ay + 0.22 * h);
	}
	return p;
}

/* The Legende2026 prints an italic navy CABLE word beside transporter
 * cables and captive balloons (type 'cable'), the same house style as the
 * winch-zone CABLE label in airspaceDecoLayer.ts. Locale-invariant chart
 * token: canvas modules never import the i18n catalogs. */
// i18n-ignore-start: invariant chart token + CSS font shorthand, not display text
const CABLE_TEXT = 'CABLE';
const CABLE_FONT = 'italic bold 11px system-ui, sans-serif';
// i18n-ignore-end

/** Draw the chart's italic CABLE mark beside a cable obstacle's symbol
 *  (to the right of the glyph, vertically centred); `s` is the symbol
 *  half-extent the layer drew the glyph with. */
export function drawCableMark(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	s: number,
): void {
	ctx.save();
	ctx.font = CABLE_FONT;
	ctx.textAlign = 'left';
	ctx.textBaseline = 'middle';
	ctx.lineJoin = 'round';
	ctx.strokeStyle = HALO;
	ctx.lineWidth = 3;
	const tx = x + s + 3;
	ctx.strokeText(CABLE_TEXT, tx, y);
	ctx.fillStyle = OBSTACLE_INK;
	ctx.fillText(CABLE_TEXT, tx, y);
	ctx.restore();
}

/** Draw the obstacle symbol centred at (x, y); `s` is the half-extent
 *  (see obstacleSymbolSize; the layer passes a larger value for the
 *  selection highlight). */
export function drawObstacleSymbol(
	ctx: CanvasRenderingContext2D,
	o: Pick<Obstacle, 'type' | 'hgt' | 'lit'>,
	x: number,
	y: number,
	s: number,
): void {
	const kind = obstacleGlyphKind(o);
	const art = OBSTACLE_GLYPH_ART[kind];
	const parts = partsFor(kind);
	const k = s * SIZE_MULT[kind];
	ctx.save();
	ctx.translate(x, y);
	ctx.scale(k, k);
	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';
	// Halo pass under the ink, then the traced fills.
	ctx.strokeStyle = HALO;
	ctx.lineWidth = HALO_PX / k;
	for (const p of parts) {
		ctx.stroke(p.path);
	}
	ctx.fillStyle = OBSTACLE_INK;
	for (const p of parts) {
		ctx.fill(p.path, p.rule);
	}
	ctx.restore();
	// Lit obstacles carry the ray marks over the glyph top (the ground
	// light star is a light by definition and never doubles them).
	if (o.lit && kind !== 'groundLight') {
		// The legend stamps the SAME ray mark on every lit obstacle (sized
		// like the caret's), not one scaled to the glyph: size off the base
		// symbol height, anchor at the glyph's own top.
		const h = 2 * s;
		const rays = raysPath(x, y, -art.halfH * s * SIZE_MULT[kind], h);
		const lw = Math.max(1.1, 0.07 * h);
		ctx.save();
		ctx.lineCap = 'butt';
		ctx.strokeStyle = HALO;
		ctx.lineWidth = lw + HALO_PX;
		ctx.stroke(rays);
		ctx.strokeStyle = OBSTACLE_INK;
		ctx.lineWidth = lw;
		ctx.stroke(rays);
		ctx.restore();
	}
}

/** Obstacle glyph head for SVG PROFILE surfaces, at (cx, ty), ty being
 *  the obstacle TOP: chevron caret (towerHigh a taller one), wind-turbine
 *  pole + blades hanging below the blade-tip top, ground light as an
 *  asterisk star. Stroke-only path `d` strings: the documented
 *  profile-scale cousins of OBSTACLE_GLYPH_ART (RouteProfile draws them
 *  beside the canvas truth; keep proportions in step when the traced art
 *  changes). */
export function profileObstacleGlyphPath(kind: ObstacleGlyphKind, cx: number, ty: number): string {
	if (kind === 'turbine') {
		const hy = ty + 4.5;
		return (
			`M ${cx} ${hy} L ${cx} ${ty} ` +
			`M ${cx} ${hy} L ${cx - 3.5} ${hy + 3} M ${cx} ${hy} L ${cx + 3.5} ${hy + 3}`
		);
	}
	if (kind === 'groundLight') {
		const my = ty + 3.5;
		return (
			`M ${cx - 3.5} ${my} L ${cx + 3.5} ${my} M ${cx} ${my - 3.5} L ${cx} ${my + 3.5} ` +
			`M ${cx - 2.5} ${my - 2.5} L ${cx + 2.5} ${my + 2.5} M ${cx - 2.5} ${my + 2.5} L ${cx + 2.5} ${my - 2.5}`
		);
	}
	const h = kind === 'towerHigh' ? 7 : 5;
	const w = kind === 'towerHigh' ? 4.5 : 3.5;
	return `M ${cx - w} ${ty + h} L ${cx} ${ty} L ${cx + w} ${ty + h}`;
}

/** Lit obstacle on the profile: two short rays above the top, the map's
 *  "balise" cue (drawObstacleSymbol's parametric rays, profile-scaled). */
export function profileObstacleRaysPath(cx: number, ty: number): string {
	return `M ${cx - 4.5} ${ty - 4} L ${cx - 2} ${ty - 1.5} M ${cx + 4.5} ${ty - 4} L ${cx + 2} ${ty - 1.5}`;
}
