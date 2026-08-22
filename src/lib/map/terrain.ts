/* Ground-terrain elevation by sampling AWS "Terrarium" terrain-RGB PNG tiles.
 *
 * Terrarium tiles (https://registry.opendata.aws/terrain-tiles) encode ground
 * elevation in metres as RGB: elev = R*256 + G + B/256 - 32768. They use the
 * standard Web-Mercator slippy scheme ({z}/{x}/{y}, y southward), identical to
 * the Leaflet base layers, so the projection here is the canonical OSM formula.
 *
 * The S3 bucket sends no CORS header, so a browser canvas reading those pixels
 * would taint; we fetch through the notam-proxy Cloudflare Worker (same proxy
 * the autorouter client uses), which adds Access-Control-Allow-Origin. Hence
 * the `/tiles/terrarium/...` path below is served by that Worker, not S3.
 *
 * Pure (lngLatToTile / tilePixel / decodeTerrarium / bilinear / metresToFeet)
 * are Vitest-tested in tests/terrain.spec.ts; the fetch/canvas path needs a
 * browser and is exercised manually. Plain .ts: the module-level Map tile cache
 * is intentionally non-reactive (svelte/prefer-svelte-reactivity only fires in
 * .svelte / .svelte.ts). */

import { proxyBase } from '$lib/autorouter/state.svelte';
import { equirectangularDistanceM } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import { passiveFetchBlob } from '$lib/offline/passiveStore';

/** Terrarium tiles are 256x256. */
export const TILE_SIZE = 256;

/** Default sampling zoom. At z12 the ground sample distance is ~156 m*cos(lat)
 *  (~38 m at 45 deg N), already finer than the ~30 m SRTM/Copernicus source the
 *  tiles are built from, while keeping tile counts (and Worker requests) low. */
export const DEFAULT_TERRAIN_ZOOM = 12;

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

/** Decode one Terrarium RGB triple to metres. Returns the raw signed value;
 *  sea and voids are 0 or negative (bathymetry). The >= 0 ground clamp is left
 *  to elevationAt so this stays a faithful, independently-testable transform. */
