/* Ground-terrain elevation from the application's own tile mosaic.
 *
 * One object per z/x/y holds three int16 bands in metres, gzipped, read
 * through map/terrainTile.ts: the ground under a point, the highest ground in
 * each pixel's footprint and the lowest. The pyramid carries POOLED extremes,
 * so a corridor can be answered exactly from a handful of coarse tiles rather
 * than hundreds of fine ones, and a coarse read costs granularity and never
 * correctness. Built by cmd/terrain from Copernicus GLO-30, GLO-90 and
 * NASADEM; see docs/terrain-sources.md for what covers what and under which
 * licence, and docs/vertical-limits.md for what each band may be used for.
 *
 * Tiles use the standard Web-Mercator slippy scheme ({z}/{x}/{y}, y
 * southward), identical to the Leaflet base layers, so the projection here is
 * the canonical OSM formula.
 *
 * There is no canvas and no DOM: a tile decodes to Int16Array through
 * DecompressionStream, which is what lets the whole module be Vitest-tested
 * rather than only exercised by hand. Plain .ts: the module-level Map tile
 * cache is intentionally non-reactive (svelte/prefer-svelte-reactivity only
 * fires in .svelte / .svelte.ts). */

import { CHART_WORKER } from '$lib/net/endpoints';
import { decodeTerrainTile } from '$lib/map/terrainTile';
import { equirectangularDistanceM, M_PER_DEG } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import { passiveFetchBlob } from '$lib/offline/passiveStore';

/** Tiles are 256x256. */
export const TILE_SIZE = 256;

/** Default sampling zoom. At z12 a pixel is 38 m at the equator and 27 m at
 *  45 deg N (earth circumference / (256 * 2^z), times cos(lat)), which is the
 *  resolution of the source itself over France: the mosaic carries EU-DEM 30 m
 *  there, and z11..z15 read the same summits within a few feet, so a deeper
 *  zoom buys interpolation, not information (it does buy some in the UK's 2 m
 *  and Austria's 10 m tiles). Tile counts, and Worker requests, stay low. */
export const DEFAULT_TERRAIN_ZOOM = 12;

/** Earth circumference at the equator (m), the Web-Mercator world width. */
const EARTH_CIRC_M = 40075016.7;

/** Which zoom levels the terrain source publishes.
 *
 *  One source publishing one level is the degenerate case, and the one in
 *  force today. The mosaic that replaces it publishes a PYRAMID whose coarse
 *  levels carry the pooled extremes of everything beneath them, so a corridor
 *  can be answered exactly from a handful of coarse tiles instead of hundreds
 *  of fine ones: at a 1 NM bin the arithmetic below picks z8, where a 100 NM
 *  corridor is about 8 tiles rather than 72. Keeping the descriptor here, and
 *  every consumer reading it through `pickLevel`, is what makes that a
 *  configuration change rather than a rewrite. */
export interface TerrainLevels {
	/** The deepest level published; a POINT query starts here. */
	deepest: number;
	/** The coarsest a reduction may fall back to. */
	coarsest: number;
}

/* The pyramid the mosaic actually publishes, as a BUILT-IN rather than
 * something the manifest has to arrive for. Terrain is a safety input: it
 * decides minimum safe altitudes, the AGL an airspace alert is graded on and
 * the ground drawn under the aircraft, and none of that may depend on one
 * more JSON fetch succeeding. The manifest still refines this (and carries
 * the credits), so a deeper national tier needs no code change to be read;
 * but a manifest that never loads costs the About credits, never the ground.
 * `cmd/terrain -pool -floor 6` is where the coarse end comes from. */
let levels: TerrainLevels = {
	deepest: DEFAULT_TERRAIN_ZOOM,
	coarsest: 6,
};

/** The levels in force. */
export function terrainLevels(): TerrainLevels {
	return levels;
}

/** Declare what the source publishes (the mosaic's manifest, later). */
export function setTerrainLevels(next: TerrainLevels): void {
	levels = next;
	// The settled nulls in the tile cache were reached by walking THIS range,
	// so a new one has to be free to walk again. Inherited from the source
	// switch this replaced, which cleared for the same reason.
	tileCache.clear();
	settledTiles.clear();
}

/** How many pooled pixels a bin should hold before a coarser level is worth
 *  taking. Four across, so a bin's extremes come from about 16 pooled pixels
 *  and the quantisation of its edges stays under a quarter of it. */
const PIXELS_PER_BIN = 4;

/** The coarsest level whose pixel still fits `PIXELS_PER_BIN` times across a
 *  bin of `binM` metres at this latitude, clamped to what the source
 *  publishes. Pure.
 *
 *  Reading a coarser level never costs correctness, only granularity: a
 *  pooled maximum IS the maximum of everything under it. It costs bytes not
 *  to; measured on a real Alpine leg, one tile at z8 against six at z10.
 *
 *  The granularity is spent on the CORRIDOR EDGE, and in the safe direction.
 *  A pixel is admitted by its centre, so a coarse pixel straddling the edge
 *  brings in ground just outside it: the same leg answered 2999 m at z8 and
 *  2967 m at z10, never the other way about. A maximum that errs high and a
 *  minimum that errs low are what every consumer of these bands wants. */
export function pickLevel(binM: number, lat: number, l: TerrainLevels = levels): number {
	if (!(binM > 0)) {
		return l.deepest;
	}
	const cosLat = Math.abs(Math.cos((lat * Math.PI) / 180)) || 1e-6;
	const wanted = Math.ceil(
		Math.log2((EARTH_CIRC_M * cosLat * PIXELS_PER_BIN) / (TILE_SIZE * binM)),
	);
	return Math.min(l.deepest, Math.max(l.coarsest, wanted));
}

/** Web-Mercator latitude limit; tan/ln blow up past it. */
const MERCATOR_MAX_LAT = 85.05112878;

/** Fractional Web-Mercator tile coordinate for a lat/lon at zoom z. x grows
 *  eastward, y southward (standard XYZ / Leaflet scheme). Latitude is clamped
 *  to the Mercator limit so the result stays finite near the poles. */
export function lngLatToTile(lat: number, lon: number, z: number): { x: number; y: number } {
	const n = 1 << z; // 2**z, exact for z <= 30
	const latClamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
	const latRad = (latClamped * Math.PI) / 180;
	const x = ((lon + 180) / 360) * n;
	const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
	return { x, y };
}

