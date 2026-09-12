/* Persist the route workspace across reloads (simplicity review Decision 3:
 * the reload trust cost overrode the old session-only doctrine). One
 * versioned doc under 'loxodrome:routes':
 *   { v: 1, activeIndex, settings, yaml, source }
 * `yaml` reuses the saved-route-file grammar (route/yaml.ts) over the lean
 * waypoints, so the stored doc and a saved file round-trip through the same
 * builder and the same tolerant loader; its settings block carries what a
 * file save carries (vfr / semicircular / transition altitude / forecast
 * winds / temperature TAS). `settings` beside it carries the planning
 * subset that lives outside the file grammar (corridors, cruise, default
 * altitude, global wind, nav-log column toggles). `source` is the active
 * flight plan's provenance (activePlan.svelte.ts), restored verbatim. The session-only view
 * state (editMode, the preview flags, airspacesOnRouteOnly, minAltDangerOn,
 * notamsOnRouteOnly, waypoint selection) stays out, per its docstrings, and
 * flight_prep persists under its own key already.
 *
 * Precedence: the URL wins. A ?file= boot skips the restore and leaves the
 * stored doc untouched. Accepted side effects of restoring through
 * loadRoutes, stated once here: it records one undo step, and its
 * setRouteVfr drives filter.trafficMode exactly like a file load. Two tabs
 * writing the same key are last-write-wins.
 *
 * Plain module (no runes): PersistHost.svelte owns the $effect and the
 * armed flag; the functions here read the $state proxies, so calling them
 * inside that effect is the tracking. */

import { parseRoutesDoc, type ParsedRoutesDoc } from '$lib/route/yaml';
import {
	activePlan,
	leanWorkspaceYaml,
	setActivePlanSource,
	type ActivePlanSource,
} from './activePlan.svelte';
import { ensureAirports, ensureNavaids } from './data.svelte';
import { getStoredPlans, putStoredPlan } from './flightsDb';
import { readItem, readJson, removeItem, writeItem } from './persist';
import { djb2 } from './hash';
import { refreshPlans } from './planCatalog.svelte';
import {
	clearRouteRestoreHold,
	markRouteRestoreRescued,
	markRouteRestoreSheltered,
	setRouteLoadNotice,
	setRouteRestoreOutcome,
	type RouteRestoreReason,
} from './routeLoad.svelte';
import { loadRoutes, routes, routeSettings, setActiveRoute, setRouteVfr } from './route.svelte';
import { nav } from './navRecording.svelte';
import { resolveWaypointToken } from './waypointSearch.svelte';

const ROUTES_KEY = 'loxodrome:routes';
/** Where an unrestored workspace is moved the instant something is about to
 *  overwrite it. The catalog copy below is what the user actually sees; this
 *  is the last-resort shelter for the case where IndexedDB is gone too, and
 *  it is written SYNCHRONOUSLY, so nothing depends on a promise settling.
 *  Listed in reset.ts's briefing group. */
const RESCUE_KEY = 'loxodrome:routes-rescued';
const ROUTES_PERSIST_VERSION = 1;
const WRITE_DEBOUNCE_MS = 1000;

/** The planning subset persisted beside the yaml: the routeSettings fields
 *  a route file does not carry but a reload must keep. */
interface StoredPlanningSettings {
	corridorRadiusNM: number;
	minAltCorridorRadiusNM: number;
	cruiseSpeedKt: number | null;
	defaultAltitudeFt: number;
	windDirDeg: number | null;
	windSpeedKt: number | null;
	airportFreqsInNavlog: boolean;
	enrouteFreqsInNavlog: boolean;
	vorRadialsInNavlog: boolean;
}

interface StoredRoutesDoc {
	v: number;
	/** Index of the active route in the list (the yaml keeps the order). */
	activeIndex: number;
	settings: StoredPlanningSettings;
	/** The route-file grammar (route/yaml.ts), settings block included. */
	yaml: string;
	/** The active flight plan's provenance (activePlan.svelte.ts), null
	 *  for a workspace that is no catalog plan. In the doc so a reload
	 *  keeps the Store target and the PRE-RELOAD dirty baseline. */
	source: ActivePlanSource | null;
}

