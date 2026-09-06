/* When the store-back action is OFFERED (state/activePlan.canStorePlan), the
 * one predicate the route-actions menu row and the catalog row's own button
 * share. A greyed control is a claim, "storing would change nothing", so what
 * the pins here are about is the claim being true: an untouched plan offers
 * nothing, an edit brings it back, undoing takes it away again (the signature
 * is content, not a flag), a store re-baselines, and a LOSSY activation keeps
 * it live with no edit at all, the workspace already differing from the fuller
 * original it was cut from.
 *
 * Each case builds a fresh module graph (vi.resetModules + dynamic import)
 * over a fresh fake IndexedDB, the tests/planCatalogRename.spec.ts harness;
 * localStorage is stubbed because vitest runs in a node environment.
 * Contract: docs/flights-library.md. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

/** One two-leg route of FREE points, so no dataset has to resolve anything. */
const PLAN = [
	'version: 1',
	'routes:',
	'  - waypoints:',
	'      - name: ALPHA',
	'        lat: 48.5',
	'        lon: 2.5',
	'      - name: BRAVO',
	'        lat: 49',
	'        lon: 3',
	'',
].join('\n');

/** The same, plus a third waypoint anchored to an ident nothing can resolve
 *  here (the datasets are stubbed empty): it is DROPPED on load, which is
 *  what makes the activation lossy while the two free points survive. */
const PLAN_WITH_IDENT = [
	'version: 1',
	'routes:',
	'  - waypoints:',
	'      - name: ALPHA',
	'        lat: 48.5',
	'        lon: 2.5',
	'      - name: BRAVO',
	'        lat: 49',
	'        lon: 3',
	'      - ident: LFPL',
	'',
].join('\n');

let store: Map<string, string>;

beforeEach(() => {
	store = new Map<string, string>();
	globalThis.indexedDB = new IDBFactory();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
	vi.stubGlobal('location', { search: '' });
	vi.resetModules();

	// The load's two awaits and the catalog listing's own: empty datasets are
	// enough, the plan being free points (and are what drops the ident above).
	vi.doMock('$lib/state/data.svelte', async () => {
		const actual =
			await vi.importActual<typeof import('$lib/state/data.svelte')>('$lib/state/data.svelte');
		return { ...actual, ensureAirports: () => Promise.resolve([]), ensureNavaids: () => Promise.resolve([]) };
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.doUnmock('$lib/state/data.svelte');
});

async function mods(): Promise<{
	plan: typeof import('$lib/state/activePlan.svelte');
	route: typeof import('$lib/state/route.svelte');
	load: typeof import('$lib/state/routeLoad.svelte');
	db: typeof import('$lib/state/flightsDb');
}> {
	return {
		plan: await import('$lib/state/activePlan.svelte'),
		route: await import('$lib/state/route.svelte'),
		load: await import('$lib/state/routeLoad.svelte'),
		db: await import('$lib/state/flightsDb'),
	};
}

describe('offering the store-back action', () => {
	it('offers nothing for a workspace that is not a catalog plan', async () => {
		const { plan, route } = await mods();
		route.addWaypoint(48.5, 2.5);
		route.addWaypoint(49, 3);
		// A scratch workspace is not dirty, it is simply not a plan yet: Store
		// as new is what it gets offered, and that button reads the floor
		// below directly.
		expect(plan.canStorePlan()).toBe(false);
		expect(plan.hasStorableWorkspace()).toBe(true);
	});

	it('offers nothing straight after an activation, and everything after an edit', async () => {
		const { plan, route, load, db } = await mods();
		await db.putStoredPlan({ id: 'p1', yaml: PLAN, savedAtMs: 1000 });
		expect(await load.loadRoutesFromYaml(PLAN, { id: 'p1', savedAtMs: 1000 })).toBe(true);
		// The workspace IS the entry: storing would only re-date the row.
		expect(plan.canStorePlan()).toBe(false);
		route.addWaypoint(48.7, 2.7);
		expect(plan.canStorePlan()).toBe(true);
		// Undo returns the workspace to the stored content, and the answer with
		// it: the baseline is a content signature, not a touched flag.
		route.undoRoute();
		expect(plan.canStorePlan()).toBe(false);
	});

	it('stops offering once the plan is stored', async () => {
		const { plan, route } = await mods();
		route.addWaypoint(48.5, 2.5);
		route.addWaypoint(49, 3);
		// storeFlownPlan is the synchronous store (the archive hook's); the
		// pilot's own Store takes the same re-baselining path through a rich
		// build this environment has no network for.
		expect(await plan.storeFlownPlan()).toEqual({ kind: 'stored' });
		expect(plan.activePlan.source).not.toBeNull();
		expect(plan.canStorePlan()).toBe(false);
	});

	it('keeps offering after a lossy activation, with no edit at all', async () => {
		const { plan, route, load, db } = await mods();
		await db.putStoredPlan({ id: 'p1', yaml: PLAN_WITH_IDENT, savedAtMs: 1000 });
		expect(await load.loadRoutesFromYaml(PLAN_WITH_IDENT, { id: 'p1', savedAtMs: 1000 })).toBe(
			true,
		);
		expect(plan.activePlan.source?.lossy).toBe(true);
		expect(route.routes.list[0].waypoints).toHaveLength(2);
		// Clean by the signature, and yet the entry holds a waypoint this
		// workspace does not: greying here would claim storing changes
		// nothing, and it would take the deliberate collapse (storeLossyConfirm)
		// away with it.
		expect(plan.activePlanDirty()).toBe(false);
		expect(plan.canStorePlan()).toBe(true);
	});

	it('offers nothing once the workspace no longer holds a route', async () => {
		const { plan, route, load, db } = await mods();
		await db.putStoredPlan({ id: 'p1', yaml: PLAN, savedAtMs: 1000 });
		await load.loadRoutesFromYaml(PLAN, { id: 'p1', savedAtMs: 1000 });
		const first = route.routes.list[0].waypoints[0];
		route.removeWaypoint(first.id);
		// Edited, so dirty; but one point is not a plan worth writing over an
		// entry, the same floor every Store applies.
		expect(plan.activePlanDirty()).toBe(true);
		expect(plan.canStorePlan()).toBe(false);
	});
});
