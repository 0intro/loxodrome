/* The Android shell's cached map tiles (offline/passiveTiles.ts), against
 * Leaflet 1.9.4 in Node. A tile fetched with no budget reached its stored copy
 * only when the fetch rejected: on a fading link that holds a socket open, the
 * tiles the passive cache held stayed blank until the system gave up on it.
 * The fetch now runs within the tile reads' budget (TILE_FETCH_TIMEOUT_MS). */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installLeafletNode } from './helpers/leafletNode';

vi.mock('$lib/native/platform', () => ({ isNativeApp: () => true }));

const cache = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock('$lib/offline/passiveStore', async (orig) => ({
	...(await orig<typeof import('../src/lib/offline/passiveStore')>()),
	cacheGet: (url: string) => {
		cache.asked.push(url);
		return Promise.resolve(new Blob([new Uint8Array(8)], { type: 'image/png' }));
	},
	cachePut: () => Promise.resolve(),
}));

installLeafletNode();
const { cachedTileLayer } = await import('$lib/offline/passiveTiles');
const { TILE_FETCH_TIMEOUT_MS } = await import('$lib/offline/passiveStore');

const URL_ = 'https://tiles.example/6/32/22.png';

afterEach(() => {
	cache.asked.length = 0;
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('a cached tile layer in the shell', () => {
	it('draws the stored copy of a tile whose fetch stalls, once the budget runs out', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		vi.stubGlobal(
			'fetch',
			(_url: string, init?: RequestInit) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
				}),
		);
		const layer = cachedTileLayer('https://tiles.example/{z}/{x}/{y}.png', {}) as unknown as {
			getTileUrl: () => string;
			createTile: (coords: unknown, done: () => void) => { src?: string };
		};
		layer.getTileUrl = () => URL_;
		const img = layer.createTile({ x: 32, y: 22, z: 6 }, () => {});
		await vi.advanceTimersByTimeAsync(TILE_FETCH_TIMEOUT_MS - 1_000);
		expect(cache.asked).toEqual([]);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(cache.asked).toEqual([URL_]);
		expect(img.src).toMatch(/^blob:/);
	});
});
