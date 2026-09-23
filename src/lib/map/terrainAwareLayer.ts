/* terrainAwareLayer.ts draws the relative-terrain shading (contract:
 * docs/terrain-awareness.md): the ground around the aircraft in Garmin's
 * Terrain Proximity colours, red at or above the aircraft or less than 100 ft
 * below it, yellow 100 to 1 000 ft below, nothing deeper, read against the
 * pose's GPS altitude while a recording or a replay supplies one.
 *
 * Pane 'terrain-aware', z 335: over the chart rasters and the VAC panels,
 * under the radar (340) and every line of symbology, so a boundary, a
 * frequency box or a route stays readable through the colour. It is
 * symbology, not a raster basemap, so it keeps full contrast at night (it is
 * not in app.css's night-dim family).
 *
 * The paint is per TILE (map/terrainShade.ts): each terrain tile in view is
 * painted once into a 256 x 256 bitmap for the reference in force, and a frame
 * blits the bitmaps at their place, so a pan costs a few dozen drawImage calls
 * and only a new reference altitude (a 10 ft step, quantised) costs pixels. A
 * tile still loading is drawn from its nearest loaded ancestor meanwhile (a
 * pooled maximum over-paints, never under-paints); a tile whose load FAILED
 * takes Garmin's no-data dither, so a gap never reads as ground safely below.
 * A tile the server does not hold is the open sea at or below the complete
 * level and is left clear; above it, it only says no finer tier reaches
 * there (outside the 30 m boxes, z11 and z12 answer 204 over the Elburz as
 * over the sea), and the level beneath stands in for it for good.
 *
 * Passive: the canvas is pointer-transparent (DirectDrawLayer), nothing here
 * is hit-tested, and the layer imports no catalog (it draws no text). The
 * tiles come through map/terrain.ts's shared, bounded cache, warmed from the
 * view behind a debounce; a pending-tile count goes back through a callback,
 * since map modules import no state. */

import type L from 'leaflet';
import { DirectDrawLayer, ensurePane } from './directDrawLayer';
import {
	TILE_RETRY_MS,
	TILE_SIZE,
	absentIsSea,
	peekTile,
	terrainLevels,
	terrainTileCacheStats,
	terrainTileDue,
	terrainTileFailed,
	visitTiles,
	type DecodedTile,
	type TerrainLevels,
	type TileCoord,
} from './terrain';
import {
	TERRAIN_NODATA_ALPHA,
	TERRAIN_NODATA_INK,
	ancestorRect,
	bandColours,
	ditherCell,
	inkRgba,
	paintTile,
	shadeLevel,
	tileSidePx,
	tileVoided,
	viewportTiles,
	warmCap,
	warmTiles,
	type ShadeView,
} from './terrainShade';
import { nextReferenceFt, tierThresholdsM } from '$lib/nav/terrainAwareness';

const PANE = 'terrain-aware';
// 335 sits between the VAC panels (300) and the radar (340): under every
// line of symbology, over the chart it colours.
const PANE_Z = '335';
/** A view settles this long before its tiles are asked for, so a zoom from 12
 *  to 6 asks for one level's view and not all seven. */
const WARM_DEBOUNCE_MS = 250;
/** Tiles arriving close together repaint once. */
const REDRAW_COALESCE_MS = 50;
/** Bitmaps kept past the ones the last frame drew (a pan back is free). */
const MAX_BITMAPS = 64;

/** What the last frame could not draw: tiles in view still loading, tiles
 *  whose load failed (drawn with the no-data dither), and whether the view is
 *  zoomed out past the coarsest level, where nothing is shaded at all. */
export interface TerrainShadeStats {
	pending: number;
	failed: number;
	zoomedOut: boolean;
}

interface Bitmap {
	canvas: HTMLCanvasElement;
	/** The reference it was painted for, and the tile object it was painted
	 *  from: a tile the shared cache evicted and read again is a new object.
	 *  Held WEAKLY, or a bitmap would keep a tile the cache evicted alive
	 *  (384 KiB each, up to MAX_BITMAPS of them past the tile budget). */
	ref: number;
	tile: WeakRef<DecodedTile>;
}

