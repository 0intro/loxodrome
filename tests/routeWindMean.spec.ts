/* The nav-log header's mean forecast wind (routeWindMean in
 * state/routeWind.svelte.ts, over the pure meanForecastWind whose rule
 * routeWind.spec.ts pins). What this spec holds is the WIRING, through a real
 * pass of the per-route forecast cache with only the network faked: each leg
 * reads the column of its own midpoint, the one point its winds are fetched
 * at, and weighs by its length, the two toggles
 * silence a cache entry that outlives them, nothing prints while the fetch is
 * in flight, after it failed or while a leg has no forecast, and a leg the
 * pilot overrode still counts with its forecast, while a plan whose every
 * leg is overridden, the forecast flying none, prints none. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindColumn } from '$lib/weather/openMeteo';

const fake = vi.hoisted(() => {
	const HOUR = 3600_000;
	return {
		/** The [direction, speed] of the column for request point `i`, or null
		 *  for a column with no hours at all (a leg the forecast cannot serve). */
		windAt: (_i: number): [number, number] | null => [250, 20],
		/** Holds the answer until resolved: the fetch in flight. */
		hold: null as Promise<void> | null,
		fail: false,
		/** Every request's points, oldest first. */
		points: [] as { lat: number; lon: number }[][],
		/** Every request's variables, oldest first. */
		variables: [] as string[][],
		/** A column holding one wind at both ladder levels and at 10 m, hourly
		 *  over the requested window. */
		column(
			p: { lat: number; lon: number },
			wind: [number, number] | null,
			startMs: number,
			endMs: number,
		): WindColumn {
			const t0 = Math.floor(startMs / HOUR) * HOUR;
			const n = wind ? Math.ceil((endMs - t0) / HOUR) + 2 : 0;
			const [dir, spd] = wind ?? [0, 0];
			const fill = (v: number): number[] => new Array<number>(n).fill(v);
			return {
				lat: p.lat,
				lon: p.lon,
				elevationM: 0,
				timesMs: Array.from({ length: n }, (_, k) => t0 + k * HOUR),
				hourly: {
					geopotential_height_925hPa: fill(800),
					wind_speed_925hPa: fill(spd),
					wind_direction_925hPa: fill(dir),
					temperature_925hPa: fill(5),
					geopotential_height_850hPa: fill(1500),
					wind_speed_850hPa: fill(spd),
					wind_direction_850hPa: fill(dir),
					temperature_850hPa: fill(2),
					wind_speed_10m: fill(spd),
					wind_direction_10m: fill(dir),
				},
			};
		},
	};
});

vi.mock('$lib/weather/openMeteo', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/weather/openMeteo')>();
	return {
		...actual,
		fetchWindColumns: async (
			points: readonly { lat: number; lon: number }[],
			opts: Parameters<typeof actual.fetchWindColumns>[1],
		): Promise<WindColumn[]> => {
			fake.points.push(points.map((p) => ({ lat: p.lat, lon: p.lon })));
			fake.variables.push(actual.hourlyVariables(actual.windModel(opts.model), opts));
			if (fake.hold) {
				await fake.hold;
			}
			if (fake.fail) {
				// A plain failure: a rate-limited one would arm the module's retry
				// timer and hold every later case behind it.
				throw new Error('forecast unreachable');
			}
			return points.map((p, i) => fake.column(p, fake.windAt(i), opts.startMs, opts.endMs));
		},
		// The run metadata is never asked of the network from a spec.
		fetchModelRun: () => Promise.resolve(null),
	};
});

import { legMidpoints, legSegments } from '$lib/route/legWind';
import { display } from '$lib/state/display.svelte';
import { flightPrep } from '$lib/state/flightPrep.svelte';
import { i18n } from '$lib/state/i18n.svelte';
import type { Route, Waypoint } from '$lib/state/route.svelte';
import { ensureRouteWindFor, pruneRouteWind, routeWindMean } from '$lib/state/routeWind.svelte';
import { windAloft } from '$lib/state/windAloft.svelte';

let seq = 0;
/** A route due north along 2°E through the given latitudes (60 NM a degree),
 *  at 3000 ft, between the fake columns' two ladder levels. A fresh id per
 *  route, the cache's bookkeeping being module-level. */
function route(...lats: number[]): Route {
	const id = `mean-wind-${seq++}`;
	return {
		id,
		name: null,
		selectedWaypointId: null,
		waypoints: lats.map(
			(lat, i): Waypoint => ({ id: `${id}-${i}`, lat, lon: 2, kind: 'free', alt: 3000, altAuto: true }),
		),
	};
}

/** The leg a request point belongs to: the winds are fetched one point per
 *  leg, in leg order. */
function legOf(_r: Route): (i: number) => number {
	return (i) => i;
}

beforeEach(() => {
	// Tomorrow 10:00Z: inside the forecast's range, and a stated departure,
	// so the cache key does not move with the clock between two reads.
	flightPrep.dossier.flightDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
	flightPrep.dossier.departureTime = '10:00';
	fake.windAt = () => [250, 20];
	fake.hold = null;
	fake.fail = false;
	fake.points = [];
	fake.variables = [];
});

