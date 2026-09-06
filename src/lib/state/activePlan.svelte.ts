/* The ACTIVE FLIGHT PLAN's provenance, the Garmin model
 * (docs/flights-library.md, "The plan-editing loop"): the route
 * workspace is 'flight plan 00' (GNS 430 Pilot's Guide, Section 5), the
 * flights DB's `plans` store the Flight Plan Catalog. Activating a
 * stored plan COPIES it into the workspace and records where it came
 * from here; the stored copy stays intact until an explicit Store
 * writes the workspace back. This module owns only the provenance and
 * the signatures; the load side sets it (state/routeLoad.svelte.ts,
 * the workspace-replacing chokepoint) and the persist doc round-trips
 * it (state/routePersist.ts). Import direction is one-way ON PURPOSE:
 * routeLoad / routePersist / the components import this module, and
 * this module never imports them (the PRISTINE_SIG cycle).
 *
 * The dirty signature is NORMALIZED: auto-levelled legs serialize at a
 * fixed altitude, because MapView's always-mounted effect re-levels
 * every altAuto leg right after a load (applyAutoAltitudes, keyed on
 * the session-only default altitude and the late airspace / terrain
 * arrivals), so a raw signature would read dirty with zero user edits
 * and the activate guard would cry wolf on every switch. The
 * flight-prep block IS in the signature: its inputs save into the file,
 * so editing them edits the plan. */

import { perfIcaos } from '$lib/aircraft/aerodromes';
import { orderedTrips } from '$lib/aircraft/trips';
import { buildSaveRoutes } from '$lib/route/navlogExport';
import {
	buildRoutesDoc,
	stringifyRoutesDoc,
	withPlanName,
	type RouteForSave,
} from '$lib/route/yaml';
import { effectiveCruiseSpeedKt } from './aircraft.svelte';
import { buildFlightPrepForSave, flightPrep } from './flightPrep.svelte';
import { getStoredPlans, newPlanId, putStoredPlan } from './flightsDb';
import { djb2 } from './hash';
import { refreshPlans } from './planCatalog.svelte';
import { routes, routeSettings, setPlanName } from './route.svelte';
import { windAloft } from './windAloft.svelte';

/** Where the workspace came from: the catalog entry activated into it. */
export interface ActivePlanSource {
	/** The stored plan's opaque id (the `plans` store key; the identity
	 *  the UI shows is the route, never a name). */
	id: string;
	/** The entry's stamp AT ACTIVATION: the Store conflict check. */
	savedAtMs: number;
	/** planSig() right after the load settled: the dirty baseline.
	 *  Persisted verbatim, so pre-reload dirtiness survives a reload. */
	sig: string;
	/** The activation lost waypoints or routes against current data
	 *  (AIRAC drift, truncation): Store must warn before overwriting
	 *  the fuller original. */
	lossy: boolean;
}

export const activePlan = $state<{ source: ActivePlanSource | null }>({ source: null });

export function setActivePlanSource(source: ActivePlanSource | null): void {
	activePlan.source = source;
}

/** Release the provenance when the entry it points at is being deleted.
 *  The workspace keeps its routes; only the Store target goes. Without
 *  this the pointer outlives its target, and since `storePlan` reads a
 *  MISSING row as "no conflict" it would put the entry straight back:
 *  Delete then Store would silently un-delete. Called by the delete
 *  action rather than by the catalog module, which owns the listing and
 *  must not import this one back. */
export function detachFromPlan(id: string): void {
	if (activePlan.source?.id === id) {
		setActivePlanSource(null);
	}
}

/** The settings block a route FILE carries (the lean and rich builders
 *  share it; the planning subset outside the grammar stays in
 *  routePersist's own `settings`). */
