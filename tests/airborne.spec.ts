/* The airborne watermark both position-referenced alert engines read
 * (state/airborne.ts): the first fix at takeoff speed, and the end of the
 * departure phase 1 500 ft above it (TSO-C151c 10.4). */

import { describe, expect, it } from 'vitest';
import {
	DEPARTURE_END_FT,
	departureWatermark,
	firstAirborneIndex,
	firstAirborneMs,
	takeoffObserved,
} from '$lib/state/airborne';
import { TAKEOFF_KT } from '$lib/nav/navlogLive';
import type { TrackPoint } from '$lib/nav/trace';

const T0 = Date.parse('2026-07-08T13:17:00Z');

/** A fix a second, `kt` and `alt` per index. */
function trace(n: number, kt: (i: number) => number, alt: (i: number) => number | null): TrackPoint[] {
	return Array.from({ length: n }, (_, i) => ({
		lat: 46.19,
		lon: 6.26 + i * 0.0005,
		altFt: alt(i),
		timeMs: T0 + i * 1000,
		speedKt: kt(i),
		trackDeg: 90,
	}));
}

describe('the airborne watermark', () => {
	it('opens at the first fix at takeoff speed', () => {
		const pts = trace(20, (i) => (i < 5 ? 10 : TAKEOFF_KT + 20), () => 1620);
		expect(firstAirborneIndex(pts)).toBe(5);
		expect(firstAirborneMs(pts)).toBe(T0 + 5000);
	});

	/** A takeoff seen by the trace: ROLL fixes on the runway at 30 kt, then 80
	 *  kt, the altitude `alt` from the takeoff on. */
	const ROLL = 3;
	function flown(n: number, alt: (k: number) => number | null): TrackPoint[] {
		return trace(n, (i) => (i < ROLL ? 30 : 80), (i) => (i < ROLL ? 1620 : alt(i - ROLL)));
	}

	it('ends the departure phase 1 500 ft above the takeoff', () => {
		const pts = flown(40, (k) => 1620 + k * 60);
		expect(takeoffObserved(pts)).toBe(true);
		const wm = departureWatermark(pts);
		expect(wm.baseFt).toBe(1620);
		expect(wm.endMs).toBe(T0 + (ROLL + Math.ceil(DEPARTURE_END_FT / 60)) * 1000);
	});

	it('reads the base from the first altitude after a takeoff fix that carries none', () => {
		// The EMU recorders interleave fixes with no altitude: the one that
		// crosses the takeoff speed may be one of them, and a null base once
		// held the whole flight in the departure phase.
		const pts = flown(40, (k) => (k % 2 === 0 ? null : 1620 + k * 60));
		const wm = departureWatermark(pts);
		expect(wm.baseFt).toBe(1680);
		expect(wm.endMs).not.toBeNull();
		expect(wm.endMs!).toBeGreaterThan(T0);
	});

	it('follows a live recording that appends in place', () => {
		const pts = flown(10, (k) => 1620 + k * 100);
		expect(departureWatermark(pts)).toEqual({ baseFt: 1620, endMs: null });
		for (let k = 7; k < 17; k++) {
			pts.push({ ...pts[9], altFt: 1620 + k * 100, timeMs: T0 + (ROLL + k) * 1000 });
		}
		expect(departureWatermark(pts)).toEqual({ baseFt: 1620, endMs: T0 + (ROLL + 15) * 1000 });
	});

	it('keeps the end it found while the recording goes on climbing', () => {
		// Every later fix also stands 1 500 ft above the base: a scan that
		// resumed after the end moved it to the newest one, and a replay of
		// the same array then read the departure phase almost to landing.
		const pts = flown(20, (k) => 1620 + k * 100);
		const first = departureWatermark(pts).endMs;
		expect(first).toBe(T0 + (ROLL + 15) * 1000);
		for (let k = 17; k < 40; k++) {
			pts.push({ ...pts[19], altFt: 1620 + k * 100, timeMs: T0 + (ROLL + k) * 1000 });
			expect(departureWatermark(pts).endMs).toBe(first);
		}
	});

	it('ends the departure at once for a trace joined in flight', () => {
		// A recording started in cruise saw no takeoff: 1 500 ft above the
		// level it was joined at would have held the departure's 100 ft
		// clearance over an IFR cruise.
		const pts = trace(40, () => 110, () => 3500);
		expect(takeoffObserved(pts)).toBe(false);
		expect(departureWatermark(pts)).toEqual({ baseFt: null, endMs: T0 });
	});

	it('answers nothing before takeoff', () => {
		const pts = trace(10, () => 12, () => 1620);
		expect(departureWatermark(pts)).toEqual({ baseFt: null, endMs: null });
		expect(takeoffObserved(pts)).toBeNull();
	});
});
