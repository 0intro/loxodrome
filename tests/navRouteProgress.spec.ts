/* Unit tests for the pure along-route progress fold (nav/routeProgress):
 * checkpoint determinism, out-and-back disambiguation, re-seeding and the
 * playhead interpolation. */

import { describe, it, expect } from 'vitest';
import {
	computeRouteProgress,
	extendRouteProgress,
	progressDistNM,
	progressOffM,
	BACKTRACK_NM,
	type RouteProgressPoint,
} from '$lib/nav/routeProgress';
import { equirectangularDistanceM } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import type { TrackPoint } from '$lib/nav/trace';
import type { Waypoint } from '$lib/state/route.svelte';

let nextId = 0;
function wp(lat: number, lon: number): Waypoint {
	return { id: `t${nextId++}`, lat, lon, kind: 'free', alt: 3000, altAuto: true };
}

function tp(lat: number, lon: number, timeMs: number): TrackPoint {
	return { lat, lon, altFt: null, timeMs };
}

/** Leg length (NM) with the module's own axis math. */
function legNM(a: Waypoint, b: Waypoint): number {
	return equirectangularDistanceM(a.lat, a.lon, b.lat, b.lon) / NM_TO_METERS;
}

describe('computeRouteProgress', () => {
	it('is empty for an empty trace or fewer than two waypoints', () => {
		expect(computeRouteProgress([], [wp(0, 0), wp(0, 1)])).toEqual([]);
		expect(computeRouteProgress([tp(0, 0, 0)], [wp(0, 0)])).toEqual([]);
		expect(computeRouteProgress([tp(0, 0, 0)], [])).toEqual([]);
	});

	it('pins a zero-length route at zero', () => {
		const wps = [wp(10, 20), wp(10, 20)];
		const out = computeRouteProgress([tp(10, 20, 0), tp(11, 21, 1000)], wps);
		expect(out.map((c) => c.distNM)).toEqual([0, 0]);
	});

	it('matches the cumulative leg axis on a flown route', () => {
		const wps = [wp(0, 0), wp(0, 1), wp(1, 1)];
		const l1 = legNM(wps[0], wps[1]);
		const l2 = legNM(wps[1], wps[2]);
		const out = computeRouteProgress(
			[tp(0, 0, 0), tp(0, 1, 1000), tp(1, 1, 2000)],
			wps,
		);
		expect(out[0].distNM).toBeCloseTo(0, 3);
		expect(out[1].distNM).toBeCloseTo(l1, 3);
		expect(out[2].distNM).toBeCloseTo(l1 + l2, 3);
	});

	it('advances monotonically along a straight route, even flown offset', () => {
		const wps = [wp(0, 0), wp(0, 2)];
		// Flown 1 NM north of the drawn line.
		const off = 1 / 60;
		const pts = Array.from({ length: 21 }, (_, i) => tp(off, (i * 2) / 20, i * 1000));
		const out = computeRouteProgress(pts, wps);
		for (let i = 1; i < out.length; i++) {
			expect(out[i].distNM).toBeGreaterThan(out[i - 1].distNM);
		}
		expect(out[20].distNM).toBeCloseTo(legNM(wps[0], wps[1]), 1);
	});

	it('resolves an out-and-back route without snapping back at the turn', () => {
		const wps = [wp(0, 0), wp(0, 1), wp(0, 0)];
		const d = legNM(wps[0], wps[1]);
		const lons = [0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25, 0];
		const out = computeRouteProgress(
			lons.map((lon, i) => tp(0, lon, i * 1000)),
			wps,
		);
		// Outbound on [0, d], return on [d, 2d]; never decreasing.
		expect(out[2].distNM).toBeCloseTo(0.5 * d, 2);
		expect(out[4].distNM).toBeCloseTo(d, 2);
		expect(out[6].distNM).toBeCloseTo(1.5 * d, 2);
		expect(out[8].distNM).toBeCloseTo(2 * d, 2);
		for (let i = 1; i < out.length; i++) {
			expect(out[i].distNM).toBeGreaterThanOrEqual(out[i - 1].distNM);
		}
	});

	it('seeds mid-route, re-seeds on a far backward jump, follows a direct-to forward', () => {
		const wps = [wp(0, 0), wp(0, 2)];
		// First fix mid-route: global nearest.
		const seed = computeRouteProgress([tp(0, 0.5, 0)], wps);
		expect(seed[0].distNM).toBeCloseTo(legNM(wps[0], wps[1]) / 4, 2);
		// A backward jump far beyond BACKTRACK_NM abandons the old progress.
		const back = computeRouteProgress([tp(0, 1.5, 0), tp(0, 0.1, 1000)], wps);
		expect(back[1].distNM).toBeLessThan(back[0].distNM - BACKTRACK_NM);
		expect(back[1].distNM).toBeCloseTo(legNM(wps[0], wps[1]) * 0.05, 1);
		// A forward jump (direct-to) needs no re-seed and just advances.
		const fwd = computeRouteProgress([tp(0, 0.2, 0), tp(0, 1, 1000)], wps);
		expect(fwd[1].distNM).toBeCloseTo(legNM(wps[0], wps[1]) / 2, 2);
	});

	it('refuses a jump the aircraft cannot have flown (a closed route at its field)', () => {
		// Departure == destination, and the roll is not aligned with the first
		// leg: the LAST leg's line runs right under it, so lateral distance alone
		// picks the route END. Only the reachability budget keeps the identity;
		// without it the log reads "arrived" seconds after takeoff and the
		// destination takes an ATO from the takeoff roll.
		const wps = [wp(0, 0), wp(0, 1), wp(-0.7, 0.7), wp(0, 0)];
		const total = legNM(wps[0], wps[1]) + legNM(wps[1], wps[2]) + legNM(wps[2], wps[3]);
		expect(total).toBeGreaterThan(150);
		// ~60 kt south-east off the field, exactly along the arrival leg's line.
		const pts = Array.from({ length: 20 }, (_, i) => tp(-0.0002 * i, 0.0002 * i, i * 1000));
		const out = computeRouteProgress(pts, wps);
		for (const c of out) {
			expect(c.distNM).toBeLessThan(1);
		}
		// Still tracking the first leg, forward.
		expect(out[19].distNM).toBeGreaterThan(out[0].distNM);
	});

	it('seeds at the departure when the last leg passes over the field', () => {
		// A closed route: the apron sits metres from leg 0's start AND on the
		// last leg's inbound line, which is the NEAREST projection, so seeding on
		// distance alone reports the whole flight flown before it starts. The
		// departure then tracks the reciprocal of that leg's course, which reads
		// as flying it backwards, so the fold never recovers on its own.
		const wps = [wp(0, 0), wp(0, 1), wp(-0.5, 1), wp(0, 0)];
		const total = legNM(wps[0], wps[1]) + legNM(wps[1], wps[2]) + legNM(wps[2], wps[3]);
		expect(total).toBeGreaterThan(100);
		const pts = [
			tp(-0.0005, 0.001, 0), // parked on the arrival leg's line
			...Array.from({ length: 30 }, (_, i) => tp(0, 0.002 + 0.0005 * i, (i + 1) * 1000)),
		];
		const out = computeRouteProgress(pts, wps);
		expect(out[0].distNM).toBeLessThan(1);
		for (const c of out) {
			expect(c.distNM).toBeLessThan(5);
		}
		// Departed: tracking the first leg forward, not the last one backwards.
		expect(out[out.length - 1].distNM).toBeGreaterThan(out[0].distNM + 0.5);
	});

	it('ignores a nearer leg it is flying against (the corridor home)', () => {
		// Out and back through the same gate: climbing out, the aircraft drifts
		// off its first leg and sits NEARER the line it will come home on. That
		// line is flown the other way, so it is not the leg being flown, however
		// near it is; without the course test the fold jumps to the route end.
		const wps = [wp(0, 0), wp(0.05, 1), wp(-0.6, 0.6), wp(-0.02, 0.9), wp(0, 0)];
		const total =
			legNM(wps[0], wps[1]) +
			legNM(wps[1], wps[2]) +
			legNM(wps[2], wps[3]) +
			legNM(wps[3], wps[4]);
		expect(total).toBeGreaterThan(150);
		// Departing east-south-east, diverging from the first leg's drawn line.
		const n = 40;
		const pts = Array.from({ length: n }, (_, i) => {
			const s = i / (n - 1);
			return tp(-0.03 * s, 0.002 + 0.298 * s, i * 20_000);
		});
		const out = computeRouteProgress(pts, wps);
		for (const c of out) {
			expect(c.distNM).toBeLessThan(25);
		}
		expect(out[out.length - 1].distNM).toBeGreaterThan(10);
	});

	it('re-seeds off a wrong seed while the identity is unestablished', () => {
		// Parked far enough down the arrival leg's line for the seed tie band not
		// to apply: the first fix reads the route END. The aircraft then departs
		// on the first leg and the seed window (SEED_LOCK_NM) lets it take over.
		const wps = [wp(0, 0), wp(0.9, -0.4), wp(0.9, 0.9), wp(0, 0)];
		const total = legNM(wps[0], wps[1]) + legNM(wps[1], wps[2]) + legNM(wps[2], wps[3]);
		const pts = Array.from({ length: 60 }, (_, i) =>
			tp(0.006 + 0.0009 * i, 0.006 - 0.0004 * i, i * 2000),
		);
		const out = computeRouteProgress(pts, wps);
		expect(out[0].distNM).toBeGreaterThan(total - 2);
		expect(out[out.length - 1].distNM).toBeLessThan(5);
	});

	it('refuses a backward re-seed onto an earlier leg the route passes near', () => {
		// Coming home, the track crosses the OUTBOUND leg's corridor and sits
		// nearer that line than the one it is flying. The flight has not un-flown
		// 180 NM, so the leg being tracked keeps it.
		const wps = [wp(0, 0), wp(0.5, 1), wp(-0.5, 1), wp(0, 0)];
		const total = legNM(wps[0], wps[1]) + legNM(wps[1], wps[2]) + legNM(wps[2], wps[3]);
		const n = 40;
		const pts = Array.from({ length: n }, (_, i) => {
			const s = i / (n - 1);
			return tp(-0.35 + s * 0.4, 0.8 - s * 0.7, i * 60_000);
		});
		const out = computeRouteProgress(pts, wps);
		// Ends on the last leg near the destination, not back on the first one.
		expect(out[out.length - 1].distNM).toBeGreaterThan(total - 12);
		for (const c of out) {
			expect(c.distNM).toBeGreaterThan(100);
		}
	});

	it('re-seeds across a GPS gap, the budget widening with the hop', () => {
		const wps = [wp(0, 0), wp(0, 1), wp(1, 1)];
		const l1 = legNM(wps[0], wps[1]);
		const l2 = legNM(wps[1], wps[2]);
		// Twenty minutes with no fix: the corner was flown in between.
		const out = computeRouteProgress([tp(0, 0.1, 0), tp(0.9, 1, 1_200_000)], wps);
		expect(out[0].distNM).toBeCloseTo(l1 * 0.1, 1);
		expect(out[1].distNM).toBeCloseTo(l1 + l2 * 0.9, 0);
	});
});