/** Integer tile + integer pixel-within-tile (0..255) + the fractional pixel
 *  position (0..256) for a lat/lon at zoom z. The fractional `fx`/`fy` drive
 *  bilinear sampling; `px`/`py` are the nearest pixel (a fallback). */
export function tilePixel(
	lat: number,
	lon: number,
	z: number,
): { tx: number; ty: number; px: number; py: number; fx: number; fy: number } {
	const { x, y } = lngLatToTile(lat, lon, z);
	const tx = Math.floor(x);
	const ty = Math.floor(y);
	const fx = (x - tx) * TILE_SIZE;
	const fy = (y - ty) * TILE_SIZE;
	const px = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(fx)));
	const py = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(fy)));
	return { tx, ty, px, py, fx, fy };
}


/** Bilinear blend of the four corner samples. wx/wy in [0,1] are the fractional
 *  position from the (x0,y0) corner toward (x1,y1):
 *  v00 = (x0,y0), v10 = (x1,y0), v01 = (x0,y1), v11 = (x1,y1). */
export function bilinear(
	v00: number,
	v10: number,
	v01: number,
	v11: number,
	wx: number,
	wy: number,
): number {
	const top = v00 + (v10 - v00) * wx;
	const bot = v01 + (v11 - v01) * wx;
	return top + (bot - top) * wy;
}

/** Metres -> feet (3.28084 ft/m, the conversion used elsewhere in the app). */
export function metresToFeet(m: number): number {
	return m * 3.28084;
}

// --- Capsule footprints -------------------------------------------------

/* A corridor answer is only as good as the pixels behind it, and the tiles
 * already hold about 4700 of them per 1 NM cell: sampling one point per cell
 * threw away 99.98 % of what was fetched, and with it the ridge between two
 * samples. These helpers fold EVERY pixel inside a capsule (the disc
 * SERA.5015(b) draws around the estimated position, swept along the leg) into
 * bins, so the extremes are exact at the DEM's own resolution.
 *
 * The frame is the app's existing flat one (M_PER_DEG scaled by the leg's
 * mid-latitude cosine), the same one legCorridorCells and
 * equirectangularDistanceM use, so a bin's distance and a nav-log distance are
 * the same number by construction rather than by two computations agreeing.
 * Both leg-frame coordinates are separable in (row, column), so a tile's inner
 * loop is two adds and a compare before it touches a pixel: measured 69 M
 * px/s, about 1 ms per tile, which is why reduceCapsule folds each tile AS IT
 * ARRIVES instead of gathering a raster (a diagonal route's bounding box is
 * hundreds of megabytes). */

/** A slippy-map tile address. */
export interface TileCoord {
	z: number;
	x: number;
	y: number;
}

/** One decoded tile handed to a reducer: three bands of metres, or one where
 *  the source has a single value per pixel (a level whose source was no finer
 *  than the output pixel). `max` and `min` are
 *  the extremes of everything the pixel covers; `NO_DATA` marks ground no
 *  source reached. */
export interface DecodedTile {
	z: number;
	tx: number;
	ty: number;
	mean: Int16Array;
	max: Int16Array;
	min: Int16Array;
}

/** A pixel no source covered, on every band. Matches internal/terrain NoData;
 *  a sentinel and not a low value, because a void that reads as an elevation
 *  is a void that reads as ground. */
export const NO_DATA = -32768;

/** Ground size of one tile edge at this latitude / zoom, metres (Web Mercator
 *  is locally isotropic, so one figure serves both axes). */
export function tileGroundM(lat: number, z: number): number {
	return (EARTH_CIRC_M * Math.cos((lat * Math.PI) / 180)) / (1 << z);
}

/** Latitude of the CENTRE of pixel row `row` of tile `ty` at zoom `z`; the
 *  exact inverse of lngLatToTile's y. */
export function tileRowLat(z: number, ty: number, row: number): number {
	const y = (ty + (row + 0.5) / TILE_SIZE) / (1 << z);
	return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/** Longitude of the CENTRE of pixel column `col` of tile `tx` at zoom `z`. */
export function tileColLon(z: number, tx: number, col: number): number {
	return ((tx + (col + 0.5) / TILE_SIZE) / (1 << z)) * 360 - 180;
}

/** Longitude difference wrapped into [-180, 180], so a leg either side of the
 *  antimeridian measures the short way (the equirectangularDistanceM guard:
 *  the in-range case stays bit-identical). */
function wrapLonDeg(d: number): number {
	if (d > 180 || d < -180) {
		return ((d + 540) % 360) - 180;
	}
	return d;
}

/** Latitude bounds of tile row `ty` at zoom `z` (north, south edges). */
export function tileLatBounds(z: number, ty: number): { north: number; south: number } {
	const n = 1 << z;
	const lat = (y: number): number => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
	return { north: lat(ty / n), south: lat((ty + 1) / n) };
}

/** Does segment a-b touch the lat/lon box? Liang-Barsky slab clip; the box is
 *  axis-aligned in lat/lon, which is the frame the app's legs are straight in. */
function segmentTouchesBox(
	aLat: number,
	aLon: number,
	bLat: number,
	bLon: number,
	minLat: number,
	maxLat: number,
	minLon: number,
	maxLon: number,
): boolean {
	let t0 = 0;
	let t1 = 1;
	const dLat = bLat - aLat;
	const dLon = bLon - aLon;
	// Keep the parameter range where p*t <= q holds; false once it empties.
	const clip = (p: number, q: number): boolean => {
		if (p === 0) {
			return q >= 0;
		}
		const r = q / p;
		if (p < 0) {
			if (r > t1) {
				return false;
			}
			if (r > t0) {
				t0 = r;
			}
		} else {
			if (r < t0) {
				return false;
			}
			if (r < t1) {
				t1 = r;
			}
		}
		return true;
	};
	return (
		clip(-dLon, aLon - minLon) &&
		clip(dLon, maxLon - aLon) &&
		clip(-dLat, aLat - minLat) &&
		clip(dLat, maxLat - aLat)
	);
}

/** Every z-tile the capsule of radius `radiusNM` about segment a-b touches:
 *  the tile's own box, grown by the radius, tested against the leg. Exact
 *  rather than generous (a lat/lon-padded box rounds the corners outward,
 *  which only ever adds a tile), x wraps, y clamps to the Mercator grid,
 *  deduped in a deterministic order.
 *
 *  ONE definition for two jobs: the offline pin stores this set
 *  (offline/terrainPin.ts) and reduceCapsule reads it, so what a plan pinned
 *  at the desk is exactly what the corridor asks for in the air. The pin's
 *  radius is the wider of the user's two corridor knobs, so it stays a
 *  superset of any single reduction. */
export function tilesCoveringCapsule(
	a: ProfilePoint,
	b: ProfilePoint,
	radiusNM: number,
	z: number = DEFAULT_TERRAIN_ZOOM,
): TileCoord[] {
	const n = 1 << z;
	const radiusM = Math.max(0, radiusNM) * NM_TO_METERS;
	const cosLat = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)) || 1;
	const padLat = radiusM / M_PER_DEG;
	const padLon = radiusM / (M_PER_DEG * cosLat);
	// Measure the leg the short way round; x is wrapped back into the grid
	// when a tile is emitted, so the window may sit outside [0, n).
	const bLon = a.lon + wrapLonDeg(b.lon - a.lon);
	const north = Math.min(MERCATOR_MAX_LAT, Math.max(a.lat, b.lat) + padLat);
	const south = Math.max(-MERCATOR_MAX_LAT, Math.min(a.lat, b.lat) - padLat);
	const nw = lngLatToTile(north, Math.min(a.lon, bLon) - padLon, z);
	const se = lngLatToTile(south, Math.max(a.lon, bLon) + padLon, z);
	const y0 = Math.max(0, Math.floor(nw.y));
	const y1 = Math.min(n - 1, Math.floor(se.y));
	const seen = new Set<string>();
	const out: TileCoord[] = [];
	for (let ty = y0; ty <= y1; ty++) {
		const bounds = tileLatBounds(z, ty);
		for (let tx = Math.floor(nw.x); tx <= Math.floor(se.x); tx++) {
			const west = (tx / n) * 360 - 180;
			const east = ((tx + 1) / n) * 360 - 180;
			if (
				!segmentTouchesBox(
					a.lat,
					a.lon,
					b.lat,
					bLon,
					bounds.south - padLat,
					bounds.north + padLat,
					west - padLon,
					east + padLon,
				)
			) {
				continue;
			}
			const x = ((tx % n) + n) % n;
			const key = `${x}/${ty}`;
			if (!seen.has(key)) {
				seen.add(key);
				out.push({ z, x, y: ty });
			}
		}
	}
	return out;
}

