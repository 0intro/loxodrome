/* airspaceDecoLayer.ts draws everything of the SIA 1:500 000 airspace
 * symbology that a Leaflet polygon stroke cannot: the inside boundary bands
 * (controlled-airspace solid tints, the R / D 45-degree hatch fringe, the P
 * crosshatch chain, the RTBA fringe + pecked strip), the FIR comb and
 * DLG-ATS fine-comb ticks, the SIV square dots, the activity glyphs, the
 * "tres petite zone" cross, and the designator labels. The per-type mapping
 * lives in airspaceSymbology.ts; this layer is paint only.
 *
 * Tint-band technique (inherited from the retired prohibitedLayer.ts):
 * build the ring as a Path2D, clip the context to its interior, stroke the
 * boundary at twice the band width; only the inner half of the stroke
 * survives, a band of constant on-screen width hugging the inside edge.
 * Hatch and crosshatch use the same band shape as a MASK over a
 * map-anchored pattern of parallel 45-degree lines (both diagonals for P):
 * the chart's convention keeps every stripe in the same direction
 * regardless of the boundary's bearing (P 66's round zone shows the
 * lattice axis-aligned all around its ring), and narrow corridors like the
 * RTBA network fill seamlessly because both edges clip the same pattern.
 *
 * Architecture mirrors obstacleLayer.ts / navaidLayer.ts: a DirectDrawLayer
 * subclass, one canvas on its own pane, repainted at rest (moveend / zoomend
 * / viewreset / resize) and transformed during zoom animation, the whole
 * lifecycle inherited from directDrawLayer.ts; this class owns only _draw
 * and its offscreen-composite state. The zone set
 * comes from airspaceLayer's visibleDecoratedAirspaces() (the `entryPasses`
 * chokepoint), so every decoration shows and hides in exact lockstep with
 * the boundary outline; the hovered / selected airspace is decorated
 * unconditionally, bypassing every gate, like the other canvas layers'
 * highlight passes. */

import L from 'leaflet';
import type { Airspace } from '$lib/data/airspaces';
import {
	visibleDecoratedAirspaces,
	highlightedAirspaces,
	setAirspaceHighlightListener,
} from '$lib/map/airspaceLayer';
import {
	symbolFor,
	airspaceLabel,
	bandZoomFactor,
	lineZoomFactor,
	RTBA_DASH,
	RTBA_INNER_PX,
	type SymbolSpec,
} from './airspaceSymbology';
import {
	ringMetrics,
	ringComplement,
	walkRing,
	walkPolyline,
	anchorPoint,
	decimationStep,
	hatchPhase,
	hatchStripes,
	type ClipRect,
} from './decoGeometry';
import {
	drawActivityGlyph,
	drawTinyCross,
	drawClassChip,
	glyphHalf,
	CHIP_SIZE,
} from './airspaceGlyphs';
import { DirectDrawLayer, ensurePane } from './directDrawLayer';
import { FIR_INTERNAL, LABEL_HALO, SIA } from './palette';

const PANE = 'airspaces-deco';
// 355 sits between airspaces (350) and supaip (360): just above the airspace
// outlines, below the SUP AIP and activation overlays (and the airport /
// navaid symbols, which overprint airspace lettering like on the paper chart).
const PANE_Z = '355';
// Mirror airspaceLayer's low-zoom pane hide (updateAirspaceViewport hides at <= 4):
// at a continental view the decorations carry no useful detail.
const LOW_ZOOM_HIDE = 4;

