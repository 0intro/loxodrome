/* The open sea is sea level, never "unknown" and never the coast.
 *
 * A LEG over the open sea: the worker answers a tile it does not hold with a
 * 204, which at or below the complete level is the sea (absentIsSea). The
 * corridor reduction counted that answer as a MISSING tile, like a failed
 * fetch, so computeCorridorGround gave a leg crossing open sea no ground at
 * all and the nav log no MSA for it (Nice to Calvi).
 *
 * A POINT just offshore: the point ladder took a no-data pixel of a present
 * coastal tile (the sea) for "try a coarser level", down to a pooled pixel
 * carrying the mean of its land children, so the ground under an aircraft
 * 1 km off the coast read the coast's hills. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

const world = vi.hoisted(() => ({ mode: 'leg', land: '' }));

/** A one-band (mean) tile of one value, LOXTERR1 row-delta encoded. */
function encode(z: number, x: number, y: number, v: number): Blob {
	const head = Buffer.alloc(20);
	head.write('LOXTERR1', 0, 'ascii');
	head.writeUInt8(z, 8);
	head.writeUInt8(1, 9);
	head.writeUInt32LE(x, 12);
	head.writeUInt32LE(y, 16);
	const plane = Buffer.alloc(256 * 256 * 2);
	for (let r = 0; r < 256; r++) {
		plane.writeInt16LE(v, r * 512);
	}
	return new Blob([gzipSync(Buffer.concat([head, plane]))]);
}

vi.mock('$lib/offline/passiveStore', () => ({
	passiveFetchBlob: (url: string): Promise<Blob | null> => {
		const parts = url.split('/');
		const z = Number(parts.at(-3));
		const x = Number(parts.at(-2));
		const y = Number(parts.at(-1));
		if (world.mode === 'point') {
			// z12 down to z7 present and holding the sea (no data) at the
			// point; z6 an 80 m pooled mean of the land around it.
			return Promise.resolve(encode(z, x, y, z === 6 ? 80 : -32768));
		}
		if (`${z}/${x}/${y}` !== world.land) {
			return Promise.resolve(new Blob([])); // the worker's 204: no such tile
		}
		const raw = gunzipSync(readFileSync('tests/fixtures/terrain-12-2125-1464.tile'));
		const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
		view.setUint8(8, z);
		view.setUint32(12, x, true);
		view.setUint32(16, y, true);
		return Promise.resolve(new Blob([gzipSync(raw)]));
	},
}));

import {
	absentIsSea,
	clearTerrainTileCache,
	elevationAt,
	lngLatToTile,
	peekElevationAt,
	peekTile,
	terrainTileFailed,
} from '$lib/map/terrain';
import { computeCorridorGround } from '$lib/route/minAltitude';

describe('the open sea', () => {
	beforeEach(() => clearTerrainTileCache());

	it('gives a leg across it sea level, every tile having answered', async () => {
		world.mode = 'leg';
		const nice = { lat: 43.66, lon: 7.21 };
		const calvi = { lat: 42.53, lon: 8.79 };
		const t = lngLatToTile(nice.lat, nice.lon, 8);
		world.land = `8/${Math.floor(t.x)}/${Math.floor(t.y)}`;
		const g = await computeCorridorGround([nice, calvi]);
		expect(g.legZ).toEqual([8]);
		expect(absentIsSea(8)).toBe(true);
		// The other tiles are settled absent (an answer), not failures.
		expect(peekTile(8, Math.floor(t.x) + 1, Math.floor(t.y) + 1)).toBeNull();
		expect(terrainTileFailed(8, Math.floor(t.x) + 1, Math.floor(t.y) + 1)).toBe(false);
		// Nice's hills are the leg's highest ground; the sea its lowest.
		expect(g.legMaxFt[0]).toBeGreaterThan(0);
		expect(g.legMinFt[0]).toBe(0);
	});

	it('gives a leg over nothing but the sea sea level', async () => {
		world.mode = 'leg';
		world.land = '';
		const g = await computeCorridorGround([
			{ lat: 43.0, lon: 7.6 },
			{ lat: 42.7, lon: 8.2 },
		]);
		expect({ max: g.legMaxFt[0], min: g.legMinFt[0] }).toEqual({ max: 0, min: 0 });
	});

	it('reads a point just offshore as no ground, never the pooled coast', async () => {
		world.mode = 'point';
		expect(await elevationAt(43.4, 7.3)).toBeNull();
		expect(peekElevationAt(43.4, 7.3)).toBeNull();
	});
});
