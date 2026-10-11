/* Unit tests for the pure leg-assignment fold (nav/routeAssign): the seed at
 * a shared departure, the arrival-triggered handover across a touch-and-go
 * junction, the two junction instants, partial and repeated records, the
 * diversion rule firing and holding off, the manual pin, and extend == batch.
 *
 * The geometry is a chain of equator legs so the distances are readable: one
 * degree of equator longitude is 60 NM. */

import { describe, it, expect } from 'vitest';
import {
	assignRouteSegments,
	extendRouteAssignment,
	segmentAt,
	DEPARTURE_RADIUS_NM,
	JUNCTION_RADIUS_NM,
	type AssignRoute,
	type RouteSegment,
} from '$lib/nav/routeAssign';
import type { TrackPoint } from '$lib/nav/trace';
import type { Waypoint } from '$lib/state/route.svelte';

let nextId = 0;
function wp(lon: number, lat = 0): Waypoint {
	return { id: `w${nextId++}`, lat, lon, kind: 'free', alt: 3000, altAuto: true };
}

function route(id: string, waypoints: Waypoint[], alternate?: true): AssignRoute {
	return { id, waypoints, alternate };
}

/** One fix a minute along a list of longitudes (lat 0 unless paired). */
function trace(lons: (number | [number, number])[]): TrackPoint[] {
	return lons.map((v, i) => {
		const [lon, lat] = Array.isArray(v) ? v : [v, 0];
		return { lat, lon, altFt: null, timeMs: i * 60_000, speedKt: 100 };
	});
}

/** A - B - C chain flown straight through, the multi-leg plan's shape: three
 *  trips at lon 0 / 1 / 2, each with an alternate branching off to the south. */
function chainPlan(): AssignRoute[] {
	return [
		route('t1', [wp(0), wp(1)]),
		route('a1', [wp(1), wp(1.5, -0.5)], true),
		route('t2', [wp(1), wp(2)]),
		route('a2', [wp(2), wp(2.5, -0.5)], true),
	];
}

const ids = (segs: readonly RouteSegment[]): string[] => segs.map((s) => s.routeId);

describe('seeding', () => {
	it('takes the earliest trip departing where the trace starts', () => {
		// The last alternate departs the first trip's field: geometry cannot
		// separate them, the trip chain can.
		const routes = [
			route('t1', [wp(0), wp(1)]),
			route('t2', [wp(1), wp(2)]),
			route('a2', [wp(0), wp(0.5, -0.5)], true),
		];
		const segs = assignRouteSegments(trace([0, 0.25, 0.5, 0.75]), routes);
		expect(segs[0].routeId).toBe('t1');
		expect(segs[0].fromIdx).toBe(0);
		expect(segs[0].chained).toBe(false);
	});

	it('seeds a partial record on the leg it actually starts', () => {
		// Recording begun at the second junction: trip 2, not trip 1.
		const segs = assignRouteSegments(trace([1, 1.25, 1.5, 1.75]), chainPlan());
		expect(ids(segs)).toEqual(['t2']);
		expect(segs[0].toIdx).toBeNull();
	});

	it('falls back to the geometric fit when no departure is near', () => {
		// Airborne mid-way down leg 2, nowhere near any departure.
		const segs = assignRouteSegments(trace([1.4, 1.5, 1.6, 1.7, 1.8]), chainPlan());
		expect(ids(segs)).toEqual(['t2']);
	});

	it('assigns nothing when the trace flies none of the legs', () => {
		const away = trace([10, 10.2, 10.4, 10.6]);
		expect(assignRouteSegments(away, chainPlan())).toEqual([]);
	});

	it('assigns nothing without a trace or without a usable route', () => {
		expect(assignRouteSegments([], chainPlan())).toEqual([]);
		expect(assignRouteSegments(trace([0, 0.5]), [route('t1', [wp(0)])])).toEqual([]);
		// A zero-length route would arrive at its own departure forever.
		expect(assignRouteSegments(trace([0, 0.5]), [route('t1', [wp(0), wp(0)])])).toEqual([]);
	});
});