/** Snapshot the workspace as the stored doc. Reads every persisted field,
 *  so calling it inside an $effect deep-tracks the workspace (the yaml
 *  builder reads each waypoint's fields through the $state proxies). The
 *  SYNC lean path on purpose: no legs / info, because buildSaveRoutes
 *  (the file save) awaits datasets and winds for a nav-log snapshot the
 *  loader ignores anyway; the builder lives in activePlan.svelte.ts,
 *  shared with the plan-editing signatures. */
function currentDoc(): StoredRoutesDoc {
	return {
		v: ROUTES_PERSIST_VERSION,
		activeIndex: Math.max(
			0,
			routes.list.findIndex((r) => r.id === routes.activeId),
		),
		settings: {
			corridorRadiusNM: routeSettings.corridorRadiusNM,
			minAltCorridorRadiusNM: routeSettings.minAltCorridorRadiusNM,
			cruiseSpeedKt: routeSettings.cruiseSpeedKt,
			defaultAltitudeFt: routeSettings.defaultAltitudeFt,
			windDirDeg: routeSettings.windDirDeg,
			windSpeedKt: routeSettings.windSpeedKt,
			airportFreqsInNavlog: routeSettings.airportFreqsInNavlog,
			enrouteFreqsInNavlog: routeSettings.enrouteFreqsInNavlog,
			vorRadialsInNavlog: routeSettings.vorRadialsInNavlog,
		},
		yaml: leanWorkspaceYaml(),
		source: activePlan.source,
	};
}

/** The change signature IS the doc's JSON (fixed key order from the
 *  currentDoc literal), so the flush can store it verbatim. Ids and
 *  selection never enter the yaml, which is what lets selection-only
 *  changes short-circuit. */
function currentSig(): string {
	return JSON.stringify(currentDoc());
}

// Captured at module evaluation, which precedes mount, the async restore
// and any possible user interaction, so currentDoc() reads the state
// modules' literal defaults here: the signature of the pristine workspace
// (one empty route, default settings). Deriving it through the live
// builders keeps it exact when a default changes.
const PRISTINE_SIG = currentSig();
// The restore guards compare the YAML alone (routes + the file-grammar
// settings), not the whole doc: what they protect is USER planning, and
// the boot's own machine writers touch the OUT-OF-YAML knobs - the
// aircraft library load re-applies the persisted selection's cruise
// speed (aircraft.svelte ensureAircraftLibrary -> syncCruiseSpeed),
// racing the dataset await here, and a whole-doc comparison then bailed
// the entire restore as "the user planned something". The flush's
// pristine-removal below stays whole-doc: the key leaves only when
// EVERYTHING is default.
const PRISTINE_YAML = leanWorkspaceYaml();

/** Whether this boot carries an incoming file (?file=). Read ONCE, at
 *  module evaluation: the restore and its continuation must agree on it,
 *  and a later hash edit must not change what the boot was. */
const bootHasFileParam =
	typeof location !== 'undefined' && new URLSearchParams(location.search).has('file');
let fileBootResumed = false;

// The debounce machinery: plain module vars, deliberately not reactive.
let lastSig: string | null = null;
let pendingSig: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** The stored doc a restore declined to apply, held so the rescue can move
 *  it somewhere durable before anything overwrites it. Non-null IS the held
 *  state. A plain module let, like the three above and for the same reason:
 *  persistRoutesSoon runs inside PersistHost's writer $effect, and a
 *  reactive read there would subscribe that effect to state the rescue then
 *  writes (the effect-writes-what-it-reads footgun). The user-facing mirror
 *  is routeLoad.restore, written by the restore and never read here.
 *
 *  `baselineYaml` is the workspace this hold was taken against, and it is
 *  the YAML, never the whole doc: the doc carries the out-of-grammar knobs
 *  (cruise speed, corridors) and the boot's own machine writers touch
 *  those. The eager aircraft-library load re-applies the persisted
 *  selection's cruise speed the moment it resolves, so a whole-doc
 *  comparison would read that as "the user planned something", rescue and
 *  release with nobody having typed anything, and write the empty
 *  workspace straight over the plan. Same trap, same answer, as the
 *  restore guards above.
 *
 *  `reason` is the routeLoad outcome's twin, kept here so the retry can
 *  decide by itself: a `parse` hold is never retried (the stored bytes
 *  cannot change), and a `lossy` one only when `missingIdents` (the
 *  anchored idents the last attempt could not resolve) has actually
 *  improved, since re-running loadRoutes on the same coverage replaces
 *  the workspace for nothing: an undo step, re-minted waypoint ids and an
 *  active-route yank per dataset revision bump. */
