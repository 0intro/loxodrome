/* decoPaint.ts draws the SIA 1:500 000 airspace symbology: the boundary
 * lines themselves when the frame asks for them (the line pass, under
 * everything else), and everything a polygon stroke cannot: the inside
 * boundary bands
 * (controlled-airspace solid tints, the R / D 45-degree hatch fringe, the P
 * crosshatch chain, the RTBA fringe + pecked strip), the FIR comb and
 * DLG-ATS fine-comb ticks, the SIV square dots, the activity glyphs, the
 * "tres petite zone" cross, and the designator labels. The per-type mapping
 * lives in airspaceSymbology.ts; this is paint only.
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
 * Out of the layer (airspaceDecoLayer.ts) so it can run where the layer
 * cannot: it paints DecoZones (decoZone.ts, plain data) for a view given as
 * numbers (DecoFrame), projects them itself (containerProjection.ts), and
 * composites through scratch canvases its caller makes, OffscreenCanvases in
 * a worker and on any page that has them (scratchOver). No map, no DOM, no
 * state beyond that scratch and the twin-mark stamps, all redrawn or reset
 * each paint. */

import {
	bandZoomFactor,
	emphasisStroke,
	lineZoomFactor,
	RTBA_DASH,
	RTBA_INNER_PX,
	type LineSpec,
	type SymbolSpec,
} from './airspaceSymbology';
import {
	ringMetrics,
	walkRing,
	walkPolyline,
	anchorPoint,
	decimationStep,
	hatchTileSize,
	hatchTilePhase,
	hatchTileStripes,
	parseDash,
	simplifyLine,
	cumulativeLengths,
	clipRuns,
	type ClipRect,
	type HatchTile,
} from './decoGeometry';
import {
	drawActivityGlyph,
	drawTinyCross,
	drawClassChip,
	glyphHalf,
	CHIP_SIZE,
} from './airspaceGlyphs';
import {
	containerProjector,
	mercatorX,
	mercatorY,
	zoomScale,
	type ContainerProjector,
	type ProjectionView,
} from './containerProjection';
import type { Margin } from './canvasPlacement';
import type { DecoZone } from './decoZone';
import { FIR_INTERNAL, LABEL_HALO, SIA } from './palette';
import type { Paint2D } from './symbolBase';

/** The view a paint is made for, as numbers: what the layer reads off the map
 *  and its canvas when it asks. */
export interface DecoFrame {
	/** The projection: zoom, pixel origin, pane offset. */
	view: ProjectionView;
	/** The painted canvas's corner in layer points (the viewport's top-left
	 *  less the margin): with the pixel origin, the hatch lattice's phase. */
	topLeft: { x: number; y: number };
	/** The viewport, CSS px. */
	size: { x: number; y: number };
	/** The margin drawn beyond each side of the viewport, CSS px. */
	margin: Margin;
	/** Device pixels per CSS px of the painted canvas. */
	dpr: number;
	/** The designator labels are on (the Layers-tab toggle). */
	labels: boolean;
	/** Paint the boundary lines too, under the decorations: every zone's
	 *  resting line, and the emphasis stroke of the highlighted zones and of
	 *  the outlined ones (those a selected NOTAM affects). */
	lines: boolean;
}

/** A scratch canvas the paint composites through: its context, and itself as
 *  an image to draw back, a page canvas or an OffscreenCanvas. */
export interface Scratch {
	readonly ctx: Paint2D;
	readonly image: CanvasImageSource;
	readonly width: number;
	readonly height: number;
	resize(width: number, height: number): void;
}

/** Make a scratch canvas of the given device-pixel size, or null when the
 *  platform has no 2d context to give. */
export type MakeScratch = (width: number, height: number) => Scratch | null;

/** A canvas and its 2d context as the paint's scratch. The worker's are
 *  OffscreenCanvases, and so are the page's wherever the platform has them
 *  (airspaceDecoLayer.ts): Chromium rasterises the hatch tiles and the tint
 *  a shade differently on a page canvas, and a painting must not change as
 *  it moves between the page and the worker. */