afterEach(() => {
	pruneRouteWind([]);
	display.liveWeather = true;
	windAloft.useForecastForLegs = true;
	i18n.locale = 'en';
	flightPrep.dossier.flightDate = null;
	flightPrep.dossier.departureTime = null;
});

describe('routeWindMean', () => {
	it('prints the mean of a steady forecast, in both languages', async () => {
		const r = route(47, 47.5, 48);
		await ensureRouteWindFor(r);
		expect(routeWindMean(r)).toBe('Mean forecast wind 250°/20 kt');
		i18n.locale = 'fr';
		expect(routeWindMean(r)).toBe('Vent moyen prévu 250°/20 kt');
	});

	it('says the wind varies when the forecast turns along the route', async () => {
		const r = route(47, 48, 49);
		const leg = legOf(r);
		fake.windAt = (i) => (leg(i) === 0 ? [270, 20] : [360, 20]);
		await ensureRouteWindFor(r);
		expect(routeWindMean(r)).toBe('Forecast wind varies along the route');
		i18n.locale = 'fr';
		expect(routeWindMean(r)).toBe('Vent prévu variable le long de la route');
	});

	it('calls a light, unsteady forecast light and variable', async () => {
		const r = route(47, 48, 49);
		const leg = legOf(r);
		fake.windAt = (i) => (leg(i) === 0 ? [90, 3] : [270, 4]);
		await ensureRouteWindFor(r);
		expect(routeWindMean(r)).toBe('Forecast wind light and variable');
		i18n.locale = 'fr';
		expect(routeWindMean(r)).toBe('Vent prévu faible et variable');
	});

	it('reads each leg off its own midpoint, its middle segment’s center, and weighs it by its length', async () => {
		// 60 NM then 10 NM: the long leg spans three cloud segments, and its
		// winds are fetched at the middle one's center alone, with no cloud.
		const r = route(47, 48, 48 + 10 / 60);
		fake.windAt = (i) => (i === 0 ? [270, 20] : [270, 40]);
		await ensureRouteWindFor(r);
		expect(fake.points).toHaveLength(1);
		const segs = legSegments(r.waypoints);
		expect(segs.filter((s) => s.legIndex === 0)).toHaveLength(3);
		expect(fake.points[0]).toEqual(legMidpoints(r.waypoints));
		expect(fake.points[0][0].lat).toBe(segs[1].lat);
		expect(fake.points[0][0].lon).toBe(segs[1].lon);
		expect(fake.variables[0].some((v) => v.startsWith('cloud_cover'))).toBe(false);
		// (60 x 20 + 10 x 40) / 70 = 22.9 kt.
		expect(routeWindMean(r)).toBe('Mean forecast wind 270°/23 kt');
	});

	it('keeps the forecast mean when the pilot overrides a leg', async () => {
		const r = route(47, 47.5, 48);
		r.waypoints[0].windDirDeg = 90;
		r.waypoints[0].windSpeedKt = 40;
		await ensureRouteWindFor(r);
		expect(routeWindMean(r)).toBe('Mean forecast wind 250°/20 kt');
	});

	it('prints nothing when every leg is overridden, the forecast flying none', async () => {
		// The provenance line then reads the manual winds alone: a forecast
		// figure beside it would be one the plan does not use, with no source.
		const r = route(47, 47.5, 48);
		for (const w of r.waypoints.slice(0, -1)) {
			w.windDirDeg = 90;
			w.windSpeedKt = 15;
		}
		await ensureRouteWindFor(r);
		expect(routeWindMean(r)).toBeNull();
		r.waypoints[1].windDirDeg = undefined;
		r.waypoints[1].windSpeedKt = undefined;
		expect(routeWindMean(r)).toBe('Mean forecast wind 250°/20 kt');
	});

	it('prints nothing while a leg has no forecast', async () => {
		const r = route(47, 48, 49);
		const leg = legOf(r);
		fake.windAt = (i) => (leg(i) === 1 ? null : [250, 20]);
		await ensureRouteWindFor(r);
		expect(routeWindMean(r)).toBeNull();
	});

	it('prints nothing once the forecast is switched off, even from an entry that outlived it', async () => {
		const r = route(47, 48);
		await ensureRouteWindFor(r);
		expect(routeWindMean(r)).not.toBeNull();
		display.liveWeather = false;
		expect(routeWindMean(r)).toBeNull();
		display.liveWeather = true;
		windAloft.useForecastForLegs = false;
		expect(routeWindMean(r)).toBeNull();
	});

	it('prints nothing while the fetch is in flight, then the mean', async () => {
		let release!: () => void;
		fake.hold = new Promise<void>((resolve) => (release = resolve));
		const r = route(47, 48);
		const pending = ensureRouteWindFor(r);
		expect(routeWindMean(r)).toBeNull();
		release();
		await pending;
		expect(routeWindMean(r)).toBe('Mean forecast wind 250°/20 kt');
	});

	it('prints nothing when the fetch failed', async () => {
		fake.fail = true;
		const r = route(47, 48);
		await ensureRouteWindFor(r);
		expect(routeWindMean(r)).toBeNull();
	});

	it('prints nothing for a route with fewer than two waypoints', async () => {
		const r = route(47);
		await ensureRouteWindFor(r);
		expect(routeWindMean(r)).toBeNull();
	});
});
