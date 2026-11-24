/* The flight being recorded times its plan's forecast to itself
 * (state/navRoute.svelte.ts flightInProgress, read by firstDepartureMs /
 * routeDepartureMs in state/routeWind.svelte.ts; docs/wind-aloft.md,
 * "Offline"). Driven through the real motion fold and leg assignment over a
 * synthetic trace, since those decide it: the route being flown departed at
 * its takeoff, whatever the clock says; on the ground, before the takeoff or
 * after a landing, the route about to be flown departs at the next whole
 * hour, the plan's chain placed around THAT route, so a return trip flown
 * after a stop is not timed a stop and a trip late; nothing recorded times
 * the plan as planned. Only Date is faked: the next-hour fallback reads it. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/weather/openMeteo', async (orig) =>
	(await import('./helpers/fakeOpenMeteo')).withFakeColumns(await orig()),
);

import { fake } from './helpers/fakeOpenMeteo';
import type { TrackPoint } from '$lib/nav/trace';
import { computeNavLog } from '$lib/route/navlog';
import { chartWindowMs } from '$lib/components/flightprep/chartsPrefetch';
import { flightPrep } from '$lib/state/flightPrep.svelte';
import { nav } from '$lib/state/navRecording.svelte';
import { routes, routeSettings, type Route, type Waypoint } from '$lib/state/route.svelte';
import {
	ensureRouteWindFor,
	firstDepartureMs,
	pruneRouteWind,
	routeDepartureMs,
	routeWindMean,
} from '$lib/state/routeWind.svelte';
import { resetWindAloftForTest } from '$lib/state/windAloft.svelte';

const S = 1000;
const MIN = 60 * S;
const at = (h: number, m: number, s = 0): number => Date.UTC(2026, 8, 27, h, m, s);

/** A (47.0 N) and B (47.5 N) on 2 E: 30 NM, 18 min at the plan's 100 kt. */
const A = { lat: 47, lon: 2 };
const B = { lat: 47.5, lon: 2 };
const TRIP_MIN = 18;

let seq = 0;
function leg(from: { lat: number; lon: number }, to: { lat: number; lon: number }): Route {
	const id = `fip-${seq++}`;
	const wp = (p: { lat: number; lon: number }, i: number): Waypoint => ({
		id: `${id}-${i}`,
		lat: p.lat,
		lon: p.lon,
		kind: 'free',
		alt: 3000,
		altAuto: true,
	});
	return { id, name: null, selectedWaypointId: null, waypoints: [wp(from, 0), wp(to, 1)] };
}

/** Fixes every `stepS` seconds standing at `p`, from `t0` for `secs`. */
function ground(p: { lat: number; lon: number }, t0: number, secs: number, stepS = 5): TrackPoint[] {
	return Array.from({ length: Math.floor(secs / stepS) }, (_, k) => ({
		lat: p.lat,
		lon: p.lon,
		altFt: 300,
		timeMs: t0 + k * stepS * S,
		speedKt: 0,
	}));
}

/** Fixes every 10 s flying from `from` to `to` at 100 kt from `t0`, climbing
 *  from the runway: the takeoff streak starts at `t0`. */
function fly(
	from: { lat: number; lon: number },
	to: { lat: number; lon: number },
	t0: number,
): TrackPoint[] {
	const n = Math.round((TRIP_MIN * MIN) / (10 * S));
	return Array.from({ length: n + 1 }, (_, k) => ({
		lat: from.lat + ((to.lat - from.lat) * k) / n,
		lon: from.lon + ((to.lon - from.lon) * k) / n,
		altFt: Math.min(3000, 300 + k * 200),
		timeMs: t0 + k * 10 * S,
		speedKt: 100,
	}));
}

/** Record `points`, the clock at the last of them. */
function recorded(points: TrackPoint[]): void {
	nav.points = points;
	nav.recording = true;
	vi.setSystemTime(points[points.length - 1].timeMs);
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(at(9, 30));
	fake.reset();
	resetWindAloftForTest();
	routeSettings.cruiseSpeedKt = 100;
	flightPrep.dossier.flightDate = null;
	flightPrep.dossier.departureTime = null;
});

afterEach(() => {
	pruneRouteWind([]);
	vi.useRealTimers();
	routes.list = [];
	nav.points = [];
	nav.recording = false;
	nav.interrupted = false;
	flightPrep.dossier.flightDate = null;
	flightPrep.dossier.departureTime = null;
	flightPrep.dossier.stopsMin = [];
});

describe('the route being flown departed at its takeoff', () => {
	it('keeps the next whole hour on the ground, then the takeoff, whatever the clock says', () => {
		const trip = leg(A, B);
		routes.list = [trip];
		recorded(ground(A, at(9, 30), 60));
		expect(firstDepartureMs()).toBe(at(10, 0));
		recorded([...ground(A, at(9, 30), 60), ...fly(A, B, at(9, 31)).slice(0, 30)]);
		expect(routeDepartureMs(trip.id)).toBe(at(9, 31));
		// Past the hour the fallback rolled to 11:00 and re-timed the plan.
		vi.setSystemTime(at(10, 5));
		expect(routeDepartureMs(trip.id)).toBe(at(9, 31));
	});

	it('serves the flight from one fetch across the hour, offline after it', async () => {
		const trip = leg(A, B);
		routes.list = [trip];
		recorded([...ground(A, at(9, 30), 60), ...fly(A, B, at(9, 31)).slice(0, 30)]);
		await ensureRouteWindFor(trip);
		vi.setSystemTime(at(10, 5));
		fake.fail = true;
		await ensureRouteWindFor(trip);
		expect(fake.calls).toBe(1);
		expect(routeWindMean(trip)).toBe('Mean forecast wind 250°/20 kt');
	});

	it('stands down at a landing: the ground has the next whole hour again', () => {
		const trip = leg(A, B);
		routes.list = [trip];
		const t = [...ground(A, at(9, 30), 60), ...fly(A, B, at(9, 31))];
		recorded([...t, ...ground(B, at(9, 49, 10), 5 * 60)]);
		expect(firstDepartureMs()).toBe(at(10, 0));
	});

	it('is the plan as planned while nothing is recorded: a replay, a loaded trace', () => {
		const trip = leg(A, B);
		routes.list = [trip];
		recorded([...ground(A, at(9, 30), 60), ...fly(A, B, at(9, 31)).slice(0, 30)]);
		nav.recording = false;
		expect(routeDepartureMs(trip.id)).toBe(at(10, 0));
	});
});

