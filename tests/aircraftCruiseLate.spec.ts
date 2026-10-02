/* A cruise speed typed before the selected plane resolves is the pilot's
 * (state/aircraft.svelte.ts commitCruiseSpeed).
 *
 * The cruise speed is one value shared by the Route tab and the selected
 * plane's data sheet. While the library had not loaded, a speed typed in the
 * Route tab lived in the route settings alone, and the library landing then
 * put the sheet's own speed back over it. A retry can land the library at any
 * moment now, in flight included, so the ETEs and the fuel changed under the
 * pilot without a word. The typed speed is the plane's once it resolves, as
 * it would have been had the plane been there to take it. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failTimes, serve, serveCoverageSite, serveText } from './helpers/coverageSite';
import { memoryStorage } from './helpers/storage';

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	vi.stubGlobal('localStorage', memoryStorage({ 'loxodrome:aircraft-selected': 'F-GORQ' }));
	serveCoverageSite();
	serve('/data/aircraft.meta.json', { generatedAt: 'x', aircraftCount: 1, files: ['f-gorq.yaml'], counts: {} });
	serveText('/data/aircraft/f-gorq.yaml', readFileSync('public/data/aircraft/f-gorq.yaml', 'utf8'));
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('a cruise speed typed before the library lands', () => {
	it('is the plane speed once the retry lands the library', async () => {
		failTimes('/data/aircraft.meta.json', 1, 503);
		const aircraft = await import('$lib/state/aircraft.svelte');
		const route = await import('$lib/state/route.svelte');
		const retry = await import('$lib/state/dataRetry.svelte');
		await vi.advanceTimersByTimeAsync(0);
		expect(retry.retryPending('aircraft')).toBe(true);
		expect(aircraft.aircraftByKey('F-GORQ')).toBeNull();
		// The Route tab: the field's input, then its change.
		route.routeSettings.cruiseSpeedKt = 111;
		aircraft.commitCruiseSpeed(111);
		await vi.advanceTimersByTimeAsync(6_000);
		expect(aircraft.aircraftState.libraryLoaded).toBe(true);
		expect(route.routeSettings.cruiseSpeedKt).toBe(111);
		expect(aircraft.aircraftByKey('F-GORQ')?.cruise?.speedKt).toBe(111);
		retry.resetDataRetryForTest();
	});

	it('leaves the sheet speed in force when nothing was typed', async () => {
		failTimes('/data/aircraft.meta.json', 1, 503);
		const aircraft = await import('$lib/state/aircraft.svelte');
		const route = await import('$lib/state/route.svelte');
		const retry = await import('$lib/state/dataRetry.svelte');
		await vi.advanceTimersByTimeAsync(6_000);
		const sheet = aircraft.aircraftByKey('F-GORQ')?.cruise?.speedKt;
		expect(sheet).toBeGreaterThan(0);
		expect(route.routeSettings.cruiseSpeedKt).toBe(sheet);
		expect(aircraft.aircraftState.user).toEqual({});
		retry.resetDataRetryForTest();
	});
});
