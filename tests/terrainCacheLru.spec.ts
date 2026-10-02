/* The shared terrain tile cache's two new rules (map/terrain.ts).
 *
 * BOUNDED: every terrain consumer reads through one cache, and a decoded tile
 * is 384 KiB; the relative-terrain shading would otherwise pin every tile a
 * flight ever drew. The least recently READ decoded tile goes first, out of
 * BOTH maps together (evicting the settled value alone would leave a resolved
 * promise whose recorder already ran, and the tile would then peek "not in
 * hand" for good), while a settled miss weighs nothing and stays, being the
 * level ladder's "asked once" memory.
 *
 * A FAILURE IS NOT AN ANSWER: a tile that could not be read used to be
 * settled as null for the session, which every consumer reads as "no ground
 * here" and the shading would have drawn as open sea. It is now kept out of
 * the cache, answered as a miss without a request during the retry delay,
 * and asked again after it. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

/** What the stub network answers: a blob, null (the server holds no such
 *  tile), 'fail' (nothing could be read: the fetch rejects), or a promise
 *  of either (a tile still loading). */
let serve: (z: number, x: number, y: number) => Blob | null | 'fail' | Promise<Blob | null> = () => null;
const asked = new Map<string, number>();

vi.mock('$lib/offline/passiveStore', () => ({
	passiveFetchBlob: (url: string): Promise<Blob | null> => {
		const parts = url.split('/');
		const z = Number(parts.at(-3));
		const x = Number(parts.at(-2));
		const y = Number(parts.at(-1));
		const key = `${z}/${x}/${y}`;
		asked.set(key, (asked.get(key) ?? 0) + 1);
		const r = serve(z, x, y);
		return r === 'fail' ? Promise.reject(new Error('offline')) : Promise.resolve(r);
	},
}));

import {
	TILE_RETRY_MS,
	elevationAt,
	peekElevationAt,
	peekTile,
	clearTerrainTileCache,
	setTerrainLevels,
	setTerrainTileBudget,
	terrainLevels,
	terrainTileCacheStats,
	terrainTileDue,
	terrainTileFailed,
	visitTiles,
} from '$lib/map/terrain';

/** The committed Go-written tile, re-addressed (the terrainPeek recipe). */
function tileAt(z: number, x: number, y: number): Blob {
	const raw = gunzipSync(readFileSync('tests/fixtures/terrain-12-2125-1464.tile'));
	const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	view.setUint8(8, z);
	view.setUint32(12, x, true);
	view.setUint32(16, y, true);
	return new Blob([gzipSync(raw)]);
}

async function load(z: number, x: number, y: number): Promise<{ visited: number; missing: number }> {
	return visitTiles([{ z, x, y }], () => {});
}

const BEFORE = terrainLevels();

beforeEach(() => {
	asked.clear();
	serve = (z, x, y) => tileAt(z, x, y);
	// Every map of the cache, and the decoded count, from empty.
	clearTerrainTileCache();
	setTerrainLevels({ deepest: 12, coarsest: 10 });
	setTerrainTileBudget(8);
});

afterEach(() => {
	vi.restoreAllMocks();
	setTerrainTileBudget(192);
	setTerrainLevels(BEFORE);
});

