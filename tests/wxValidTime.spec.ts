/* WHICH hour the weather map is read at (state/wxTime.svelte). The winds-aloft
 * overlay is a dated map surface like the others, so its valid time follows the
 * toolbar's viewing period: the current hour under 'now', the flight's own
 * departure under 'flight' (the instant the nav log's first leg flies, so map
 * and plan cannot brief different hours), the typed range's start under
 * 'custom', and every fall-through back on the current hour rather than on one
 * nobody asked for. Then the two rules that keep it honest: a default is
 * clamped to what the model can answer and says so, and a hand-set hour pins
 * only until the period says something else. */

import { describe, it, expect, afterEach } from 'vitest';
import {
	clampToReach,
	forecastReachEndMs,
	releaseWxValidTime,
	setWxValidTime,
	wxValidTime,
} from '$lib/state/wxTime.svelte';
import { animationWindow, floorHourMs, gridWindow, windAloft } from '$lib/state/windAloft.svelte';
import { periodAnchor } from '$lib/state/timeWindow.svelte';
import { filter, setWindowMode, DEFAULT_HORIZON_H } from '$lib/state/filter.svelte';
import { flightPrep } from '$lib/state/flightPrep.svelte';
import { routeFetchWindow } from '$lib/state/routeWind.svelte';
import { forecastRangeEndMs } from '$lib/weather/openMeteo';
import { routes, type Route, type Waypoint } from '$lib/state/route.svelte';

const HOUR_MS = 3600_000;

function reset(): void {
	filter.window.mode = 'now';
	filter.window.horizonH = DEFAULT_HORIZON_H;
	filter.window.fromDate = '';
	filter.window.fromTime = '';
	filter.window.toDate = '';
	filter.window.toTime = '';
	routes.list = [];
	flightPrep.dossier.flightDate = null;
	flightPrep.dossier.departureTime = null;
	windAloft.animAnchorMs = null;
	releaseWxValidTime();
}

/** The least a route needs to be a trip the flight period can derive from. */
function flyableRoute(): Route {
	const wp = (id: string, lat: number, lon: number): Waypoint => ({
		id,
		lat,
		lon,
		kind: 'free',
		alt: 3000,
		altAuto: true,
	});
	return {
		id: 'route-1',
		name: null,
		waypoints: [wp('a', 48.82, 2.62), wp('b', 47.97, 2.68)],
		selectedWaypointId: null,
	};
}

/** A date far enough out that no model reaches it, but inside the endpoint's
 *  own +15 day window. */
function inSevenDays(): string {
	return new Date(Date.now() + 7 * 24 * HOUR_MS).toISOString().slice(0, 10);
}

afterEach(reset);

describe('the forecast reach', () => {
	it('is the lesser of the model horizon and the endpoint range', () => {
		const now = Date.parse('2026-09-08T10:30:00Z');
		// AROME sees 48 h, well inside the endpoint's 15 days.
		expect(forecastReachEndMs(now, 48)).toBe(Date.parse('2026-09-08T10:00:00Z') + 48 * HOUR_MS);
		// GFS sees 384 h, which outruns it, so the endpoint decides.
		expect(forecastReachEndMs(now, 384)).toBe(forecastRangeEndMs(now));
	});

	it('pulls an instant past it back, and says it did', () => {
		expect(clampToReach(1_000, 2_000)).toEqual({ ms: 1_000, clamped: false });
		expect(clampToReach(2_000, 2_000)).toEqual({ ms: 2_000, clamped: false });
		expect(clampToReach(3_000, 2_000)).toEqual({ ms: 2_000, clamped: true });
	});
});

