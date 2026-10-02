/* The per-route forecast offline, the phone in flight without mobile data
 * (state/routeWind.svelte.ts, docs/wind-aloft.md "Offline"). A forecast the
 * app holds is not thrown away because the network is: a failed refresh keeps
 * it and says since when, a refresh in flight reads it, and a plan re-timed to
 * the next hour still reads the hours it holds (a flight in progress with no
 * ETD is timed to itself: tests/flightInProgress.spec.ts); the provenance
 * names only the run the held figures came from, and a poll that answers
 * nothing forgets no run. What a held forecast must never do is serve
 * another place, another model, or a date the endpoint refused. A held
 * forecast is refreshed when a run of its model lands, or when the plan
 * leaves the day of hours it holds, never on a clock. Only Date is faked: the
 * one-hour age of a forecast no run anchors, the failure pacing and the
 * next-hour fallback read it. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/weather/openMeteo', async (orig) =>
	(await import('./helpers/fakeOpenMeteo')).withFakeColumns(await orig()),
);

import { fake } from './helpers/fakeOpenMeteo';
import { flightPrep } from '$lib/state/flightPrep.svelte';
import { i18n } from '$lib/state/i18n.svelte';
import { nav } from '$lib/state/navRecording.svelte';
import { routeSettings, type Route, type Waypoint } from '$lib/state/route.svelte';
import {
	ensureRouteCloudsFor,
	ensureRouteWindFor,
	globalWindIsFallback,
	pruneRouteWind,
	routeCloudCover,
	routeFetchSpan,
	routeFetchWindow,
	routeForecastModel,
	routeForecastMissing,
	routeFreezingLevelsFt,
	routeLegWindTips,
	routeWind,
	routeWindMean,
	routeWindSummary,
	routeWindWarning,
} from '$lib/state/routeWind.svelte';
import { display } from '$lib/state/display.svelte';
import {
	ensureModelRun,
	modelRunMs,
	nextHourMs,
	resetWindAloftForTest,
	windAloft,
	windRuns,
} from '$lib/state/windAloft.svelte';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 09:40Z on the morning of the flight. */
const T0 = Date.UTC(2026, 8, 27, 9, 40);
const MEAN = 'Mean forecast wind 250°/20 kt';

let seq = 0;
/** A route due north along 2°E through the given latitudes (60 NM a degree),
 *  at 3000 ft; a fresh id per route, the cache's bookkeeping being
 *  module-level. */
function route(...lats: number[]): Route {
	const id = `offline-${seq++}`;
	return {
		id,
		name: null,
		selectedWaypointId: null,
		waypoints: lats.map(
			(lat, i): Waypoint => ({ id: `${id}-${i}`, lat, lon: 2, kind: 'free', alt: 3000, altAuto: true }),
		),
	};
}

/** The morning's plan, departing 10:00Z as stated. */
function statedEtd(): void {
	flightPrep.dossier.flightDate = '2026-09-27';
	flightPrep.dossier.departureTime = '10:00';
}

/** The runs a held forecast is fetched under, then made stale by. */
const RUN_A = Date.UTC(2026, 8, 27, 6);
const RUN_B = Date.UTC(2026, 8, 27, 9);

/** A route fetched once at T0 under a known run, then made stale by its
 *  model's next run landing (a poll a quarter of an hour later). */
async function heldAndStale(r: Route): Promise<void> {
	const model = routeForecastModel(r);
	fake.runMs = RUN_A;
	ensureModelRun(model);
	await vi.waitFor(() => expect(modelRunMs(model)).toBe(RUN_A));
	await ensureRouteWindFor(r);
	expect(routeWindMean(r)).toBe(MEAN);
	vi.setSystemTime(Date.now() + 16 * MIN);
	fake.runMs = RUN_B;
	ensureModelRun(model);
	await vi.waitFor(() => expect(modelRunMs(model)).toBe(RUN_B));
}

/** A route fetched once at T0 with no run ever known, then taken past the
 *  hour such a forecast is held before it is asked again. */