export function workspaceSettingsBlock(): {
	vfr: boolean;
	semicircular: boolean;
	transitionAltitudeFt: number | null;
	windForecast: boolean;
	temperatureTas: boolean;
} {
	return {
		vfr: routeSettings.vfr,
		semicircular: routeSettings.semicircular,
		transitionAltitudeFt: routeSettings.transitionAltitudeFt,
		windForecast: windAloft.useForecastForLegs,
		temperatureTas: windAloft.tempTas,
	};
}

/** Snapshot the workspace as the route-file grammar over the LEAN
 *  waypoints (no legs / info: buildSaveRoutes awaits datasets and winds
 *  for a nav-log snapshot the loader ignores anyway; a Waypoint is
 *  structurally a SaveWaypoint). Moved from routePersist.currentDoc,
 *  which imports it back: reading every serialized field through the
 *  $state proxies is the callers' deep tracking. */
export function leanWorkspaceYaml(): string {
	const lean: RouteForSave[] = routes.list.map((r) => ({
		name: r.name,
		waypoints: r.waypoints,
		alternate: r.alternate,
	}));
	return stringifyRoutesDoc(buildRoutesDoc(lean, undefined, workspaceSettingsBlock(), routes.planName));
}

/** The DURABLE serialization: everything a load reads, built without a
 *  single await. The lean routes plus the flight-prep block, which is the
 *  difference from leanWorkspaceYaml above and the reason this exists
 *  separately.
 *
 *  This is what an automatic store writes, where the pilot's own Store
 *  button writes the RICH form (buildWorkspaceFileYaml). The rich form
 *  goes through buildSaveRoutes, whose dataset warms, per-route forecast
 *  wind fetch and terrain scan make it a seconds-long NETWORK operation
 *  that rejects when offline: exactly what an aeroplane parked on the
 *  apron with the engine just shut down cannot supply. What the rich form
 *  adds is the nav-log snapshot (legs / info), which the file format
 *  itself declares saved-only and the loader ignores, so nothing a reload
 *  needs is missing here. A later manual Store upgrades the entry. */
export function durableWorkspaceYaml(): string {
	const lean: RouteForSave[] = routes.list.map((r) => ({
		name: r.name,
		waypoints: r.waypoints,
		alternate: r.alternate,
	}));
	const trips = orderedTrips(routes.list);
	const fp = buildFlightPrepForSave(trips.length, perfIcaos(trips, flightPrep.perf.manualIcaos));
	return stringifyRoutesDoc(buildRoutesDoc(lean, fp, workspaceSettingsBlock(), routes.planName));
}

/** Whether the workspace holds a plan worth remembering: one route that
 *  actually goes somewhere. THE floor under every Store, the automatic one
 *  included (it has no disabled state to hide behind), and under the
 *  Store-as buttons, which read it directly. */
export function hasStorableWorkspace(): boolean {
	return routes.list.some((r) => r.waypoints.length >= 2);
}

/** The workspace's content signature for the dirty comparison: the lean
 *  yaml with every altAuto leg's altitude PINNED (see the header), plus
 *  the flight-prep block (sync and write-free by its own doctrine).
 *  Reads the workspace deep, so calling it inside a $derived tracks. */
export function planSig(): string {
	const normalized: RouteForSave[] = routes.list.map((r) => ({
		name: r.name,
		waypoints: r.waypoints.map((w) => (w.altAuto ? { ...w, alt: 0 } : w)),
		alternate: r.alternate,
	}));
	// The plan NAME is pinned out, the altAuto reasoning one field over: the
	// catalog rename writes the stored row and the workspace in one action, so
	// the name can never be what distinguishes them, and hashing it would leave
	// a baseline that says "dirty" for ever after a rename over unstored edits.
	const yaml = stringifyRoutesDoc(buildRoutesDoc(normalized, undefined, workspaceSettingsBlock(), null));
	const trips = orderedTrips(routes.list);
	const fp = buildFlightPrepForSave(trips.length, perfIcaos(trips, flightPrep.perf.manualIcaos));
	return djb2(`${yaml}\u0000${JSON.stringify(fp ?? null)}`);
}

