/* radarDecode.ts: from a composite tile's bytes to what the canvas paints.
 * Three pure steps (docs/precipitation-radar.md "Client shape"): the
 * inflated tile's Float32 pairs become one integer a cell, an Int8
 * reflectivity or an Int16 tenth of a millimetre per hour, with the two
 * ODIM states as sentinels; a tile is MAX-pooled to the map's resolution
 * (the maximum, never a mean: ICAO Doc 8896 App. 9 3.2.2 and EASA AMC9
 * SPA.EFB.100(b)(3) both require a reformatting to preserve the most
 * intense cell, and the product itself is a maximum composite); and an
 * index map says which pooled cell each pixel of a rectangle of the map
 * reads, so an animation frame is one lookup a pixel. The index map and the
 * paint are anchored to Leaflet's PROJECTED pixels, not to a canvas: a
 * pixel reads the same cell and takes the same ink whatever rectangle it is
 * built or painted in, so a painting can be made in pieces, and the
 * piece a pan brings in matches the one beside it. Pure: no Leaflet, no
 * state, no catalog. */

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

/** A rectangle of whole pixels in Leaflet's projected space at a zoom: the
 *  pixel origin plus a layer point is a projected pixel (canvasZoom.ts), and
 *  pixel (x, y) is the one whose top-left corner that is. */
export interface PixelRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** A rectangle at a zoom: what an index map is built for. */
export interface IndexRect extends PixelRect {
	zoom: number;
}

/** Per pixel of a rectangle, row by row from its corner, the tile it reads
 *  (OUTSIDE = off the composite) and the offset into that tile's pooled
 *  grid. */
export interface IndexMap extends PixelRect {
	p: number;
	tile: Uint8Array;
	off: Uint32Array;
}

/** RGBA pixels (an ImageData's bytes seen as Uint32) of a rectangle of
 *  projected space, row by row from its corner: what a frame is painted
 *  into. */
export interface Raster extends PixelRect {
	data: Uint32Array;
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

/** The projection is made on a lattice every this many projected pixels
 *  (on pixel centres, anchored to projected space) and interpolated between:
 *  the LAEA is smooth, the error is far under a cell, so a 1.4-million-pixel
 *  desktop view costs a few thousand projections. A power of two. */
export const LATTICE_PX = 8;

/** Build the index map of a rectangle at pooling `p` (a power of two) on a
 *  grid. The lattice is anchored to projected space, never to the
 *  rectangle: a pixel's cell depends on its own coordinates alone, so a
 *  rectangle's map is, pixel for pixel, the same as the part of any larger
 *  one it is cut from (a pan's band, a hover's single pixel). */
export function buildIndexMap(rect: IndexRect, p: number, grid: OperaGrid): IndexMap {
	const { x, y, w, h } = rect;
	const scale = 256 * 2 ** rect.zoom;
	const L = LATTICE_PX;
	const lShift = Math.log2(L);
	const ix0 = Math.floor(x / L);
	const iy0 = Math.floor(y / L);
	const nx = Math.floor((x + w - 1) / L) - ix0 + 2;
	const ny = Math.floor((y + h - 1) / L) - iy0 + 2;
	const lcol = new Float64Array(nx * ny);
	const lrow = new Float64Array(nx * ny);
	for (let j = 0; j < ny; j++) {
		for (let i = 0; i < nx; i++) {
			// The lattice sits on pixel centres.
			const ll = pixelToLatLon((ix0 + i) * L + 0.5, (iy0 + j) * L + 0.5, scale);
			const g = Math.abs(ll.lat) < 89.9 ? gridColRow(ll.lat, ll.lon, grid) : null;
			lcol[j * nx + i] = g ? g.col : NaN;
			lrow[j * nx + i] = g ? g.row : NaN;
		}
	}
	const tile = new Uint8Array(w * h).fill(OUTSIDE);
	const off = new Uint32Array(w * h);
	const T = grid.tile;
	const tShift = Math.log2(T);
	const pShift = Math.log2(p);
	const rowShift = tShift - pShift;
	const cols = grid.tileCols;
	// A row's two lattice rows, interpolated once at its fraction.
	const rc = new Float64Array(nx);
	const rr = new Float64Array(nx);
	let k = 0;
	for (let yy = 0; yy < h; yy++) {
		const gy = y + yy - iy0 * L;
		const j = gy >> lShift;
		const fy = (gy & (L - 1)) / L;
		const a = j * nx;
		for (let i = 0; i < nx; i++) {
			rc[i] = lcol[a + i] * (1 - fy) + lcol[a + nx + i] * fy;
			rr[i] = lrow[a + i] * (1 - fy) + lrow[a + nx + i] * fy;
		}
		for (let xx = 0; xx < w; xx++, k++) {
			const gx = x + xx - ix0 * L;
			const i = gx >> lShift;
			const fx = (gx & (L - 1)) / L;
			const col = rc[i] * (1 - fx) + rc[i + 1] * fx;
			const row = rr[i] * (1 - fx) + rr[i + 1] * fx;
			if (!(col === col && row === row) || !gridContains(col, row, grid)) {
				continue;
			}
			const c = col | 0;
			const r = row | 0;
			tile[k] = (r >> tShift) * cols + (c >> tShift);
			off[k] = (((r & (T - 1)) >> pShift) << rowShift) + ((c & (T - 1)) >> pShift);
		}
	}
	return { x, y, w, h, p, tile, off };
}

/** The no-coverage hatch's pitch: a 45-degree stripe family on the
 *  projected pixels where (x + y) modulo it is under 2, anchored to the map
 *  so it stays put under a pan (decoGeometry.hatchPhase's idea). */
export const HATCH_PITCH = 8;

/** Paint rectangle `r` of a frame through an index map into a raster, both
 *  holding it: each pixel is one lookup. Tiles not yet held paint nothing;
 *  no coverage paints the hatch in `hatchRgba` (nothing when null); Level 6
 *  alternates its check on the two-pixel grid of projected space. The paint
 *  (LUT + texture threshold) is the product's; the scratch is sized for any
 *  tile id under OUTSIDE. */
export function paintFrame(
	out: Raster,
	map: IndexMap,
	r: PixelRect,
	tileAt: (idx: number) => RadarCells | null,
	paint: RadarPaint,
	hatchRgba: number | null,
): void {
	const { tile, off } = map;
	const { lut, textureFrom, textureRgba } = paint;
	const data = out.data;
	const tiles: (RadarCells | null | undefined)[] = new Array<RadarCells | null | undefined>(OUTSIDE);
	for (let yy = r.y; yy < r.y + r.h; yy++) {
		let o = (yy - out.y) * out.w + (r.x - out.x);
		let k = (yy - map.y) * map.w + (r.x - map.x);
		for (let xx = r.x; xx < r.x + r.w; xx++, o++, k++) {
			const t = tile[k];
			if (t === OUTSIDE) {
				data[o] = 0;
				continue;
			}
			let arr = tiles[t];
			if (arr === undefined) {
				arr = tiles[t] = tileAt(t);
			}
			if (!arr) {
				data[o] = 0;
				continue;
			}
			const v = arr[off[k]];
			if (v === NODATA) {
				data[o] = hatchRgba !== null && ((xx + yy) & (HATCH_PITCH - 1)) < 2 ? hatchRgba : 0;
			} else if (v >= textureFrom && (((xx >> 1) + (yy >> 1)) & 1) === 1) {
				data[o] = textureRgba;
			} else {
				data[o] = lut[v + LUT_OFFSET];
			}
		}
	}
}
