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
import { fileToken } from '$lib/files/fileName';
import {
	identCandidates,
	readRouteFile,
	type ImportedPlan,
	type ImportedPoint,
} from '$lib/route/routeImport';
import { SAME_PLACE_NM, distanceNM } from '$lib/route/routePoints';
import { parseRoutesDoc, type LoadedWaypoint } from '$lib/route/yaml';
import { planSig, setActivePlanSource } from '$lib/state/activePlan.svelte';
import { getStoredPlans } from '$lib/state/flightsDb';
import { ensureAirports, ensureNavaids } from '$lib/state/data.svelte';
import { applyLoadedFlightPrep } from '$lib/state/flightPrep.svelte';
import { loadRoutes, routes, setRouteVfr, type WaypointAnchor } from '$lib/state/route.svelte';
import {
	hitPosition,
	hitToAnchor,
	resolveWaypointToken,
	waypointHitIndex,
	type WaypointHit,
} from '$lib/state/waypointSearch.svelte';

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

/** Replace the workspace with the plan in an INTERCHANGE file (FPL, GPX, KML
 *  or PLN; docs/route-files.md). Returns false when the file could not be
 *  read, leaving the workspace untouched and the reason in `routeLoad.error`,
 *  exactly as the YAML door does.
 *
 *  The plan lands through `loadRoutes` like every other opened file, so it
 *  records undo, replaces the workspace whole and DISPLACES a held stored
 *  plan rather than being held behind it (docs/route-workspace.md; on Android
 *  an "Open with" cold start lands while the restore is still running, which
 *  is the ordinary path for this).
 *
 *  It ends DETACHED (`setActivePlanSource(null)`): a foreign file is nothing
 *  the catalog holds, so there is no entry for Store to write back over. */
export async function loadPlanFile(text: string): Promise<boolean> {
	clearRouteLoadOutcome();
	try {
		// The same await the YAML door makes, for the same reason: the readers
		// resolve identifiers against the datasets, and a plan opened seconds
		// after boot would otherwise anchor nothing.
		//
		// allSettled, unlike that door: a YAML states its anchored points by
		// IDENT ALONE, so loading one without the datasets loses them, while
		// every one of these formats states a POSITION for every point. A
		// pilot opening a plan with no signal gets the route drawn, its points
		// free where the file put them, instead of an error and nothing.
		await Promise.allSettled([ensureAirports(), ensureNavaids()]);
		const plan = readRouteFile(text);
		// One index for the whole file, not a linear scan of every dataset per
		// candidate per point (state/waypointSearch.svelte.ts).
		const index = waypointHitIndex();
		// The answer this importer confirms against the file's own position has
		// to TRAVEL with the identifier: loadRoutes re-resolves every one it is
		// handed, by token alone (state/route.svelte.ts, phase A), and the
		// first BOV in the datasets is an airport in Papua New Guinea.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a per-load table, not state
		const chosen = new Map<string, WaypointAnchor>();
		const resolved = plan.routes.map((r) =>
			r.points.map((p) => importedWaypoint(p, index, chosen)),
		);
		const parsed = {
			// The file's own name for each route, which GPX states and the
			// others do not: unnamed trips in the strip, the flight-prep list
			// and every print is not what a file naming them all deserves.
			routes: plan.routes.map((r, i) => ({
				name: r.name,
				waypoints: resolved[i].map((x) => x.wp),
			})),
			// The chain of every route the file states, which is what the
			// caption is weighed against: one document, one plan.
			planName: planNameOf(
				plan,
				resolved.flat().map((x) => x.airport),
			),
		};
		const { dropped, truncated, reconstructed } = loadRoutes(
			parsed,
			(token) => chosen.get(token.trim().toUpperCase()) ?? resolveWaypointToken(token),
		);
		// NOT through loadRoutes' settings block, which reads an ABSENT
		// transition altitude as "automatic" and would clear the pilot's own
		// override. These formats state one planning option between them, the
		// flight rules, and say nothing whatever about the rest.
		if (plan.vfr !== null) {
			setRouteVfr(plan.vfr);
		}
		// The workspace is replaced whole, so its workbook is too: the fuel and
		// mass-and-balance inputs of the plan that was here belong to a
		// different flight, and a figure read for the wrong one is worse than
		// no figure. The pilot block survives, exactly as it does for a YAML
		// load whose file carries no flight_prep section.
		applyLoadedFlightPrep(undefined, perfIcaos(orderedTrips(routes.list), []));
		setActivePlanSource(null);
		// The reader's own refusals ride out beside the loader's: a point whose
		// position the file states in a punctuation this grammar does not read
		// is one the pilot planned and this app is about to fly without.
		setRouteLoadNotice({ dropped: [...plan.skipped, ...dropped], truncated, reconstructed }, null);
		return true;
	} catch (err) {
		routeLoad.error = err instanceof Error ? err.message : String(err);
		return false;
	}
}

