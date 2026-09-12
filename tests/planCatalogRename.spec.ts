/* The catalog's rename (state/activePlan.renamePlan). A plan's descriptive
 * name lives in its FILE, so renaming rewrites the stored yaml, and what the
 * pins here are about is everything it must NOT disturb: the entry's stamp
 * (the Stored column, the listing order and the Store conflict check all read
 * it), a row that is no longer there (putStoredPlan is an upsert), and the
 * workspace's own dirty state, since the name is pinned out of planSig.
 *
 * Each case builds a fresh module graph (vi.resetModules + dynamic import)
 * over a fresh fake IndexedDB, the tests/routeRestore.spec.ts harness;
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
	// enough, the plan being free points.
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

describe('renaming a catalog entry', () => {
	it('rewrites the stored file and keeps its stamp', async () => {
		const { plan, db } = await mods();
		await db.putStoredPlan({ id: 'p1', yaml: PLAN, savedAtMs: 1000 });
		expect(await plan.renamePlan('p1', 'Nav examen')).toEqual({ kind: 'renamed' });
		const row = (await db.getStoredPlans())[0];
		// The stamp answers "did my store land?", the listing sorts on it and
		// the conflict check reads it: a rename is not a store.
		expect(row.savedAtMs).toBe(1000);
		expect(row.yaml).toContain('name: Nav examen');
		// Everything else in the file is untouched.
		expect(row.yaml).toContain('      - name: ALPHA');
		expect(await plan.renamePlan('p1', '')).toEqual({ kind: 'renamed' });
		expect((await db.getStoredPlans())[0].yaml).toBe(PLAN);
	});

	it('writes nothing for a row that is no longer there', async () => {
		const { plan, db } = await mods();
		// putStoredPlan is an upsert, so a rename racing a delete would put the
		// row back rather than fail.
		expect(await plan.renamePlan('gone', 'X')).toEqual({ kind: 'aborted' });
		expect(await db.getStoredPlans()).toEqual([]);
	});

	it('follows the workspace when the row is the active plan, and leaves it clean', async () => {
		const { plan, route, load, db } = await mods();
		await db.putStoredPlan({ id: 'p1', yaml: PLAN, savedAtMs: 1000 });
		expect(await load.loadRoutesFromYaml(PLAN, { id: 'p1', savedAtMs: 1000 })).toBe(true);
		expect(plan.activePlanDirty()).toBe(false);
		const sig = plan.planSig();
		await plan.renamePlan('p1', 'Nav examen');
		expect(route.routes.planName).toBe('Nav examen');
		// The name is PINNED OUT of the signature (both halves were written in
		// one action), so a clean plan stays clean and nothing is re-baselined.
		expect(plan.planSig()).toBe(sig);
		expect(plan.activePlanDirty()).toBe(false);
		// It does reach the file the workspace would write.
		expect(plan.leanWorkspaceYaml()).toContain('name: Nav examen');
	});

	it('neither hides nor forgives unstored edits', async () => {
		const { plan, route, load, db } = await mods();
		await db.putStoredPlan({ id: 'p1', yaml: PLAN, savedAtMs: 1000 });
		await load.loadRoutesFromYaml(PLAN, { id: 'p1', savedAtMs: 1000 });
		route.addWaypoint(48.7, 2.7);
		expect(plan.activePlanDirty()).toBe(true);
		await plan.renamePlan('p1', 'Nav examen');
		expect(plan.activePlanDirty()).toBe(true);
		// Undoing the edit returns the workspace to the stored content: the
		// rename must not have moved the baseline under it.
		route.undoRoute();
		expect(plan.activePlanDirty()).toBe(false);
	});

	it('leaves the workspace alone when another row is renamed', async () => {
		const { plan, route, load, db } = await mods();
		await db.putStoredPlan({ id: 'p1', yaml: PLAN, savedAtMs: 1000 });
		await db.putStoredPlan({ id: 'p2', yaml: PLAN, savedAtMs: 2000 });
		await load.loadRoutesFromYaml(PLAN, { id: 'p1', savedAtMs: 1000 });
		await plan.renamePlan('p2', 'Sortie plage');
		expect(route.routes.planName).toBeNull();
		expect(plan.activePlanDirty()).toBe(false);
	});
});
