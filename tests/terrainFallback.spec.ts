/* The level fallback: what a read does at the edge of a finer tier.
 *
 * The mosaic's tiers do not all reach the same level. z12 exists where a 30 m
 * or finer source does, z10 is the global floor, and the boundary between
 * them is a coastline, a border, or the edge of a withheld degree, not
 * anything the client knows. So a deep read misses constantly and by design:
 * in the Bay of Biscay, on the Rhine, and along every national edge.
 *
 * A miss there must fall to the level below, because the pooled parent covers
 * the same ground and its max IS the max of everything under it. Reading it
 * costs granularity and never correctness. Returning null instead would put
 * "no terrain data" under an aircraft over ground the mosaic holds one level
 * up, and every clearance number downstream inherits that hole. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

const asked: string[] = [];
/** A blob, null for the server's "none", or an Error for a failed read. */
let serve: (url: string) => Blob | null | Error = () => null;

vi.mock('$lib/offline/passiveStore', () => ({
	passiveFetchBlob: (url: string): Promise<Blob | null> => {
		asked.push(url);
		const r = serve(url);
		return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
	},
}));

import {
	TILE_RETRY_MS,
	clearTerrainTileCache,
	elevationAt,
	peekTile,
	setTerrainLevels,
	terrainLevels,
	terrainTileFailed,
	visitTiles,
} from '$lib/map/terrain';
import { TERRAIN_MAGIC } from '$lib/map/terrainTile';

/** The committed Go-written tile, re-addressed. Its content is real Alpine
 *  ground; only the header's z/x/y move, so the decoder's address check
 *  passes and the bands are a genuine tile rather than a hand-rolled one. */
function tileAt(z: number, x: number, y: number): Blob {
	const raw = gunzipSync(readFileSync('tests/fixtures/terrain-12-2125-1464.tile'));
	const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	expect(String.fromCharCode(...raw.subarray(0, 8))).toBe(TERRAIN_MAGIC);
	view.setUint8(8, z);
	view.setUint32(12, x, true);
	view.setUint32(16, y, true);
	return new Blob([gzipSync(raw)]);
}

/** Which tile a point falls in, the same slippy arithmetic the reader uses. */
function tileOf(lat: number, lon: number, z: number): { x: number; y: number } {
	const n = 1 << z;
	const r = (lat * Math.PI) / 180;
	return {
		x: Math.floor(((lon + 180) / 360) * n),
		y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n),
	};
}

// Ground the fixture describes, so a hit is a plausible elevation.
const LAT = 45.63;
const LON = 6.79;

const BEFORE = terrainLevels();

describe('elevationAt across levels', () => {
	beforeEach(() => {
		asked.length = 0;
		serve = () => null;
		clearTerrainTileCache();
		// z10 complete, as the mosaic's own range: a tile missing above it
		// is a tier that does not reach, below or at it the sea.
		setTerrainLevels({ deepest: 12, coarsest: 10, complete: 10 });
	});
	afterEach(() => {
		setTerrainLevels(BEFORE);
	});

	it('answers from the level below when the finer tier does not reach', () => {
		const at10 = tileOf(LAT, LON, 10);
		serve = (url) => (url.endsWith(`/10/${at10.x}/${at10.y}`) ? tileAt(10, at10.x, at10.y) : null);

		return elevationAt(LAT, LON).then((v) => {
			expect(v).not.toBeNull();
			expect(Number.isFinite(v)).toBe(true);
			// Deepest first, and it stopped as soon as one answered.
			expect(asked.map((u) => u.split('/').at(-3))).toEqual(['12', '11', '10']);
		});
	});

	it('prefers the deepest level that does answer', () => {
		const at12 = tileOf(LAT, LON, 12);
		const at10 = tileOf(LAT, LON, 10);
		serve = (url) => {
			if (url.endsWith(`/12/${at12.x}/${at12.y}`)) return tileAt(12, at12.x, at12.y);
			if (url.endsWith(`/10/${at10.x}/${at10.y}`)) return tileAt(10, at10.x, at10.y);
			return null;
		};

		return elevationAt(LAT, LON).then((v) => {
			expect(v).not.toBeNull();
			// It never looked past the level that answered.
			expect(asked.map((u) => u.split('/').at(-3))).toEqual(['12']);
		});
	});

	it('reports no ground only when no level holds any', () => {
		return elevationAt(LAT, LON).then((v) => {
			expect(v).toBeNull();
			expect(asked.map((u) => u.split('/').at(-3))).toEqual(['12', '11', '10']);
		});
	});

	it('does not walk the pyramid when the caller named a level', () => {
		return elevationAt(LAT, LON, 11).then(() => {
			expect(asked.map((u) => u.split('/').at(-3))).toEqual(['11']);
		});
	});
});

