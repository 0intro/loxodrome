/* Unit tests for the pure live nav-log core (nav/navlogLive): the motion fold
 * (takeoff detection by sustained speed with a streak-start commit, its
 * landing mirror, block times), the crossing fold (crossing interpolation,
 * gating, watermark, jump segments, backward-re-seed revocation, incremental
 * == batch), the estimate chain at an instant (anchor ladder, live target,
 * recalage on actuals, arrival, scrub-back), the display mapping and the
 * clock formatter. */

import { describe, it, expect } from 'vitest';
import {
	newMotionFold,
	newCrossingFold,
	extendMotion,
	extendCrossings,
	liveNavlogAt,
	toNavlogDisplay,
	TAKEOFF_KT,
	TAKEOFF_SUSTAIN_MS,
	type CrossingFold,
	type MotionFold,
	type LiveNavlogFmt,
} from '$lib/nav/navlogLive';
import { computeRouteProgress, type RouteProgressPoint } from '$lib/nav/routeProgress';
import { computeNavLog } from '$lib/route/navlog';
import { fmtClockUtc, fmtClockUtcSec } from '$lib/route/format';
import type { TrackPoint } from '$lib/nav/trace';
import type { Waypoint } from '$lib/state/route.svelte';

let nextId = 0;
function wp(lat: number, lon: number): Waypoint {
	return { id: `t${nextId++}`, lat, lon, kind: 'free', alt: 3000, altAuto: true };
}

function tp(lat: number, lon: number, timeMs: number, speedKt?: number): TrackPoint {
	return { lat, lon, altFt: null, timeMs, speedKt: speedKt ?? null };
}

/** Synthetic index-aligned points + checkpoints: one fast (or given-speed)
 *  point per checkpoint, so the takeoff sub-fold sees the wanted speeds and
 *  the crossing sub-fold the wanted distances. */
function synth(
	ds: number[],
	opts: { dtMs?: number; speedKt?: number | ((i: number) => number) } = {},
): { points: TrackPoint[]; checkpoints: RouteProgressPoint[] } {
	const dt = opts.dtMs ?? 10_000;
	const speedOf =
		typeof opts.speedKt === 'function' ? opts.speedKt : (): number => (opts.speedKt as number) ?? 100;
	return {
		points: ds.map((_, i) => tp(0, 0, i * dt, speedOf(i))),
		checkpoints: ds.map((d, i) => ({ timeMs: i * dt, distNM: d, offM: 0 })),
	};
}

/** Both folds over one trace, driven the way state/navLive drives them: the
 *  motion fold's committed takeoff gates the crossing fold. Passing `prev`
 *  extends in place, which is how the incremental == batch pins run. */
interface Passages {
	motion: MotionFold;
	crossings: CrossingFold;
}

function foldPassages(
	points: TrackPoint[],
	checkpoints: RouteProgressPoint[],
	boundariesNM: number[],
	prev?: Passages,
): Passages {
	const p = prev ?? { motion: newMotionFold(), crossings: newCrossingFold(boundariesNM) };
	extendMotion(p.motion, points);
	extendCrossings(p.crossings, checkpoints, boundariesNM, p.motion.takeoffMs);
	return p;
}

/** A motion fold already airborne since `takeoffMs`, for the assembly tests
 *  that hand-build their state rather than folding a trace. */
function airborneAt(takeoffMs: number): MotionFold {
	return { ...newMotionFold(), idx: 2, takeoffMs };
}

/** Two 60 NM equator legs: waypoints at lon 0 / 1 / 2. */
function twoLegRoute(): { wps: Waypoint[]; boundaries: number[]; legs: { legNM: number; cumNM: number }[] } {
	const wps = [wp(0, 0), wp(0, 1), wp(0, 2)];
	const legs = computeNavLog(wps, 100).legs;
	return { wps, boundaries: legs.map((l) => l.cumNM), legs };
}

describe('takeoff detection', () => {
	const { wps, boundaries } = twoLegRoute();

	function foldFor(points: TrackPoint[]): Passages {
		return foldPassages(points, computeRouteProgress(points, wps), boundaries);
	}

	it('commits at the start of a sustained streak', () => {
		const f = foldFor([
			tp(0, 0, 0, 5),
			tp(0, 0.001, 10_000, TAKEOFF_KT + 10),
			tp(0, 0.002, 10_000 + TAKEOFF_SUSTAIN_MS, TAKEOFF_KT + 20),
		]);
		expect(f.motion.takeoffMs).toBe(10_000);
	});

	it('rejects a single fast spike between slow fixes', () => {
		const f = foldFor([
			tp(0, 0, 0, 5),
			tp(0, 0.001, 10_000, TAKEOFF_KT + 5),
			tp(0, 0.001, 20_000, 4),
			tp(0, 0.0012, 30_000, 6),
		]);
		expect(f.motion.takeoffMs).toBeNull();
	});

	it('backfills missing speeds from the hop (GPX traces)', () => {
		// 0.0278 deg of equator lon per minute is roughly 100 kt.
		const pts = Array.from({ length: 4 }, (_, i) => tp(0, i * 0.0278, i * 60_000));
		const f = foldFor(pts);
		// The first fix has no predecessor: the streak starts at the second.
		expect(f.motion.takeoffMs).toBe(60_000);
	});

	it('never commits on an all-slow trace, leaving the log unstarted', () => {
		const pts = Array.from({ length: 6 }, (_, i) => tp(0, i * 0.0001, i * 10_000, 8));
		const f = foldFor(pts);
		expect(f.motion.takeoffMs).toBeNull();
		expect(f.crossings.crossMs.every((c) => c === null)).toBe(true);
	});
});