/** The metric frame of one capsule reduction: the leg's flat-earth axes plus
 *  the bin grid pixels fold into. Bin (i, c) is centred at along = i *
 *  alongBinM, cross = c * crossBinM; `i` runs [alongMin, alongMax] (negative
 *  and past the end inside the caps) and `c` runs [-crossMax, crossMax]. */
export interface CapsuleFrame {
	aLat: number;
	aLon: number;
	/** Unit vector along the leg in the flat, cosLat-scaled metric frame. */
	ux: number;
	uy: number;
	/** Longitude scale at the leg's mid-latitude. */
	cosLat: number;
	legM: number;
	halfWidthM: number;
	alongBinM: number;
	crossBinM: number;
	alongMin: number;
	alongMax: number;
	crossMax: number;
}

/** How a caller wants a capsule binned. `alongBins` is the number of bins
 *  along the leg, so bin i sits at i * legM / alongBins (bin 0 on the first
 *  waypoint, bin alongBins on the second); `crossMax` 0 means one lane. */
export interface CapsuleOpts {
	/** Corridor half-width in metres, or `'track'` for the strip of pixels
	 *  the track itself crosses. The strip cannot be given a width in
	 *  metres by its caller, because the width that makes it a strip (half a
	 *  pixel diagonal, the lattice's covering radius, so every point of the
	 *  track has a pixel) is a property of the LEVEL actually read, and the
	 *  level is chosen here. A caller that guesses it against the wrong
	 *  level admits no pixel at all and hands back a band that has silently
	 *  collapsed to the point value it was meant to widen. */
	halfWidthM: number | 'track';
	alongBins: number;
	crossBinM?: number | undefined;
	crossMax?: number | undefined;
	/** Force a level instead of picking one: the offline pin, which must
	 *  enumerate exactly what a reduction will ask for, and the tests. */
	z?: number | undefined;
}

/** Build the frame for one leg. Pure. */
export function capsuleFrame(
	a: ProfilePoint,
	b: ProfilePoint,
	opts: CapsuleOpts & { halfWidthM: number },
): CapsuleFrame {
	const cosLat = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)) || 1;
	const vx = wrapLonDeg(b.lon - a.lon) * cosLat * M_PER_DEG;
	const vy = (b.lat - a.lat) * M_PER_DEG;
	const legM = Math.hypot(vx, vy);
	// A degenerate leg still has a capsule (the disc about the point); any
	// axis will do for it.
	const ux = legM > 0 ? vx / legM : 1;
	const uy = legM > 0 ? vy / legM : 0;
	const alongBins = Math.max(1, Math.round(opts.alongBins));
	const alongBinM = legM > 0 ? legM / alongBins : Math.max(1, opts.halfWidthM);
	// The caps reach halfWidth beyond each end, so the bin range does too.
	const nCap = Math.ceil(opts.halfWidthM / alongBinM);
	return {
		aLat: a.lat,
		aLon: a.lon,
		ux,
		uy,
		cosLat,
		legM,
		halfWidthM: opts.halfWidthM,
		alongBinM,
		crossBinM: opts.crossBinM ?? Math.max(1, opts.halfWidthM),
		alongMin: -nCap,
		alongMax: alongBins + nCap,
		crossMax: opts.crossMax ?? 0,
	};
}

/** Ground extremes per bin, in METRES. An empty bin keeps its sentinel
 *  (-Infinity / Infinity), which `binMax` / `binMin` report as null. */
export interface CapsuleBins {
	max: Float64Array;
	min: Float64Array;
	alongMin: number;
	alongCount: number;
	crossMax: number;
	crossCount: number;
}

/** Empty bins for a frame. Pure. */
export function makeCapsuleBins(f: CapsuleFrame): CapsuleBins {
	const alongCount = f.alongMax - f.alongMin + 1;
	const crossCount = 2 * f.crossMax + 1;
	const n = alongCount * crossCount;
	const max = new Float64Array(n).fill(-Infinity);
	const min = new Float64Array(n).fill(Infinity);
	return { max, min, alongMin: f.alongMin, alongCount, crossMax: f.crossMax, crossCount };
}