describe('handover', () => {
	it('hands over at the arrival, chaining the whole plan', () => {
		const segs = assignRouteSegments(trace([0, 0.5, 1, 1.5, 2]), chainPlan());
		expect(ids(segs)).toEqual(['t1', 't2']);
		expect(segs[0].toIdx).toBe(2);
		expect(segs[1].toIdx).toBe(4);
		expect(segs[1].chained).toBe(true);
	});

	it('closes the arrival on the first pass and opens the next on the last', () => {
		// A touch-and-go junction: three passes at lon 1 (indices 2, 4, 6)
		// before departing on leg 2. The circuits belong to the arrival.
		const segs = assignRouteSegments(
			trace([0, 0.5, 1, [0.99, 0.01], 1, [1.01, 0.01], 1, 1.5, 2]),
			chainPlan(),
		);
		expect(ids(segs)).toEqual(['t1', 't2']);
		expect(segs[0].toIdx).toBe(2); // first pass overhead
		expect(segs[1].fromIdx).toBe(6); // last fix still inside the junction
		expect(segs[1].fromMs).toBe(6 * 60_000);
	});

	it('never lets a landing gate the handover, since a junction is a fly-through', () => {
		// Every fix at cruise speed: no landing is detectable anywhere, and the
		// chain still walks.
		const pts = trace([0, 0.5, 1, 1.5, 2]).map((p) => ({ ...p, speedKt: 110 }));
		expect(ids(assignRouteSegments(pts, chainPlan()))).toEqual(['t1', 't2']);
	});

	it('marks a discontinuous plan unchained', () => {
		// Trip 2 departs somewhere trip 1 never reached.
		const routes = [route('t1', [wp(0), wp(1)]), route('t2', [wp(5), wp(6)])];
		const segs = assignRouteSegments(trace([0, 0.5, 1, 1.5]), routes);
		expect(segs[1].chained).toBe(false);
	});

	it('stops at the last trip instead of wrapping onto an alternate', () => {
		const routes = [
			route('t1', [wp(0), wp(1)]),
			route('a1', [wp(1), wp(1.5, -0.5)], true),
		];
		const segs = assignRouteSegments(trace([0, 0.5, 1, 1.02, 1.01]), routes);
		expect(ids(segs)).toEqual(['t1']);
	});
});

describe('diversion onto an alternate', () => {
	// The alternate runs due south from the junction; the trip carries on east.
	const routes = [
		route('t1', [wp(0), wp(1)]),
		route('t2', [wp(1), wp(2)]),
		route('a2', [wp(1), wp(1, -0.5)], true),
	];

	it('holds off while the trip is being flown', () => {
		const segs = assignRouteSegments(trace([0, 0.5, 1, 1.3, 1.6, 1.9]), routes);
		expect(ids(segs)).toEqual(['t1', 't2']);
	});

	it('reassigns the leg once the flight is decisively on the alternate', () => {
		// South from the junction: 0.5 degrees of latitude is 30 NM, well past
		// both the off-route threshold and the sustain distance.
		const segs = assignRouteSegments(
			trace([0, 0.5, 1, [1, -0.05], [1, -0.15], [1, -0.3], [1, -0.45]]),
			routes,
		);
		expect(ids(segs)).toEqual(['t1', 'a2']);
	});

	it('does not divert on a deviation that rejoins', () => {
		// About 6 NM off the trip's track and back: short of DIVERT_SUSTAIN_NM.
		const segs = assignRouteSegments(
			trace([0, 0.5, 1, [1.1, -0.1], [1.3, -0.1], [1.5, 0], 1.8]),
			routes,
		);
		expect(ids(segs)).toEqual(['t1', 't2']);
	});
});

describe('repeated and partial records', () => {
	it('reports the leg still open at the end of the trace', () => {
		const segs = assignRouteSegments(trace([0, 0.5, 1, 1.5]), chainPlan());
		expect(ids(segs)).toEqual(['t1', 't2']);
		expect(segs[1].toIdx).toBeNull();
		expect(segs[1].arrivalMs).toBeNull();
	});

	it('carries the median lateral offset of each leg', () => {
		// Leg 1 flown 0.05 degrees (3 NM) north of its track.
		const segs = assignRouteSegments(
			trace([[0, 0.05], [0.5, 0.05], [1, 0.05], 1.5, 2]),
			chainPlan(),
		);
		expect(segs[0].offNM).toBeGreaterThan(2.5);
		expect(segs[0].offNM).toBeLessThan(3.5);
		expect(segs[1].offNM).toBeLessThan(1);
	});
});

