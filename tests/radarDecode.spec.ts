import { describe, expect, it } from 'vitest';
import { OPERA_GRID, OPERA_GRID_2KM, gridColRow } from '$lib/weather/laea';
import {
	LUT_OFFSET,
	NODATA,
	OPERA_PRODUCT_INFO,
	UNDETECT,
	buildPaint,
	decodedTileBytes,
	hexRgba,
} from '$lib/weather/opera';
import {
	OUTSIDE,
	maskPadding,
	buildIndexMap,
	decodeDbzTile,
	decodeRateTile,
	decodeTile,
	maxPool,
	paintFrame,
	type IndexMap,
	type Raster,
} from '$lib/weather/radarDecode';

describe('the decoded tier\'s sizes', () => {
	it('are what the decoder allocates, per product and per pooling', () => {
		// The loop cap sizes tier B off the registry (decodedTileBytes); the
		// decoder is what fills it. A decoder moved to another cell type with
		// the registry left behind would cap the loop on the wrong figure.
		for (const product of ['DBZH', 'RATE'] as const) {
			const cells = decodeTile(new Uint8Array(512 * 512 * 2 * 4), product);
			expect(cells.BYTES_PER_ELEMENT, product).toBe(OPERA_PRODUCT_INFO[product].cellBytes);
			expect(cells.byteLength, product).toBe(decodedTileBytes(product, 1));
			for (const p of [2, 4, 8, 16]) {
				expect(maxPool(cells, 512, p).byteLength, `${product} p ${p}`).toBe(decodedTileBytes(product, p));
			}
		}
	});
});

describe('decodeDbzTile', () => {
	it('keeps the first sample as a rounded, clamped reflectivity with the two sentinels', () => {
		const f = new Float32Array([NaN, 1, -9999000, 1, 34.6, 1, 65.5, 1, -32, 1, 150, 1, -200, 1]);
		expect([...decodeDbzTile(new Uint8Array(f.buffer))]).toEqual([UNDETECT, NODATA, 35, 66, -32, 100, -100]);
	});

	it('copies a misaligned buffer rather than viewing it', () => {
		const f = new Float32Array([7.2, 1]);
		const padded = new Uint8Array(9);
		padded.set(new Uint8Array(f.buffer), 1);
		expect([...decodeDbzTile(padded.subarray(1))]).toEqual([7]);
	});
});

describe('decodeRateTile', () => {
	it('keeps tenths of mm/h, nothing measurable being no echo, clamped at 409.5', () => {
		const f = new Float32Array([NaN, 1, 0, 1, -9999000, 1, 0.04, 1, 0.06, 1, 2.44, 1, 137, 1, 600, 1, 0.4, 1]);
		const cells = decodeRateTile(new Uint8Array(f.buffer));
		expect(cells).toBeInstanceOf(Int16Array);
		expect([...cells]).toEqual([UNDETECT, UNDETECT, NODATA, UNDETECT, 1, 24, 1370, 4095, 4]);
	});

	it('is what decodeTile picks for RATE, decodeDbzTile for DBZH', () => {
		const f = new Float32Array([2.44, 1]);
		expect(decodeTile(new Uint8Array(f.buffer), 'RATE')).toBeInstanceOf(Int16Array);
		expect([...decodeTile(new Uint8Array(f.buffer), 'RATE')]).toEqual([24]);
		expect(decodeTile(new Uint8Array(f.buffer), 'DBZH')).toBeInstanceOf(Int8Array);
		expect([...decodeTile(new Uint8Array(f.buffer), 'DBZH')]).toEqual([2]);
	});
});

