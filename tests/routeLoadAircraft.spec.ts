/* A plan naming a library plane, opened before the aircraft library loaded
 * (state/routeLoad.svelte.ts loadRoutesFromYaml).
 *
 * The library loads at startup only for a persisted selection. A plan opened
 * or activated on a device with none (a fresh one, or one whose pilot never
 * picked a plane) found the fleet empty: its own club plane was reported
 * "not in your fleet" and the cruise speed read the default, and the notice
 * stayed up once the library had landed. The load now waits for the library
 * as it waits for the airports and navaids, and the notice is read against
 * the fleet at render (unknownAircraftShown), so a library that failed and
 * came back takes it down. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { failTimes, serve, serveCoverageSite, serveText } from './helpers/coverageSite';
import { memoryStorage } from './helpers/storage';

const SHEET = readFileSync('public/data/aircraft/f-gorq.yaml', 'utf8');

function plan(aircraft: string): string {
	return [
		'version: 1',
		'routes:',
		'  - waypoints:',
		'      - lat: 48.82',
		'        lon: 2.62',
		'      - lat: 48.84',
		'        lon: 3.01',
		'flight_prep:',
		`  aircraft: ${aircraft}`,
		'',
	].join('\n');
}

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	globalThis.indexedDB = new IDBFactory();
	// No persisted selection: nothing loads the library at startup.
	vi.stubGlobal('localStorage', memoryStorage({}));
	vi.stubGlobal('location', { search: '' });
	serveCoverageSite();
	serve('/data/aircraft.meta.json', { generatedAt: 'x', aircraftCount: 1, files: ['f-gorq.yaml'], counts: {} });
	serveText('/data/aircraft/f-gorq.yaml', SHEET);
	vi.doMock('$lib/state/data.svelte', async () => {
		const actual = await vi.importActual<typeof import('$lib/state/data.svelte')>('$lib/state/data.svelte');
		return { ...actual, ensureAirports: () => Promise.resolve([]), ensureNavaids: () => Promise.resolve([]) };
	});
});

afterEach(async () => {
	const retry = await import('$lib/state/dataRetry.svelte');
	retry.resetDataRetryForTest();
	vi.doUnmock('$lib/state/data.svelte');
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function mods() {
	return {
		load: await import('$lib/state/routeLoad.svelte'),
		aircraft: await import('$lib/state/aircraft.svelte'),
	};
}

// The first case imports the loader's whole module graph cold.
describe('a plan naming a library plane, opened before the library loaded', { timeout: 20_000 }, () => {
	it('waits for the library: no "not in your fleet", the plane and its speed in force', async () => {
		const { load, aircraft } = await mods();
		expect(aircraft.aircraftState.libraryLoaded).toBe(false);
		expect(await load.loadRoutesFromYaml(plan('F-GORQ'))).toBe(true);
		expect(aircraft.aircraftState.libraryLoaded).toBe(true);
		expect(load.routeLoad.notice?.unknownAircraft).toBeNull();
		expect(load.unknownAircraftShown()).toBeNull();
		expect(aircraft.aircraftState.selectedKey).toBe('F-GORQ');
		const sheet = aircraft.aircraftByKey('F-GORQ')?.cruise?.speedKt;
		expect(sheet).toBeGreaterThan(0);
		expect(aircraft.effectiveCruiseSpeedKt()).toBe(sheet);
	});

	it('still reports a plane the fleet does not hold', async () => {
		const { load } = await mods();
		await load.loadRoutesFromYaml(plan('F-ZZZZ'));
		expect(load.routeLoad.notice?.unknownAircraft).toBe('F-ZZZZ');
		expect(load.unknownAircraftShown()).toBe('F-ZZZZ');
	});

	it('takes the notice down once a library that failed lands', async () => {
		failTimes('/data/aircraft.meta.json', 1, 503);
		const { load, aircraft } = await mods();
		await load.loadRoutesFromYaml(plan('F-GORQ'));
		expect(aircraft.aircraftState.libraryLoaded).toBe(false);
		expect(load.unknownAircraftShown()).toBe('F-GORQ');
		await vi.advanceTimersByTimeAsync(6_000);
		expect(aircraft.aircraftState.libraryLoaded).toBe(true);
		expect(load.unknownAircraftShown()).toBeNull();
	});
});
