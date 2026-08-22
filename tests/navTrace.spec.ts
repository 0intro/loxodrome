/* Unit tests for the pure track helpers: replay interpolation (positionAt),
 * motion inference (deriveMotion), decimation (downsample) and bounds. */

import { describe, it, expect } from 'vitest';
import {
	positionAt,
	deriveMotion,
	downsample,
	traceBounds,
	traceStartMs,
	traceEndMs,
	projectedPositions,
	smoothedMotionAt,
	MS_PER_KT,
	VECTOR_MINUTES,
	type TrackPoint,
} from '$lib/nav/trace';
import { destinationPoint } from '$lib/notam/geometry';

const track: TrackPoint[] = [
	{ lat: 48, lon: 2, altFt: 1000, timeMs: 0 },
	{ lat: 49, lon: 2, altFt: 2000, timeMs: 10_000 },
	{ lat: 50, lon: 2, altFt: 3000, timeMs: 20_000 },
];

describe('positionAt', () => {
	it('returns null for an empty track', () => {
		expect(positionAt([], 0)).toBeNull();
	});

	it('clamps before the first and after the last fix', () => {
		expect(positionAt(track, -5000)?.lat).toBe(48);
		expect(positionAt(track, 999_999)?.lat).toBe(50);
	});

	it('interpolates position and altitude by time fraction', () => {
		const f = positionAt(track, 5000);
		expect(f).not.toBeNull();
		expect(f?.lat).toBeCloseTo(48.5, 6);
		expect(f?.altFt).toBeCloseTo(1500, 6);
	});

	it('derives a northbound heading from the segment', () => {
		expect(positionAt(track, 5000)?.trackDeg).toBeCloseTo(0, 3);
	});
});

describe('deriveMotion', () => {
	it('gives 1 kt for 1 NM travelled in one hour, heading north', () => {
		// 1 NM north = 1852 m / 111320 m-per-deg of latitude.
		const a: TrackPoint = { lat: 48, lon: 2, altFt: null, timeMs: 0 };
		const b: TrackPoint = { lat: 48 + 1852 / 111320, lon: 2, altFt: null, timeMs: 3_600_000 };
		const { speedKt, trackDeg } = deriveMotion(a, b);
		expect(speedKt).toBeCloseTo(1, 2);
		expect(trackDeg).toBeCloseTo(0, 2);
	});

	it('is zero speed for a zero time delta', () => {
		const a: TrackPoint = { lat: 48, lon: 2, altFt: null, timeMs: 5000 };
		const b: TrackPoint = { lat: 49, lon: 2, altFt: null, timeMs: 5000 };
		expect(deriveMotion(a, b).speedKt).toBe(0);
	});
});

describe('downsample', () => {
	const many: TrackPoint[] = Array.from({ length: 100 }, (_, i) => ({
		lat: 48 + i / 1000,
		lon: 2,
		altFt: null,
		timeMs: i * 1000,
	}));

	it('is a copy when already within the cap', () => {
		const out = downsample(many, 200);
		expect(out).toHaveLength(100);
		expect(out).not.toBe(many);
	});

	it('caps to about max points, always keeping first and last', () => {
		const out = downsample(many, 10);
		expect(out.length).toBeLessThanOrEqual(11);
		expect(out[0]).toBe(many[0]);
		expect(out[out.length - 1]).toBe(many[99]);
	});
});

describe('bounds and slider ends', () => {
	it('computes the lat/lon box', () => {
		expect(traceBounds(track)).toEqual({ south: 48, west: 2, north: 50, east: 2 });
		expect(traceBounds([])).toBeNull();
	});

	it('reports the first and last fix times', () => {
		expect(traceStartMs(track)).toBe(0);
		expect(traceEndMs(track)).toBe(20_000);
		expect(traceStartMs([])).toBeNull();
	});
});

