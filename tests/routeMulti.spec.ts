/* Unit tests for the pure multi-route helpers: route colours, the endpoint label,
 * and the route-list reducers. */

import { describe, it, expect } from 'vitest';
import { ROUTE_COLORS, routeColor } from '$lib/route/routeColors';
import { planFileSubject, routeEndpointLabel, routesFileBaseName } from '$lib/route/routeLabel';
import { addRouteTo, removeRouteFrom, setActiveIn, reorderRouteIn } from '$lib/route/routeList';
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

	it('reorderRouteIn moves a route and keeps the active id', () => {
		const r = reorderRouteIn(base, 0, 2);
		expect(r.list.map((x) => x.id)).toEqual(['b', 'c', 'a']);
		expect(r.activeId).toBe('b');
	});

	it('reorderRouteIn is a no-op (same ref) for same / out-of-range indices', () => {
		expect(reorderRouteIn(base, 1, 1)).toBe(base);
		expect(reorderRouteIn(base, -1, 0)).toBe(base);
		expect(reorderRouteIn(base, 5, 0)).toBe(base);
	});

	it('reorderRouteIn clamps an out-of-range destination', () => {
		expect(reorderRouteIn(base, 0, 99).list.map((x) => x.id)).toEqual(['b', 'c', 'a']);
	});
});
