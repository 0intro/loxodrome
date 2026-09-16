/* navaidSymbols.ts draws the SIA / ICAO Annex 4 navaid chart symbols onto a
 * 2D canvas context, one shape per family, with the geometry measured off
 * the Legende2026 radionavigation panel (600 dpi; see
 * docs/airspace-symbology.md):
 *
 *   VOR        regular flat-top hexagon + centre dot
 *   VOR-DME    regular hexagon inscribed in a sharp SQUARE, vertices
 *              touching the sides (the ICAO form; the legend prints its
 *              box slightly wide, a documented quirk) + centre dot
 *   VORTAC     hexagon + 3 filled trapezoid lobes on the upper-left /
 *              upper-right / bottom edges + centre dot
 *   TACAN      the same silhouette as ONE continuous outline (hexagon
 *              walk detouring around each lobe), no fill
 *   DME        sharp SQUARE + centre dot (ICAO; the legend prints 103x77)
 *   NDB        centre dot + a small OPEN circle + three concentric rings of
 *              stipple dots at a uniform along-ring pitch (the legend
 *              prints 16/22/32 dots; see NDB_CIRCLE_R / NDB_RINGS)
 *   ILS / LOC  diamond (no legend row: the dataset carries no localizer
 *              course, so the directional "feather" can't be oriented)
 *   WAYPOINT   4-pointed star (no Legende2026 row; ENAIRE GEN 2.3 glyph)
 *
 * Each shape is built as a Path2D and painted with a white halo underneath
 * the coloured stroke/fill so it stays legible on dark, satellite, and
 * topo basemaps alike. Colours are hardcoded (like the other canvas
 * layers); the whole radionav family prints in the chart navy #164194
 * (sampled from the legend), matching SIA.ctl. */

import type { NavaidType } from '$lib/data/navaids';
import { NAVAID } from './palette';
import { haloStroke, haloFill, centreDot, HALO } from './symbolBase';

/** Per-family colour. The whole radionav family prints in the Legende2026
 *  navy (#164194 sampled flat, the same ink as SIA.ctl); the VFR reporting
 *  triangle prints in it too. ILS (no VFR-chart row) keeps its distinct
 *  orange, the RNAV waypoint star its slate (ENAIRE convention); both are
 *  documented deviations. */
export const NAVAID_COLOR: Record<NavaidType, string> = {
	VOR: NAVAID.radionav,
	'VOR-DME': NAVAID.radionav,
	VORTAC: NAVAID.radionav,
	TACAN: NAVAID.radionav,
	DME: NAVAID.radionav,
	NDB: NAVAID.radionav,
	ILS: NAVAID.ils,
	'ILS-DME': NAVAID.ils,
	LOC: NAVAID.ils,
	MKR: NAVAID.ils,
	WAYPOINT: NAVAID.waypoint,
	VFR_REPORTING_POINT: NAVAID.radionav,
};

/** Half-extent (px) of each family's glyph, for hit-testing and cue rings.
 *  Radio navaids draw biggest, ILS a touch smaller, waypoints smallest. */
export function navaidSymbolSize(type: NavaidType): number {
	if (type === 'WAYPOINT' || type === 'VFR_REPORTING_POINT') {
		return 6;
	}
	if (type === 'ILS' || type === 'ILS-DME' || type === 'LOC') {
		return 7;
	}
	if (type === 'NDB') {
		// The chart's largest radionav glyph: the stipple rings need the
		// extra room to resolve (see NDB_MIN_PITCH).
		return 11;
	}
	return 8;
}

function hexPath(x: number, y: number, s: number): Path2D {
	const p = new Path2D();
	for (let i = 0; i < 6; i++) {
		const a = (Math.PI / 3) * i; // flat-top: vertices at 0,60,...,300
		const px = x + s * Math.cos(a);
		const py = y + s * Math.sin(a);
		if (i === 0) {
			p.moveTo(px, py);
		} else {
			p.lineTo(px, py);
		}
	}
	p.closePath();
	return p;
}

function squarePath(x: number, y: number, half: number): Path2D {
	// Sharp-cornered square centred on (x, y): the ICAO DME box.
	const p = new Path2D();
	p.rect(x - half, y - half, 2 * half, 2 * half);
	return p;
}

/** Hexagon vertices in hexPath order (flat-top, pointy left-right, y down). */
function hexVertices(x: number, y: number, s: number): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (let i = 0; i < 6; i++) {
		const a = (Math.PI / 3) * i;
		out.push([x + s * Math.cos(a), y + s * Math.sin(a)]);
	}
	return out;
}

// TACAN / VOR-TACAN lobes sit ON the upper-left, upper-right and bottom
// hexagon edges (Legende2026: trapezoids spanning nearly the full edge,
// about half the hexagon radius deep, mildly tapered). With hexVertices
// order (0deg, 60deg, ...; y down) those are edges 3->4, 5->0 and 1->2.
const LOBE_EDGES = [3, 5, 1] as const;
const LOBE_DEPTH = 0.5;
const LOBE_INSET = 0.04;
const LOBE_TAPER = 0.12;