describe('maxPool', () => {
	it('keeps the maximum and orders the sentinels under every value', () => {
		const tile = new Int8Array([
			NODATA, UNDETECT, 12, 40,
			UNDETECT, 12, NODATA, NODATA,
			NODATA, NODATA, UNDETECT, NODATA,
			NODATA, NODATA, NODATA, NODATA,
		]);
		const pooled = maxPool(tile, 4, 2);
		expect([...pooled]).toEqual([12, 40, NODATA, UNDETECT]);
		expect(maxPool(tile, 4, 1)).toBe(tile);
		expect([...maxPool(tile, 4, 4)]).toEqual([40]);
	});

	it('keeps an Int16 tile Int16, the tenths above the sentinels', () => {
		const tile = new Int16Array([
			NODATA, UNDETECT, 4, 1370,
			UNDETECT, 4, NODATA, NODATA,
			NODATA, NODATA, UNDETECT, NODATA,
			NODATA, NODATA, NODATA, 4095,
		]);
		const pooled = maxPool(tile, 4, 2);
		expect(pooled).toBeInstanceOf(Int16Array);
		expect([...pooled]).toEqual([4, 1370, NODATA, 4095]);
		expect(maxPool(tile, 4, 1)).toBe(tile);
	});
});

/** Leaflet's projected pixel of a point at a zoom (EPSG3857, 256 px tiles). */
function projectedPx(lat: number, lon: number, zoom: number): { x: number; y: number } {
	const scale = 256 * 2 ** zoom;
	const s = Math.sin((lat * Math.PI) / 180);
	return {
		x: (lon / 360 + 0.5) * scale,
		y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
	};
}

describe('maskPadding', () => {
	it('marks the cells past the grid edge no coverage, so the pool never reads the padding as dry', () => {
		// A 4 x 4 tile of 0 dBZ (the producer's finite padding) whose grid
		// ends after 3 columns and 2 rows.
		const tile = new Int8Array(16);
		maskPadding(tile, 4, 3, 2);
		expect([...tile]).toEqual([0, 0, 0, NODATA, 0, 0, 0, NODATA, NODATA, NODATA, NODATA, NODATA, NODATA, NODATA, NODATA, NODATA]);
		const pooled = maxPool(tile, 4, 2);
		// The straddling cell keeps its real column; a cell wholly past the
		// edge reads no coverage.
		expect([...pooled]).toEqual([0, 0, NODATA, NODATA]);
		const whole = new Int16Array(16).fill(7);
		maskPadding(whole, 4, 4, 4);
		expect([...whole]).toEqual(Array<number>(16).fill(7));
	});
});

/** The point at the centre of projected pixel (x, y) at a zoom. */
function centreOf(x: number, y: number, zoom: number): { lat: number; lon: number } {
	const scale = 256 * 2 ** zoom;
	const px = x + 0.5;
	const py = y + 0.5;
	return { lon: (px / scale - 0.5) * 360, lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / scale))) * 180) / Math.PI };
}

/** The lattice node at or west and north of a point's pixel: a pixel whose
 *  cell is its own projection, uninterpolated. */
function nodeAt(lat: number, lon: number, zoom: number): { x: number; y: number } {
	const p = projectedPx(lat, lon, zoom);
	return { x: Math.floor(p.x / 8) * 8, y: Math.floor(p.y / 8) * 8 };
}