let held: {
	raw: string;
	baselineYaml: string;
	reason: RouteRestoreReason;
	missingIdents?: string[] | undefined;
} | null = null;
/** One rescue per session: it releases the hold, so this only guards the
 *  window between the first held edit and the catalog write settling. */
let rescuing = false;
/** Re-entrancy guard for the retry. The dataset effect that drives it can
 *  re-run while the first attempt is still awaiting, and two concurrent
 *  restores would load the workspace twice, two undo steps deep. */
let retrying = false;
/** Whether a restore attempt is mid-flight. The BOOT attempt runs before
 *  the writer is armed, but the resume and the retry run with it live, and
 *  the restore's own flight-rules seed is a yaml-affecting write: without
 *  this latch the writer effect scheduled that seed and, when the dataset
 *  awaits outlast the debounce, FLUSHED the near-pristine seed doc over
 *  the very stored plan the restore was reading; the restore then still
 *  succeeded from its in-memory copy, so the loss was invisible until the
 *  next boot. */
let restoring = false;

/** Whether the mirror must write nothing right now: a restore attempt is
 *  mid-flight (above), or a ?file= boot has not had its deferred restore
 *  yet, during which the stored doc sits unrestored under an armed writer
 *  and an edit made while the file downloads would overwrite it, shelter
 *  and rescue never having had their look. Both windows end in a rearm,
 *  whose sync writes through whatever the workspace holds by then. */
function writesSuspended(): boolean {
	return restoring || (bootHasFileParam && !fileBootResumed);
}
/** Set by the reset, which is about to wipe both the catalog and the keys:
 *  a rescue that lands after that would resurrect a plan the user asked to
 *  erase. */
let cancelled = false;

/** Seed the change detector with the settled post-restore signature, so
 *  arming never writes by itself: a skipped restore (?file= boot, aborted
 *  dataset fetches) must leave the stored workspace intact until the user
 *  actually edits. PersistHost calls this when restoreRoutes settles, on
 *  every exit path. */
export function armRoutesPersist(): void {
	lastSig = currentSig();
	syncRoutesStorage();
}

/** Re-seed the change detector AND drop whatever the writer had already
 *  queued. A restore landing late (the retry) writes the workspace inside
 *  the same tick, so Svelte's flush runs the writer effect BEFORE the
 *  retry's own continuation: it sees the fresh routes against the empty
 *  workspace's signature and starts the debounce. Re-seeding lastSig alone
 *  leaves that timer live, and a second later it writes what the restore
 *  had just read. */
function rearmRoutesPersist(): void {
	if (timer !== null) {
		clearTimeout(timer);
		timer = null;
	}
	pendingSig = null;
	lastSig = currentSig();
	syncRoutesStorage();
}

/** Bring storage into agreement with the workspace the writer just armed
 *  on. Seeding lastSig alone DECLARED the workspace persisted without ever
 *  writing it, and the arm points are exactly where the workspace can hold
 *  content storage does not: a route file that displaced the stored plan
 *  (an Android "Open with", a ?file= boot), planning done while the
 *  restore awaited, a retry's own reload. Without this, the opened file
 *  was on screen but `loxodrome:routes` still held the OLD plan, so a
 *  no-edit session ended with the next boot bringing the old plan back:
 *  the very "I opened my plan and it did not stick" the displacement
 *  exists to prevent (found again on G2 desktop / P3 device).
 *
 *  Never while held (storage is deliberately AHEAD of the workspace) or
 *  suspended (the deferred restore has not had its look), and never for a
 *  pristine YAML: an untouched planner leaves no storage behind, and the
 *  test is the yaml, not the doc, because the boot's machine writers touch
 *  the out-of-grammar knobs (the aircraft library's cruise-speed re-apply)
 *  and a doc test would write a ghost workspace on every boot. This only
 *  ever WRITES; the pristine removal stays the flush's. */
function syncRoutesStorage(): void {
	if (held !== null || writesSuspended()) {
		return;
	}
	if (leanWorkspaceYaml() === PRISTINE_YAML) {
		return;
	}
	if (lastSig !== null && readItem(ROUTES_KEY) !== lastSig) {
		writeItem(ROUTES_KEY, lastSig);
	}
}