function lobeCorners(
	v: Array<[number, number]>,
	edge: number,
	s: number,
	cx: number,
	cy: number,
): [number, number][] {
	const [ax, ay] = v[edge];
	const [bx, by] = v[(edge + 1) % 6];
	const ux = bx - ax;
	const uy = by - ay;
	// Outward normal: away from the hexagon centre.
	const mx = (ax + bx) / 2 - cx;
	const my = (ay + by) / 2 - cy;
	const ml = Math.hypot(mx, my);
	const nx = (mx / ml) * s * LOBE_DEPTH;
	const ny = (my / ml) * s * LOBE_DEPTH;
	const a1x = ax + ux * LOBE_INSET;
	const a1y = ay + uy * LOBE_INSET;
	const b1x = bx - ux * LOBE_INSET;
	const b1y = by - uy * LOBE_INSET;
	const t = LOBE_TAPER;
	return [
		[a1x, a1y],
		[a1x + nx + ux * t, a1y + ny + uy * t],
		[b1x + nx - ux * t, b1y + ny - uy * t],
		[b1x, b1y],
	];
}

/** The three filled VORTAC lobes (the legend fills them solid against the
 *  stroked hexagon). */
function vortacLobesPath(x: number, y: number, s: number): Path2D {
	const v = hexVertices(x, y, s);
	const p = new Path2D();
	for (const edge of LOBE_EDGES) {
		const c = lobeCorners(v, edge, s, x, y);
		p.moveTo(c[0][0], c[0][1]);
		for (let i = 1; i < 4; i++) {
			p.lineTo(c[i][0], c[i][1]);
		}
		p.closePath();
	}
	return p;
}

/** The TACAN silhouette as one continuous outline (the legend draws TACAN
 *  stroke-only): the hexagon perimeter detouring around each edge lobe. */
function tacanOutlinePath(x: number, y: number, s: number): Path2D {
	const v = hexVertices(x, y, s);
	const p = new Path2D();
	p.moveTo(v[0][0], v[0][1]);
	for (let i = 0; i < 6; i++) {
		const next = v[(i + 1) % 6];
		if ((LOBE_EDGES as readonly number[]).includes(i)) {
			for (const [px, py] of lobeCorners(v, i, s, x, y)) {
				p.lineTo(px, py);
			}
		}
		p.lineTo(next[0], next[1]);
	}
	p.closePath();
	return p;
}

function diamondPath(x: number, y: number, s: number): Path2D {
	const p = new Path2D();
	p.moveTo(x, y - s);
	p.lineTo(x + s, y);
	p.lineTo(x, y + s);
	p.lineTo(x - s, y);
	p.closePath();
	return p;
}

function trianglePath(x: number, y: number, s: number): Path2D {
	// Point-up equilateral triangle inscribed in radius s (centroid at x, y).
	// ICAO Annex 4 VFR reporting-point symbol. Compulsory vs on-request is a
	// route-segment property, not carried on the point, so every reporting
	// point uses the hollow form.
	const p = new Path2D();
	p.moveTo(x, y - s);
	p.lineTo(x + s * 0.866, y + s * 0.5);
	p.lineTo(x - s * 0.866, y + s * 0.5);
	p.closePath();
	return p;
}

// ICAO Annex 4 waypoint (WPT): a 4-pointed star, an open circle hub with a
// triangle radiating from each cardinal point (the ENAIRE GEN 2.3 glyph).
function starPath(x: number, y: number, s: number): Path2D {
	const p = new Path2D();
	const hub = s * 0.4; // central circle radius
	const baseR = s * 0.5; // triangle base distance from centre
	const half = s * 0.4; // triangle base half-width
	for (let k = 0; k < 4; k++) {
		const a = (Math.PI / 2) * k;
		const dx = Math.sin(a); // k=0 -> north, then E, S, W
		const dy = -Math.cos(a);
		const px = -dy; // perpendicular to (dx, dy)
		const py = dx;
		p.moveTo(x + dx * baseR - px * half, y + dy * baseR - py * half);
		p.lineTo(x + dx * s, y + dy * s);
		p.lineTo(x + dx * baseR + px * half, y + dy * baseR + py * half);
		p.closePath();
	}
	p.moveTo(x + hub, y);
	p.arc(x, y, hub, 0, Math.PI * 2);
	return p;
}

/* The legend NDB (Legende2026, measured on the 600 dpi scan): an OPEN
 * circle at 0.31 of the symbol extent around the centre dot, wrapped in
 * THREE concentric stipple rings at 0.42 / 0.58 / 0.75 of the extent with
 * 16 / 22 / 32 dots (a near-uniform along-ring pitch; the counted gaps are
 * uniform, no dot occluded). */
export const NDB_CIRCLE_R = 0.31;
export const NDB_RINGS: ReadonlyArray<readonly [number, number]> = [
	[0.42, 16],
	[0.58, 22],
	[0.75, 32],
];