export function scratchOver(canvas: HTMLCanvasElement | OffscreenCanvas, ctx: Paint2D): Scratch {
	return {
		ctx,
		image: canvas,
		get width() {
			return canvas.width;
		},
		get height() {
			return canvas.height;
		},
		resize(width: number, height: number) {
			canvas.width = width;
			canvas.height = height;
		},
	};
}

// Mirror airspaceLayer's low-zoom pane hide (updateAirspaceViewport hides at <= 4):
// at a continental view the decorations carry no useful detail.
const LOW_ZOOM_HIDE = 4;

/** Whether a painting of these zones at `zoom` draws nothing at all: at a
 *  continental zoom, or with no zone shown and none highlighted (the zones a
 *  selected NOTAM outlines are shown ones). The layer asks it before making a
 *  painting, which it then does not make (airspaceDecoLayer.ts). */
export function paintsNothing(zoom: number, zones: readonly DecoZone[], highlighted: readonly DecoZone[]): boolean {
	return zoom <= LOW_ZOOM_HIDE || (zones.length === 0 && highlighted.length === 0);
}

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
// Off-viewport padding for the projection cull and the walkers' segment skip:
// a zone whose bbox comes within it of the painted canvas is painted.
export const CLIP_PAD = 32;
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
// Band-draw cap per repaint; beyond it the smallest zones keep their line
// only, the ones in the margin before those on screen (withinBandBudget).
// Rarely binds: by the time 600 band-bearing zones fit the painting, most sit
// under the SMALL_PX gate anyway.
const MAX_BAND_RINGS = 600;
// The simplified lines held between paintings (a ring the stride would thin,
// per zone and zoom), counted in vertices: a few megabytes, dropped least
// recently used first. The 21 131 vertex ring (Cadiz) keeps a few thousand
// at a planning zoom.
const LINE_CACHE_VERTICES = 400_000;
// A dashed ring longer than this many times the painted canvas's perimeter
// strokes only its runs near the canvas: a dash is laid down along the whole
// path, off the canvas as much as on it, and the Canada ADIZ (16 000 km) is
// a hundred thousand pixels long at z9.
const LONG_DASHED_RING = 8;
const LABEL_FONT = 'bold 11px system-ui, sans-serif'; // i18n-ignore: CSS font shorthand, not display text
// The chart prints the CABLE mark beside winch sites in italics.
const LABEL_FONT_ITALIC = 'italic bold 11px system-ui, sans-serif'; // i18n-ignore: CSS font shorthand, not display text
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
	z: DecoZone;
	spec: SymbolSpec;
	pts: Float64Array;
	path: Path2D;
	/** The ring's orientation and length, for the marks' walkers: measured
	 *  only for an item that draws marks (1 and 0 otherwise). */
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
	/** Outlined (linked to a selected NOTAM): the line pass strokes it in the
	 *  emphasis stroke, and nothing else of it changes. */
	outlined: boolean;
	/** Projected external FIR arcs (Airspace.arcs): when present, the
	 *  bold boundary line + comb draw along these instead of the full
	 *  ring (the polygon underneath keeps the thin internal grey). */
	arcPts: Float64Array[] | null;
	/** Projected INTERNAL chains (the ring minus the arcs): the deco layer
	 *  stamps the chart's grey crossing traverses along them. */
	internalPts: Float64Array[] | null;
	/** The line pass strokes it: its resting line, or its emphasis stroke
	 *  when highlighted. */
	wantLine: boolean;
	wantBand: boolean;
	wantMarks: boolean;
	wantGlyph: boolean;
	wantLabel: boolean;
}

/** The items whose band a painting draws, out of the `banded` ones, in their
 *  order: every highlighted one, and at most `max` others, those reaching
 *  into the viewport (0, 0 to `size`, container points) taking the budget
 *  before those in the margin only, each in stacking order. A painting made
 *  ahead of a moving view holds more zones than the view does, and the ones
 *  on screen must not lose their bands to them. */
