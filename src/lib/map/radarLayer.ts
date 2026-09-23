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
 * The paint: an index map, rebuilt only when the view changed, says which
 * pooled cell each CSS pixel reads; a frame is then one lookup a pixel into
 * an ImageData, put on an offscreen canvas and drawn onto the layer canvas
 * under the device-pixel scale with the opacity (putImageData ignores both).
 * Inks are fixed hex from $lib/weather/opera (map overlays never read CSS
 * variables); the no-coverage label comes in as a parameter, since map
 * modules import no catalog. */

import type L from 'leaflet';
import { DirectDrawLayer, ensurePane } from './directDrawLayer';
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
	hatchPhaseOf,
	paintFrame,
	type IndexMap,
	type RadarCells,
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
/** The no-coverage label repeats on this lattice, from this zoom. */
const LABEL_STEP_PX = 360;
const LABEL_MIN_ZOOM = 5;

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
	private _radarIndexKey = '';
	private _radarIndex: IndexMap | null = null;
	private _radarIndexProduct: OperaProduct = 'DBZH';
	private _radarImg: ImageData | null = null;
	private _radarU32: Uint32Array | null = null;
	private _offscreen: HTMLCanvasElement | null = null;

	/** The index map the last paint read through and the product (grid) it
	 *  was built for; null before a paint. */
	paintedIndex(): { index: IndexMap; product: OperaProduct } | null {
		return this._radarIndex ? { index: this._radarIndex, product: this._radarIndexProduct } : null;
	}

	/** The buffers go with the layer: a hidden radar holds no ImageData,
	 *  offscreen canvas or index map (a desktop view's dozen megabytes). */
	override onRemove(map: L.Map): this {
		super.onRemove(map);
		this._radarIndex = null;
		this._radarIndexKey = '';
		this._radarImg = null;
		this._radarU32 = null;
		this._offscreen = null;
		return this;
	}

	protected override _draw(): void {
		const canvas = this._canvas;
		const ctx = this._ctx;
		const map = this._map;
		const st = this._drawState;
		if (!canvas || !ctx || !map || !st) {
			return;
		}
		const dpr = window.devicePixelRatio || 1;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.scale(dpr, dpr);
		const { frameKey, product } = data;
		if (!frameKey) {
			return;
		}
		const lats = map.getBounds();
		const p = poolingAt(st.zoom, lats.getSouth(), lats.getNorth(), OPERA_PRODUCT_INFO[product].grid.cellM);
		const size = map.getSize();
		const w = Math.max(1, Math.round(size.x));
		const h = Math.max(1, Math.round(size.y));
		// The product leads the key: the same view on the other grid is
		// another index map.
		const key = `${product}|${st.zoom}|${st.origin.x}|${st.origin.y}|${st.topLeft.x}|${st.topLeft.y}|${w}|${h}|${p}`;
		if (key !== this._radarIndexKey || !this._radarIndex) {
			this._radarIndex = buildIndexMap(
				{
					w,
					h,
					zoom: st.zoom,
					originX: st.origin.x,
					originY: st.origin.y,
					topLeftX: st.topLeft.x,
					topLeftY: st.topLeft.y,
				},
				p,
				OPERA_PRODUCT_INFO[product].grid,
			);
			this._radarIndexKey = key;
			this._radarIndexProduct = product;
		}
		if (!this._radarImg || this._radarImg.width !== w || this._radarImg.height !== h) {
			this._radarImg = new ImageData(w, h);
			this._radarU32 = new Uint32Array(this._radarImg.data.buffer);
			if (!this._offscreen) {
				this._offscreen = document.createElement('canvas');
			}
			this._offscreen.width = w;
			this._offscreen.height = h;
		}
		const index = this._radarIndex;
		const tileAt = (i: number): RadarCells | null => data.tileAt(frameKey, i, p);
		const hatch = data.coverage
			? { rgba: HATCH_RGBA, phase: hatchPhaseOf(st.origin.x + st.topLeft.x, st.origin.y + st.topLeft.y) }
			: null;
		paintFrame(this._radarU32!, index, tileAt, PAINTS[product], hatch);
		const off = this._offscreen!.getContext('2d');
		if (!off) {
			return;
		}
		off.putImageData(this._radarImg, 0, 0);
		ctx.globalAlpha = data.opacity;
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(this._offscreen!, 0, 0, w, h);
		ctx.globalAlpha = 1;
		if (data.coverage && data.noCoverageLabel && st.zoom >= LABEL_MIN_ZOOM) {
			this.labelNoCoverage(ctx, index, tileAt, w, h);
		}
	}

	/** The sparse "No radar coverage" label on a lattice, where the pixel
	 *  under the lattice point reads no coverage. */
	private labelNoCoverage(
		ctx: CanvasRenderingContext2D,
		index: IndexMap,
		tileAt: (i: number) => RadarCells | null,
		w: number,
		h: number,
	): void {
		ctx.font = LABEL_FONT;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'center';
		ctx.lineWidth = 3;
		ctx.strokeStyle = LABEL_HALO;
		ctx.fillStyle = LABEL_INK;
		ctx.globalAlpha = 0.85;
		for (let y = LABEL_STEP_PX / 2; y < h; y += LABEL_STEP_PX) {
			for (let x = LABEL_STEP_PX / 2; x < w; x += LABEL_STEP_PX) {
				const i = y * w + x;
				const t = index.tile[i];
				if (t === OUTSIDE) {
					continue;
				}
				const arr = tileAt(t);
				if (!arr || arr[index.off[i]] !== NODATA) {
					continue;
				}
				ctx.strokeText(data.noCoverageLabel, x, y);
				ctx.fillText(data.noCoverageLabel, x, y);
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
	const p = layer.paintedIndex()?.index.p ?? 1;
	const arr = data.tileAt(data.frameKey, tile, p);
	if (!arr) {
		return null;
	}
	const pooledW = T / p;
	return sampleOf(arr[Math.floor((r % T) / p) * pooledW + Math.floor((c % T) / p)], product, data.frameKey);
}

/** The sample the LAST PAINT drew at a container pixel, read through the
 *  same index map and the same decoded tile, so the hover badge names the
 *  class whose colour is under the cursor. radarSampleAt projects the
 *  exact position instead, and where a pooled cell spans about one screen
 *  pixel the two can name adjacent cells (the desktop drive read "38 dBZ"
 *  over a yellow 30-35 pixel). Null before a paint, off the composite, or
 *  while the tile is not decoded. */
export function radarSampleAtPixel(x: number, y: number): RadarSample | null {
	if (!layer || !visible || !data.frameKey) {
		return null;
	}
	const painted = layer.paintedIndex();
	// An index map of the other grid (a switch not yet repainted) reads
	// nothing rather than the wrong cell.
	if (!painted || painted.product !== data.product) {
		return null;
	}
	const { index } = painted;
	if (x < 0 || y < 0 || x >= index.w || y >= index.h) {
		return null;
	}
	const i = y * index.w + x;
	const tile = index.tile[i];
	if (tile === OUTSIDE) {
		return null;
	}
	const arr = data.tileAt(data.frameKey, tile, index.p);
	return arr ? sampleOf(arr[index.off[i]], data.product, data.frameKey) : null;
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