// Geometry constants (css px). Zones smaller on screen than TINY_PX draw the
// GEN 2.3 rubine cross instead of their band / glyph; below SMALL_PX a band
// would fill the whole zone, so only the boundary line, a centred glyph and
// the label remain. Solid tint bands need more room than the ink fringes:
// a small P zone reading fully crosshatched matches the chart, but a
// controlled zone reading as a filled blue blob does not, so tint bands
// require SOLID_BAND_EXTENT times their width.
const TINY_PX = 8;
const SMALL_PX = 24;
const SOLID_BAND_EXTENT = 3.5;
// Tint bands composite through an offscreen canvas: every solid band
// paints OPAQUE there (so the stacked sectors of a TMA family yield ONE
// band tone along shared boundaries, like the printed chart, instead of
// accumulating alpha), then the offscreen blends onto the map once at this
// alpha. 0.6 reproduces the Legende2026 printed screens over paper-white:
// class A #EC6072 from SIA.zone, B/C/D and CTR #748FC9 from SIA.ctl
// (within ~10/255 per channel), class E #B7D0EE exactly from the
// pre-blended SIA.classE ink.
const BAND_TINT_ALPHA = 0.6;
// Off-viewport padding for the projection cull and the walkers' segment skip.
const CLIP_PAD = 32;
// Tick count cap for giant rings (spacing grows instead of ticks exploding).
const MAX_TICKS_PER_RING = 4000;
// The FIR-limit form, measured on the 2026 Nord-Ouest sheet over open
// water at 49.40 N 000d15' W (Baie de Seine, refs/meridian_sea in the
// verify-legend workspace): a thin line ~7 chart px = 1.4 css with stubs
// strictly ALTERNATING sides every 186 chart px = 37 css, ~19 chart px
// = 3.8 css long at ~1 css stroke. ONE shape, two inks: black between
// countries (the legend's "Limite de FIR"; its swatch is a denser
// stylised form, the map instance is authoritative) and FIR_INTERNAL
// grey between two French metro FIRs. Adjacent rings walk the shared
// boundary with unrelated phases (FIR twins, the UIR FRANCE outline
// over the arcs, pruatlas neighbours), so the stubs are twin-suppressed
// like the SIV dashes: only the first-drawn sequence survives and the
// alternation stays strict left / right. Ink and grey stamp SEPARATE
// maps: where an internal chain meets an external arc both forms print.
const FIR_LIMIT_SPACING = 37;
const FIR_LIMIT_TICK = 3.8;
const FIR_LIMIT_TICK_W = 1;
const FIR_LIMIT_SUPPRESS_R = 20;
const FIR_LIMIT_CELL = 20;
// DLG-ATS fine comb (one-sided inward, per GEN 2.3).
const FINE_SPACING = 6;
const FINE_TICK = 5;
// SIV squares: the legend prints the side at half the pitch (23.25 / 47);
// the 500k chart instances run even denser (13.5 / 22 at 600 dpi).
const SQUARE_SPACING = 10;
const SQUARE_SIZE = 5;
// Adjacent sectors each walk the shared border with unrelated phases, so
// the interleaved twin dashes would close the gaps into a near-solid
// line. A dash landing within this radius of one already stamped this
// repaint is such a twin and is skipped: along a shared edge the twin
// sits at most half a pitch away, while own-ring neighbours sit a full
// pitch apart (a sharp corner's pair can come closer; dropping one of
// those calms the clumping anyway).
const SQUARE_SUPPRESS_R = SQUARE_SPACING * 0.65;
// Cell size of the stamped-dash hash; must stay >= SQUARE_SUPPRESS_R so
// a 3x3 neighbourhood scan suffices.
const DASH_CELL = 8;
// Hatch / crosshatch fringes: stroke spacing along the boundary (lengths
// come from the spec's band.widthPx) and the stroke weight.
const HATCH_SPACING = 6;
// Legende2026 P chain: fringe depth 1.1x the diamond pitch (42 px deep,
// diamonds every 38 px).
const CROSS_SPACING = 7;
// Chart hatch strokes run ~4.3 px at 600 dpi (thinner than the boundary
// line, unlike the legend's equal-weight sample).
const FRINGE_WEIGHT = 0.9;
const INV_SQRT2 = Math.SQRT1_2;
// Band-draw cap per repaint; beyond it the smallest zones keep their Leaflet
// outline only. Rarely binds: by the time 600 band-bearing zones fit the
// viewport, most sit under the SMALL_PX gate anyway.
const MAX_BAND_RINGS = 600;
const LABEL_FONT = 'bold 11px system-ui, sans-serif'; // i18n-ignore: CSS font shorthand, not display text
// The chart prints the CABLE mark beside winch sites in italics.
const LABEL_FONT_ITALIC = 'italic bold 11px system-ui, sans-serif'; // i18n-ignore: CSS font shorthand, not display text
let layer: AirspaceDecoLayer | null = null;
// Designator-label visibility (the Layers-tab toggle), read at draw time.
let labelsVisible = true;

function rgba(hex: string, alpha: number): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Check-and-stamp against a per-repaint position hash (cell size must
 *  stay >= r so a 3x3 neighbourhood scan suffices): true when a mark was
 *  already stamped within `r` px (the twin walked by the neighbouring
 *  ring along a shared border); otherwise records (x, y). */
function twinStamp(
	seen: Map<number, number[]>,
	cell: number,
	r: number,
	x: number,
	y: number,
): boolean {
	const cx = Math.floor(x / cell);
	const cy = Math.floor(y / cell);
	const r2 = r * r;
	for (let i = cx - 1; i <= cx + 1; i++) {
		for (let j = cy - 1; j <= cy + 1; j++) {
			const bucket = seen.get(i * 131071 + j);
			if (!bucket) {
				continue;
			}
			for (let k = 0; k < bucket.length; k += 2) {
				const dx = bucket[k] - x;
				const dy = bucket[k + 1] - y;
				if (dx * dx + dy * dy < r2) {
					return true;
				}
			}
		}
	}
	const key = cx * 131071 + cy;
	let own = seen.get(key);
	if (!own) {
		own = [];
		seen.set(key, own);
	}
	own.push(x, y);
	return false;
}

/* ----------------------------------------------------------------------
 * Per-repaint work items: each visible airspace's ring is projected ONCE
 * (decimated for monster rings) and the Path2D / orientation metrics /
 * anchor are shared by every drawing pass.
 * ------------------------------------------------------------------- */