/** Whether a stored workspace is waiting, unrestored. PersistHost's retry
 *  effect reads it; it is a plain function over a plain let on purpose, so
 *  the caller decides what to track. */
export function routesRestorePending(): boolean {
	return held !== null;
}

/** Stand the writer down for a reset: the debounce is dropped, the hold is
 *  released without a rescue, and any rescue already in flight is told not
 *  to land. resetApplication is about to erase these very keys and the
 *  catalog with them, so a copy arriving afterwards would resurrect what
 *  the user asked to be rid of. */
export function disarmRoutesPersist(): void {
	if (timer !== null) {
		clearTimeout(timer);
		timer = null;
	}
	pendingSig = null;
	held = null;
	cancelled = true;
	setRouteRestoreOutcome(null);
}

/** Move the held workspace out of harm's way, then release the hold so the
 *  user's own planning can persist. Two steps, cheapest first: the localStorage
 *  aside is synchronous and cannot fail into nothing, the catalog copy is what
 *  makes the plan VISIBLE again (the Plans view, one Activate away) and clears
 *  the aside once it lands. The hold is released either way: refusing to
 *  persist what the user is typing now would trade one loss for another. */
function rescueHeldDoc(): void {
	const doc = held?.raw;
	if (doc === undefined || rescuing) {
		return;
	}
	rescuing = true;
	// The shelter goes down FIRST and synchronously: from here on the plan
	// survives even if this tab dies mid-rescue, and the outbox pass at the
	// next boot finishes the job. The stage flips with it, so the Route tab
	// stops offering a retry for a hold that no longer exists and says what
	// is actually true now.
	writeItem(RESCUE_KEY, doc);
	held = null;
	markRouteRestoreSheltered();
	void depositRescue(doc).finally(() => {
		rescuing = false;
	});
}

/** Copy a sheltered doc's plan into the flight plan catalog and, once it is
 *  really there, take the shelter down. The id is derived from the CONTENT,
 *  and putStoredPlan is an upsert, so re-depositing the same plan (a second
 *  offline session, the outbox pass at the next boot) lands on the same row
 *  instead of breeding one entry per boot. */
async function depositRescue(doc: string): Promise<void> {
	let yaml: string | null;
	try {
		const parsed = JSON.parse(doc) as { yaml?: unknown };
		yaml = typeof parsed.yaml === 'string' ? parsed.yaml : null;
	} catch {
		yaml = null;
	}
	if (yaml === null) {
		// Unreadable: the shelter can do nothing for it. Compare-and-remove,
		// like the success tail below, in case the key was re-written since.
		if (readItem(RESCUE_KEY) === doc) {
			removeItem(RESCUE_KEY);
		}
		return;
	}
	const id = `r${yaml.length.toString(36)}${djb2(yaml)}`;
	try {
		const existing = await getStoredPlans();
		if (cancelled) {
			return;
		}
		if (!existing.some((p) => p.id === id)) {
			await putStoredPlan({ id, yaml, savedAtMs: Date.now() });
			if (cancelled) {
				return;
			}
			void refreshPlans();
		}
		// Take the shelter down and stamp the receipt ONLY while it still
		// holds the doc this deposit carried: a displacement can re-write the
		// key with a newer plan while an outbox drain is in flight, and
		// removing or marking then would claim the NEWER plan safe on the
		// strength of the older one's deposit.
		if (readItem(RESCUE_KEY) === doc) {
			removeItem(RESCUE_KEY);
			markRouteRestoreRescued();
		}
	} catch {
		/* the shelter stands, and the next boot's outbox pass retries */
	}
}

/** Finish any rescue a previous session could not: the shelter key is an
 *  OUTBOX, not a tombstone, so a boot that finds one deposits it before
 *  doing anything else. Called from the restore, which runs once a session. */
function drainRescueOutbox(): void {
	const doc = readItem(RESCUE_KEY);
	if (doc !== null) {
		void depositRescue(doc);
	}
}

/** Debounced mirror: schedule a write when the workspace differs from the
 *  stored signature. A change that lands back on it (an undo inside the
 *  debounce window) cancels the pending write instead, so a stale doc can
 *  never fire after the state returned to what storage holds. Reading the
 *  whole doc here is the calling $effect's deep tracking; selection-only
 *  changes re-run it and short-circuit on the unchanged signature. */