export function withinBandBudget<T extends { highlighted: boolean; x0: number; y0: number; x1: number; y1: number }>(
	banded: readonly T[],
	max: number,
	size: { x: number; y: number },
): T[] {
	if (banded.length <= max) {
		return banded.slice();
	}
	const onScreen = (it: T): boolean => it.x1 >= 0 && it.x0 <= size.x && it.y1 >= 0 && it.y0 <= size.y;
	const kept = new Set<T>();
	for (const screen of [true, false]) {
		for (const it of banded) {
			if (kept.size >= max) {
				break;
			}
			if (!it.highlighted && onScreen(it) === screen) {
				kept.add(it);
			}
		}
	}
	return banded.filter((it) => it.highlighted || kept.has(it));
}

/** Stroke a ring the way Leaflet's canvas renderer strokes a path
 *  (Canvas._fillStroke): the dash parsed as it parses one, the weight and
 *  the dash lengths times `factor`, round caps unless the line says
 *  otherwise; the caller sets the round join and restores the state. A
 *  dashed ring reaching past `clip` and longer than `longPx` strokes only its
 *  runs that reach it, each from the dash's own place along the ring, so the
 *  pattern is the one the whole ring would show and stays put as the map
 *  pans. */
function strokeLine(ctx: Paint2D, it: DrawItem, line: LineSpec, factor: number, clip: ClipRect, longPx: number): void {
	const dash = parseDash(line.dashArray, factor);
	ctx.setLineDash(dash);
	ctx.lineWidth = line.weight * factor;
	ctx.strokeStyle = line.color;
	ctx.lineCap = line.lineCap ?? 'round';
	const inside = it.x0 >= clip.x0 && it.x1 <= clip.x1 && it.y0 >= clip.y0 && it.y1 <= clip.y1;
	if (dash.length > 0 && !inside) {
		const cum = cumulativeLengths(it.pts);
		if (cum[cum.length - 1] > longPx) {
			const runs = clipRuns(it.pts, clip);
			if (runs) {
				strokeRuns(ctx, it.pts, runs, cum, dash);
				return;
			}
		}
	}
	ctx.stroke(it.path);
}

/** Stroke the runs of a ring (clipRuns), each with the dash offset its first
 *  vertex has along the whole ring (cumulativeLengths), reduced to one period
 *  of the pattern (the canvas repeats an odd list twice). */