describe('a plan of several trips is timed around the one flown', () => {
	/** A -> B, a 90 min stop at B, then B -> A; `chain` is how long after the
	 *  outbound trip's departure the return trip's falls (its still-air time,
	 *  a little over 18 min, plus the stop). */
	function roundTrip(): { out: Route; back: Route; chain: number } {
		const out = leg(A, B);
		const back = leg(B, A);
		routes.list = [out, back];
		flightPrep.dossier.stopsMin = [90];
		const ete = computeNavLog(out.waypoints, 100).totalEteMin!;
		return { out, back, chain: (ete + 90) * MIN };
	}
	const outbound = (): TrackPoint[] => [...ground(A, at(9, 30), 60), ...fly(A, B, at(9, 31))];

	it('times the trip about to be flown from the next field at the next whole hour', () => {
		const { out, back, chain } = roundTrip();
		recorded([...outbound(), ...ground(B, at(9, 49, 10), 20 * 60)]);
		// 10:09 on the ground at B: the return trip departs at 11:00, never at
		// the next hour plus the outbound trip plus the stop (12:48).
		expect(routeDepartureMs(back.id)).toBe(at(11, 0));
		expect(routeDepartureMs(out.id)).toBeCloseTo(at(11, 0) - chain, 3);
	});

	it('times the return trip to its own takeoff once it is flown', () => {
		const { out, back, chain } = roundTrip();
		const takeoff = at(10, 10);
		// Past the junction ring, where the fold opens the return trip's leg.
		recorded([...outbound(), ...ground(B, at(9, 49, 10), 20 * 60), ...fly(B, A, takeoff).slice(0, 40)]);
		expect(routeDepartureMs(back.id)).toBe(takeoff);
		expect(routeDepartureMs(out.id)).toBeCloseTo(takeoff - chain, 3);
	});

	it('times a trip reached through a touch-and-go to the arrival at its junction', () => {
		const { back } = roundTrip();
		// Straight back without stopping: no landing, so no takeoff of its own,
		// and the outbound takeoff (09:31) is no departure of the return trip.
		const out = fly(A, B, at(9, 31));
		const turn = fly(B, A, out[out.length - 1].timeMs + 10 * S);
		recorded([...ground(A, at(9, 30), 60), ...out, ...turn.slice(0, 60)]);
		const dep = routeDepartureMs(back.id);
		expect(dep).toBeGreaterThanOrEqual(out[0].timeMs + 17 * MIN);
		expect(dep).toBeLessThanOrEqual(out[out.length - 1].timeMs);
	});
});

describe('the TEMSI / WINTEM a dossier prints', () => {
	it('are the ones still ahead of a flight printed hours into it', () => {
		const trip = leg(A, B);
		routes.list = [trip];
		recorded([...ground(A, at(9, 30), 60), ...fly(A, B, at(9, 31)).slice(0, 30)]);
		expect(chartWindowMs().startMs).toBe(at(9, 31));
		// Printed at 11:40 with the flight still recorded: from the current
		// hour, never the 09:31 to 11:31 that had passed.
		vi.setSystemTime(at(11, 40));
		expect(chartWindowMs()).toEqual({ startMs: at(11, 0), endMs: at(13, 0) });
		// Planning, the fallback is ahead of the clock already.
		nav.recording = false;
		expect(chartWindowMs().startMs).toBe(at(12, 0));
	});
});

describe('the dossier date', () => {
	it('keeps its own day when it plans a later flight, and gives way when it is past', () => {
		const trip = leg(A, B);
		routes.list = [trip];
		recorded([...ground(A, at(9, 30), 60), ...fly(A, B, at(9, 31)).slice(0, 30)]);
		flightPrep.dossier.flightDate = '2026-09-28';
		expect(firstDepartureMs()).toBe(Date.UTC(2026, 8, 28));
		// A plan flown again carries the day it was first planned for.
		flightPrep.dossier.flightDate = '2026-09-20';
		expect(firstDepartureMs()).toBe(at(9, 31));
		flightPrep.dossier.flightDate = '2026-09-27';
		expect(firstDepartureMs()).toBe(at(9, 31));
	});

	it('a stated ETD still wins, the plan the pilot printed', () => {
		const trip = leg(A, B);
		routes.list = [trip];
		recorded([...ground(A, at(9, 30), 60), ...fly(A, B, at(9, 31)).slice(0, 30)]);
		flightPrep.dossier.flightDate = '2026-09-27';
		flightPrep.dossier.departureTime = '10:00';
		expect(firstDepartureMs()).toBe(at(10, 0));
	});
});