describe('the ground-roll gate', () => {
	// A point WITH an altitude: the evidence channel the gate reads.
	function tpa(sec: number, speedKt: number, altFt: number | null): TrackPoint {
		return { lat: 0, lon: sec * 0.0001, altFt, timeMs: sec * 1000, speedKt };
	}

	it('an aborted takeoff roll never commits: fast, flat, then slow', () => {
		// The corpus shape: 50 kt held twelve seconds at field elevation,
		// then the abort. Speed alone reads as a departure; the altitude
		// says the wheels never left.
		const pts = [
			tpa(0, 5, 350),
			...Array.from({ length: 12 }, (_, i) => tpa(1 + i, 50, 352)),
			tpa(13, 15, 351),
			tpa(80, 4, 350),
		];
		const m = extendMotion(newMotionFold(), pts);
		expect(m.takeoffMs).toBeNull();
		expect(m.takeoffsMs).toEqual([]);
	});

	it('a real departure commits at the streak start, rise confirming it', () => {
		const pts = [
			tpa(0, 5, 350),
			...Array.from({ length: 15 }, (_, i) => tpa(1 + i, 45 + i * 2, 350 + i * 20)),
		];
		const m = extendMotion(newMotionFold(), pts);
		expect(m.takeoffMs).toBe(1000);
	});

	it('altitude dropouts inside the streak do not lose the departure', () => {
		const pts = [
			tpa(0, 5, 350),
			tpa(1, 45, 350),
			tpa(2, 47, null),
			tpa(3, 50, null),
			...Array.from({ length: 10 }, (_, i) => tpa(4 + i, 55, 380 + i * 25)),
		];
		const m = extendMotion(newMotionFold(), pts);
		expect(m.takeoffMs).toBe(1000);
	});

	it('a trace with no altitude at all keeps the sustain-alone rule', () => {
		const pts = [tp(0, 0, 0, 5), ...Array.from({ length: 7 }, (_, i) => tp(0, 0.001 * i, (1 + i) * 1000, 50))];
		const m = extendMotion(newMotionFold(), pts);
		expect(m.takeoffMs).toBe(1000);
	});

	it('a flat streak outliving the guard commits: no abort runs that long', () => {
		const pts = [
			tpa(0, 5, 350),
			...Array.from({ length: 22 }, (_, i) => tpa(1 + i, 50, 352)),
		];
		const m = extendMotion(newMotionFold(), pts);
		expect(m.takeoffMs).toBe(1000);
	});

	it('the re-arm needs the rise: a fast flat run of ANY length keeps the landing', () => {
		// Airborne, landed (60 s slow), then thirty fast seconds at field
		// elevation: the drive home under the auto-stop grace holds 45 kt
		// on a flat road far past the initial streak's 20 s time guard, and
		// must not resurrect the flight. The same run climbing does.
		const flight = [
			tpa(0, 5, 350),
			...Array.from({ length: 10 }, (_, i) => tpa(1 + i, 60, 350 + i * 40)),
			...Array.from({ length: 70 }, (_, i) => tpa(11 + i, 8, 352)),
		];
		const flat = [...flight, ...Array.from({ length: 30 }, (_, i) => tpa(81 + i, 45, 353))];
		const mFlat = extendMotion(newMotionFold(), flat);
		expect(mFlat.landingMs).toBe(11_000);
		expect(mFlat.takeoffsMs).toHaveLength(1);

		const climb = [...flight, ...Array.from({ length: 12 }, (_, i) => tpa(81 + i, 45, 353 + i * 20))];
		const mClimb = extendMotion(newMotionFold(), climb);
		expect(mClimb.landingMs).toBeNull();
		expect(mClimb.takeoffsMs).toEqual([1000, 81_000]);

		// A speed-only trace keeps the sustain-alone re-arm (nothing to judge by).
		const blind = [
			tp(0, 0, 0, 5),
			...Array.from({ length: 10 }, (_, i) => tp(0, 0.001 * i, (1 + i) * 1000, 60)),
			...Array.from({ length: 70 }, (_, i) => tp(0, 0.01, (11 + i) * 1000, 8)),
			...Array.from({ length: 8 }, (_, i) => tp(0, 0.01 + 0.001 * i, (81 + i) * 1000, 45)),
		];
		const mBlind = extendMotion(newMotionFold(), blind);
		expect(mBlind.landingMs).toBeNull();
	});

	it('incremental extension equals one batch fold, evidence fields included', () => {
		const pts = [
			tpa(0, 5, 350),
			...Array.from({ length: 30 }, (_, i) => tpa(1 + i, 45 + i, 350 + Math.max(0, i - 5) * 30)),
		];
		const batch = extendMotion(newMotionFold(), pts);
		const inc = newMotionFold();
		for (let i = 1; i <= pts.length; i++) {
			extendMotion(inc, pts.slice(0, i));
		}
		expect(inc).toEqual(batch);
	});
});