describe('extendRouteProgress', () => {
	it('extends point-by-point to the same checkpoints as one full compute', () => {
		const wps = [wp(0, 0), wp(0, 1), wp(0, 0)];
		const lons = [0, 0.3, 0.6, 0.9, 1, 0.7, 0.4, 0.1];
		const pts = lons.map((lon, i) => tp(0, lon, i * 1000));
		const full = computeRouteProgress(pts, wps);
		let inc: RouteProgressPoint[] = [];
		for (let i = 1; i <= pts.length; i++) {
			inc = extendRouteProgress(inc, pts.slice(0, i), wps);
		}
		expect(inc).toEqual(full);
	});

	it('starts over when the trace shrank under the checkpoints', () => {
		const wps = [wp(0, 0), wp(0, 1)];
		const pts = [tp(0, 0.2, 0), tp(0, 0.4, 1000)];
		const prev = computeRouteProgress(pts, wps);
		const out = extendRouteProgress(prev, [tp(0, 0.6, 2000)], wps);
		expect(out).toHaveLength(1);
		expect(out[0].timeMs).toBe(2000);
	});
});

describe('fromIdx (one leg of a chained plan)', () => {
	/** The second leg of a plan whose first leg ran lon 0 -> 1: the trace
	 *  crosses the junction at index 4 and carries on to lon 2. */
	const legTwo = [wp(0, 1), wp(0, 2)];
	const pts = [0, 0.3, 0.6, 0.9, 1, 1.3, 1.6, 1.9].map((lon, i) => tp(0, lon, i * 60_000));

	it('answers for point fromIdx + j, seeded at the leg start', () => {
		const cps = computeRouteProgress(pts, legTwo, 4);
		expect(cps).toHaveLength(pts.length - 4);
		expect(cps[0].timeMs).toBe(pts[4].timeMs);
		expect(cps[0].distNM).toBeCloseTo(0, 6);
		expect(cps[cps.length - 1].distNM).toBeCloseTo(legNM(legTwo[0], legTwo[1]) * 0.9, 3);
	});

	it('never sees the fixes flown on the preceding leg', () => {
		// Folded from 0 the same leg starts already parked at its own
		// beginning, so the first four fixes report a spurious zero.
		const whole = computeRouteProgress(pts, legTwo);
		expect(whole).toHaveLength(pts.length);
		expect(whole[0].timeMs).toBe(pts[0].timeMs);
		const sliced = computeRouteProgress(pts, legTwo, 4);
		expect(sliced.map((c) => c.timeMs)).toEqual(pts.slice(4).map((p) => p.timeMs));
	});

	it('extends point-by-point to the same checkpoints as one full compute', () => {
		const full = computeRouteProgress(pts, legTwo, 4);
		let inc: RouteProgressPoint[] = [];
		for (let i = 5; i <= pts.length; i++) {
			inc = extendRouteProgress(inc, pts.slice(0, i), legTwo, 4);
		}
		expect(inc).toEqual(full);
	});

	it('starts over when the trace shrank under the segment', () => {
		const prev = computeRouteProgress(pts, legTwo, 4);
		const out = extendRouteProgress(prev, pts.slice(0, 6), legTwo, 4);
		expect(out).toHaveLength(2);
		expect(out[0].timeMs).toBe(pts[4].timeMs);
	});
});

