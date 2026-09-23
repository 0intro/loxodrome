/* radarDecode.ts: from a composite tile's bytes to what the canvas paints.
 * Three pure steps (docs/precipitation-radar.md "Client shape"): the
 * inflated tile's Float32 pairs become one integer a cell, an Int8
 * reflectivity or an Int16 tenth of a millimetre per hour, with the two
 * ODIM states as sentinels; a tile is MAX-pooled to the map's resolution
 * (the maximum, never a mean: ICAO Doc 8896 App. 9 3.2.2 and EASA AMC9
 * SPA.EFB.100(b)(3) both require a reformatting to preserve the most
 * intense cell, and the product itself is a maximum composite); and a
 * view's index map, computed once per view, says which pooled cell each
 * canvas pixel reads, so an animation frame is one lookup a pixel. Pure:
 * no Leaflet, no state, no catalog. */

import { gridColRow, gridContains, type OperaGrid } from './laea';
import {
	LUT_OFFSET,
	NODATA,
	RATE_CELL_MAX,
	RAW_NODATA,
	UNDETECT,
	type OperaProduct,
	type RadarPaint,
} from './opera';

/** A decoded tile: dBZ cells (Int8) or tenths of mm/h (Int16), the two
 *  sentinels the same values in both. */
export type RadarCells = Int8Array | Int16Array;

/** Reflectivities are kept to the dB; a real value never nears the
 *  sentinels (-32 dBZ is the lowest the composite carries). */
const DBZ_MIN = -100;
const DBZ_MAX = 100;

function floatsOf(inflated: Uint8Array): Float32Array {
	return inflated.byteOffset % 4 === 0
		? new Float32Array(inflated.buffer, inflated.byteOffset, inflated.byteLength >> 2)
		: new Float32Array(inflated.slice().buffer);
}

/** Decode an inflated DBZH tile: the first of each pixel's samples is the
 *  reflectivity (the second the quality index), NaN is no echo and the
 *  raw nodata no coverage. Little-endian floats, the OPERA layout's. */
export function decodeDbzTile(inflated: Uint8Array, samplesPerPixel = 2, rawNodata = RAW_NODATA): Int8Array {
	const floats = floatsOf(inflated);
	const n = Math.floor(floats.length / samplesPerPixel);
	const out = new Int8Array(n);
	for (let i = 0; i < n; i++) {
		const v = floats[i * samplesPerPixel];
		if (v !== v) {
			out[i] = UNDETECT;
		} else if (v <= rawNodata) {
			out[i] = NODATA;
		} else {
			out[i] = Math.max(DBZ_MIN, Math.min(DBZ_MAX, Math.round(v)));
		}
	}
	return out;
}

/** Decode an inflated RATE tile to TENTHS of mm/h: exact at every legend
 *  edge (2, 11, 65, 115 are integers in tenths) and an exact badge. NaN is
 *  no echo and the raw nodata no coverage. ONE rounding rule: to the
 *  nearest tenth, and whatever rounds to 0 tenths is UNDETECT too, the
 *  exact 0.0 the composite carries (911 cells in a live frame) and a trace
 *  under 0.05 mm/h alike: nothing measurable fell, the paint has nothing
 *  to draw and the badge nothing to print (a "0.0 mm/h" reading would say
 *  rain where there is none). Clamped at 409.5 mm/h (the composite tops at
 *  137). */
export function decodeRateTile(inflated: Uint8Array, samplesPerPixel = 2, rawNodata = RAW_NODATA): Int16Array {
	const floats = floatsOf(inflated);
	const n = Math.floor(floats.length / samplesPerPixel);
	const out = new Int16Array(n);
	for (let i = 0; i < n; i++) {
		const v = floats[i * samplesPerPixel];
		if (v !== v) {
			out[i] = UNDETECT;
		} else if (v <= rawNodata) {
			out[i] = NODATA;
		} else {
			const tenths = Math.round(v * 10);
			out[i] = tenths <= 0 ? UNDETECT : Math.min(RATE_CELL_MAX, tenths);
		}
	}
	return out;
}

/** The product's decoder; `rawNodata` the file's own GDAL_NODATA when the
 *  head states one (both products state -9999000 today), so a producer
 *  moving it never turns no coverage into a value. */