/** How a tile in view is drawn when it is not in hand itself. */
type StandIn = 'drawn' | 'sea' | 'pending' | 'failed';

let layer: TerrainCanvasLayer | null = null;
let layerMap: L.Map | null = null;
let visible = false;
/** The reference altitude on its quantum (feet MSL), null for no shading. */
let refFt: number | null = null;
let statsListener: ((s: TerrainShadeStats) => void) | null = null;
const COLOURS = bandColours();
const NODATA_RGBA = inkRgba(TERRAIN_NODATA_INK, TERRAIN_NODATA_ALPHA);

function mod(a: number, n: number): number {
	return ((a % n) + n) % n;
}

class TerrainCanvasLayer extends DirectDrawLayer {
	protected override readonly canvasClass = 'leaflet-terrain-aware-canvas';
	protected override readonly paneName = PANE;

	// Prefixed, never Leaflet's own names: L.Evented keeps private _on / _off
	// helpers on the prototype, and a field shadowing one broke removeLayer
	// in the radar layer (radarLayer.ts).
	private _taBitmaps = new Map<string, Bitmap>();
	private _taScratch: ImageData | null = null;
	private _taScratchU32: Uint32Array | null = null;
	private _taDither: CanvasPattern | null = null;
	private _taWarmTimer: ReturnType<typeof setTimeout> | null = null;
	private _taRedrawTimer: ReturnType<typeof setTimeout> | null = null;
	private _taRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private _taWarmCtrl: AbortController | null = null;
	/** The tile keys (z/x/y) of the warm in flight. */
	private _taWarmSet = new Set<string>();
	private _taPending = -1;
	private _taFailed = -1;
	private _taZoomedOut: boolean | null = null;

	/** Timers, the warm and the bitmaps go with the layer: a hidden shading
	 *  holds no canvas memory and asks for no tile. */
	override onRemove(map: L.Map): this {
		super.onRemove(map);
		for (const t of [this._taWarmTimer, this._taRedrawTimer, this._taRetryTimer]) {
			if (t != null) {
				clearTimeout(t);
			}
		}
		this._taWarmTimer = null;
		this._taRedrawTimer = null;
		this._taRetryTimer = null;
		this._taWarmCtrl?.abort();
		this._taWarmCtrl = null;
		this._taWarmSet = new Set();
		this._taBitmaps.clear();
		this._taScratch = null;
		this._taScratchU32 = null;
		this._taDither = null;
		this._taReport(0, 0, false);
		return this;
	}

	/** Every view change also schedules the warm (the base binds moveend /
	 *  zoomend / viewreset / resize to _reset). */
	protected override _reset(): void {
		super._reset();
		this._taScheduleWarm();
	}

	private _taView(): ShadeView | null {
		const map = this._map;
		const st = this._drawState;
		if (!map || !st) {
			return null;
		}
		const size = map.getSize();
		return {
			bx: st.origin.x + st.topLeft.x,
			by: st.origin.y + st.topLeft.y,
			w: size.x,
			h: size.y,
			zoom: st.zoom,
		};
	}

