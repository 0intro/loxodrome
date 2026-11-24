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

describe('the crash-recovery copy', () => {
	it('says recording while one runs, and not after the stop', async () => {
		// The flag the next boot reads to tell an interrupted flight from a
		// finished one: written with the points while recording, false at
		// the stop, which runs after nav.recording is already false.
		vi.useFakeTimers();
		try {
			const r = await record();
			r.feed(pos(Date.now(), 48.6, 2.6, 40));
			vi.advanceTimersByTime(9_000);
			const doc = (): { recording?: unknown } =>
				JSON.parse(localStorage.getItem('loxodrome:nav-trace') ?? '{}') as { recording?: unknown };
			expect(doc().recording).toBe(true);
			r.stop();
			expect(doc().recording).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});

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

	it('drops its oldest 20 000 fixes at once past the 200 000 cap', async () => {
		// A drop moves the trace's head, and every fold over the trace refolds
		// when it moves (tests/navTraceCap.spec.ts): one drop of 20 000 costs
		// one refold, where a fix dropped per fix appended costs one per fix.
		const r = await record();
		const t = (i: number): number => 1_000_000 + i * 2000;
		for (let i = 0; i <= 200_000; i++) {
			r.feed(pos(t(i), 48.6, 2.6));
		}
		expect(r.points()).toHaveLength(180_001);
		expect(r.points()[0].timeMs).toBe(t(20_000));
		r.feed(pos(t(200_001), 48.6, 2.6));
		expect(r.points()).toHaveLength(180_002);
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

/* A GNSS fix is stamped on satellite time (Location.getTime() on Android),
 * and a phone's clock can run seconds away from it. The quality ages the
 * fix against the device clock, so it reads the fix on that clock too: read
 * raw, a device clock ahead makes every fresh fix degraded (lateral-only
 * airspace alerts, terrain withheld) or lost (alerts suspended), and one
 * behind hides a dropout for as long as the gap. */
describe('the position quality', () => {
	const NOW = Date.UTC(2026, 6, 7, 10, 0);

	async function recordAt(): Promise<typeof import('$lib/state/navRecording.svelte')> {
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
		vi.setSystemTime(NOW);
		const mod = await import('$lib/state/navRecording.svelte');
		mod.startRecording();
		return mod;
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it('reads a fresh fix as good with the device clock ahead of it', async () => {
		const m = await recordAt();
		onFix?.(pos(NOW - 10_000, 48.6, 2.6));
		expect(m.positionQuality()).toBe('good');
		onFix?.(pos(NOW - 9_000, 48.61, 2.6));
		vi.advanceTimersByTime(1_000);
		expect(m.positionQuality()).toBe('good');
		vi.advanceTimersByTime(16_000);
		expect(m.positionQuality()).toBe('lost');
		m.stopRecording();
	});

	it('sees a dropout age with the device clock behind the fixes', async () => {
		const m = await recordAt();
		onFix?.(pos(NOW + 10_000, 48.6, 2.6));
		expect(m.positionQuality()).toBe('good');
		vi.advanceTimersByTime(6_000);
		expect(m.positionQuality()).toBe('degraded');
		m.stopRecording();
	});
});