function binSlot(bins: CapsuleBins, alongIdx: number, crossIdx: number): number {
	const ai = alongIdx - bins.alongMin;
	const ci = crossIdx + bins.crossMax;
	if (ai < 0 || ai >= bins.alongCount || ci < 0 || ci >= bins.crossCount) {
		return -1;
	}
	return ai * bins.crossCount + ci;
}

/** Highest ground in a bin, METRES, or null when no pixel landed in it. */
export function binMax(bins: CapsuleBins, alongIdx: number, crossIdx = 0): number | null {
	const k = binSlot(bins, alongIdx, crossIdx);
	return k < 0 || bins.max[k] === -Infinity ? null : bins.max[k];
}

/** Lowest ground in a bin, METRES, or null when no pixel landed in it. */
export function binMin(bins: CapsuleBins, alongIdx: number, crossIdx = 0): number | null {
	const k = binSlot(bins, alongIdx, crossIdx);
	return k < 0 || bins.min[k] === Infinity ? null : bins.min[k];
}

/** Fold one decoded tile's pixels into a capsule's bins: pixel centres inside
 *  the capsule only, no-data skipped. Each pixel contributes its own band to
 *  its own bin, so a POOLED tile's extremes carry through: a coarse tile's
 *  max is the max of everything beneath it, which is what lets a corridor be
 *  answered from a handful of coarse tiles instead of hundreds of fine ones.
 *  Pure over its inputs (it writes into the caller's bins). */
export function reduceTileIntoCapsule(
	tile: DecodedTile,
	f: CapsuleFrame,
	bins: CapsuleBins,
): void {
	// Separable leg-frame coordinates: one term per column, one per row, so
	// the inner loop adds two numbers instead of projecting a point.
	const alongCol = new Float64Array(TILE_SIZE);
	const crossCol = new Float64Array(TILE_SIZE);
	const alongRow = new Float64Array(TILE_SIZE);
	const crossRow = new Float64Array(TILE_SIZE);
	for (let i = 0; i < TILE_SIZE; i++) {
		const wx = wrapLonDeg(tileColLon(tile.z, tile.tx, i) - f.aLon) * f.cosLat * M_PER_DEG;
		alongCol[i] = wx * f.ux;
		crossCol[i] = -wx * f.uy;
	}
	for (let j = 0; j < TILE_SIZE; j++) {
		const wy = (tileRowLat(tile.z, tile.ty, j) - f.aLat) * M_PER_DEG;
		alongRow[j] = wy * f.uy;
		crossRow[j] = wy * f.ux;
	}
	const hw = f.halfWidthM;
	const hw2 = hw * hw;
	const single = f.crossMax === 0;
	for (let j = 0; j < TILE_SIZE; j++) {
		const ar = alongRow[j];
		const cr = crossRow[j];
		const rowOff = j * TILE_SIZE;
		for (let i = 0; i < TILE_SIZE; i++) {
			const cross = crossCol[i] + cr;
			if (cross > hw || cross < -hw) {
				continue;
			}
			const along = alongCol[i] + ar;
			if (along < -hw || along > f.legM + hw) {
				continue;
			}
			if (along < 0 || along > f.legM) {
				// In a cap: the round end of the capsule, not a corner.
				const da = along < 0 ? along : along - f.legM;
				if (da * da + cross * cross > hw2) {
					continue;
				}
			}
			const o = rowOff + i;
			const hi = tile.max[o];
			if (hi === NO_DATA) {
				continue; // a void is unknown, and unknown is not an elevation
			}
			const lo = tile.min[o];
			let ai = Math.round(along / f.alongBinM);
			if (ai < f.alongMin) {
				ai = f.alongMin;
			} else if (ai > f.alongMax) {
				ai = f.alongMax;
			}
			let ci = single ? 0 : Math.round(cross / f.crossBinM);
			if (ci < -f.crossMax) {
				ci = -f.crossMax;
			} else if (ci > f.crossMax) {
				ci = f.crossMax;
			}
			const k = (ai - bins.alongMin) * bins.crossCount + (ci + bins.crossMax);
			if (hi > bins.max[k]) {
				bins.max[k] = hi;
			}
			if (lo < bins.min[k]) {
				bins.min[k] = lo;
			}
		}
	}
}

// --- The tiers in force ------------------------------------------------

/** One tier of the mosaic, as the manifest states it: what an About credit
 *  prints and what tells a bare-earth tier from a surface one. */
export interface TerrainRegion {
	id: string;
	label: string;
	native: number;
	/** 'DTM' bare earth, 'DSM' a surface model whose three bands all describe
	 *  the same surface (canopy and buildings included). */
	datum: string;
	vertical: string;
	licence: string;
	/** VERBATIM what the licence demands be shown. */
	attribution: string;
	bounds: [number, number, number, number];
}

let regionList: TerrainRegion[] = [];

/** The tiers in force, for the About modal's credits. */
export function terrainRegions(): TerrainRegion[] {
	return regionList;
}

let manifestRead: Promise<void> | null = null;

/** Read the manifest once: the tiers, for the About credits, and the level
 *  range the mosaic publishes.
 *
 *  It REFINES what the module already knows rather than deciding it. The
 *  built-in range covers what is deployed, so a manifest that is absent,
 *  unreadable or malformed costs the credits and never the ground; publishing
 *  a deeper national tier then needs no code change to be read. Terrain
 *  decides minimum safe altitudes, the AGL an airspace alert is graded on and
 *  the ground drawn under the aircraft, and none of that may rest on one more
 *  JSON fetch succeeding. */
export function ensureTerrainRegions(): Promise<void> {
	if (!manifestRead) {
		manifestRead = loadTerrainManifest();
	}
	return manifestRead;
}

async function loadTerrainManifest(): Promise<void> {
	try {
		const res = await fetch('/data/terrain.json');
		if (!res.ok) {
			return;
		}
		const doc: unknown = await res.json();
		if (typeof doc !== 'object' || doc === null) {
			return;
		}
		const d = doc as Partial<{
			deepest: number;
			coarsest: number;
			regions: TerrainRegion[];
		}>;
		if (typeof d.deepest !== 'number' || typeof d.coarsest !== 'number') {
			return;
		}
		if (d.coarsest > d.deepest || d.deepest > 20 || d.coarsest < 0) {
			return;
		}
		regionList = Array.isArray(d.regions) ? d.regions : [];
		setTerrainLevels({ deepest: d.deepest, coarsest: d.coarsest });
	} catch {
		// Keep the built-in range: no manifest is a fact about the deployment,
		// not an error to surface, and the ground is still readable without it.
	}
}