export function persistRoutesSoon(): void {
	// Unconditional and first: this read IS the calling effect's dependency
	// on the workspace, so a held branch that returned before it would leave
	// the effect tracking nothing and the hold would never hear the edit
	// that should release it.
	const doc = currentDoc();
	const sig = JSON.stringify(doc);
	if (held !== null) {
		// A stored workspace is waiting to be restored. Until the user plans
		// something of their own, write NOTHING: leaving pendingSig null is the
		// whole hold, since flushRoutesPersist early-returns on it and so the
		// debounce, the pagehide listener and reset's explicit flush all become
		// no-ops. The comparison is on the YAML, never the whole doc, for the
		// reason `held` carries. The first real edit rescues and releases.
		if (doc.yaml === held.baselineYaml) {
			return;
		}
		rescueHeldDoc();
	}
	if (writesSuspended()) {
		// A restore attempt is mid-flight, or the ?file= restore has not run
		// yet: schedule nothing, the stored doc is not ours to overwrite. The
		// window ends in a rearm whose sync writes the workspace through, so
		// an edit made inside it still lands.
		return;
	}
	if (sig === lastSig) {
		pendingSig = null;
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		return;
	}
	pendingSig = sig;
	if (timer !== null) {
		clearTimeout(timer);
	}
	timer = setTimeout(flushRoutesPersist, WRITE_DEBOUNCE_MS);
}

/** Write the pending doc now: the debounce fire, and the pagehide flush so
 *  closing the tab inside the window loses nothing. A pristine workspace
 *  removes the key instead (one empty route, default settings: an untouched
 *  planner leaves no storage behind). */
export function flushRoutesPersist(): void {
	if (timer !== null) {
		clearTimeout(timer);
		timer = null;
	}
	// Belt to persistRoutesSoon's braces. Nothing should have queued a write
	// while a stored workspace is held or a restore is mid-flight, but the
	// removal branch below deletes the key outright, so neither guard rests
	// on one function's early-return order.
	if (held !== null || writesSuspended()) {
		pendingSig = null;
		return;
	}
	if (pendingSig === null) {
		return;
	}
	if (pendingSig === PRISTINE_SIG) {
		removeItem(ROUTES_KEY);
	} else {
		writeItem(ROUTES_KEY, pendingSig);
	}
	lastSig = pendingSig;
	pendingSig = null;
}

/** Apply the stored planning subset onto routeSettings, each field only
 *  when well-typed and in range (the yaml settings loader's tolerance:
 *  malformed values leave the session default). */
function applyStoredSettings(raw: unknown): void {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return;
	}
	const s = raw as Record<string, unknown>;
	const num = (v: unknown): number | undefined =>
		typeof v === 'number' && Number.isFinite(v) ? v : undefined;
	const corridor = num(s.corridorRadiusNM);
	if (corridor !== undefined && corridor > 0) {
		routeSettings.corridorRadiusNM = corridor;
	}
	const msaCorridor = num(s.minAltCorridorRadiusNM);
	if (msaCorridor !== undefined && msaCorridor > 0) {
		routeSettings.minAltCorridorRadiusNM = msaCorridor;
	}
	const cruise = num(s.cruiseSpeedKt);
	if (s.cruiseSpeedKt === null || (cruise !== undefined && cruise > 0)) {
		routeSettings.cruiseSpeedKt = cruise ?? null;
	}
	const defAlt = num(s.defaultAltitudeFt);
	if (defAlt !== undefined && defAlt >= 0) {
		routeSettings.defaultAltitudeFt = defAlt;
	}
	if (s.windDirDeg === null || num(s.windDirDeg) !== undefined) {
		routeSettings.windDirDeg = num(s.windDirDeg) ?? null;
	}
	const windSpeed = num(s.windSpeedKt);
	if (s.windSpeedKt === null || (windSpeed !== undefined && windSpeed >= 0)) {
		routeSettings.windSpeedKt = windSpeed ?? null;
	}
	if (typeof s.airportFreqsInNavlog === 'boolean') {
		routeSettings.airportFreqsInNavlog = s.airportFreqsInNavlog;
	}
	if (typeof s.enrouteFreqsInNavlog === 'boolean') {
		routeSettings.enrouteFreqsInNavlog = s.enrouteFreqsInNavlog;
	}
	if (typeof s.vorRadialsInNavlog === 'boolean') {
		routeSettings.vorRadialsInNavlog = s.vorRadialsInNavlog;
	}
}

