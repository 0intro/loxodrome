/* Unit tests for the native-fix mapper (nav/nativeFix.ts): the raw Android
 * Location units into TrackPoint, the tolerant parse of journal lines, and
 * the monotonic take that makes event + drain overlap harmless. */

import { describe, it, expect } from 'vitest';
import { toTrackPoint, takeNewer } from '$lib/nav/nativeFix';
import type { TrackPoint } from '$lib/nav/trace';

const T0 = Date.parse('2026-07-20T10:00:00Z');

describe('toTrackPoint', () => {
	it('maps a full fix with unit conversions', () => {
		const p = toTrackPoint({
			tMs: T0,
			lat: 48.62,
			lon: 2.62,
			altM: 304.8,
			accM: 8,
			spdMps: 1852 / 36,
			brgDeg: 273.5,
		});
		expect(p).not.toBeNull();
		expect(p?.timeMs).toBe(T0);
		expect(p?.lat).toBe(48.62);
		expect(p?.lon).toBe(2.62);
		// 304.8 m is exactly 1000 ft; 1852/36 m/s is exactly 100 kt.
		expect(p?.altFt).toBeCloseTo(1000, 6);
		expect(p?.speedKt).toBeCloseTo(100, 6);
		expect(p?.trackDeg).toBe(273.5);
		expect(p?.accuracyM).toBe(8);
	});

	it('maps absent optionals to null, as the web path records them', () => {
		const p = toTrackPoint({ tMs: T0, lat: 48, lon: 2 });
		expect(p).toEqual({
			lat: 48,
			lon: 2,
			timeMs: T0,
			altFt: null,
			speedKt: null,
			trackDeg: null,
			accuracyM: null,
		});
	});

	it('drops non-finite optionals instead of propagating them', () => {
		const p = toTrackPoint({ tMs: T0, lat: 48, lon: 2, altM: NaN, spdMps: Infinity });
		expect(p?.altFt).toBeNull();
		expect(p?.speedKt).toBeNull();
	});

	it('rejects a fix missing any essential', () => {
		expect(toTrackPoint({ lat: 48, lon: 2 })).toBeNull();
		expect(toTrackPoint({ tMs: T0, lon: 2 })).toBeNull();
		expect(toTrackPoint({ tMs: T0, lat: 48 })).toBeNull();
		expect(toTrackPoint({ tMs: NaN, lat: 48, lon: 2 })).toBeNull();
	});

	it('rejects malformed journal values without throwing', () => {
		expect(toTrackPoint(null)).toBeNull();
		expect(toTrackPoint(undefined)).toBeNull();
		expect(toTrackPoint('48,2')).toBeNull();
		expect(toTrackPoint(42)).toBeNull();
		expect(toTrackPoint({ tMs: '12', lat: '48', lon: '2' })).toBeNull();
	});
});

describe('takeNewer', () => {
	const pt = (timeMs: number): TrackPoint => ({ lat: 48, lon: 2, altFt: null, timeMs });

	it('keeps only points strictly after the floor', () => {
		const pts = [pt(T0), pt(T0 + 1000), pt(T0 + 2000)];
		expect(takeNewer(T0, pts).map((p) => p.timeMs)).toEqual([T0 + 1000, T0 + 2000]);
	});

	it('keeps everything when the trace is empty', () => {
		const pts = [pt(T0), pt(T0 + 1000)];
		expect(takeNewer(null, pts)).toEqual(pts);
	});

	it('drops duplicates and regressions inside the batch', () => {
		const pts = [pt(T0), pt(T0), pt(T0 - 1000), pt(T0 + 1000), pt(T0 + 1000)];
		expect(takeNewer(null, pts).map((p) => p.timeMs)).toEqual([T0, T0 + 1000]);
	});

	it('returns nothing when the batch is entirely stale', () => {
		expect(takeNewer(T0 + 5000, [pt(T0), pt(T0 + 1000)])).toEqual([]);
	});
});