/** The URL one tile is read from. Exported for the terrain-pin prefetch
 *  (state/offlineTerrain.svelte.ts), which must pin the EXACT urls this
 *  module will read back. */
export function tileUrl(z: number, x: number, y: number): string {
	// The dev-server escape the chart layers already have, so a local build of
	// the mosaic can be driven without deploying it.
	const base = (import.meta.env.VITE_TERRAIN_TILES_URL as string | undefined) ?? CHART_WORKER;
	return `${base}/terrain/${z}/${x}/${y}`;
}

/* Per-(z/x/y) decoded tile, or null when it failed to load. The Promise is
 * cached before it resolves so concurrent samplers on one tile share a single
 * fetch, and a settled null is cached so a repeated miss doesn't re-hit the
 * network, which is also what makes the level fallback cheap: a point off the
 * edge of a national tier probes its deepest level once, ever. (Plain .ts:
 * the svelte/prefer-svelte-reactivity rule doesn't apply, so a plain Map is
 * fine.) */
const tileCache = new Map<string, Promise<DecodedTile | null>>();

/* The same tiles under the same keys, recorded AS EACH LOAD SETTLES: what a
 * SYNCHRONOUS reader can answer from. tileCache holds promises, and a promise
 * cannot be read without a microtask, so the cursor readout, which answers
 * inside the mousemove's own frame beside stationNear and windBarbNear, needs
 * the value sitting beside the promise. Absent = nothing has settled yet;
 * null = the load settled as a miss. Cleared with tileCache, same lifetime. */
const settledTiles = new Map<string, DecodedTile | null>();

/* Cap simultaneous tile fetches (a profile can want dozens at once); roughly a
 * browser's per-host socket budget. Dedupe is already handled by tileCache. */
const MAX_CONCURRENT = 6;
let inFlight = 0;
const waiters: (() => void)[] = [];
async function runLimited<T>(fn: () => Promise<T>): Promise<T> {
	if (inFlight >= MAX_CONCURRENT) {
		await new Promise<void>((resolve) => waiters.push(resolve));
	}
	inFlight++;
	try {
		return await fn();
	} finally {
		inFlight--;
		waiters.shift()?.();
	}
}


async function loadTile(z: number, x: number, y: number): Promise<DecodedTile | null> {
	try {
		// passiveFetchBlob = the Android shell's offline cache in front of the
		// fetch; a plain fetch on the web (the service worker caches there).
		const blob = await runLimited(() => passiveFetchBlob(tileUrl(z, x, y)));
		if (!blob) {
			return null;
		}
		const tile = await decodeTerrainTile(await blob.arrayBuffer());
		if (!tile) {
			return null;
		}
		// The address is in the tile, so a misrouted object is a miss rather
		// than terrain in the wrong place.
		if (tile.z !== z || tile.x !== x || tile.y !== y) {
			return null;
		}
		return {
			z, tx: x, ty: y,
			mean: tile.mean,
			max: tile.max ?? tile.mean,
			min: tile.min ?? tile.mean,
		};
	} catch {
		return null; // network / decode error -> caller renders "no data"
	}
}

/** The cache key for a tile address and the wrapped x it names, or null above
 *  / below the Mercator limit where no tile exists. Pure, and the ONE
 *  definition getTile and peekTile share, so a peek cannot look under a key
 *  the loader never writes. */
function tileKey(z: number, x: number, y: number): { key: string; x: number } | null {
	const n = 1 << z;
	if (y < 0 || y >= n) {
		return null;
	}
	const wx = ((x % n) + n) % n; // wrap longitude across the antimeridian
	return { key: `${z}/${wx}/${y}`, x: wx };
}

async function getTile(z: number, x: number, y: number): Promise<DecodedTile | null> {
	// Which source is in force decides the URL AND the cache key, so it is
	// resolved before either: a tile keyed under one source and fetched from
	// the other would be a hit that never matched.
	await ensureTerrainRegions();
	const addr = tileKey(z, x, y);
	if (!addr) {
		return null; // above / below the Mercator limit: no tile
	}
	let p = tileCache.get(addr.key);
	if (!p) {
		p = loadTile(z, addr.x, y);
		tileCache.set(addr.key, p);
		// Record the settled value beside the promise, for peekTile. Only
		// while this load is still the cache's own: setTerrainLevels can
		// clear both maps while a fetch is in flight, and a settle landing
		// after that would put back an entry the promise cache no longer
		// has, which is exactly the lockstep the clear is there to keep.
		const settling = p;
		void p.then((tile) => {
			if (tileCache.get(addr.key) === settling) {
				settledTiles.set(addr.key, tile);
			}
		});
	}
	return p;
}

/** The decoded tile at z/x/y IF IT IS ALREADY IN HAND: `undefined` when
 *  nothing has settled for it (ask getTile), `null` when the load settled as
 *  a miss or the address is off the Mercator grid. Never fetches, never
 *  awaits, never decodes: a plain Map lookup a pointer-move handler can
 *  afford at frame rate. */
export function peekTile(z: number, x: number, y: number): DecodedTile | null | undefined {
	const addr = tileKey(z, x, y);
	if (!addr) {
		return null; // the same definite answer getTile gives there
	}
	return settledTiles.get(addr.key);
}

/** Fetch and decode `tiles` through the shared cache and concurrency cap,
 *  handing each to `visit` AS IT ARRIVES. Streaming is the point: a corridor
 *  wants hundreds of tiles, and folding each on arrival spreads about 1 ms of
 *  reduction per tile across the fetches instead of building one long task at
 *  the end. Missing tiles are counted, not silently skipped, so a caller can
 *  say "no data" rather than answer from a hole. */
export async function visitTiles(
	tiles: readonly TileCoord[],
	visit: (tile: DecodedTile) => void,
	signal?: AbortSignal,
): Promise<{ visited: number; missing: number }> {
	let visited = 0;
	let missing = 0;
	await Promise.all(
		tiles.map(async (t) => {
			const tile = await getTile(t.z, t.x, t.y);
			if (signal?.aborted) {
				return;
			}
			if (!tile) {
				missing++;
				return;
			}
			visit(tile);
			visited++;
		}),
	);
	return { visited, missing };
}

