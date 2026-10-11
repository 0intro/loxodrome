/* The cruise speed while the selected plane has not resolved, and once it has
 * (state/aircraft.svelte.ts automaticCruiseSpeedKt).
 *
 * The Route tab's Cruise box is the flight plan's own speed, a manual
 * override over the automatic one, the selected plane's data-sheet speed,
 * which the box shows in grey. A library plane resolves only once the library
 * lands, which a retry can bring at any moment, in flight included: until
 * then the plan flies the speed that plane had when it last resolved, never
 * the 100 kt default; the landing never touches a speed the pilot typed; and
 * nothing typed in the Route tab ever writes the plane's sheet. F-GIEQ cruises
 * at 110 kt, apart from both the default and the remembered speed below. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failTimes, serve, serveCoverageSite, serveText } from './helpers/coverageSite';
import { memoryStorage } from './helpers/storage';

const SHEET_KT = 110;

function site(store: Record<string, string>): void {
	vi.stubGlobal('localStorage', memoryStorage(store));
	serveCoverageSite();
	serve('/data/aircraft.meta.json', { generatedAt: 'x', aircraftCount: 1, files: ['f-gieq.yaml'], counts: {} });
	serveText('/data/aircraft/f-gieq.yaml', readFileSync('public/data/aircraft/f-gieq.yaml', 'utf8'));
}

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('the cruise speed around a late library', () => {
	it('flies the plane last known speed until the plane resolves, then its sheet speed', async () => {
		site({
			'loxodrome:aircraft-selected': 'F-GIEQ',
			'loxodrome:aircraft-cruise': JSON.stringify({ key: 'F-GIEQ', kt: 97 }),
		});
		failTimes('/data/aircraft.meta.json', 1, 503);
		const aircraft = await import('$lib/state/aircraft.svelte');
		const route = await import('$lib/state/route.svelte');
		const retry = await import('$lib/state/dataRetry.svelte');
		await vi.advanceTimersByTimeAsync(0);
		expect(retry.retryPending('aircraft')).toBe(true);
		expect(aircraft.aircraftByKey('F-GIEQ')).toBeNull();
		expect(aircraft.automaticCruiseSpeedKt()).toBe(97);
		expect(aircraft.effectiveCruiseSpeedKt()).toBe(97);
		await vi.advanceTimersByTimeAsync(6_000);
		expect(aircraft.aircraftState.libraryLoaded).toBe(true);
		expect(aircraft.effectiveCruiseSpeedKt()).toBe(SHEET_KT);
		// The plan stays automatic, and the new speed is remembered.
		expect(route.routeSettings.cruiseSpeedKt).toBeNull();
		expect(JSON.parse(localStorage.getItem('loxodrome:aircraft-cruise') ?? 'null')).toEqual({ key: 'F-GIEQ', kt: SHEET_KT });
		retry.resetDataRetryForTest();
	});

	it('keeps a speed typed before the landing as the plan own, the sheet untouched', async () => {
		site({ 'loxodrome:aircraft-selected': 'F-GIEQ' });
		failTimes('/data/aircraft.meta.json', 1, 503);
		const aircraft = await import('$lib/state/aircraft.svelte');
		const route = await import('$lib/state/route.svelte');
		const retry = await import('$lib/state/dataRetry.svelte');
		await vi.advanceTimersByTimeAsync(0);
		// Nothing remembered for this plane yet: the default, until it resolves.
		expect(aircraft.automaticCruiseSpeedKt()).toBe(route.DEFAULT_CRUISE_KT);
		route.routeSettings.cruiseSpeedKt = 111;
		await vi.advanceTimersByTimeAsync(6_000);
		expect(aircraft.aircraftState.libraryLoaded).toBe(true);
		expect(route.routeSettings.cruiseSpeedKt).toBe(111);
		expect(aircraft.effectiveCruiseSpeedKt()).toBe(111);
		expect(aircraft.automaticCruiseSpeedKt()).toBe(SHEET_KT);
		expect(aircraft.aircraftByKey('F-GIEQ')?.cruise?.speedKt).toBe(SHEET_KT);
		expect(aircraft.aircraftState.user).toEqual({});
		retry.resetDataRetryForTest();
	});

	it('plans at 100 kt with no plane selected, a remembered speed for another plane ignored', async () => {
		site({ 'loxodrome:aircraft-cruise': JSON.stringify({ key: 'F-GIEQ', kt: 97 }) });
		const aircraft = await import('$lib/state/aircraft.svelte');
		const route = await import('$lib/state/route.svelte');
		expect(aircraft.automaticCruiseSpeedKt()).toBe(route.DEFAULT_CRUISE_KT);
		expect(aircraft.effectiveCruiseSpeedKt()).toBe(100);
	});
});
