/* The arithmetic of the relative-terrain shading (map/terrainAwareLayer.ts),
 * kept free of Leaflet and of the DOM so it can be pinned by Vitest
 * (tests/terrainShade.spec.ts; contract docs/terrain-awareness.md).
 *
 * The terrain tiles are already in the map's own projection (Web Mercator,
 * the slippy z/x/y grid), so no reprojection is involved: a tile at level L
 * drawn at map zoom Z is a square of 256 * 2^(Z - L) CSS pixels at a place
 * that is a multiplication away. The shading is painted PER TILE into a
 * 256 x 256 bitmap and the bitmaps are blitted per frame, Leaflet's own
 * GridLayer idea, so a pan costs a few dozen drawImage calls and only a new
 * reference altitude costs pixels.
 *
 * Pixels are packed for an ImageData seen as a Uint32Array, which is
 * little-endian on every platform the app runs on: A << 24 | B << 16 |
 * G << 8 | R. */

import type { DecodedTile, TerrainLevels, TileCoord } from './terrain';
import { NO_DATA, TILE_SIZE, completeLevel } from './terrain';
import { TERRAIN_BANDS, type TerrainBand, type TerrainTier } from '$lib/nav/terrainAwareness';

/** How opaque the shading is over the chart. A flat translucent fill is how
 *  ForeFlight shows the same rule over a chart: the chart's own relief, its
 *  hypsometric tints and every line of it stay readable underneath, which is
 *  what the hillshade on Garmin's black Terrain page is there to give back. */
export const TERRAIN_SHADE_ALPHA = 0.5;

/** The no-data ink: a tile that could not be read is covered by Garmin's own
 *  8 x 8 dither (the firmware draws its "unread" samples that way) in this
 *  neutral grey, the radar's no-coverage ink, so a gap never passes for
 *  ground that is safely below. */
export const TERRAIN_NODATA_INK = '#78909c';
export const TERRAIN_NODATA_ALPHA = 0.7;

/** The firmware's dither mask (8 x 8, row by row), an X over the cell. */
export const TERRAIN_DITHER_MASK: readonly number[] = [
	1, 0, 0, 0, 0, 0, 0, 1,
	0, 1, 0, 0, 0, 0, 1, 0,
	0, 0, 1, 0, 0, 1, 0, 0,
	0, 0, 0, 1, 1, 0, 0, 0,
	0, 0, 0, 1, 1, 0, 0, 0,
	0, 0, 1, 0, 0, 1, 0, 0,
	0, 1, 0, 0, 0, 0, 1, 0,
	1, 0, 0, 0, 0, 0, 0, 1,
];

/** Most tiles a warm may ask for; past it the level steps coarser, whose
 *  pooled maximum is exact for a "at or above" test and only paints larger
 *  cells (a 4K screen at zoom 12 would otherwise want 144 tiles at once).
 *  The layer lowers it to half the decoded-tile budget where that is less
 *  (warmCap), since a warm the cache cannot hold whole evicts its own first
 *  tiles to make room for its last and asks for them again forever. */
export const MAX_WARM_TILES = 64;

/** The tiles a warm may ask for against a decoded-tile budget. */
export function warmCap(budget: number, max = MAX_WARM_TILES): number {
	return Math.max(1, Math.min(max, Math.floor(budget / 2)));
}

