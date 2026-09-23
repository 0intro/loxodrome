/* The arithmetic behind the relative-terrain layer (map/terrainShade.ts):
 * which terrain level a zoom draws, which tiles a view needs and in what
 * order, the budget that steps a big screen coarser, the per-tile paint, the
 * stand-in square of an ancestor, and the packing the ImageData bytes take.
 * Leaflet-free on purpose, so all of it is pinned here rather than only
 * eyeballed on a screen. */

import { describe, expect, it } from 'vitest';
import { NO_DATA } from '$lib/map/terrain';
import {
	MAX_WARM_TILES,
	TERRAIN_DITHER_MASK,
	ancestorRect,
	bandColours,
	ditherCell,
	inkRgba,
	levelForZoom,
	packRgba,
	paintTile,
	shadeLevel,
	terrainSwatchCss,
	terrainSwatches,
	tileSidePx,
	viewportTiles,
	warmCap,
	warmTiles,
	type ShadeView,
} from '$lib/map/terrainShade';

const LEVELS = { deepest: 12, coarsest: 6 };

describe('the level a zoom draws', () => {
	it('is the floor of the zoom, capped at the deepest, none below the coarsest', () => {
		expect(levelForZoom(5, LEVELS)).toBeNull();
		expect(levelForZoom(5.99, LEVELS)).toBeNull();
		expect(levelForZoom(6, LEVELS)).toBe(6);
		expect(levelForZoom(9.7, LEVELS)).toBe(9);
		expect(levelForZoom(12, LEVELS)).toBe(12);
		expect(levelForZoom(15, LEVELS)).toBe(12);
	});

	it('draws a deep level larger past it', () => {
		expect(tileSidePx(12, 12)).toBe(256);
		expect(tileSidePx(14, 12)).toBe(1024);
		expect(tileSidePx(10.5, 10)).toBeCloseTo(362.04, 1);
	});
});

/** A view whose top-left sits at tile (tx, ty) of `zoom`, offset by (ox, oy)
 *  CSS pixels. */
function viewAt(zoom: number, tx: number, ty: number, w: number, h: number, ox = 0, oy = 0): ShadeView {
	return { bx: tx * 256 + ox, by: ty * 256 + oy, w, h, zoom };
}