describe('landing and block times', () => {
	const { wps, boundaries } = twoLegRoute();

	function foldFor(points: TrackPoint[]): Passages {
		return foldPassages(points, computeRouteProgress(points, wps), boundaries);
	}

	/** Taxi out, fly, land, taxi in: one fix a minute along the equator. */
	function outing(speeds: number[]): TrackPoint[] {
		let lon = 0;
		return speeds.map((kt, i) => {
			const p = tp(0, lon, i * 60_000, kt);
			lon += kt / 3600 / 60; // NM per minute -> degrees of equator lon
			return p;
		});
	}

	it('commits the landing at the start of the sustained slow streak', () => {
		// 5 min taxi, 10 min flight, then stopped.
		const f = foldFor(outing([5, 5, 100, 100, 100, 100, 10, 5, 3, 0]));
		expect(f.motion.takeoffMs).toBe(2 * 60_000);
		expect(f.motion.landingMs).toBe(6 * 60_000);
		expect(f.motion.firstMoveMs).toBe(0);
		expect(f.motion.lastMoveMs).toBe(8 * 60_000);
		expect(f.motion.takeoffsMs).toEqual([2 * 60_000]);
		expect(f.motion.landingsMs).toEqual([6 * 60_000]);
	});

	it('needs the streak sustained, so a touch-and-go is not a landing', () => {
		// A single slow fix mid-flight (a steep-turn ground speed, a bad fix).
		const f = foldFor(outing([100, 100, 100, 15, 100, 100, 100]));
		expect(f.motion.landingMs).toBeNull();
		// And the instants record grows nothing either: a touch-and-go is not
		// GPS-detectable, by design (the logbook figure may undercount).
		expect(f.motion.takeoffsMs).toEqual([0]);
		expect(f.motion.landingsMs).toEqual([]);
	});

	it('re-arms after a stop-and-go, keeping the LAST landing', () => {
		const f = foldFor(
			outing([5, 100, 100, 100, 5, 5, 5, 100, 100, 100, 100, 5, 5, 5, 5]),
		);
		expect(f.motion.takeoffMs).toBe(60_000);
		expect(f.motion.landingMs).toBe(11 * 60_000);
		// The instants record keeps BOTH committed landings and the re-arm's
		// takeoff: a stop-and-go is a landing plus a takeoff in a logbook,
		// even though the scalar landingMs was cleared and re-stamped.
		expect(f.motion.takeoffsMs).toEqual([60_000, 7 * 60_000]);
		expect(f.motion.landingsMs).toEqual([4 * 60_000, 11 * 60_000]);
	});

	it('extends point by point exactly like one batch fold', () => {
		const pts = outing([5, 100, 100, 100, 5, 5, 5, 100, 100, 5, 5, 5]);
		const batch = foldFor(pts);
		const inc: Passages = { motion: newMotionFold(), crossings: newCrossingFold(boundaries) };
		for (let i = 1; i <= pts.length; i++) {
			const slice = pts.slice(0, i);
			foldPassages(slice, computeRouteProgress(slice, wps), boundaries, inc);
		}
		expect(inc.motion.takeoffMs).toBe(batch.motion.takeoffMs);
		expect(inc.motion.landingMs).toBe(batch.motion.landingMs);
		expect(inc.motion.firstMoveMs).toBe(batch.motion.firstMoveMs);
		expect(inc.motion.lastMoveMs).toBe(batch.motion.lastMoveMs);
		expect(inc.motion.takeoffsMs).toEqual(batch.motion.takeoffsMs);
		expect(inc.motion.landingsMs).toEqual(batch.motion.landingsMs);
	});

	it('shows the block pair only once the landing is visible', () => {
		// Ends stopped, so the last fix under way is the one before it.
		const pts = outing([5, 100, 100, 100, 5, 5, 0]);
		const checkpoints = computeRouteProgress(pts, wps);
		const f = foldPassages(pts, checkpoints, boundaries);
		const legs = computeNavLog(wps, 100).legs;
		const mid = liveNavlogAt({
			legs,
			checkpoints,
			...f,
			tMs: 3 * 60_000,
			gsLiveKt: null,
			cruiseKt: 100,
			legGsKt: [null, null],
			etdMs: null,
		});
		expect(mid.landingMs).toBeNull();
		expect(mid.blockInMs).toBeNull();
		expect(mid.blockOutMs).toBe(0);
		const after = liveNavlogAt({
			legs,
			checkpoints,
			...f,
			tMs: 6 * 60_000,
			gsLiveKt: null,
			cruiseKt: 100,
			legGsKt: [null, null],
			etdMs: null,
		});
		expect(after.landingMs).toBe(4 * 60_000);
		expect(after.blockInMs).toBe(5 * 60_000);
	});
});