/** One pixel for a Uint32 view of ImageData bytes (little-endian RGBA). */
export function packRgba(r: number, g: number, b: number, a: number): number {
	return (((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
}

/** A `#rrggbb` ink at an opacity in [0, 1], packed. */
export function inkRgba(hex: string, alpha: number): number {
	const n = parseInt(hex.slice(1), 16);
	return packRgba((n >> 16) & 255, (n >> 8) & 255, n & 255, Math.round(alpha * 255));
}

/** The CSS colour a legend swatch takes to show what the map shows: the ink
 *  at the shade's own opacity, over the swatch's own background. */
export function terrainSwatchCss(ink: string, alpha = TERRAIN_SHADE_ALPHA): string {
	const n = parseInt(ink.slice(1), 16);
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** The packed colour of each band, in the bands' order. */
export function bandColours(
	bands: readonly TerrainBand[] = TERRAIN_BANDS,
	alpha = TERRAIN_SHADE_ALPHA,
): Uint32Array {
	return Uint32Array.from(bands.map((b) => inkRgba(b.ink, alpha)));
}

/** The swatch colour of each tier, for the legend and the Layers tab. */
export function terrainSwatches(bands: readonly TerrainBand[] = TERRAIN_BANDS): Record<TerrainTier, string> {
	const out = {} as Record<TerrainTier, string>;
	for (const b of bands) {
		out[b.tier] = terrainSwatchCss(b.ink);
	}
	return out;
}

/** The level whose tiles are drawn at map zoom `zoom`: the floor of the zoom,
 *  capped at the deepest level published, or null below the coarsest one,
 *  where a tile's cells would fall under a screen pixel and a lone red cell
 *  could vanish between two pixel centres. The floor and not the round: a
 *  cell then spans one to two CSS pixels at a fractional zoom, so every cell
 *  holds a pixel centre. */
export function levelForZoom(zoom: number, levels: TerrainLevels): number | null {
	const z = Math.floor(zoom + 1e-9);
	if (z < levels.coarsest) {
		return null;
	}
	return Math.min(levels.deepest, z);
}

/** The view a canvas paints: its top-left corner in projected pixels at the
 *  draw zoom (Leaflet's pixel origin plus the canvas position, canvasZoom.ts),
 *  its size in CSS pixels, and the zoom. */
export interface ShadeView {
	bx: number;
	by: number;
	w: number;
	h: number;
	zoom: number;
}

/** The side of a level-`level` tile in CSS pixels at the view's zoom. */
export function tileSidePx(zoom: number, level: number): number {
	return TILE_SIZE * 2 ** (zoom - level);
}

/** The tiles at `level` covering the view, grown by `ring` tiles on every
 *  side, nearest the view's centre first (the aircraft's own tiles, in
 *  follow mode, then outward). Columns are UNWRAPPED, so a view across the
 *  antimeridian keeps its geometry (the tile cache wraps them); rows are
 *  clamped to the Mercator grid. */
export function viewportTiles(view: ShadeView, level: number, ring = 0): TileCoord[] {
	const s = tileSidePx(view.zoom, level);
	const n = 2 ** level;
	const x0 = Math.floor(view.bx / s) - ring;
	const x1 = Math.floor((view.bx + Math.max(1, view.w) - 1) / s) + ring;
	const y0 = Math.max(0, Math.floor(view.by / s) - ring);
	const y1 = Math.min(n - 1, Math.floor((view.by + Math.max(1, view.h) - 1) / s) + ring);
	const cx = (view.bx + view.w / 2) / s - 0.5;
	const cy = (view.by + view.h / 2) / s - 0.5;
	const out: TileCoord[] = [];
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			out.push({ z: level, x, y });
		}
	}
	out.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
	return out;
}

/** The level a view is drawn at: the zoom's own level, stepped coarser while
 *  the view with its warm ring would ask for more than `maxTiles` tiles.
 *  Null where nothing is drawn: below the coarsest level, and where even the
 *  coarsest level's tiles in view alone outnumber `maxTiles` (a 4K screen at
 *  zoom 6), which the legend reads as "zoom in" like the first case, rather
 *  than asking for more tiles than can be held. */
export function shadeLevel(
	view: ShadeView,
	levels: TerrainLevels,
	ring = 1,
	maxTiles = MAX_WARM_TILES,
): number | null {
	let level = levelForZoom(view.zoom, levels);
	if (level == null) {
		return null;
	}
	while (level > levels.coarsest && viewportTiles(view, level, ring).length > maxTiles) {
		level--;
	}
	if (viewportTiles(view, level, 0).length > maxTiles) {
		return null;
	}
	return level;
}

/** The tiles a warm asks for, in order: the view's own nearest its centre
 *  first, then the ring around it, at most `cap` of them, so a cap can only
 *  ever cut the ring. Columns unwrapped, like viewportTiles. */
export function warmTiles(view: ShadeView, level: number, ring: number, cap: number): TileCoord[] {
	const inView = viewportTiles(view, level, 0);
	const seen = new Set(inView.map((t) => `${t.x}/${t.y}`));
	const around = viewportTiles(view, level, ring).filter((t) => !seen.has(`${t.x}/${t.y}`));
	return [...inView, ...around].slice(0, Math.max(0, cap));
}

/** Paint one tile's shading into `out` (256 * 256 packed pixels) from its
 *  `max` band, the highest ground in each pixel's footprint: the band the
 *  whole app compares a ceiling against, and the only one for which a pooled
 *  coarse tile stays exact. `thresholds` are the bands' lower edges in whole
 *  metres (tierThresholdsM), `colours` their packed inks, in the same order,
 *  most severe first. A pixel no source covered (the open sea inside a
 *  coastal tile) is left clear, never shaded: Garmin never shades the sea
 *  either. Returns how many pixels took a colour. */
export function paintTile(
	out: Uint32Array,
	max: Int16Array,
	thresholds: Int32Array,
	colours: Uint32Array,
): number {
	const n = Math.min(out.length, max.length);
	const bands = Math.min(thresholds.length, colours.length);
	let painted = 0;
	if (bands === 2) {
		// The fixed-wing pair, unrolled: two compares a pixel.
		const t0 = thresholds[0];
		const t1 = thresholds[1];
		const c0 = colours[0];
		const c1 = colours[1];
		for (let i = 0; i < n; i++) {
			const v = max[i];
			if (v === NO_DATA || v < t1) {
				out[i] = 0;
			} else {
				out[i] = v >= t0 ? c0 : c1;
				painted++;
			}
		}
		return painted;
	}
	for (let i = 0; i < n; i++) {
		const v = max[i];
		let c = 0;
		if (v !== NO_DATA) {
			for (let b = 0; b < bands; b++) {
				if (v >= thresholds[b]) {
					c = colours[b];
					break;
				}
			}
		}
		out[i] = c;
		if (c !== 0) {
			painted++;
		}
	}
	return painted;
}

/** Does a tile's max band hold a no-data pixel? */
export function hasNoData(max: Int16Array): boolean {
	for (let i = 0; i < max.length; i++) {
		if (max[i] === NO_DATA) {
			return true;
		}
	}
	return false;
}

// tileVoided's answer per decoded tile: a scan of its max band, once.
const voidedMemo = new WeakMap<DecodedTile, boolean>();

/** Is a tile VOIDED: above the complete level and holding a no-data pixel?
 *  There that pixel is ground no finer tier covers (a parent pooled at a 30 m
 *  box's edge keeps no-data over the land no child covered), not the sea,
 *  which the native data writes as 0 m: over the 2 602 z11 and z12 tiles the
 *  corpus flights read, coasts included, none held one. Painted as it
 *  stands, the void would read as clear water over the land; the layer draws
 *  the nearest usable ancestor instead, whose pooled maximum is the ground
 *  the alert's corridor falls back to there too. */
export function tileVoided(tile: DecodedTile, levels: TerrainLevels): boolean {
	if (tile.z <= completeLevel(levels)) {
		return false; // a no-data pixel there is the sea
	}
	let v = voidedMemo.get(tile);
	if (v === undefined) {
		v = hasNoData(tile.max);
		voidedMemo.set(tile, v);
	}
	return v;
}

/** The ancestor `k` levels up of tile (x, y) and the square of its bitmap
 *  that covers the tile, in the ancestor's own 256-pixel frame: what a tile
 *  still loading is drawn from meanwhile (its pooled maximum over-paints and
 *  never under-paints, so the stand-in is conservative). `x` may be
 *  unwrapped; the ancestor's column is too, the cache wraps it. */
export function ancestorRect(
	x: number,
	y: number,
	k: number,
): { x: number; y: number; sx: number; sy: number; size: number } {
	const f = 2 ** k;
	const ax = Math.floor(x / f);
	const ay = Math.floor(y / f);
	const size = TILE_SIZE / f;
	return { x: ax, y: ay, sx: (x - ax * f) * size, sy: (y - ay * f) * size, size };
}

/** The 8 x 8 dither cell in an ink, packed, for a repeating pattern. */
export function ditherCell(rgba: number): Uint32Array {
	return Uint32Array.from(TERRAIN_DITHER_MASK.map((m) => (m ? rgba : 0)));
}