interface DrawItem {
	a: Airspace;
	spec: SymbolSpec;
	pts: Float64Array;
	path: Path2D;
	inwardSign: 1 | -1;
	perimeter: number;
	/** Projected bbox centre (the tiny-cross / small-glyph anchor). */
	cx: number;
	cy: number;
	/** Projected bbox in container px, kept so the offscreen composites can
	 *  be bounded to the ground they actually cover instead of clearing and
	 *  blitting the whole viewport three times per repaint. */
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	tiny: boolean;
	small: boolean;
	highlighted: boolean;
	/** Projected external FIR arcs (Airspace.arcs): when present, the
	 *  bold boundary line + comb draw along these instead of the full
	 *  ring (the polygon underneath keeps the thin internal grey). */
	arcPts: Float64Array[] | null;
	/** Projected INTERNAL chains (the ring minus the arcs): the deco layer
	 *  stamps the chart's grey crossing traverses along them. */
	internalPts: Float64Array[] | null;
	wantBand: boolean;
	wantMarks: boolean;
	wantGlyph: boolean;
	wantLabel: boolean;
}

/** The device-pixel rectangle a set of items covers, padded for the band's
 *  own width and clamped to the canvas; null when it would be empty.
 *
 *  The offscreen composites (the tint blend and the two hatch passes) used to
 *  clear and blit the entire viewport canvas each, three full-canvas
 *  drawImages per repaint, which was the single largest cost left in a zoom
 *  once the polygons stopped being re-projected. Airspace bands only ever
 *  cover the zones themselves, so the blit is bounded by their union. */
function compositeRect(
	items: DrawItem[],
	padPx: number,
	dpr: number,
	canvas: HTMLCanvasElement,
): { x: number; y: number; w: number; h: number } | null {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const it of items) {
		if (it.x0 < x0) x0 = it.x0;
		if (it.y0 < y0) y0 = it.y0;
		if (it.x1 > x1) x1 = it.x1;
		if (it.y1 > y1) y1 = it.y1;
	}
	if (!Number.isFinite(x0)) {
		return null;
	}
	const x = Math.max(0, Math.floor((x0 - padPx) * dpr));
	const y = Math.max(0, Math.floor((y0 - padPx) * dpr));
	const w = Math.min(canvas.width, Math.ceil((x1 + padPx) * dpr)) - x;
	const h = Math.min(canvas.height, Math.ceil((y1 + padPx) * dpr)) - y;
	return w > 0 && h > 0 ? { x, y, w, h } : null;
}

class AirspaceDecoLayer extends DirectDrawLayer {
	protected override readonly canvasClass = 'leaflet-airspace-deco-canvas';
	// The base class resolves the pane by NAME in onAdd (never through
	// options.pane), placing the canvas at z 355: below the SUP AIP /
	// activation overlays and the NOTAM areas, with the airport / navaid
	// symbols overprinting the labels like on the paper chart.
	protected override readonly paneName = PANE;

	// Stamped SIV dash centres this repaint, keyed by DASH_CELL cell
	// (plain Map rebuilt per draw; see SQUARE_SUPPRESS_R).
	private _dashSeen = new Map<number, number[]>();
	// Stamped FIR-limit stubs this repaint (FIR_LIMIT_CELL cells), one map
	// per ink so the grey internal form never suppresses the black one
	// where the two meet at a triple point.
	private _greySeen = new Map<number, number[]>();
	private _inkSeen = new Map<number, number[]>();
	// Offscreen canvas for the tint-band composite (never attached to the DOM).
	private _tint: HTMLCanvasElement | null = null;