	protected override _draw(): void {
		const canvas = this._canvas;
		const ctx = this._ctx;
		if (!canvas || !ctx || !this._map) {
			return;
		}
		const dpr = window.devicePixelRatio || 1;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.scale(dpr, dpr);
		const view = this._taView();
		const levels = terrainLevels();
		const level = view && refFt != null ? shadeLevel(view, levels, 1, warmCap(terrainTileCacheStats().budget)) : null;
		if (view == null || refFt == null || level == null) {
			this._taReport(0, 0, view != null && refFt != null);
			return;
		}
		const side = tileSidePx(view.zoom, level);
		const thresholds = tierThresholdsM(refFt);
		// Nearest-neighbour: a cell is a cell, and a blend of red into clear
		// would draw a band the rule never computed. Set per frame, because a
		// canvas resize resets the context's state.
		ctx.imageSmoothingEnabled = false;
		const used = new Set<string>();
		let pending = 0;
		let failed = 0;
		for (const t of viewportTiles(view, level, 0)) {
			const dx = t.x * side - view.bx;
			const dy = t.y * side - view.by;
			const tile = peekTile(level, t.x, t.y);
			const voided = tile != null && tileVoided(tile, levels);
			if (tile && !voided) {
				ctx.drawImage(this._taBitmap(tile, refFt, thresholds, used), dx, dy, side, side);
			} else if (tile === undefined && terrainTileFailed(level, t.x, t.y)) {
				failed++;
				this._taDitherRect(ctx, view, dx, dy, side);
			} else if (tile === undefined || voided || !absentIsSea(level, levels)) {
				// Loading, a level no tier reaches here, or one whose tile
				// holds ground no finer tier covers: the nearest ancestor in
				// hand stands in (for good, in the last two cases).
				const standIn = this._taAncestor(ctx, t, levels, refFt, thresholds, used, dx, dy, side);
				if (standIn === 'failed') {
					failed++;
					this._taDitherRect(ctx, view, dx, dy, side);
				} else if (tile === undefined || standIn === 'pending') {
					pending++;
				}
			}
			// null at or below the complete level: the open sea. Clear.
		}
		this._taPrune(used);
		this._taReport(pending, failed, false);
		// A failed tile is asked again once the cache's retry delay is over,
		// whoever's read it was that failed (a warm this layer aborted, the
		// alert's corridor, the cursor badge).
		if (failed > 0) {
			this._taScheduleRetry();
		}
	}

	/** The tile's bitmap for this reference, painted on demand. */
	private _taBitmap(
		tile: DecodedTile,
		ref: number,
		thresholds: Int32Array,
		used: Set<string>,
	): HTMLCanvasElement {
		const key = `${tile.z}/${tile.tx}/${tile.ty}`;
		used.add(key);
		let bmp = this._taBitmaps.get(key);
		if (bmp && bmp.ref === ref && bmp.tile.deref() === tile) {
			this._taBitmaps.delete(key);
			this._taBitmaps.set(key, bmp);
			return bmp.canvas;
		}
		if (!bmp) {
			const canvas = document.createElement('canvas');
			canvas.width = TILE_SIZE;
			canvas.height = TILE_SIZE;
			bmp = { canvas, ref, tile: new WeakRef(tile) };
		}
		if (!this._taScratch || !this._taScratchU32) {
			this._taScratch = new ImageData(TILE_SIZE, TILE_SIZE);
			this._taScratchU32 = new Uint32Array(this._taScratch.data.buffer);
		}
		paintTile(this._taScratchU32, tile.max, thresholds, COLOURS);
		bmp.canvas.getContext('2d')?.putImageData(this._taScratch, 0, 0);
		bmp.ref = ref;
		bmp.tile = new WeakRef(tile);
		this._taBitmaps.delete(key);
		this._taBitmaps.set(key, bmp);
		return bmp.canvas;
	}

	/** A tile not in hand, drawn from the nearest ancestor that is (its
	 *  pooled maximum is conservative over the tile's own ground). An ancestor
	 *  the server does not hold above the complete level is passed over like
	 *  the tile itself; at or below it, it is the sea. */
	private _taAncestor(
		ctx: CanvasRenderingContext2D,
		t: TileCoord,
		levels: TerrainLevels,
		ref: number,
		thresholds: Int32Array,
		used: Set<string>,
		dx: number,
		dy: number,
		side: number,
	): StandIn {
		let failed = false;
		for (let k = 1; t.z - k >= levels.coarsest; k++) {
			const z = t.z - k;
			const a = ancestorRect(t.x, t.y, k);
			const anc = peekTile(z, a.x, a.y);
			if (anc && !tileVoided(anc, levels)) {
				const bmp = this._taBitmap(anc, ref, thresholds, used);
				ctx.drawImage(bmp, a.sx, a.sy, a.size, a.size, dx, dy, side, side);
				return 'drawn';
			}
			if (anc) {
				continue; // voided above the complete level: further up
			}
			if (anc === null && absentIsSea(z, levels)) {
				return 'sea'; // nothing to stand in
			}
			if (anc === undefined && terrainTileFailed(z, a.x, a.y)) {
				failed = true;
			}
		}
		return failed ? 'failed' : 'pending';
	}