describe('periodAnchor', () => {
	it('is the hour in force by default, not the next one', () => {
		reset();
		const now = Date.parse('2026-09-08T10:30:00Z');
		// The instant something is READ at, where firstDepartureMs answers when
		// a flight can DEPART; a display anchored an hour ahead would never
		// show the weather happening now.
		expect(periodAnchor(now)).toEqual({ ms: Date.parse('2026-09-08T10:00:00Z'), source: 'now' });
	});

	it('is the typed range start in custom mode', () => {
		setWindowMode('custom');
		filter.window.fromDate = '2026-06-09';
		filter.window.fromTime = '07:30';
		expect(periodAnchor(Date.now())).toEqual({
			ms: Date.parse('2026-06-09T07:30:00Z'),
			source: 'custom',
		});
	});

	it('falls back to the current hour for an invalid range', () => {
		setWindowMode('custom');
		filter.window.fromDate = '2026-06-10';
		filter.window.fromTime = '00:00';
		filter.window.toDate = '2026-06-09';
		filter.window.toTime = '00:00';
		const now = Date.parse('2026-09-08T10:30:00Z');
		expect(periodAnchor(now).source).toBe('now');
	});

	it('is the stated departure in flight mode', () => {
		reset();
		routes.list = [flyableRoute()];
		flightPrep.dossier.flightDate = '2026-09-20';
		flightPrep.dossier.departureTime = '09:30';
		setWindowMode('flight');
		expect(periodAnchor(Date.now())).toEqual({
			ms: Date.parse('2026-09-20T09:30:00Z'),
			source: 'flight',
		});
	});

	it('marks a flight with no departure time as a day, never a departure', () => {
		// The whole point of the separate source: the panel may show that hour
		// but must not word it as a departure the pilot never gave.
		reset();
		routes.list = [flyableRoute()];
		flightPrep.dossier.flightDate = '2026-09-20';
		setWindowMode('flight');
		const a = periodAnchor(Date.now());
		expect(a.source).toBe('flight-day');
		expect(new Date(a.ms).toISOString()).toBe('2026-09-20T00:00:00.000Z');
	});

	it('falls back to the current hour in flight mode with no route planned', () => {
		setWindowMode('flight');
		const now = Date.parse('2026-09-08T10:30:00Z');
		expect(periodAnchor(now)).toEqual({ ms: Date.parse('2026-09-08T10:00:00Z'), source: 'now' });
	});
});

describe('wxValidTime', () => {
	it('shows the current hour under the default period', () => {
		reset();
		const w = wxValidTime();
		expect(w.source).toBe('now');
		expect(w.ms).toBe(floorHourMs(Date.now()));
		expect(w.clamped).toBe(false);
	});

	it('shows the flight the nav log flies', () => {
		reset();
		routes.list = [flyableRoute()];
		// Tomorrow, so the departure is inside every model's horizon.
		const d = new Date(Date.now() + 24 * HOUR_MS).toISOString().slice(0, 10);
		flightPrep.dossier.flightDate = d;
		flightPrep.dossier.departureTime = '09:30';
		setWindowMode('flight');
		const w = wxValidTime();
		expect(w.ms).toBe(Date.parse(`${d}T09:30:00Z`));
		expect(w.source).toBe('flight');
		expect(w.periodSource).toBe('flight');
	});

	it('shows the last hour the forecast reaches for a flight beyond it', () => {
		// The degradation is stated, not silent: briefedMs keeps the flight's
		// own instant so the panel can name both.
		reset();
		routes.list = [flyableRoute()];
		flightPrep.dossier.flightDate = inSevenDays();
		flightPrep.dossier.departureTime = '09:30';
		setWindowMode('flight');
		const w = wxValidTime();
		expect(w.clamped).toBe(true);
		expect(w.ms).toBe(w.reachEndMs);
		expect(w.briefedMs).toBe(Date.parse(`${inSevenDays()}T09:30:00Z`));
		expect(w.ms).toBeLessThan(w.briefedMs);
	});
});

