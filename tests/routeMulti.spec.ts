/* Unit tests for the pure multi-route helpers: route colours, the endpoint label,
 * and the route-list reducers. */

import { describe, it, expect } from 'vitest';
import { ROUTE_COLORS, routeColor } from '$lib/route/routeColors';
import { planFileSubject, routeEndpointLabel, routesFileBaseName } from '$lib/route/routeLabel';
import {
	addRouteTo,
	departureSlot,
	dropBarIndex,
	dropSlot,
	flownFloor,
	moveRouteIn,
	removeRouteFrom,
	routeSlots,
	setActiveIn,
} from '$lib/route/routeList';
import type { Waypoint } from '$lib/state/route.svelte';

function wp(extra: Partial<Waypoint>): Waypoint {
	return { id: 't', lat: 0, lon: 0, kind: 'free', alt: 2000, altAuto: true, ...extra };
}

describe('routeColor', () => {
	it('keeps the legacy magenta at index 0 and wraps modulo the palette', () => {
		expect(ROUTE_COLORS).toHaveLength(6);
		expect(routeColor(0)).toBe('#c2185b');
		expect(routeColor(6)).toBe(routeColor(0));
		expect(routeColor(7)).toBe(routeColor(1));
		expect(new Set(ROUTE_COLORS).size).toBe(6); // all distinct
	});
});

describe('routeEndpointLabel', () => {
	it('prefers a custom name', () => {
		expect(routeEndpointLabel({ name: 'My trip', waypoints: [] }, 'New route')).toBe('My trip');
	});
	it('labels by first -> last waypoint idents', () => {
		const r = { name: null, waypoints: [wp({ ident: 'LFPL' }), wp({ ident: 'LFAI' }), wp({ ident: 'LFPK' })] };
		expect(routeEndpointLabel(r, 'New route')).toBe('LFPL → LFPK');
	});
	it('uses coordinates for free endpoints', () => {
		const r = { name: null, waypoints: [wp({ lat: 48.857, lon: 2.352 }), wp({ ident: 'LFPK' })] };
		expect(routeEndpointLabel(r, 'New route')).toBe('48.857, 2.352 → LFPK');
	});
	it('shows the single waypoint, then a placeholder when empty', () => {
		expect(routeEndpointLabel({ name: null, waypoints: [wp({ ident: 'LFPL' })] }, 'New route')).toBe('LFPL');
		expect(routeEndpointLabel({ name: null, waypoints: [] }, 'New route')).toBe('New route');
	});
});

describe('routesFileBaseName', () => {
	const ap = (ident: string) => wp({ kind: 'airport', ident });

	it('chains every trip, collapsing the airport shared between consecutive legs', () => {
		const list = [
			{ waypoints: [ap('LFPL'), ap('LFPU')] },
			{ waypoints: [ap('LFPU'), ap('LFGO')] },
			{ waypoints: [ap('LFGO'), ap('LFPL')] },
		];
		expect(routesFileBaseName(list)).toBe('LFPL-LFPU-LFGO-LFPL');
	});

	it('joins the airports within a single trip, skipping non-airport turn points', () => {
		const list = [
			{ waypoints: [ap('LFPL'), wp({ kind: 'navaid', ident: 'CGN' }), ap('LFPK'), ap('LFFZ')] },
		];
		expect(routesFileBaseName(list)).toBe('LFPL-LFPK-LFFZ');
	});

	it('excludes alternate routes from the chain', () => {
		const list = [
			{ waypoints: [ap('LFPL'), ap('LFPU')] },
			{ waypoints: [ap('LFPU'), ap('LFQB')], alternate: true },
			{ waypoints: [ap('LFPU'), ap('LFGO')] },
		];
		expect(routesFileBaseName(list)).toBe('LFPL-LFPU-LFGO');
	});

	it('concatenates disjoint trips that share no junction', () => {
		const list = [{ waypoints: [ap('LFPL'), ap('LFPU')] }, { waypoints: [ap('LFAT'), ap('LFBO')] }];
		expect(routesFileBaseName(list)).toBe('LFPL-LFPU-LFAT-LFBO');
	});

	it('falls back to endpoint labels, sanitized, when no trip names an airport', () => {
		const list = [{ waypoints: [wp({ label: 'Custom point' }), wp({ kind: 'navaid', ident: 'CGN' })] }];
		expect(routesFileBaseName(list)).toBe('Custom-point-CGN');
	});

	/* Accents fold to their base letter rather than becoming separators: this
	 * is a filename FIELD, and "B-le" is not a name anyone recognises. */
	it('folds diacritics instead of punching holes in the name', () => {
		const list = [{ waypoints: [wp({ label: 'B\u00e2le' }), wp({ label: 'A\u00e9rodrome' })] }];
		expect(routesFileBaseName(list)).toBe('Bale-Aerodrome');
	});

	/* Nothing usable is an EMPTY field, which the grammar then omits, so a
	 * nameless plan saves as "plan.yaml" and not "routes_plan.yaml". */
	it('uses a lone airport, then nothing at all when there is nothing usable', () => {
		expect(routesFileBaseName([{ waypoints: [ap('LFPL')] }])).toBe('LFPL');
		expect(routesFileBaseName([{ waypoints: [] }])).toBe('');
		expect(routesFileBaseName([])).toBe('');
	});
});

