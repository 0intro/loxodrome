// Route-corridor terrain pins (docs/offline-maps.md): the pure enumeration
// and reconciliation of offline/terrainPin.ts, and the pin job over
// fake-indexeddb.

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	computePinOps,
	corridorTerrainTiles,
	estimateBytes,
	isoDay,
} from '../src/lib/offline/terrainPin';

vi.mock('$lib/ui/wakeLock', () => ({ acquireWakeLock: () => undefined, releaseWakeLock: () => undefined }));

const paris = { lat: 48.85, lon: 2.35 };
const alps = { lat: 45.05, lon: 7.05 };

describe('corridorTerrainTiles', () => {
	it('pins a contiguous swath along a leg, deduped and in-grid', () => {
		const tiles = corridorTerrainTiles([[paris, alps]], 10, [12]);
		expect(tiles.length).toBeGreaterThan(100);
		const keys = new Set(tiles.map((t) => `${t.x}/${t.y}`));
		expect(keys.size).toBe(tiles.length);
		for (const t of tiles) {
			expect(t.z).toBe(12);
			expect(t.x).toBeGreaterThanOrEqual(0);
			expect(t.x).toBeLessThan(1 << 12);
			expect(t.y).toBeGreaterThanOrEqual(0);
			expect(t.y).toBeLessThan(1 << 12);
		}
	});

	it('contains the endpoints own tiles', () => {
		const tiles = corridorTerrainTiles([[paris, alps]], 10, [12]);
		const keys = new Set(tiles.map((t) => `${t.x}/${t.y}`));
		// z12 tile of Paris 48.85N 2.35E: x = (2.35+180)/360*4096 = 2074,
		// y from the Mercator formula = 1409.
		expect(keys.has('2074/1409')).toBe(true);
	});

	it('grows with the radius and dedupes overlapping routes', () => {
		const narrow = corridorTerrainTiles([[paris, alps]], 5, [12]).length;
		const wide = corridorTerrainTiles([[paris, alps]], 15, [12]).length;
		expect(wide).toBeGreaterThan(narrow * 2);
		const twice = corridorTerrainTiles(
			[
				[paris, alps],
				[paris, alps],
			],
			5,
			[12],
		).length;
		expect(twice).toBe(narrow);
	});

	it('ignores routes with fewer than two waypoints', () => {
		expect(corridorTerrainTiles([[paris]], 10, [12])).toEqual([]);
		expect(corridorTerrainTiles([], 10, [12])).toEqual([]);
	});

	it('clamps to the Mercator grid near the poles', () => {
		const tiles = corridorTerrainTiles(
			[
				[
					{ lat: 85.0, lon: 0 },
					{ lat: 85.0, lon: 1 },
				],
			],
			30,
			[12],
		);
		for (const t of tiles) {
			expect(t.y).toBeGreaterThanOrEqual(0);
			expect(t.y).toBeLessThan(1 << 12);
		}
	});
});

describe('computePinOps', () => {
	it('fetches the missing, reads the overlap again, drops the stale', () => {
		expect(computePinOps(new Set(['a', 'b']), ['b', 'c'])).toEqual({
			toFetch: ['c'],
			toRefresh: ['b'],
			toDrop: ['a'],
		});
	});
	it('reads an identical set again and replaces a disjoint one', () => {
		expect(computePinOps(new Set(['a']), ['a'])).toEqual({ toFetch: [], toRefresh: ['a'], toDrop: [] });
		expect(computePinOps(new Set(['a']), ['b'])).toEqual({ toFetch: ['b'], toRefresh: [], toDrop: ['a'] });
	});
});

describe('labels', () => {
	it('estimates a conservative 50 KB per tile', () => {
		expect(estimateBytes(300)).toBe(15_000_000);
	});
	it('formats the pin day as a UTC date', () => {
		expect(isoDay(Date.UTC(2026, 7, 4, 12))).toBe('2026-08-04');
	});
});