/** The result of one leg's capsule reduction: the frame it was binned in, the
 *  bins themselves, the LEVEL it was answered at, and how many of its tiles
 *  never arrived (which a caller must treat as "unknown" and not as the
 *  extremes of the tiles that did). */
export interface CapsuleGround {
	frame: CapsuleFrame;
	bins: CapsuleBins;
	z: number;
	tiles: number;
	missing: number;
}

/** Fold every terrain pixel inside the capsule about segment a-b into bins.
 *  The tiles are the ones `tilesCoveringCapsule` names, i.e. the ones the
 *  offline pin already holds; nothing else is fetched. */
export async function reduceCapsule(
	a: ProfilePoint,
	b: ProfilePoint,
	opts: CapsuleOpts,
	signal?: AbortSignal,
): Promise<CapsuleGround> {
	const midLat = (a.lat + b.lat) / 2;
	const track = opts.halfWidthM === 'track';
	// The level first, because the strip's own width comes from it. A
	// corridor takes the coarsest level its bins can still be filled from;
	// the strip is a point query in disguise and takes the deepest.
	const legM = equirectangularDistanceM(a.lat, a.lon, b.lat, b.lon);
	const alongBinM = legM > 0 ? legM / Math.max(1, opts.alongBins) : 0;
	const binM = Math.min(alongBinM || Infinity, opts.crossBinM ?? Infinity);
	const z =
		opts.z ??
		(track || !Number.isFinite(binM) ? terrainLevels().deepest : pickLevel(binM, midLat));
	const pixelM = tileGroundM(midLat, z) / TILE_SIZE;
	const halfWidthM =
		opts.halfWidthM === 'track' ? (pixelM * Math.SQRT2) / 2 : opts.halfWidthM;
	const frame = capsuleFrame(a, b, { ...opts, halfWidthM });
	const bins = makeCapsuleBins(frame);
	const tiles = tilesCoveringCapsule(a, b, halfWidthM / NM_TO_METERS, z);
	const { visited, missing } = await visitTiles(
		tiles,
		(tile) => {
			reduceTileIntoCapsule(tile, frame, bins);
		},
		signal,
	);
	return { frame, bins, z, tiles: visited, missing };
}

/* The three pure pieces of a point read. They exist so the async reader and
 * the synchronous peek below cannot drift: the two differ ONLY in how they
 * get hold of a tile, and share which tile they ask for, which pixel they
 * read out of it and how the four corners blend. */

/** The tile and the in-tile pixel for a pixel index possibly outside [0,255],
 *  following across the tile border. Pure. */
function pixelAddress(
	tx: number,
	ty: number,
	px: number,
	py: number,
): { x: number; y: number; ix: number; iy: number } {
	let x = tx;
	let y = ty;
	let ix = px;
	let iy = py;
	if (ix < 0) {
		x -= 1;
		ix += TILE_SIZE;
	} else if (ix >= TILE_SIZE) {
		x += 1;
		ix -= TILE_SIZE;
	}
	if (iy < 0) {
		y -= 1;
		iy += TILE_SIZE;
	} else if (iy >= TILE_SIZE) {
		y += 1;
		iy -= TILE_SIZE;
	}
	return { x, y, ix, iy };
}

/** One pixel's metres off a decoded tile: the mean band, with the void
 *  sentinel read as "no data" rather than as ground. Pure. */
function tilePixelMetres(tile: DecodedTile, ix: number, iy: number): number | null {
	const v = tile.mean[iy * TILE_SIZE + ix];
	return v === NO_DATA ? null : v;
}

/** The geometry of one bilinear sample: the tile, the NEAREST pixel (the seam
 *  fallback) and the top-left corner with the two fractional weights. Pure. */
function sampleCorners(
	lat: number,
	lon: number,
	z: number,
): { tx: number; ty: number; px: number; py: number; x0: number; y0: number; wx: number; wy: number } {
	const { tx, ty, px, py, fx, fy } = tilePixel(lat, lon, z);
	// Reference each pixel value at its centre: shift by -0.5 so an integer fx
	// lands exactly between two pixels and the weights are symmetric.
	const sx = fx - 0.5;
	const sy = fy - 0.5;
	const x0 = Math.floor(sx);
	const y0 = Math.floor(sy);
	return { tx, ty, px, py, x0, y0, wx: sx - x0, wy: sy - y0 };
}

/** The blend of the four corner reads, or null when any corner is missing,
 *  which is the caller's cue to fall back to the nearest pixel (a seam at the
 *  edge of coverage). The blend of four numbers is never null, so the signal
 *  is unambiguous. Pure. */
function blendCorners(
	v00: number | null,
	v10: number | null,
	v01: number | null,
	v11: number | null,
	wx: number,
	wy: number,
): number | null {
	if (v00 == null || v10 == null || v01 == null || v11 == null) {
		return null;
	}
	return bilinear(v00, v10, v01, v11, wx, wy);
}

/** Decoded metres at integer pixel (px,py) of tile (z,tx,ty), following across
 *  tile borders when px/py land outside [0,255]. Null if the needed tile is
 *  missing. */
async function pixelMetres(
	z: number,
	tx: number,
	ty: number,
	px: number,
	py: number,
): Promise<number | null> {
	const { x, y, ix, iy } = pixelAddress(tx, ty, px, py);
	const tile = await getTile(z, x, y);
	return tile ? tilePixelMetres(tile, ix, iy) : null;
}

/** The same read off an ALREADY DECODED tile: `undefined` when that tile has
 *  not settled, so the caller knows to ask asynchronously rather than to
 *  treat a pending tile as a hole. */
function peekPixelMetres(
	z: number,
	tx: number,
	ty: number,
	px: number,
	py: number,
): number | null | undefined {
	const { x, y, ix, iy } = pixelAddress(tx, ty, px, py);
	const tile = peekTile(z, x, y);
	if (tile === undefined) {
		return undefined;
	}
	return tile ? tilePixelMetres(tile, ix, iy) : null;
}

/** Ground elevation in metres at (lat, lon), bilinearly interpolated.
 *
 *  With no level pinned it reads the DEEPEST the source publishes and falls
 *  back a level at a time, because national coverage is not rectangular: the
 *  deepest level exists over France and not over the Bay of Biscay, the
 *  Rhine or the far side of a border, and a single-level read would answer
 *  "no data" there rather than from the tier underneath. `getTile` caches the
 *  settled null, so each miss costs one request ever.
 *
 *  Null when nothing answered or the source has no data there. */
