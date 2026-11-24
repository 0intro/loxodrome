/* A recording at its in-memory cap drops its oldest fixes in place, the
 * array kept, and three folds over the trace extend by index: the motion
 * fold (state/navMotion), the airborne watermark (state/airborne) and the
 * route assignment (state/navRoute navSegments). Each keys on the array AND
 * its head instant, so a head that moves refolds it, the checkpoint memo's
 * rule (state/navProgress): whatever the drop and however often the fold is
 * read, it equals a fold over a copy of the same fixes, and a takeoff, a
 * landing or a handover past the cap is seen. */

import { afterEach, describe, expect, it } from 'vitest';
import { extendMotion, newMotionFold, TAKEOFF_KT } from '$lib/nav/navlogLive';
import { assignRouteSegments } from '$lib/nav/routeAssign';
import type { TrackPoint } from '$lib/nav/trace';
import { airborneGate, firstAirborneIndex, firstAirborneMs } from '$lib/state/airborne';
import { traceMotion } from '$lib/state/navMotion';
import { nav } from '$lib/state/navRecording.svelte';
import { navSegments } from '$lib/state/navRoute.svelte';
import { addRoute, addWaypoint, clearAllRoutes, routes } from '$lib/state/route.svelte';

const T0 = Date.UTC(2026, 10, 18, 8, 0);

/** Fix `i`: a second apart from T0, at `kt`, moving east. */
function fix(i: number, kt: number): TrackPoint {
	return { lat: 48.6, lon: 2.6 + i * 0.0005, altFt: null, timeMs: T0 + i * 1000, speedKt: kt, trackDeg: 90 };
}

/** The ingest at the cap: each fix appended in place and the oldest one
 *  dropped, the length held, `read` run per fix as the live readers do. */
function slide(points: TrackPoint[], next: TrackPoint[], read: () => void): void {
	for (const p of next) {
		points.push(p);
		points.splice(0, 1);
		read();
	}
}

const ground = (n: number): TrackPoint[] => Array.from({ length: n }, (_, i) => fix(i, 0));

describe('the motion fold over a trace whose head moves', () => {
	it('sees a takeoff and a landing at a constant length', () => {
		const points = ground(300);
		expect(traceMotion(points).takeoffMs).toBeNull();
		// Two minutes at 90 kt, then 90 s at 5 kt: a flight and its landing.
		const kts = [...Array<number>(120).fill(90), ...Array<number>(90).fill(5)];
		slide(points, kts.map((kt, k) => fix(300 + k, kt)), () => traceMotion(points));
		expect(points).toHaveLength(300);
		const m = traceMotion(points);
		expect(m.takeoffMs).toBe(T0 + 300_000);
		expect(m.takeoffObserved).toBe(true);
		expect(m.landingMs).toBe(T0 + 420_000);
		expect(m).toEqual(extendMotion(newMotionFold(), [...points]));
	});

	it('reads every fix after a drop it was not there to see', () => {
		const points = ground(300);
		traceMotion(points);
		// Fifty fixes, the tenth taking off, then the oldest forty go at once.
		for (let k = 0; k < 50; k++) {
			points.push(fix(300 + k, k < 9 ? 0 : 90));
		}
		points.splice(0, 40);
		const m = traceMotion(points);
		expect(m.takeoffMs).toBe(T0 + 309_000);
		expect(m).toEqual(extendMotion(newMotionFold(), [...points]));
	});
});

describe('the airborne watermark over a trace whose head moves', () => {
	it('opens on a takeoff at a constant length', () => {
		const points = ground(300);
		expect(firstAirborneIndex(points)).toBeNull();
		const fast = Array.from({ length: 60 }, (_, k) => fix(300 + k, TAKEOFF_KT + 50));
		slide(points, fast, () => firstAirborneIndex(points));
		expect(firstAirborneMs(points)).toBe(T0 + 300_000);
		expect(firstAirborneIndex(points)).toBe(240);
		expect(airborneGate(points, T0 + 359_000, null, true)).toMatchObject({ airborne: true, openMs: T0 + 300_000 });
	});
});

describe('the route assignment over a trace whose head moves', () => {
	afterEach(() => {
		nav.points = [];
	});

	it('hands over to the next trip at a constant length', () => {
		clearAllRoutes();
		const t1 = routes.activeId;
		addWaypoint(48, 2);
		addWaypoint(48, 2.6);
		addRoute();
		addWaypoint(48, 2.6);
		addWaypoint(48, 3.2);
		const t2 = routes.activeId;
		// 100 kt eastward along both trips, a fix every 10 s.
		const flight: TrackPoint[] = Array.from({ length: 150 }, (_, i) => ({
			lat: 48,
			lon: 2 + i * 0.0067,
			altFt: 2000,
			timeMs: T0 + i * 10_000,
			speedKt: 100,
			trackDeg: 90,
		}));
		nav.points = flight.slice(0, 60);
		expect(navSegments().map((s) => s.routeId)).toEqual([t1]);
		slide(nav.points, flight.slice(60, 120), () => navSegments());
		const fresh = assignRouteSegments([...nav.points], routes.list);
		expect(fresh.map((s) => s.routeId)).toEqual([t1, t2]);
		expect(navSegments()).toEqual(fresh);
	});
});
