/* radarLayer.ts draws the EUMETNET OPERA precipitation composites on a
 * direct-draw canvas (pane 'radar', z 340: over the chart rasters and the
 * VAC panels, under the airspaces so every boundary stays readable; a
 * raster, so it joins the night-dim family in app.css). The PRODUCT comes
 * in with the feed (DBZH on the 1 km grid, RATE on the 2 km one): the index
 * map is keyed by it, the paint (LUT + Level 6 texture) is the product's,
 * and every sample carries it. A passive overlay:
 * the canvas is pointer-transparent (DirectDrawLayer default), there is no
 * hit-test beyond the two sample readers (radarSampleAtPixel for the hover
 * badge, radarSampleAt for the context menu), and no highlight. The decoded
 * tiles come from $lib/state/radar.svelte.ts through the tileAt callback the
 * payload carries; the layer only paints them (docs/precipitation-radar.md
 * "Map and panels").
 *
 * The paint: an index map says which pooled cell each CSS pixel reads; a
 * frame is then one lookup a pixel into an ImageData, put on an offscreen
 * canvas and drawn onto the layer canvas under the device-pixel scale with
 * the opacity (putImageData ignores both). The index map and the image are
 * anchored to Leaflet's PROJECTED pixels, not to the canvas: the map is
 * built and kept in squares of INDEX_TILE_PX, so a painting after a pan
 * builds only the squares it brings in, and the image starts at the whole
 * projected pixel at or before the canvas's corner (a drag can leave the
 * pane between two), one pixel wider and taller, drawn that fraction back.
 * A painting of the same feed, zoom and pooling keeps the image before it:
 * copied into a second canvas at the whole-pixel offset the pan moved it by
 * (a copy the GPU makes), only the bands the pan brought in painted and put;
 * a new feed is painted whole.
 *
 * It paints while the map moves (directDrawLayer.ts), each painting reaching
 * ahead of the view on the side it goes toward, while a frame is shown and
 * its paintings made WHILE THE MAP MOVES cost the move little (the motion
 * budget the other layers on the page share): those alone feed the average,
 * since a settle's paint (a drag the radar did not follow leaves most of the
 * image to paint again) or a new feed's whole painting says nothing of a
 * band painted under a moving map, the phone's clocks and cores busy with
 * the move. On the Redmi those cost 7 ms at the median and
 * 18 at the 90th percentile, and painting them whatever their cost added a
 * missed frame or two a swipe: the gate holds the radar to the settles
 * there, and tries again a minute after its last painting in motion, so a
 * device that was only busy for a moment gets it back. The pooling is held through a movement, so a drag across
 * the latitude where the view would read another never repaints whole; the
 * settle takes the view's, and repaints when it differs. The radar tiles are
 * asked for after the view settles, as before.
 * The hover reads the projected pixel under the cursor through the same
 * cells, so it names the class drawn there wherever the canvas stands. Inks
 * are fixed hex from $lib/weather/opera (map overlays never read CSS
 * variables); the no-coverage label comes in as a parameter, since map
 * modules import no catalog. */

import type L from 'leaflet';
import { rectMinus } from './canvasPlacement';
import { DirectDrawLayer, ensurePane, type CanvasTarget } from './directDrawLayer';
import { gridColRow, gridContains } from '$lib/weather/laea';
import {
	NODATA,
	NO_COVERAGE_COLOR,
	OPERA_PRODUCT_INFO,
	RADAR_SCALES,
	UNDETECT,
	buildPaint,
	cellClass,
	hexRgba,
	poolingAt,
	type OperaProduct,
	type RadarPaint,
	type RadarSample,
} from '$lib/weather/opera';
import {
	OUTSIDE,
	buildIndexMap,
	paintFrame,
	type IndexMap,
	type PixelRect,
	type RadarCells,
	type Raster,
} from '$lib/weather/radarDecode';

const PANE = 'radar';
// 340 sits between the VAC panels (300) and the airspace polygons (350):
// a raster under every line of symbology.
const PANE_Z = '340';
/** The credit CC BY 4.0 asks for, the licensor and the licence each linked
 *  (the chart credits' shape), folded by attributionCredit.ts; the About
 *  modal carries the producers and the modification statement. */
// i18n-ignore: publisher name + licence, invariant
const ATTRIBUTION =
	'Radar <a href="https://eumetnet.github.io/openradardata-documentation/">EUMETNET OPERA</a>, <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>';
