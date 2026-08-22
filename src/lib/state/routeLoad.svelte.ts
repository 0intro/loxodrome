/* Loading a route file, and what the load has to say about it.
 *
 * Two entry points share this: the Route tab's own picker and the
 * incoming-file dispatcher (an Android VIEW / SEND intent, the ?file= boot
 * parameter, state/openFile.svelte.ts). The recipe is the same either way, so
 * it lives here once, and the OUTCOME lives with it: the Route tab renders it
 * whichever entry point produced it, which is how a file opened from the
 * system still reports its dropped waypoints in the place the user looks.
 *
 * The outcome is stored as DATA and worded at render (docs/i18n.md rule 7);
 * the error line is the upstream parser message, English by recorded decision.
 *
 * The boot restore (state/routePersist.ts) deliberately keeps its own copy of
 * the sequence: its pristine-signature guards around the dataset await are
 * load-bearing. What both share is `loadRoutes`, the workspace-replacing
 * chokepoint, and now this module's outcome: the restore reports its dropped
 * waypoints through the same `notice` a file load uses, and its own refusals
 * through `restore` below. routePersist is a plain .ts module and cannot hold
 * $state of its own, so this is where its outcome lives; the import direction
 * is routePersist -> here, never back.
 */

import { perfIcaos } from '$lib/aircraft/aerodromes';
import { orderedTrips } from '$lib/aircraft/trips';
import { parseRoutesDoc } from '$lib/route/yaml';
import { planSig, setActivePlanSource } from '$lib/state/activePlan.svelte';
import { getStoredPlans } from '$lib/state/flightsDb';
import { ensureAirports, ensureNavaids } from '$lib/state/data.svelte';
import { applyLoadedFlightPrep } from '$lib/state/flightPrep.svelte';
import { loadRoutes, routes } from '$lib/state/route.svelte';
import { resolveWaypointToken } from '$lib/state/waypointSearch.svelte';

export interface RouteLoadNotice {
	truncated: boolean;
	reconstructed: string[];
	dropped: string[];
	unknownAircraft: string | null;
}

/** Why the boot restore left a stored workspace unapplied. A CODE, worded
 *  at render like every other outcome here:
 *  - `data`: the airport / navaid fetches did not resolve, and loadRoutes
 *    silently drops what it cannot resolve, so restoring would mutilate the
 *    plan. Retriable, and retried by itself when the datasets arrive.
 *  - `lossy`: they did resolve, but the plan came back short (the coverage
 *    gate is the map viewport at boot, so a route whose navaids lie
 *    elsewhere loses them). Retriable as the gate widens.
 *  - `parse`: the stored yaml no longer parses. Not retriable.
 *  - `superseded`: the user has a workspace of their own, from an incoming
 *    file or from planning done while the restore ran. Not an error and not
 *    a hold: theirs keeps persisting and the plan it displaced is deposited
 *    in the catalog at once, which is all this reports.
 *  Null means nothing is pending: restored, or nothing was stored. */
export type RouteRestoreReason = 'data' | 'lossy' | 'parse' | 'superseded';

/** How far the pending plan has travelled.
 *  - `held`: the stored doc is unapplied and protected in place; the
 *    Restore-it button's state.
 *  - `sheltered`: the first edit (or a displacement) moved it to the
 *    synchronous localStorage aside. The catalog copy is on its way, or
 *    waits for the next boot's outbox pass if IndexedDB refused, and the
 *    line says so instead of keeping the hold's failure sentence beside a
 *    button that no longer does anything.
 *  - `rescued`: it is in the flight plan catalog, one Activate away. */
export type RouteRestoreStage = 'held' | 'sheltered' | 'rescued';

export const routeLoad = $state<{
	/** Raw upstream error text (untranslated detail line, docs/i18n.md rule 7). */
	error: string;
	notice: RouteLoadNotice | null;
	/** The stored workspace that is still waiting, why, and how far its
	 *  rescue has travelled (`RouteRestoreStage`). */
	restore: { reason: RouteRestoreReason; stage: RouteRestoreStage } | null;
}>({ error: '', notice: null, restore: null });

export function clearRouteLoadOutcome(): void {
	routeLoad.error = '';
	routeLoad.notice = null;
}

/** Publish (or clear) the boot restore's outcome. Called only by
 *  state/routePersist.ts, which owns the decision. */
export function setRouteRestoreOutcome(reason: RouteRestoreReason | null): void {
	if (reason === null) {
		routeLoad.restore = null;
		return;
	}
	// Idempotent on the reason: a retry that re-holds for the same cause must
	// not reset a stage the user is reading.
	if (routeLoad.restore?.reason !== reason) {
		routeLoad.restore = { reason, stage: 'held' };
	}
}

/** Clear a hold's outcome WITHOUT touching a `rescued` receipt: the restore
 *  success tail calls this, and an outbox deposit landing during that very
 *  restore's dataset await must keep its "it is in the catalog" line on the
 *  one boot meant to show it. The reset path keeps the unconditional wipe
 *  through setRouteRestoreOutcome(null). */