describe('buildIndexMap', () => {
	it('maps a lattice pixel to the tile and cell under its centre, at every pooling', () => {
		const n = nodeAt(49.01, 2.55, 10);
		const c = centreOf(n.x, n.y, 10);
		const g = gridColRow(c.lat, c.lon, OPERA_GRID)!;
		const col = Math.floor(g.col);
		const row = Math.floor(g.row);
		// Paris CDG's neighbourhood: tile 42 of the 1 km grid.
		expect(Math.floor(row / 512) * 8 + Math.floor(col / 512)).toBe(42);
		const rect = { x: n.x, y: n.y, w: 2, h: 2, zoom: 10 };
		const m1 = buildIndexMap(rect, 1, OPERA_GRID);
		expect(m1.tile[0]).toBe(42);
		expect(m1.off[0]).toBe((row - 2560) * 512 + (col - 1024));
		const m2 = buildIndexMap(rect, 2, OPERA_GRID);
		expect(m2.tile[0]).toBe(42);
		expect(m2.off[0]).toBe(((row - 2560) >> 1) * 256 + ((col - 1024) >> 1));
		const m16 = buildIndexMap(rect, 16, OPERA_GRID);
		expect(m16.off[0]).toBe(((row - 2560) >> 4) * 32 + ((col - 1024) >> 4));
		expect([m1.x, m1.y, m1.w, m1.h, m1.p]).toEqual([n.x, n.y, 2, 2, 1]);
	});

	it('maps the same pixel onto the 2 km grid: Paris CDG on tile 9', () => {
		const n = nodeAt(49.01, 2.55, 10);
		const c = centreOf(n.x, n.y, 10);
		const g = gridColRow(c.lat, c.lon, OPERA_GRID_2KM)!;
		const col = Math.floor(g.col);
		const row = Math.floor(g.row);
		const rect = { x: n.x, y: n.y, w: 2, h: 2, zoom: 10 };
		const m1 = buildIndexMap(rect, 1, OPERA_GRID_2KM);
		expect(m1.tile[0]).toBe(9);
		expect(m1.off[0]).toBe((row - 1024) * 512 + (col - 512));
		const m2 = buildIndexMap(rect, 2, OPERA_GRID_2KM);
		expect(m2.tile[0]).toBe(9);
		expect(m2.off[0]).toBe(((row - 1024) >> 1) * 256 + ((col - 512) >> 1));
	});

	it('marks pixels off the composite', () => {
		const p = projectedPx(0, -100, 6);
		const rect = { x: Math.floor(p.x), y: Math.floor(p.y), w: 4, h: 3, zoom: 6 };
		expect([...buildIndexMap(rect, 4, OPERA_GRID).tile]).toEqual(Array<number>(12).fill(OUTSIDE));
		expect([...buildIndexMap(rect, 4, OPERA_GRID_2KM).tile]).toEqual(Array<number>(12).fill(OUTSIDE));
	});

	it('interpolates between lattice points to within a cell', () => {
		// A 17 x 17 rectangle at zoom 9 over Brittany, lattice every 8 px:
		// compare the interpolated cell of every pixel with the exact
		// projection of its centre.
		const p = projectedPx(48.45, -4.42, 9);
		const x0 = Math.floor(p.x) + 3;
		const y0 = Math.floor(p.y) + 5;
		const m = buildIndexMap({ x: x0, y: y0, w: 17, h: 17, zoom: 9 }, 1, OPERA_GRID);
		let off = 0;
		for (let y = 0; y < 17; y++) {
			for (let x = 0; x < 17; x++) {
				const c = centreOf(x0 + x, y0 + y, 9);
				const g = gridColRow(c.lat, c.lon, OPERA_GRID)!;
				const col = Math.floor(g.col);
				const row = Math.floor(g.row);
				const idx = y * 17 + x;
				if (m.off[idx] !== (row % 512) * 512 + (col % 512)) {
					off++;
				}
				expect(m.tile[idx]).toBe(Math.floor(row / 512) * 8 + Math.floor(col / 512));
			}
		}
		// A pixel whose exact cell lies on a cell edge may round the other
		// way; that is under one cell and rare.
		expect(off).toBeLessThan(6);
	});

	it('stays within one pooled cell at a continental zoom, on both grids', () => {
		// Zoom 2 at pooling 16: a 40 x 40 rectangle over the composite's
		// middle, where the lattice spans 8 px of 25 km each; the pooled cell
		// every pixel reads must be the exact projection's or its neighbour.
		for (const grid of [OPERA_GRID, OPERA_GRID_2KM]) {
			const p = projectedPx(50, 10, 2);
			const x0 = Math.floor(p.x) - 20;
			const y0 = Math.floor(p.y) - 20;
			const m = buildIndexMap({ x: x0, y: y0, w: 40, h: 40, zoom: 2 }, 16, grid);
			const pooledW = grid.tile / 16;
			let inside = 0;
			for (let y = 0; y < 40; y++) {
				for (let x = 0; x < 40; x++) {
					const c = centreOf(x0 + x, y0 + y, 2);
					const g = gridColRow(c.lat, c.lon, grid)!;
					const idx = y * 40 + x;
					if (m.tile[idx] === OUTSIDE) {
						continue;
					}
					inside++;
					const gc = (m.tile[idx] % grid.tileCols) * pooledW + (m.off[idx] % pooledW);
					const gr = Math.floor(m.tile[idx] / grid.tileCols) * pooledW + Math.floor(m.off[idx] / pooledW);
					expect(Math.abs(gc - Math.floor(g.col / 16))).toBeLessThanOrEqual(1);
					expect(Math.abs(gr - Math.floor(g.row / 16))).toBeLessThanOrEqual(1);
				}
			}
			expect(inside).toBeGreaterThan(100);
		}
	});

	it('gives a pixel the same cell whatever rectangle holds it, a single pixel included', () => {
		// A 61 x 37 rectangle at zoom 8 over the Alps, its corner off the
		// lattice, and pieces cut from it: a band, an inner block, single
		// pixels; on both grids, at two poolings.
		const p = projectedPx(46.5, 8.5, 8);
		const big = { x: Math.floor(p.x) - 29, y: Math.floor(p.y) - 13, w: 61, h: 37, zoom: 8 };
		for (const grid of [OPERA_GRID, OPERA_GRID_2KM]) {
			for (const pool of [1, 4]) {
				const whole = buildIndexMap(big, pool, grid);
				const pieces = [
					{ x: big.x + 45, y: big.y, w: 16, h: 37 },
					{ x: big.x + 3, y: big.y + 9, w: 21, h: 11 },
					{ x: big.x + 7, y: big.y + 30, w: 1, h: 1 },
					{ x: big.x + 60, y: big.y + 36, w: 1, h: 1 },
				];
				for (const r of pieces) {
					const part = buildIndexMap({ ...r, zoom: 8 }, pool, grid);
					for (let y = 0; y < r.h; y++) {
						for (let x = 0; x < r.w; x++) {
							const k = (r.y - big.y + y) * big.w + (r.x - big.x + x);
							expect(part.tile[y * r.w + x]).toBe(whole.tile[k]);
							expect(part.off[y * r.w + x]).toBe(whole.off[k]);
						}
					}
				}
			}
		}
	});
});

