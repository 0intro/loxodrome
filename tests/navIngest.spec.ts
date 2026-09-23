/* The ONE append boundary (state/navRecording's ingestFix), driven through
 * the real geolocation watch.
 *
 * A trace has three sources (a file import, the native recorder, this web
 * watch) and every reader of one assumes a STRICTLY INCREASING timeline:
 * nav/trace.ts brackets the playhead by binary search, the motion fold
 * backfills a missing speed from the hop, and the writers export it as a
 * timeline. The importers enforce it (stampedTrack drops a stamp that does
 * not advance rather than re-stamping it) and both native paths filter
 * before they append; these pin that the watch does too, since the platform
 * hands back CACHED positions carrying their original timestamp.
 *
 * Fresh module graph per case: the trace lives in module state. */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

let onFix: ((p: unknown) => void) | null = null;

/** A GeolocationPosition as the platform shapes it. */
function pos(
	timeMs: number,
	lat: number,
	lon: number,
	speed: number | null = null,
): unknown {
	return {
		coords: {
			latitude: lat,
			longitude: lon,
			altitude: null,
			altitudeAccuracy: null,
			accuracy: 5,
			speed,
			heading: null,
		},
		timestamp: timeMs,
	};
}

beforeEach(() => {
	const store = new Map<string, string>();
	onFix = null;
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
	vi.stubGlobal('window', {
		isSecureContext: true,
		addEventListener: () => {},
		removeEventListener: () => {},
	});
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

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Start a recording and hand back the live trace plus the watch callback. */
async function record(): Promise<{
	points: () => readonly { timeMs: number; speedKt?: number | null }[];
	feed: (p: unknown) => void;
	stop: () => void;
}> {
	const mod = await import('$lib/state/navRecording.svelte');
	mod.startRecording();
	expect(onFix, 'the watch was armed').not.toBeNull();
	return {
		points: () => mod.nav.points,
		feed: (p: unknown) => onFix?.(p),
		stop: () => mod.stopRecording(),
	};
}

describe('the live append boundary', () => {
	it('keeps a fix that advances the clock', async () => {
		const r = await record();
		r.feed(pos(1000, 48.6, 2.6));
		r.feed(pos(2000, 48.61, 2.6));
		r.feed(pos(3000, 48.62, 2.6));
		expect(r.points().map((p) => p.timeMs)).toEqual([1000, 2000, 3000]);
		r.stop();
	});

	it('drops a cached position replayed under its own timestamp', async () => {
		// The watch hands back the same fix again: same stamp, and far enough
		// away that the stationary-jitter gate would let it through.
		const r = await record();
		r.feed(pos(1000, 48.6, 2.6));
		r.feed(pos(1000, 48.65, 2.65));
		expect(r.points().map((p) => p.timeMs)).toEqual([1000]);
		r.stop();
	});

	it('drops a fix whose clock went backwards', async () => {
		const r = await record();
		r.feed(pos(5000, 48.6, 2.6));
		r.feed(pos(4000, 48.65, 2.65));
		r.feed(pos(6000, 48.7, 2.7));
		expect(r.points().map((p) => p.timeMs)).toEqual([5000, 6000]);
		r.stop();
	});

	it('never backfills a speed from a zero-elapsed hop', async () => {
		// The reason the rule is load-bearing rather than cosmetic: with a
		// repeated stamp admitted, deriveMotion divides by a zero interval and
		// reports 0 kt, which every speed rule then weighs as a slow fix (the
		// motion fold's landing watch, and the evidence behind
		// takeoffObserved). No fix in the trace may carry that value.
		const r = await record();
		r.feed(pos(1000, 48.6, 2.6));
		r.feed(pos(1000, 48.9, 2.9));
		r.feed(pos(2000, 48.9, 2.9));
		const speeds = r.points().map((p) => p.speedKt ?? null);
		expect(r.points()).toHaveLength(2);
		expect(speeds.some((s) => s === 0)).toBe(false);
		r.stop();
	});

	it('still drops a stationary jitter fix inside the quiet window', async () => {
		// The pre-existing gate, unchanged: metres apart and under the dwell,
		// so a parked aircraft does not bloat the trace.
		const r = await record();
		r.feed(pos(1000, 48.6, 2.6));
		r.feed(pos(1500, 48.600008, 2.6));
		expect(r.points()).toHaveLength(1);
		r.stop();
	});
});