async function heldAndAged(r: Route): Promise<void> {
	await ensureRouteWindFor(r);
	expect(routeWindMean(r)).toBe(MEAN);
	vi.setSystemTime(Date.now() + 61 * MIN);
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T0);
	fake.reset();
	resetWindAloftForTest();
});

afterEach(() => {
	pruneRouteWind([]);
	vi.useRealTimers();
	flightPrep.dossier.flightDate = null;
	flightPrep.dossier.departureTime = null;
	nav.points = [];
	nav.recording = false;
	nav.interrupted = false;
	display.liveWeather = true;
	windAloft.animAnchorMs = null;
	windAloft.model = 'auto';
	windAloft.useForecastForLegs = true;
	routeSettings.windDirDeg = null;
	routeSettings.windSpeedKt = null;
	routeSettings.cruiseSpeedKt = 100;
	i18n.locale = 'en';
});

describe('a held forecast through the network failing', () => {
	it('keeps the forecast through a failed refresh', async () => {
		statedEtd();
		const r = route(47, 47.5, 48);
		await heldAndStale(r);
		fake.fail = true;
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(2);
		expect(routeWindMean(r)).toBe(MEAN);
	});

	it('reads the forecast while it refreshes', async () => {
		statedEtd();
		const r = route(47, 47.5, 48);
		await heldAndStale(r);
		let release!: () => void;
		fake.hold = new Promise<void>((resolve) => (release = resolve));
		const pending = ensureRouteWindFor(r);
		expect(fake.calls).toBe(2);
		expect(routeWindMean(r)).toBe(MEAN);
		release();
		await pending;
		expect(routeWindMean(r)).toBe(MEAN);
	});

	it('keeps reading it, with no request, when the plan departing at the next hour re-times within its day', async () => {
		// No ETD: the plan departs at the next whole hour, 10:00, and at 10:05
		// at 11:00, inside the day of hours the forecast holds.
		const r = route(47, 47.5, 48);
		await ensureRouteWindFor(r);
		expect(routeWindMean(r)).toBe(MEAN);
		vi.setSystemTime(T0 + 25 * MIN);
		fake.fail = true;
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(1);
		expect(routeWindMean(r)).toBe(MEAN);
		expect(routeWindWarning(r)).toBeNull();
	});

	it('says since when it holds the forecast, in both languages, through the retries', async () => {
		statedEtd();
		const r = route(47, 47.5, 48);
		await heldAndStale(r);
		fake.fail = true;
		await ensureRouteWindFor(r);
		expect(routeWindWarning(r)).toBe('Forecast not refreshed since 09:40Z 27 Sep');
		i18n.locale = 'fr';
		expect(routeWindWarning(r)).toBe('Prévision non actualisée depuis 09:40Z 27 sept.');
		i18n.locale = 'en';
		// The next retry, still offline and still in flight, keeps saying it.
		vi.setSystemTime(Date.now() + 31 * MIN);
		fake.hold = new Promise<void>(() => {});
		void ensureRouteWindFor(r);
		expect(routeWindWarning(r)).toBe('Forecast not refreshed since 09:40Z 27 Sep');
	});

	it('flashes no warning while a refresh is in flight, even over hours it does not hold', async () => {
		// No ETD, fetched at 09:40 for a 10:00 departure (hours 09:00 to
		// 09:00 the next day). The next day at 10:05 the plan departs at
		// 11:00, past the held hours, which would read as legs past the
		// forecast.
		const r = route(47, 47.5, 48);
		await ensureRouteWindFor(r);
		vi.setSystemTime(T0 + 24 * HOUR + 25 * MIN);
		let release!: () => void;
		fake.hold = new Promise<void>((resolve) => (release = resolve));
		const pending = ensureRouteWindFor(r);
		expect(fake.calls).toBe(2);
		expect(routeWindWarning(r)).toBeNull();
		release();
		await pending;
		expect(routeWindWarning(r)).toBeNull();
		expect(routeWindMean(r)).toBe(MEAN);
	});

	it('takes a 200 that carries no forecast for a failed refresh, never an answer', async () => {
		statedEtd();
		const r = route(47, 47.5, 48);
		await heldAndStale(r);
		fake.empty = true;
		await ensureRouteWindFor(r);
		expect(routeWindMean(r)).toBe(MEAN);
		expect(routeWindWarning(r)).toBe('Forecast not refreshed since 09:40Z 27 Sep');
	});

	it('joins a refresh in flight rather than restarting it', async () => {
		statedEtd();
		const r = route(47, 47.5, 48);
		await heldAndStale(r);
		let release!: () => void;
		fake.hold = new Promise<void>((resolve) => (release = resolve));
		const first = ensureRouteWindFor(r);
		const second = ensureRouteWindFor(r);
		expect(fake.calls).toBe(2);
		let settled = 0;
		void first.then(() => settled++);
		void second.then(() => settled++);
		await Promise.resolve();
		expect(settled).toBe(0);
		release();
		await Promise.all([first, second]);
		expect(settled).toBe(2);
		expect(fake.calls).toBe(2);
		expect(routeWind.byRoute[r.id]?.status).toBe('ready');
	});

	it('still serves the plan where the typed wind is only the fallback', async () => {
		statedEtd();
		routeSettings.windDirDeg = 270;
		routeSettings.windSpeedKt = 10;
		const r = route(47, 47.5, 48);
		await heldAndStale(r);
		fake.fail = true;
		await ensureRouteWindFor(r);
		expect(globalWindIsFallback(r)).toBe(true);
		expect(routeForecastMissing(r)).toBeNull();
		// A route the forecast never reached: the typed wind flies it.
		const other = route(46, 46.5);
		await ensureRouteWindFor(other);
		expect(globalWindIsFallback(other)).toBe(false);
		expect(routeForecastMissing(other)).toBe('manual');
	});
});