export async function elevationAt(
	lat: number,
	lon: number,
	z?: number,
): Promise<number | null> {
	if (z !== undefined) {
		return elevationAtLevel(lat, lon, z);
	}
	const { deepest, coarsest } = terrainLevels();
	for (let level = deepest; level >= coarsest; level--) {
		const v = await elevationAtLevel(lat, lon, level);
		if (v !== null) {
			return v;
		}
	}
	return null;
}

async function elevationAtLevel(
	lat: number,
	lon: number,
	z: number,
): Promise<number | null> {
	const c = sampleCorners(lat, lon, z);
	const [v00, v10, v01, v11] = await Promise.all([
		pixelMetres(z, c.tx, c.ty, c.x0, c.y0),
		pixelMetres(z, c.tx, c.ty, c.x0 + 1, c.y0),
		pixelMetres(z, c.tx, c.ty, c.x0, c.y0 + 1),
		pixelMetres(z, c.tx, c.ty, c.x0 + 1, c.y0 + 1),
	]);
	const blend = blendCorners(v00, v10, v01, v11, c.wx, c.wy);
	// A neighbour tile is missing (seam): fall back to nearest-pixel rather
	// than dropping the whole sample.
	return blend ?? (await pixelMetres(z, c.tx, c.ty, c.px, c.py));
}

/** Single-point ground elevation in feet, or null on tile failure. Convenience
 *  over elevationAt for the vertical-profile ground line. */
export async function elevationFtAt(lat: number, lon: number): Promise<number | null> {
	const m = await elevationAt(lat, lon);
	return m == null ? null : metresToFeet(m);
}

/** What elevationAt would answer, FROM WHAT IS ALREADY DECODED: a number,
 *  `null` where the source states no data, `undefined` where a tile the
 *  answer needs has not settled.
 *
 *  It walks the same level ladder, samples the same pixels and blends them
 *  the same way, so it answers exactly what elevationAt would or nothing at
 *  all: the first level whose tiles are not all in hand stops the walk,
 *  rather than falling through to a coarser one. That matters, because a
 *  coarse level carries the POOLED MEAN of everything beneath it, and a
 *  readout must not print an average over a kilometre where the point value
 *  is one fetch away.
 *
 *  Zero network, zero microtasks: a handful of Map lookups, cheap enough for
 *  a pointer-move handler to call at frame rate. */
export function peekElevationAt(
	lat: number,
	lon: number,
	z?: number,
): number | null | undefined {
	if (z !== undefined) {
		return peekElevationAtLevel(lat, lon, z);
	}
	const { deepest, coarsest } = terrainLevels();
	for (let level = deepest; level >= coarsest; level--) {
		const v = peekElevationAtLevel(lat, lon, level);
		if (v !== null) {
			return v; // a number, or undefined: either way the walk stops here
		}
	}
	return null;
}

function peekElevationAtLevel(
	lat: number,
	lon: number,
	z: number,
): number | null | undefined {
	const c = sampleCorners(lat, lon, z);
	const v00 = peekPixelMetres(z, c.tx, c.ty, c.x0, c.y0);
	const v10 = peekPixelMetres(z, c.tx, c.ty, c.x0 + 1, c.y0);
	const v01 = peekPixelMetres(z, c.tx, c.ty, c.x0, c.y0 + 1);
	const v11 = peekPixelMetres(z, c.tx, c.ty, c.x0 + 1, c.y0 + 1);
	if (v00 === undefined || v10 === undefined || v01 === undefined || v11 === undefined) {
		return undefined; // a corner is still in flight: this level cannot answer
	}
	const blend = blendCorners(v00, v10, v01, v11, c.wx, c.wy);
	return blend ?? peekPixelMetres(z, c.tx, c.ty, c.px, c.py);
}

/** peekElevationAt in feet, the synchronous twin of elevationFtAt. */
export function peekElevationFtAt(lat: number, lon: number): number | null | undefined {
	const m = peekElevationAt(lat, lon);
	return m == null ? m : metresToFeet(m);
}

// --- Along-route profile sampler ----------------------------------------

export interface ProfilePoint {
	lat: number;
	lon: number;
}

export interface TerrainSample {
	/** Cumulative distance (NM) from the first point. */
	distNM: number;
	/** Ground elevation in feet under the sample itself (bilinear), or null
	 *  when the tile failed to load. */
	elevFt: number | null;
	/** Lowest ground in the strip under the TRACK for this sample's own
	 *  along-track cell, at the DEM's resolution. An AGL floor resolves
	 *  against this one: the lower the ground, the lower the floor, and a
	 *  zone is never hidden by a ridge the aircraft did not fly over. */
	minFt?: number | null;
	/** Highest ground in that same strip. An AGL ceiling resolves against
	 *  this one, and the drawn ground line follows it: one scalar cannot be
	 *  conservative for both edges of a band. */
	maxFt?: number | null;
}

/** Ground for an AGL FLOOR at a sample: the lowest in its footprint. Falls
 *  back to the point value for a hand-built sample that carries no band. */
export function sampleFloorFt(s: TerrainSample): number | null {
	return s.minFt ?? s.elevFt;
}

/** Ground for an AGL CEILING at a sample, and for the drawn terrain line: the
 *  highest in its footprint, point value for a hand-built sample. */
export function sampleCeilingFt(s: TerrainSample): number | null {
	return s.maxFt ?? s.elevFt;
}

export interface SampleProfileOpts {
	/** Terrain tile zoom; default DEFAULT_TERRAIN_ZOOM. */
	zoom?: number;
	/** Target along-route step in NM; widened so totalNM/step <= maxSamples. */
	stepNM?: number;
	/** Hard cap on samples (one-shot fetch budget). Default 600. */
	maxSamples?: number;
	/** Aborts an in-flight run when the caller's effect re-runs. */
	signal?: AbortSignal;
}

const PROFILE_STEP_NM = 1;
const PROFILE_MAX_SAMPLES = 600;

/** Sample ground elevation along a multi-leg route. Walks each leg at a fixed
 *  NM step (widened so the total stays under maxSamples; each sample is a tile
 *  read, not a cheap test), interpolating lat/lon linearly and accumulating
 *  distance with the same equirectangular metric the rest of the route code
 *  uses, so the X axis lines up with the nav-log cumNM and the airspace spans.
 *  Elevations come from elevationAt (tile-cached, concurrency-capped); null
 *  marks a tile that failed (a genuine gap, distinct from sea/void -> 0). */
