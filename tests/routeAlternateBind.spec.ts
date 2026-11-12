/* The alternate tick binds a route to the trip it diverts from: the trip
 * arriving where the alternate departs (state/route.svelte.ts
 * setRouteAlternate over route/routeList.ts departureSlot). A pilot plans
 * the trips first and adds the alternates after, each appended at the end. */
import { beforeEach, describe, expect, it } from 'vitest';
import {
	addAlternate,
	addRoute,
	addWaypoint,
	canAddAlternate,
	clearAllRoutes,
	MAX_ROUTES,
	routes,
	setRouteAlternate,
	undoRoute,
} from '../src/lib/state/route.svelte';

const P: [number, number] = [48.5, 2.5];
const Q: [number, number] = [47.5, 3.5];
const R: [number, number] = [46.5, 4.5];
const S: [number, number] = [47.25, 3.25];

/** A route from points, made active; its id. */
function draw(...points: [number, number][]): string {
	addRoute();
	for (const [lat, lon] of points) {
		addWaypoint(lat, lon);
	}
	return routes.activeId;
}

describe('the alternate tick binds by departure', () => {
	let t1: string, t2: string, t3: string;

	beforeEach(() => {
		clearAllRoutes();
		t1 = routes.activeId;
		addWaypoint(...P);
		addWaypoint(...Q);
		t2 = draw(Q, R);
		t3 = draw(R, P);
	});

	const order = (): string[] => routes.list.map((r) => r.id);

	it('an appended alternate leaving Q lands after the trip arriving at Q', () => {
		const x = draw(Q, S);
		setRouteAlternate(x, true);
		expect(order()).toEqual([t1, x, t2, t3]);
		expect(routes.list[1].alternate).toBe(true);
	});

	it('the flag and the move are one undo step', () => {
		const x = draw(Q, S);
		setRouteAlternate(x, true);
		undoRoute();
		expect(order()).toEqual([t1, t2, t3, x]);
		expect(routes.list[3].alternate).toBeUndefined();
	});

	it('a route with no point yet stays where it is, after the last trip', () => {
		addRoute();
		const empty = routes.activeId;
		setRouteAlternate(empty, true);
		expect(order()).toEqual([t1, t2, t3, empty]);
	});

	it('a departure no trip arrives at keeps the positional rule', () => {
		const x = draw(S, Q);
		setRouteAlternate(x, true);
		expect(order()).toEqual([t1, t2, t3, x]);
	});

	it('unticked, the route stays where it stands, a trip again', () => {
		const x = draw(Q, S);
		setRouteAlternate(x, true);
		setRouteAlternate(x, false);
		expect(order()).toEqual([t1, x, t2, t3]);
		expect(routes.list[1].alternate).toBeUndefined();
	});
});

describe('Add alternate', () => {
	let t1: string, t2: string;

	beforeEach(() => {
		clearAllRoutes();
		t1 = routes.activeId;
		addWaypoint(...P);
		addWaypoint(...Q);
		t2 = draw(Q, R);
	});

	it('inserts the alternate right after its trip, from its destination, active', () => {
		const a = addAlternate(t1)!;
		expect(routes.list.map((r) => r.id)).toEqual([t1, a.id, t2]);
		expect(a.alternate).toBe(true);
		expect(routes.activeId).toBe(a.id);
		const dep = routes.list[1].waypoints;
		expect(dep).toHaveLength(1);
		expect([dep[0].lat, dep[0].lon]).toEqual(Q);
		expect(dep[0].id).not.toBe(routes.list[0].waypoints[1].id);
	});

	it('is one undo step', () => {
		addAlternate(t1);
		undoRoute();
		expect(routes.list.map((r) => r.id)).toEqual([t1, t2]);
	});

	it('is refused for a trip holding one, for an alternate, and at the cap', () => {
		const a = addAlternate(t1)!;
		expect(canAddAlternate(t1)).toBe(false);
		expect(addAlternate(t1)).toBe(null);
		expect(addAlternate(a.id)).toBe(null);
		while (routes.list.length < MAX_ROUTES) {
			addRoute();
		}
		expect(canAddAlternate(t2)).toBe(false);
		expect(addAlternate(t2)).toBe(null);
	});
});