function strokeRuns(ctx: Paint2D, pts: Float64Array, runs: [number, number][], cum: Float64Array, dash: number[]): void {
	const n = pts.length / 2;
	let period = dash.reduce((a, v) => a + v, 0);
	if (dash.length % 2 === 1) {
		period *= 2;
	}
	for (const [first, end] of runs) {
		ctx.lineDashOffset = period > 0 ? cum[first] % period : 0;
		ctx.beginPath();
		ctx.moveTo(pts[2 * first], pts[2 * first + 1]);
		for (let k = first + 1; k <= end; k++) {
			const i = k % n;
			ctx.lineTo(pts[2 * i], pts[2 * i + 1]);
		}
		ctx.stroke();
	}
	ctx.lineDashOffset = 0;
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
	canvas: { width: number; height: number },
	margin: Margin,
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
	// Items are in container points; the canvas starts the left and top
	// margins before the viewport.
	const x = Math.max(0, Math.floor((x0 + margin.left - padPx) * dpr));
	const y = Math.max(0, Math.floor((y0 + margin.top - padPx) * dpr));
	const w = Math.min(canvas.width, Math.ceil((x1 + margin.left + padPx) * dpr)) - x;
	const h = Math.min(canvas.height, Math.ceil((y1 + margin.top + padPx) * dpr)) - y;
	return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** The paint, and the scratch it keeps between paints. */
export class DecoPainter {
	// Stamped SIV dash centres this repaint, keyed by DASH_CELL cell
	// (plain Map rebuilt per draw; see SQUARE_SUPPRESS_R).
	private _dashSeen = new Map<number, number[]>();
	// Stamped FIR-limit stubs this repaint (FIR_LIMIT_CELL cells), one map
	// per ink so the grey internal form never suppresses the black one
	// where the two meet at a triple point.
	private _greySeen = new Map<number, number[]>();
	private _inkSeen = new Map<number, number[]>();
	// Scratch canvas for the tint-band composite (never on screen).
	private _tint: Scratch | null = null;
	// The simplified lines held, per zone and zoom, least recently used
	// first (a Map keeps its insertion order), and their vertex count.
	private _lines = new Map<DecoZone, { byZoom: Map<number, Float64Array>; vertices: number }>();
	private _lineVertices = 0;
	private _linesMade = 0;

	constructor(private readonly makeScratch: MakeScratch) {}

	/** Let go of the scratch canvases, the tint and the hatch tiles, their
	 *  stores freed at once rather than at the next collection: the next
	 *  paint makes them again. The page calls it once a worker paints in its
	 *  place. */
	release(): void {
		this._tint?.resize(0, 0);
		this._tint = null;
		for (const { scratch } of this._hatchTiles.values()) {
			scratch.resize(0, 0);
		}
		this._hatchTiles.clear();
		this._lines.clear();
		this._lineVertices = 0;
	}

	/** Let go of what is held for a zone that will not be painted again (the
	 *  worker forgets the zones the page no longer has). */
	forget(z: DecoZone): void {
		const held = this._lines.get(z);
		if (held) {
			this._lines.delete(z);
			this._lineVertices -= held.vertices;
		}
	}

	/** The simplified cached lines' vertex count, for a spec. */
	get heldLineVertices(): number {
		return this._lineVertices;
	}

	/** How many lines were simplified so far, for a spec. */
	get linesMade(): number {
		return this._linesMade;
	}

	/** A zone's line at `zoom` in world pixels: its vertices projected and
	 *  rounded as Leaflet rounds them, simplified at 1 px as it simplifies
	 *  them (simplifyLine), made once per zone and zoom and kept under the
	 *  vertex budget. */
	private _worldLine(z: DecoZone, zoom: number): Float64Array {
		let held = this._lines.get(z);
		if (held) {
			// Most recently used last.
			this._lines.delete(z);
			this._lines.set(z, held);
			const line = held.byZoom.get(zoom);
			if (line) {
				return line;
			}
		} else {
			held = { byZoom: new Map(), vertices: 0 };
			this._lines.set(z, held);
		}
		const scale = zoomScale(zoom);
		const ring = z.ring;
		const world = new Float64Array(ring.length);
		for (let o = 0; o < ring.length; o += 2) {
			world[o] = Math.round(mercatorX(ring[o + 1], scale));
			world[o + 1] = Math.round(mercatorY(ring[o], scale));
		}
		const line = simplifyLine(world, 1);
		this._linesMade++;
		held.byZoom.set(zoom, line);
		held.vertices += line.length / 2;
		this._lineVertices += line.length / 2;
		for (const [other, h] of this._lines) {
			if (this._lineVertices <= LINE_CACHE_VERTICES || other === z) {
				break;
			}
			this._lines.delete(other);
			this._lineVertices -= h.vertices;
		}
		return line;
	}

	/** The scratch tint canvas, sized to match the painted one. */
	private _tintScratch(canvas: { width: number; height: number }): Scratch | null {
		if (!this._tint) {
			this._tint = this.makeScratch(canvas.width, canvas.height);
		} else if (this._tint.width !== canvas.width || this._tint.height !== canvas.height) {
			this._tint.resize(canvas.width, canvas.height);
		}
		return this._tint;
	}

	// The hatch tile canvases, one per (families, pitch) in device px: a
	// handful per session (the zoom factors, the two families), cleared if a
	// DPR change ever makes the set grow.
	private _hatchTiles = new Map<string, { scratch: Scratch; tile: HatchTile }>();

	/** The hatch pattern for this repaint: the tile for the family (or both,
	 *  for the crosshatch) redrawn at the canvas's own phase in the projected
	 *  lattice, so the pattern repeats 1:1 from the canvas origin with no
	 *  resampling (hatchTileSize). `pitch` and `weight` in device px. */
	private _hatchPattern(
		ctx: Paint2D,
		cross: boolean,
		colour: string,
		pitch: number,
		weight: number,
		topLeftProjX: number,
		topLeftProjY: number,
		dpr: number,
	): CanvasPattern | null {
		const key = `${cross ? 'x' : '/'}|${pitch.toFixed(4)}`;
		let entry = this._hatchTiles.get(key);
		if (!entry) {
			if (this._hatchTiles.size >= 32) {
				this._hatchTiles.clear();
			}
			const tile = hatchTileSize(pitch);
			const scratch = this.makeScratch(tile.size, tile.size);
			if (!scratch) {
				return null;
			}
			entry = { scratch, tile };
			this._hatchTiles.set(key, entry);
		}
		const g = entry.scratch.ctx;
		const phase = hatchTilePhase(topLeftProjX, topLeftProjY, dpr, pitch);
		g.clearRect(0, 0, entry.tile.size, entry.tile.size);
		g.strokeStyle = colour;
		g.lineWidth = weight;
		g.beginPath();
		for (const l of hatchTileStripes(entry.tile, pitch, cross ? [1, -1] : [1], phase)) {
			g.moveTo(l.x0, l.y0);
			g.lineTo(l.x1, l.y1);
		}
		g.stroke();
		return ctx.createPattern(entry.scratch.image, 'repeat');
	}

	/** Project one airspace into a DrawItem, or null when nothing draws. The
	 *  projection is the map's own, bit for bit (containerProjection.ts),
	 *  without a LatLng and three Points per vertex. */
	private _itemFor(
		pr: ContainerProjector,
		view: ProjectionView,
		z: DecoZone,
		zoom: number,
		clip: ClipRect,
		highlighted: boolean,
		outlined: boolean,
		labels: boolean,
		lines: boolean,
	): DrawItem | null {
		const spec = z.spec;
		const b = z.bbox;
		const tlx = pr.x(b.minLon);
		const tly = pr.y(b.maxLat);
		const brx = pr.x(b.maxLon);
		const bry = pr.y(b.minLat);
		if (brx < clip.x0 || tlx > clip.x1 || bry < clip.y0 || tly > clip.y1) {
			return null;
		}
		const w = brx - tlx;
		const h = bry - tly;
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
			labels && !tiny && pass(spec.minZoom.label) &&
			// Bare boundary-line types label only alongside some other mark
			// at this zoom, so labels never outrun their symbols.
			(wantBand || wantMarks || wantGlyph || !!spec.line);
		const wantCross = tiny && spec.crossEligible;
		// Every zone with a resting line strokes it, a tiny one included, as
		// Leaflet stroked every polygon; a FIR with arcs rests strokeless, its
		// marks drawing both of its renditions (a zone has arcs only then,
		// decoZone.ts), and an emphasised zone always strokes.
		const wantLine = lines && (highlighted || outlined || (spec.line !== null && z.arcs === null));
		if (!wantBand && !wantMarks && !wantGlyph && !wantLabel && !wantCross && !highlighted && !wantLine) {
			return null;
		}
		// The ring is flat lat / lon pairs (decoZone.ts), projected whole;
		// one with more vertices than its size on screen needs (decimationStep)
		// takes Leaflet's own line at this zoom instead, simplified once and
		// moved to this view, which its band and marks follow too, so the band
		// and the line agree however many vertices the ring carries.
		const ring = z.ring;
		const n = ring.length / 2;
		let pts: Float64Array;
		if (decimationStep(n, w, h) > 1) {
			const world = this._worldLine(z, zoom);
			const { originX, originY, paneX, paneY } = view;
			pts = new Float64Array(world.length);
			for (let o = 0; o < world.length; o += 2) {
				// In the projector's own order, so a point lands where it would.
				pts[o] = world[o] - originX + paneX;
				pts[o + 1] = world[o + 1] - originY + paneY;
			}
		} else {
			pts = new Float64Array(n * 2);
			for (let i = 0, o = 0; i < n; i++, o += 2) {
				pts[o] = pr.x(ring[2 * i + 1]);
				pts[o + 1] = pr.y(ring[2 * i]);
			}
		}
		const path = new Path2D();
		path.moveTo(pts[0], pts[1]);
		for (let o = 2; o < pts.length; o += 2) {
			path.lineTo(pts[o], pts[o + 1]);
		}
		path.closePath();
		const m = wantMarks ? ringMetrics(pts) : null;
		// Metro FIR external arcs project 1:1 (they are short); the ring's
		// inward sign carries over since arcs keep the ring's vertex order.
		let arcPts: Float64Array[] | null = null;
		let internalPts: Float64Array[] | null = null;
		// A zone carries its arcs only when its marks are the comb (decoZone.ts).
		if (z.arcs && (wantMarks || highlighted)) {
			const project = (line: Float64Array): Float64Array => {
				const ap = new Float64Array(line.length);
				for (let o = 0; o < line.length; o += 2) {
					ap[o] = pr.x(line[o + 1]);
					ap[o + 1] = pr.y(line[o]);
				}
				return ap;
			};
			arcPts = z.arcs.map(project);
			internalPts = (z.internal ?? []).map(project);
		}
		return {
			z,
			spec,
			pts,
			path,
			inwardSign: m?.inwardSign ?? 1,
			perimeter: m?.perimeter ?? 0,
			cx: (tlx + brx) / 2,
			cy: (tly + bry) / 2,
			x0: tlx,
			y0: tly,
			x1: brx,
			y1: bry,
			tiny,
			small,
			highlighted,
			outlined,
			arcPts,
			internalPts,
			wantLine,
			wantBand,
			wantMarks,
			wantGlyph,
			wantLabel,
		};
	}

	/** The line pass, under everything else (where the boundary canvas sat,
	 *  below the decorations): each zone's resting line in stacking order,
	 *  largest first, then the emphasis stroke over all of them, the outlined
	 *  zones' and then the highlighted ones', as Leaflet drew the emphasis
	 *  clones over its polygons and a highlighted polygon on top. A resting
	 *  line's weight and dash follow the zoom (lineZoomFactor); the emphasis
	 *  does not. The dash restarts at each ring's first vertex. */
	private _drawLines(ctx: Paint2D, items: DrawItem[], zoom: number, clip: ClipRect, longPx: number): void {
		const factor = lineZoomFactor(zoom);
		ctx.save();
		ctx.lineJoin = 'round';
		for (const it of items) {
			const line = it.z.spec.line;
			if (it.wantLine && !it.highlighted && !it.outlined && line) {
				strokeLine(ctx, it, line, factor, clip, longPx);
			}
		}
		for (const it of items) {
			if (it.wantLine && it.outlined && !it.highlighted) {
				strokeLine(ctx, it, emphasisStroke(it.z.spec), 1, clip, longPx);
			}
		}
		for (const it of items) {
			if (it.wantLine && it.highlighted) {
				strokeLine(ctx, it, emphasisStroke(it.z.spec), 1, clip, longPx);
			}
		}
		ctx.restore();
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
		canvas: { width: number; height: number },
		ctx: Paint2D,
		items: DrawItem[],
		zoom: number,
		cross: boolean,
		frame: DecoFrame,
	): void {
		if (items.length === 0) {
			return;
		}
		const off = this._tintScratch(canvas);
		if (!off) {
			return;
		}
		const tctx = off.ctx;
		const { dpr, margin } = frame;
		const factor = bandZoomFactor(zoom);
		const colour = items[0].spec.band?.color ?? SIA.zone;
		// The band is a stroke of twice its depth centred on the boundary, so
		// half of it falls outside the ring's own bbox; the fringe weight and
		// a pixel of rounding go on top.
		const pad = Math.max(...items.map((it) => (it.spec.band?.widthPx ?? 0) * factor)) + FRINGE_WEIGHT + 2;
		const rect = compositeRect(items, pad, dpr, canvas, margin);
		if (!rect) {
			return;
		}
		tctx.setTransform(1, 0, 0, 1, 0, 0);
		tctx.clearRect(rect.x, rect.y, rect.w, rect.h);
		tctx.setTransform(dpr, 0, 0, dpr, margin.left * dpr, margin.top * dpr);
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
		// Keep the parallel-line pattern only where the bands are: ONE
		// source-in fill of the bounded rect with a repeating tile, where this
		// used to stroke every stripe crossing the canvas, which was most of
		// the repaint (docs/performance-2026-09.md). The tile lives in
		// decoGeometry.ts: it is redrawn each repaint at the canvas's own
		// phase in the PROJECTED stripe lattice (origin + topLeft; the pixel
		// origin alone is pan-invariant in Leaflet, which would leave the
		// stripes screen-anchored and re-phasing against the zones on every
		// pan), so the pattern repeats 1:1 from the canvas origin, lights the
		// lines the stroked stripes lit, and stays put while panning.
		const spacing = (cross ? CROSS_SPACING : HATCH_SPACING) * factor;
		const pitch = Math.max(2, spacing * INV_SQRT2);
		const fw = FRINGE_WEIGHT * lineZoomFactor(zoom);
		const weight = items.some((it) => it.highlighted) ? fw + 0.25 : fw;
		const origin = { x: frame.view.originX, y: frame.view.originY };
		const topLeft = frame.topLeft;
		const pattern = this._hatchPattern(
			tctx,
			cross,
			colour,
			pitch * dpr,
			weight * dpr,
			origin.x + topLeft.x,
			origin.y + topLeft.y,
			dpr,
		);
		if (pattern) {
			tctx.save();
			tctx.setTransform(1, 0, 0, 1, 0, 0);
			tctx.globalCompositeOperation = 'source-in';
			tctx.fillStyle = pattern;
			tctx.fillRect(rect.x, rect.y, rect.w, rect.h);
			tctx.restore();
		}
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.drawImage(off.image, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
		ctx.restore();
	}

	/** RTBA zones overlay a thick solid pecked strip tight on the inside
	 *  edge (the GEN 2.3 "R 45 A" symbol), drawn per zone over the fringe. */
	private _drawPeckedStrip(
		ctx: Paint2D,
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
		ctx: Paint2D,
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
		ctx: Paint2D,
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
		ctx: Paint2D,
		it: DrawItem,
		x: number,
		y: number,
		placed: { x: number; y: number; w: number; h: number }[],
	): void {
		const label = it.z.label;
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

	/** Paint `zones` (the rows shown, largest first) and the `highlighted`
	 *  ones (drawn whatever the filters; usually one, several when a nav-log
	 *  frequency line names every sector sharing it) onto `ctx`, the whole of
	 *  `canvas` cleared first, for the view `frame` describes. The `outlined` ones
	 *  (linked to a selected NOTAM) take the emphasis stroke where they are
	 *  drawn. */
	paint(
		ctx: Paint2D,
		canvas: { width: number; height: number },
		frame: DecoFrame,
		zones: readonly DecoZone[],
		highlighted: readonly DecoZone[],
		outlined: readonly DecoZone[] = [],
	): void {
		const { dpr, margin } = frame;
		// Clear, then draw in container points: the ratio and the follow-mode
		// margin in one transform.
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.setTransform(dpr, 0, 0, dpr, margin.left * dpr, margin.top * dpr);
		const zoom = frame.view.zoom;
		if (paintsNothing(zoom, zones, highlighted)) {
			return;
		}
		const hlKeys = new Set(highlighted.map((z) => z.key));
		const outlinedKeys = new Set(outlined.map((z) => z.key));
		const extent = {
			x0: -margin.left,
			y0: -margin.top,
			x1: frame.size.x + margin.right,
			y1: frame.size.y + margin.bottom,
		};
		const clip: ClipRect = {
			x0: extent.x0 - CLIP_PAD,
			y0: extent.y0 - CLIP_PAD,
			x1: extent.x1 + CLIP_PAD,
			y1: extent.y1 + CLIP_PAD,
		};
		// Project visible zones (largest first, so small zones overprint);
		// the highlighted airspaces join unconditionally and draw last.
		const pr = containerProjector(frame.view);
		const items: DrawItem[] = [];
		const seen = new Set<string>();
		for (const z of zones) {
			const hl = hlKeys.has(z.key);
			if (hl) {
				seen.add(z.key);
			}
			const it = this._itemFor(pr, frame.view, z, zoom, clip, hl, outlinedKeys.has(z.key), frame.labels, frame.lines);
			if (it) {
				items.push(it);
			}
		}
		for (const z of highlighted) {
			if (seen.has(z.key)) {
				continue;
			}
			const it = this._itemFor(pr, frame.view, z, zoom, clip, true, outlinedKeys.has(z.key), frame.labels, frame.lines);
			if (it) {
				items.push(it);
			}
		}
		// Pass 0: the boundary lines, when asked for.
		if (frame.lines) {
			const longPx = LONG_DASHED_RING * 2 * (extent.x1 - extent.x0 + extent.y1 - extent.y0);
			this._drawLines(ctx, items, zoom, clip, longPx);
		}
		// Pass 1: bands (clip + thick stroke), capped. Tint bands go through
		// the offscreen composite; the ink fringes draw direct afterwards so
		// they aren't washed by the blend.
		const tintItems: DrawItem[] = [];
		const fringeItems: DrawItem[] = [];
		const banded = items.filter((it) => it.wantBand && it.spec.band);
		for (const it of withinBandBudget(banded, MAX_BAND_RINGS, frame.size)) {
			if (it.spec.band?.kind === 'solid') {
				tintItems.push(it);
			} else {
				fringeItems.push(it);
			}
		}
		const plainTint = tintItems.filter((it) => !it.highlighted);
		if (plainTint.length > 0) {
			const tint = this._tintScratch(canvas);
			const tintPad =
				Math.max(...plainTint.map((it) => (it.spec.band?.widthPx ?? 0))) * bandZoomFactor(zoom) + 2;
			const rect = compositeRect(plainTint, tintPad, dpr, canvas, margin);
			if (tint && rect) {
				const tctx = tint.ctx;
				tctx.setTransform(1, 0, 0, 1, 0, 0);
				tctx.clearRect(rect.x, rect.y, rect.w, rect.h);
				tctx.setTransform(dpr, 0, 0, dpr, margin.left * dpr, margin.top * dpr);
				for (const it of plainTint) {
					this._drawTintBand(tctx, it, zoom);
				}
				ctx.save();
				ctx.setTransform(1, 0, 0, 1, 0, 0);
				ctx.globalAlpha = BAND_TINT_ALPHA;
				ctx.drawImage(tint.image, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
				ctx.restore();
			}
		}
		for (const it of tintItems) {
			if (it.highlighted) {
				this._drawTintBand(ctx, it, zoom);
			}
		}
		this._drawFringePattern(
			canvas, ctx, fringeItems.filter((it) => it.spec.band?.kind !== 'cross'), zoom, false, frame,
		);
		this._drawFringePattern(
			canvas, ctx, fringeItems.filter((it) => it.spec.band?.kind === 'cross'), zoom, true, frame,
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
		// the highlighted label always places. Between two zones of one area
		// (the same ring, twice: TMA PARIS 4 and R 205 /4), the one drawn on
		// top names it, so the line on top and the label beside it agree.
		const placed: { x: number; y: number; w: number; h: number }[] = [];
		const labelled = items.filter((it) => it.wantLabel && !it.tiny);
		const stacked = new Map(labelled.map((it, i) => [it, i]));
		labelled.sort((p, q) =>
			p.highlighted !== q.highlighted
				? (p.highlighted ? -1 : 1)
				: p.z.area - q.z.area || (stacked.get(q) ?? 0) - (stacked.get(p) ?? 0),
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
