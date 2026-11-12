/* When the per-route forecast is asked again, and what it says meanwhile
 * (state/routeWind.svelte.ts, docs/wind-aloft.md "Offline"): a request the
 * rate-limit backoff holds back says so rather than reading the held hours
 * against a plan they were not fetched for, a burst of rate limits arms ONE
 * backoff, a print asks a failed refresh again at once and waits for the
 * request that superseded its own, the network coming back asks again, and
 * the provenance names a run only when it is the one the figures came from.
 * Date and the timers are faked: the backoff is a timer, and a case runs it
 * out before the next. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/weather/openMeteo', async (orig) =>
	(await import('./helpers/fakeOpenMeteo')).withFakeColumns(await orig()),
);

import { fake } from './helpers/fakeOpenMeteo';
import { flightPrep } from '$lib/state/flightPrep.svelte';
import { i18n } from '$lib/state/i18n.svelte';
import { routeSettings, type Route, type Waypoint } from '$lib/state/route.svelte';
import {
	ensureRouteWindFor,
	globalWindIsFallback,
	pruneRouteWind,
	retryFailedRouteWinds,
	routeForecastMissing,
	routeForecastModel,
	routeLegWindTips,
	routeWind,
	routeWindMean,
	routeWindSummary,
	routeWindWarning,
} from '$lib/state/routeWind.svelte';
import { display } from '$lib/state/display.svelte';
import { ensureModelRun, modelRunMs, resetWindAloftForTest, windAloft, windRuns } from '$lib/state/windAloft.svelte';

const MIN = 60_000;
/** 09:40Z on the morning of the flight. */
const T0 = Date.UTC(2026, 8, 27, 9, 40);
const RUN06 = Date.UTC(2026, 8, 27, 6);
const RUN09 = Date.UTC(2026, 8, 27, 9);
const MEAN = 'Mean forecast wind 250°/20 kt';

let seq = 0;
function route(...lats: number[]): Route {
	const id = `retry-${seq++}`;
	return {
		id,
		name: null,
		selectedWaypointId: null,
		waypoints: lats.map(
			(lat, i): Waypoint => ({ id: `${id}-${i}`, lat, lon: 2, kind: 'free', alt: 3000, altAuto: true }),
		),
	};
}

function statedEtd(time = '10:00'): void {
	flightPrep.dossier.flightDate = '2026-09-27';
	flightPrep.dossier.departureTime = time;
}

/** Let the promise callbacks queued so far run (setImmediate is not faked). */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
	vi.setSystemTime(T0);
	fake.reset();
	resetWindAloftForTest();
});

afterEach(() => {
	// Run any backoff out, so the next case starts with no timer pending.
	vi.runOnlyPendingTimers();
	pruneRouteWind([]);
	vi.useRealTimers();
	flightPrep.dossier.flightDate = null;
	flightPrep.dossier.departureTime = null;
	display.liveWeather = true;
	windAloft.model = 'auto';
	windAloft.useForecastForLegs = true;
	routeSettings.windDirDeg = null;
	routeSettings.windSpeedKt = null;
	i18n.locale = 'en';
});