describe('passage fold', () => {
	const { wps, boundaries } = twoLegRoute();

	it('stamps a crossing time lerped inside the crossing segment', () => {
		// Airborne from t=0 (sustained by 10 s); the waypoint-1 boundary is
		// crossed inside the 0.95 -> 1.02 degree segment (t 30 s -> 40 s).
		const lons = [0.8, 0.85, 0.9, 0.95, 1.02, 1.07];
		const points = lons.map((lon, i) => tp(0, lon, i * 10_000, 100));
		const checkpoints = computeRouteProgress(points, wps);
		const f = foldPassages(points, checkpoints, boundaries);
		expect(f.motion.takeoffMs).toBe(0);
		expect(f.crossings.crossMs[0]).not.toBeNull();
		expect(f.crossings.crossMs[0]!).toBeGreaterThan(30_000);
		expect(f.crossings.crossMs[0]!).toBeLessThan(40_000);
		expect(f.crossings.crossMs[1]).toBeNull();
	});

	it('gates crossings at takeoff: taxi movement stamps nothing', () => {
		// A short 0.3 NM first leg; the taxi crosses it before ever going fast.
		const shortWps = [wp(0, 0), wp(0, 0.005), wp(0, 1)];
		const legs = computeNavLog(shortWps, 100).legs;
		const bs = legs.map((l) => l.cumNM);
		const points = [
			tp(0, 0, 0, 3),
			tp(0, 0.004, 60_000, 4),
			tp(0, 0.006, 120_000, 5),
			// Takeoff run and away.
			tp(0, 0.008, 180_000, 60),
			tp(0, 0.02, 190_000, 90),
		];
		const checkpoints = computeRouteProgress(points, shortWps);
		const f = foldPassages(points, checkpoints, bs);
		expect(f.motion.takeoffMs).toBe(180_000);
		// The 0.3 NM boundary was behind the post-takeoff seed: passed later by
		// position, never an ATO.
		expect(f.crossings.crossMs[0]).toBeNull();
	});

	it('keeps the watermark on a backtrack dip (no re-stamp)', () => {
		const { points, checkpoints } = synth([50, 54, 58, 61, 59.5, 61.5, 63]);
		const f = foldPassages(points, checkpoints, [60]);
		const first = f.crossings.crossMs[0];
		expect(first).not.toBeNull();
		// Stamped inside the 58 -> 61 segment; the dip back under 60 and the
		// re-crossing changed nothing.
		expect(first!).toBeGreaterThan(20_000);
		expect(first!).toBeLessThan(30_000);
	});

	it('consumes a jump segment without fabricating an ATO', () => {
		const { points, checkpoints } = synth([0, 4, 8, 40, 44, 48, 52, 56, 61]);
		const f = foldPassages(points, checkpoints, [20, 60]);
		// 8 -> 40 jumped over the 20 NM boundary: passed, no time.
		expect(f.crossings.crossMs[0]).toBeNull();
		// The later genuine crossing of 60 stamps normally.
		expect(f.crossings.crossMs[1]).not.toBeNull();
	});

	it('stamps nothing behind a mid-flight seed', () => {
		const { points, checkpoints } = synth([50, 54, 58, 61]);
		const f = foldPassages(points, checkpoints, [20, 60]);
		expect(f.crossings.crossMs[0]).toBeNull();
		expect(f.crossings.crossMs[1]).not.toBeNull();
	});

	it('never stamps the phantom takeoff pass of a closed route', () => {
		// The projection seeds near the route END (start == end), brushes past
		// the total (the seed guard holds the stamp back), then re-seeds to
		// the true outbound position: the genuine crossings stamp later.
		const ds = [39.2, 39.8, 40.2, 2, 6, 10, 14, 18, 22, 26, 30, 34, 38, 41];
		const { points, checkpoints } = synth(ds);
		const f = foldPassages(points, checkpoints, [20, 40.2]);
		// The mid boundary stamps inside the genuine 18 -> 22 segment...
		expect(f.crossings.crossMs[0]!).toBeGreaterThan(70_000);
		expect(f.crossings.crossMs[0]!).toBeLessThan(80_000);
		// ...and the destination inside 38 -> 41, not at the phantom takeoff pass.
		expect(f.crossings.crossMs[1]!).toBeGreaterThan(120_000);
		expect(f.crossings.crossMs[1]!).toBeLessThan(130_000);
	});

	it('keeps long-standing stamps across the landing flip of a closed route', () => {
		// Fly the whole route, then the projection flips back to the start on
		// landing: the flight's ink survives; only the cursor rewinds.
		const ds = [...Array.from({ length: 16 }, (_, i) => i * 4), 61, 1, 0.5];
		const { points, checkpoints } = synth(ds);
		const f = foldPassages(points, checkpoints, [20, 60]);
		expect(f.crossings.crossMs[0]).not.toBeNull();
		expect(f.crossings.crossMs[1]).not.toBeNull();
		expect(f.crossings.nextB).toBe(0);
	});

	it('suppresses stamps inside the initial seed guard', () => {
		// Joining just below a boundary: the fresh identity is unproven, so
		// the crossing passes without an ATO.
		const { points, checkpoints } = synth([10, 11, 12.5, 14]);
		const f = foldPassages(points, checkpoints, [11.5]);
		expect(f.crossings.crossMs[0]).toBeNull();
	});

	it('stamps inside the guard zone on a chained leg', () => {
		// The same geometry read as the continuation of a preceding leg: the
		// identity comes from the junction, not from the seed, so a waypoint
		// within SEED_GUARD_NM of the start stamps normally.
		const { checkpoints } = synth([0, 1, 2.5, 4]);
		const f = extendCrossings(newCrossingFold([1.5]), checkpoints, [1.5], 0, true);
		expect(f.crossMs[0]).not.toBeNull();
		expect(f.crossMs[0]!).toBeGreaterThan(10_000);
		expect(f.crossMs[0]!).toBeLessThan(20_000);
	});

	it('extends incrementally to the same fold as one batch run', () => {
		// A slow prefix (commit mid-way exercises the fast-forward), cruise, a
		// backward re-seed (revocation) and a forward jump.
		const ds = [0, 0.1, 0.2, 5, 15, 30, 45, 61, 20, 24, 62, 121];
		const { points, checkpoints } = synth(ds, {
			speedKt: (i) => (i < 3 ? 5 : 100),
		});
		const batch = foldPassages(points, checkpoints, [60, 120]);
		const inc: Passages = { motion: newMotionFold(), crossings: newCrossingFold([60, 120]) };
		for (let i = 1; i <= points.length; i++) {
			foldPassages(points.slice(0, i), checkpoints.slice(0, i), [60, 120], inc);
		}
		expect(inc).toEqual(batch);
	});

	it('restarts defensively on a boundary-count mismatch', () => {
		const { points, checkpoints } = synth(Array.from({ length: 17 }, (_, i) => i * 4));
		const f = foldPassages(points, checkpoints, [60]);
		expect(f.crossings.crossMs[0]).not.toBeNull();
		foldPassages(points, checkpoints, [30, 60], f);
		expect(f.crossings.crossMs).toHaveLength(2);
		expect(f.crossings.crossMs[0]).not.toBeNull();
		expect(f.crossings.crossMs[1]).not.toBeNull();
	});
});

