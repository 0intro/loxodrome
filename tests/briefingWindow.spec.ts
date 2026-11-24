/* The window a NOTAM briefing for the planned flight asks for. The route
 * fetch sent the viewing period, which every session opens on Now: a flight
 * dated in three days was briefed for the next 24 h, and the nav log and the
 * performance page then read that day's NOTAM states from a briefing that
 * held none of them. The planned flight's own window goes instead, from the
 * current minute during a recording or once the planned window has passed,
 * since SOFIA refuses a departure behind the clock. A typed custom period
 * still goes first, and an app with no flight to plan (the NOTAM Viewer)
 * reads the viewing period. */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => ({
	route: [] as { from: number; to: number }[],
	aerodrome: [] as number[],
}));

vi.mock('$lib/sofia/fetch', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/sofia/fetch')>()),
	briefFromSofia: (_tracks: unknown, opts: { window: { from: number; to: number } }) => {
		sent.route.push(opts.window);
		return Promise.resolve();
	},
	fetchAerodromeFromSofia: (_id: string, fromMs: number) => {
		sent.aerodrome.push(fromMs);
		return Promise.resolve({ answer: [], briefed: { from: fromMs, to: fromMs + 86_340_000 } });
	},
}));
vi.mock('$lib/state/data.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/state/data.svelte')>()),
	ensureNavaids: () => Promise.resolve([]),
	ensureAirports: () => Promise.resolve([]),
	ensureAirspaces: () => Promise.resolve([]),
}));

const { briefingWindow } = await import('$lib/state/timeWindow.svelte');
const { fetchRouteNotamsFromSofia } = await import('$lib/state/routeNotamFetch');
const { refreshAerodromeNotams, refreshAerodromesByName } = await import('$lib/state/aerodromeNotams');
const { activeEvalWindow } = await import('$lib/state/notam.svelte');
const { filter, setWindowMode } = await import('$lib/state/filter.svelte');
const { flightPrep } = await import('$lib/state/flightPrep.svelte');
const { installFlightScope } = await import('$lib/state/flightScope');
const { planScope } = await import('$lib/state/planScope.svelte');
const { nav } = await import('$lib/state/navRecording.svelte');
const { routes, routeSettings } = await import('$lib/state/route.svelte');
import type { Route, Waypoint } from '$lib/state/route.svelte';

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 24, 9, 30, 20);
const MINUTE = Date.UTC(2026, 10, 24, 9, 30);

function route(): Route {
	const wp = (id: string, lat: number, lon: number): Waypoint =>
		({ id, lat, lon, kind: 'free', alt: 2500, altAuto: true }) as unknown as Waypoint;
	return {
		id: 'route-1',
		name: null,
		waypoints: [wp('a', 48.75, 2.11), wp('b', 47.9, 2.16)],
		selectedWaypointId: null,
	};
}

const cruise = routeSettings.cruiseSpeedKt;

beforeAll(() => {
	installFlightScope();
});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	routes.list = [route()];
	routeSettings.cruiseSpeedKt = 100;
	flightPrep.dossier.flightDate = '2026-11-27';
	flightPrep.dossier.departureTime = '10:00';
	sent.route = [];
	sent.aerodrome = [];
});

afterEach(() => {
	vi.useRealTimers();
	routes.list = [];
	routeSettings.cruiseSpeedKt = cruise;
	flightPrep.dossier.flightDate = null;
	flightPrep.dossier.departureTime = null;
	nav.recording = false;
	setWindowMode('now');
});

describe('the planned flight asks its own window', () => {
	it('opens the ramp hour before a departure three days ahead', () => {
		const w = briefingWindow();
		expect(w?.from).toBe(Date.UTC(2026, 10, 27, 9, 0));
		expect(w && w.to > Date.UTC(2026, 10, 27, 10, 0)).toBe(true);
	});

	it('spans the whole day of a flight dated with no departure time', () => {
		flightPrep.dossier.departureTime = null;
		expect(briefingWindow()).toEqual({
			from: Date.UTC(2026, 10, 27),
			to: Date.UTC(2026, 10, 28) - 1,
		});
	});

	it('asks nothing of its own with no route to plan from', () => {
		routes.list = [];
		expect(briefingWindow()).toBeNull();
	});
});

describe('a flight flown now asks from the current minute', () => {
	it('during a recording, whatever the plan is dated', () => {
		nav.recording = true;
		const planned = { from: Date.UTC(2026, 10, 27, 9, 0) };
		const w = briefingWindow();
		expect(w?.from).toBe(MINUTE);
		expect(w && w.from < planned.from).toBe(true);
	});

	it('once a dated day has passed, for half a day', () => {
		flightPrep.dossier.flightDate = '2026-11-23';
		flightPrep.dossier.departureTime = null;
		expect(briefingWindow()).toEqual({ from: MINUTE, to: MINUTE + 12 * H });
	});

	it('once a timed flight has landed, for its own length', () => {
		flightPrep.dossier.flightDate = '2026-11-24';
		flightPrep.dossier.departureTime = '04:00';
		const w = briefingWindow();
		expect(w?.from).toBe(MINUTE);
		// The ramp hour, the flight and the two hours after it.
		expect(w && w.to - w.from > 3 * H && w.to - w.from < 6 * H).toBe(true);
	});
});

describe('what the fetches send', () => {
	it('the route fetch briefs the flight, not the viewing period', async () => {
		await fetchRouteNotamsFromSofia();
		expect(sent.route).toEqual([briefingWindow()]);
		expect(sent.route[0].from).not.toBe(activeEvalWindow().from);
	});

	it('a typed custom period goes first', async () => {
		filter.window.fromDate = '2026-11-25';
		filter.window.fromTime = '08:00';
		filter.window.toDate = '2026-11-25';
		filter.window.toTime = '18:00';
		setWindowMode('custom');
		await fetchRouteNotamsFromSofia();
		expect(sent.route).toEqual([{ from: Date.UTC(2026, 10, 25, 8, 0), to: Date.UTC(2026, 10, 25, 18, 0) }]);
	});

	it('the automatic run briefs the flight whatever period is typed', async () => {
		filter.window.fromDate = '2026-11-25';
		filter.window.fromTime = '08:00';
		filter.window.toDate = '2026-11-25';
		filter.window.toTime = '18:00';
		setWindowMode('custom');
		await fetchRouteNotamsFromSofia({ flight: true });
		await refreshAerodromesByName(['LFOQ']);
		expect(sent.route).toEqual([briefingWindow()]);
		expect(sent.aerodrome).toEqual([briefingWindow()?.from]);
	});

	it("the airport panel asks the route fetch's window", async () => {
		await refreshAerodromeNotams('LFOZ');
		expect(sent.aerodrome).toEqual([Date.UTC(2026, 10, 27, 9, 0)]);
	});

	it('the panel of an app with no flight reads the viewing period', async () => {
		const flight = planScope.flight;
		planScope.flight = null;
		try {
			await refreshAerodromeNotams('LFOZ');
			expect(sent.aerodrome).toEqual([activeEvalWindow().from]);
		} finally {
			planScope.flight = flight;
		}
	});
});