/** Along-ring stipple pitch floor (px). The legend prints its dots at
 *  roughly a third of the pitch (dot ~5 px, pitch ~15 px on the scan);
 *  what makes the symbol read as STIPPLE is that duty cycle, not the
 *  absolute count, and 32 dots on a canvas ring a few px across would
 *  fuse into a solid annulus. So each ring draws at most as many dots as
 *  keep this pitch, converging to the legend counts as the extent grows. */
const NDB_MIN_PITCH = 3.2;

/** Per-ring dot counts at half-extent `s`: the legend counts, thinned to
 *  the pitch floor (never below 6, so even a tiny glyph keeps its ring
 *  texture). At print-like extents this returns 16 / 22 / 32 exactly. */
export function ndbRingCounts(s: number): number[] {
	return NDB_RINGS.map(([rf, n]) =>
		Math.min(n, Math.max(6, Math.floor((2 * Math.PI * s * rf) / NDB_MIN_PITCH))),
	);
}

function ndbStipplePath(x: number, y: number, s: number): Path2D {
	const p = new Path2D();
	const dot = Math.max(0.55, s * 0.05);
	const counts = ndbRingCounts(s);
	for (let k = 0; k < NDB_RINGS.length; k++) {
		const r = s * NDB_RINGS[k][0];
		const n = counts[k];
		for (let i = 0; i < n; i++) {
			const a = (2 * Math.PI * i) / n;
			const cx = x + r * Math.cos(a);
			const cy = y + r * Math.sin(a);
			p.moveTo(cx + dot, cy);
			p.arc(cx, cy, dot, 0, Math.PI * 2);
		}
	}
	return p;
}

/** Draw the ICAO symbol for `type` centred at (x, y). `s` is the glyph
 *  half-extent (see navaidSymbolSize); `selected` thickens the strokes;
 *  `dimmed` greys it out and fades it (for unserviceable navaids - the
 *  red cue ring, drawn separately, stays at full strength). */
export function drawNavaidSymbol(
	ctx: CanvasRenderingContext2D,
	type: NavaidType,
	x: number,
	y: number,
	s: number,
	selected = false,
	dimmed = false,
): void {
	const color = dimmed ? NAVAID.unserviceable : NAVAID_COLOR[type];
	const lw = selected ? 2.4 : 1.6;
	if (dimmed) {
		ctx.save();
		ctx.globalAlpha = 0.45;
	}
	switch (type) {
		case 'VOR':
			haloStroke(ctx, hexPath(x, y, s), color, lw);
			centreDot(ctx, x, y, s, color);
			break;
		case 'VOR-DME':
			// ICAO: the regular hexagon inscribed in a square, vertices
			// touching the left / right sides.
			haloStroke(ctx, squarePath(x, y, s), color, lw);
			haloStroke(ctx, hexPath(x, y, s), color, lw);
			centreDot(ctx, x, y, s, color);
			break;
		case 'VORTAC':
			haloFill(ctx, vortacLobesPath(x, y, s), color);
			haloStroke(ctx, hexPath(x, y, s), color, lw);
			centreDot(ctx, x, y, s, color);
			break;
		case 'TACAN':
			haloStroke(ctx, tacanOutlinePath(x, y, s), color, lw);
			centreDot(ctx, x, y, s, color);
			break;
		case 'DME':
			// ICAO: a sharp square, sized to the radionav family height.
			haloStroke(ctx, squarePath(x, y, s * 0.8), color, lw);
			centreDot(ctx, x, y, s, color);
			break;
		case 'NDB': {
			// Open circle + centre dot inside three stipple rings. The halo
			// pass for BOTH parts underlays both ink passes, so the tight
			// circle-to-first-ring gap never has one part's halo nibbling the
			// other's ink.
			const stipple = ndbStipplePath(x, y, s);
			const circle = new Path2D();
			circle.arc(x, y, s * NDB_CIRCLE_R, 0, Math.PI * 2);
			// Legend circle stroke ~0.07 of the extent, floored for legibility.
			const clw = Math.max(1.1, s * 0.07);
			ctx.lineJoin = 'round';
			ctx.strokeStyle = HALO;
			ctx.lineWidth = 2;
			ctx.stroke(stipple);
			ctx.lineWidth = clw + 2;
			ctx.stroke(circle);
			ctx.fillStyle = color;
			ctx.fill(stipple);
			ctx.strokeStyle = color;
			ctx.lineWidth = clw;
			ctx.stroke(circle);
			centreDot(ctx, x, y, s, color);
			break;
		}
		case 'ILS':
		case 'ILS-DME':
		case 'LOC':
			haloStroke(ctx, diamondPath(x, y, s), color, lw);
			centreDot(ctx, x, y, s, color);
			break;
		case 'MKR':
			// ILS marker beacon: a small filled diamond, the ILS family
			// mark reduced, since a marker is an ILS component.
			haloStroke(ctx, diamondPath(x, y, s * 0.6), color, lw);
			break;
		case 'WAYPOINT':
			haloStroke(ctx, starPath(x, y, s), color, lw);
			break;
		case 'VFR_REPORTING_POINT':
			haloStroke(ctx, trianglePath(x, y, s), color, lw);
			break;
	}
	if (dimmed) {
		ctx.restore();
	}
}
