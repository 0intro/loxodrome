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
let serve: (url: string) => Blob | null = () => null;

vi.mock('$lib/offline/passiveStore', () => ({
	passiveFetchBlob: (url: string): Promise<Blob | null> => {
		asked.push(url);
		return Promise.resolve(serve(url));
	},
}));

import { elevationAt, setTerrainLevels, terrainLevels } from '$lib/map/terrain';
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
		setTerrainLevels({ deepest: 12, coarsest: 10 });
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