export function clearRouteRestoreHold(): void {
	if (routeLoad.restore && routeLoad.restore.stage !== 'rescued') {
		routeLoad.restore = null;
	}
}

/** The pending plan reached the synchronous shelter: from here it survives
 *  the tab dying, and the catalog copy is in flight. Called by the rescue
 *  and the displacement right after their writeItem. */
export function markRouteRestoreSheltered(): void {
	if (routeLoad.restore?.stage === 'held') {
		routeLoad.restore.stage = 'sheltered';
	}
}

/** The pending plan is in the flight plan catalog. Only ever upgrades a
 *  `sheltered` object: upgrading a `held` one would let LAST session's
 *  outbox deposit, landing at boot, flip the text and hide the Restore-it
 *  button of a NEW hold protecting a different plan. With no outcome
 *  standing at all (that same boot-drain, nothing held this session), it
 *  sets the receipt that fulfils last session's "at the next start". */
export function markRouteRestoreRescued(): void {
	if (routeLoad.restore === null) {
		routeLoad.restore = { reason: 'superseded', stage: 'rescued' };
		return;
	}
	if (routeLoad.restore.stage === 'sheltered') {
		routeLoad.restore.stage = 'rescued';
	}
}

/** Publish what a `loadRoutes` call had to drop or reshape. Shared by the
 *  file load below and the boot restore, which used to discard the same
 *  three fields: a plan restored MINUS two waypoints the current AIRAC no
 *  longer publishes has to say so, exactly as a file load does. */
export function setRouteLoadNotice(
	result: { dropped: string[]; truncated: boolean; reconstructed: string[] },
	unknownAircraft: string | null,
): void {
	routeLoad.notice = {
		truncated: result.truncated,
		// Throwaway dedupers: the arrays are what the notice holds.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		reconstructed: [...new Set(result.reconstructed)],
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		dropped: [...new Set(result.dropped)],
		unknownAircraft,
	};
}

/** The picker's own entry: read the file, then load it. The READ is guarded
 *  like the parse, because on Android it is the step that fails -- the chooser
 *  hands back a content URI and a provider can refuse it or serve nothing --
 *  and an unguarded read rejects into nowhere, which looks exactly like the
 *  app ignoring the file. */
export async function loadRoutesFromFile(file: File): Promise<boolean> {
	let text: string;
	try {
		text = await file.text();
	} catch (err) {
		clearRouteLoadOutcome();
		routeLoad.error = err instanceof Error ? err.message : String(err);
		return false;
	}
	return loadRoutesFromYaml(text);
}

/** Replace the workspace with the routes in `text`. Returns false when the
 *  document could not be read, leaving the workspace untouched and the reason
 *  in `routeLoad.error`.
 *
 *  `source` names the Flight Plan Catalog entry being ACTIVATED (the Plans
 *  view's action): on success the provenance records it, with the dirty
 *  baseline computed AFTER the load and flight-prep apply settled and a
 *  `lossy` flag when this copy lost waypoints against current data. A
 *  caller passing none (file picker, openFile dispatcher, a filed
 *  outing's frozen plan) RE-ATTACHES automatically when the text is
 *  byte-identical to exactly one catalog entry - the content is provably
 *  that plan, so Store-after-edit targets what the user expects (the
 *  greyed "Store flight plan" report) - and DETACHES otherwise (no match,
 *  an ambiguous duplicate, or the catalog unreadable). Both writes happen
 *  only on the success path: a failed parse must not orphan a live
 *  plan's provenance. */
export async function loadRoutesFromYaml(
	text: string,
	source?: { id: string; savedAtMs: number },
): Promise<boolean> {
	clearRouteLoadOutcome();
	try {
		// Resolve anchored idents against the current data, so a load right after
		// startup doesn't drop every airport/navaid before the datasets arrive.
		await Promise.all([ensureAirports(), ensureNavaids()]);
		const parsed = parseRoutesDoc(text);
		const effective = source ?? (await catalogSourceForText(text));
		const { dropped, truncated, reconstructed } = loadRoutes(parsed, resolveWaypointToken);
		const { unknownAircraft } = applyLoadedFlightPrep(
			parsed.flightPrep,
			perfIcaos(orderedTrips(routes.list), []),
		);
		setActivePlanSource(
			effective
				? {
						id: effective.id,
						savedAtMs: effective.savedAtMs,
						sig: planSig(),
						lossy: dropped.length > 0 || truncated,
					}
				: null,
		);
		setRouteLoadNotice({ dropped, truncated, reconstructed }, unknownAircraft ?? null);
		return true;
	} catch (err) {
		routeLoad.error = err instanceof Error ? err.message : String(err);
		return false;
	}
}

/** The auto-attach lookup: the catalog entry this text IS, byte-equal
 *  and unique (two store-created twins would make the target arbitrary,
 *  so an ambiguous match stays detached). Failures read as no match. */
async function catalogSourceForText(
	text: string,
): Promise<{ id: string; savedAtMs: number } | null> {
	const hits = (await getStoredPlans()).filter((p) => p.yaml === text);
	return hits.length === 1 ? { id: hits[0].id, savedAtMs: hits[0].savedAtMs } : null;
}
