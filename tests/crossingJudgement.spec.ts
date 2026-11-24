/* How the crossings strip judges the planned flight's crossings
 * (state/activity.svelte.ts crossingJudgement, crossingClock), as the
 * verdict window reads the flight (briefingWindow): each crossing at its
 * planned time while the plan states its times and its window is still to
 * come or under way, over the flight's day for a plan dated alone, and from
 * the current minute during a recording or once the planned window has
 * passed. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crossingClock, crossingJudgement } from '$lib/state/activity.svelte';
import { flightPrep } from '$lib/state/flightPrep.svelte';
import { nav } from '$lib/state/navRecording.svelte';
import { routes, routeSettings, type Route, type Waypoint } from '$lib/state/route.svelte';

const MIN = 60_000;

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

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(Date.UTC(2026, 10, 24, 9, 30));
	routes.list = [route()];
	routeSettings.cruiseSpeedKt = 100;
	flightPrep.dossier.flightDate = '2026-11-27';
	flightPrep.dossier.departureTime = '10:00';
});

afterEach(() => {
	vi.useRealTimers();
	routes.list = [];
	routeSettings.cruiseSpeedKt = cruise;
	flightPrep.dossier.flightDate = null;
	flightPrep.dossier.departureTime = null;
	nav.recording = false;
});

describe('how the strip judges the crossings', () => {
	it('judges each crossing at its planned time while the flight is to come', () => {
		expect(crossingJudgement()).toBe('timed');
		const clock = crossingClock(routes.list[0]);
		expect(clock?.(0)).toBe(Date.UTC(2026, 10, 27, 10, 0));
		// 10 NM at 100 kt in still air.
		expect(clock && clock(10) - clock(0)).toBeCloseTo(6 * MIN, 6);
	});

	it('keeps the planned times under way, until the planned window has passed', () => {
		vi.setSystemTime(Date.UTC(2026, 10, 27, 10, 20));
		expect(crossingJudgement()).toBe('timed');
		vi.setSystemTime(Date.UTC(2026, 10, 27, 14, 0));
		expect(crossingJudgement()).toBe('now');
		expect(crossingClock(routes.list[0])).toBeNull();
	});

	it('judges over the flight’s day for a plan dated alone', () => {
		flightPrep.dossier.departureTime = null;
		expect(crossingJudgement()).toBe('day');
		expect(crossingClock(routes.list[0])).toBeNull();
	});

	it('judges from the current minute during a recording', () => {
		nav.recording = true;
		expect(crossingJudgement()).toBe('now');
		expect(crossingClock(routes.list[0])).toBeNull();
	});
});