describe('what a held forecast never serves', () => {
	it('another place: a moved waypoint reads nothing held, before and after its fetch fails', async () => {
		statedEtd();
		const r = route(47, 47.5, 48);
		await ensureRouteWindFor(r);
		r.waypoints[1].lat = 47.6;
		expect(routeWindMean(r)).toBeNull();
		fake.fail = true;
		await ensureRouteWindFor(r);
		expect(routeWindMean(r)).toBeNull();
		expect(routeWindWarning(r)).toBe('Forecast unavailable');
	});

	it('another model', async () => {
		statedEtd();
		const r = route(47, 47.5, 48);
		await ensureRouteWindFor(r);
		const model = routeWind.byRoute[r.id]?.model;
		windAloft.model = model === 'icon_seamless' ? 'ecmwf_ifs025' : 'icon_seamless';
		expect(routeWindMean(r)).toBeNull();
	});

	it('a route pruned: an entry is dropped with its route, even once its key went with the toggles', async () => {
		statedEtd();
		const r = route(47, 47.5, 48);
		await ensureRouteWindFor(r);
		// Switching forecast winds off drops the request's key and keeps the
		// entry; the route then goes, and its entry with it.
		windAloft.useForecastForLegs = false;
		await ensureRouteWindFor(r);
		pruneRouteWind([]);
		windAloft.useForecastForLegs = true;
		expect(routeWindMean(r)).toBeNull();
	});

	it('a date the endpoint does not serve, whose forecast comes back with the date put back', async () => {
		statedEtd();
		const r = route(47, 47.5, 48);
		await ensureRouteWindFor(r);
		flightPrep.dossier.flightDate = '2026-10-27';
		await ensureRouteWindFor(r);
		expect(routeWindMean(r)).toBeNull();
		expect(routeWindWarning(r)).toBe('Departure beyond the 15-day forecast range');
		expect(routeForecastMissing(r)).toBe('blank');
		// Typed wrong offline and put back: the forecast held for the morning
		// serves again, with no network to refetch it.
		fake.fail = true;
		flightPrep.dossier.flightDate = '2026-09-27';
		await ensureRouteWindFor(r);
		expect(routeWindMean(r)).toBe(MEAN);
	});
});

