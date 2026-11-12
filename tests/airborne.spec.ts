/* The airborne watermark both position-referenced alert engines read
 * (state/airborne.ts): the first fix at takeoff speed, and the end of the
 * departure phase 1 500 ft above it (TSO-C151c 10.4); and the gate per
 * FLIGHT, closed by a landing on a known aerodrome until the next takeoff. */

import { describe, expect, it } from 'vitest';
import {
	DEPARTURE_END_FT,
	airborneGate,
	departureWatermark,
	firstAirborneIndex,
	firstAirborneMs,
	takeoffObserved,
	type GroundEvidence,
} from '$lib/state/airborne';
import { LANDING_SUSTAIN_MS, TAKEOFF_KT } from '$lib/nav/navlogLive';
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

describe('the gate per flight', () => {
	const FIELD_FT = 1620;
	/** A fix a second through phases of [seconds, knots, altitude]. */
	function phased(phases: [number, number, number | null][]): TrackPoint[] {
		const pts: TrackPoint[] = [];
		let t = 0;
		for (const [dur, kt, alt] of phases) {
			for (let s = 0; s < dur; s++) {
				pts.push({ lat: 46.19, lon: 6.26 + t * 0.0001, altFt: alt, timeMs: T0 + t * 1000, speedKt: kt, trackDeg: 90 });
				t++;
			}
		}
		return pts;
	}
	const at = (s: number): number => T0 + s * 1000;
	/** Taxi 20 s, fly 200 s climbing, land and stop 120 s at `landFt`, then
	 *  taxi 20 s and fly again, climbing 60 ft a second. */
	function twoLegs(landFt: number | null): TrackPoint[] {
		return phased([
			[20, 10, FIELD_FT],
			[200, 90, FIELD_FT + 2000],
			[120, 5, landFt],
			[20, 10, landFt],
			...Array.from({ length: 60 }, (_, k): [number, number, number | null] => [1, 90, FIELD_FT + k * 60]),
		]);
	}
	const LAND = 220;
	const REOPEN = 360;
	const onField: GroundEvidence = { altMslFt: (p) => p.altFt, fieldElevFt: () => FIELD_FT };
	const nowhere: GroundEvidence = { altMslFt: (p) => p.altFt, fieldElevFt: () => null };

	it('closes at a landing on a known field once confirmed, and reopens at the next takeoff', () => {
		const pts = twoLegs(FIELD_FT);
		const gate = (s: number) => airborneGate(pts, at(s), onField, true);
		expect(gate(100)).toMatchObject({ airborne: true, epoch: 0, openMs: at(20) });
		// The landing is a minute's slow evidence; until it is in, the gate holds.
		expect(gate(LAND + 30).airborne).toBe(true);
		expect(gate(LAND + LANDING_SUSTAIN_MS / 1000).airborne).toBe(false);
		expect(gate(REOPEN - 1)).toMatchObject({ airborne: false, epoch: 0 });
		expect(gate(REOPEN)).toMatchObject({ airborne: true, epoch: 1, openMs: at(REOPEN) });
	});

	it('gives the next flight a departure phase of its own', () => {
		const pts = twoLegs(FIELD_FT);
		const first = airborneGate(pts, at(100), onField, true).departureEndMs;
		expect(first).toBe(departureWatermark(pts).endMs);
		const next = airborneGate(pts, at(REOPEN + 30), onField, true).departureEndMs;
		expect(next).toBe(at(REOPEN + Math.ceil(DEPARTURE_END_FT / 60)));
	});

	it('stays open over a landing no known field confirms, or away from its elevation', () => {
		const pts = twoLegs(FIELD_FT);
		expect(airborneGate(pts, at(REOPEN - 1), nowhere, true)).toMatchObject({ airborne: true, epoch: 0 });
		// Slow flight 2 000 ft above the field (ridge soaring, a hover).
		const high = twoLegs(FIELD_FT + 2000);
		expect(airborneGate(high, at(REOPEN - 1), onField, true).airborne).toBe(true);
		// No altitude in the landing's own fixes: no evidence.
		const blind = twoLegs(null);
		expect(airborneGate(blind, at(REOPEN - 1), onField, true).airborne).toBe(true);
	});

	it('keeps the first flight on the watermark rules, a trace joined in flight included', () => {
		// Joined in cruise: no departure to measure from, it ends at once.
		const joined = trace(40, () => 110, () => 3500);
		expect(airborneGate(joined, T0 + 10_000, onField, true)).toMatchObject({ airborne: true, departureEndMs: T0 });
	});

	it('never closes for a helicopter or a glider', () => {
		const pts = twoLegs(FIELD_FT);
		expect(airborneGate(pts, at(REOPEN - 1), onField, false)).toMatchObject({ airborne: true, epoch: 0 });
	});

	it('asks again about a landing while the aerodromes are not loaded', () => {
		const pts = twoLegs(FIELD_FT);
		let loaded = false;
		const later: GroundEvidence = { altMslFt: (p) => p.altFt, fieldElevFt: () => (loaded ? FIELD_FT : undefined) };
		expect(airborneGate(pts, at(REOPEN - 1), later, true).airborne).toBe(true);
		loaded = true;
		expect(airborneGate(pts, at(REOPEN - 1), later, true).airborne).toBe(false);
	});

	it('follows a live recording through the stop and the next takeoff', () => {
		const all = twoLegs(FIELD_FT);
		const pts = all.slice(0, LAND + 30);
		expect(airborneGate(pts, at(LAND + 29), onField, true).airborne).toBe(true);
		for (const p of all.slice(LAND + 30, REOPEN)) {
			pts.push(p);
		}
		expect(airborneGate(pts, at(REOPEN - 1), onField, true)).toMatchObject({ airborne: false, epoch: 0 });
		for (const p of all.slice(REOPEN)) {
			pts.push(p);
		}
		expect(airborneGate(pts, at(REOPEN + 5), onField, true)).toMatchObject({ airborne: true, epoch: 1 });
		// The first flight's answers are unchanged.
		expect(firstAirborneMs(pts)).toBe(at(20));
	});
});