// Resolved when restoreRoutes settles, on EVERY exit path (the skips
// included). The flights library defers its boot archive behind it: an
// outing filed before the workspace restore would snapshot an empty plan.
let routesRestoredResolve: (() => void) | null = null;
const routesRestored = new Promise<void>((resolve) => {
	routesRestoredResolve = resolve;
});

/** Settles when the boot restore has run (or decided not to). Never
 *  rejects. Callers must not await this in environments where
 *  PersistHost does not mount (node / vitest). */
export function whenRoutesRestored(): Promise<void> {
	return routesRestored;
}

/** Restore the stored workspace at boot. Guards, in order: the URL wins (a
 *  ?file= boot skips, its file being the user's explicit choice); nothing
 *  stored / wrong version skips; a workspace the user already edited wins
 *  over the restore (checked again after the dataset await, the real race
 *  window); and BOTH dataset fetches must resolve, because loadRoutes
 *  silently drops unresolvable waypoints and an offline boot must not
 *  mutilate the stored workspace. No fitRoute here: the boot view belongs
 *  to the URL hash / default.
 *
 *  Every guard that leaves a stored workspace UNAPPLIED now HOLDS it
 *  (`heldDoc`) instead of walking away: the writer used to arm on the empty
 *  workspace right after, so the user's next edit overwrote the plan that
 *  had merely failed to load, and a transient failure became permanent. A
 *  held doc is retried (PersistHost's dataset effect calls back in) and,
 *  if the user plans something first, rescued into the flight plan catalog
 *  before the workspace is written over it.
 *
 *  `whenRoutesRestored` settles on the FIRST attempt either way: the
 *  flights boot archive waits on it for its nav.recording re-check, and a
 *  hold must not delay that, nor a retry re-fire it. */
export async function restoreRoutes(): Promise<void> {
	try {
		restoring = true;
		await restoreRoutesInner('boot');
	} finally {
		restoring = false;
		// A DEFERRED boot has not restored anything yet: the settle belongs
		// to resumeRoutesRestore, or the flights boot archive would run its
		// storeFlownPlan against the still-pristine workspace and the flown
		// plan would never reach the catalog on a ?file= boot.
		if (!bootHasFileParam || fileBootResumed) {
			routesRestoredResolve?.();
		}
	}
}

/** Try a held restore again: the datasets arrived, the incoming file
 *  settled, or the user asked. Does nothing unless a doc is actually held.
 *  Re-entrancy-guarded, because its driver is an $effect that can re-run
 *  while the first attempt is still awaiting, and two concurrent restores
 *  would load the workspace twice. Re-arms the writer on success, timer
 *  included. Never touches `whenRoutesRestored`, which settled on the
 *  first attempt. */
export async function retryRestoreRoutes(): Promise<void> {
	// The recording gate is the in-flight doctrine at its chokepoint (the
	// automatic effect checks it too, but the Route tab's manual button and
	// any future caller land here): a late restore would swap the route
	// under a pilot in flight, nav log, progress fold and alert grading
	// with it. A parse hold is never retried: the stored bytes cannot
	// change, so every attempt would fail the same way.
	if (held === null || retrying || nav.recording || held.reason === 'parse') {
		return;
	}
	retrying = true;
	try {
		restoring = true;
		await restoreRoutesInner('retry');
	} finally {
		restoring = false;
		retrying = false;
	}
	if (held === null) {
		rearmRoutesPersist();
	}
}

/** The ?file= continuation. A boot with an incoming file DEFERS the
 *  restore rather than refusing it: the file is usually a NOTAM briefing,
 *  which has nothing to do with the flight plan, and skipping for the
 *  session would leave the plan unrestored for no reason. Once the
 *  dispatch has settled, whichever kind it was, this runs the restore: if
 *  the file WAS a route file the workspace is no longer pristine and the
 *  ordinary "the user has their own workspace" exit displaces the stored
 *  plan into the catalog, which is exactly right. Called by App.loadInitial
 *  on every exit path, a failed fetch included. Settles
 *  `whenRoutesRestored` (the boot skipped that on the deferral) and ends
 *  with the rearm, whose sync writes the workspace through: the opened
 *  file must stick with no further edit. */