describe('the pin', () => {
	it('holds a hand-set hour, and is never clamped', () => {
		reset();
		const at = floorHourMs(Date.now()) + 3 * HOUR_MS;
		setWxValidTime(at);
		const w = wxValidTime();
		expect(w.ms).toBe(at);
		expect(w.source).toBe('pin');
		expect(w.periodSource).toBe('now');
	});

	it('is not taken by a value the period already shows', () => {
		reset();
		setWxValidTime(floorHourMs(Date.now()));
		expect(wxValidTime().source).toBe('now');
	});

	it('is released by hand', () => {
		reset();
		setWxValidTime(floorHourMs(Date.now()) + HOUR_MS);
		releaseWxValidTime();
		expect(wxValidTime().source).toBe('now');
	});

	it('is taken back when a typed range stops resolving', () => {
		// The instant moves (the range falls through to the current hour) while
		// the From fields do not, so the sig carries whether the branch
		// resolves at all, not only what it was typed as.
		setWindowMode('custom');
		filter.window.fromDate = '2026-06-09';
		filter.window.fromTime = '07:30';
		filter.window.toDate = '2026-06-10';
		filter.window.toTime = '00:00';
		const at = Date.parse('2026-06-09T12:00:00Z');
		setWxValidTime(at);
		expect(wxValidTime().ms).toBe(at);
		filter.window.toDate = '2026-06-08';
		expect(wxValidTime().source).not.toBe('pin');
	});

	it('is taken back when the period says something else', () => {
		reset();
		const at = floorHourMs(Date.now()) + 3 * HOUR_MS;
		setWxValidTime(at);
		expect(wxValidTime().ms).toBe(at);
		routes.list = [flyableRoute()];
		const d = new Date(Date.now() + 24 * HOUR_MS).toISOString().slice(0, 10);
		flightPrep.dossier.flightDate = d;
		flightPrep.dossier.departureTime = '09:30';
		setWindowMode('flight');
		const w = wxValidTime();
		expect(w.source).toBe('flight');
		expect(w.ms).toBe(Date.parse(`${d}T09:30:00Z`));
	});

	it('survives the hour rolling over under the same period', () => {
		// The look-ahead and the clock are deliberately out of the period
		// signature: neither moves the instant the period states.
		reset();
		const at = floorHourMs(Date.now()) + 3 * HOUR_MS;
		setWxValidTime(at);
		filter.window.horizonH = 24;
		expect(wxValidTime().ms).toBe(at);
	});
});

describe('animationWindow', () => {
	const now = Date.parse('2026-09-08T10:30:00Z');
	const nowHour = Date.parse('2026-09-08T10:00:00Z');

	it('starts at the current hour when the anchor is the current hour', () => {
		// The bounds the slider has always had, now expressed through the
		// anchor: 'now' must not move them.
		const w = animationWindow('arome_france', nowHour, now);
		expect(w.startMs).toBe(nowHour);
		expect(w.endMs).toBe(nowHour + 48 * HOUR_MS);
	});

	it('opens a ramp hour before a flight anchor', () => {
		const etd = Date.parse('2026-09-09T09:00:00Z');
		const w = animationWindow('meteofrance_seamless', etd, now);
		expect(w.startMs).toBe(etd - HOUR_MS);
		expect(w.endMs).toBeLessThanOrEqual(nowHour + 96 * HOUR_MS);
	});

	it('keeps a past anchor its own hour', () => {
		const past = Date.parse('2026-09-07T06:00:00Z');
		expect(animationWindow('meteofrance_seamless', past, now).startMs).toBe(past);
	});

	it('never offers an hour the model cannot answer', () => {
		const tomorrow = nowHour + 24 * HOUR_MS;
		for (const [m, h] of [
			['arome_france', 48],
			['meteofrance_seamless', 96],
			['gfs_seamless', 384],
		] as const) {
			const w = animationWindow(m, tomorrow, now);
			expect(w.endMs).toBeGreaterThan(w.startMs);
			expect(w.endMs).toBeLessThanOrEqual(forecastReachEndMs(now, h));
		}
	});

	it('backs off so a clamped anchor still spans the forecast, not one hour', () => {
		// Where a period further out than the model goes is clamped to: the
		// last hour answered. Anchoring a ramp hour before THAT would leave a
		// one-hour stub, so the span ends there and opens a full 48 h earlier.
		const reach = nowHour + 96 * HOUR_MS; // meteofrance_seamless
		const w = animationWindow('meteofrance_seamless', reach, now);
		expect(w.endMs).toBe(reach);
		expect(w.startMs).toBe(reach - 48 * HOUR_MS);
	});

	it('stays well-formed for a pinned hour past the reach', () => {
		// Only a pin gets there, the period's own instant being clamped. The
		// thumb rests at the end of the range and the panel's note says the
		// forecast does not reach the hour asked for.
		const far = nowHour + 40 * 24 * HOUR_MS;
		const w = animationWindow('meteofrance_seamless', far, now);
		expect(w.endMs).toBe(nowHour + 96 * HOUR_MS);
		expect(w.endMs - w.startMs).toBe(48 * HOUR_MS);
	});
});