describe('the run a held forecast names', () => {
	const RUN1 = Date.UTC(2026, 8, 27, 6);
	const RUN2 = Date.UTC(2026, 8, 27, 9);
	// The run poll's records are module-level and keyed by directory, which
	// models share: every case starts from none (resetWindAloftForTest).

	it('keeps the run known when a poll answers nothing, and counts the next run read as new', async () => {
		const model = 'arome_france';
		fake.runMs = RUN1;
		ensureModelRun(model);
		await vi.waitFor(() => expect(modelRunMs(model)).toBe(RUN1));
		vi.setSystemTime(Date.now() + 31 * MIN);
		fake.runMs = null;
		ensureModelRun(model);
		// A macrotask: every microtask of the poll has run by then.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(modelRunMs(model)).toBe(RUN1);
		const seqBefore = windRuns.newRunSeq;
		vi.setSystemTime(Date.now() + 31 * MIN);
		fake.runMs = RUN2;
		ensureModelRun(model);
		await vi.waitFor(() => expect(modelRunMs(model)).toBe(RUN2));
		expect(windRuns.newRunSeq).toBe(seqBefore + 1);
	});

	it('names the run the held figures came from, never a newer one it could not fetch', async () => {
		statedEtd();
		windAloft.model = 'arpege_europe';
		const r = route(47, 47.5, 48);
		fake.runMs = RUN1;
		await ensureRouteWindFor(r);
		const model = routeWind.byRoute[r.id].model;
		ensureModelRun(model);
		await vi.waitFor(() => expect(modelRunMs(model)).toBe(RUN1));
		// The run was learned after the fetch: the healthy entry reads it.
		expect(routeWindSummary(r)).toContain('run 06:00Z 27 Sep');
		// Refetched under that run (past the hour a forecast no run anchored
		// is held), then a newer run is published and the refresh it
		// triggers cannot reach the network.
		vi.setSystemTime(Date.now() + 61 * MIN);
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(2);
		vi.setSystemTime(Date.now() + 31 * MIN);
		fake.runMs = RUN2;
		ensureModelRun(model);
		await vi.waitFor(() => expect(modelRunMs(model)).toBe(RUN2));
		fake.fail = true;
		await ensureRouteWindFor(r);
		expect(routeWindMean(r)).toBe(MEAN);
		expect(routeWindSummary(r)).toContain('run 06:00Z 27 Sep');
	});

	it('names no run for held figures whose run was never known', async () => {
		statedEtd();
		windAloft.model = 'gfs_seamless';
		const r = route(47, 47.5, 48);
		await heldAndAged(r);
		fake.fail = true;
		await ensureRouteWindFor(r);
		const model = routeWind.byRoute[r.id].model;
		vi.setSystemTime(Date.now() + 31 * MIN);
		fake.runMs = RUN2;
		ensureModelRun(model);
		await vi.waitFor(() => expect(modelRunMs(model)).toBe(RUN2));
		expect(routeWindSummary(r)).not.toContain('run ');
	});
});

describe('what a held forecast says of the legs it does not reach', () => {
	it('names them beside its age, and their tooltips blame no model horizon', async () => {
		statedEtd();
		routeSettings.windDirDeg = 270;
		routeSettings.windSpeedKt = 10;
		const r = route(47, 47.5, 48);
		// Fetched at 09:40 for a 10:00 departure: hours 09:00 to 09:00 the
		// next day.
		await heldAndStale(r);
		// Re-timed offline to 08:45 the next day: the first leg flies inside
		// the held hours, the second past them.
		flightPrep.dossier.flightDate = '2026-09-28';
		flightPrep.dossier.departureTime = '08:45';
		fake.fail = true;
		await ensureRouteWindFor(r);
		expect(routeWindWarning(r)).toBe('Forecast not refreshed since 09:40Z 27 Sep, 1 leg not covered');
		i18n.locale = 'fr';
		expect(routeWindWarning(r)).toBe('Prévision non actualisée depuis 09:40Z 27 sept., 1 segment non couvert');
		i18n.locale = 'en';
		const tips = routeLegWindTips(r);
		expect(tips[1]).toContain('Global manual wind, forecast unavailable');
		expect(tips[1]).not.toContain('horizon');
	});
});

