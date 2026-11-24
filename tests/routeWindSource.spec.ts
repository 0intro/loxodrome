/* The plan's wind source (state/routeWind.svelte.ts, docs/wind-aloft.md
 * "The wind source"): Forecast flies each leg on the forecast, the plan's
 * manual wind only where it misses; Manual flies every leg on that wind,
 * while the forecast stays fetched for what the Forecast source would give.
 * The Route tab reads the legs the forecast misses and its one-line source
 * from here. Only Date is faked. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/weather/openMeteo', async (orig) =>
	(await import('./helpers/fakeOpenMeteo')).withFakeColumns(await orig()),
);

import { fake } from './helpers/fakeOpenMeteo';
import { display } from '$lib/state/display.svelte';
import { flightPrep } from '$lib/state/flightPrep.svelte';
import { routeSettings, type Route, type Waypoint } from '$lib/state/route.svelte';
import {
	effectiveRouteWinds,
	ensureRouteWindFor,
	pruneRouteWind,
	routeForecastMissedLegs,
	routeLegForecasts,
	routeMeanForecast,
	routeWindBrief,
	routeWindEteMin,
	routeWindMean,
} from '$lib/state/routeWind.svelte';
import { resetWindAloftForTest, windAloft } from '$lib/state/windAloft.svelte';

const T0 = Date.UTC(2026, 9, 2, 9, 40);

let seq = 0;
/** A route due north along 2°E through the given latitudes, at 3000 ft. */
function route(...lats: number[]): Route {
	const id = `source-${seq++}`;
	return {
		id,
		name: null,
		selectedWaypointId: null,
		waypoints: lats.map(
			(lat, i): Waypoint => ({ id: `${id}-${i}`, lat, lon: 2, kind: 'free', alt: 3000, altAuto: true }),
		),
	};
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
	display.liveWeather = true;
	windAloft.useForecastForLegs = true;
	routeSettings.windDirDeg = null;
	routeSettings.windSpeedKt = null;
});

describe('a Manual wind source', () => {
	it('flies every leg on the manual wind, the forecast still fetched for the comparison', async () => {
		const r = route(47, 48, 49);
		windAloft.useForecastForLegs = false;
		routeSettings.windDirDeg = 90;
		routeSettings.windSpeedKt = 10;
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(1);
		expect(effectiveRouteWinds(r).map((w) => w?.source)).toEqual(['manual', 'manual']);
		// What the Forecast source would give: the forecast's 250/20.
		const forecast = effectiveRouteWinds(r, { source: 'forecast' });
		expect(forecast.map((w) => [w?.source, Math.round(w?.dirDeg ?? -1), Math.round(w?.speedKt ?? -1)])).toEqual([
			['forecast', 250, 20],
			['forecast', 250, 20],
		]);
		const manualEte = routeWindEteMin(r);
		const forecastEte = routeWindEteMin(r, { source: 'forecast' });
		expect(manualEte).not.toBeNull();
		expect(forecastEte).not.toBeNull();
		expect(forecastEte).not.toBeCloseTo(manualEte!, 3);
		// The plan says nothing of a forecast it does not fly.
		expect(routeWindMean(r)).toBeNull();
		expect(routeMeanForecast(r)).toBeNull();
		expect(routeWindBrief(r)).toBeNull();
		expect(routeForecastMissedLegs(r)).toEqual([]);
	});

	it('leaves the legs in still air with no wind typed', async () => {
		const r = route(47, 48);
		windAloft.useForecastForLegs = false;
		await ensureRouteWindFor(r);
		expect(effectiveRouteWinds(r)).toEqual([null]);
	});

	it('fetches nothing with live weather off, the comparison then having no forecast', async () => {
		const r = route(47, 48);
		windAloft.useForecastForLegs = false;
		display.liveWeather = false;
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(0);
		expect(effectiveRouteWinds(r, { source: 'forecast' })).toEqual([null]);
	});
});

describe('a Forecast wind source', () => {
	it('states its source and the mean wind', async () => {
		const r = route(47, 48, 49);
		await ensureRouteWindFor(r);
		expect(routeWindBrief(r)).toMatch(/, mean wind 250°\/20 kt$/);
		const mean = routeMeanForecast(r);
		expect(mean?.kind).toBe('mean');
		if (mean?.kind === 'mean') {
			expect([Math.round(mean.dirDeg), Math.round(mean.speedKt)]).toEqual([250, 20]);
		}
	});

	it('names the legs it misses, a leg flying its own wind never missed', async () => {
		const r = route(47, 48, 49, 50);
		fake.windAt = (i) => (i === 1 ? null : [250, 20]);
		await ensureRouteWindFor(r);
		expect(routeLegForecasts(r)?.map((f) => f.ok)).toEqual([true, false, true]);
		expect(routeForecastMissedLegs(r)).toEqual([2]);
		// The missed leg flies the manual wind typed for it.
		routeSettings.windDirDeg = 90;
		routeSettings.windSpeedKt = 10;
		expect(effectiveRouteWinds(r).map((w) => w?.source)).toEqual(['forecast', 'manual', 'forecast']);
		r.waypoints[1].windDirDeg = 100;
		r.waypoints[1].windSpeedKt = 5;
		expect(routeForecastMissedLegs(r)).toEqual([]);
	});

	it('misses nothing while a first fetch is in flight, every leg once it failed', async () => {
		const r = route(47, 48, 49);
		let release!: () => void;
		fake.hold = new Promise<void>((res) => (release = res));
		fake.fail = true;
		const pending = ensureRouteWindFor(r);
		expect(routeForecastMissedLegs(r)).toEqual([]);
		expect(routeWindBrief(r)).toBe('Fetching the forecast...');
		release();
		await pending;
		expect(routeForecastMissedLegs(r)).toEqual([1, 2]);
		expect(routeWindBrief(r)).toBeNull();
	});
});