describe('segmentAt', () => {
	const segs = assignRouteSegments(
		trace([0, 0.5, 1, [0.99, 0.01], 1, 1.5, 2]),
		chainPlan(),
	);

	it('reads the leg that arrived while the flight is still at the junction', () => {
		expect(segs[1].fromMs).toBe(4 * 60_000);
		expect(segmentAt(segs, 3 * 60_000)?.routeId).toBe('t1');
		expect(segmentAt(segs, 4 * 60_000)?.routeId).toBe('t2');
		expect(segmentAt(segs, 5 * 60_000)?.routeId).toBe('t2');
	});

	it('clamps before the trace and answers null with no segments', () => {
		expect(segmentAt(segs, -1)?.routeId).toBe('t1');
		expect(segmentAt([], 0)).toBeNull();
	});
});

describe('manual pin', () => {
	const pts = trace([0, 0.5, 1, 1.5]);

	it('replaces the leg being flown and stops the chain there', () => {
		const segs = assignRouteSegments(pts, chainPlan(), 'a1');
		expect(ids(segs)).toEqual(['t1', 'a1']);
		expect(segs[1].pinned).toBe(true);
		expect(segs[1].fromIdx).toBe(2);
	});

	it('marks the pin without re-folding when it names the leg already open', () => {
		const segs = assignRouteSegments(pts, chainPlan(), 't2');
		expect(ids(segs)).toEqual(['t1', 't2']);
		expect(segs[1].pinned).toBe(true);
	});

	it('ignores a pin naming no loaded route', () => {
		expect(ids(assignRouteSegments(pts, chainPlan(), 'nope'))).toEqual(['t1', 't2']);
	});
});

describe('extendRouteAssignment', () => {
	it('extends fix by fix to the same segments as one batch run', () => {
		const pts = trace([0, 0.4, 0.8, 1, [0.99, 0.01], 1, 1.4, 1.8, 2, 2.02]);
		const routes = chainPlan();
		const batch = assignRouteSegments(pts, routes);
		let inc: RouteSegment[] = [];
		for (let i = 1; i <= pts.length; i++) {
			inc = extendRouteAssignment(inc, pts.slice(0, i), routes);
		}
		expect(inc).toEqual(batch);
	});

	it('extends to the same segments through a diversion', () => {
		const routes = [
			route('t1', [wp(0), wp(1)]),
			route('t2', [wp(1), wp(2)]),
			route('a2', [wp(1), wp(1, -0.5)], true),
		];
		const pts = trace([0, 0.5, 1, [1, -0.05], [1, -0.15], [1, -0.3], [1, -0.45]]);
		const batch = assignRouteSegments(pts, routes);
		let inc: RouteSegment[] = [];
		for (let i = 1; i <= pts.length; i++) {
			inc = extendRouteAssignment(inc, pts.slice(0, i), routes);
		}
		expect(inc).toEqual(batch);
	});

	it('re-derives a leg start the flight has not yet left for good', () => {
		// Just outside the junction ring but not clear of it: the last fix
		// inside is not yet known, so the leg it opens must not be cached as
		// settled and its start must follow if the flight comes back round.
		const routes = chainPlan();
		const early = trace([0, 0.5, 1, 1.02, 1.05]);
		const segsEarly = extendRouteAssignment([], early, routes);
		expect(segsEarly[1].fromIdx).toBe(3);
		expect(segsEarly[1].startFinal).toBe(false);
		// It did come back round, then left: the start moves to the true last
		// pass, and only once clear does it settle.
		const later = trace([0, 0.5, 1, 1.02, 1.05, 1.01, 1.3, 1.6]);
		const segsLater = extendRouteAssignment(segsEarly, later, routes);
		expect(segsLater[1].fromIdx).toBe(5);
		expect(segsLater[1].startFinal).toBe(true);
		expect(segsLater).toEqual(assignRouteSegments(later, routes));
	});

	it('starts over when the routes no longer hold the assigned leg', () => {
		const pts = trace([0, 0.5, 1, 1.5, 2]);
		const stale = assignRouteSegments(pts, chainPlan());
		const other = [route('r9', [wp(0), wp(2)])];
		expect(ids(extendRouteAssignment(stale, pts, other))).toEqual(['r9']);
	});
});

describe('calibration constants', () => {
	it('keeps the junction ring inside the departure radius', () => {
		// A junction is a tighter question than a departure: the ring must not
		// swallow a neighbouring leg's start.
		expect(JUNCTION_RADIUS_NM).toBeLessThan(DEPARTURE_RADIUS_NM);
	});
});