describe('leg pins (the pilot telling the fold which segment is flown)', () => {
	/** Three 60 NM segments due east; the trace flies along the last one. */
	const wps = [wp(0, 0), wp(0, 1), wp(0, 2), wp(0, 3)];
	const pts = [2.2, 2.4, 2.6, 2.8].map((lon, i) => tp(0, lon, i * 60_000));
	const l0 = legNM(wps[0], wps[1]);
	const l1 = legNM(wps[1], wps[2]);

	it('takes the named segment, whatever lies nearer, and only from its instant', () => {
		const plain = computeRouteProgress(pts, wps);
		const out = computeRouteProgress(pts, wps, 0, [{ legIdx: 0, sinceMs: 2 * 60_000 }]);
		// Behind the instant the flight is exactly what it was: a correction
		// states what is being flown NOW, and rewriting the past would move
		// times already stamped.
		expect(out.slice(0, 2)).toEqual(plain.slice(0, 2));
		// At it, the nearest point of the segment NAMED: its end waypoint,
		// though the third segment runs under the aircraft.
		expect(out[2].distNM).toBeCloseTo(l0, 6);
		// And it fires once: past it the fold sequences on by its own rules,
		// which here take the aircraft back to where it plainly is.
		expect(out[3].distNM).toBeGreaterThan(l0 + l1);
	});

	it('is established at once, so a nearer earlier segment cannot steal it back', () => {
		// Three miles north of the FIRST segment's line, thirty from the
		// second's nearest point, the pilot names the second.
		const w = [wp(0, 0), wp(0, 1), wp(0, 2)];
		const p = [0.5, 0.51, 0.52].map((lon, i) => tp(0.05, lon, i * 60_000));
		const end = legNM(w[0], w[1]);
		// Left to itself the fold reads the first segment throughout.
		for (const c of computeRouteProgress(p, w)) {
			expect(c.distNM).toBeLessThan(end);
		}
		// Pinned, it holds the second: the seed window exists to correct an
		// unproven identity, and there is nothing unproven about this one.
		for (const c of computeRouteProgress(p, w, 0, [{ legIdx: 1, sinceMs: 0 }])) {
			expect(c.distNM).toBeCloseTo(end, 6);
		}
	});

	it('applies every correction in turn, the last one inside a fix interval winning', () => {
		const out = computeRouteProgress(pts, wps, 0, [
			// Deliberately unordered, and two inside the interval before pts[2].
			{ legIdx: 1, sinceMs: 61_000 },
			{ legIdx: 0, sinceMs: 60_000 },
			{ legIdx: 2, sinceMs: 60_001 },
		]);
		expect(out[1].distNM).toBeCloseTo(l0, 6);
		expect(out[2].distNM).toBeCloseTo(l0 + l1, 6);
	});

	it('ignores a pin naming a segment the route no longer has', () => {
		const plain = computeRouteProgress(pts, wps);
		expect(computeRouteProgress(pts, wps, 0, [{ legIdx: 9, sinceMs: 0 }])).toEqual(plain);
		expect(computeRouteProgress(pts, wps, 0, [{ legIdx: -1, sinceMs: 0 }])).toEqual(plain);
	});

	it('extends point-by-point to the same checkpoints as one full compute', () => {
		const pins = [
			{ legIdx: 0, sinceMs: 60_000 },
			{ legIdx: 2, sinceMs: 150_000 },
		];
		const full = computeRouteProgress(pts, wps, 0, pins);
		let inc: RouteProgressPoint[] = [];
		for (let i = 1; i <= pts.length; i++) {
			inc = extendRouteProgress(inc, pts.slice(0, i), wps, 0, pins);
		}
		expect(inc).toEqual(full);
	});
});