export async function resumeRoutesRestore(): Promise<void> {
	if (!bootHasFileParam || fileBootResumed) {
		return;
	}
	fileBootResumed = true;
	try {
		restoring = true;
		await restoreRoutesInner('boot');
	} finally {
		restoring = false;
		routesRestoredResolve?.();
	}
	rearmRoutesPersist();
}

/** The user already has a workspace of their own: an incoming route file
 *  (an Android "Open with", which cold-starts the app and lands while this
 *  is running), or planning done during the load. Theirs is the live one
 *  and MUST keep persisting, so this does NOT hold: holding here would
 *  take the workspace on screen as its own baseline, and the writer would
 *  then see nothing to write and never store the file the user just
 *  opened. It would come back at the next boot as the old plan, which is
 *  exactly "I opened my plan and it did not stick".
 *
 *  So the displaced stored plan goes to the catalog straight away and the
 *  writer stays armed. Repeat boots collapse onto one row: the rescue's id
 *  is content-derived and the put is skipped when it is already there. */
function displaceStoredDoc(): void {
	const raw = readItem(ROUTES_KEY);
	if (raw === null) {
		return;
	}
	setRouteRestoreOutcome('superseded');
	writeItem(RESCUE_KEY, raw);
	markRouteRestoreSheltered();
	void depositRescue(raw);
}

/** Hold the stored doc against the workspace it was declined for, and say
 *  why. The bytes are kept verbatim rather than re-read at rescue time, so
 *  what is sheltered is what this attempt saw. Idempotent on the outcome:
 *  a re-hold must not reset a `rescued` flag the user is reading. */
function hold(reason: RouteRestoreReason, baselineYaml: string, missingIdents?: string[]): void {
	const raw = readItem(ROUTES_KEY);
	if (raw === null) {
		return; // nothing stored: nothing to protect, arm normally
	}
	held = { raw, baselineYaml, reason, missingIdents };
	setRouteRestoreOutcome(reason);
}

