/* What a missing terrain tile MEANS, and the cache rules around it
 * (map/terrain.ts; docs/terrain-awareness.md).
 *
 * THE COMPLETE LEVEL. The mosaic is complete only up to its global floor:
 * GLO-90 at z10 covers the world, while z11 and z12 exist only inside the
 * boxes a 30 m source was built for. So a tile the worker does not hold is
 * the open sea at or below z10, and above it only says no finer tier reaches
 * there: over the Elburz or Svalbard z12 answers 204 above ground z10 holds.
 * Read as the sea, that land vanished from the shading from zoom 11 and read
 * as 0 ft in the terrain alert's corridor.
 *
 * THE CORRIDOR READ. The alert grades per 200 m bin. At a level coarser than
 * the bins a pixel admitted by its centre leaves some bins holding no pixel
 * (read as the sea, which disarmed the rise gate) and drops a pixel covering
 * the corridor's edge from outside it; admitted by its footprint, neither.
 * The finer level is still asked for when a coarser one answers.
 *
 * THE QUEUE AND THE MANIFEST. A pan's warm aborted by the next one used to
 * fetch its whole list anyway, ahead of anything asked after it; its tiles
 * still waiting for a connection are dropped now, and recorded as nothing. A
 * tile read never waits for the manifest, and a manifest landing late keeps
 * the tiles in hand. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

/** What the stub network answers per tile: a blob, null (the worker's 204),
 *  'fail' (the fetch rejects), or 'hold' (parked until released). */
let serve: (z: number, x: number, y: number) => Blob | null | 'fail' | 'hold' = () => null;
const asked: string[] = [];
const parked: (() => void)[] = [];

vi.mock('$lib/offline/passiveStore', () => ({
	passiveFetchBlob: (url: string): Promise<Blob | null> => {
		const parts = url.split('/');
		const z = Number(parts.at(-3));
		const x = Number(parts.at(-2));
		const y = Number(parts.at(-1));
		asked.push(`${z}/${x}/${y}`);
		const r = serve(z, x, y);
		if (r === 'hold') {
			return new Promise((resolve) => parked.push(() => resolve(null)));
		}
		return r === 'fail' ? Promise.reject(new Error('offline')) : Promise.resolve(r);
	},
}));

import {
	absentIsSea,
	binMax,
	clearTerrainTileCache,
	completeLevel,
	ensureTerrainRegions,
	lngLatToTile,
	peekCapsuleGround,
	peekTile,
	reduceCapsuleFromTiles,
	setTerrainLevels,
	terrainLevels,
	terrainTileDue,
	terrainTileFailed,
	tileRowLat,
	visitTiles,
	type DecodedTile,
	type TerrainLevels,
} from '$lib/map/terrain';
import { M_PER_DEG, destinationPoint } from '$lib/notam/geometry';

/** The committed Go-written tile, re-addressed (the terrainPeek recipe). */
function tileAt(z: number, x: number, y: number): Blob {
	const raw = gunzipSync(readFileSync('tests/fixtures/terrain-12-2125-1464.tile'));
	const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	view.setUint8(8, z);
	view.setUint32(12, x, true);
	view.setUint32(16, y, true);
	return new Blob([gzipSync(raw)]);
}

/** A decoded tile of one height, or of `fn(col, row)`. */
function flat(z: number, x: number, y: number, fn: number | ((col: number, row: number) => number)): DecodedTile {
	const band = new Int16Array(256 * 256);
	for (let row = 0; row < 256; row++) {
		for (let col = 0; col < 256; col++) {
			band[row * 256 + col] = typeof fn === 'number' ? fn : fn(col, row);
		}
	}
	return { z, tx: x, ty: y, mean: band, max: band, min: band };
}

const BUILT_IN = terrainLevels();
/** The mosaic as deployed: z12 in the boxes, the global floor at z10. */
const MOSAIC: TerrainLevels = { deepest: 12, coarsest: 6, complete: 10 };

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
}

beforeEach(() => {
	asked.length = 0;
	parked.length = 0;
	serve = () => null;
	clearTerrainTileCache();
	setTerrainLevels(MOSAIC);
});

afterEach(() => {
	for (const release of parked.splice(0)) {
		release();
	}
	clearTerrainTileCache();
	setTerrainLevels(BUILT_IN);
	vi.unstubAllGlobals();
});

describe('the complete level', () => {
	it('is the global floor in the built-in range', () => {
		expect(BUILT_IN).toMatchObject({ deepest: 12, coarsest: 6, complete: 10 });
		expect(completeLevel(BUILT_IN)).toBe(10);
		expect(absentIsSea(10, BUILT_IN)).toBe(true);
		expect(absentIsSea(11, BUILT_IN)).toBe(false);
		// Unstated, every level is complete; stated outside the range, clamped.
		expect(completeLevel({ deepest: 12, coarsest: 10 })).toBe(12);
		expect(completeLevel({ deepest: 12, coarsest: 8, complete: 4 })).toBe(8);
	});
});