export function decodeTile(inflated: Uint8Array, product: OperaProduct, rawNodata = RAW_NODATA): RadarCells {
	return product === 'RATE' ? decodeRateTile(inflated, 2, rawNodata) : decodeDbzTile(inflated, 2, rawNodata);
}

/** The cells of a tile past the grid's edge are PADDING the producer fills
 *  with 0.0 (finite, so a 0 dBZ value or a dry rate), which would beat the
 *  no-coverage sentinel under the pool: the last real column and row of
 *  both composites are all NODATA, and the pooled strip straddling the edge
 *  read "dry" for a pixel along the Urals and the Sahara at low zoom. Marks
 *  every cell beyond `validCols` / `validRows` NODATA, in place. */
export function maskPadding(tile: RadarCells, size: number, validCols: number, validRows: number): void {
	if (validCols >= size && validRows >= size) {
		return;
	}
	for (let y = 0; y < size; y++) {
		const from = y < validRows ? Math.max(0, validCols) : 0;
		if (from < size) {
			tile.fill(NODATA, y * size + from, (y + 1) * size);
		}
	}
}

/** Max-pool a square tile of `size` cells by `p` (p divides size). The
 *  sentinels order below every value, NODATA below UNDETECT, so a pooled
 *  cell reads no coverage only when every source cell does. Keeps the
 *  input's element type. */
export function maxPool<T extends RadarCells>(tile: T, size: number, p: number): T {
	if (p <= 1) {
		return tile;
	}
	const w = size / p;
	const out = (tile instanceof Int16Array ? new Int16Array(w * w) : new Int8Array(w * w)).fill(NODATA) as T;
	for (let y = 0; y < size; y++) {
		const row = (y / p) | 0;
		for (let x = 0; x < size; x++) {
			const v = tile[y * size + x];
			const j = row * w + ((x / p) | 0);
			if (v > out[j]) {
				out[j] = v;
			}
		}
	}
	return out;
}

/** The view a canvas was painted for, in Leaflet's projected pixels at the
 *  draw zoom: the pixel origin plus the canvas's layer-point position is
 *  the viewport's top-left (canvasZoom.ts). */
export interface IndexView {
	w: number;
	h: number;
	zoom: number;
	originX: number;
	originY: number;
	topLeftX: number;
	topLeftY: number;
}

/** Per canvas pixel, the tile it reads (255 = off the composite) and the
 *  offset into that tile's pooled grid. */
export interface IndexMap {
	w: number;
	h: number;
	p: number;
	tile: Uint8Array;
	off: Uint32Array;
}

export const OUTSIDE = 255;
const R = 6378137;

/** Inverse spherical Mercator of a Leaflet projected pixel at `scale`
 *  (256 * 2^zoom): Leaflet's EPSG3857 transformation undone. */
function pixelToLatLon(px: number, py: number, scale: number): { lat: number; lon: number } {
	const x = (px / scale - 0.5) * 2 * Math.PI * R;
	const y = -(py / scale - 0.5) * 2 * Math.PI * R;
	return {
		lon: (x / R) * (180 / Math.PI),
		lat: (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI),
	};
}

/** Build the index map of a view at pooling `p` on a grid: the projection
 *  is done on a lattice every `latticePx` pixels and interpolated between
 *  (the LAEA is smooth, the error is far under a cell), so a 1.4-million-
 *  pixel desktop view costs a few thousand projections. */