const HATCH_RGBA = hexRgba(NO_COVERAGE_COLOR, 110);
const LABEL_FONT = '600 11px system-ui, sans-serif'; // i18n-ignore: CSS font shorthand, not display text
const LABEL_INK = '#546e7a';
const LABEL_HALO = 'rgba(255, 255, 255, 0.8)';
/** The no-coverage label repeats on this lattice of projected pixels, from
 *  this zoom. */
const LABEL_STEP_PX = 360;
const LABEL_MIN_ZOOM = 5;
/** The index map is built and kept in squares of this many projected
 *  pixels: a painting reads the squares it covers, and the one after a pan
 *  builds only those it brings in. */
const INDEX_TILE_PX = 64;
/** The squares kept, as a share of those the newest painting read. */
const INDEX_KEEP = 1.5;

/** A gate the radar's paintings in motion closed opens again this long
 *  after the last of them, ms, to measure them anew. */
const RADAR_RETRY_MS = 60_000;

/** What a painting holds: its image's rectangle of projected pixels, the
 *  zoom and pooling it was made at, and its product (grid). */
export interface RadarPainted extends PixelRect {
	zoom: number;
	p: number;
	product: OperaProduct;
}

/** The layer's whole prepared feed (one call per change from MapView). */
export interface RadarLayerData {
	product: OperaProduct;
	/** The frame drawn; null paints nothing (hidden, expired, no frame). */
	frameKey: string | null;
	tileAt: (t: string, tile: number, p: number) => RadarCells | null;
	/** 0..1 */
	opacity: number;
	/** Draw the no-coverage hatch and its label. */
	coverage: boolean;
	noCoverageLabel: string;
}

let layer: RadarCanvasLayer | null = null;
let layerMap: L.Map | null = null;
let visible = false;
let data: RadarLayerData = {
	product: 'DBZH',
	frameKey: null,
	tileAt: () => null,
	opacity: 0.7,
	coverage: true,
	noCoverageLabel: '',
};
const PAINTS: Record<OperaProduct, RadarPaint> = { DBZH: buildPaint('DBZH'), RATE: buildPaint('RATE') };

class RadarCanvasLayer extends DirectDrawLayer {
	protected override readonly canvasClass = 'leaflet-radar-canvas';
	protected override readonly paneName = PANE;

	// Prefixed, never Leaflet's own: L.Evented keeps private _on / _off
	// helpers on the prototype, and a field named _off shadowed the one
	// removeLayer calls (found by the desktop drive).
	/** The index squares, by product, zoom, pooling and place, least
	 *  recently read first. */
	private _radarSquares = new Map<string, IndexMap>();
	private _radarImg: ImageData | null = null;
	private _radarU32: Uint32Array | null = null;
	/** The image, twice: the one on screen and the one the next painting is
	 *  made in, swapped after each. */
	private _radarFront: HTMLCanvasElement | null = null;
	private _radarBack: HTMLCanvasElement | null = null;
	/** The feed the image in front was painted from. */
	private _radarFed: RadarLayerData | null = null;
	/** Whether the painting queued was asked for while the map moves, and
	 *  when the last such painting was made. */
	private _radarMoving = false;
	private _radarMovedAt = -Infinity;
	private _radarPainted: RadarPainted | null = null;

	/** What the newest painting holds; null before one, or when it drew no
	 *  frame. */
	painted(): RadarPainted | null {
		return this._radarPainted;
	}

	/** While a frame is shown and its paintings in motion cost the move
	 *  little; a closed gate is opened again RADAR_RETRY_MS after the last of
	 *  them, its average forgotten, for the next drag to measure. */
	protected override paintsInMotion(): boolean {
		if (data.frameKey === null) {
			return false;
		}
		if (!this._paintsCheaply() && performance.now() - this._radarMovedAt > RADAR_RETRY_MS) {
			this._paintAvgMs = null;
		}
		return this._paintsCheaply();
	}

	/** A painting asked for while the map moves: the gate's average takes
	 *  it. */
	protected override _askPainting(): void {
		this._radarMoving = true;
		super._askPainting();
	}

	/** A settle the newest painting covers paints nothing, unless the view
	 *  now reads at another pooling than the one held through the movement. */
	protected override _covered(t: CanvasTarget): boolean {
		const map = this._map;
		const prev = this._radarPainted;
		if (map && prev && prev.zoom === t.zoom && prev.p !== this._radarPooling(map, t.zoom)) {
			return false;
		}
		return super._covered(t);
	}

	/** The pooling the view reads at, at `zoom` (poolingAt over its
	 *  latitudes). */
	private _radarPooling(map: L.Map, zoom: number): number {
		const lats = map.getBounds();
		return poolingAt(zoom, lats.getSouth(), lats.getNorth(), OPERA_PRODUCT_INFO[data.product].grid.cellM);
	}