describe('the switches and the stamps', () => {
	it('keeps the profile’s cloud curtain and freezing line off once the forecast is switched off', async () => {
		statedEtd();
		const r = route(47, 47.5, 48);
		await ensureRouteWindFor(r);
		await ensureRouteCloudsFor(r);
		expect(routeCloudCover(r)).not.toBeNull();
		display.liveWeather = false;
		expect(routeCloudCover(r)).toBeNull();
		expect(routeFreezingLevelsFt(r).every((v) => v == null)).toBe(true);
	});

	it('stamps no run when a new one was detected while the fetch was out', async () => {
		statedEtd();
		windAloft.model = 'ukmo_seamless';
		const r = route(47, 47.5, 48);
		const model = 'ukmo_seamless';
		fake.runMs = Date.UTC(2026, 8, 27, 6);
		ensureModelRun(model);
		await vi.waitFor(() => expect(modelRunMs(model)).toBe(Date.UTC(2026, 8, 27, 6)));
		let release!: () => void;
		fake.hold = new Promise<void>((resolve) => (release = resolve));
		const pending = ensureRouteWindFor(r);
		vi.setSystemTime(Date.now() + 31 * MIN);
		fake.runMs = Date.UTC(2026, 8, 27, 9);
		ensureModelRun(model);
		await vi.waitFor(() => expect(modelRunMs(model)).toBe(Date.UTC(2026, 8, 27, 9)));
		release();
		await pending;
		expect(routeWind.byRoute[r.id]?.runMs).toBeNull();
	});
});

describe('an offline edit undone', () => {
	it('finds the forecast of the place it comes back to', async () => {
		statedEtd();
		const r = route(47, 47.5, 48);
		await ensureRouteWindFor(r);
		fake.fail = true;
		// A pin dragged by a bump, in flight without data: another place,
		// nothing held for it.
		r.waypoints[1].lat = 47.6;
		await ensureRouteWindFor(r);
		expect(routeWindMean(r)).toBeNull();
		// Put back: the forecast held for it serves again, with no request.
		r.waypoints[1].lat = 47.5;
		await ensureRouteWindFor(r);
		expect(routeWindMean(r)).toBe(MEAN);
		expect(fake.calls).toBe(2);
		expect(routeWindWarning(r)).toBeNull();
	});
});

describe('the day of hours it holds and the runs it was asked under', () => {
	it('asks for nothing as the hour rolls over, the ETD moves within the day or a cruise speed is typed', async () => {
		const r = route(47, 47.5, 48);
		await ensureRouteWindFor(r);
		// No ETD: 10:00, then 11:00 as the hour rolls over.
		vi.setSystemTime(T0 + 25 * MIN);
		await ensureRouteWindFor(r);
		// Stated, then moved within the day.
		statedEtd();
		await ensureRouteWindFor(r);
		flightPrep.dossier.departureTime = '15:00';
		await ensureRouteWindFor(r);
		// The cruise speed typed, its arrival moving with it.
		routeSettings.cruiseSpeedKt = 80;
		await ensureRouteWindFor(r);
		routeSettings.cruiseSpeedKt = 120;
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(1);
		expect(routeWindMean(r)).toBe(MEAN);
	});

	it('refetches once when a run of its model lands, and not before', async () => {
		statedEtd();
		const r = route(47, 47.5, 48);
		const model = routeForecastModel(r);
		fake.runMs = RUN_A;
		ensureModelRun(model);
		await vi.waitFor(() => expect(modelRunMs(model)).toBe(RUN_A));
		await ensureRouteWindFor(r);
		// Hours later, the same run: nothing to ask.
		vi.setSystemTime(T0 + 3 * HOUR);
		ensureModelRun(model);
		// A macrotask: every microtask of the poll has run by then.
		await new Promise((resolve) => setTimeout(resolve, 0));
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(1);
		fake.runMs = RUN_B;
		vi.setSystemTime(T0 + 4 * HOUR);
		ensureModelRun(model);
		await vi.waitFor(() => expect(modelRunMs(model)).toBe(RUN_B));
		await ensureRouteWindFor(r);
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(2);
		expect(routeWindSummary(r)).toContain('run 09:00Z 27 Sep');
	});

	it('asks a forecast no run anchors again after an hour, not before', async () => {
		statedEtd();
		const r = route(47, 47.5, 48);
		await ensureRouteWindFor(r);
		vi.setSystemTime(T0 + 59 * MIN);
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(1);
		vi.setSystemTime(T0 + 61 * MIN);
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(2);
	});
});