	/** The ancestor to ask for where a tile in view is absent above the
	 *  complete level, or holds ground no finer tier covers there (voided):
	 *  the first one up that is neither in hand nor known absent, if it is
	 *  due. Null when a usable one is in hand, the sea is reached, or the
	 *  next one up failed a moment ago. */
	private _taStandInWanted(t: TileCoord, levels: TerrainLevels): TileCoord | null {
		for (let k = 1; t.z - k >= levels.coarsest; k++) {
			const z = t.z - k;
			const a = ancestorRect(t.x, t.y, k);
			const anc = peekTile(z, a.x, a.y);
			if (anc) {
				if (!tileVoided(anc, levels)) {
					return null;
				}
				continue; // voided above the complete level: further up
			}
			if (anc === null) {
				if (absentIsSea(z, levels)) {
					return null;
				}
				continue;
			}
			return terrainTileDue(z, a.x, a.y) ? { z, x: a.x, y: a.y } : null;
		}
		return null;
	}

	/** Garmin's no-data dither over a tile that could not be read, anchored to
	 *  the map so it holds still under a pan. */
	private _taDitherRect(
		ctx: CanvasRenderingContext2D,
		view: ShadeView,
		dx: number,
		dy: number,
		side: number,
	): void {
		if (!this._taDither) {
			const cell = document.createElement('canvas');
			cell.width = 8;
			cell.height = 8;
			const c = cell.getContext('2d');
			if (!c) {
				return;
			}
			const img = new ImageData(8, 8);
			new Uint32Array(img.data.buffer).set(ditherCell(NODATA_RGBA));
			c.putImageData(img, 0, 0);
			this._taDither = ctx.createPattern(cell, 'repeat');
			if (!this._taDither) {
				return;
			}
		}
		const p = this._taDither;
		if (typeof DOMMatrix !== 'undefined' && typeof p.setTransform === 'function') {
			p.setTransform(new DOMMatrix([1, 0, 0, 1, -mod(view.bx, 8), -mod(view.by, 8)]));
		}
		ctx.fillStyle = p;
		ctx.fillRect(dx, dy, side, side);
	}

	/** Drop the least recently drawn bitmaps past the cap, never one this
	 *  frame drew. */
	private _taPrune(used: Set<string>): void {
		if (this._taBitmaps.size <= MAX_BITMAPS) {
			return;
		}
		for (const key of this._taBitmaps.keys()) {
			if (this._taBitmaps.size <= MAX_BITMAPS) {
				return;
			}
			if (!used.has(key)) {
				this._taBitmaps.delete(key);
			}
		}
	}

	private _taReport(pending: number, failed: number, zoomedOut: boolean): void {
		if (pending === this._taPending && failed === this._taFailed && zoomedOut === this._taZoomedOut) {
			return;
		}
		this._taPending = pending;
		this._taFailed = failed;
		this._taZoomedOut = zoomedOut;
		statsListener?.({ pending, failed, zoomedOut });
	}

	private _taScheduleWarm(): void {
		if (this._taWarmTimer != null) {
			clearTimeout(this._taWarmTimer);
		}
		this._taWarmTimer = setTimeout(() => {
			this._taWarmTimer = null;
			this._taWarm();
		}, WARM_DEBOUNCE_MS);
	}

	private _taScheduleRedraw(): void {
		if (this._taRedrawTimer != null) {
			return;
		}
		this._taRedrawTimer = setTimeout(() => {
			this._taRedrawTimer = null;
			if (this._map) {
				this.redraw();
			}
		}, REDRAW_COALESCE_MS);
	}

	private _taScheduleRetry(): void {
		if (this._taRetryTimer != null) {
			return;
		}
		// A failed tile is asked again once the cache's retry delay is over.
		this._taRetryTimer = setTimeout(() => {
			this._taRetryTimer = null;
			if (this._map) {
				this._taWarm();
			}
		}, TILE_RETRY_MS + 1_000);
	}