describe('a corridor over land no finer tier reaches', () => {
	// Mont Blanc's neighbourhood, but served the way the worker serves the
	// Elburz: nothing at z11 or z12, the massif at z10.
	const a = { lat: 45.83, lon: 6.8 };
	const b = destinationPoint(a.lat, a.lon, 70, 3700);
	const opts = { halfWidthM: 463, alongBins: 18, crossMax: 0 };
	const massif = (z: number, x: number, y: number): DecodedTile | null | undefined =>
		z > 10 ? null : z === 10 ? flat(z, x, y, 3000) : undefined;

	it('is read from the complete level, not taken for the sea', () => {
		const peek = peekCapsuleGround(a, b, opts, massif);
		expect(peek.z).toBe(10);
		expect(peek.resolved).toBe(true);
		for (let i = 0; i <= opts.alongBins; i++) {
			expect(binMax(peek.bins, i)).toBe(3000);
		}
	});

	it('asks for the complete level while it is not in hand, and grades nothing meanwhile', () => {
		const peek = peekCapsuleGround(a, b, opts, (z) => (z > 10 ? null : undefined));
		expect(peek.resolved).toBe(false);
		expect(peek.warm.length).toBeGreaterThan(0);
		expect(new Set(peek.warm.map((t) => t.z))).toEqual(new Set([10]));
	});

	it('is the sea where the complete level holds no tile either', () => {
		const peek = peekCapsuleGround(a, b, opts, () => null);
		expect(peek.z).toBe(10);
		expect(peek.resolved).toBe(true);
		expect(binMax(peek.bins, 5)).toBeNull();
	});

	it('never falls below the complete level, whose coarser pixels would stand for distant ridges', () => {
		// Only z8 in hand (the route MSA's level): nothing is resolved, and
		// the finest level's tiles are what is asked for.
		const peek = peekCapsuleGround(a, b, opts, (z, x, y) => (z === 8 ? flat(z, x, y, 3000) : undefined));
		expect(peek.resolved).toBe(false);
		expect(peek.z).toBe(12);
		expect(new Set(peek.warm.map((t) => t.z))).toEqual(new Set([12]));
	});

	it('still asks for the finer level when a coarser one answered', () => {
		const peek = peekCapsuleGround(a, b, opts, (z, x, y) => (z === 10 ? flat(z, x, y, 3000) : undefined));
		expect(peek.z).toBe(10);
		expect(peek.resolved).toBe(true);
		expect(new Set(peek.warm.map((t) => t.z))).toEqual(new Set([12]));
	});
});

describe('the corridor read by footprint', () => {
	// z8 pixels are about 420 m here, twice the alert's 200 m bins: the level
	// the route's MSA corridor holds, and the one the alert used to fall to.
	// Northbound, so the bins run along the pixel rows.
	const a = { lat: 47.2, lon: 1.3 };
	const b = destinationPoint(a.lat, a.lon, 0, 3700);
	const opts = { halfWidthM: 463, alongBins: 18, crossMax: 0, z: 8 };

	it('leaves no bin empty over land', () => {
		const lookup = (z: number, x: number, y: number): DecodedTile => flat(z, x, y, 400);
		const byCentre = reduceCapsuleFromTiles(a, b, opts, lookup);
		const byFootprint = reduceCapsuleFromTiles(a, b, { ...opts, footprint: true }, lookup);
		const empty = (bins: typeof byCentre.bins): number =>
			Array.from({ length: opts.alongBins + 1 }, (_, i) => binMax(bins, i)).filter((m) => m == null).length;
		// The failure the footprint exists for: a bin no pixel centre fell in.
		expect(empty(byCentre.bins)).toBeGreaterThan(0);
		expect(empty(byFootprint.bins)).toBe(0);
	});

	it('takes a pixel covering the edge from outside it', () => {
		// One row of z9 pixels (about 208 m tall) whose centres stand 50 m past
		// the half-width, north of an eastbound leg: the corridor reaches half
		// way into those pixels, and their centre never does.
		const z = 9;
		const ty = Math.floor(lngLatToTile(47.2, 1.3, z).y);
		const rowLat = tileRowLat(z, ty, 128);
		const east = { lat: rowLat - 513 / M_PER_DEG, lon: 1.3 };
		const end = destinationPoint(east.lat, east.lon, 90, 3700);
		const lookup = (tz: number, x: number, y: number): DecodedTile =>
			flat(tz, x, y, (_col, row) => (y === ty && row === 128 ? 2500 : 300));
		const e = { ...opts, z };
		const byCentre = reduceCapsuleFromTiles(east, end, e, lookup);
		const byFootprint = reduceCapsuleFromTiles(east, end, { ...e, footprint: true }, lookup);
		const top = (bins: typeof byCentre.bins): number =>
			Math.max(...Array.from({ length: opts.alongBins + 1 }, (_, i) => binMax(bins, i) ?? 0));
		expect(top(byCentre.bins)).toBe(300);
		expect(top(byFootprint.bins)).toBe(2500);
	});
});