/** Whether the workspace differs from the plan it was activated from.
 *  False without provenance: a scratch workspace is not "dirty", it is
 *  simply not a catalog plan yet. */
export function activePlanDirty(): boolean {
	const src = activePlan.source;
	return src != null && planSig() !== src.sig;
}

/** Whether the store-back action has anything to write: the workspace is a
 *  catalog plan, holds a route worth storing, and DIFFERS from the entry it
 *  came from. THE definition the offering surfaces share (the route-actions
 *  menu row, the catalog row's own button), so the two cannot disagree about
 *  whether Store is available.
 *
 *  A greyed control is a CLAIM, here "storing would change nothing", and it
 *  must not lie. That is why `lossy` keeps it live: a copy that lost
 *  waypoints against current data already differs from the fuller original
 *  with no edit at all, and collapsing the entry onto it deliberately is
 *  exactly what `storeLossyConfirm` is for. It is read first, being the
 *  cheap half and the one the signature cannot see.
 *
 *  What it does NOT claim is byte equality: Store writes the rich
 *  serialization (nav-log snapshot, per-leg winds, frequencies) while the
 *  signature hashes the lean one, so a clean store would still refresh those
 *  saved-only fields. The loader ignores them and every download builds them
 *  fresh, so "no changes since you activated this plan" is the honest
 *  meaning, and `storePlanTip` says exactly that. */
export function canStorePlan(): boolean {
	const src = activePlan.source;
	return src != null && hasStorableWorkspace() && (src.lossy || activePlanDirty());
}

/** The RICH file serialization, the Save button's own recipe extracted
 *  (byte-identical: same builders, same settings block): legs / info
 *  nav-log snapshot via buildSaveRoutes (awaits dataset and wind
 *  warms), the flight-prep block, the file grammar. What Store writes
 *  into the catalog IS a route file. */
export async function buildWorkspaceFileYaml(): Promise<string> {
	const saveRoutes = await buildSaveRoutes(routes.list, {
		...routeSettings,
		cruiseSpeedKt: effectiveCruiseSpeedKt(),
	});
	const trips = orderedTrips(routes.list);
	const fp = buildFlightPrepForSave(trips.length, perfIcaos(trips, flightPrep.perf.manualIcaos));
	return stringifyRoutesDoc(buildRoutesDoc(saveRoutes, fp, workspaceSettingsBlock(), routes.planName));
}

export type StoreOutcome =
	| { kind: 'stored' }
	/** The catalog entry changed since activation (a re-import): nothing
	 *  written; the caller confirms and retries with force. */
	| { kind: 'conflict' }
	/** The workspace was replaced or the provenance moved while the rich
	 *  build awaited (another activation, clear-all): a mixed document
	 *  must never be written under the old name. Also the re-entry no-op. */
	| { kind: 'aborted' }
	| { kind: 'failed'; detail: string };

// Non-reactive in-flight guard (the flightImport idiom); the caller
// keeps its own $state for the disabled look.
let storing = false;

/** Take the store guard for a NON-store writer of the plans catalog
 *  (the sync applier: docs/accounts-sync.md). The applier cannot live
 *  in this module (activePlan -> flightLinks -> flightLibrary ->
 *  activePlan would cycle), yet it must serialize with the four store
 *  paths or it could land between storePlan's read and its put.
 *  Returns the release, or null while a store runs (the applier skips
 *  and retries next pass). */
export function acquirePlanStoring(): (() => void) | null {
	if (storing) {
		return null;
	}
	storing = true;
	return () => {
		storing = false;
	};
}

/** Store the active flight plan back over its catalog entry (the G1000
 *  'Store Flight Plan'; the GNS 430 catalog-editing semantic carried
 *  through flight plan 00). The conflict check runs BEFORE the
 *  expensive build and again just before the put, shrinking the window
 *  against a concurrent import to a tick; between two explicit user
 *  actions, last write wins by design. On success the entry is exactly
 *  the workspace, so the provenance re-baselines and `lossy` clears. */