describe('progressDistNM', () => {
	const progress: RouteProgressPoint[] = [
		{ timeMs: 0, distNM: 0 },
		{ timeMs: 10_000, distNM: 10 },
		{ timeMs: 20_000, distNM: 30 },
	];

	it('is null with no checkpoints and clamped at the ends', () => {
		expect(progressDistNM([], 0)).toBeNull();
		expect(progressDistNM(progress, -5000)).toBe(0);
		expect(progressDistNM(progress, 99_000)).toBe(30);
	});

	it('interpolates between checkpoints, independent of query order', () => {
		expect(progressDistNM(progress, 5000)).toBeCloseTo(5, 6);
		expect(progressDistNM(progress, 15_000)).toBeCloseTo(20, 6);
		// Scrub back and forth: pure lookups answer identically.
		const a = progressDistNM(progress, 15_000);
		progressDistNM(progress, 2000);
		expect(progressDistNM(progress, 15_000)).toBe(a);
	});

	it('steps to the later checkpoint on duplicate timestamps', () => {
		const dup: RouteProgressPoint[] = [
			{ timeMs: 0, distNM: 0 },
			{ timeMs: 1000, distNM: 5 },
			{ timeMs: 1000, distNM: 7 },
			{ timeMs: 2000, distNM: 9 },
		];
		expect(progressDistNM(dup, 1000)).toBe(7);
	});
});

