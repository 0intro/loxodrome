/* The route forecast's columns kept per point (state/routeWind.svelte.ts):
 * a column fetched at a leg's midpoint (or a segment's center) serves any
 * route asking there while it is still the model's run and holds the plan's
 * hours, so an edit asks only for the legs it moved, an edit undone and a
 * return over the outbound legs ask for nothing, and a new run or another
 * model asks again. Each location costs Open-Meteo a call per ten
 * variables, so this is what editing a plan costs. Only Date is faked. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/weather/openMeteo', async (orig) =>
	(await import('./helpers/fakeOpenMeteo')).withFakeColumns(await orig()),
);

import { fake } from './helpers/fakeOpenMeteo';
import { legMidpoints, legSegments } from '$lib/route/legWind';
import { flightPrep } from '$lib/state/flightPrep.svelte';
import type { Route, Waypoint } from '$lib/state/route.svelte';
import {
	ensureRouteCloudsFor,
	ensureRouteWindFor,
	pruneRouteWind,
	routeCloudCover,
	routeForecastModel,
	routeWindMean,
} from '$lib/state/routeWind.svelte';
import { ensureModelRun, modelRunMs, resetWindAloftForTest, windAloft } from '$lib/state/windAloft.svelte';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 9, 40);
const RUN_A = Date.UTC(2026, 9, 2, 6);
const RUN_B = Date.UTC(2026, 9, 2, 9);
const MEAN = 'Mean forecast wind 250°/20 kt';

let seq = 0;
/** A route due north along 2°E through the given latitudes, at 3000 ft. */
function route(...lats: number[]): Route {
	const id = `cells-${seq++}`;
	return {
		id,
		name: null,
		selectedWaypointId: null,
		waypoints: lats.map(
			(lat, i): Waypoint => ({ id: `${id}-${i}`, lat, lon: 2, kind: 'free', alt: 3000, altAuto: true }),
		),
	};
}

/** The runs known before anything is asked for, so every column is
 *  stamped with them. */
async function knownRun(r: Route, run: number): Promise<void> {
	const model = routeForecastModel(r);
	fake.runMs = run;
	ensureModelRun(model);
	await vi.waitFor(() => expect(modelRunMs(model)).toBe(run));
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T0);
	fake.reset();
	resetWindAloftForTest();
	flightPrep.dossier.flightDate = '2026-10-02';
	flightPrep.dossier.departureTime = '10:00';
});

afterEach(() => {
	pruneRouteWind([]);
	vi.useRealTimers();
	flightPrep.dossier.flightDate = null;
	flightPrep.dossier.departureTime = null;
	windAloft.model = 'auto';
});

describe('an edit', () => {
	it('asks only for the leg it moved', async () => {
		const r = route(47, 47.5, 48, 48.5, 49);
		await knownRun(r, RUN_A);
		await ensureRouteWindFor(r);
		expect(fake.requests[0].points).toHaveLength(4);
		// The last pin moved: only the last leg's midpoint is new.
		r.waypoints[4].lat = 49.2;
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(2);
		expect(fake.requests[1].points).toEqual([legMidpoints(r.waypoints)[3]]);
		expect(routeWindMean(r)).toBe(MEAN);
		// 4 legs x 4.2, then 1 x 4.2.
		expect(fake.weight).toBeCloseTo(21, 9);
	});

	it('undone, asks for nothing', async () => {
		const r = route(47, 47.5, 48);
		await knownRun(r, RUN_A);
		await ensureRouteWindFor(r);
		r.waypoints[1].lat = 47.6;
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(2);
		r.waypoints[1].lat = 47.5;
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(2);
		expect(routeWindMean(r)).toBe(MEAN);
	});

	it('of the clouds, asks only for the segments it moved', async () => {
		const r = route(47, 48, 49);
		await knownRun(r, RUN_A);
		await ensureRouteWindFor(r);
		await ensureRouteCloudsFor(r);
		const before = legSegments(r.waypoints);
		r.waypoints[2].lat = 49.1;
		await ensureRouteWindFor(r);
		await ensureRouteCloudsFor(r);
		const after = legSegments(r.waypoints).map((s) => ({ lat: s.lat, lon: s.lon }));
		const moved = after.filter((p) => !before.some((b) => b.lat === p.lat && b.lon === p.lon));
		expect(fake.requests[3].opts.clouds).toBe(true);
		expect(fake.requests[3].points).toEqual(moved);
		expect(routeCloudCover(r)).toHaveLength(after.length);
	});
});

describe('two routes over the same legs', () => {
	it('share them: a return over the outbound legs asks for nothing', async () => {
		const out = route(47, 47.5, 48);
		await knownRun(out, RUN_A);
		await ensureRouteWindFor(out);
		const back = route(48, 47.5, 47);
		await ensureRouteWindFor(back);
		expect(fake.calls).toBe(1);
		expect(routeWindMean(back)).toBe(MEAN);
	});
});

describe('what asks again', () => {
	it('a new run, for every point, once', async () => {
		const r = route(47, 47.5, 48, 48.5);
		await knownRun(r, RUN_A);
		await ensureRouteWindFor(r);
		vi.setSystemTime(T0 + 16 * MIN);
		await knownRun(r, RUN_B);
		await ensureRouteWindFor(r);
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(2);
		expect(fake.requests[1].points).toHaveLength(3);
	});

	it('another model, whose columns are its own', async () => {
		const r = route(47, 47.5, 48);
		await ensureRouteWindFor(r);
		windAloft.model = 'icon_seamless';
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(2);
		expect(fake.requests[1].points).toHaveLength(2);
	});

	it('every route removed: nothing is kept for a plan that is gone', async () => {
		const r = route(47, 47.5, 48);
		await ensureRouteWindFor(r);
		pruneRouteWind([]);
		await ensureRouteWindFor(route(47, 47.5, 48));
		expect(fake.calls).toBe(2);
	});
});