export async function sampleProfile(
	points: ProfilePoint[],
	opts: SampleProfileOpts = {},
): Promise<TerrainSample[]> {
	if (points.length < 2) {
		return [];
	}
	const zoom = opts.zoom ?? DEFAULT_TERRAIN_ZOOM;
	const maxSamples = opts.maxSamples ?? PROFILE_MAX_SAMPLES;

	const legNM: number[] = [];
	let totalNM = 0;
	for (let i = 0; i + 1 < points.length; i++) {
		const d =
			equirectangularDistanceM(
				points[i].lat,
				points[i].lon,
				points[i + 1].lat,
				points[i + 1].lon,
			) / NM_TO_METERS;
		legNM.push(d);
		totalNM += d;
	}
	if (totalNM <= 0) {
		const m = await elevationAt(points[0].lat, points[0].lon, zoom);
		const ft = m == null ? null : metresToFeet(m);
		return [{ distNM: 0, elevFt: ft, minFt: ft, maxFt: ft }];
	}

	const baseStep = opts.stepNM ?? PROFILE_STEP_NM;
	const stepNM = Math.max(baseStep, totalNM / maxSamples);
	if (stepNM > baseStep) {
		// No silent cap: a very long route is thinned to maxSamples points.
		console.info(
			`sampleProfile: ${Math.round(totalNM)} NM route thinned to ~${maxSamples} samples (${stepNM.toFixed(1)} NM step)`,
		);
	}

	// Same interior-point sampling as computeAirspaceSchedule: each leg emits
	// its start + (seg-1) interiors (the leg end is the next leg's start), then
	// the final endpoint is pushed once -> distances match the airspace spans.
	const sampled: { lat: number; lon: number; distNM: number }[] = [];
	const segs: number[] = [];
	let cumBase = 0;
	for (let i = 0; i + 1 < points.length; i++) {
		const a = points[i];
		const b = points[i + 1];
		const d = legNM[i];
		const seg = Math.max(1, Math.ceil(d / stepNM));
		segs.push(seg);
		for (let k = 0; k < seg; k++) {
			const f = k / seg;
			sampled.push({
				lat: a.lat + (b.lat - a.lat) * f,
				lon: a.lon + (b.lon - a.lon) * f,
				distNM: cumBase + d * f,
			});
		}
		cumBase += d;
	}
	const last = points[points.length - 1];
	sampled.push({ lat: last.lat, lon: last.lon, distNM: totalNM });

	if (opts.signal?.aborted) {
		return [];
	}
	// The point under each sample, and the STRIP of pixels the track actually
	// crosses between one sample and the next: `'track'` sizes that strip from
	// the level the reduction reads, the lattice's covering radius, so every
	// point of the track has a pixel. It answers "the ground under this leg"
	// honestly rather than every 1 NM, which is what let a ridge crossing read
	// 985 ft low on an Alpine leg.
	const [elevs, strips] = await Promise.all([
		Promise.all(sampled.map((p) => elevationAt(p.lat, p.lon, zoom))),
		Promise.all(
			points.slice(0, -1).map((a, i) =>
				reduceCapsule(
					a,
					points[i + 1],
					{ halfWidthM: 'track', alongBins: segs[i], crossMax: 0, z: opts.zoom },
					opts.signal,
				),
			),
		),
	]);
	if (opts.signal?.aborted) {
		return [];
	}
	const out: TerrainSample[] = sampled.map((p, i) => {
		const m = elevs[i];
		const ft = m == null ? null : metresToFeet(m);
		return { distNM: p.distNM, elevFt: ft, minFt: ft, maxFt: ft };
	});
	// Bin k of leg i is the sample at that station; its bin `seg` is the next
	// leg's first sample (or the final endpoint), so a waypoint's band covers
	// the half-cell on each side of it.
	let base = 0;
	for (let i = 0; i < strips.length; i++) {
		const { bins } = strips[i];
		for (let k = 0; k <= segs[i]; k++) {
			const t = out[base + k];
			if (!t) {
				break;
			}
			const lo = binMin(bins, k);
			const hi = binMax(bins, k);
			if (lo != null) {
				const loFt = metresToFeet(lo);
				t.minFt = t.minFt == null ? loFt : Math.min(t.minFt, loFt);
			}
			if (hi != null) {
				const hiFt = metresToFeet(hi);
				t.maxFt = t.maxFt == null ? hiFt : Math.max(t.maxFt, hiFt);
			}
		}
		base += segs[i];
	}
	return out;
}

/** Minimum ground elevation (ft) per leg from a route's centerline samples.
 *  Leg i spans [legCumNM[i-1], legCumNM[i]] (closed: a sample sitting exactly
 *  on the shared boundary lies on both legs' centerlines and counts for both);
 *  sampleProfile accumulates distance with the same per-leg partial sums as
 *  computeNavLog, so the spans match exactly. Each sample contributes the
 *  LOWEST ground in its own footprint (`sampleFloorFt`), which is the
 *  direction the applicability floor is conservative in: a valley between two
 *  sample points used to raise the floor and stop the rule binding. A leg with
 *  any failed sample or no sample at all yields null: unknown, which the
 *  semicircular applicability floor treats as sea level (conservative). */
export function minGroundPerLeg(
	samples: TerrainSample[],
	legCumNM: number[],
): (number | null)[] {
	const eps = 1e-6;
	const out: (number | null)[] = [];
	let start = 0;
	let lo = 0;
	for (const hi of legCumNM) {
		// Step back over the shared boundary sample consumed by the previous leg.
		while (start > 0 && samples[start - 1].distNM >= lo - eps) {
			start--;
		}
		while (start < samples.length && samples[start].distNM < lo - eps) {
			start++;
		}
		let min: number | null = null;
		let seen = false;
		let gap = false;
		let j = start;
		for (; j < samples.length && samples[j].distNM <= hi + eps; j++) {
			seen = true;
			const e = sampleFloorFt(samples[j]);
			if (e == null) {
				gap = true;
			} else if (min == null || e < min) {
				min = e;
			}
		}
		out.push(seen && !gap ? min : null);
		start = j;
		lo = hi;
	}
	return out;
}
