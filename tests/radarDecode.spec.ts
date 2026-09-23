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
	hatchPhaseOf,
	maxPool,
	paintFrame,
	type IndexMap,
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

describe('buildIndexMap', () => {
	it('maps a pixel to the tile and cell under it, at every pooling', () => {
		const p = projectedPx(49.01, 2.55, 10);
		// The lattice sits on pixel centres: pixel (0, 0)'s centre must be the point.
		const view = { w: 2, h: 2, zoom: 10, originX: p.x - 0.5, originY: p.y - 0.5, topLeftX: 0, topLeftY: 0 };
		const g = gridColRow(49.01, 2.55, OPERA_GRID)!;
		const col = Math.floor(g.col);
		const row = Math.floor(g.row);
		expect([col, row]).toEqual([1405, 2737]);
		const m1 = buildIndexMap(view, 1, OPERA_GRID);
		expect(m1.tile[0]).toBe(42);
		expect(m1.off[0]).toBe((row - 2560) * 512 + (col - 1024));
		const m2 = buildIndexMap(view, 2, OPERA_GRID);
		expect(m2.tile[0]).toBe(42);
		expect(m2.off[0]).toBe(((row - 2560) >> 1) * 256 + ((col - 1024) >> 1));
		const m16 = buildIndexMap(view, 16, OPERA_GRID);
		expect(m16.off[0]).toBe(((row - 2560) >> 4) * 32 + ((col - 1024) >> 4));
	});

	it('maps the same pixel onto the 2 km grid: Paris CDG on tile 9', () => {
		const p = projectedPx(49.01, 2.55, 10);
		const view = { w: 2, h: 2, zoom: 10, originX: p.x - 0.5, originY: p.y - 0.5, topLeftX: 0, topLeftY: 0 };
		const g = gridColRow(49.01, 2.55, OPERA_GRID_2KM)!;
		const col = Math.floor(g.col);
		const row = Math.floor(g.row);
		expect([col, row]).toEqual([702, 1368]);
		const m1 = buildIndexMap(view, 1, OPERA_GRID_2KM);
		expect(m1.tile[0]).toBe(9);
		expect(m1.off[0]).toBe((row - 1024) * 512 + (col - 512));
		const m2 = buildIndexMap(view, 2, OPERA_GRID_2KM);
		expect(m2.tile[0]).toBe(9);
		expect(m2.off[0]).toBe(((row - 1024) >> 1) * 256 + ((col - 512) >> 1));
	});

	it('marks pixels off the composite', () => {
		const p = projectedPx(0, -100, 6);
		const view = { w: 4, h: 3, zoom: 6, originX: p.x, originY: p.y, topLeftX: 0, topLeftY: 0 };
		const m = buildIndexMap(view, 4, OPERA_GRID);
		expect([...m.tile]).toEqual(Array<number>(12).fill(OUTSIDE));
		expect([...buildIndexMap(view, 4, OPERA_GRID_2KM).tile]).toEqual(Array<number>(12).fill(OUTSIDE));
	});

	it('interpolates between lattice points to within a cell', () => {
		// A 17 x 17 view at zoom 9 over Brittany, lattice every 8 px: compare
		// the interpolated cell of every pixel with the exact projection.
		const p = projectedPx(48.45, -4.42, 9);
		const view = { w: 17, h: 17, zoom: 9, originX: p.x, originY: p.y, topLeftX: 0, topLeftY: 0 };
		const m = buildIndexMap(view, 1, OPERA_GRID);
		const scale = 256 * 2 ** 9;
		let off = 0;
		for (let y = 0; y < 17; y++) {
			for (let x = 0; x < 17; x++) {
				const px = p.x + x + 0.5;
				const py = p.y + y + 0.5;
				const lon = (px / scale - 0.5) * 360;
				const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / scale))) * 180) / Math.PI;
				const g = gridColRow(lat, lon, OPERA_GRID)!;
				const c = Math.floor(g.col);
				const r = Math.floor(g.row);
				const idx = y * 17 + x;
				const expectOff = (r % 512) * 512 + (c % 512);
				if (m.off[idx] !== expectOff) {
					off++;
				}
				expect(m.tile[idx]).toBe(Math.floor(r / 512) * 8 + Math.floor(c / 512));
			}
		}
		// A pixel whose exact cell lies on a cell edge may round the other
		// way; that is under one cell and rare.
		expect(off).toBeLessThan(6);
	});

	it('stays within one pooled cell at a continental zoom, on both grids', () => {
		// Zoom 2 at pooling 16: a 40 x 40 view over the composite's middle,
		// where the lattice spans 8 px of 25 km each; the pooled cell every
		// pixel reads must be the exact projection's or its neighbour.
		for (const grid of [OPERA_GRID, OPERA_GRID_2KM]) {
			const p = projectedPx(50, 10, 2);
			const view = { w: 40, h: 40, zoom: 2, originX: p.x - 20, originY: p.y - 20, topLeftX: 0, topLeftY: 0 };
			const m = buildIndexMap(view, 16, grid);
			const scale = 256 * 2 ** 2;
			const pooledW = grid.tile / 16;
			let inside = 0;
			for (let y = 0; y < 40; y++) {
				for (let x = 0; x < 40; x++) {
					const px = p.x - 20 + x + 0.5;
					const py = p.y - 20 + y + 0.5;
					const lon = (px / scale - 0.5) * 360;
					const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / scale))) * 180) / Math.PI;
					const g = gridColRow(lat, lon, grid)!;
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
});

