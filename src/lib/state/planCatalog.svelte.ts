/* The Plans view's listing state: the remembered route files (the plan
 * catalog, flightsDb `plans` store) derived through planRows AS THE
 * MATCHER READS THEM against current data. The derivation cache is a
 * plain module Map keyed by the entry's own id, hit only on
 * byte-identical yaml and populated only while BOTH datasets are loaded:
 * an offline "no usable route" verdict must not pin for the session
 * after the data arrives. The re-entrancy guard is a plain module let
 * (the refreshList doctrine); `loading` stays display-only. */

import { dataState, ensureAirports, ensureNavaids } from './data.svelte';
import { deleteStoredPlan, getStoredPlans } from './flightsDb';
import { derivePlanRow, type PlanRow } from './planRows';
import { resolveWaypointToken } from './waypointSearch.svelte';

export interface PlanListRow extends PlanRow {
	/** The opaque store key; the row's shown identity is its name over its
	 *  route, never this. */
	id: string;
	yaml: string;
	savedAtMs: number;
}

export const planCatalog = $state<{
	/** The listed catalog, saved-at descending. */
	rows: PlanListRow[];
	loaded: boolean;
	loading: boolean;
}>({ rows: [], loaded: false, loading: false });

/** Non-reactive in-flight guard (plain let on purpose, see header); a
 *  refresh requested while one runs is remembered and runs ONCE more
 *  when it finishes, so a store landing during the open effect's
 *  dataset await still reaches the listed rows (the Saved column must
 *  not lie until the next surface open). */
let listing = false;
let rerun = false;

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local cache, not state
const derived = new Map<string, { yaml: string; row: PlanRow }>();

/** List the catalog (the Plans view's open effect). */
export async function refreshPlans(): Promise<void> {
	if (listing) {
		rerun = true;
		return;
	}
	listing = true;
	planCatalog.loading = true;
	try {
		do {
			rerun = false;
			await listOnce();
		} while (rerun);
	} finally {
		planCatalog.loading = false;
		listing = false;
	}
}

async function listOnce(): Promise<void> {
	try {
		await Promise.all([ensureAirports(), ensureNavaids()]);
	} catch {
		/* derive against whatever loaded; verdicts stay uncached below */
	}
	const stored = await getStoredPlans();
	const cacheable = dataState.airportsLoaded && dataState.navaidsLoaded;
	const rows: PlanListRow[] = stored.map((p) => {
		const hit = derived.get(p.id);
		if (hit && hit.yaml === p.yaml) {
			return { id: p.id, yaml: p.yaml, savedAtMs: p.savedAtMs, ...hit.row };
		}
		const row = derivePlanRow(p.yaml, resolveWaypointToken);
		if (cacheable) {
			derived.set(p.id, { yaml: p.yaml, row });
		}
		return { id: p.id, yaml: p.yaml, savedAtMs: p.savedAtMs, ...row };
	});
	rows.sort((a, b) => b.savedAtMs - a.savedAtMs);
	planCatalog.rows = rows;
	planCatalog.loaded = true;
}

/** Forget one remembered plan. Failures degrade silently: the row stays
 *  listed and the next attempt retries. Recorded flights are never
 *  touched: their traces stay stored and the ones linked to this entry
 *  DETACH on the next link pass, the link being purely dynamic.
 *
 *  The WORKSPACE's provenance is the caller's to release
 *  (`detachFromPlan`, activePlan.svelte.ts): this module owns the
 *  listing, not the active plan, and importing that one here would close
 *  a cycle back through it. */
export async function removeStoredPlan(id: string): Promise<void> {
	try {
		await deleteStoredPlan(id);
	} catch {
		return;
	}
	derived.delete(id);
	planCatalog.rows = planCatalog.rows.filter((r) => r.id !== id);
}