describe('the pin job', () => {
	/** What the tile server holds at a url: the build that wrote the tile,
	 *  which names its bytes and its ETag, or null for the 204 of a tile no
	 *  tier reaches. A rebuild keeps the urls (docs/terrain-sources.md). */
	let holds: (url: string) => string | null = () => 'old';
	/** The tiles whose reads a fading link holds open until the job stops. */
	let stalled: (url: string) => boolean = () => false;
	/** Every tile request, in order. */
	let asked: { url: string; method: string; cache: RequestCache | undefined }[] = [];

	beforeEach(() => {
		holds = () => 'old';
		stalled = () => false;
		asked = [];
		vi.resetModules();
		vi.stubGlobal('indexedDB', new IDBFactory());
		vi.stubGlobal('fetch', (url: string, init?: RequestInit): Promise<Response> => {
			if (!url.includes('/terrain/')) {
				return Promise.resolve(new Response(null, { status: 404 }));
			}
			const method = init?.method ?? 'GET';
			asked.push({ url, method, cache: init?.cache });
			if (stalled(url)) {
				return new Promise((_, reject) => {
					init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
				});
			}
			const build = holds(url);
			if (build === null) {
				return Promise.resolve(new Response(null, { status: 204 }));
			}
			const body = method === 'HEAD' ? null : `${build} ${url}`;
			return Promise.resolve(new Response(body, { headers: { ETag: `"${build}"` } }));
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const wp = (id: string, lat: number, lon: number) => ({
		id,
		lat,
		lon,
		kind: 'free' as const,
		alt: 3000,
		altAuto: true,
	});
	const leg = [wp('a', 45.63, 6.79), wp('b', 45.66, 6.83)];

	async function modules() {
		const { routes } = await import('$lib/state/route.svelte');
		const terrain = await import('$lib/state/offlineTerrain.svelte');
		const { whenDrained } = await import('$lib/state/offlineQueue.svelte');
		const store = await import('$lib/offline/passiveStore');
		const { tileUrl } = await import('$lib/map/terrain');
		const plan = (waypoints: ReturnType<typeof wp>[]) => {
			routes.list = [{ id: 'r', name: null, waypoints, selectedWaypointId: null }];
		};
		return { plan, terrain, whenDrained, store, tileUrl };
	}

	it('reads again on an Update the tiles a rebuild changed, and only those', async () => {
		const { plan, terrain, whenDrained, store } = await modules();
		// No finer tier reaches the z11 tiles yet: the server answers 204.
		holds = (u) => (u.includes('/terrain/11/') ? null : 'old');
		plan(leg);
		terrain.downloadTerrainPins();
		await whenDrained();
		const pinned = [...(await store.pinnedKeys())];
		// The rebuild writes a z11 tier and rewrites z12, and the passive LRU
		// still holds the copies read before the pin, as the Android shell's
		// may.
		holds = (u) => (u.includes('/terrain/11/') || u.includes('/terrain/12/') ? 'new' : 'old');
		const changed = pinned.filter((u) => holds(u) === 'new');
		expect(changed.length).toBeGreaterThan(0);
		expect(changed.length).toBeLessThan(pinned.length);
		for (const u of pinned) {
			await store.cachePut(u, new Blob([`lru ${u}`]));
		}
		asked = [];
		terrain.downloadTerrainPins();
		await whenDrained();
		expect(terrain.offlineTerrain.status).toBe('ready');
		for (const u of pinned) {
			expect(await (await store.passiveFetchBlob(u))?.text()).toBe(`${holds(u)} ${u}`);
		}
		// A HEAD for each pin holding an ETag, and a GET for the changed
		// alone, past the service worker's cache, which holds the old copy.
		const gets = asked.filter((a) => a.method === 'GET');
		expect(gets.map((a) => a.url).sort()).toEqual([...changed].sort());
		expect(gets.every((a) => a.cache === 'reload')).toBe(true);
		const heads = asked.filter((a) => a.method === 'HEAD').map((a) => a.url);
		expect(heads.sort()).toEqual(pinned.filter((u) => !u.includes('/terrain/11/')).sort());
	});

	it('pins a new leg before it asks about the old tiles', async () => {
		const { plan, terrain, whenDrained, store, tileUrl } = await modules();
		plan(leg);
		terrain.downloadTerrainPins();
		await whenDrained();
		const before = await store.pinnedKeys();
		// A diversion, over a link that holds every old tile's read open:
		// the new leg's tiles still land.
		plan([...leg, wp('c', 45.8, 7.0)]);
		stalled = (url) => before.has(url);
		terrain.downloadTerrainPins();
		const fresh = corridorTerrainTiles(terrain.planRoutePoints(), terrain.pinRadiusNM(), terrain.pinLevels())
			.map((t) => tileUrl(t.z, t.x, t.y))
			.filter((u) => !before.has(u));
		expect(fresh.length).toBeGreaterThan(0);
		try {
			await vi.waitFor(
				async () => {
					const now = await store.pinnedKeys();
					expect(fresh.filter((u) => !now.has(u))).toEqual([]);
				},
				{ timeout: 5_000 },
			);
		} finally {
			terrain.cancelTerrainPins();
			await whenDrained();
		}
	});
});