describe('liveNavlogAt', () => {
	/** Two exact 60 NM legs (synthetic: precise expected clocks). */
	const legs = [
		{ legNM: 60, cumNM: 60 },
		{ legNM: 60, cumNM: 120 },
	];
	/** Airborne at t=0, waypoint 1 crossed at t=520 s. */
	const motion = airborneAt(0);
	const crossings: CrossingFold = {
		idx: 2,
		watermarkNM: 70,
		nextB: 1,
		guardTopNM: null,
		crossMs: [520_000, null],
	};
	/** Straight progress: 60 NM in 600 s. */
	const checkpoints: RouteProgressPoint[] = [
		{ timeMs: 0, distNM: 0, offM: 0 },
		{ timeMs: 1_200_000, distNM: 120, offM: 0 },
	];
	const base = {
		legs,
		checkpoints,
		motion,
		crossings,
		cruiseKt: 100,
		legGsKt: [120, 60] as (number | null)[],
		etdMs: null,
		gsLiveKt: null,
	};

	it('freezes a passed row at its recalage value and stamps the ATO', () => {
		const s = liveNavlogAt({ ...base, tMs: 600_000 });
		// Waypoint 1: anchored on the takeoff + the planned 30 min of leg 1.
		expect(s.wpts[1].etoMs).toBe(30 * 60_000);
		expect(s.wpts[1].atoMs).toBe(520_000);
		expect(s.wpts[0].atoMs).toBe(0);
		expect(s.wpts[0].etoMs).toBeNull();
		// The destination (the target at D=60) estimates live off the planned
		// leg-2 ground speed: 60 NM at 60 kt from now.
		expect(s.currentLegIdx).toBe(1);
		expect(s.wpts[2].etoMs).toBe(600_000 + 60 * 60_000);
		expect(s.etaMs).toBe(s.wpts[2].etoMs);
	});

	it('anchors on the actual passage, not the original plan (recalage)', () => {
		// Three legs; waypoint 2 was passed late: waypoint 2 is frozen at
		// waypoint 1's ACTUAL + the planned leg, and the estimate chain
		// continues from the target's live figure.
		const legs3 = [
			{ legNM: 60, cumNM: 60 },
			{ legNM: 60, cumNM: 120 },
			{ legNM: 60, cumNM: 180 },
		];
		const cross3: CrossingFold = {
			idx: 2,
			watermarkNM: 150,
			nextB: 2,
			guardTopNM: null,
			crossMs: [520_000, 4_500_000, null],
		};
		const cps: RouteProgressPoint[] = [
			{ timeMs: 0, distNM: 0, offM: 0 },
			{ timeMs: 1_800_000, distNM: 180, offM: 0 },
		];
		const s = liveNavlogAt({
			legs: legs3,
			checkpoints: cps,
			motion: airborneAt(0),
			crossings: cross3,
			tMs: 1_500_000,
			gsLiveKt: 60,
			cruiseKt: 100,
			legGsKt: [120, 60, 60],
			etdMs: null,
		});
		expect(s.currentLegIdx).toBe(2);
		expect(s.wpts[1].etoMs).toBe(30 * 60_000);
		// Frozen recalage: ATO(wpt 1) + planned leg 2, not the original plan.
		expect(s.wpts[2].etoMs).toBe(520_000 + 60 * 60_000);
		// The target at D=150: 30 NM at the live 60 kt.
		expect(s.wpts[3].etoMs).toBe(1_500_000 + 30 * 60_000);
	});

	it('chains from the explicit ETD before takeoff and blanks without one', () => {
		const preTakeoff = { motion: airborneAt(900_000), crossings: { ...crossings, crossMs: [null, null] } };
		const withEtd = liveNavlogAt({ ...base, ...preTakeoff, tMs: 100_000, etdMs: 7_200_000 });
		expect(withEtd.takeoffMs).toBeNull();
		expect(withEtd.wpts[1].etoMs).toBe(7_200_000 + 30 * 60_000);
		expect(withEtd.wpts[2].etoMs).toBe(7_200_000 + 90 * 60_000);
		const without = liveNavlogAt({ ...base, ...preTakeoff, tMs: 100_000 });
		expect(without.wpts[1].etoMs).toBeNull();
		expect(without.wpts[2].etoMs).toBeNull();
	});

	it('estimates the target at the live speed and chains the plan beyond', () => {
		// At t=300 s the position is 30 NM: mid leg 1, 30 NM from waypoint 1.
		const s = liveNavlogAt({ ...base, tMs: 300_000, gsLiveKt: 60 });
		expect(s.currentLegIdx).toBe(0);
		expect(s.currentLegFrac!).toBeCloseTo(0.5, 6);
		expect(s.gsUsedKt).toBe(60);
		// 30 NM at 60 kt = 30 min; the destination adds the planned 60 min.
		expect(s.wpts[1].etoMs).toBe(300_000 + 30 * 60_000);
		expect(s.wpts[2].etoMs).toBe(300_000 + 90 * 60_000);
		expect(s.etaMs).toBe(s.wpts[2].etoMs);
	});

	it('falls back to the planned leg speed, then cruise, for the target', () => {
		const planned = liveNavlogAt({ ...base, tMs: 300_000 });
		// Leg 1 planned GS 120 kt: 30 NM in 15 min.
		expect(planned.gsUsedKt).toBe(120);
		expect(planned.wpts[1].etoMs).toBe(300_000 + 15 * 60_000);
		const cruise = liveNavlogAt({ ...base, tMs: 300_000, legGsKt: [null, null] });
		expect(cruise.gsUsedKt).toBe(100);
	});

	it('measures the arrival against the plan flown from the departure', () => {
		// Planned: 30 min on leg 1 at 120 kt, 60 min on leg 2 at 60 kt. Halfway
		// at t = 10 min, the target estimated at the planned 60 kt puts the
		// arrival at 70 min: twenty ahead of the ninety planned.
		const s = liveNavlogAt({ ...base, tMs: 600_000 });
		expect(s.etaMs).toBe(4_200_000);
		expect(s.planDeltaMin).toBeCloseTo(-20, 6);
		// Landed late: the ACTUAL arrival is what the figure then compares, so
		// the number stands as the flight's result.
		const landed: CrossingFold = { ...crossings, crossMs: [520_000, 6_000_000] };
		const late = liveNavlogAt({ ...base, crossings: landed, tMs: 6_000_000 });
		expect(late.wpts[2].atoMs).toBe(6_000_000);
		expect(late.planDeltaMin).toBeCloseTo(10, 6);
	});

	it('has no plan figure before departure or without a planned time', () => {
		// A late departure is not counted in it: with nothing airborne there is
		// no time gained or lost in the air yet.
		const before = liveNavlogAt({ ...base, motion: newMotionFold(), tMs: 600_000, etdMs: 0 });
		expect(before.planDeltaMin).toBeNull();
		const noPlan = liveNavlogAt({ ...base, tMs: 600_000, cruiseKt: null, legGsKt: [null, null] });
		expect(noPlan.planDeltaMin).toBeNull();
	});

	it('estimates only the target when no cruise speed resolves the plan', () => {
		const s = liveNavlogAt({ ...base, tMs: 300_000, cruiseKt: null, gsLiveKt: 60 });
		expect(s.wpts[1].etoMs).toBe(300_000 + 30 * 60_000);
		expect(s.wpts[2].etoMs).toBeNull();
	});

	it('keeps a stamped waypoint behind the aircraft, its estimate frozen', () => {
		// A position behind an already stamped waypoint (a closed route's landed
		// projection flipping to the route start, a circuit at the waypoint): the
		// row stays passed, is never re-targeted, and its inked estimate must not
		// turn live again.
		const cps: RouteProgressPoint[] = [
			{ timeMs: 0, distNM: 0, offM: 0 },
			{ timeMs: 1_200_000, distNM: 60, offM: 0 },
		];
		const s = liveNavlogAt({ ...base, checkpoints: cps, tMs: 600_000, gsLiveKt: 90 });
		expect(s.currentLegIdx).toBe(1);
		expect(s.wpts[1].passed).toBe(true);
		expect(s.wpts[1].atoMs).toBe(520_000);
		// Frozen: takeoff + the planned 30 min, not a live 90 kt figure.
		expect(s.wpts[1].etoMs).toBe(30 * 60_000);
	});

	it('holds the active leg through a circuit at a stamped waypoint', () => {
		// A touch-and-go at waypoint 1: the position dips back over the boundary
		// after the ATO is inked, which must not re-target the waypoint.
		const cps: RouteProgressPoint[] = [
			{ timeMs: 0, distNM: 0, offM: 0 },
			{ timeMs: 600_000, distNM: 60, offM: 0 },
			{ timeMs: 700_000, distNM: 57, offM: 0 },
			{ timeMs: 800_000, distNM: 63, offM: 0 },
		];
		const circuit: CrossingFold = { ...crossings, crossMs: [600_000, null] };
		const dip = liveNavlogAt({ ...base, checkpoints: cps, crossings: circuit, tMs: 700_000 });
		expect(dip.distNM).toBeCloseTo(57, 6);
		expect(dip.currentLegIdx).toBe(1);
		expect(dip.currentLegFrac).toBe(0);
		expect(dip.wpts[1].passed).toBe(true);
		// Scrubbed back before the stamp, the waypoint is ahead again.
		const before = liveNavlogAt({ ...base, checkpoints: cps, crossings: circuit, tMs: 300_000 });
		expect(before.currentLegIdx).toBe(0);
		expect(before.wpts[1].passed).toBe(false);
	});

	it('lets a pinned segment re-target a stamped waypoint', () => {
		// The turn-back the ink floor exists to survive: waypoint 1 is stamped
		// and the position has dipped back behind it. Left alone the log holds
		// the later leg (the test above); told which segment is being flown, it
		// answers that one, and the stamp itself is untouched.
		const cps: RouteProgressPoint[] = [
			{ timeMs: 0, distNM: 0, offM: 0 },
			{ timeMs: 600_000, distNM: 60, offM: 0 },
			{ timeMs: 700_000, distNM: 45, offM: 0 },
		];
		const circuit: CrossingFold = { ...crossings, crossMs: [600_000, null] };
		const arg = { ...base, checkpoints: cps, crossings: circuit, tMs: 700_000 };
		expect(liveNavlogAt(arg).currentLegIdx).toBe(1);
		const s = liveNavlogAt({ ...arg, pinnedLegIdx: 0 });
		expect(s.currentLegIdx).toBe(0);
		expect(s.currentLegFrac).toBeCloseTo(0.75, 6);
		expect(s.wpts[1].atoMs).toBe(600_000);
	});

	it('lets a pinned segment un-arrive a route whose destination is stamped', () => {
		const cps: RouteProgressPoint[] = [
			{ timeMs: 0, distNM: 0, offM: 0 },
			{ timeMs: 1_200_000, distNM: 120, offM: 0 },
			{ timeMs: 1_260_000, distNM: 90, offM: 0 },
		];
		const landed: CrossingFold = { ...crossings, crossMs: [520_000, 1_200_000] };
		const arg = { ...base, checkpoints: cps, crossings: landed, tMs: 1_260_000 };
		expect(liveNavlogAt(arg).arrived).toBe(true);
		const s = liveNavlogAt({ ...arg, pinnedLegIdx: 1 });
		expect(s.arrived).toBe(false);
		expect(s.currentLegIdx).toBe(1);
		expect(s.wpts[2].atoMs).toBe(1_200_000);
	});

	it('stays arrived once the destination stamp is visible', () => {
		const cps: RouteProgressPoint[] = [
			{ timeMs: 0, distNM: 0, offM: 0 },
			{ timeMs: 1_200_000, distNM: 120, offM: 0 },
			{ timeMs: 1_260_000, distNM: 117, offM: 0 },
		];
		const landed: CrossingFold = { ...crossings, crossMs: [520_000, 1_200_000] };
		const s = liveNavlogAt({ ...base, checkpoints: cps, crossings: landed, tMs: 1_260_000 });
		expect(s.arrived).toBe(true);
		expect(s.currentLegIdx).toBeNull();
		expect(s.wpts[2].atoMs).toBe(1_200_000);
	});

	it('marks rows passed by position past a jump, without an ATO', () => {
		// At t=700 s the position is 70 NM: waypoint 1 is behind.
		const jumped: CrossingFold = { ...crossings, crossMs: [null, null] };
		const s = liveNavlogAt({ ...base, crossings: jumped, tMs: 700_000 });
		expect(s.wpts[1].passed).toBe(true);
		expect(s.wpts[1].atoMs).toBeNull();
		expect(s.currentLegIdx).toBe(1);
	});

	it('arrives near the destination, clears the target and freezes the chain', () => {
		const s = liveNavlogAt({ ...base, tMs: 1_197_000 });
		expect(s.distNM!).toBeGreaterThan(119.5);
		expect(s.arrived).toBe(true);
		expect(s.currentLegIdx).toBeNull();
		// The destination's estimate froze at its recalage value.
		expect(s.wpts[2].etoMs).toBe(520_000 + 60 * 60_000);
		expect(s.etaMs).toBe(s.wpts[2].etoMs);
	});

	it('answers a scrubbed-back playhead with the earlier state', () => {
		const s = liveNavlogAt({ ...base, tMs: 400_000 });
		// The waypoint-1 crossing (520 s) is in the playhead's future: no ATO,
		// and the row is the live target again (planned-GS estimate).
		expect(s.wpts[1].atoMs).toBeNull();
		expect(s.wpts[1].passed).toBe(false);
		expect(s.currentLegIdx).toBe(0);
		expect(s.wpts[1].etoMs).toBe(400_000 + 10 * 60_000);
		const before = liveNavlogAt({ ...base, tMs: -1000 });
		expect(before.takeoffMs).toBeNull();
		expect(before.currentLegIdx).toBeNull();
		expect(before.wpts[0].atoMs).toBeNull();
	});
});