	/** The offscreen tint context, sized to match the live canvas. */
	private _tintCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
		if (!this._tint) {
			this._tint = document.createElement('canvas');
		}
		if (this._tint.width !== canvas.width || this._tint.height !== canvas.height) {
			this._tint.width = canvas.width;
			this._tint.height = canvas.height;
		}
		return this._tint.getContext('2d');
	}

	/** Project one airspace into a DrawItem, or null when nothing draws. */
	private _itemFor(
		map: L.Map,
		a: Airspace,
		zoom: number,
		clip: ClipRect,
		highlighted: boolean,
	): DrawItem | null {
		const spec = symbolFor(a);
		const b = a.bbox;
		const tl = map.latLngToContainerPoint([b.maxLat, b.minLon]);
		const br = map.latLngToContainerPoint([b.minLat, b.maxLon]);
		if (br.x < clip.x0 || tl.x > clip.x1 || br.y < clip.y0 || tl.y > clip.y1) {
			return null;
		}
		const w = br.x - tl.x;
		const h = br.y - tl.y;
		const maxDim = Math.max(w, h);
		const tiny = maxDim < TINY_PX;
		const small = maxDim < SMALL_PX;
		const pass = (gate: number) => highlighted || zoom >= gate;
		// Tint bands gate on the bbox MINOR extent: an elongated en-route CTA
		// whose width is a couple of band widths would read as a filled
		// ribbon, which the chart never does for controlled airspace. The ink
		// hatches keep the small gate on the major extent: a narrow R / P
		// corridor printing fully hatched matches the chart (RTBA corridors).
		const tintBand = spec.band !== null && spec.band.kind === 'solid';
		const wantBand =
			!!spec.band &&
			(tintBand
				? Math.min(w, h) >= spec.band.widthPx * SOLID_BAND_EXTENT
				: maxDim >= SMALL_PX) &&
			pass(spec.minZoom.band);
		const wantMarks = !!spec.marks && !small && pass(spec.minZoom.marks);
		const wantGlyph = !!spec.glyph && !tiny && pass(spec.minZoom.glyph);
		const wantLabel =
			labelsVisible && !tiny && pass(spec.minZoom.label) &&
			// Bare boundary-line types label only alongside some other mark
			// at this zoom, so labels never outrun their symbols.
			(wantBand || wantMarks || wantGlyph || !!spec.line);
		const wantCross = tiny && spec.crossEligible;
		if (!wantBand && !wantMarks && !wantGlyph && !wantLabel && !wantCross && !highlighted) {
			return null;
		}
		const ring = a.ring;
		const step = decimationStep(ring.length, w, h);
		const count = Math.ceil(ring.length / step);
		const pts = new Float64Array(count * 2);
		for (let i = 0, o = 0; i < ring.length; i += step, o += 2) {
			const p = map.latLngToContainerPoint(ring[i]);
			pts[o] = p.x;
			pts[o + 1] = p.y;
		}
		const path = new Path2D();
		path.moveTo(pts[0], pts[1]);
		for (let o = 2; o < pts.length; o += 2) {
			path.lineTo(pts[o], pts[o + 1]);
		}
		path.closePath();
		const m = ringMetrics(pts);
		// Metro FIR external arcs project 1:1 (they are short); the ring's
		// inward sign carries over since arcs keep the ring's vertex order.
		let arcPts: Float64Array[] | null = null;
		let internalPts: Float64Array[] | null = null;
		if (a.arcs && spec.marks?.kind === 'comb' && (wantMarks || highlighted)) {
			const project = (line: [number, number][]): Float64Array => {
				const ap = new Float64Array(line.length * 2);
				for (let i = 0, o = 0; i < line.length; i++, o += 2) {
					const p = map.latLngToContainerPoint(line[i]);
					ap[o] = p.x;
					ap[o + 1] = p.y;
				}
				return ap;
			};
			arcPts = a.arcs.map(project);
			internalPts = ringComplement(a.ring, a.arcs).map(project);
		}
		return {
			a,
			spec,
			pts,
			path,
			inwardSign: m.inwardSign,
			perimeter: m.perimeter,
			cx: (tl.x + br.x) / 2,
			cy: (tl.y + br.y) / 2,
			x0: tl.x,
			y0: tl.y,
			x1: br.x,
			y1: br.y,
			tiny,
			small,
			highlighted,
			arcPts,
			internalPts,
			wantBand,
			wantMarks,
			wantGlyph,
			wantLabel,
		};
	}

	/** Hatch / crosshatch fringes follow the chart's FIXED-direction
	 *  convention: a map-anchored pattern of parallel 45-degree lines (one
	 *  family for R / D, both diagonals for P), clipped to a band hugging
	 *  the inside of the boundary. Verified against the chart (P 66's round
	 *  zone shows the lattice axis-aligned all around its ring); a
	 *  boundary-relative walker would rotate the strokes with the edge.
	 *  Implementation: the bands paint opaque into the shared offscreen,
	 *  then 'source-in' keeps the global line pattern only inside them, and
	 *  the result composites onto the map canvas; narrow corridors fill
	 *  seamlessly because both edges clip the SAME pattern. The pattern
	 *  phase anchors to layer space, so it stays put while panning. */
	private _drawFringePattern(
		canvas: HTMLCanvasElement,
		ctx: CanvasRenderingContext2D,
		items: DrawItem[],
		zoom: number,
		cross: boolean,
		dpr: number,
	): void {
		if (items.length === 0) {
			return;
		}
		const tctx = this._tintCtx(canvas);
		const off = this._tint;
		if (!tctx || !off) {
			return;
		}
		const factor = bandZoomFactor(zoom);
		const colour = items[0].spec.band?.color ?? SIA.zone;
		// The band is a stroke of twice its depth centred on the boundary, so
		// half of it falls outside the ring's own bbox; the fringe weight and
		// a pixel of rounding go on top.
		const pad = Math.max(...items.map((it) => (it.spec.band?.widthPx ?? 0) * factor)) + FRINGE_WEIGHT + 2;
		const rect = compositeRect(items, pad, dpr, canvas);
		if (!rect) {
			return;
		}
		tctx.setTransform(1, 0, 0, 1, 0, 0);
		tctx.clearRect(rect.x, rect.y, rect.w, rect.h);
		tctx.scale(dpr, dpr);
		for (const it of items) {
			const band = it.spec.band;
			if (!band) {
				continue;
			}
			// The stroke length on a horizontal boundary stays band.widthPx,
			// so the band depth is its 45-degree projection.
			const depth = band.widthPx * INV_SQRT2 * factor + (it.highlighted ? 2 : 0);
			tctx.save();
			tctx.clip(it.path);
			tctx.lineWidth = depth * 2;
			tctx.lineJoin = 'round';
			tctx.strokeStyle = colour;
			tctx.stroke(it.path);
			tctx.restore();
		}
		// Keep the parallel-line pattern only where the bands are.
		const spacing = (cross ? CROSS_SPACING : HATCH_SPACING) * factor;
		const pitch = Math.max(2, spacing * INV_SQRT2);
		const fw = FRINGE_WEIGHT * lineZoomFactor(zoom);
		const size = { x: canvas.width / dpr, y: canvas.height / dpr };
		const origin = this._drawState?.origin ?? { x: 0, y: 0 };
		const topLeft = this._drawState?.topLeft ?? { x: 0, y: 0 };
		tctx.save();
		tctx.globalCompositeOperation = 'source-in';
		tctx.strokeStyle = colour;
		tctx.lineWidth = items.some((it) => it.highlighted) ? fw + 0.25 : fw;
		tctx.beginPath();
		const dirs: (1 | -1)[] = cross ? [1, -1] : [1];
		for (const sign of dirs) {
			// The stripe family and its phase live in decoGeometry.ts:
			// hatchPhase anchors it to PROJECTED map space via the viewport
			// top-left (origin + topLeft; the pixel origin alone is
			// pan-invariant in Leaflet, which would leave the stripes
			// screen-anchored and re-phasing against the zones on every
			// pan), and hatchStripes ranges over all four viewport corners.
			const c0 = hatchPhase(origin.x + topLeft.x, origin.y + topLeft.y, sign);
			for (const l of hatchStripes(size.x, size.y, sign, pitch, c0)) {
				tctx.moveTo(l.x0, l.y0);
				tctx.lineTo(l.x1, l.y1);
			}
		}
		tctx.stroke();
		tctx.restore();
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.drawImage(off, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
		ctx.restore();
	}

	/** RTBA zones overlay a thick solid pecked strip tight on the inside
	 *  edge (the GEN 2.3 "R 45 A" symbol), drawn per zone over the fringe. */
	private _drawPeckedStrip(
		ctx: CanvasRenderingContext2D,
		it: DrawItem,
		zoom: number,
	): void {
		const band = it.spec.band;
		if (!band) {
			return;
		}
		const factor = bandZoomFactor(zoom);
		ctx.save();
		ctx.clip(it.path);
		ctx.strokeStyle = band.color;
		ctx.lineWidth = RTBA_INNER_PX * 2 * factor;
		ctx.lineJoin = 'round';
		ctx.setLineDash(RTBA_DASH.map((v) => v * factor));
		ctx.stroke(it.path);
		ctx.setLineDash([]);
		ctx.restore();
	}

	/** Solid tint bands paint OPAQUE into the offscreen tint canvas
	 *  (composited once at BAND_TINT_ALPHA by _draw), so stacked sectors
	 *  sharing a boundary tone like one chart band. The highlighted band
	 *  instead draws directly with a stronger rgba (one zone, no stacking).
	 *  The band narrows below z10, where sector tiling would otherwise weave
	 *  a heavy lattice (the printed chart's fixed 1:500k scale corresponds to
	 *  roughly z10). */
	private _drawTintBand(
		ctx: CanvasRenderingContext2D,
		it: DrawItem,
		zoom: number,
	): void {
		const band = it.spec.band;
		if (!band) {
			return;
		}
		const factor = bandZoomFactor(zoom);
		ctx.save();
		ctx.clip(it.path);
		ctx.lineWidth = (band.widthPx * factor + (it.highlighted ? 2 : 0)) * 2;
		ctx.lineJoin = 'round';
		ctx.strokeStyle = it.highlighted
			? rgba(band.color, Math.min(1, BAND_TINT_ALPHA + 0.15))
			: band.color;
		ctx.stroke(it.path);
		ctx.restore();
	}

	/** True when a dash was already stamped within SQUARE_SUPPRESS_R this
	 *  repaint (the twin walked by the neighbouring sector's ring along a
	 *  shared border); otherwise records (x, y) and answers false. */
	private _dashTwin(x: number, y: number): boolean {
		return twinStamp(this._dashSeen, DASH_CELL, SQUARE_SUPPRESS_R, x, y);
	}

	private _drawMarks(
		ctx: CanvasRenderingContext2D,
		it: DrawItem,
		zoom: number,
		clip: ClipRect,
	): void {
		const marks = it.spec.marks;
		if (!marks) {
			return;
		}
		if (marks.kind === 'squareDots') {
			ctx.beginPath();
			const half = SQUARE_SIZE / 2;
			walkRing(
				it.pts,
				SQUARE_SPACING,
				SQUARE_SPACING / 2,
				it.inwardSign,
				(s) => {
					if (this._dashTwin(s.x, s.y)) {
						return;
					}
					// Each dash is a chunk of the boundary line itself, so
					// the square rides the local tangent (an axis-aligned
					// rect would keep every dash east-west on the screen).
					const lx = s.tx * half;
					const ly = s.ty * half;
					const wx = s.nx * half;
					const wy = s.ny * half;
					ctx.moveTo(s.x + lx + wx, s.y + ly + wy);
					ctx.lineTo(s.x - lx + wx, s.y - ly + wy);
					ctx.lineTo(s.x - lx - wx, s.y - ly - wy);
					ctx.lineTo(s.x + lx - wx, s.y + ly - wy);
					ctx.closePath();
				},
				clip,
			);
			ctx.fillStyle = marks.color;
			ctx.fill();
			return;
		}
		const fine = marks.kind === 'fineComb';
		let spacing = fine ? FINE_SPACING : FIR_LIMIT_SPACING;
		const tick = fine ? FINE_TICK : FIR_LIMIT_TICK;
		if (it.perimeter / spacing > MAX_TICKS_PER_RING) {
			spacing = it.perimeter / MAX_TICKS_PER_RING;
		}
		ctx.beginPath();
		if (fine) {
			walkRing(
				it.pts,
				spacing,
				spacing / 2,
				it.inwardSign,
				(s) => {
					ctx.moveTo(s.x, s.y);
					ctx.lineTo(s.x + s.nx * tick, s.y + s.ny * tick);
				},
				clip,
			);
		} else if (it.arcPts) {
			// Internal chains first: the boundary BETWEEN two French FIRs
			// draws the chart's grey FIR-limit form entirely on THIS canvas
			// (above every airspace polygon stroke, so the grey line stays
			// visible where sector edges ride the same boundary; the FIR
			// polygon itself is strokeless). Thin grey line + stubs strictly
			// alternating left / right; the twin ring's walk of the same
			// chain is suppressed so one clean sequence survives.
			if (it.internalPts && it.internalPts.length > 0) {
				const gw = (it.spec.line?.weight ?? 1.4) * lineZoomFactor(zoom);
				ctx.beginPath();
				for (const ip of it.internalPts) {
					ctx.moveTo(ip[0], ip[1]);
					for (let o = 2; o < ip.length; o += 2) {
						ctx.lineTo(ip[o], ip[o + 1]);
					}
				}
				ctx.save();
				ctx.strokeStyle = FIR_INTERNAL;
				ctx.lineWidth = it.highlighted ? gw + 0.6 : gw;
				ctx.lineJoin = 'round';
				ctx.lineCap = 'round';
				ctx.stroke();
				const halfGrey = gw / 2;
				ctx.beginPath();
				for (const ip of it.internalPts) {
					let gside = 1;
					walkPolyline(ip, FIR_LIMIT_SPACING, FIR_LIMIT_SPACING / 2, it.inwardSign, (s) => {
						if (twinStamp(this._greySeen, FIR_LIMIT_CELL, FIR_LIMIT_SUPPRESS_R, s.x, s.y)) {
							return;
						}
						ctx.moveTo(s.x + s.nx * halfGrey * gside, s.y + s.ny * halfGrey * gside);
						ctx.lineTo(
							s.x + s.nx * (halfGrey + FIR_LIMIT_TICK) * gside,
							s.y + s.ny * (halfGrey + FIR_LIMIT_TICK) * gside,
						);
						gside = -gside;
					});
				}
				ctx.lineCap = 'butt';
				ctx.strokeStyle = FIR_INTERNAL;
				ctx.lineWidth = it.highlighted ? FIR_LIMIT_TICK_W + 0.6 : FIR_LIMIT_TICK_W;
				ctx.stroke();
				ctx.restore();
			}
			// Metro FIR with external arcs: the boundary line is not on the
			// Leaflet canvas (the polygon is strokeless), so draw it here
			// along the arcs, then the stubs: the SAME shape as the internal
			// chains, in the ink. Alternation restarts per arc; twin walks
			// (the UIR FRANCE outline, pruatlas neighbours) are suppressed.
			const lw = (it.spec.line?.weight ?? 1.4) * lineZoomFactor(zoom);
			ctx.beginPath();
			for (const ap of it.arcPts) {
				ctx.moveTo(ap[0], ap[1]);
				for (let o = 2; o < ap.length; o += 2) {
					ctx.lineTo(ap[o], ap[o + 1]);
				}
			}
			ctx.save();
			ctx.strokeStyle = it.spec.line?.color ?? marks.color;
			ctx.lineWidth = it.highlighted ? lw + 1 : lw;
			ctx.lineJoin = 'round';
			ctx.lineCap = 'round';
			ctx.stroke();
			ctx.restore();
			const halfLine = lw / 2;
			ctx.beginPath();
			for (const ap of it.arcPts) {
				let side = 1;
				walkPolyline(ap, spacing, spacing / 2, it.inwardSign, (s) => {
					if (twinStamp(this._inkSeen, FIR_LIMIT_CELL, FIR_LIMIT_SUPPRESS_R, s.x, s.y)) {
						return;
					}
					ctx.moveTo(s.x + s.nx * halfLine * side, s.y + s.ny * halfLine * side);
					ctx.lineTo(
						s.x + s.nx * (halfLine + tick) * side,
						s.y + s.ny * (halfLine + tick) * side,
					);
					side = -side;
				});
			}
		} else {
			// FIR limit, full ring (foreign FIRs, US centres, the UIR FRANCE
			// outline): stubs alternate sides along the line, rising from the
			// LINE EDGE (the ring stroke lives on the Leaflet canvas
			// underneath). Walked WITHOUT the viewport skip so the side
			// assignment stays pan-stable; the sample count is bounded by the
			// spacing-growth cap above. Twin walks of a shared boundary (two
			// pruatlas neighbours, the UIR over the metro arcs) suppress.
			const halfLine = ((it.spec.line?.weight ?? 0) / 2) * lineZoomFactor(zoom);
			let side = 1;
			walkRing(it.pts, spacing, spacing / 2, it.inwardSign, (s) => {
				if (twinStamp(this._inkSeen, FIR_LIMIT_CELL, FIR_LIMIT_SUPPRESS_R, s.x, s.y)) {
					return;
				}
				ctx.moveTo(s.x + s.nx * halfLine * side, s.y + s.ny * halfLine * side);
				ctx.lineTo(
					s.x + s.nx * (halfLine + tick) * side,
					s.y + s.ny * (halfLine + tick) * side,
				);
				side = -side;
			});
		}
		ctx.strokeStyle = marks.color;
		const tickW = fine ? 1 : FIR_LIMIT_TICK_W;
		ctx.lineWidth = it.highlighted ? tickW + 0.6 : tickW;
		ctx.stroke();
	}

	private _drawLabel(
		ctx: CanvasRenderingContext2D,
		it: DrawItem,
		x: number,
		y: number,
		placed: { x: number; y: number; w: number; h: number }[],
	): void {
		const label = airspaceLabel(it.a);
		if (!label) {
			return;
		}
		// The CABLE prefix of a winch-zone label prints in italics, like the
		// chart's mark beside every treuillage site; the number stays upright.
		const segments: Array<{ font: string; text: string }> =
			label.text.startsWith('CABLE ')
				? [
						{ font: LABEL_FONT_ITALIC, text: 'CABLE ' },
						{ font: LABEL_FONT, text: label.text.slice(6) },
					]
				: [{ font: LABEL_FONT, text: label.text }];
		let textW = 0;
		for (const seg of segments) {
			ctx.font = seg.font;
			textW += ctx.measureText(seg.text).width;
		}
		const chipW = label.chip ? CHIP_SIZE + 4 : 0;
		const total = textW + chipW;
		const rect = { x: x - total / 2 - 2, y: y - 9, w: total + 4, h: 18 };
		if (!it.highlighted) {
			for (const r of placed) {
				if (
					rect.x < r.x + r.w &&
					rect.x + rect.w > r.x &&
					rect.y < r.y + r.h &&
					rect.y + rect.h > r.y
				) {
					return;
				}
			}
		}
		placed.push(rect);
		const textX = x - chipW / 2;
		ctx.textAlign = 'left';
		ctx.textBaseline = 'middle';
		ctx.lineJoin = 'round';
		ctx.strokeStyle = LABEL_HALO;
		ctx.lineWidth = 3;
		ctx.fillStyle = label.color;
		let segX = textX - textW / 2;
		for (const seg of segments) {
			ctx.font = seg.font;
			ctx.strokeText(seg.text, segX, y);
			ctx.fillText(seg.text, segX, y);
			segX += ctx.measureText(seg.text).width;
		}
		if (label.chip) {
			drawClassChip(
				ctx,
				textX + textW / 2 + 4,
				y - CHIP_SIZE / 2,
				label.chip.letter,
				label.chip.solid,
				label.color,
			);
		}
		ctx.font = LABEL_FONT;
	}

	protected override _draw(): void {
		const canvas = this._canvas;
		const ctx = this._ctx;
		const map = this._map;
		if (!canvas || !ctx || !map) {
			return;
		}
		const dpr = window.devicePixelRatio || 1;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		const zoom = map.getZoom();
		if (zoom <= LOW_ZOOM_HIDE) {
			return;
		}
		const zones = visibleDecoratedAirspaces(map);
		// Usually one; several when a nav-log frequency line names every sector
		// sharing it.
		const hl = highlightedAirspaces();
		if (zones.length === 0 && hl.length === 0) {
			return;
		}
		const hlKeys = new Set(hl.map((a) => a.key));
		const size = map.getSize();
		const clip: ClipRect = {
			x0: -CLIP_PAD,
			y0: -CLIP_PAD,
			x1: size.x + CLIP_PAD,
			y1: size.y + CLIP_PAD,
		};
		// Draw in container points; scale once for retina.
		ctx.scale(dpr, dpr);
		// Project visible zones (largest first, so small zones overprint);
		// the highlighted airspaces join unconditionally and draw last.
		const items: DrawItem[] = [];
		const seen = new Set<string>();
		for (const a of zones) {
			const highlighted = hlKeys.has(a.key);
			if (highlighted) {
				seen.add(a.key);
			}
			const it = this._itemFor(map, a, zoom, clip, highlighted);
			if (it) {
				items.push(it);
			}
		}
		for (const a of hl) {
			if (seen.has(a.key)) {
				continue;
			}
			const it = this._itemFor(map, a, zoom, clip, true);
			if (it) {
				items.push(it);
			}
		}
		// Pass 1: bands (clip + thick stroke), capped. Tint bands go through
		// the offscreen composite; the ink fringes draw direct afterwards so
		// they aren't washed by the blend.
		let bands = 0;
		const tintItems: DrawItem[] = [];
		const fringeItems: DrawItem[] = [];
		for (const it of items) {
			if (!it.wantBand || !it.spec.band) {
				continue;
			}
			if (bands >= MAX_BAND_RINGS && !it.highlighted) {
				continue;
			}
			bands++;
			if (it.spec.band.kind === 'solid') {
				tintItems.push(it);
			} else {
				fringeItems.push(it);
			}
		}
		const plainTint = tintItems.filter((it) => !it.highlighted);
		if (plainTint.length > 0) {
			const tctx = this._tintCtx(canvas);
			const tintPad =
				Math.max(...plainTint.map((it) => (it.spec.band?.widthPx ?? 0))) * bandZoomFactor(zoom) + 2;
			const rect = compositeRect(plainTint, tintPad, dpr, canvas);
			if (tctx && this._tint && rect) {
				tctx.setTransform(1, 0, 0, 1, 0, 0);
				tctx.clearRect(rect.x, rect.y, rect.w, rect.h);
				tctx.scale(dpr, dpr);
				for (const it of plainTint) {
					this._drawTintBand(tctx, it, zoom);
				}
				ctx.save();
				ctx.setTransform(1, 0, 0, 1, 0, 0);
				ctx.globalAlpha = BAND_TINT_ALPHA;
				ctx.drawImage(this._tint, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
				ctx.restore();
			}
		}
		for (const it of tintItems) {
			if (it.highlighted) {
				this._drawTintBand(ctx, it, zoom);
			}
		}
		this._drawFringePattern(
			canvas, ctx, fringeItems.filter((it) => it.spec.band?.kind !== 'cross'), zoom, false, dpr,
		);
		this._drawFringePattern(
			canvas, ctx, fringeItems.filter((it) => it.spec.band?.kind === 'cross'), zoom, true, dpr,
		);
		for (const it of fringeItems) {
			if (it.spec.band?.kind === 'hatchPecked') {
				this._drawPeckedStrip(ctx, it, zoom);
			}
		}
		// Pass 2: boundary marks (combs, square dots).
		this._dashSeen.clear();
		this._greySeen.clear();
		this._inkSeen.clear();
		for (const it of items) {
			if (it.wantMarks) {
				this._drawMarks(ctx, it, zoom, clip);
			}
		}
		// Pass 3: tiny-zone crosses and activity glyphs.
		for (const it of items) {
			if (it.tiny) {
				if (it.spec.crossEligible) {
					drawTinyCross(ctx, it.cx, it.cy, it.spec.labelColor);
				}
				continue;
			}
			if (it.wantGlyph && it.spec.glyph) {
				const at = it.small ? { x: it.cx, y: it.cy } : anchorPoint(it.pts);
				drawActivityGlyph(ctx, it.spec.glyph, at.x, at.y, it.spec.labelColor, it.highlighted);
			}
		}
		// Pass 4: designator labels, smallest zones first (they win cells);
		// the highlighted label always places.
		const placed: { x: number; y: number; w: number; h: number }[] = [];
		const labelled = items.filter((it) => it.wantLabel && !it.tiny);
		labelled.sort((p, q) =>
			p.highlighted !== q.highlighted
				? (p.highlighted ? -1 : 1)
				: p.a.area - q.a.area,
		);
		for (const it of labelled) {
			const at = it.small ? { x: it.cx, y: it.cy } : anchorPoint(it.pts);
			const y =
				it.wantGlyph && it.spec.glyph
					? at.y + glyphHalf(it.spec.glyph).h + 9
					: at.y;
			this._drawLabel(ctx, it, at.x, y, placed);
		}
	}
}

/* ----------------------------------------------------------------------
 * Public API.
 * ------------------------------------------------------------------- */

/** Build the decoration layer once and attach it. The layer stays on the map
 *  and draws nothing when no airspace is visible (visibleDecoratedAirspaces
 *  returns []), so visibility is driven entirely by redraw(). Idempotent. */
export function buildAirspaceDecoLayer(map: L.Map): void {
	if (layer) {
		return;
	}
	ensurePane(map, PANE, PANE_Z);
	layer = new AirspaceDecoLayer();
	layer.addTo(map);
	// Follow hover / selection emphasis without MapView threading a redraw
	// through every highlightAirspace call site.
	setAirspaceHighlightListener(() => layer?.redraw());
}

/** Repaint the decorations. Called by MapView whenever airspace visibility
 *  could change (category / publisher toggles, altitude filter, route
 *  filter, dataset load); map move / zoom repaints are handled by the
 *  layer's own event hooks. */
export function redrawAirspaceDeco(map: L.Map): void {
	void map;
	layer?.redraw();
}

/** Show / hide the designator labels (the Layers-tab toggle). */
export function setAirspaceLabelsVisible(on: boolean): void {
	labelsVisible = on;
	layer?.redraw();
}