describe('the fetch window', () => {
	const now = Date.parse('2026-09-08T10:30:00Z');

	it('brackets the shown hour', () => {
		const at = Date.parse('2026-09-09T09:30:00Z');
		expect(gridWindow('meteofrance_seamless', at, null, now)).toEqual({
			startMs: Date.parse('2026-09-09T09:00:00Z'),
			endMs: Date.parse('2026-09-09T11:00:00Z'),
		});
	});

	it('never asks past the endpoint range, whatever the shown hour', () => {
		// The trap the clamp walks into: a period further out than the model
		// goes is clamped to the last hour the forecast answers, which for a
		// long-horizon model IS the endpoint's own last hour (23:00 of the
		// 15th day), and the two hours after it fall into a day the endpoint
		// refuses. start_hour and end_hour are BOTH range-checked, so the
		// whole request would 400 rather than answer short.
		const rangeEnd = forecastRangeEndMs(now);
		const reach = forecastReachEndMs(now, 384); // GFS, longer than the range
		expect(reach).toBe(rangeEnd);
		const w = gridWindow('gfs_seamless', reach, null, now);
		expect(w.startMs).toBe(rangeEnd);
		expect(w.endMs).toBe(rangeEnd);
		expect(w.endMs).toBeLessThanOrEqual(rangeEnd);
	});

	it('spans the whole animation while its anchor is frozen', () => {
		const anchor = Date.parse('2026-09-09T09:00:00Z');
		const w = gridWindow('meteofrance_seamless', now, anchor, now);
		expect(w).toEqual(animationWindow('meteofrance_seamless', anchor, now));
	});

	it('keeps the animation span inside the endpoint range too', () => {
		const far = floorHourMs(now) + 40 * 24 * HOUR_MS;
		const w = gridWindow('gfs_seamless', far, far, now);
		expect(w.endMs).toBeLessThanOrEqual(forecastRangeEndMs(now));
		expect(w.endMs).toBeGreaterThanOrEqual(w.startMs);
	});
});

describe('the route fetch window', () => {
	/** Two points about 60 NM apart, so the leg carries a real duration. */
	const legWaypoints = (): Waypoint[] => [
		{ id: 'a', lat: 48.82, lon: 2.62, kind: 'free', alt: 3000, altAuto: true },
		{ id: 'b', lat: 47.97, lon: 2.68, kind: 'free', alt: 3000, altAuto: true },
	];

	it('cuts an end past the endpoint range rather than asking for it', () => {
		// A departure near the 15-day edge: the flight's own span runs past it,
		// and both hours being range-checked, asking would 400 the whole route
		// instead of answering short. The legs past the cut resolve
		// beyond-horizon, which is what they are.
		const cap = forecastRangeEndMs(Date.now());
		const w = routeFetchWindow(legWaypoints(), cap - HOUR_MS, 100, 'meteofrance_seamless');
		expect(w.endMs).toBeLessThanOrEqual(cap);
		expect(w.endMs).toBeGreaterThanOrEqual(w.startMs);
	});

	it('cuts the widened animation span the same way', () => {
		// The span is anchored on the hour SHOWN now, so for a long-horizon
		// model it can itself end on the last hour the endpoint accepts, and
		// the route window adds the flight time on top of it.
		const cap = forecastRangeEndMs(Date.now());
		windAloft.animAnchorMs = cap - 2 * HOUR_MS;
		const w = routeFetchWindow(legWaypoints(), Date.now(), 100, 'gfs_seamless');
		expect(w.endMs).toBeLessThanOrEqual(cap);
		windAloft.animAnchorMs = null;
	});
});