describe('liveNavlogAt precomputed progress', () => {
	const legs = [
		{ legNM: 60, cumNM: 60 },
		{ legNM: 60, cumNM: 120 },
	];
	const crossings: CrossingFold = {
		idx: 2,
		watermarkNM: 70,
		nextB: 1,
		guardTopNM: null,
		crossMs: [520_000, null],
	};
	const checkpoints: RouteProgressPoint[] = [
		{ timeMs: 0, distNM: 0, offM: 0 },
		{ timeMs: 1_200_000, distNM: 120, offM: 0 },
	];
	const base = {
		legs,
		checkpoints,
		motion: airborneAt(0),
		crossings,
		cruiseKt: 100,
		legGsKt: [120, 60] as (number | null)[],
		etdMs: null,
		gsLiveKt: null,
	};

	it('honors a supplied distance, an explicit null, and omission alike', () => {
		// Omitted: the internal recompute puts t=300 s mid leg 1.
		expect(liveNavlogAt({ ...base, tMs: 300_000 }).currentLegIdx).toBe(0);
		// Supplied: 90 NM overrides the lookup into leg 2.
		const s = liveNavlogAt({ ...base, tMs: 300_000, distNM: 90, offM: 500 });
		expect(s.currentLegIdx).toBe(1);
		expect(s.distNM).toBe(90);
		expect(s.offM).toBe(500);
		// An explicit null is honored as "no position", never recomputed.
		const n = liveNavlogAt({ ...base, tMs: 300_000, distNM: null, offM: null });
		expect(n.distNM).toBeNull();
		expect(n.currentLegIdx).toBeNull();
	});
});

