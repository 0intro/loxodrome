/* The single-file datasets read again what failed: the chart links, the
 * aerodrome facilities, the METAR station catalog, the FAA designators, the
 * fuel grades, the VAC georeference and the aircraft library
 * (state/adCharts, referenceData, aerodromeFuel, vacGeo, aircraft).
 *
 * Their loaders folded a 503 into an empty list, kept as the dataset for the
 * session (an aerodrome's charts, its directory, its fuel, the VAC layer
 * gone without a word), or threw it and were asked again by every panel
 * that opened. A failure worth asking again now waits for its retry, one
 * read for however many asks, and lands on its own. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failTimes, fetched, serve, serveCoverageSite, settle } from './helpers/coverageSite';

let retry: typeof import('$lib/state/dataRetry.svelte');

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
	vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
	serveCoverageSite();
	serve('/data/faa-designators.json', { designators: [], types: [] });
	serve('/data/aircraft.meta.json', { generatedAt: 'x', aircraftCount: 0, files: [], counts: {} });
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	retry.resetDataRetryForTest();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

interface Set_ {
	file: string;
	key: string;
	/** Ask for the set; the aircraft library's ensure never rejects. */
	ask: () => Promise<unknown>;
	loaded: () => boolean;
	rejects: boolean;
}

async function sets(): Promise<Record<string, Set_>> {
	retry = await import('$lib/state/dataRetry.svelte');
	const charts = await import('$lib/state/adCharts.svelte');
	const ref = await import('$lib/state/referenceData.svelte');
	const fuel = await import('$lib/state/aerodromeFuel.svelte');
	const vac = await import('$lib/state/vacGeo.svelte');
	const aircraft = await import('$lib/state/aircraft.svelte');
	return {
		frCharts: { file: '/data/fr-adcharts.json', key: 'charts:fr', ask: charts.ensureFrAdCharts, loaded: () => charts.adChartsState.fr.loaded, rejects: true },
		ukCharts: { file: '/data/uk-adcharts.json', key: 'charts:uk', ask: charts.ensureUkAdCharts, loaded: () => charts.adChartsState.uk.loaded, rejects: true },
		usCharts: { file: '/data/us-adcharts.json', key: 'charts:us', ask: charts.ensureUsAdCharts, loaded: () => charts.adChartsState.us.loaded, rejects: true },
		atCharts: { file: '/data/at-adcharts.json', key: 'charts:at', ask: charts.ensureAtAdCharts, loaded: () => charts.adChartsState.at.loaded, rejects: true },
		deCharts: { file: '/data/de-adcharts.json', key: 'charts:de', ask: charts.ensureDeAdCharts, loaded: () => charts.adChartsState.de.loaded, rejects: true },
		skCharts: { file: '/data/sk-adcharts.json', key: 'charts:sk', ask: () => charts.ensureAipCharts('LZIB'), loaded: () => charts.aipChartsState.sk.loaded, rejects: true },
		facilities: { file: '/data/fr-aerodrome-facilities.json', key: 'facilities:fr', ask: () => ref.ensureAerodromeFacilities('fr'), loaded: () => ref.referenceDataState.facilitiesLoaded, rejects: true },
		metarStations: { file: '/data/metar-stations.json', key: 'metarStations', ask: ref.ensureMetarStationCatalog, loaded: () => ref.referenceDataState.metarCatalogLoaded, rejects: true },
		designators: { file: '/data/faa-designators.json', key: 'designators', ask: ref.ensureFaaDesignators, loaded: () => ref.referenceDataState.designatorsLoaded, rejects: true },
		fuel: { file: '/data/fr-fuel.json', key: 'fuel', ask: () => fuel.ensureAerodromeFuel('fr'), loaded: () => fuel.aerodromeFuelState.loaded, rejects: true },
		vacgeo: { file: '/data/fr-vacgeo.json', key: 'vacgeo', ask: vac.ensureVacGeo, loaded: () => vac.vacGeoState.loaded, rejects: true },
		aircraft: { file: '/data/aircraft.meta.json', key: 'aircraft', ask: aircraft.ensureAircraftLibrary, loaded: () => aircraft.aircraftState.libraryLoaded, rejects: false },
	};
}

const NAMES = [
	'frCharts',
	'ukCharts',
	'usCharts',
	'atCharts',
	'deCharts',
	'skCharts',
	'facilities',
	'metarStations',
	'designators',
	'fuel',
	'vacgeo',
	'aircraft',
];

describe('a single-file dataset whose read failed', () => {
	it.each(NAMES)('%s: waits for its retry, one read however often it is asked, then lands', async (name) => {
		const set = (await sets())[name];
		failTimes(set.file, 1, 503);
		if (set.rejects) {
			await expect(set.ask()).rejects.toMatchObject({ transient: true });
		} else {
			await expect(set.ask()).resolves.toBeUndefined();
		}
		expect(set.loaded()).toBe(false);
		expect(retry.retryPending(set.key)).toBe(true);
		for (let i = 0; i < 50; i++) {
			await set.ask().catch(() => {});
		}
		expect(fetched(set.file)).toBe(1);
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(fetched(set.file)).toBe(2);
		expect(set.loaded()).toBe(true);
		expect(retry.retryPending(set.key)).toBe(false);
		await set.ask();
		expect(fetched(set.file)).toBe(2);
	});

	it.each(NAMES.filter((n) => n !== 'aircraft' && n !== 'designators'))(
		'%s: answers empty for a file the deployment does not hold, never asked again',
		async (name) => {
			const set = (await sets())[name];
			failTimes(set.file, 1, 404);
			await expect(set.ask()).resolves.toEqual([]);
			expect(retry.retryPending(set.key)).toBe(false);
			await vi.advanceTimersByTimeAsync(600_000);
			expect(fetched(set.file)).toBe(1);
		},
	);
});

describe('a single-file dataset whose rows do not index', () => {
	// The value was stored before its index was built: a row the index
	// could not take (no ident) threw with the value in place, the retry
	// then found it there and returned without reading, and the entry was
	// rescheduled for good, a banner line with no read behind it. The value
	// is now stored last, and a retry finding it present clears its key.
	it.each([
		['frCharts', { fields: [], chartFields: [], rows: [[null, [], null]] }, { fields: [], chartFields: [], rows: [['LFPL', [], null]] }],
		['designators', { designators: ['C172'], types: [[null, 'CESSNA', '172']] }, { designators: ['C172'], types: [] }],
	])('%s: is read again at its retry, and lands once it does', async (name, bad, good) => {
		const set = (await sets())[name];
		serve(set.file, bad);
		await expect(set.ask()).rejects.toBeInstanceOf(TypeError);
		expect(set.loaded()).toBe(false);
		expect(retry.retryPending(set.key)).toBe(true);
		serve(set.file, good);
		await vi.advanceTimersByTimeAsync(300_000);
		await settle();
		expect(fetched(set.file)).toBe(2);
		expect(set.loaded()).toBe(true);
		expect(retry.retryPending(set.key)).toBe(false);
	});
});
