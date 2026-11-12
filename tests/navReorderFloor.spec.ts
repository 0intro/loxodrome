/* In flight, the routes flown keep their places (state/navRoute.svelte.ts
 * reorderFloor): the trace's assignment keys on the list's order, so a
 * reorder would re-cut the flight already flown. A recording along trip 1
 * of three: trip 1 stays first, the others still reorder among
 * themselves, and the floor goes when the recording stops. */
import { afterEach, describe, expect, it } from 'vitest';
import { nav } from '../src/lib/state/navRecording.svelte';
import { navSegments, reorderFloor } from '../src/lib/state/navRoute.svelte';
import { addRoute, addWaypoint, clearAllRoutes, moveRoute, routes } from '../src/lib/state/route.svelte';
import type { TrackPoint } from '../src/lib/nav/trace';

function draw(...points: [number, number][]): string {
	addRoute();
	for (const [lat, lon] of points) {
		addWaypoint(lat, lon);
	}
	return routes.activeId;
}

/** Fixes every 10 s at 100 kt from (lat, lon0) eastward to lon1. */
function eastward(lat: number, lon0: number, lon1: number, n: number): TrackPoint[] {
	return Array.from({ length: n }, (_, i) => ({
		lat,
		lon: lon0 + ((lon1 - lon0) * i) / (n - 1),
		altFt: 2000,
		timeMs: Date.UTC(2026, 10, 8, 10, 0, i * 10),
		speedKt: 100,
		trackDeg: 90,
	}));
}

describe('reorderFloor', () => {
	afterEach(() => {
		nav.recording = false;
		nav.points = [];
	});

	it('keeps trip 1 first while it is being flown', () => {
		clearAllRoutes();
		const t1 = routes.activeId;
		addWaypoint(48, 2);
		addWaypoint(48, 2.6);
		const t2 = draw([48, 2.6], [48.5, 2.6]);
		const t3 = draw([48.5, 2.6], [48.5, 2]);
		nav.points = eastward(48, 2, 2.4, 40);
		nav.recording = true;
		expect(navSegments().map((s) => s.routeId)).toEqual([t1]);
		expect(reorderFloor()).toBe(1);
		moveRoute(t3, -1, reorderFloor());
		expect(routes.list.map((r) => r.id)).toEqual([t1, t3, t2]);
		moveRoute(t3, -1, reorderFloor());
		expect(routes.list.map((r) => r.id)).toEqual([t1, t3, t2]);
		moveRoute(t1, 1, reorderFloor());
		expect(routes.list.map((r) => r.id)).toEqual([t1, t3, t2]);
		nav.recording = false;
		expect(reorderFloor()).toBe(0);
	});
});
