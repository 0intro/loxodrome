/* The aircraft library's ensure subscribes nobody (state/aircraft.svelte.ts),
 * in the client runtime where effects run (tests/env/webnode.ts).
 *
 * The editor's open effect, the Aircraft tab and the flight preparation call
 * ensureAircraftLibrary() from effects. It read the library's LOADED flag
 * first, a reactive read, so every one of them re-ran when the library
 * landed: the editor reseeded its draft over the pilot's typing, and closing
 * it then asked nothing. The ensure's own state is plain. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failTimes, hold, serve, serveCoverageSite, untilReal } from './helpers/coverageSite';

const META = { generatedAt: 'x', aircraftCount: 0, files: [], counts: {} };

beforeEach(() => {
	vi.resetModules();
	serveCoverageSite();
	serve('/data/aircraft.meta.json', META);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('an effect asking for the aircraft library', () => {
	it('does not run again when the library lands', async () => {
		const release = hold('/data/aircraft.meta.json');
		const { flushSync } = await import('svelte');
		const aircraft = await import('$lib/state/aircraft.svelte');
		const host = await import('./helpers/derivedHost.svelte');
		const effect = host.mountEffect(() => {
			void aircraft.ensureAircraftLibrary();
		});
		flushSync();
		expect(effect.runs()).toBe(1);
		release();
		await untilReal(() => aircraft.aircraftState.libraryLoaded);
		flushSync();
		expect(aircraft.aircraftState.libraryLoaded).toBe(true);
		expect(effect.runs()).toBe(1);
		effect.stop();
	});

	it('does not run again when its retry lands it', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		failTimes('/data/aircraft.meta.json', 1, 503);
		const { flushSync } = await import('svelte');
		const aircraft = await import('$lib/state/aircraft.svelte');
		const retry = await import('$lib/state/dataRetry.svelte');
		const host = await import('./helpers/derivedHost.svelte');
		void aircraft.ensureAircraftLibrary();
		await vi.advanceTimersByTimeAsync(0);
		expect(retry.retryPending('aircraft')).toBe(true);
		const effect = host.mountEffect(() => {
			void aircraft.ensureAircraftLibrary();
		});
		flushSync();
		expect(effect.runs()).toBe(1);
		await vi.advanceTimersByTimeAsync(6_000);
		flushSync();
		expect(aircraft.aircraftState.libraryLoaded).toBe(true);
		expect(effect.runs()).toBe(1);
		effect.stop();
		retry.resetDataRetryForTest();
	});
});
