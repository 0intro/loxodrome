/* The place names in the app (src/lib/data/places.ts, the loader, and
 * src/lib/state/places.svelte.ts, the store): read per country by area from
 * one index that is every file's sidecar, widened as the coverage moves and
 * by "Search all countries", a failing country retried on the one schedule
 * (docs/places.md "App side"). Real modules over a served site, a fresh
 * graph per case. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PARIS, failAlways, fetched, serve, serveCoverageSite } from './helpers/coverageSite';

const MUNICH = { minLat: 48.0, minLon: 11.4, maxLat: 48.3, maxLon: 11.8 };

const INDEX = {
	generatedAt: '2026-10-19T00:00:00.000Z',
	placeCount: 3,
	sources: {},
	countries: {
		fr: { source: 'ign', rows: 2, minPop: 0, bbox: [-5.2, 41.3, 9.6, 51.1] },
		de: { source: 'geonames', rows: 1, minPop: 1000, bbox: [5.9, 47.3, 15.0, 55.1] },
		gp: { source: 'ign', rows: 0, minPop: 0, bbox: [-61.8, 15.8, -61.0, 16.5] },
	},
};
const FR = {
	fields: ['id', 'name', 'lat', 'lon', 'pop', 'admin', 'alt'],
	admins: { '91': 'Essonne' },
	rows: [
		['fr:91223', 'Étampes', 48.435, 2.161, 26857, '91', ''],
		['fr:91999', 'Nulle-Part', 48.5, 2.2, null, null, ''],
	],
};
const DE = {
	fields: ['id', 'name', 'lat', 'lon', 'pop', 'admin', 'alt'],
	admins: { '02': 'Bavaria' },
	rows: [['de:2867714', 'München', 48.137, 11.575, 1260391, '02', 'Munich|Munique']],
};

beforeEach(() => {
	vi.resetModules();
	serveCoverageSite();
	serve('/data/places.meta.json', INDEX);
	serve('/data/places-fr.json', FR);
	serve('/data/places-de.json', DE);
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function mods() {
	return {
		cov: await import('$lib/state/coverage.svelte'),
		data: await import('$lib/state/data.svelte'),
		places: await import('$lib/state/places.svelte'),
		retry: await import('$lib/state/dataRetry.svelte'),
	};
}

describe('loadPlaces', () => {
	it('names the division, keeps an unknown population null and says whose file it is', async () => {
		const { loadPlaces } = await import('$lib/data/places');
		const [etampes, nowhere] = await loadPlaces('fr', true);
		expect(etampes).toEqual({
			id: 'fr:91223',
			country: 'FR',
			name: 'Étampes',
			lat: 48.435,
			lon: 2.161,
			pop: 26857,
			admin: 'Essonne',
			alt: '',
			commune: true,
		});
		expect([nowhere.pop, nowhere.admin]).toEqual([null, '']);
		const [munich] = await loadPlaces('de', false);
		expect([munich.admin, munich.alt, munich.commune]).toEqual(['Bavaria', 'Munich|Munique', false]);
		expect(await loadPlaces('xx', false)).toEqual([]);
	});
});

describe('the places store', () => {
	it('reads the countries the areas reach, and widens as they move', async () => {
		const { cov, data, places } = await mods();
		cov.setCoverageViewport(PARIS);
		const first = await places.ensurePlaces();
		expect(first.map((p) => p.name)).toEqual(['Étampes', 'Nulle-Part']);
		expect(fetched('/data/places-de.json')).toBe(0);
		expect(fetched('/data/places-gp.json')).toBe(0);
		cov.setCoverageViewport(MUNICH);
		await data.extendCoverage();
		expect(places.getPlaces()?.map((p) => p.name)).toEqual(['Étampes', 'Nulle-Part', 'München']);
		expect(places.loadedPlaceCountries()).toEqual(['fr', 'de']);
		expect(fetched('/data/places-fr.json')).toBe(1);
	});

	it('reads every country under "Search all countries"', async () => {
		const { cov, data, places } = await mods();
		cov.setCoverageViewport(PARIS);
		await places.ensurePlaces();
		await data.searchAllCountries();
		expect(fetched('/data/places-de.json')).toBe(1);
		expect(fetched('/data/places-gp.json')).toBe(1);
	});

	it('is no places, without an error, where the deployment holds no index', async () => {
		serveCoverageSite();
		const { cov, places } = await mods();
		cov.setCoverageViewport(PARIS);
		expect(await places.ensurePlaces()).toEqual([]);
		expect(places.placesState.error).toBeNull();
	});

	it('publishes around a country that fails, retrying it quietly when it is far', async () => {
		const { cov, places, retry } = await mods();
		try {
			cov.setCoverageViewport(PARIS);
			failAlways('/data/places-de.json', 503);
			cov.setSearchAll(true);
			const got = await places.ensurePlaces();
			expect(got.map((p) => p.name)).toEqual(['Étampes', 'Nulle-Part']);
			expect(retry.dataRetry.pending.find((p) => p.key === 'places:de')?.quiet).toBe(true);
		} finally {
			retry.resetDataRetryForTest();
		}
	});

	it('fails a first load that nothing answered, for its retry', async () => {
		const { cov, places, retry } = await mods();
		try {
			cov.setCoverageViewport(PARIS);
			failAlways('/data/places-fr.json', 503);
			await expect(places.ensurePlaces()).rejects.toThrow();
			expect(retry.dataRetry.pending.some((p) => p.group === 'places')).toBe(true);
		} finally {
			retry.resetDataRetryForTest();
		}
	});

	it('is never asked for by a widening alone, so the NOTAM Viewer reads none', async () => {
		const { cov, data } = await mods();
		cov.setCoverageViewport(PARIS);
		await data.extendCoverage();
		expect(fetched('/data/places.meta.json')).toBe(0);
	});
});

describe('the index in the service worker', () => {
	it('has a network-first rule of its own, kept a month, ahead of every /data/ rule', () => {
		const cfg = readFileSync('vite.config.ts', 'utf8');
		const caching = cfg.slice(cfg.indexOf('runtimeCaching: ['));
		const own = caching.indexOf("url.pathname === '/data/places.meta.json'");
		const firstData = caching.indexOf("url.pathname.startsWith('/data/')");
		expect(own).toBeGreaterThan(-1);
		expect(firstData).toBeGreaterThan(own);
		const rule = caching.slice(own, firstData);
		expect(rule).toContain("handler: 'NetworkFirst'");
		expect(rule).toContain("cacheName: 'places-index'");
		expect(rule).toContain('maxAgeSeconds: 60 * 60 * 24 * 30');
	});
});