export async function storePlan(opts: { force?: boolean } = {}): Promise<StoreOutcome> {
	const src = activePlan.source;
	if (storing || !src) {
		return { kind: 'aborted' };
	}
	storing = true;
	const listRef = routes.list;
	// The workspace's CONTENT signature at the instant the build starts. The
	// two reference checks below cannot see an in-place edit (a waypoint drag,
	// an inserted point and an altitude change all mutate routes.list[i]
	// without reassigning routes.list), and the build awaits the dataset and
	// wind warms, which is seconds. Storing the pre-edit yaml while
	// re-baselining on the post-edit workspace would grey out "Store flight
	// plan" over an entry that does not contain the edit: the edit would be
	// silently unstored. planSig PINS every altAuto altitude, so the
	// re-levelling effect cannot make this abort spuriously.
	const sigBefore = planSig();
	try {
		if (!opts.force) {
			const row = (await getStoredPlans()).find((p) => p.id === src.id);
			if (row && row.savedAtMs !== src.savedAtMs) {
				return { kind: 'conflict' };
			}
		}
		const yaml = await buildWorkspaceFileYaml();
		// loadRoutes and clearAllRoutes reassign routes.list wholesale, and
		// every provenance write replaces the source object: reference
		// inequality on either is the torn-write detector, and the signature
		// covers what neither reference can see.
		if (routes.list !== listRef || activePlan.source !== src || planSig() !== sigBefore) {
			return { kind: 'aborted' };
		}
		const row = (await getStoredPlans()).find((p) => p.id === src.id);
		if (!opts.force && row && row.savedAtMs !== src.savedAtMs) {
			return { kind: 'conflict' };
		}
		const savedAtMs = Date.now();
		await putStoredPlan({ id: src.id, yaml, savedAtMs });
		setActivePlanSource({ id: src.id, savedAtMs, sig: sigBefore, lossy: false });
		void refreshPlans();
		return { kind: 'stored' };
	} catch (err) {
		return { kind: 'failed', detail: err instanceof Error ? err.message : String(err) };
	} finally {
		storing = false;
	}
}

/** Store the active flight plan as a NEW catalog entry (the GNS 430
 *  'Copy Flight Plan?' to an open location). The entry's shown identity
 *  is its route (the manual's first-and-last-waypoints comment rule,
 *  derived at listing); the minted id only addresses it. The provenance
 *  moves to the new entry: the workspace now IS that plan. */
/** What a rename did, on the StoreOutcome model: nothing was written
 *  (`aborted`), the row now carries the name (`renamed`), or the store refused
 *  and the caller must say so (`failed`). */
export type RenameOutcome =
	| { kind: 'renamed' }
	| { kind: 'aborted' }
	| { kind: 'failed'; detail: string };

/** Name a catalog entry (the Plans view's action; there is no workspace-side
 *  rename by decision). A plan's descriptive name lives in the FILE, so this
 *  rewrites the stored yaml SURGICALLY: parse-and-rebuild would drop the
 *  saved-only nav-log snapshot out of a document the user may have downloaded
 *  and an external tool may read.
 *
 *  Three things it must not do. It must not run beside a store, so it shares
 *  the `storing` guard: a rename landing between storePlan's read and its put
 *  would write the pre-store yaml back over the fresh one AND leave the row's
 *  stamp mismatched, so the next Store would cry conflict. It must not
 *  resurrect a row deleted meanwhile, putStoredPlan being an upsert. And it
 *  must not touch `savedAtMs`: a rename is not a store, the Stored column
 *  answers "did my store land?", the listing sorts on it, and the conflict
 *  check reads that very stamp.
 *
 *  When the renamed row IS the active plan the workspace follows it, so the
 *  next Store writes the new name instead of reverting it. Nothing is
 *  re-baselined: planSig pins the name out exactly so that a rename is neither
 *  an edit of its own nor an absolution of the edits already there. */