describe('planFileSubject', () => {
	const ap = (ident: string) => wp({ kind: 'airport', ident });
	const list = [{ waypoints: [ap('LFPL'), ap('LFOX')] }];

	/* A name the user typed is theirs, and nothing else can restate it: the
	 * same reason docs/file-names.md gives for an imported trace keeping its
	 * own name. It stays ONE field, `-` inside and never `_`, which separates
	 * fields, and it keeps the case it was typed in like every other subject. */
	it('takes the plan name, folded into one field, when there is one', () => {
		expect(planFileSubject('Nav examen Compiègne', list)).toBe('Nav-examen-Compiegne');
		expect(planFileSubject('Sortie / plage', list)).not.toContain('_');
	});

	it('falls back to the chain when there is no name, or none that survives', () => {
		expect(planFileSubject(null, list)).toBe('LFPL-LFOX');
		expect(planFileSubject('', list)).toBe('LFPL-LFOX');
		expect(planFileSubject('   ', list)).toBe('LFPL-LFOX');
		// Nothing ASCII survives the fold: the chain still answers.
		expect(planFileSubject('привет', list)).toBe('LFPL-LFOX');
		// Neither answers: an empty field, which the grammar omits.
		expect(planFileSubject(null, [])).toBe('');
	});
});

describe('route-list reducers', () => {
	const base = { list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], activeId: 'b' };

	it('addRouteTo appends and activates, respecting the cap', () => {
		const r = addRouteTo(base, { id: 'd' }, 6);
		expect(r.list.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
		expect(r.activeId).toBe('d');
		// at the cap, no-op
		expect(addRouteTo({ list: [{ id: 'a' }], activeId: 'a' }, { id: 'b' }, 1)).toEqual({
			list: [{ id: 'a' }],
			activeId: 'a',
		});
	});

	it('removeRouteFrom drops the route and reselects the previous neighbour', () => {
		const r = removeRouteFrom(base, 'b'); // active removed
		expect(r.list.map((x) => x.id)).toEqual(['a', 'c']);
		expect(r.activeId).toBe('a'); // previous index
	});

	it('removeRouteFrom keeps the active id when a non-active route goes', () => {
		const r = removeRouteFrom(base, 'a');
		expect(r.list.map((x) => x.id)).toEqual(['b', 'c']);
		expect(r.activeId).toBe('b');
	});

	it('removeRouteFrom refuses to drop the last route', () => {
		const one = { list: [{ id: 'a' }], activeId: 'a' };
		expect(removeRouteFrom(one, 'a')).toBe(one);
	});

	it('setActiveIn validates membership', () => {
		expect(setActiveIn(base, 'c').activeId).toBe('c');
		expect(setActiveIn(base, 'zz')).toBe(base);
	});
});