describe('the endpoint’s range and the print notice', () => {
	it('refuses a departure in the first hour past the range without a request', async () => {
		flightPrep.dossier.flightDate = '2026-10-13';
		flightPrep.dossier.departureTime = '00:30';
		const r = route(47, 47.5, 48);
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(0);
		expect(routeWindWarning(r)).toBe('Departure beyond the 15-day forecast range');
	});

	it('says the manual wind applies only where no leg the forecast should serve has one', async () => {
		statedEtd();
		fake.fail = true;
		const r = route(47, 47.5, 48);
		await ensureRouteWindFor(r);
		// No wind typed: the notice may not promise one, the cells stay blank.
		expect(routeForecastMissing(r)).toBe('blank');
		routeSettings.windDirDeg = 270;
		routeSettings.windSpeedKt = 10;
		expect(routeForecastMissing(r)).toBe('manual');
		for (const w of r.waypoints.slice(0, -1)) {
			w.windDirDeg = 90;
			w.windSpeedKt = 30;
		}
		expect(routeForecastMissing(r)).toBeNull();
	});
});

describe('the fetch window', () => {
	it('asks for a day from the plan’s own first hour, cut at the endpoint’s range', () => {
		const need = { startMs: Date.UTC(2026, 8, 27, 9), endMs: Date.UTC(2026, 8, 27, 14) };
		expect(routeFetchSpan(need, T0)).toEqual({ startMs: need.startMs, endMs: Date.UTC(2026, 8, 28, 9) });
		// A plan longer than a day keeps its own end.
		const long = { startMs: need.startMs, endMs: Date.UTC(2026, 8, 29, 9) };
		expect(routeFetchSpan(long, T0)).toEqual(long);
		// Near the range's last hour (23:00 on the 12th of October), cut there.
		const late = { startMs: Date.UTC(2026, 9, 12, 20), endMs: Date.UTC(2026, 9, 12, 22) };
		expect(routeFetchSpan(late, T0)).toEqual({ startMs: late.startMs, endMs: Date.UTC(2026, 9, 12, 23) });
	});

	it('keeps an hour before the departure hour and three after the arrival hour', () => {
		const r = route(47, 47.5, 48);
		// 60 NM at the default 100 kt: 36 min, arriving 10:36.
		const w = routeFetchWindow(r.waypoints, Date.UTC(2026, 8, 27, 10), 100, 'arome_france');
		expect(w).toEqual({ startMs: Date.UTC(2026, 8, 27, 9), endMs: Date.UTC(2026, 8, 27, 14) });
	});

	it('still holds the flight’s own hours while the animation slider is engaged far from them', () => {
		const r = route(47, 47.5, 48);
		windAloft.animAnchorMs = T0;
		const departure = T0 + 3 * 24 * HOUR;
		const w = routeFetchWindow(r.waypoints, departure, 100, 'arome_france');
		expect(w.startMs).toBeLessThanOrEqual(T0);
		expect(w.endMs).toBeGreaterThanOrEqual(nextHourMs(departure + 36 * MIN) + 3 * HOUR);
	});
});