describe('passage fold over schedule boundaries', () => {
	// Schedule rows share the fold with the waypoint boundaries: an ascending
	// atNM list that may repeat (a leave and an enter at one sample).
	const bounds = [10, 20, 20, 30];

	it('stamps equal-atNM ties with one lerped time', () => {
		const { points, checkpoints } = synth([0, 4, 8, 12, 16, 21, 25, 29, 31]);
		const f = foldPassages(points, checkpoints, bounds);
		expect(f.crossings.crossMs.every((c) => c != null)).toBe(true);
		expect(f.crossings.crossMs[1]).toBe(f.crossings.crossMs[2]);
	});

	it('extends incrementally over duplicate boundaries like one batch run', () => {
		const { points, checkpoints } = synth([0, 4, 8, 12, 16, 21, 25, 29, 31]);
		const batch = foldPassages(points, checkpoints, bounds);
		const inc: Passages = { motion: newMotionFold(), crossings: newCrossingFold(bounds) };
		for (let i = 1; i <= points.length; i++) {
			foldPassages(points.slice(0, i), checkpoints.slice(0, i), bounds, inc);
		}
		expect(inc).toEqual(batch);
	});

	it('restarts defensively when the schedule changes the boundary count', () => {
		const { points, checkpoints } = synth([0, 4, 8, 12, 16, 21]);
		const f = foldPassages(points, checkpoints, [10, 20]);
		expect(f.crossings.crossMs[0]).not.toBeNull();
		foldPassages(points, checkpoints, [5, 10, 20], f);
		expect(f.crossings.crossMs).toHaveLength(3);
		expect(f.crossings.crossMs.every((c) => c != null)).toBe(true);
	});
});