describe('the tile queue', () => {
	it("drops an aborted warm's tiles still waiting for a connection, and records nothing for them", async () => {
		// Six connections, all parked; forty tiles of a pan's warm queued
		// behind them, then the pan moves on.
		serve = () => 'hold';
		const pan = new AbortController();
		const warm = Array.from({ length: 46 }, (_, i) => ({ z: 12, x: 2000 + i, y: 1400 }));
		const panned = visitTiles(warm, () => {}, pan.signal);
		await settle();
		expect(asked).toHaveLength(6);
		pan.abort();
		// Then the ground under the aircraft, wanted for good.
		serve = (z, x, y) => tileAt(z, x, y);
		const wanted = visitTiles([{ z: 12, x: 2100, y: 1400 }], () => {});
		for (const release of parked.splice(0)) {
			release();
		}
		await panned;
		expect(await wanted).toEqual({ visited: 1, missing: 0, sea: 0 });
		// The six already running finished; none of the forty was fetched.
		expect(asked).toEqual([...warm.slice(0, 6).map((t) => `12/${t.x}/1400`), '12/2100/1400']);
		// A dropped tile is neither an answer nor a failure: asked again later.
		const dropped = warm[20];
		expect(peekTile(12, dropped.x, dropped.y)).toBeUndefined();
		expect(terrainTileFailed(12, dropped.x, dropped.y)).toBe(false);
		expect(terrainTileDue(12, dropped.x, dropped.y)).toBe(true);
	});

	it('keeps a queued tile another reader still wants', async () => {
		serve = () => 'hold';
		const pan = new AbortController();
		const warm = Array.from({ length: 8 }, (_, i) => ({ z: 12, x: 2000 + i, y: 1400 }));
		const panned = visitTiles(warm, () => {}, pan.signal);
		await settle();
		// The alert asks for a tile the warm had queued, then the warm aborts.
		serve = (z, x, y) => tileAt(z, x, y);
		const wanted = visitTiles([warm[7]], () => {});
		pan.abort();
		for (const release of parked.splice(0)) {
			release();
		}
		await panned;
		expect(await wanted).toEqual({ visited: 1, missing: 0, sea: 0 });
		expect(peekTile(12, warm[7].x, warm[7].y)).toBeTruthy();
		expect(asked).not.toContain(`12/${warm[6].x}/1400`);
	});
});

describe('the manifest', () => {
	it('never holds a tile read behind it', async () => {
		// A manifest fetch that never answers.
		vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
		void ensureTerrainRegions();
		serve = (z, x, y) => tileAt(z, x, y);
		const r = await Promise.race([
			visitTiles([{ z: 12, x: 2125, y: 1464 }], () => {}),
			// Generous: the race ends the moment the read does, and a busy
			// machine took longer than 200 ms to decode the tile.
			new Promise((resolve) => setTimeout(() => resolve('blocked'), 3000)),
		]);
		expect(r).toEqual({ visited: 1, missing: 0, sea: 0 });
	});

	it('landing with the same range changes nothing, and a new range keeps the ground in hand', async () => {
		serve = (z, x, y) => (x === 2125 ? tileAt(z, x, y) : x === 2126 ? 'fail' : null);
		await visitTiles(
			[
				{ z: 12, x: 2125, y: 1464 },
				{ z: 12, x: 2126, y: 1464 },
				{ z: 12, x: 2127, y: 1464 },
			],
			() => {},
		);
		const held = peekTile(12, 2125, 1464);
		expect(held).toBeTruthy();
		expect(peekTile(12, 2127, 1464)).toBeNull();
		expect(terrainTileFailed(12, 2126, 1464)).toBe(true);
		setTerrainLevels({ ...MOSAIC });
		expect(peekTile(12, 2125, 1464)).toBe(held);
		expect(peekTile(12, 2127, 1464)).toBeNull();
		expect(terrainTileFailed(12, 2126, 1464)).toBe(true);
		// A new range: the misses were reached by walking the old one and are
		// free to be asked again; decoded ground is the same ground.
		setTerrainLevels({ deepest: 13, coarsest: 6, complete: 10 });
		expect(peekTile(12, 2125, 1464)).toBe(held);
		expect(peekTile(12, 2127, 1464)).toBeUndefined();
		expect(terrainTileFailed(12, 2126, 1464)).toBe(false);
	});
});