	/** The buffers go with the layer: a hidden radar holds no ImageData,
	 *  offscreen canvas or index map (a desktop view's dozen megabytes). */
	override onRemove(map: L.Map): this {
		super.onRemove(map);
		this._radarSquares.clear();
		this._radarImg = null;
		this._radarU32 = null;
		this._radarFront = null;
		this._radarBack = null;
		this._radarFed = null;
		this._radarPainted = null;
		return this;
	}

	/** The index square (tx, ty) of `product` at `zoom` and pooling `p`, read
	 *  from the kept ones or built. */
	private _radarSquare(product: OperaProduct, zoom: number, p: number, tx: number, ty: number): IndexMap {
		const key = `${product}|${zoom}|${p}|${tx}|${ty}`;
		let sq = this._radarSquares.get(key);
		if (sq) {
			this._radarSquares.delete(key);
		} else {
			const S = INDEX_TILE_PX;
			sq = buildIndexMap({ x: tx * S, y: ty * S, w: S, h: S, zoom }, p, OPERA_PRODUCT_INFO[product].grid);
		}
		this._radarSquares.set(key, sq);
		return sq;
	}

	/** Paint rectangle `r` of a frame into the image, square by square. */
	private _radarPaint(
		out: Raster,
		r: PixelRect,
		zoom: number,
		p: number,
		product: OperaProduct,
		tileAt: (i: number) => RadarCells | null,
	): void {
		const S = INDEX_TILE_PX;
		const hatch = data.coverage ? HATCH_RGBA : null;
		for (let ty = Math.floor(r.y / S); ty * S < r.y + r.h; ty++) {
			for (let tx = Math.floor(r.x / S); tx * S < r.x + r.w; tx++) {
				const x0 = Math.max(r.x, tx * S);
				const y0 = Math.max(r.y, ty * S);
				const x1 = Math.min(r.x + r.w, (tx + 1) * S);
				const y1 = Math.min(r.y + r.h, (ty + 1) * S);
				paintFrame(out, this._radarSquare(product, zoom, p, tx, ty), { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, tileAt, PAINTS[product], hatch);
			}
		}
	}

	/** Drop the squares read least recently past INDEX_KEEP of a painting of
	 *  `w` x `h`. */
	private _radarPrune(w: number, h: number): void {
		const S = INDEX_TILE_PX;
		const keep = Math.ceil((Math.ceil(w / S) + 1) * (Math.ceil(h / S) + 1) * INDEX_KEEP);
		for (const key of this._radarSquares.keys()) {
			if (this._radarSquares.size <= keep) {
				return;
			}
			this._radarSquares.delete(key);
		}
	}

	protected override _draw(): void {
		const canvas = this._canvas;
		const ctx = this._ctx;
		const map = this._map;
		const a = this._applied;
		// Whether this painting was asked for while the map moves (consumed
		// whatever the paint does).
		const moving = this._radarMoving;
		this._radarMoving = false;
		if (!canvas || !ctx || !map || !a) {
			return;
		}
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.setTransform(a.dpr, 0, 0, a.dpr, 0, 0);
		const { frameKey, product } = data;
		if (!frameKey) {
			this._radarPainted = null;
			return;
		}
		// The pooling: the newest painting's while the map moves at its zoom,
		// so the image is moved along rather than painted whole; the view's.
		const prev = this._radarPainted;
		const v = this._velocity(performance.now());
		const p =
			(v.x !== 0 || v.y !== 0) && prev && prev.zoom === a.zoom && prev.product === product
				? prev.p
				: this._radarPooling(map, a.zoom);
		// The canvas's corner in projected pixels, which a drag can leave
		// between two: the image starts at the whole pixel at or before it,
		// covers the canvas, and is drawn that fraction back.
		const ex = a.origin.x + a.topLeft.x;
		const ey = a.origin.y + a.topLeft.y;
		const x = Math.floor(ex);
		const y = Math.floor(ey);
		const w = Math.max(1, Math.ceil(ex + a.cssW) - x);
		const h = Math.max(1, Math.ceil(ey + a.cssH) - y);
		if (!this._radarImg || this._radarImg.width !== w || this._radarImg.height !== h) {
			this._radarImg = new ImageData(w, h);
			this._radarU32 = new Uint32Array(this._radarImg.data.buffer);
		}
		const back = this._radarBack ?? document.createElement('canvas');
		if (back.width !== w || back.height !== h) {
			back.width = w;
			back.height = h;
		}
		const bctx = back.getContext('2d');
		if (!bctx || !this._radarImg || !this._radarU32) {
			return;
		}
		// What is still to paint: the bands a pan brought in when the image in
		// front was painted from this feed at this zoom and pooling, moved
		// along at the offset of its corner; all of it otherwise.
		const r = { x, y, w, h };
		const front = this._radarFront;
		let todo: PixelRect[] = [r];
		const kept = !!front && !!prev && this._radarFed === data && prev.zoom === a.zoom && prev.p === p && prev.product === product;
		if (front && prev && kept) {
			todo = rectMinus(r, prev);
			bctx.setTransform(1, 0, 0, 1, 0, 0);
			bctx.clearRect(0, 0, w, h);
			bctx.drawImage(front, 0, 0, prev.w, prev.h, prev.x - x, prev.y - y, prev.w, prev.h);
		}
		// The motion gate's average takes the paintings made while the map
		// moves alone: what following a move costs.
		this._paintAside = !moving;
		if (moving) {
			this._radarMovedAt = performance.now();
		}
		const tileAt = (i: number): RadarCells | null => data.tileAt(frameKey, i, p);
		const raster = { data: this._radarU32, x, y, w, h };
		for (const band of todo) {
			this._radarPaint(raster, band, a.zoom, p, product, tileAt);
			bctx.putImageData(this._radarImg, 0, 0, band.x - x, band.y - y, band.w, band.h);
		}
		this._radarBack = front;
		this._radarFront = back;
		this._radarFed = data;
		ctx.globalAlpha = data.opacity;
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(back, 0, 0, w, h, x - ex, y - ey, w, h);
		ctx.globalAlpha = 1;
		this._radarPainted = { x, y, w, h, zoom: a.zoom, p, product };
		if (data.coverage && data.noCoverageLabel && a.zoom >= LABEL_MIN_ZOOM) {
			this._radarLabels(ctx, { x: ex, y: ey, w: a.cssW, h: a.cssH }, a.zoom, p, product, tileAt);
		}
		this._radarPrune(w, h);
	}

	/** The sparse "No radar coverage" label on a lattice of projected
	 *  pixels, where the pixel under the lattice point reads no coverage;
	 *  `view` is the canvas's extent, its corner in projected pixels. */
	private _radarLabels(
		ctx: CanvasRenderingContext2D,
		view: PixelRect,
		zoom: number,
		p: number,
		product: OperaProduct,
		tileAt: (i: number) => RadarCells | null,
	): void {
		ctx.font = LABEL_FONT;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'center';
		ctx.lineWidth = 3;
		ctx.strokeStyle = LABEL_HALO;
		ctx.fillStyle = LABEL_INK;
		ctx.globalAlpha = 0.85;
		const S = INDEX_TILE_PX;
		const half = LABEL_STEP_PX / 2;
		const first = (v: number): number => Math.ceil((v - half) / LABEL_STEP_PX) * LABEL_STEP_PX + half;
		for (let y = first(view.y); y < view.y + view.h; y += LABEL_STEP_PX) {
			for (let x = first(view.x); x < view.x + view.w; x += LABEL_STEP_PX) {
				const sq = this._radarSquare(product, zoom, p, Math.floor(x / S), Math.floor(y / S));
				const i = (y - sq.y) * S + (x - sq.x);
				const t = sq.tile[i];
				if (t === OUTSIDE) {
					continue;
				}
				const arr = tileAt(t);
				if (!arr || arr[sq.off[i]] !== NODATA) {
					continue;
				}
				ctx.strokeText(data.noCoverageLabel, x + 0.5 - view.x, y + 0.5 - view.y);
				ctx.fillText(data.noCoverageLabel, x + 0.5 - view.x, y + 0.5 - view.y);
			}
		}
		ctx.globalAlpha = 1;
	}
}

/** Build the layer once (idempotent); attached by syncRadarLayer. */
export function buildRadarLayer(map: L.Map): void {
	if (layer) {
		return;
	}
	layerMap = map;
	ensurePane(map, PANE, PANE_Z);
	layer = new RadarCanvasLayer();
	layer.options.attribution = ATTRIBUTION;
}

/** Hand the layer its feed and repaint. */
export function setRadarData(next: RadarLayerData): void {
	data = next;
	if (layerMap) {
		syncNow(layerMap);
	}
}

/** Reconcile attachment with the show-on-map toggle and redraw. */
export function syncRadarLayer(map: L.Map, on: boolean): void {
	visible = on;
	syncNow(map);
}

function syncNow(map: L.Map): void {
	if (!layer) {
		return;
	}
	const has = map.hasLayer(layer);
	if (visible && !has) {
		layer.addTo(map);
	} else if (!visible && has) {
		map.removeLayer(layer);
	} else if (has) {
		layer.redraw();
	}
}

/** A stored cell as a sample: the sentinels by kind, a value in the
 *  product's unit (the tenths of mm/h divided back). A cell under the
 *  display floor reads as a dry one: the paint draws nothing there (cloud,
 *  drizzle and clutter, docs/precipitation-radar.md "The scale"), and a
 *  reading of "8 dBZ" over a blank pixel would name precipitation the
 *  legend says is not there. */
function sampleOf(v: number, product: OperaProduct, t: string): RadarSample {
	if (v === NODATA) {
		return { kind: 'nocoverage', product, value: null, t };
	}
	if (v === UNDETECT || cellClass(v, RADAR_SCALES[product]) < 0) {
		return { kind: 'none', product, value: null, t };
	}
	return { kind: 'echo', product, value: OPERA_PRODUCT_INFO[product].unit === 'mm/h' ? v / 10 : v, t };
}

/** What the shown frame holds under a point: the value of the pooled cell
 *  drawn there, a dry cell, or no coverage; null while the layer is
 *  hidden, off the composite, or the tile is not decoded yet. The context
 *  menu's reader (a long press has no pixel worth keeping). */
export function radarSampleAt(lat: number, lon: number): RadarSample | null {
	if (!layer || !visible || !data.frameKey) {
		return null;
	}
	const { product } = data;
	const grid = OPERA_PRODUCT_INFO[product].grid;
	const g = gridColRow(lat, lon, grid);
	if (!g || !gridContains(g.col, g.row, grid)) {
		return null;
	}
	const T = grid.tile;
	const c = Math.floor(g.col);
	const r = Math.floor(g.row);
	const tile = Math.floor(r / T) * grid.tileCols + Math.floor(c / T);
	// The pooling the last paint drew at (the cell the map shows there).
	const p = layer.painted()?.p ?? 1;
	const arr = data.tileAt(data.frameKey, tile, p);
	if (!arr) {
		return null;
	}
	const pooledW = T / p;
	return sampleOf(arr[Math.floor((r % T) / p) * pooledW + Math.floor((c % T) / p)], product, data.frameKey);
}

/** The sample the NEWEST PAINTING drew under a container point (exact, not
 *  floored), read through the cell its projected pixel maps to at that
 *  painting's zoom and pooling, so the hover badge names the class whose
 *  colour is under the cursor, wherever the canvas stands (a lead, a glide,
 *  a pane a drag left between two pixels). radarSampleAt projects the exact
 *  position instead, and where a pooled cell spans about one screen pixel
 *  the two can name adjacent cells (the desktop drive read "38 dBZ" over a
 *  yellow 30-35 pixel). Null before a paint, off it, off the composite, or
 *  while the tile is not decoded. */
export function radarSampleAtPixel(x: number, y: number): RadarSample | null {
	const map = layerMap;
	if (!layer || !visible || !data.frameKey || !map) {
		return null;
	}
	const painted = layer.painted();
	// A painting of the other grid (a switch not yet repainted) reads
	// nothing rather than the wrong cell.
	if (!painted || painted.product !== data.product || painted.zoom !== map.getZoom()) {
		return null;
	}
	const at = map.containerPointToLayerPoint([x, y]);
	const o = map.getPixelOrigin();
	const px = Math.floor(o.x + at.x);
	const py = Math.floor(o.y + at.y);
	if (px < painted.x || py < painted.y || px >= painted.x + painted.w || py >= painted.y + painted.h) {
		return null;
	}
	const cell = buildIndexMap({ x: px, y: py, w: 1, h: 1, zoom: painted.zoom }, painted.p, OPERA_PRODUCT_INFO[painted.product].grid);
	if (cell.tile[0] === OUTSIDE) {
		return null;
	}
	const arr = data.tileAt(data.frameKey, cell.tile[0], painted.p);
	return arr ? sampleOf(arr[cell.off[0]], data.product, data.frameKey) : null;
}

/** Detach and drop the layer; buildRadarLayer must rebuild (HMR teardown). */
export function clearRadarLayer(map: L.Map): void {
	if (layer && map.hasLayer(layer)) {
		map.removeLayer(layer);
	}
	layer = null;
	layerMap = null;
	visible = false;
	data = { ...data, frameKey: null };
}