async function restoreRoutesInner(kind: 'boot' | 'retry'): Promise<void> {
	if (kind === 'boot' && bootHasFileParam && !fileBootResumed) {
		// Deferred, not declined: resumeRoutesRestore finishes this once the
		// incoming file has been dispatched.
		return;
	}
	drainRescueOutbox();
	const raw = readJson<Record<string, unknown>>(ROUTES_KEY);
	if (raw === null || raw.v !== ROUTES_PERSIST_VERSION || typeof raw.yaml !== 'string') {
		return;
	}
	// What "untouched" means depends on which attempt this is. At boot it is
	// the module-eval default. On a RETRY it is the workspace the hold was
	// taken against, which is NOT the default: the flight-rules seed below
	// already ran and is never rolled back, so a held IFR plan compared
	// against the default would decline every retry for ever and the manual
	// button would be dead. The same read-back-your-own-write trap as the
	// post-await guard, one attempt later.
	const entry = kind === 'retry' && held !== null ? held.baselineYaml : PRISTINE_YAML;
	if (leanWorkspaceYaml() !== entry) {
		displaceStoredDoc();
		return;
	}
	// A lossy retry runs only when it can actually do better: at least one
	// of the idents the last attempt could not resolve resolves now. The
	// dataset effect fires per revision bump, and re-running loadRoutes on
	// unchanged coverage rebuilds the identical mutilated workspace at the
	// cost of an undo step, re-minted waypoint ids and an active-route
	// yank, once per country the coverage gate lets in.
	if (kind === 'retry' && held?.reason === 'lossy') {
		const improved = (held.missingIdents ?? []).some((id) => resolveWaypointToken(id) !== null);
		if (!improved) {
			return;
		}
	}
	let parsed: ParsedRoutesDoc;
	try {
		parsed = parseRoutesDoc(raw.yaml);
	} catch {
		hold('parse', leanWorkspaceYaml());
		return;
	}
	// The stored flight profile applies SYNCHRONOUSLY, ahead of the dataset
	// awaits: the airspace alerts grade by routeSettings.vfr, and letting the
	// first evaluations run under the default profile flashed a VFR-graded
	// warning at every boot until the restore landed seconds later (the
	// on-device R 275 case, docs/nav-alerts.md). loadRoutes below applies it
	// again, idempotently; a user toggle during the await runs after this
	// synchronous seed, so it wins.
	if (typeof parsed.settings?.vfr === 'boolean') {
		setRouteVfr(parsed.settings.vfr);
	}
	// The baseline for the post-await guard is taken HERE, after that seed,
	// not from the module-eval PRISTINE_YAML: the seed writes into the very
	// settings block leanWorkspaceYaml serializes, so comparing against the
	// eternal default made the restore read back its own write and abort. A
	// stored IFR plan never came back (broken since the seed landed). The
	// question this guard asks is "did anything change while I awaited?",
	// which is what a baseline captured at the start of the await answers,
	// and it stays right for the next machine writer of that block too.
	const baseline = leanWorkspaceYaml();
	try {
		await Promise.all([ensureAirports(), ensureNavaids()]);
	} catch {
		hold('data', baseline);
		return;
	}
	if (leanWorkspaceYaml() !== baseline) {
		displaceStoredDoc();
		return;
	}
	// The file-load recipe (RouteTab.onLoadFile): same resolver, same loader.
	const outcome = loadRoutes(parsed, resolveWaypointToken);
	applyStoredSettings(raw.settings);
	const n = routes.list.length;
	const idx =
		typeof raw.activeIndex === 'number' && Number.isFinite(raw.activeIndex)
			? Math.min(Math.max(0, Math.trunc(raw.activeIndex)), n - 1)
			: 0;
	setActiveRoute(routes.list[idx].id);
	// The provenance round-trips VERBATIM (never recomputed: the stored sig
	// is the pre-reload dirty baseline, so unstored edits stay flagged), with
	// ONE addition: a restore that had to drop waypoints is lossy however the
	// stored flag read, or Store would overwrite the fuller catalog entry
	// with the mutilated workspace and skip its own confirm.
	const lossy = outcome.dropped.length > 0 || outcome.truncated;
	const stored = parseStoredSource(raw.source);
	setActivePlanSource(stored && lossy ? { ...stored, lossy: true } : stored);
	// What the restore had to drop reaches the same line a file load uses:
	// a plan restored minus two waypoints the current AIRAC dropped has to
	// say so. The flight-prep block is not re-applied here (it persists
	// under its own key), so no aircraft can be unknown.
	if (lossy || outcome.reconstructed.length > 0) {
		setRouteLoadNotice(outcome, null);
	}
	if (lossy) {
		// A lossy restore is NOT a success. ensureNavaids resolving says the
		// fetch ran, not that the countries this route needs are in: the
		// coverage gate is the map viewport alone at boot, the empty
		// workspace contributing no route extent, so a plan whose navaids
		// live elsewhere loses them on a perfectly online boot. Hold the
		// fuller stored doc against the mutilated workspace: a later retry
		// (the gate widened, the route extent now counted) can recover it,
		// and until then the first edit rescues rather than overwrites.
		// The unresolvable anchored idents ride the hold so a retry can ask
		// "did any of these appear?" without reloading the workspace.
		const missing = [
			...new Set(
				parsed.routes.flatMap((r) =>
					r.waypoints
						.map((w) => w.ident)
						.filter((id): id is string => id !== undefined && resolveWaypointToken(id) === null),
				),
			),
		];
		hold('lossy', leanWorkspaceYaml(), missing);
		return;
	}
	held = null;
	// Conditional on purpose: an outbox deposit landing during this very
	// restore's dataset await stamps a `rescued` receipt, and the success
	// clear must not wipe it on the one boot meant to show it. The reset
	// path keeps the unconditional setRouteRestoreOutcome(null).
	clearRouteRestoreHold();
}

/** Tolerant reader of the stored provenance; anything malformed is a
 *  plan-less workspace, like a doc from before the field existed. */
function parseStoredSource(raw: unknown): ActivePlanSource | null {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return null;
	}
	const s = raw as Record<string, unknown>;
	// Docs written before the id rekey stored the file name; the v2->v3
	// migration reused it as the id, so reading it AS the id keeps those
	// pointers matching.
	const id = typeof s.id === 'string' ? s.id : typeof s.name === 'string' ? s.name : '';
	if (
		id === '' ||
		typeof s.savedAtMs !== 'number' ||
		!Number.isFinite(s.savedAtMs) ||
		typeof s.sig !== 'string'
	) {
		return null;
	}
	return {
		id,
		savedAtMs: s.savedAtMs,
		sig: s.sig,
		lossy: s.lossy === true,
	};
}