describe('moving a route keeps every alternate with its trip', () => {
	/** A list from a picture: T for a trip, A for an alternate, in order. */
	const plan = (...ids: string[]) => ({
		list: ids.map((id) => ({ id, alternate: id.startsWith('A') ? true : undefined })),
		activeId: ids[0],
	});
	const ids = (s: { list: { id: string }[] }) => s.list.map((r) => r.id);

	it('a trip steps over the neighbouring trip with its alternate', () => {
		const s = plan('T1', 'A1', 'T2');
		expect(ids(moveRouteIn(s, 'T2', -1))).toEqual(['T2', 'T1', 'A1']);
		expect(ids(moveRouteIn(s, 'T1', 1))).toEqual(['T2', 'T1', 'A1']);
	});

	it('an alternate steps to the next trip and attaches to it', () => {
		const s = plan('T1', 'A1', 'T2', 'T3');
		expect(ids(moveRouteIn(s, 'A1', 1))).toEqual(['T1', 'T2', 'A1', 'T3']);
		expect(ids(moveRouteIn(moveRouteIn(s, 'A1', 1), 'A1', 1))).toEqual(['T1', 'T2', 'T3', 'A1']);
	});

	it('an appended alternate climbs to the first trip that holds none, skipping held ones', () => {
		const s = plan('T1', 'A1', 'T2', 'T3', 'AX');
		const up = moveRouteIn(s, 'AX', -1);
		expect(ids(up)).toEqual(['T1', 'A1', 'T2', 'AX', 'T3']);
		// T1 holds A1: nothing above is free, so the step does nothing.
		expect(moveRouteIn(up, 'AX', -1)).toBe(up);
		const s2 = plan('T1', 'T2', 'A2', 'T3', 'AX');
		expect(ids(moveRouteIn(s2, 'AX', -1))).toEqual(['T1', 'AX', 'T2', 'A2', 'T3']);
	});

	it('an alternate never climbs above the first trip', () => {
		const s = plan('T1', 'A1', 'T2');
		expect(moveRouteIn(s, 'A1', -1)).toBe(s);
	});

	it('a doubled alternate travels with its trip and keeps its place behind', () => {
		const s = plan('T1', 'A1', 'A1b', 'T2');
		expect(ids(moveRouteIn(s, 'T2', -1))).toEqual(['T2', 'T1', 'A1', 'A1b']);
	});

	it('a leading alternate stays leading, and a trip never adopts it', () => {
		const s = plan('A0', 'T1', 'T2');
		expect(ids(moveRouteIn(s, 'T2', -1))).toEqual(['A0', 'T2', 'T1']);
		expect(moveRouteIn(moveRouteIn(s, 'T2', -1), 'T2', -1)).toEqual(moveRouteIn(s, 'T2', -1));
	});

	it('the ends and an unknown id do nothing, the active id stays', () => {
		const s = plan('T1', 'T2');
		expect(moveRouteIn(s, 'T1', -1)).toBe(s);
		expect(moveRouteIn(s, 'T2', 1)).toBe(s);
		expect(moveRouteIn(s, 'zz', 1)).toBe(s);
		expect(moveRouteIn(s, 'T1', 1).activeId).toBe('T1');
	});

	it('nothing crosses the floor, and a route above it keeps its place', () => {
		const s = plan('T1', 'A1', 'T2', 'T3');
		// T1 and its alternate flown: the floor sits after them.
		expect(routeSlots(s.list, 'T1', 2)).toEqual([0]);
		expect(moveRouteIn(s, 'T3', -1, 2).list.map((r) => r.id)).toEqual(['T1', 'A1', 'T3', 'T2']);
		expect(moveRouteIn(moveRouteIn(s, 'T3', -1, 2), 'T3', -1, 2)).toEqual(moveRouteIn(s, 'T3', -1, 2));
	});

	it('lists the slots a route may take, its own included', () => {
		const s = plan('T1', 'A1', 'T2', 'T3', 'AX');
		// Before T1, its own place, or the end: never between T3 and B.
		expect(routeSlots(s.list, 'T2')).toEqual([0, 2, 4]);
		expect(routeSlots(s.list, 'AX')).toEqual([3, 4]);
		expect(routeSlots(s.list, 'zz')).toEqual([]);
	});

	it('a drop lands in the nearest slot, and the bar marks where the block will start', () => {
		const s = plan('T1', 'A1', 'T2', 'T3');
		// Dropped between T1 and A1, T3 cannot split them: of the two slots
		// as near, it takes the earlier, before T1.
		expect(dropSlot(s.list, 'T3', 1)).toBe(0);
		expect(dropSlot(s.list, 'T3', 2)).toBe(2);
		expect(dropBarIndex(s.list, 'T3', 2)).toBe(2);
		expect(dropBarIndex(s.list, 'T3', 3)).toBe(null);
		// T1 carries A1: its slots count the routes without them.
		expect(dropBarIndex(s.list, 'T1', 1)).toBe(3);
		expect(dropBarIndex(s.list, 'T1', 2)).toBe(4);
	});
});

