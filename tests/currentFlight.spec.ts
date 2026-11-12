/* The flight being flown (state/currentFlight.ts), which the toolbar pill's
 * elapsed, the Flight page's recording chip and its live summary card read.
 * A trace can hold several flights since "Add to this trace" records the next
 * leg at the end of the landed one, so neither the trace's first fix nor the
 * fold's first takeoff says when the flight in hand began. Driven through the
 * real recording state, the platform's geolocation faked, since what "this
 * recording" means is where its start found the trace.
 *
 * Fresh module graph per case: the trace and the memo live in module state. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackPoint } from '$lib/nav/trace';
import { memoryStorage } from './helpers/storage';

// Each case imports a fresh module graph, which a loaded machine can take
// past the default five seconds to transform.
vi.setConfig({ testTimeout: 30_000 });

const T0 = Date.UTC(2026, 6, 21, 10, 0);
const MIN = 60_000;

let onFix: ((p: unknown) => void) | null = null;

beforeEach(() => {
	onFix = null;
	vi.stubGlobal('localStorage', memoryStorage());
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
	vi.resetModules();
});

let stop: (() => void) | null = null;

afterEach(() => {
	stop?.();
	stop = null;
	vi.unstubAllGlobals();
});

/** One fix a minute along the equator at the given speeds (logbook.spec's
 *  outing factory). */
function outing(speeds: number[], baseMs = T0): TrackPoint[] {
	let lon = 0;
	return speeds.map((kt, i) => {
		const p = { lat: 0, lon, timeMs: baseMs + i * MIN, altFt: null, speedKt: kt, trackDeg: 90, accuracyM: 5 };
		lon += kt / 3600;
		return p;
	});
}

/** Taxi, fly, land, taxi in, park: one flight, landed. */
const ONE = [5, 100, 100, 100, 5, 5, 5, 0, 0, 0];

async function load() {
	const n = await import('$lib/state/navRecording.svelte');
	const c = await import('$lib/state/currentFlight');
	stop = () => {
		if (n.nav.recording) {
			n.stopRecording();
		}
	};
	return { ...n, ...c };
}

/** A geolocation fix at `timeMs`, standing still or at `kt`. */
function fix(timeMs: number, kt = 0, lon = 0.2): unknown {
	return {
		coords: { latitude: 0, longitude: lon, altitude: null, altitudeAccuracy: null, accuracy: 5, speed: kt * (1852 / 3600), heading: 90 },
		timestamp: timeMs,
	};
}

describe('the last flight', () => {
	it('is none before a takeoff, and the first flight with its own flags', async () => {
		const m = await load();
		expect(m.liveLastFlight()).toBeNull();
		m.nav.points = outing([5, 5, 5]);
		expect(m.liveLastFlight()).toBeNull();
		m.nav.points = outing(ONE);
		// The trace opens already taxiing, so its block-off is not seen: the
		// first flight carries the fold's own flags.
		expect(m.liveLastFlight()).toMatchObject({
			index: 1,
			count: 1,
			blockOffMs: T0,
			takeoffMs: T0 + MIN,
			landingMs: T0 + 4 * MIN,
			blockOnMs: T0 + 6 * MIN,
			blockOutObserved: false,
			takeoffObserved: true,
		});
		// A later flight is seen whole by construction.
		m.nav.points = outing([...ONE, 5, 100, 100]);
		expect(m.liveLastFlight()).toMatchObject({ blockOutObserved: true, takeoffObserved: true });
	});

	it('is the second of two, cut at the parking between them', async () => {
		const m = await load();
		m.nav.points = outing([...ONE, 5, 100, 100]);
		expect(m.liveLastFlight()).toMatchObject({
			index: 2,
			count: 2,
			blockOffMs: T0 + 10 * MIN,
			takeoffMs: T0 + 11 * MIN,
			landingMs: null,
			blockOnMs: null,
		});
	});

	it('follows a replaced trace holding as many takeoffs', async () => {
		const m = await load();
		m.nav.points = outing(ONE);
		expect(m.liveLastFlight()?.blockOffMs).toBe(T0);
		m.nav.points = outing(ONE, T0 + 60 * MIN);
		expect(m.liveLastFlight()?.blockOffMs).toBe(T0 + 60 * MIN);
	});
});

describe('when the flight being flown began', () => {
	it('is nothing before a fix, else the first flight timed from the first fix', async () => {
		const m = await load();
		expect(m.currentFlightStartMs()).toBeNull();
		m.nav.points = outing([0, 0, 5]);
		expect(m.currentFlightStartMs()).toBe(T0);
		// The takeoff does not move the clock back to the first movement.
		m.nav.points = outing([0, 0, 5, 100, 100]);
		expect(m.currentFlightStartMs()).toBe(T0);
	});

	it('is a later flight own block-off', async () => {
		const m = await load();
		m.nav.points = outing([...ONE, 5, 100, 100]);
		expect(m.currentFlightStartMs()).toBe(T0 + 10 * MIN);
	});

	it('is this recording first fix after an add, until the next takeoff', async () => {
		const m = await load();
		m.nav.points = outing(ONE);
		m.nav.origin = 'recording';
		m.continueRecording();
		expect(m.nav.recording).toBe(true);
		// No fix yet: no 0:00 while the GPS finds one.
		expect(m.currentFlightStartMs()).toBeNull();
		const resumed = T0 + 90 * MIN;
		onFix?.(fix(resumed));
		expect(m.currentFlightStartMs()).toBe(resumed);
		onFix?.(fix(resumed + 2 * MIN, 5, 0.21));
		onFix?.(fix(resumed + 3 * MIN, 100, 0.25));
		onFix?.(fix(resumed + 4 * MIN, 100, 0.3));
		// The next flight's takeoff commits: its own block-off from here.
		expect(m.liveLastFlight()?.index).toBe(2);
		expect(m.currentFlightStartMs()).toBe(resumed + 2 * MIN);
	});

	it('keeps timing a flight that landed during this recording', async () => {
		const m = await load();
		m.startRecording();
		m.nav.points = outing(ONE);
		expect(m.currentFlightStartMs()).toBe(T0);
	});
});