describe('elevationAt past a failed tile', () => {
	beforeEach(() => {
		asked.length = 0;
		clearTerrainTileCache();
		setTerrainLevels({ deepest: 12, coarsest: 8, complete: 10 });
	});
	afterEach(() => {
		vi.restoreAllMocks();
		setTerrainLevels(BEFORE);
	});

	// Offline, z12 to z10 fail while a z9 tile is still in hand: a coarser
	// level's pooled MEAN of 200 to 450 m read as the ground under the
	// aircraft, the band's AGL and the alerts' ASFC grading with it.
	it('stops at the complete level rather than read a coarser pooled mean', async () => {
		const at9 = tileOf(LAT, LON, 9);
		const at10 = tileOf(LAT, LON, 10);
		let z10back = false;
		serve = (url) => {
			const z = Number(url.split('/').at(-3));
			if (z === 9 && url.endsWith(`/9/${at9.x}/${at9.y}`)) {
				return tileAt(9, at9.x, at9.y);
			}
			if (z === 10 && z10back && url.endsWith(`/10/${at10.x}/${at10.y}`)) {
				return tileAt(10, at10.x, at10.y);
			}
			return z >= 10 ? new Error('offline') : null;
		};
		expect(await elevationAt(LAT, LON)).toBeNull();
		expect(asked.map((u) => u.split('/').at(-3))).not.toContain('9');
		// Once z10 answers, it is z10's value.
		z10back = true;
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + TILE_RETRY_MS + 1_000);
		const v = await elevationAt(LAT, LON);
		expect(v).not.toBeNull();
		expect(v).toBe(await elevationAt(LAT, LON, 10));
	});
});

describe('a tile body the reader cannot account for', () => {
	beforeEach(() => {
		asked.length = 0;
		clearTerrainTileCache();
		setTerrainLevels({ deepest: 12, coarsest: 8, complete: 10 });
	});
	afterEach(() => {
		setTerrainLevels(BEFORE);
	});

	// Taken for the server's "none" and cached for the session, it read at
	// the complete level as the open sea: a ridge under it left the MSA
	// corridor and the shading.
	const at10 = tileOf(LAT, LON, 10);
	const t = { z: 10, x: at10.x, y: at10.y };

	it('is a failure when its bytes do not decode', async () => {
		serve = () => new Blob(['<html>bad gateway</html>']);
		expect(await visitTiles([t], () => {})).toEqual({ visited: 0, missing: 1, sea: 0 });
		expect(terrainTileFailed(t.z, t.x, t.y)).toBe(true);
		expect(peekTile(t.z, t.x, t.y)).toBeUndefined();
	});

	it('is a failure when it names another tile', async () => {
		serve = () => tileAt(10, at10.x + 1, at10.y);
		expect(await visitTiles([t], () => {})).toEqual({ visited: 0, missing: 1, sea: 0 });
		expect(terrainTileFailed(t.z, t.x, t.y)).toBe(true);
	});

	it('reads an empty body as no tile: the sea at the complete level', async () => {
		serve = () => new Blob([]);
		expect(await visitTiles([t], () => {})).toEqual({ visited: 0, missing: 0, sea: 1 });
		expect(peekTile(t.z, t.x, t.y)).toBeNull();
	});
});