describe('departureSlot', () => {
	type W = { kind: string; ident?: string; lat: number; lon: number };
	const ad = (ident: string): W => ({ kind: 'airport', ident, lat: 0, lon: 0 });
	const r = (id: string, from: string, to: string, alternate?: boolean) => ({
		id,
		alternate,
		waypoints: [ad(from), ad(to)],
	});

	it('binds an appended alternate to the trip arriving where it departs', () => {
		const list = [r('T1', 'LFPN', 'LFAQ'), r('T2', 'LFAQ', 'LFQQ'), r('T3', 'LFQQ', 'LFPN'), r('A', 'LFAQ', 'LFOB', true)];
		expect(departureSlot(list, 'A')).toBe(1);
	});

	it('keeps a well placed alternate where it is', () => {
		const list = [r('T1', 'LFPN', 'LFAQ'), r('A', 'LFAQ', 'LFOB', true), r('T2', 'LFAQ', 'LFQQ')];
		expect(departureSlot(list, 'A')).toBe(1);
	});

	it('takes the nearest trip before it of two arriving there, else the one after', () => {
		const list = [r('T1', 'LFPN', 'LFAQ'), r('T2', 'LFAQ', 'LFPN'), r('T3', 'LFPN', 'LFAQ'), r('A', 'LFAQ', 'LFOB', true)];
		expect(departureSlot(list, 'A')).toBe(3);
		const first = [r('A', 'LFAQ', 'LFOB', true), r('T1', 'LFPN', 'LFAQ'), r('T2', 'LFAQ', 'LFPN')];
		expect(departureSlot(first, 'A')).toBe(1);
	});

	it('skips a trip that holds an alternate', () => {
		const list = [r('T1', 'LFPN', 'LFAQ'), r('A1', 'LFAQ', 'LFOB', true), r('T2', 'LFAQ', 'LFQQ'), r('B', 'LFAQ', 'LFOK', true)];
		expect(departureSlot(list, 'B')).toBe(null);
	});

	it('matches a free point by its position, and an empty route matches nothing', () => {
		const p = { kind: 'free', lat: 48.5, lon: 2.25 };
		const list = [
			{ id: 'T1', waypoints: [ad('LFPN'), p] },
			{ id: 'T2', waypoints: [p, ad('LFPN')] },
			{ id: 'A', alternate: true, waypoints: [{ ...p }, ad('LFOB')] },
			{ id: 'E', alternate: true, waypoints: [] },
		];
		expect(departureSlot(list, 'A')).toBe(1);
		expect(departureSlot(list, 'E')).toBe(null);
	});
});

describe('flownFloor', () => {
	const list = ['T1', 'A1', 'T2', 'T3'].map((id) => ({ id, alternate: id.startsWith('A') ? true : undefined }));

	it('sits past the last route flown, with the alternates behind it', () => {
		expect(flownFloor(list, [])).toBe(0);
		expect(flownFloor(list, ['T1'])).toBe(2);
		expect(flownFloor(list, ['T1', 'T2'])).toBe(3);
		expect(flownFloor(list, ['A1'])).toBe(2);
		expect(flownFloor(list, ['zz'])).toBe(0);
	});
});