describe('the tiles a view needs', () => {
	it('covers the viewport, grown by the ring', () => {
		const v = viewAt(10, 520, 350, 1500, 950, 40, 90);
		const tiles = viewportTiles(v, 10, 0);
		const xs = [...new Set(tiles.map((t) => t.x))].sort((a, b) => a - b);
		const ys = [...new Set(tiles.map((t) => t.y))].sort((a, b) => a - b);
		// 40 + 1500 = 1540 px wide from the tile's own origin: 7 columns.
		expect(xs).toEqual([520, 521, 522, 523, 524, 525, 526]);
		// 90 + 950 = 1040 px tall: 5 rows.
		expect(ys).toEqual([350, 351, 352, 353, 354]);
		expect(viewportTiles(v, 10, 1)).toHaveLength(9 * 7);
	});

	it('comes nearest the centre first', () => {
		const v = viewAt(10, 520, 350, 1024, 1024);
		const [first] = viewportTiles(v, 10, 1);
		// The view's centre is on the corner of four tiles; one of those four.
		expect([521, 522]).toContain(first.x);
		expect([351, 352]).toContain(first.y);
		const d = (t: { x: number; y: number }): number => Math.hypot(t.x + 0.5 - 522, t.y + 0.5 - 352);
		const order = viewportTiles(v, 10, 1).map(d);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it('keeps unwrapped columns across the antimeridian and clamps the rows', () => {
		// Level 6 is 64 tiles round; a view straddling x = 0 from the west.
		const v: ShadeView = { bx: -300, by: -500, w: 700, h: 900, zoom: 6 };
		const tiles = viewportTiles(v, 6, 0);
		const xs = [...new Set(tiles.map((t) => t.x))].sort((a, b) => a - b);
		expect(xs).toEqual([-2, -1, 0, 1]);
		expect(Math.min(...tiles.map((t) => t.y))).toBe(0);
	});

	it('steps a big screen coarser until the warm fits the budget', () => {
		const laptop = viewAt(12, 2100, 1450, 1500, 950);
		expect(shadeLevel(laptop, LEVELS)).toBe(12);
		const fourK = viewAt(12, 2100, 1450, 3840, 2160);
		const level = shadeLevel(fourK, LEVELS)!;
		expect(level).toBeLessThan(12);
		expect(viewportTiles(fourK, level, 1).length).toBeLessThanOrEqual(MAX_WARM_TILES);
		expect(viewportTiles(fourK, level + 1, 1).length).toBeGreaterThan(MAX_WARM_TILES);
		expect(shadeLevel(viewAt(5, 10, 10, 800, 600), LEVELS)).toBeNull();
	});

	it('shades nothing where even the coarsest level outnumbers the cap', () => {
		// A 4K screen at zoom 6 wants about 150 tiles in view alone, and asked
		// for 198 with the ring: a warm the cache cannot hold evicts its own
		// first tiles for its last and asks for them again forever.
		const fourK = viewAt(6, 32, 22, 3840, 2160, 100, 50);
		expect(viewportTiles(fourK, 6, 0).length).toBeGreaterThan(MAX_WARM_TILES);
		expect(shadeLevel(fourK, LEVELS)).toBeNull();
		// A 1080p screen at zoom 6 still shades: its view fits, the ring is cut.
		const hd = viewAt(6, 32, 22, 1920, 1080, 100, 50);
		expect(shadeLevel(hd, LEVELS)).toBe(6);
		expect(viewportTiles(hd, 6, 1).length).toBeGreaterThan(MAX_WARM_TILES);
	});

	it('caps the warm at half the tile budget, the view before its ring', () => {
		expect(warmCap(192)).toBe(MAX_WARM_TILES);
		expect(warmCap(96)).toBe(48);
		expect(warmCap(8)).toBe(4);
		const hd = viewAt(6, 32, 22, 1920, 1080, 100, 50);
		const inView = viewportTiles(hd, 6, 0);
		const warm = warmTiles(hd, 6, 1, MAX_WARM_TILES);
		expect(warm).toHaveLength(MAX_WARM_TILES);
		// Every tile in view is asked for, ahead of any ring tile.
		expect(warm.slice(0, inView.length)).toEqual(inView);
		// Uncapped, the ring follows whole.
		expect(warmTiles(hd, 6, 1, 1000)).toHaveLength(viewportTiles(hd, 6, 1).length);
	});
});

describe('the per-tile paint', () => {
	it('colours by the maximum, first band reached wins, the sea left clear', () => {
		const colours = bandColours();
		const max = Int16Array.from([NO_DATA, -5, 0, 99, 100, 199, 200, 999, 1000, 4000]);
		const out = new Uint32Array(max.length).fill(123);
		// Red from 200 m, yellow from 100 m.
		const painted = paintTile(out, max, Int32Array.from([200, 100]), colours);
		expect(Array.from(out)).toEqual([0, 0, 0, 0, colours[1], colours[1], colours[0], colours[0], colours[0], colours[0]]);
		expect(painted).toBe(6);
	});

	it('takes a longer band list the same way', () => {
		const colours = Uint32Array.from([1, 2, 3]);
		const max = Int16Array.from([50, 150, 250, 350, NO_DATA]);
		const out = new Uint32Array(max.length);
		expect(paintTile(out, max, Int32Array.from([300, 200, 100]), colours)).toBe(3);
		expect(Array.from(out)).toEqual([0, 3, 2, 1, 0]);
	});
});

describe('an ancestor standing in', () => {
	it('names the square of its bitmap that covers the tile', () => {
		expect(ancestorRect(5, 9, 1)).toEqual({ x: 2, y: 4, sx: 128, sy: 128, size: 128 });
		expect(ancestorRect(4, 8, 2)).toEqual({ x: 1, y: 2, sx: 0, sy: 0, size: 64 });
		// An unwrapped column west of 0 stays on its own side.
		expect(ancestorRect(-1, 3, 2)).toEqual({ x: -1, y: 0, sx: 192, sy: 192, size: 64 });
	});
});

describe('the inks', () => {
	it('pack little-endian RGBA for a Uint32 view of ImageData', () => {
		expect(packRgba(255, 0, 0, 128)).toBe(0x800000ff);
		expect(inkRgba('#ffff00', 0.5)).toBe(0x8000ffff);
		const bytes = new Uint8ClampedArray(Uint32Array.from([inkRgba('#d2d200', 1)]).buffer);
		expect(Array.from(bytes)).toEqual([0xd2, 0xd2, 0x00, 0xff]);
	});

	it('give the legend what the map shows', () => {
		expect(terrainSwatchCss('#ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
		expect(terrainSwatches()).toEqual({ red: 'rgba(255, 0, 0, 0.5)', yellow: 'rgba(255, 255, 0, 0.5)' });
	});

	it('dither with the firmware mask, an X over the 8 x 8 cell', () => {
		expect(TERRAIN_DITHER_MASK).toHaveLength(64);
		const cell = ditherCell(7);
		for (let r = 0; r < 8; r++) {
			for (let c = 0; c < 8; c++) {
				expect(cell[r * 8 + c], `(${r}, ${c})`).toBe(r === c || r + c === 7 ? 7 : 0);
			}
		}
	});
});