describe('the rate-limit backoff', () => {
	it('says a request it holds back waits on the rate limit, never that the model stops short', async () => {
		statedEtd();
		routeSettings.windDirDeg = 270;
		routeSettings.windSpeedKt = 10;
		const y = route(47, 47.5, 48);
		// Fetched at 09:40 for a 10:00 departure: the hours 09:00 to 09:00
		// the next day.
		await ensureRouteWindFor(y);
		// Another route's refresh is rate-limited: the backoff arms.
		fake.rateLimited = true;
		await ensureRouteWindFor(route(46, 46.5));
		fake.rateLimited = false;
		// Re-timed inside the backoff to 08:45 the next day: no fetch, and the
		// held hours no longer reach the second leg, which says nothing of
		// the model's reach.
		flightPrep.dossier.flightDate = '2026-09-28';
		flightPrep.dossier.departureTime = '08:45';
		const calls = fake.calls;
		await ensureRouteWindFor(y);
		expect(fake.calls).toBe(calls);
		expect(routeWindWarning(y)).toBe('Rate limit reached, retrying');
		expect(routeLegWindTips(y)[1]).not.toContain('horizon');
		// The backoff runs out: the request goes, and covers the plan.
		vi.runOnlyPendingTimers();
		await ensureRouteWindFor(y);
		expect(fake.calls).toBe(calls + 1);
		expect(routeWindWarning(y)).toBeNull();
		expect(routeWindMean(y)).toBe(MEAN);
	});

	it('arms one timer for a burst of rate limits, at the first delay', async () => {
		statedEtd();
		// A success first, so the delay starts from its first step.
		await ensureRouteWindFor(route(45, 45.5));
		fake.rateLimited = true;
		await Promise.all([
			ensureRouteWindFor(route(46, 46.5)),
			ensureRouteWindFor(route(47, 47.5)),
			ensureRouteWindFor(route(48, 48.5)),
		]);
		const before = routeWind.retrySeq;
		// Three routes limited in the same minute used to re-arm it three
		// times, doubling the delay each time: 264 s for a 66 s backoff.
		vi.advanceTimersByTime(66_000);
		expect(routeWind.retrySeq).toBe(before + 1);
	});
});

describe('a gesture and the network asking again', () => {
	/** A route whose forecast is held, made stale by its model's next run, and
	 *  whose refresh failed at 10:15. */
	async function failedRefresh(): Promise<Route> {
		statedEtd();
		const r = route(47, 47.5, 48);
		const model = routeForecastModel(r);
		fake.runMs = RUN06;
		ensureModelRun(model);
		await flush();
		await ensureRouteWindFor(r);
		vi.setSystemTime(T0 + 35 * MIN);
		fake.runMs = RUN09;
		ensureModelRun(model);
		await flush();
		fake.fail = true;
		await ensureRouteWindFor(r);
		expect(routeWindWarning(r)).toBe('Forecast not refreshed since 09:40Z 27 Sep');
		fake.fail = false;
		vi.setSystemTime(T0 + 40 * MIN);
		return r;
	}

	it('a print asks a refresh that failed again at once, where the tick waits its pace', async () => {
		const r = await failedRefresh();
		const calls = fake.calls;
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(calls);
		await ensureRouteWindFor(r, { retry: true });
		expect(fake.calls).toBe(calls + 1);
		expect(routeWindWarning(r)).toBeNull();
	});

	it('the network coming back asks it again through the warm effect', async () => {
		const r = await failedRefresh();
		const calls = fake.calls;
		const nudge = routeWind.retrySeq;
		retryFailedRouteWinds();
		expect(routeWind.retrySeq).toBe(nudge + 1);
		await ensureRouteWindFor(r);
		expect(fake.calls).toBe(calls + 1);
		expect(routeWindWarning(r)).toBeNull();
	});

	it('a print waits for the request that superseded its own', async () => {
		statedEtd();
		const r = route(47, 47.5, 48);
		let releaseFirst!: () => void;
		let releaseSecond!: () => void;
		fake.holds = [
			new Promise<void>((resolve) => (releaseFirst = resolve)),
			new Promise<void>((resolve) => (releaseSecond = resolve)),
		];
		let printed = false;
		const print = ensureRouteWindFor(r, { retry: true }).then(() => {
			printed = true;
		});
		// A pin moved while the request is out: another place, a new request.
		r.waypoints[2].lat = 48.1;
		void ensureRouteWindFor(r);
		expect(fake.calls).toBe(2);
		releaseFirst();
		await flush();
		// The first answer is thrown away: the print must not read yet.
		expect(printed).toBe(false);
		releaseSecond();
		await print;
		expect(routeForecastMissing(r)).toBeNull();
		expect(routeWindMean(r)).toBe(MEAN);
	});
});