export function buildIndexMap(view: IndexView, p: number, grid: OperaGrid, latticePx = 8): IndexMap {
	const { w, h } = view;
	const scale = 256 * 2 ** view.zoom;
	const nx = Math.ceil(w / latticePx) + 1;
	const ny = Math.ceil(h / latticePx) + 1;
	const lcol = new Float64Array(nx * ny);
	const lrow = new Float64Array(nx * ny);
	const baseX = view.originX + view.topLeftX;
	const baseY = view.originY + view.topLeftY;
	for (let j = 0; j < ny; j++) {
		for (let i = 0; i < nx; i++) {
			// The lattice sits on pixel centres.
			const px = baseX + i * latticePx + 0.5;
			const py = baseY + j * latticePx + 0.5;
			const ll = pixelToLatLon(px, py, scale);
			const g = Math.abs(ll.lat) < 89.9 ? gridColRow(ll.lat, ll.lon, grid) : null;
			lcol[j * nx + i] = g ? g.col : NaN;
			lrow[j * nx + i] = g ? g.row : NaN;
		}
	}
	const tile = new Uint8Array(w * h).fill(OUTSIDE);
	const off = new Uint32Array(w * h);
	const T = grid.tile;
	const pooledW = T / p;
	for (let y = 0; y < h; y++) {
		const j = (y / latticePx) | 0;
		const fy = (y - j * latticePx) / latticePx;
		for (let x = 0; x < w; x++) {
			const i = (x / latticePx) | 0;
			const fx = (x - i * latticePx) / latticePx;
			const k = j * nx + i;
			const c00 = lcol[k];
			const c10 = lcol[k + 1];
			const c01 = lcol[k + nx];
			const c11 = lcol[k + nx + 1];
			const r00 = lrow[k];
			const r10 = lrow[k + 1];
			const r01 = lrow[k + nx];
			const r11 = lrow[k + nx + 1];
			const col = (c00 * (1 - fx) + c10 * fx) * (1 - fy) + (c01 * (1 - fx) + c11 * fx) * fy;
			const row = (r00 * (1 - fx) + r10 * fx) * (1 - fy) + (r01 * (1 - fx) + r11 * fx) * fy;
			if (!(col === col && row === row) || !gridContains(col, row, grid)) {
				continue;
			}
			const c = col | 0;
			const r = row | 0;
			const idx = y * w + x;
			tile[idx] = ((r / T) | 0) * grid.tileCols + ((c / T) | 0);
			off[idx] = (((r % T) / p) | 0) * pooledW + (((c % T) / p) | 0);
		}
	}
	return { w, h, p, tile, off };
}

/** The no-coverage hatch: a 45-degree stripe family anchored to PROJECTED
 *  space so it stays put while panning (decoGeometry.hatchPhase's idea).
 *  `phase` is the projected top-left's (x + y) modulo the pitch. */
export interface PaintHatch {
	rgba: number;
	phase: number;
}

export const HATCH_PITCH = 8;

export function hatchPhaseOf(topLeftProjX: number, topLeftProjY: number): number {
	const s = Math.round(topLeftProjX) + Math.round(topLeftProjY);
	return ((s % HATCH_PITCH) + HATCH_PITCH) % HATCH_PITCH;
}

/** Paint one frame through the index map into an RGBA pixel buffer (the
 *  ImageData's bytes seen as Uint32): each pixel is one lookup. Tiles not
 *  yet held paint nothing; no coverage paints the hatch (or nothing when it
 *  is off); Level 6 alternates its check on a two-pixel grid. The paint
 *  (LUT + texture threshold) is the product's; the scratch is sized for
 *  any tile id under OUTSIDE. */
export function paintFrame(
	out: Uint32Array,
	map: IndexMap,
	tileAt: (idx: number) => RadarCells | null,
	paint: RadarPaint,
	hatch: PaintHatch | null,
): void {
	const { w, h, tile, off } = map;
	const { lut, textureFrom, textureRgba } = paint;
	const tiles: (RadarCells | null | undefined)[] = new Array<RadarCells | null | undefined>(OUTSIDE);
	let i = 0;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++, i++) {
			const t = tile[i];
			if (t === OUTSIDE) {
				out[i] = 0;
				continue;
			}
			let arr = tiles[t];
			if (arr === undefined) {
				arr = tiles[t] = tileAt(t);
			}
			if (!arr) {
				out[i] = 0;
				continue;
			}
			const v = arr[off[i]];
			if (v === NODATA) {
				out[i] = hatch && ((x + y + hatch.phase) & (HATCH_PITCH - 1)) < 2 ? hatch.rgba : 0;
			} else if (v >= textureFrom && (((x >> 1) + (y >> 1)) & 1) === 1) {
				out[i] = textureRgba;
			} else {
				out[i] = lut[v + LUT_OFFSET];
			}
		}
	}
}