/** One imported point, resolved: what the loader takes, plus the aerodrome
 *  identifier it turned out to be (the plan's own chain is built from those,
 *  and nothing else knows which anchors were fields).
 *
 *  An identifier is only ever emitted once it has been RESOLVED here, because
 *  `loadRoutes` deletes a waypoint whose ident does not resolve even when it
 *  carries coordinates; a point that cannot be anchored is far better off as
 *  a free point at the position the file states. */
function importedWaypoint(
	p: ImportedPoint,
	index: Map<string, WaypointHit[]>,
	chosen: Map<string, WaypointAnchor>,
): { wp: LoadedWaypoint; airport: string | null } {
	const hit = anchorFor(p, index);
	const leg = p.altFt === null ? {} : { altitude: p.altFt, auto: false };
	const free = { wp: { name: p.name ?? undefined, lat: p.lat, lon: p.lon, ...leg }, airport: null };
	if (!hit) {
		return free;
	}
	const key = hit.ident.trim().toUpperCase();
	const prior = chosen.get(key);
	if (prior === undefined) {
		chosen.set(key, hit);
	} else if (prior.refId !== hit.refId || prior.kind !== hit.kind) {
		// One identifier, two places, in one file: CHW is the Chartres VOR-DME
		// and a reporting point near Arcachon, 400 km apart. The chokepoint
		// resolves by token alone, so the second cannot be told from the first
		// and stays free where the file put it, rather than being drawn onto
		// the first one's position.
		return free;
	}
	return { wp: { ident: hit.ident, ...leg }, airport: hit.kind === 'airport' ? hit.ident : null };
}

/** The feature the app's own data agrees this point names, or null.
 *
 *  Every candidate the file offers is CONFIRMED against the position the file
 *  states, within the tolerance one identifier is allowed to move by
 *  (`SAME_PLACE_NM`). That test is the whole safety of the recovery: an AIXM
 *  overlay moves an aerodrome reference point by metres, while one identifier
 *  naming two places (CHW is Chartres and a reporting point near Arcachon) is
 *  400 km apart, and anchoring the second would fly the pilot elsewhere. */
function anchorFor(p: ImportedPoint, index: Map<string, WaypointHit[]>): WaypointAnchor | null {
	for (const candidate of identCandidates(p)) {
		const near = (index.get(candidate) ?? []).filter(
			(h) => distanceNM(hitPosition(h), p) <= SAME_PLACE_NM,
		);
		if (near.length === 0) {
			continue;
		}
		// The file's own word first, where it gave one: a PLN typing the point
		// an Airport means the field, not the VOR sharing its name and its
		// position. Then the nearest, an aerodrome and its on-field beacon
		// being metres apart.
		const typed = p.aerodrome ? near.filter((h) => h.kind === 'airport') : [];
		const pool = typed.length > 0 ? typed : near;
		let best = pool[0];
		for (const h of pool) {
			if (distanceNM(hitPosition(h), p) < distanceNM(hitPosition(best), p)) {
				best = h;
			}
		}
		return hitToAnchor(best);
	}
	return null;
}

/** The caption an imported plan takes.
 *
 *  The file's own title, unless it is the aerodrome chain this app would have
 *  derived anyway: every one of our own exports writes that chain into its
 *  title field, and reading one back must not caption a plan
 *  "LFPL-LFPK-LFPL" when it never had a name (docs/file-names.md: a plan's
 *  subject is its chain, and its NAME is the pilot's own text).
 *
 *  Weighed against BOTH chains, the one the datasets RESOLVED and the one the
 *  file itself states. An import proceeds with no datasets at all by decision
 *  (`allSettled` above), and then nothing resolves, the resolved chain is
 *  empty, and our own file's title is a name again: exactly the caption this
 *  guard exists to refuse, arriving whenever the pilot opens a plan with no
 *  signal. */
function planNameOf(plan: ImportedPlan, airports: readonly (string | null)[]): string | undefined {
	const trimmed = plan.title?.trim();
	if (!trimmed) {
		return undefined;
	}
	const token = fileToken(trimmed);
	// A caption in a script fileToken cannot fold (Cyrillic, Greek, CJK) folds
	// to nothing, and nothing matches the nothing an empty chain gives. It is a
	// name the pilot wrote, so it is kept.
	if (token === '') {
		return trimmed;
	}
	const stated = plan.routes.flatMap((r) => r.points.map(statedAerodrome));
	return [airports, stated].some((idents) => fileToken(chainOf(idents)) === token)
		? undefined
		: trimmed;
}

/** The aerodrome chain those identifiers spell, consecutive repeats collapsed
 *  the way routesFileBaseName spells it on the way out. */
function chainOf(idents: readonly (string | null)[]): string {
	const chain: string[] = [];
	for (const ident of idents) {
		if (ident && chain[chain.length - 1] !== ident) {
			chain.push(ident);
		}
	}
	return chain.join('-');
}

/** The ICAO location indicator a point states or opens its name with, which
 *  is the chain a file spells before any dataset has confirmed a word of it. */
function statedAerodrome(p: ImportedPoint): string | null {
	return identCandidates(p).find((c) => /^[A-Z]{4}$/.test(c)) ?? null;
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