describe('offM (lateral offset)', () => {
	it('carries the flown lateral offset on each checkpoint', () => {
		const wps = [wp(0, 0), wp(0, 2)];
		// Flown 1 NM north of the drawn line: every checkpoint sits ~1852 m off.
		const off = 1 / 60;
		const pts = Array.from({ length: 11 }, (_, i) => tp(off, (i * 2) / 10, i * 1000));
		const out = computeRouteProgress(pts, wps);
		for (const c of out) {
			expect(c.offM).toBeDefined();
			expect(Math.abs((c.offM ?? 0) - NM_TO_METERS)).toBeLessThan(50);
		}
	});

	it('is near zero on the drawn line', () => {
		const wps = [wp(0, 0), wp(0, 1)];
		const out = computeRouteProgress([tp(0, 0.5, 0)], wps);
		expect(out[0].offM).toBeCloseTo(0, 3);
	});
});

describe('progressOffM', () => {
	const progress: RouteProgressPoint[] = [
		{ timeMs: 0, distNM: 0, offM: 0 },
		{ timeMs: 10_000, distNM: 10, offM: 1000 },
	];

	it('is null with no checkpoints or without the field, clamped at the ends', () => {
		expect(progressOffM([], 0)).toBeNull();
		expect(progressOffM([{ timeMs: 0, distNM: 0 }], 0)).toBeNull();
		expect(progressOffM(progress, -1)).toBe(0);
		expect(progressOffM(progress, 99_000)).toBe(1000);
	});

	it('interpolates between checkpoints', () => {
		expect(progressOffM(progress, 5000)).toBeCloseTo(500, 6);
	});
});