describe('the run a provenance names', () => {
	it('names no newer run for figures asked for under the older one, and refetches the new cycle', async () => {
		statedEtd();
		windAloft.model = 'icon_seamless';
		const r = route(47, 47.5, 48);
		fake.runMs = RUN06;
		ensureModelRun('icon_seamless');
		await flush();
		expect(modelRunMs('icon_seamless')).toBe(RUN06);
		let release!: () => void;
		fake.hold = new Promise<void>((resolve) => (release = resolve));
		const first = ensureRouteWindFor(r);
		// The 09Z run is detected while the fetch is out.
		vi.setSystemTime(T0 + 31 * MIN);
		fake.runMs = RUN09;
		const seqBefore = windRuns.newRunSeq;
		ensureModelRun('icon_seamless');
		await flush();
		expect(windRuns.newRunSeq).toBe(seqBefore + 1);
		// Asked again, the request is not joined but refetched.
		const calls = fake.calls;
		const second = ensureRouteWindFor(r);
		expect(fake.calls).toBe(calls + 1);
		fake.hold = null;
		release();
		await Promise.all([first, second]);
		expect(routeWindSummary(r)).toContain('run 09:00Z 27 Sep');
	});

	it('names no run for held figures when a new cycle was detected since they were asked for', async () => {
		statedEtd();
		windAloft.model = 'gfs_seamless';
		const r = route(47, 47.5, 48);
		let release!: () => void;
		fake.hold = new Promise<void>((resolve) => (release = resolve));
		fake.runMs = RUN06;
		const pending = ensureRouteWindFor(r);
		await flush();
		// 06Z became known while the fetch was out (a first arrival, the
		// ensure's own poll), then 09Z is detected at the next poll, before
		// anything asks for the route again.
		expect(modelRunMs('gfs_seamless')).toBe(RUN06);
		fake.runMs = RUN09;
		vi.setSystemTime(T0 + 31 * MIN);
		ensureModelRun('gfs_seamless');
		await flush();
		expect(modelRunMs('gfs_seamless')).toBe(RUN09);
		fake.hold = null;
		release();
		await pending;
		expect(routeWindSummary(r)).not.toContain('run ');
	});

	it('polls the run of the route’s own model, whatever the map shows', async () => {
		statedEtd();
		windAloft.model = 'ukmo_seamless';
		fake.runMs = RUN06;
		await ensureRouteWindFor(route(47, 47.5, 48));
		await flush();
		expect(modelRunMs('ukmo_seamless')).toBe(RUN06);
	});

	it('asks a poll that answered nothing again within minutes', async () => {
		const model = 'ecmwf_ifs025';
		ensureModelRun(model, T0);
		await flush();
		expect(modelRunMs(model)).toBeNull();
		fake.runMs = RUN06;
		ensureModelRun(model, T0 + 6 * MIN);
		await flush();
		expect(modelRunMs(model)).toBe(RUN06);
	});
});

describe('the legs a held forecast does not cover', () => {
	it('are the ones before its hours too, never "beyond" them', async () => {
		statedEtd();
		const r = route(47, 47.5, 48);
		await ensureRouteWindFor(r);
		vi.setSystemTime(T0 + 35 * MIN);
		// Re-timed offline to 06:00, before the held 09:00 to 14:00.
		statedEtd('06:00');
		fake.fail = true;
		await ensureRouteWindFor(r);
		expect(routeWindWarning(r)).toBe('Forecast not refreshed since 09:40Z 27 Sep, 2 legs not covered');
	});

	it('keep a typed wind the fallback while the refresh that serves them is in flight', async () => {
		statedEtd();
		routeSettings.windDirDeg = 270;
		routeSettings.windSpeedKt = 10;
		const r = route(47, 47.5, 48);
		await ensureRouteWindFor(r);
		expect(globalWindIsFallback(r)).toBe(true);
		let release!: () => void;
		fake.hold = new Promise<void>((resolve) => (release = resolve));
		// Re-timed to the next evening, past the held day of hours.
		flightPrep.dossier.flightDate = '2026-09-28';
		flightPrep.dossier.departureTime = '20:00';
		// Not covered by the held hours, about to be refetched: no flicker.
		expect(globalWindIsFallback(r)).toBe(true);
		const pending = ensureRouteWindFor(r);
		expect(globalWindIsFallback(r)).toBe(true);
		fake.hold = null;
		release();
		await pending;
		expect(globalWindIsFallback(r)).toBe(true);
	});
});
