/* The flight in progress reaches the forecast's readers without waking them
 * per fix (state/navRoute.svelte.ts flightInProgress, two module-level
 * deriveds answering primitives). Every consumer of the plan's departure
 * (the nav log's winds, the warm effect, the period's hour) reads it inside
 * an effect or a derived, and a recording appends a fix a second: an answer
 * read straight off the trace would re-run them all each time. Client
 * project, so the effects really run; the fixes come through the real
 * recording path, off a stubbed geolocation. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MS_PER_KT = 1852 / 3600;
const T0 = Date.UTC(2026, 8, 27, 9, 30);
let onFix: ((p: unknown) => void) | null = null;

/** One geolocation fix north along 2°E. */
function pos(timeMs: number, lat: number, kt: number, altM: number): unknown {
	return {
		coords: {
			latitude: lat,
			longitude: 2,
			altitude: altM,
			altitudeAccuracy: null,
			accuracy: 5,
			speed: kt * MS_PER_KT,
			heading: 0,
		},
		timestamp: timeMs,
	};
}

beforeEach(() => {
	const store = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
	vi.stubGlobal('window', { isSecureContext: true, addEventListener: () => {}, removeEventListener: () => {} });
	vi.stubGlobal('document', {
		addEventListener: () => {},
		removeEventListener: () => {},
		visibilityState: 'visible',
		documentElement: { lang: 'en' },
	});
	vi.stubGlobal('navigator', {
		geolocation: {
			watchPosition: (cb: (p: unknown) => void) => {
				onFix = cb;
				return 1;
			},
			clearWatch: () => {},
		},
	});
	vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
	vi.setSystemTime(T0);
	vi.resetModules();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('the readers of the flight in progress', () => {
	it('run at the recording start and at the takeoff, never at an ordinary fix', async () => {
		const { flushSync } = await import('svelte');
		const { mountEffect } = await import('./helpers/derivedHost.svelte');
		const m = await import('$lib/state/navRecording.svelte');
		const rw = await import('$lib/state/routeWind.svelte');
		const seen: number[] = [];
		const e = mountEffect(() => {
			seen.push(rw.firstDepartureMs());
		});
		flushSync();
		m.startRecording();
		flushSync();
		const started = e.runs();
		// A minute on the ground, then the takeoff roll and the climb at 100 kt.
		let lat = 47;
		for (let i = 0; i < 60; i++) {
			onFix?.(pos(T0 + i * 1000, lat, 0, 90));
			flushSync();
		}
		expect(e.runs()).toBe(started);
		const takeoffMs = T0 + 60_000;
		for (let i = 0; i < 120; i++) {
			lat += 100 * MS_PER_KT / 111_000;
			onFix?.(pos(takeoffMs + i * 1000, lat, 100, 90 + i * 3));
			flushSync();
		}
		// One run, the takeoff committing, for the 180 fixes.
		expect(e.runs() - started).toBe(1);
		expect(seen.at(-1)).toBe(takeoffMs);
		m.stopRecording();
		flushSync();
		e.stop();
	});
});