describe('paintFrame', () => {
	const paint = buildPaint('DBZH');
	const lut = paint.lut;
	const map = (w: number, tile: number[], off: number[]): IndexMap => ({
		w,
		h: 1,
		p: 1,
		tile: Uint8Array.from(tile),
		off: Uint32Array.from(off),
	});

	it('paints the LUT colour, the hatch for no coverage and nothing off-grid or unloaded', () => {
		const m = map(4, [42, 42, OUTSIDE, 7], [0, 1, 0, 0]);
		const out = new Uint32Array(4);
		const tiles: Record<number, Int8Array> = { 42: new Int8Array([NODATA, 40]) };
		const hatch = { rgba: hexRgba('#78909c', 120), phase: 0 };
		paintFrame(out, m, (i) => tiles[i] ?? null, paint, hatch);
		expect(out[0]).toBe(hatch.rgba);
		expect(out[1]).toBe(lut[40 + LUT_OFFSET]);
		expect(out[2]).toBe(0);
		expect(out[3]).toBe(0);
		paintFrame(out, m, (i) => tiles[i] ?? null, paint, null);
		expect(out[0]).toBe(0);
	});

	it('textures Level 6 on a two-pixel check', () => {
		const m = map(4, [42, 42, 42, 42], [0, 1, 2, 3]);
		const out = new Uint32Array(4);
		paintFrame(out, m, () => new Int8Array([60, 60, 60, 60]), paint, null);
		expect([...out]).toEqual([lut[60 + LUT_OFFSET], lut[60 + LUT_OFFSET], paint.textureRgba, paint.textureRgba]);
		expect(paint.textureRgba).toBe(hexRgba('#4a148c'));
	});

	it('paints a tenths tile through the RATE paint, the texture from 115 mm/h', () => {
		const rate = buildPaint('RATE');
		const m = map(6, [9, 9, 9, 9, 9, 9], [0, 1, 2, 3, 4, 5]);
		const out = new Uint32Array(6);
		const hatch = { rgba: 5, phase: 0 };
		// The check is ON where (x >> 1) + (y >> 1) is odd: x = 2, 3 on row 0.
		paintFrame(out, m, () => new Int16Array([NODATA, UNDETECT, 1370, 1370, 24, 3]), rate, hatch);
		expect(out[0]).toBe(5);
		expect(out[1]).toBe(0);
		expect(out[2]).toBe(hexRgba('#4a148c'));
		expect(out[3]).toBe(hexRgba('#4a148c'));
		expect(out[4]).toBe(hexRgba('#ffee58'));
		expect(out[5]).toBe(0);
		// Off the check, the top step keeps its own ink.
		paintFrame(out, m, () => new Int16Array([1370, 1370, 24, 24, 1370, 1370]), rate, null);
		expect(out[0]).toBe(hexRgba('#8e24aa'));
		expect(out[1]).toBe(hexRgba('#8e24aa'));
		expect(out[4]).toBe(hexRgba('#8e24aa'));
		expect(out[5]).toBe(hexRgba('#8e24aa'));
	});

	it('starts the RATE texture and the top ink at exactly 115.0 mm/h, not a tenth below', () => {
		// The Level 6 edge of Meteo-France's Guide aviation legend, in tenths.
		// Samples a tenth either side of it, on the check and off it, against
		// the literal inks: moving the edge by a tenth either way fails here,
		// and so does the edge a third of the rate lower.
		const rate = buildPaint('RATE');
		expect(rate.textureFrom).toBe(1150);
		const m = map(4, [9, 9, 9, 9], [0, 1, 2, 3]);
		const out = new Uint32Array(4);
		// x = 0, 1 off the check, x = 2, 3 on it.
		paintFrame(out, m, () => new Int16Array([1149, 1150, 1149, 1150]), rate, null);
		expect(out[0], '114.9 mm/h off the check').toBe(hexRgba('#d81b60'));
		expect(out[1], '115.0 mm/h off the check').toBe(hexRgba('#8e24aa'));
		expect(out[2], '114.9 mm/h on the check').toBe(hexRgba('#d81b60'));
		expect(out[3], '115.0 mm/h on the check').toBe(hexRgba('#4a148c'));
	});

	it('anchors the hatch phase to projected space', () => {
		expect(hatchPhaseOf(3, 6)).toBe(1);
		expect(hatchPhaseOf(-1, 0)).toBe(7);
		expect(hatchPhaseOf(8, 8)).toBe(0);
		const m = map(8, Array<number>(8).fill(42), [0, 1, 2, 3, 4, 5, 6, 7]);
		const out = new Uint32Array(8);
		const hatch = { rgba: 7, phase: hatchPhaseOf(2, 4) };
		paintFrame(out, m, () => new Int8Array(8).fill(NODATA), paint, hatch);
		// (x + 6) & 7 < 2 for x = 2, 3.
		expect([...out]).toEqual([0, 0, 7, 7, 0, 0, 0, 0]);
	});
});
