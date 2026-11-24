/* The service worker's runtime rules for /data/ and the terrain tiles
 * (vite.config.ts, docs/pwa.md), judged as the worker judges them: Workbox
 * answers a request with the FIRST rule whose pattern matches, so a path is
 * run through the configured list in order, and a request no rule matches
 * goes to the network. The plugin is replaced by a stub that hands back the
 * options it was given. */

import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('vite-plugin-pwa', () => ({ VitePWA: (options: unknown) => ({ name: 'pwa-options', options }) }));
vi.mock('@sveltejs/vite-plugin-svelte', () => ({ svelte: () => ({ name: 'svelte' }) }));

interface Rule {
	urlPattern: (o: { url: URL; request: { cache: RequestCache } }) => boolean;
	handler: string;
	options: {
		cacheName: string;
		networkTimeoutSeconds?: number;
		expiration?: { maxEntries: number; maxAgeSeconds: number };
	};
}

const ORIGIN = 'https://loxodrome.fr';
let rules: Rule[] = [];

beforeAll(async () => {
	vi.stubGlobal('self', { location: { origin: ORIGIN } });
	const config = (await import('../vite.config')).default as unknown as (env: {
		command: string;
		mode: string;
	}) => { plugins: { name: string; options?: { workbox: { runtimeCaching: Rule[] } } }[] };
	const pwa = config({ command: 'build', mode: 'production' }).plugins.find((p) => p.name === 'pwa-options');
	rules = pwa?.options?.workbox.runtimeCaching ?? [];
});

/** The rule the worker answers a same-origin path with, asked in a cache
 *  mode. */
function ruleFor(path: string, cache: RequestCache = 'default'): Rule | undefined {
	const url = new URL(path, ORIGIN);
	return rules.find((r) => r.urlPattern({ url, request: { cache } }));
}

const MONTH = 60 * 60 * 24 * 30;

describe('a dataset in the service worker', () => {
	it.each(['/data/fr-airspaces.json', '/data/fr-airspaces.next.json', '/data/aircraft/f-gieq.yaml'])(
		'%s is read network first, the cache its offline fallback for a month',
		(path) => {
			// Its URL is the same in every AIRAC cycle: answered from the
			// cache first, the first session after a deploy would pair the
			// sidecars' new cycle with the last cycle's rows.
			const r = ruleFor(path);
			expect(r?.handler).toBe('NetworkFirst');
			expect(r?.options.cacheName).toBe('datasets');
			expect(r?.options.networkTimeoutSeconds).toBe(3);
			expect(r?.options.expiration?.maxAgeSeconds).toBe(MONTH);
		},
	);
});

describe('a sidecar in the service worker', () => {
	it.each(['/data/fr-airspaces.meta.json', '/data/fr-airspaces.next.meta.json'])(
		'%s is kept as long as the datasets it picks between',
		(path) => {
			// Offline, the sidecars pick the file to read. Expired before
			// the data, they read as none, which picks the current slot: a
			// session past an AIRAC date would draw the superseded cycle and
			// say nothing.
			const r = ruleFor(path);
			expect(r?.handler).toBe('NetworkFirst');
			expect(r?.options.cacheName).toBe('dataset-meta');
			expect(r?.options.expiration?.maxAgeSeconds).toBe(MONTH);
		},
	);
});

describe('a terrain tile in the service worker', () => {
	const tile = '/terrain/12/2074/1409';

	it('is read from the cache first', () => {
		const r = ruleFor(tile);
		expect(r?.handler).toBe('CacheFirst');
		expect(r?.options.cacheName).toBe('terrain-tiles');
	});

	it('is left to the network when the pin job reads a pinned tile again', () => {
		// The cache holds the copy the pin was taken from: answered from it,
		// an Update would write the pin's own bytes back over a rebuilt tile.
		expect(ruleFor(tile, 'reload')).toBeUndefined();
	});
});
