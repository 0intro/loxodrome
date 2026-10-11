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
import { cloudReadingAt } from '$lib/route/routeProfile';
import { display } from '$lib/state/display.svelte';
import { flightPrep } from '$lib/state/flightPrep.svelte';
import { i18n, t } from '$lib/state/i18n.svelte';
import { routeSettings, type Route, type Waypoint } from '$lib/state/route.svelte';
import {
	ensureRouteCloudsFor,
	ensureRouteWindFor,
	pruneRouteWind,
	routeCloudCover,
	routeCloudProvenance,
	routeForecastModel,
	routeLegForecasts,
	routeWindMean,
} from '$lib/state/routeWind.svelte';
import { ensureModelRun, modelRunMs, resetWindAloftForTest, windAloft } from '$lib/state/windAloft.svelte';
import { hourlyVariables, windModel } from '$lib/weather/openMeteo';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 9, 40);
const RUN_A = Date.UTC(2026, 9, 2, 6);
const RUN_B = Date.UTC(2026, 9, 2, 9);
const CRUISE_KT = routeSettings.cruiseSpeedKt;

/** "10:05Z 2 Oct": the provenance's time, spelt out independently. */
function zulu(ms: number): string {
	const d = new Date(ms);
	const p = (n: number): string => String(n).padStart(2, '0');
	return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z ${d.getUTCDate()} Oct`;
}

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
	routeSettings.cruiseSpeedKt = CRUISE_KT;
	i18n.locale = 'en';
});

describe('the winds', () => {
	it('are asked at each leg’s midpoint, with temperatures and no cloud, one call per ten variables', async () => {
		// Two legs of 60 NM: six cloud segments, two wind points.
		const r = route(47, 48, 49);
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(1);
		expect(fake.requests[0].points).toEqual(legMidpoints(r.waypoints));
		const vars = asked(0);
		// Our Météo-France ladder: 16 levels' winds, heights and
		// temperatures, and the 10 m wind.
		expect(vars).toHaveLength(66);
		expect(vars).toContain('temperature_850hPa');
		expect(vars).toContain('wind_speed_300hPa');
		expect(vars.some((v) => v.startsWith('cloud_cover'))).toBe(false);
		// What it would cost Open-Meteo answering it (a failover): 2
		// locations x 6.6, where every segment with clouds cost 50.
		expect(fake.weight).toBeCloseTo(13.2, 9);
		expect(routeWindMean(r)).toBe('Mean forecast wind 250°/20 kt');
		// The curtain was never asked for.
		expect(routeCloudCover(r)).toBeNull();
	});

	it('follow the model’s own ladder (ECMWF’s reduced one)', async () => {
		windAloft.model = 'ecmwf_ifs025';
		const r = route(47, 48);
		await ensureRouteWindFor(r);
		expect(asked(0)).toHaveLength(34);
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
		expect(vars).toHaveLength(32);
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

	it('are never asked while live weather is off, and are under a manual wind', async () => {
		const r = route(47, 48);
		display.liveWeather = false;
		await ensureRouteCloudsFor(r);
		expect(fake.calls).toBe(0);
		// A manual wind source replaces the forecast's wind, never its clouds.
		display.liveWeather = true;
		windAloft.useForecastForLegs = false;
		await ensureRouteCloudsFor(r);
		expect(fake.calls).toBe(1);
		windAloft.useForecastForLegs = true;
	});

	/** The instant the forecast reads leg `i` at. */
	function legInstant(r: Route, i: number): number {
		const f = routeLegForecasts(r)?.[i];
		if (!f) {
			throw new Error(`no forecast for leg ${i}`);
		}
		return f.ok ? f.wind.validTimeMs : f.validTimeMs;
	}

	it('say the instant each segment was read at, shifted along its leg at the cruise speed', async () => {
		const r = route(47, 48, 49);
		await ensureRouteWindFor(r);
		await ensureRouteCloudsFor(r);
		// Two 60 NM legs in three 20 NM segments each, at the route's 100 kt:
		// the middle one read at its leg's instant, the others 12 min apart.
		const offsets = (routeCloudCover(r) ?? []).map(
			(s, si) => ((s.validMs ?? NaN) - legInstant(r, Math.floor(si / 3))) / MIN,
		);
		expect(offsets).toHaveLength(6);
		for (const [si, want] of [-12, 0, 12, -12, 0, 12].entries()) {
			expect(offsets[si]).toBeCloseTo(want, 1);
		}
	});

	it('read at the cursor in amount steps', async () => {
		const r = route(47, 48, 49);
		await ensureRouteWindFor(r);
		await ensureRouteCloudsFor(r);
		// The fake's broken layer at 850 hPa (1500 m), clear at 925 hPa
		// (800 m): one BKN layer, its edges graded through FEW and SCT.
		expect(cloudReadingAt(routeCloudCover(r) ?? [], 10, 5000, 0)).toEqual({
			segIndex: 0,
			lines: [{ text: 'BKN 2800–6100 ft', here: true }],
		});
	});

	it('name the runs of the one column a segment was read from, in the language shown', async () => {
		fake.runMs = RUN_A;
		fake.bboxes.arome0025 = [46.9, -5, 47.6, 10];
		const r = route(47, 48, 49);
		const model = routeForecastModel(r);
		ensureModelRun(model);
		await vi.waitFor(() => expect(modelRunMs(model)).toBe(RUN_A));
		await ensureRouteWindFor(r);
		await ensureRouteCloudsFor(r);
		const curtain = routeCloudCover(r) ?? [];
		const at = (si: number) => routeCloudProvenance(r, si, curtain[si]?.validMs ?? NaN);
		expect(at(0)).toEqual({
			forecast: 'Forecast AROME 06:00Z 2 Oct, ARPEGE 06:00Z 2 Oct, IFS 06:00Z 2 Oct',
			valid: `Valid ${zulu(curtain[0]?.validMs ?? NaN)}`,
		});
		// North of AROME's grid the column came from the members beyond it,
		// whatever the rest of the route used.
		expect(at(5)?.forecast).toBe('Forecast ARPEGE 06:00Z 2 Oct, IFS 06:00Z 2 Oct');
		// Worded when asked, never held as text.
		i18n.locale = 'fr';
		expect(at(0)?.forecast).toBe('Prévision AROME 06:00Z 2 oct., ARPEGE 06:00Z 2 oct., IFS 06:00Z 2 oct.');
		display.liveWeather = false;
		expect(at(0)).toBeNull();
	});

	it('name an Open-Meteo model with the run it answered from', async () => {
		windAloft.model = 'icon_seamless';
		fake.runMs = RUN_A;
		const r = route(47, 48);
		const model = routeForecastModel(r);
		ensureModelRun(model);
		await vi.waitFor(() => expect(modelRunMs(model)).toBe(RUN_A));
		await ensureRouteWindFor(r);
		await ensureRouteCloudsFor(r);
		const validMs = routeCloudCover(r)?.[0]?.validMs ?? NaN;
		expect(routeCloudProvenance(r, 0, validMs)).toEqual({
			forecast: `Forecast ${t.weather.windModels.icon_seamless}`,
			valid: `Run 06:00Z 2 Oct, valid ${zulu(validMs)}`,
		});
	});
});