export function decodeTerrarium(r: number, g: number, b: number): number {
	return r * 256 + g + b / 256 - 32768;
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

// --- Tile fetch + decode (browser only) ---------------------------------

// Tiles ride the same notam-proxy Worker as the autorouter calls; proxyBase
// encodes the localStorage -> VITE env -> default precedence. Exported for
// the terrain-pin prefetch (state/offlineTerrain.svelte.ts), which must pin
// the EXACT urls this module will read back.
export function tileUrl(z: number, x: number, y: number): string {
	return `${proxyBase()}/tiles/terrarium/${z}/${x}/${y}.png`;
}

/* Per-(z/x/y) decoded RGBA buffer (length 256*256*4), or null when the tile
 * failed to load/decode. The Promise is cached before it resolves so concurrent
 * samplers on one tile share a single fetch, and a settled null is cached so a
 * repeated miss doesn't re-hit the network. (Plain .ts: the
 * svelte/prefer-svelte-reactivity rule doesn't apply, so a plain Map is fine.) */
const tileCache = new Map<string, Promise<Uint8ClampedArray | null>>();

/* One reused 256x256 canvas; allocating per tile would thrash the GC under a
 * profile fan-out or rapid hover. willReadFrequently keeps the buffer CPU-side
 * for getImageData. */
let tileCtx: CanvasRenderingContext2D | null = null;
function getTileCtx(): CanvasRenderingContext2D {
	if (tileCtx) {
		return tileCtx;
	}
	const c = document.createElement('canvas');
	c.width = TILE_SIZE;
	c.height = TILE_SIZE;
	tileCtx = c.getContext('2d', { willReadFrequently: true });
	if (!tileCtx) {
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new Error('terrain: 2D canvas context unavailable');
	}
	return tileCtx;
}

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

async function loadTile(z: number, x: number, y: number): Promise<Uint8ClampedArray | null> {
	try {
		// passiveFetchBlob = the Android shell's offline cache in front of the
		// proxy fetch; a plain fetch on the web (the service worker caches
		// there).
		const blob = await runLimited(() => passiveFetchBlob(tileUrl(z, x, y)));
		if (!blob) {
			return null;
		}
		const bmp = await createImageBitmap(blob);
		const ctx = getTileCtx();
		ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
		ctx.drawImage(bmp, 0, 0, TILE_SIZE, TILE_SIZE);
		bmp.close();
		return ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
	} catch {
		return null; // network / decode error -> caller renders "no data"
	}
}

function getTile(z: number, x: number, y: number): Promise<Uint8ClampedArray | null> {
	const n = 1 << z;
	const wx = ((x % n) + n) % n; // wrap longitude across the antimeridian
	if (y < 0 || y >= n) {
		return Promise.resolve(null); // above / below the Mercator limit: no tile
	}
	const key = `${z}/${wx}/${y}`;
	let p = tileCache.get(key);
	if (!p) {
		p = loadTile(z, wx, y);
		tileCache.set(key, p);
	}
	return p;
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
	const data = await getTile(z, x, y);
	if (!data) {
		return null;
	}
	const o = (iy * TILE_SIZE + ix) * 4;
	return decodeTerrarium(data[o], data[o + 1], data[o + 2]);
}

/** Ground elevation in metres at (lat, lon), bilinearly interpolated from
 *  Terrarium tiles at zoom z. Null if the tile(s) failed to load. Sea / void
 *  (raw <= 0) is clamped to 0 (ground at sea level), distinct from null. */
export async function elevationAt(
	lat: number,
	lon: number,
	z: number = DEFAULT_TERRAIN_ZOOM,
): Promise<number | null> {
	const { tx, ty, px, py, fx, fy } = tilePixel(lat, lon, z);
	// Reference each pixel value at its centre: shift by -0.5 so an integer fx
	// lands exactly between two pixels and the weights are symmetric.
	const sx = fx - 0.5;
	const sy = fy - 0.5;
	const x0 = Math.floor(sx);
	const y0 = Math.floor(sy);
	const wx = sx - x0;
	const wy = sy - y0;
	const [v00, v10, v01, v11] = await Promise.all([
		pixelMetres(z, tx, ty, x0, y0),
		pixelMetres(z, tx, ty, x0 + 1, y0),
		pixelMetres(z, tx, ty, x0, y0 + 1),
		pixelMetres(z, tx, ty, x0 + 1, y0 + 1),
	]);
	if (v00 == null || v10 == null || v01 == null || v11 == null) {
		// A neighbour tile is missing (seam): fall back to nearest-pixel rather
		// than dropping the whole sample.
		const nn = await pixelMetres(z, tx, ty, px, py);
		return nn == null ? null : Math.max(0, nn);
	}
	return Math.max(0, bilinear(v00, v10, v01, v11, wx, wy));
}

/** Single-point ground elevation in feet, or null on tile failure. Convenience
 *  over elevationAt for the vertical-profile ground line. */
export async function elevationFtAt(lat: number, lon: number): Promise<number | null> {
	const m = await elevationAt(lat, lon);
	return m == null ? null : metresToFeet(m);
}

// --- Along-route profile sampler ----------------------------------------

export interface ProfilePoint {
	lat: number;
	lon: number;
}

export interface TerrainSample {
	/** Cumulative distance (NM) from the first point. */
	distNM: number;
	/** Ground elevation in feet, or null when the tile failed to load. */
	elevFt: number | null;
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
		return [{ distNM: 0, elevFt: m == null ? null : metresToFeet(m) }];
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
	let cumBase = 0;
	for (let i = 0; i + 1 < points.length; i++) {
		const a = points[i];
		const b = points[i + 1];
		const d = legNM[i];
		const seg = Math.max(1, Math.ceil(d / stepNM));
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
	const elevs = await Promise.all(sampled.map((p) => elevationAt(p.lat, p.lon, zoom)));
	if (opts.signal?.aborted) {
		return [];
	}
	return sampled.map((p, i) => {
		const m = elevs[i];
		return { distNM: p.distNM, elevFt: m == null ? null : metresToFeet(m) };
	});
}

/** Minimum ground elevation (ft) per leg from a route's centerline samples.
 *  Leg i spans [legCumNM[i-1], legCumNM[i]] (closed: a sample sitting exactly
 *  on the shared boundary lies on both legs' centerlines and counts for both);
 *  sampleProfile accumulates distance with the same per-leg partial sums as
 *  computeNavLog, so the spans match exactly. A leg with any failed sample
 *  (elevFt null) or no sample at all yields null: unknown, which the
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
			const e = samples[j].elevFt;
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