describe('the decoded-tile budget', () => {
	it('evicts the least recently read tile first', async () => {
		for (let x = 2000; x < 2010; x++) {
			await load(12, x, 1400);
		}
		expect(terrainTileCacheStats().decoded).toBe(8);
		expect(peekTile(12, 2000, 1400)).toBeUndefined();
		expect(peekTile(12, 2001, 1400)).toBeUndefined();
		for (let x = 2002; x < 2010; x++) {
			expect(peekTile(12, x, 1400), `x ${x}`).toBeTruthy();
		}
	});

	it('counts a read as a use: a tile just peeked outlives an older one', async () => {
		for (let x = 2000; x < 2008; x++) {
			await load(12, x, 1400);
		}
		expect(peekTile(12, 2000, 1400)).toBeTruthy(); // now the youngest
		await load(12, 2008, 1400);
		expect(peekTile(12, 2000, 1400)).toBeTruthy();
		expect(peekTile(12, 2001, 1400)).toBeUndefined();
	});

	it('takes an evicted tile out of both maps, so it is fetched and peeks again', async () => {
		for (let x = 2000; x < 2010; x++) {
			await load(12, x, 1400);
		}
		expect(peekTile(12, 2000, 1400)).toBeUndefined();
		expect(asked.get('12/2000/1400')).toBe(1);
		expect(await load(12, 2000, 1400)).toEqual({ visited: 1, missing: 0, sea: 0 });
		expect(asked.get('12/2000/1400')).toBe(2);
		expect(peekTile(12, 2000, 1400)).toBeTruthy();
	});

	it('never counts or evicts a settled miss', async () => {
		serve = (z, x, y) => (x === 3000 ? null : tileAt(z, x, y));
		await load(12, 3000, 1400);
		expect(peekTile(12, 3000, 1400)).toBeNull();
		for (let x = 2000; x < 2012; x++) {
			await load(12, x, 1400);
		}
		expect(terrainTileCacheStats().decoded).toBe(8);
		expect(peekTile(12, 3000, 1400)).toBeNull();
		expect(asked.get('12/3000/1400')).toBe(1);
	});

	it('stops the level ladder at an evicted deep tile rather than read a coarse mean', async () => {
		const lat = 45.63;
		const lon = 6.79;
		// The deep tile for the point first, then enough others to push it out,
		// then the two coarser levels for the same point.
		expect(await elevationAt(lat, lon, 12)).not.toBeNull();
		for (let x = 2000; x < 2007; x++) {
			await load(12, x, 1300);
		}
		expect(await elevationAt(lat, lon, 11)).not.toBeNull();
		expect(await elevationAt(lat, lon, 10)).not.toBeNull();
		// z11 and z10 are in hand; z12 is not.
		expect(peekElevationAt(lat, lon, 11)).not.toBeUndefined();
		expect(peekElevationAt(lat, lon, 12)).toBeUndefined();
		expect(peekElevationAt(lat, lon)).toBeUndefined();
		// The async read fetches it back and the peek answers again.
		const deep = await elevationAt(lat, lon);
		expect(peekElevationAt(lat, lon)).toBe(deep);
	});

	it('never evicts a tile still loading: a second read joins its one fetch', async () => {
		let release: (b: Blob) => void = () => {};
		const slow = new Promise<Blob>((r) => {
			release = r;
		});
		serve = (z, x, y) => (x === 4000 ? slow : tileAt(z, x, y));
		const first = load(12, 4000, 1400);
		for (let x = 2000; x < 2012; x++) {
			await load(12, x, 1400);
		}
		expect(terrainTileCacheStats().decoded).toBe(8);
		expect(peekTile(12, 4000, 1400)).toBeUndefined(); // still loading
		const second = load(12, 4000, 1400);
		release(tileAt(12, 4000, 1400));
		expect(await Promise.all([first, second])).toEqual([
			{ visited: 1, missing: 0, sea: 0 },
			{ visited: 1, missing: 0, sea: 0 },
		]);
		expect(asked.get('12/4000/1400')).toBe(1);
		expect(peekTile(12, 4000, 1400)).toBeTruthy();
	});

	it('cannot be set below a floor that keeps a view drawable', () => {
		setTerrainTileBudget(1);
		expect(terrainTileCacheStats().budget).toBe(8);
	});
});

describe('a tile that fails to load', () => {
	it('is not settled: it peeks as not in hand and says it failed', async () => {
		serve = () => 'fail';
		expect(await load(12, 2100, 1400)).toEqual({ visited: 0, missing: 1, sea: 0 });
		expect(peekTile(12, 2100, 1400)).toBeUndefined();
		expect(terrainTileFailed(12, 2100, 1400)).toBe(true);
		expect(terrainTileCacheStats().failed).toBe(1);
	});

	it('is a miss without a request during the retry delay, and asked again after it', async () => {
		const t0 = Date.now();
		const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
		serve = () => 'fail';
		await load(12, 2100, 1400);
		expect(asked.get('12/2100/1400')).toBe(1);
		expect(terrainTileDue(12, 2100, 1400)).toBe(false);
		now.mockReturnValue(t0 + TILE_RETRY_MS - 1);
		expect(await load(12, 2100, 1400)).toEqual({ visited: 0, missing: 1, sea: 0 });
		expect(asked.get('12/2100/1400')).toBe(1);
		now.mockReturnValue(t0 + TILE_RETRY_MS);
		expect(terrainTileDue(12, 2100, 1400)).toBe(true);
		serve = (z, x, y) => tileAt(z, x, y);
		expect(await load(12, 2100, 1400)).toEqual({ visited: 1, missing: 0, sea: 0 });
		expect(asked.get('12/2100/1400')).toBe(2);
		expect(terrainTileFailed(12, 2100, 1400)).toBe(false);
		expect(peekTile(12, 2100, 1400)).toBeTruthy();
		expect(terrainTileDue(12, 2100, 1400)).toBe(false);
	});

	it('is told apart from a tile the server does not hold', async () => {
		serve = () => null;
		await load(12, 2100, 1400);
		expect(peekTile(12, 2100, 1400)).toBeNull();
		expect(terrainTileFailed(12, 2100, 1400)).toBe(false);
		expect(terrainTileDue(12, 2100, 1400)).toBe(false);
	});
});
