/* A flight DATED but not TIMED, under the Flight period, is drawn over its
 * whole day (state/notam.svelte.ts drawnStateAt): what the period popover
 * tells the pilot ("the whole flight day is used") and what the performance
 * page reads (plannedFlightAt()). It was read at the current minute's time of
 * day on the flight's own day, so tomorrow's flight was drawn at whatever
 * hour the pilot happened to look: the same field read open at 0900 and shut
 * at 1500, and open beside a performance page marking it closed. Under-marking
 * a closure is the unsafe direction for a drawn warning. */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNotams } from '$lib/notam/parser';
import type { Notam } from '$lib/notam/types';
import type { Airport, Runway } from '$lib/data/airports';

const m = vi.hoisted(() => ({ items: [] as { notam: Notam; index: number }[] }));

vi.mock('$lib/state/notam.svelte', async () => {
	const real =
		await vi.importActual<typeof import('$lib/state/notam.svelte')>('$lib/state/notam.svelte');
	return {
		...real,
		filteredNotams: () => m.items,
		notamsByIdent: () => {
			const map = new Map<string, { notam: Notam; index: number }[]>();
			for (const it of m.items) {
				for (const code of it.notam.icaoCodes) {
					const k = code.toUpperCase();
					map.set(k, [...(map.get(k) ?? []), it]);
				}
			}
			return map;
		},
	};
});

const { aerodromeClosedByNotam, resolveAerodromeState } = await import(
	'$lib/state/aerodromeState.svelte'
);
const { drawnStateAt } = await import('$lib/state/notam.svelte');
const { setWindowMode } = await import('$lib/state/filter.svelte');
const { flightPrep } = await import('$lib/state/flightPrep.svelte');
const { installFlightScope } = await import('$lib/state/flightScope');
const { plannedFlightAt, plannedFlightTimed, plannedFlightWindow } = await import(
	'$lib/state/timeWindow.svelte'
);
const { routes, routeSettings } = await import('$lib/state/route.svelte');
const en = (await import('$lib/i18n/en/conditions')).conditions;
import type { Route, Waypoint } from '$lib/state/route.svelte';

const lszh = {
	ident: 'LSZH',
	name: 'ZURICH',
	lat: 47.46,
	lon: 8.55,
	runways: [{ le: '10', he: '28' } as Runway],
	radios: [],
} as unknown as Airport;

function flyableRoute(): Route {
	const wp = (id: string, lat: number, lon: number): Waypoint => ({
		id,
		lat,
		lon,
		kind: 'free',
		alt: 3000,
		altAuto: true,
	}) as unknown as Waypoint;
	return {
		id: 'route-1',
		name: null,
		waypoints: [wp('a', 48.82, 2.62), wp('b', 47.97, 2.68)],
		selectedWaypointId: null,
	};
}

beforeAll(() => {
	installFlightScope();
});

beforeEach(() => {
	vi.useFakeTimers();
	routes.list = [flyableRoute()];
	flightPrep.dossier.flightDate = '2026-09-24'; // tomorrow, no ETD
	flightPrep.dossier.departureTime = null;
	setWindowMode('flight');
	// LSZH shut 1400-1600 on the flight's day.
	m.items = parseNotams(`A1234/26 NOTAMN
Q) LSAS/QFALC/IV/NBO/A/000/999/4728N00833E005
A) LSZH B) 2609241400 C) 2609241600
E) AD CLSD`).map((notam, index) => ({ notam, index }));
});

afterEach(() => {
	vi.useRealTimers();
	m.items = [];
	routes.list = [];
	setWindowMode('now');
	flightPrep.dossier.flightDate = null;
});

describe('an untimed flight tomorrow', () => {
	it('draws the same field the same way whenever today the pilot looks', () => {
		vi.setSystemTime(Date.UTC(2026, 8, 23, 9, 0));
		const morning = aerodromeClosedByNotam(lszh);
		vi.setSystemTime(Date.UTC(2026, 8, 23, 15, 0));
		const afternoon = aerodromeClosedByNotam(lszh);
		expect({ morning, afternoon }).toEqual({ morning: afternoon, afternoon: morning });
	});

	it('draws what the flight-prep page and the popover say for the same flight', () => {
		vi.setSystemTime(Date.UTC(2026, 8, 23, 9, 0));
		expect(en.flightNoEtd).toMatch(/whole flight day/);
		// The performance page: closed on the flight's day.
		expect(resolveAerodromeState(lszh, plannedFlightAt()).closed?.notam.id).toBe('A1234/26');
		// The map's cross and the panel's tag, over the flight's day:
		expect(drawnStateAt()).toEqual(plannedFlightAt());
		expect(aerodromeClosedByNotam(lszh)).toBe(true);
	});
});

/* The same flight with a departure time stated and the Route tab's Cruise box
 * emptied, no aircraft selected. That once left no cruise speed at all, so no
 * span: the planned-flight surfaces fell back to its DAY while the map fell
 * back to the current minute, and for one flight the performance page read
 * LSZH closed while the map read it open. An empty box now flies the
 * automatic speed (the aircraft's, else the 100 kt default), so the flight
 * keeps its span. */
describe('a timed flight with the Cruise box emptied', () => {
	const cruise = routeSettings.cruiseSpeedKt;
	beforeEach(() => {
		flightPrep.dossier.departureTime = '14:30';
		routeSettings.cruiseSpeedKt = null;
	});
	afterEach(() => {
		flightPrep.dossier.departureTime = null;
		routeSettings.cruiseSpeedKt = cruise;
	});

	it('keeps its span, flown at the automatic speed', () => {
		vi.setSystemTime(Date.UTC(2026, 8, 23, 9, 0));
		expect(plannedFlightTimed()).toBe(true);
		const w = plannedFlightWindow();
		// The ramp hour before the 14:30 departure, as at a typed 100 kt.
		expect(w?.from).toBe(Date.UTC(2026, 8, 24, 13, 30));
		expect(drawnStateAt()).toEqual(plannedFlightAt());
	});

	it('narrows to the flight at a typed speed too', () => {
		vi.setSystemTime(Date.UTC(2026, 8, 23, 9, 0));
		routeSettings.cruiseSpeedKt = 100;
		expect(plannedFlightTimed()).toBe(true);
		const w = plannedFlightWindow();
		// The ramp hour before the 14:30 departure.
		expect(w?.from).toBe(Date.UTC(2026, 8, 24, 13, 30));
		expect(w && w.to > Date.UTC(2026, 8, 24, 14, 30)).toBe(true);
	});
});
