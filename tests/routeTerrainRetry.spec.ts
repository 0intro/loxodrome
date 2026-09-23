/* The route memos recover once a failed terrain tile reads again. A tile that
 * failed is asked again after TILE_RETRY_MS (map/terrain.ts), but the two
 * route memos settled READY over the gap, the corridor and the profile
 * settling rather than throwing for one tile, so their own failure retry,
 * which only a thrown error armed, never fired: the nav log's MSA column, the
 * band's "MSA leg" and the profile's ground stayed blank for the whole
 * session under the same route signature.
 *
 * The real memos over the real corridor pass, profile and tile cache; only
 * the store in front of the network is stubbed: offline first, back a minute
 * later. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

const net = vi.hoisted(() => ({ up: false, asked: 0 }));
vi.mock('$lib/offline/passiveStore', () => ({
	passiveFetchBlob: (url: string): Promise<Blob | null> => {
		net.asked++;
		if (!net.up) {
			return Promise.reject(new Error('offline'));
		}
		const parts = url.split('/');
		const raw = gunzipSync(readFileSync('tests/fixtures/terrain-12-2125-1464.tile'));
		const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
		view.setUint8(8, Number(parts.at(-3)));
		view.setUint32(12, Number(parts.at(-2)), true);
		view.setUint32(16, Number(parts.at(-1)), true);
		return Promise.resolve(new Blob([gzipSync(raw)]));
	},
}));
vi.mock('$lib/state/data.svelte', () => ({ ensureObstacles: () => Promise.resolve([]) }));

import { ensureRouteMsa, routeMsaLegs } from '$lib/state/routeMsa.svelte';
import { ensureRouteTerrain, routeTerrainSamples } from '$lib/state/routeTerrain.svelte';
import { TILE_RETRY_MS, clearTerrainTileCache } from '$lib/map/terrain';

const settle = async (): Promise<void> => {
	for (let i = 0; i < 50; i++) {
		await new Promise((r) => setTimeout(r, 0));
	}
};

const WPS = [
	{ lat: 48.8, lon: 2.6 },
	{ lat: 48.5, lon: 2.7 },
];
const OPTS = { halfWidthNM: 5, vfr: true };

describe('the route memos after a transient tile failure', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		net.up = false;
		clearTerrainTileCache();
	});

	it('read the MSA again once the tiles read again', async () => {
		ensureRouteMsa('r1', WPS, OPTS);
		await settle();
		expect(routeMsaLegs('r1', WPS, OPTS)).toEqual([null]); // offline: unknown
		net.up = true;
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + TILE_RETRY_MS + 5_000);
		ensureRouteMsa('r1', WPS, OPTS); // the host effect re-runs
		await settle();
		expect(routeMsaLegs('r1', WPS, OPTS)?.[0]).toBeGreaterThan(0);
	});

	it('read the profile ground again once the tiles read again', async () => {
		ensureRouteTerrain('r2', WPS);
		await settle();
		const before = routeTerrainSamples('r2', WPS);
		expect(before?.some((s) => s.elevFt == null)).toBe(true);
		net.up = true;
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + TILE_RETRY_MS + 5_000);
		ensureRouteTerrain('r2', WPS);
		await settle();
		const after = routeTerrainSamples('r2', WPS);
		expect(after?.every((s) => s.elevFt != null)).toBe(true);
	});
});