	/** Ask for the view's tiles (and a ring around it) that are not in hand,
	 *  the view's own nearest the centre first, at most warmCap of them,
	 *  unless the same ones are already on their way; and, for a tile the
	 *  server does not hold above the complete level, the ancestor standing in
	 *  for it. A tile in hand, known absent, or failed within the cache's
	 *  retry delay is never asked for, so a repaint (which lands here through
	 *  _reset) does not re-ask a failure it is only drawing; an aborted warm's
	 *  tiles still waiting for a connection are dropped by the cache. */
	private _taWarm(): void {
		const view = this._taView();
		if (refFt == null || !view || !this._map) {
			return;
		}
		const levels = terrainLevels();
		const cap = warmCap(terrainTileCacheStats().budget);
		const level = shadeLevel(view, levels, 1, cap);
		if (level == null) {
			return;
		}
		const n = 2 ** level;
		const want: TileCoord[] = [];
		const keys = new Set<string>();
		const ask = (t: TileCoord): void => {
			const key = `${t.z}/${t.x}/${t.y}`;
			if (!keys.has(key)) {
				keys.add(key);
				want.push(t);
			}
		};
		for (const t of warmTiles(view, level, 1, cap)) {
			const x = mod(t.x, n);
			const held = peekTile(level, x, t.y);
			if (terrainTileDue(level, x, t.y)) {
				ask({ z: level, x, y: t.y });
			} else if ((!absentIsSea(level, levels) && held === null) || (held && tileVoided(held, levels))) {
				const anc = this._taStandInWanted({ z: level, x, y: t.y }, levels);
				if (anc) {
					ask(anc);
				}
			}
		}
		if (want.length === 0) {
			return;
		}
		const inFlight =
			this._taWarmCtrl != null &&
			!this._taWarmCtrl.signal.aborted &&
			want.every((t) => this._taWarmSet.has(`${t.z}/${t.x}/${t.y}`));
		if (inFlight) {
			return;
		}
		this._taWarmCtrl?.abort();
		const ctrl = new AbortController();
		this._taWarmCtrl = ctrl;
		this._taWarmSet = new Set(keys);
		void visitTiles(want, () => this._taScheduleRedraw(), ctrl.signal).then(() => {
			// A failure is asked again after the retry delay whether or not a
			// later warm aborted this one.
			if (want.some((t) => terrainTileFailed(t.z, t.x, t.y))) {
				this._taScheduleRetry();
			}
			if (ctrl.signal.aborted) {
				return;
			}
			this._taWarmCtrl = null;
			this._taWarmSet = new Set();
			if (!this._map) {
				return;
			}
			// The absent and the failed call no visitor: repaint for them too,
			// and warm again, since an absent tile names the ancestor to ask.
			this._taScheduleRedraw();
			this._taScheduleWarm();
		});
	}
}

/** Build the layer once (idempotent); attached by syncTerrainAwareLayer. */
export function buildTerrainAwareLayer(map: L.Map): void {
	if (layer) {
		return;
	}
	layerMap = map;
	ensurePane(map, PANE, PANE_Z);
	layer = new TerrainCanvasLayer();
}

/** The altitude the ground is coloured against (feet MSL), or null for none.
 *  Quantised down, with a climb's hysteresis (nextReferenceFt), and a repaint
 *  only when the reference moves. */
export function setTerrainReference(altFt: number | null): void {
	const q = altFt == null || !Number.isFinite(altFt) ? null : nextReferenceFt(refFt, altFt);
	if (q === refFt) {
		return;
	}
	refFt = q;
	if (layer && layerMap?.hasLayer(layer)) {
		layer.redraw();
	}
}

/** Where the layer reports what it could not draw (the legend's hints). */
export function setTerrainShadeListener(fn: ((s: TerrainShadeStats) => void) | null): void {
	statsListener = fn;
}

/** Reconcile attachment with the toggle and the reference, and redraw. */
export function syncTerrainAwareLayer(map: L.Map, on: boolean): void {
	visible = on;
	if (!layer) {
		return;
	}
	const has = map.hasLayer(layer);
	if (visible && !has) {
		layer.addTo(map);
	} else if (!visible && has) {
		map.removeLayer(layer);
	}
}

/** Detach and drop the layer; buildTerrainAwareLayer must rebuild (HMR). */
export function clearTerrainAwareLayer(map: L.Map): void {
	if (layer && map.hasLayer(layer)) {
		map.removeLayer(layer);
	}
	layer = null;
	layerMap = null;
	visible = false;
	refFt = null;
}