export async function renamePlan(id: string, name: string | null): Promise<RenameOutcome> {
	if (storing) {
		return { kind: 'aborted' };
	}
	storing = true;
	try {
		const row = (await getStoredPlans()).find((p) => p.id === id);
		if (!row) {
			return { kind: 'aborted' };
		}
		const yaml = withPlanName(row.yaml, name);
		if (yaml !== row.yaml) {
			await putStoredPlan({ id, yaml, savedAtMs: row.savedAtMs });
		}
		if (activePlan.source?.id === id) {
			setPlanName(name);
		}
		void refreshPlans();
		return { kind: 'renamed' };
	} catch (err) {
		return { kind: 'failed', detail: err instanceof Error ? err.message : String(err) };
	} finally {
		storing = false;
	}
}

/** Keep the plan that was just FLOWN, so the flight can find it.
 *
 *  An outing files itself the moment a recording settles; the plan it was
 *  flown with reached the catalog only if the pilot remembered to Store
 *  it, and since the trace->plan link is computed against the CATALOG, a
 *  plan that never got there could never be linked to its own flight
 *  (docs/flights-library.md counts four such flights in the real
 *  back-catalog). Flying a plan is evidence enough that it is not
 *  scratch, so this is the second way in beside the Store button.
 *
 *  Deliberately NOT storePlanAs: that one is a user action and takes the
 *  slow rich path over the network (see durableWorkspaceYaml). This is
 *  synchronous up to one IndexedDB put, so the archive hook that calls it
 *  fire-and-forget stays as fast as it was, and it works with no signal.
 *
 *  Idempotent across repeat flights: storing sets the provenance, and the
 *  provenance is what this refuses to run over, so the same plan flown
 *  again on Sunday finds itself already in the catalog. Refuses in three
 *  cases, all silently: the workspace is already a catalog plan (there is
 *  nothing to add), it holds no route worth keeping, or another store is
 *  in flight (the shared guard, so the pilot's own tap always wins). */
export async function storeFlownPlan(): Promise<StoreOutcome> {
	if (storing || activePlan.source !== null || !hasStorableWorkspace()) {
		return { kind: 'aborted' };
	}
	storing = true;
	try {
		// No await before the build, so no torn-write check is needed: the
		// yaml and the signature are taken from one synchronous read of the
		// workspace, which is the same posture the archive hook itself takes.
		const yaml = durableWorkspaceYaml();
		const sig = planSig();
		const id = newPlanId();
		const savedAtMs = Date.now();
		await putStoredPlan({ id, yaml, savedAtMs });
		setActivePlanSource({ id, savedAtMs, sig, lossy: false });
		void refreshPlans();
		return { kind: 'stored' };
	} catch (err) {
		return { kind: 'failed', detail: err instanceof Error ? err.message : String(err) };
	} finally {
		storing = false;
	}
}

export async function storePlanAs(): Promise<StoreOutcome> {
	if (storing) {
		return { kind: 'aborted' };
	}
	storing = true;
	const listRef = routes.list;
	// Same torn-write reasoning as storePlan: the signature is what catches
	// an in-place edit across the build's awaits.
	const sigBefore = planSig();
	try {
		const yaml = await buildWorkspaceFileYaml();
		if (routes.list !== listRef || planSig() !== sigBefore) {
			return { kind: 'aborted' };
		}
		const id = newPlanId();
		const savedAtMs = Date.now();
		await putStoredPlan({ id, yaml, savedAtMs });
		setActivePlanSource({ id, savedAtMs, sig: sigBefore, lossy: false });
		void refreshPlans();
		return { kind: 'stored' };
	} catch (err) {
		return { kind: 'failed', detail: err instanceof Error ? err.message : String(err) };
	} finally {
		storing = false;
	}
}