describe('toNavlogDisplay', () => {
	const fmt: LiveNavlogFmt = { clock: (ms) => `c${ms}` };
	const legs = [
		{ legNM: 60, cumNM: 60 },
		{ legNM: 60, cumNM: 120 },
	];

	it('maps the single estimate + actual per row and flags the target', () => {
		const s = liveNavlogAt({
			legs,
			checkpoints: [
				{ timeMs: 0, distNM: 0, offM: 0 },
				{ timeMs: 1_200_000, distNM: 120, offM: 0 },
			],
			motion: airborneAt(0),
			crossings: {
				idx: 2,
				watermarkNM: 30,
				nextB: 0,
				guardTopNM: null,
				crossMs: [null, null],
			},
			tMs: 300_000,
			gsLiveKt: 60,
			cruiseKt: 100,
			legGsKt: [120, 60],
			etdMs: null,
		});
		const d = toNavlogDisplay(s, fmt);
		expect(d.wpts[0].passed).toBe(true);
		expect(d.wpts[0].ato).toBe('c0');
		expect(d.wpts[0].eto).toBe('');
		expect(d.wpts[1].target).toBe(true);
		expect(d.wpts[1].eto).toBe(`c${300_000 + 30 * 60_000}`);
		expect(d.wpts[1].ato).toBe('');
		expect(d.wpts[2].target).toBe(false);
		expect(d.wpts[2].eto).toBe(`c${300_000 + 90 * 60_000}`);
		expect(d.currentLegIdx).toBe(0);
		expect(d.currentLegFrac!).toBeCloseTo(0.5, 6);
	});
});

describe('clock formatter', () => {
	it('formats HH:MM UTC', () => {
		expect(fmtClockUtc(Date.UTC(2026, 6, 21, 9, 5))).toBe('09:05');
		expect(fmtClockUtc(Date.UTC(2026, 6, 21, 23, 59))).toBe('23:59');
	});

	it('formats HH:MM:SS UTC with seconds', () => {
		expect(fmtClockUtcSec(Date.UTC(2026, 6, 21, 9, 5, 7))).toBe('09:05:07');
		expect(fmtClockUtcSec(Date.UTC(2026, 6, 21, 23, 59, 59))).toBe('23:59:59');
		// Midnight rollover lands on the next UTC day at 00:00:00.
		expect(fmtClockUtcSec(Date.UTC(2026, 6, 21, 23, 59, 59) + 1000)).toBe('00:00:00');
	});
});