describe('projectedPositions', () => {
	it('projects due east at ground speed x time', () => {
		// 120 kt on track 090 for 2 min = 4 NM east.
		const pos = projectedPositions(48, 2, 90, 120, VECTOR_MINUTES);
		expect(pos.map((p) => p.min)).toEqual(VECTOR_MINUTES);
		const two = pos[0];
		expect(two.min).toBe(2);
		expect(two.lat).toBeCloseTo(48, 2); // east track barely changes latitude at 4 NM
		// 4 NM east at 48N ~ 4 / (60 * cos48) deg of longitude.
		expect(two.lon).toBeCloseTo(2 + 4 / (60 * Math.cos((48 * Math.PI) / 180)), 2);
		expect(two.lon).toBeGreaterThan(2);
	});

	it('returns nothing when stationary', () => {
		expect(projectedPositions(48, 2, 90, 0, VECTOR_MINUTES)).toEqual([]);
	});
});

describe('smoothedMotionAt', () => {
	// A fix at an explicit time carrying device speed/track (default position, so
	// the turn-rate estimate, which reads positions, stays zero unless a helper
	// supplies a curving track).
	function fix(
		timeMs: number,
		speedKt: number,
		trackDeg: number,
		lat = 48,
		lon = 2,
	): TrackPoint {
		return { lat, lon, altFt: null, timeMs, speedKt, trackDeg };
	}

	it('derives the vertical speed from alt-carrying fixes, null without them', () => {
		// A constant 500 ft/min climb: +50 ft every 6 s across the window.
		const climb = Array.from({ length: 5 }, (_, i) => ({
			...fix(-24_000 + i * 6000, 100, 90),
			altFt: 1000 + i * 50,
		}));
		expect(smoothedMotionAt(climb, 0)?.vsFpm).toBeCloseTo(500, 6);
		const level = climb.map((p) => ({ ...p, altFt: 1500 }));
		expect(smoothedMotionAt(level, 0)?.vsFpm).toBeCloseTo(0, 6);
		// No altitudes at all: a rate cannot be taken.
		expect(smoothedMotionAt([fix(-6000, 100, 90), fix(0, 100, 90)], 0)?.vsFpm).toBeNull();
	});

	// A genuine constant-rate turn: step the position along the current heading,
	// then advance the heading, so the position bearings (turn rate) and the
	// stored track ramp together.
	function arcTrack(o: {
		hdg0: number;
		rateDegS: number;
		speedKt: number;
		n: number;
		dtSec: number;
		t0: number;
	}): TrackPoint[] {
		const pts: TrackPoint[] = [];
		let lat = 48;
		let lon = 2;
		let hdg = o.hdg0;
		const stepM = o.speedKt * MS_PER_KT * o.dtSec;
		for (let i = 0; i < o.n; i++) {
			pts.push({
				lat,
				lon,
				altFt: null,
				timeMs: o.t0 + i * o.dtSec * 1000,
				speedKt: o.speedKt,
				trackDeg: ((hdg % 360) + 360) % 360,
			});
			const d = destinationPoint(lat, lon, hdg, stepM);
			lat = d.lat;
			lon = d.lon;
			hdg += o.rateDegS * o.dtSec;
		}
		return pts;
	}

	// Signed shortest difference b - a in (-180, 180], used to measure lag.
	const angleDelta = (a: number, b: number) => ((b - a + 540) % 360) - 180;

	it('vector-means the track across the 360 wrap (350 & 010 -> ~360)', () => {
		const m = smoothedMotionAt([fix(0, 100, 350), fix(0, 120, 10)], 0);
		expect(m).not.toBeNull();
		expect(m?.speedKt).toBeCloseTo(110, 6);
		// Near 0/360, not the arithmetic mean 180. Speed-weighting tugs it off an
		// exact 0 (100 vs 120 kt), so pin the wrap, not a precise angle.
		const t = m?.trackDeg ?? 0;
		expect(Math.min(t, 360 - t)).toBeLessThan(2);
	});

	it('is a closed-form time-weighted blend (ages 0 & tau, headings 0 & 90)', () => {
		// Newest (age 0, weight 1) heads 000; oldest (age tau=8 s, weight e^-1)
		// heads 090. atan2(e^-1, 1) = 20.19 deg, independent of the internals.
		const m = smoothedMotionAt([fix(-8000, 100, 90), fix(0, 100, 0)], 0, 8);
		expect(m?.trackDeg).toBeCloseTo(20.19, 1);
		expect(m?.speedKt).toBeCloseTo(100, 6);
	});

	it('is cadence-invariant for steady flight', () => {
		// Same constant 120 kt / 090 over 30 s, sampled 1 Hz vs irregularly. The
		// weighted mean of identical samples is that sample, whatever the cadence.
		const dense = Array.from({ length: 31 }, (_, i) => fix(-30_000 + i * 1000, 120, 90));
		const sparse = [-30_000, -23_000, -11_000, -3000, 0].map((t) => fix(t, 120, 90));
		const a = smoothedMotionAt(dense, 0);
		const b = smoothedMotionAt(sparse, 0);
		expect(a?.speedKt).toBeCloseTo(120, 6);
		expect(a?.trackDeg).toBeCloseTo(90, 6);
		expect(b?.speedKt).toBeCloseTo(a?.speedKt ?? 0, 6);
		expect(b?.trackDeg).toBeCloseTo(a?.trackDeg ?? 0, 6);
	});

	it('is causal: later fixes never change an earlier instant', () => {
		const base = [fix(-4000, 100, 80), fix(-2000, 110, 85), fix(0, 120, 90)];
		const extended = [...base, fix(2000, 130, 95), fix(4000, 140, 100)];
		// Evaluated at the last shared instant, the future fixes are out of scope.
		expect(smoothedMotionAt(extended, 0)).toEqual(smoothedMotionAt(base, 0));
	});

	it('recovers a constant turn rate and shortens its memory in the turn', () => {
		const turn = arcTrack({ hdg0: 90, rateDegS: 0.5, speedKt: 120, n: 31, dtSec: 1, t0: -30_000 });
		const m = smoothedMotionAt(turn, 0);
		expect(m).not.toBeNull();
		expect(m?.turnRateDegS).toBeCloseTo(0.5, 1);
		// A gentle 0.5 deg/s turn keeps tau off its floor, so a shorter base tau
		// lags the live heading less than the default does.
		const latest = turn[turn.length - 1].trackDeg as number;
		const adaptive = smoothedMotionAt(turn, 0, 8);
		const short = smoothedMotionAt(turn, 0, 2.5);
		const lag = (x?: number) => Math.abs(angleDelta(x ?? 0, latest));
		expect(lag(short?.trackDeg)).toBeLessThan(lag(adaptive?.trackDeg));
	});

	it('estimates turn rate across the 360 wrap without a spike', () => {
		// 350 -> 000 -> 010 must read as a small positive rate, not a ~-340 deg/s
		// unwrap artefact.
		const turn = arcTrack({ hdg0: 350, rateDegS: 5, speedKt: 120, n: 6, dtSec: 1, t0: -5000 });
		const m = smoothedMotionAt(turn, 0);
		expect(m?.turnRateDegS).toBeGreaterThan(0);
		expect(m?.turnRateDegS).toBeLessThan(20);
	});

	it('returns null on incoherent (opposing) fixes, not a false north', () => {
		// atan2(0, 0) is 0 in JS (due north); the coherence guard rejects it.
		expect(smoothedMotionAt([fix(0, 100, 0), fix(0, 100, 180)], 0)).toBeNull();
	});

	it('is null when the window is empty, stale or stationary; one good fix suffices', () => {
		expect(smoothedMotionAt([], 0)).toBeNull();
		expect(smoothedMotionAt([fix(-40_000, 100, 90)], 0)).toBeNull(); // older than the window
		expect(smoothedMotionAt([fix(-1000, 2, 90), fix(0, 3, 90)], 0)).toBeNull(); // < MIN_VECTOR_KT
		// One in-window fix carrying device motion is enough (time, not count).
		const one = smoothedMotionAt([fix(0, 100, 90)], 0);
		expect(one?.speedKt).toBeCloseTo(100, 6);
		expect(one?.trackDeg).toBeCloseTo(90, 6);
		expect(one?.turnRateDegS).toBe(0);
	});
});
