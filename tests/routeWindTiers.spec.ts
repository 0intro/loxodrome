/* What a route's forecast asks Open-Meteo for (state/routeWind.svelte.ts,
 * docs/wind-aloft.md "Per-leg planning wind"): its WINDS at each leg's
 * midpoint, the full ladder with temperatures and no cloud, which every wind
 * reader reads; its CLOUDS at each leg segment, heights and cover and no
 * wind, only when the curtain is asked for (the route profile, the dossier's
 * print). Each location costs Open-Meteo a call per ten variables, so this is
 * what a plan costs. Only Date is faked. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/weather/openMeteo', async (orig) =>
	(await import('./helpers/fakeOpenMeteo')).withFakeColumns(await orig()),
);

import { fake } from './helpers/fakeOpenMeteo';
import { legMidpoints, legSegments } from '$lib/route/legWind';
import { display } from '$lib/state/display.svelte';
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
import { hourlyVariables, windModel } from '$lib/weather/openMeteo';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 9, 40);
const RUN_A = Date.UTC(2026, 9, 2, 6);
const RUN_B = Date.UTC(2026, 9, 2, 9);

let seq = 0;
/** A route due north along 2°E through the given latitudes (60 NM a
 *  degree), at 3000 ft. */
function route(...lats: number[]): Route {
	const id = `tiers-${seq++}`;
	return {
		id,
		name: null,
		selectedWaypointId: null,
		waypoints: lats.map(
			(lat, i): Waypoint => ({ id: `${id}-${i}`, lat, lon: 2, kind: 'free', alt: 3000, altAuto: true }),
		),
	};
}

const asked = (i: number): string[] => {
	const { opts } = fake.requests[i];
	return hourlyVariables(windModel(opts.model), opts);
};

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
	display.liveWeather = true;
	windAloft.model = 'auto';
	windAloft.useForecastForLegs = true;
});

describe('the winds', () => {
	it('are asked at each leg’s midpoint, with temperatures and no cloud, one call per ten variables', async () => {
		// Two legs of 60 NM: six cloud segments, two wind points.
		const r = route(47, 48, 49);
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(1);
		expect(fake.requests[0].points).toEqual(legMidpoints(r.waypoints));
		const vars = asked(0);
		expect(vars).toHaveLength(42);
		expect(vars).toContain('temperature_850hPa');
		expect(vars.some((v) => v.startsWith('cloud_cover'))).toBe(false);
		// 2 locations x 4.2: 8.4 calls, where every segment with clouds cost 31.2.
		expect(fake.weight).toBeCloseTo(8.4, 9);
		expect(routeWindMean(r)).toBe('Mean forecast wind 250°/20 kt');
		// The curtain was never asked for.
		expect(routeCloudCover(r)).toBeNull();
	});

	it('follow the model’s own ladder (ECMWF’s reduced one)', async () => {
		windAloft.model = 'ecmwf_ifs025';
		const r = route(47, 48);
		await ensureRouteWindFor(r);
		expect(asked(0)).toHaveLength(26);
	});
});

describe('the clouds', () => {
	it('are asked only for the curtain, at each segment, heights and cover and no wind', async () => {
		const r = route(47, 48, 49);
		await ensureRouteWindFor(r);
		await ensureRouteCloudsFor(r);
		expect(fake.calls).toBe(2);
		expect(fake.requests[1].points).toEqual(legSegments(r.waypoints).map((s) => ({ lat: s.lat, lon: s.lon })));
		const vars = asked(1);
		expect(vars).toHaveLength(20);
		expect(vars.some((v) => v.startsWith('wind_'))).toBe(false);
		expect(vars).toContain('geopotential_height_850hPa');
		expect(vars).toContain('cloud_cover_850hPa');
		const curtain = routeCloudCover(r);
		expect(curtain).toHaveLength(6);
		expect(curtain?.[0].levels.some((l) => l.coverPct === 70)).toBe(true);
	});

	it('are held and refreshed like the winds: once per model run', async () => {
		const r = route(47, 48, 49);
		const model = routeForecastModel(r);
		fake.runMs = RUN_A;
		ensureModelRun(model);
		await vi.waitFor(() => expect(modelRunMs(model)).toBe(RUN_A));
		await ensureRouteWindFor(r);
		await ensureRouteCloudsFor(r);
		await ensureRouteCloudsFor(r);
		expect(fake.calls).toBe(2);
		vi.setSystemTime(T0 + 16 * MIN);
		fake.runMs = RUN_B;
		ensureModelRun(model);
		await vi.waitFor(() => expect(modelRunMs(model)).toBe(RUN_B));
		await ensureRouteCloudsFor(r);
		expect(fake.calls).toBe(3);
		expect(fake.requests[2].opts.clouds).toBe(true);
	});

	it('are never asked while the forecast is off', async () => {
		const r = route(47, 48);
		windAloft.useForecastForLegs = false;
		await ensureRouteCloudsFor(r);
		display.liveWeather = false;
		windAloft.useForecastForLegs = true;
		await ensureRouteCloudsFor(r);
		expect(fake.calls).toBe(0);
	});
});