describe('paintFrame', () => {
	const paint = buildPaint('DBZH');
	const lut = paint.lut;
	const map = (w: number, tile: number[], off: number[], x = 0, y = 0): IndexMap => ({
		x,
		y,
		w,
		h: 1,
		p: 1,
		tile: Uint8Array.from(tile),
		off: Uint32Array.from(off),
	});
	const raster = (m: IndexMap): Raster => ({ data: new Uint32Array(m.w * m.h), x: m.x, y: m.y, w: m.w, h: m.h });

	it('paints the LUT colour, the hatch for no coverage and nothing off-grid or unloaded', () => {
		const m = map(4, [42, 42, OUTSIDE, 7], [0, 1, 0, 0]);
		const out = raster(m);
		const tiles: Record<number, Int8Array> = { 42: new Int8Array([NODATA, 40]) };
		const hatch = hexRgba('#78909c', 120);
		paintFrame(out, m, m, (i) => tiles[i] ?? null, paint, hatch);
		expect(out.data[0]).toBe(hatch);
		expect(out.data[1]).toBe(lut[40 + LUT_OFFSET]);
		expect(out.data[2]).toBe(0);
		expect(out.data[3]).toBe(0);
		paintFrame(out, m, m, (i) => tiles[i] ?? null, paint, null);
		expect(out.data[0]).toBe(0);
	});

	it('textures Level 6 on a two-pixel check', () => {
		const m = map(4, [42, 42, 42, 42], [0, 1, 2, 3]);
		const out = raster(m);
		paintFrame(out, m, m, () => new Int8Array([60, 60, 60, 60]), paint, null);
		expect([...out.data]).toEqual([lut[60 + LUT_OFFSET], lut[60 + LUT_OFFSET], paint.textureRgba, paint.textureRgba]);
		expect(paint.textureRgba).toBe(hexRgba('#4a148c'));
	});

	it('paints a tenths tile through the RATE paint, the texture from 115 mm/h', () => {
		const rate = buildPaint('RATE');
		const m = map(6, [9, 9, 9, 9, 9, 9], [0, 1, 2, 3, 4, 5]);
		const out = raster(m);
		// The check is ON where (x >> 1) + (y >> 1) is odd: x = 2, 3 on row 0.
		paintFrame(out, m, m, () => new Int16Array([NODATA, UNDETECT, 1370, 1370, 24, 3]), rate, 5);
		expect(out.data[0]).toBe(5);
		expect(out.data[1]).toBe(0);
		expect(out.data[2]).toBe(hexRgba('#4a148c'));
		expect(out.data[3]).toBe(hexRgba('#4a148c'));
		expect(out.data[4]).toBe(hexRgba('#ffee58'));
		expect(out.data[5]).toBe(0);
		// Off the check, the top step keeps its own ink.
		paintFrame(out, m, m, () => new Int16Array([1370, 1370, 24, 24, 1370, 1370]), rate, null);
		expect(out.data[0]).toBe(hexRgba('#8e24aa'));
		expect(out.data[1]).toBe(hexRgba('#8e24aa'));
		expect(out.data[4]).toBe(hexRgba('#8e24aa'));
		expect(out.data[5]).toBe(hexRgba('#8e24aa'));
	});

	it('starts the RATE texture and the top ink at exactly 115.0 mm/h, not a tenth below', () => {
		// The Level 6 edge of Meteo-France's Guide aviation legend, in tenths.
		// Samples a tenth either side of it, on the check and off it, against
		// the literal inks: moving the edge by a tenth either way fails here,
		// and so does the edge a third of the rate lower.
		const rate = buildPaint('RATE');
		expect(rate.textureFrom).toBe(1150);
		const m = map(4, [9, 9, 9, 9], [0, 1, 2, 3]);
		const out = raster(m);
		// x = 0, 1 off the check, x = 2, 3 on it.
		paintFrame(out, m, m, () => new Int16Array([1149, 1150, 1149, 1150]), rate, null);
		expect(out.data[0], '114.9 mm/h off the check').toBe(hexRgba('#d81b60'));
		expect(out.data[1], '115.0 mm/h off the check').toBe(hexRgba('#8e24aa'));
		expect(out.data[2], '114.9 mm/h on the check').toBe(hexRgba('#d81b60'));
		expect(out.data[3], '115.0 mm/h on the check').toBe(hexRgba('#4a148c'));
	});

	it('anchors the hatch and the check to projected space', () => {
		// Eight pixels from projected (2, 4): the hatch where (x + y) & 7 < 2,
		// x = 4 and 5.
		const m = map(8, Array<number>(8).fill(42), [0, 1, 2, 3, 4, 5, 6, 7], 2, 4);
		const out = raster(m);
		paintFrame(out, m, m, () => new Int8Array(8).fill(NODATA), paint, 7);
		expect([...out.data]).toEqual([0, 0, 7, 7, 0, 0, 0, 0]);
		// The check where (x >> 1) + (y >> 1) is odd, y = 4: x = 2, 3, 6, 7,
		// the first, second, fifth and sixth pixels.
		paintFrame(out, m, m, () => new Int8Array(8).fill(60), paint, null);
		const on = paint.textureRgba;
		const off = lut[60 + LUT_OFFSET];
		expect([...out.data]).toEqual([on, on, off, off, on, on, off, off]);
	});

	it('paints a region as the same pixels of a whole paint, into a raster of its own', () => {
		// A 24 x 6 map from projected (101, 203) holding echoes, Level 6, no
		// coverage and holes; a whole paint against two regions painted into
		// a raster placed elsewhere.
		const w = 24;
		const h = 6;
		const tile: number[] = [];
		const off: number[] = [];
		for (let i = 0; i < w * h; i++) {
			tile.push(i % 11 === 5 ? OUTSIDE : 42);
			off.push(i % 4);
		}
		const m: IndexMap = { x: 101, y: 203, w, h, p: 1, tile: Uint8Array.from(tile), off: Uint32Array.from(off) };
		const cells = (): Int8Array => new Int8Array([NODATA, 60, 30, UNDETECT]);
		const whole = raster(m);
		paintFrame(whole, m, m, cells, paint, 9);
		const other: Raster = { data: new Uint32Array(30 * 8), x: 99, y: 202, w: 30, h: 8 };
		paintFrame(other, m, { x: 101, y: 203, w: 9, h: 6 }, cells, paint, 9);
		paintFrame(other, m, { x: 110, y: 203, w: 15, h: 6 }, cells, paint, 9);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				expect(other.data[(203 + y - 202) * 30 + (101 + x - 99)]).toBe(whole.data[y * w + x]);
			}
		}
	});
});
