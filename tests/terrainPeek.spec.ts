/* The synchronous read, and the one property that makes it safe to show.
 *
 * peekElevationAt answers from tiles already decoded, so a pointer-move
 * handler can print the ground at frame rate without touching the network.
 * That is only tolerable while it answers EXACTLY what elevationAt would, or
 * nothing at all. The trap it must not fall into is the level ladder: the
 * coarse tiers carry the POOLED MEAN of everything beneath them, so falling
 * through to one because the deep tile has not arrived yet would print an
 * average over a kilometre of ground as if it were the point. The rule is
 * that the first level whose tiles are not all in hand stops the walk. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

let serve: (url: string) => Blob | null = () => null;

vi.mock('$lib/offline/passiveStore', () => ({
	passiveFetchBlob: (url: string): Promise<Blob | null> => Promise.resolve(serve(url)),
}));

import {
	elevationAt,
	elevationFtAt,
	peekElevationAt,
	peekElevationFtAt,
	setTerrainLevels,
	terrainLevels,
} from '$lib/map/terrain';
import { TERRAIN_MAGIC } from '$lib/map/terrainTile';

/** The committed Go-written tile, re-addressed: the terrainFallback recipe. */
function tileAt(z: number, x: number, y: number): Blob {
	const raw = gunzipSync(readFileSync('tests/fixtures/terrain-12-2125-1464.tile'));
	const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	expect(String.fromCharCode(...raw.subarray(0, 8))).toBe(TERRAIN_MAGIC);
	view.setUint8(8, z);
	view.setUint32(12, x, true);
	view.setUint32(16, y, true);
	return new Blob([gzipSync(raw)]);
}

function tileOf(lat: number, lon: number, z: number): { x: number; y: number } {
	const n = 1 << z;
	const r = (lat * Math.PI) / 180;
	return {
		x: Math.floor(((lon + 180) / 360) * n),
		y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n),
	};
}

/** Serve every level's tile for this point, so a bare walk always answers. */
function serveAllLevels(lat: number, lon: number): void {
	serve = (url) => {
		const parts = url.split('/');
		const z = Number(parts.at(-3));
		const x = Number(parts.at(-2));
		const y = Number(parts.at(-1));
		const at = tileOf(lat, lon, z);
		return x === at.x && y === at.y ? tileAt(z, x, y) : null;
	};
}

// Ground the fixture describes, so a hit is a plausible elevation.
const LAT = 45.63;
const LON = 6.79;

const BEFORE = terrainLevels();

describe('peekElevationAt', () => {
	beforeEach(() => {
		serve = () => null;
		// A fresh range clears the tile caches, decoded and settled alike.
		setTerrainLevels({ deepest: 12, coarsest: 10 });
	});
	afterEach(() => {
		setTerrainLevels(BEFORE);
	});

	it('knows nothing before a tile has been read', () => {
		serveAllLevels(LAT, LON);
		expect(peekElevationAt(LAT, LON)).toBeUndefined();
		expect(peekElevationFtAt(LAT, LON)).toBeUndefined();
	});

	it('answers the same number as elevationAt once the tile is in hand', async () => {
		serveAllLevels(LAT, LON);
		const async_ = await elevationAt(LAT, LON);
		expect(async_).not.toBeNull();
		expect(peekElevationAt(LAT, LON)).toBe(async_);
		expect(peekElevationFtAt(LAT, LON)).toBe(await elevationFtAt(LAT, LON));
	});

	it('walks past a level that settled as a miss, exactly as the reader does', async () => {
		// Only the coarse tier reaches here, the case at every national edge.
		const at10 = tileOf(LAT, LON, 10);
		serve = (url) => (url.endsWith(`/10/${at10.x}/${at10.y}`) ? tileAt(10, at10.x, at10.y) : null);
		const async_ = await elevationAt(LAT, LON);
		expect(async_).not.toBeNull();
		expect(peekElevationAt(LAT, LON)).toBe(async_);
	});

	it('says nothing rather than a coarse average while the finer level is pending', async () => {
		// The coarse tile alone is in hand, and z12 has never been attempted.
		const at10 = tileOf(LAT, LON, 10);
		serve = (url) => (url.endsWith(`/10/${at10.x}/${at10.y}`) ? tileAt(10, at10.x, at10.y) : null);
		const coarse = await elevationAt(LAT, LON, 10);
		expect(coarse).not.toBeNull();

		// The pooled mean at z10 IS available, and must not be handed out as
		// the ground at this point: z12 might yet answer.
		expect(peekElevationAt(LAT, LON)).toBeUndefined();
		expect(peekElevationAt(LAT, LON, 10)).toBe(coarse);
	});

	it('reports no data where every level has settled empty', async () => {
		expect(await elevationAt(LAT, LON)).toBeNull();
		expect(peekElevationAt(LAT, LON)).toBeNull();
		expect(peekElevationFtAt(LAT, LON)).toBeNull();
	});
});
