/* Aircraft fleet state: the committed library (public/data/aircraft/, loaded
 * once on demand) plus the user's planes, which shadow library entries by
 * key (registration, else type) and persist to localStorage as YAML text so
 * the data sheet stays the one canonical format (a stored sheet that no
 * longer parses is dropped, not crashed on). The selected aircraft key also
 * persists; it may name a plane that isn't in the fleet (a route file from
 * another machine), which the UI surfaces as "unknown aircraft". The tanked
 * fuel grade is per-plane OPERATIONAL state kept beside the fleet (see
 * tankedFuelType), never a data-sheet edit. */

import { untrack } from 'svelte';
import { loadCommittedAircraft } from '$lib/data/aircraft';
import {
	parseAircraftYaml,
	stringifyAircraftYaml,
	aircraftKey,
	GENERIC_KEY_PREFIX,
	gradientFtPerNM,
	FUEL_TYPE_INFO,
	type Aircraft,
	type AircraftFuel,
	type ClosedFormConfig,
	type FuelType,
} from '$lib/aircraft/schema';
import type { ErrorText } from '$lib/i18n/errorText';
import { t } from './i18n.svelte';
import { readItem, readJson, removeItem, writeItem, writeJson } from './persist';
import { DEFAULT_CRUISE_KT, routeSettings } from './route.svelte';
import { recordSyncTombstone } from './syncRegistry';
import { isNotamViewer } from './appIdentity';
import { retryAfterFailure, retryCleared, retryPending } from './dataRetry.svelte';

const SELECTED_KEY = 'loxodrome:aircraft-selected';
const USER_KEY = 'loxodrome:aircraft-user';
const TANKED_KEY = 'loxodrome:aircraft-fuel';
const CRUISE_KNOWN_KEY = 'loxodrome:aircraft-cruise';

function initialSelected(): string | null {
	// The NOTAM Viewer has no aircraft: the flight app's selection, on the
	// storage the two share, is not its (state/appIdentity.ts).
	return isNotamViewer() ? null : readItem(SELECTED_KEY);
}

// Entries whose GRADE this build does not know (a newer build's pick,
// arrived via sync): carried through storage and the sync snapshot
// verbatim, never into the reactive map (every consumer indexes
// FUEL_TYPE_INFO). Module state beside the store, not $state: only the
// serializers read it.
let tankedForeign: Record<string, string> = {};

function initialTankedFuel(): Record<string, FuelType> {
	const stored = readJson<{ v?: number; types?: Record<string, string> }>(TANKED_KEY);
	if (!stored || stored.v !== 1 || typeof stored.types !== 'object' || stored.types === null) {
		return {};
	}
	const out: Record<string, FuelType> = {};
	for (const [key, type] of Object.entries(stored.types)) {
		if (type in FUEL_TYPE_INFO) {
			out[key] = type as FuelType;
		} else {
			tankedForeign[key] = type;
		}
	}
	return out;
}

function initialUser(): Record<string, Aircraft> {
	const stored = readJson<{ v?: number; planes?: Record<string, string> }>(USER_KEY);
	if (!stored || stored.v !== 1 || typeof stored.planes !== 'object' || stored.planes === null) {
		return {};
	}
	const out: Record<string, Aircraft> = {};
	for (const [key, text] of Object.entries(stored.planes)) {
		try {
			out[key] = withoutGeneric(parseAircraftYaml(text));
		} catch {
			/* drop a sheet that no longer parses */
		}
	}
	return out;
}

export const aircraftState = $state<{
	library: Aircraft[];
	libraryLoaded: boolean;
	libraryError: string | null;
	/** User planes by key; shadow same-key library entries. */
	user: Record<string, Aircraft>;
	selectedKey: string | null;
	/** Tanked grade by plane key; missing = the data sheet's own grade. */
	tankedFuel: Record<string, FuelType>;
}>({
	library: [],
	libraryLoaded: false,
	libraryError: null,
	user: initialUser(),
	selectedKey: initialSelected(),
	tankedFuel: initialTankedFuel(),
});

// Non-reactive in-flight guard; the loader in $lib/data/aircraft also caches.
let libraryPromise: Promise<void> | null = null;

/** Idempotent committed-library load; safe to call from effects. Never
 *  rejects: a failure is recorded in aircraftState.libraryError (the prints
 *  read requireAircraftLibrary for a rejection). A read that failed for a
 *  reason that may pass is read again by the retry schedule
 *  (state/dataRetry.svelte.ts), and until then this answers at once without
 *  reading, whoever asks. It subscribes its caller to nothing: the editor's
 *  open effect calls it, and re-run when the library landed it reseeded its
 *  draft over the pilot's typing (tests/aircraftLibraryEffect.client.spec.ts). */
export function ensureAircraftLibrary(): Promise<void> {
	if (libraryLoadedNow()) {
		return Promise.resolve();
	}
	if (!libraryPromise && retryPending('aircraft')) {
		return Promise.resolve();
	}
	return libraryPromise ?? startAircraftLibrary();
}

/** The loaded flag, read without subscribing the caller. */
function libraryLoadedNow(): boolean {
	return untrack(() => aircraftState.libraryLoaded);
}

function retryAircraftLibrary(): Promise<unknown> {
	// Loaded, the retry clears its key: the work after the load (the
	// shadows, the cruise speed) throwing would otherwise leave it
	// rescheduled for good, settle reading a retry still registered as one
	// that failed again.
	if (libraryLoadedNow()) {
		retryCleared('aircraft');
		return Promise.resolve();
	}
	return libraryPromise ?? startAircraftLibrary();
}

function startAircraftLibrary(): Promise<void> {
	libraryPromise = loadCommittedAircraft()
		.then((list) => {
			retryCleared('aircraft');
			aircraftState.library = list.map((c) => c.aircraft);
			aircraftState.libraryLoaded = true;
			aircraftState.libraryError = null;
			pruneIdenticalShadows();
			// The persisted selection resolves only now.
			rememberCruiseSpeed();
		})
		.catch((e: unknown) => {
			retryAfterFailure('aircraft', 'aircraft', e, retryAircraftLibrary);
			aircraftState.libraryError = e instanceof Error ? e.message : String(e);
			libraryPromise = null;
		});
	return libraryPromise;
}

/** The library, or the reason it did not load. The prints settle each
 *  dataset they read and report the ones that fail, and the ensure above
 *  never rejects (its boot call and four components fire it and forget it),
 *  so a failed library read as a success and the sheet went out without
 *  saying so. Rejects exactly when the library is not loaded afterwards. */
export async function requireAircraftLibrary(): Promise<void> {
	await ensureAircraftLibrary();
	if (!aircraftState.libraryLoaded) {
		// i18n-ignore: the loader's own wire diagnostic, which the print issue does not display
		throw new Error(aircraftState.libraryError ?? 'aircraft library not loaded');
	}
}

/** The selected plane's cruise speed as it last resolved. A library plane
 *  resolves only once the library lands, at every boot, and not at all when
 *  it fails to load; the plan keeps flying at that plane's speed meanwhile,
 *  never at the default, and the Route tab shows it in grey. Plain: read only
 *  while the plane is unresolved, and the plane resolving is what moves the
 *  reactive readers on. Class `aircraft` (state/storageKeys.ts). */
let knownCruise: { key: string; kt: number } | null = initialKnownCruise();

function initialKnownCruise(): { key: string; kt: number } | null {
	if (isNotamViewer()) {
		return null;
	}
	const raw = readJson(CRUISE_KNOWN_KEY);
	if (typeof raw !== 'object' || raw === null) {
		return null;
	}
	const { key, kt } = raw as { key?: unknown; kt?: unknown };
	return typeof key === 'string' && typeof kt === 'number' && Number.isFinite(kt) && kt > 0
		? { key, kt }
		: null;
}

/** Note the selected plane's sheet speed once it resolves. Called from every
 *  mutation that can change which plane (or which speed) is current; it
 *  writes nothing into the plan, the cruise speed being the plane's until a
 *  flight plan states its own (routeSettings.cruiseSpeedKt). Untracked, so a
 *  caller inside an effect subscribes to nothing. */
function rememberCruiseSpeed(): void {
	untrack(() => {
		const key = aircraftState.selectedKey;
		const kt = selectedAircraft()?.cruise?.speedKt;
		if (!key || kt === undefined || !(kt > 0) || (knownCruise?.key === key && knownCruise.kt === kt)) {
			return;
		}
		knownCruise = { key, kt };
		writeJson(CRUISE_KNOWN_KEY, knownCruise);
	});
}

function libraryPlane(key: string): Aircraft | null {
	return aircraftState.library.find((a) => aircraftKey(a) === key) ?? null;
}

/** Value-identical to the library plane of the same key (canonical-YAML
 *  comparison, so field order and proxies don't matter). A shadow that lands
 *  back on the library values is dropped: no "edited" badge for a round trip. */
function sameAsLibrary(key: string, a: Aircraft): boolean {
	const lib = libraryPlane(key);
	return lib !== null && stringifyAircraftYaml(a) === stringifyAircraftYaml($state.snapshot(lib));
}

/** Drop one user plane from the store, recording the sync tombstone when
 *  one actually existed: every path that removes a shadow or a user-only
 *  plane is a USER-INTENT deletion of the synced `aircraft` doc, the
 *  shadow prune included (the other device then drops its shadow and
 *  resolves to the committed library too; docs/accounts-sync.md). No-op
 *  for an absent key, so the import-equals-library path stays free to
 *  call it unconditionally; the device-wipe paths edit storage directly
 *  and never come through here. */
function dropUserPlane(key: string): void {
	if (!(key in aircraftState.user)) {
		return;
	}
	delete aircraftState.user[key];
	void recordSyncTombstone('aircraft', key);
}

function sameChart(a: ClosedFormConfig, b: ClosedFormConfig): boolean {
	return (
		a.flapsDeg === b.flapsDeg &&
		a.massExponent === b.massExponent &&
		JSON.stringify(a.distance15m) === JSON.stringify(b.distance15m) &&
		JSON.stringify(a.groundRoll) === JSON.stringify(b.groundRoll)
	);
}

/** The library's take-off procedure tags, given to a shadow saved before
 *  they existed: a cruise speed typed into F-GIEQ copies the WHOLE sheet, so
 *  its untagged charts would keep the page from naming the short-field
 *  procedure for good. Only when every take-off chart matches the library's
 *  one to one, in order; a shadow whose charts the pilot edited is theirs
 *  and is left alone. Null when there is nothing to give. */
function withLibraryProcedures(snap: Aircraft, lib: Aircraft | null): Aircraft | null {
	const sp = snap.performance;
	const lp = lib?.performance;
	if (sp?.kind !== 'closed-form' || lp?.kind !== 'closed-form') {
		return null;
	}
	const own = sp.configs.filter((c) => c.phase === 'takeoff');
	const theirs = lp.configs.filter((c) => c.phase === 'takeoff');
	if (
		own.length !== theirs.length ||
		own.some((c) => c.procedure) ||
		!theirs.some((c) => c.procedure) ||
		!own.every((c, i) => sameChart(c, theirs[i]))
	) {
		return null;
	}
	let i = 0;
	return {
		...snap,
		performance: {
			...sp,
			configs: sp.configs.map((c) => (c.phase === 'takeoff' ? { ...c, procedure: theirs[i++].procedure } : c)),
		},
	};
}

/** Drop shadows that no longer differ from the library (older sessions may
 *  have stored them before edits started reconverging), after giving a
 *  shadow the library's take-off procedure tags when its charts are the
 *  library's (withLibraryProcedures; persisted, so it syncs once). A shadow whose ONLY
 *  difference is the fuel grade (stored by the Aircraft-tab selector before
 *  the tanked grade moved out of the data sheet) is absorbed into the
 *  per-plane selection instead, so the plane stops reading as edited. */
function pruneIdenticalShadows(): void {
	let changed = false;
	for (const [key, a] of Object.entries(aircraftState.user)) {
		let snap = $state.snapshot(a);
		const tagged = withLibraryProcedures(snap, libraryPlane(key));
		if (tagged) {
			aircraftState.user[key] = tagged;
			snap = tagged;
			changed = true;
		}
		if (sameAsLibrary(key, snap)) {
			dropUserPlane(key);
			changed = true;
			continue;
		}
		const lib = libraryPlane(key);
		if (!snap.fuel || !lib?.fuel || !lib.fuel.types.includes(snap.fuel.type)) {
			continue;
		}
		const rebased = { ...snap, fuel: { ...snap.fuel, type: lib.fuel.type } };
		if (sameAsLibrary(key, rebased)) {
			if (snap.fuel.type !== lib.fuel.type) {
				aircraftState.tankedFuel[key] = snap.fuel.type;
				persistTankedFuel();
			}
			dropUserPlane(key);
			changed = true;
		}
	}
	if (changed) {
		persistUser();
	}
}

/** The fleet: the library with user planes shadowing by key, then the
 *  user-only planes appended (insertion order). */
export function fleet(): Aircraft[] {
	const out: Aircraft[] = [];
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local dedup, not state
	const seen = new Set<string>();
	for (const a of aircraftState.library) {
		const key = aircraftKey(a);
		out.push(aircraftState.user[key] ?? a);
		seen.add(key);
	}
	for (const [key, a] of Object.entries(aircraftState.user)) {
		if (!seen.has(key)) {
			out.push(a);
		}
	}
	return out;
}

export function aircraftByKey(key: string): Aircraft | null {
	return fleet().find((a) => aircraftKey(a) === key) ?? null;
}

/** The selected aircraft, or null when none / unknown (key kept either way). */
export function selectedAircraft(): Aircraft | null {
	return aircraftState.selectedKey ? aircraftByKey(aircraftState.selectedKey) : null;
}

/** A cruise setting a plan may fly: the sheet's default first (its speed
 *  with fuel.consumptionLph, `name` its own or null), then the flight
 *  manual's others (aircraft/schema.ts CruiseSetting). */
export interface PlanCruiseSetting {
	/** True for the sheet's default, which a plan names by null. */
	isDefault: boolean;
	name: string | null;
	speedKt: number;
	consumptionLph: number | null;
}

/** The selected plane's cruise settings, the default first; empty without a
 *  plane or a cruise section. Tracked. */
export function cruiseSettings(): PlanCruiseSetting[] {
	const a = selectedAircraft();
	if (!a?.cruise) {
		return [];
	}
	return [
		{ isDefault: true, name: a.cruise.name ?? null, speedKt: a.cruise.speedKt, consumptionLph: a.fuel?.consumptionLph ?? null },
		...(a.cruise.settings ?? []).map((s) => ({
			isDefault: false,
			name: s.name,
			speedKt: s.speedKt,
			consumptionLph: s.consumptionLph,
		})),
	];
}

/** The setting the plan flies: the one it names (routeSettings.cruiseSetting,
 *  the default's own name included), else the sheet's default. Null
 *  without a plane or a cruise section. Tracked. */
export function planCruiseSetting(): PlanCruiseSetting | null {
	const all = cruiseSettings();
	const name = routeSettings.cruiseSetting;
	return (name !== null ? all.find((s) => s.name === name) : undefined) ?? all[0] ?? null;
}

/** A setting the plan names that the selected sheet does not hold (another
 *  plane, a setting renamed): the plan flies the default meanwhile, and the
 *  Route tab says which name went. Null while the plane has not resolved,
 *  which would claim every name lost. Tracked. */
export function cruiseSettingLost(): string | null {
	const name = routeSettings.cruiseSetting;
	const key = aircraftState.selectedKey;
	if (name === null || (key !== null && !aircraftByKey(key))) {
		return null;
	}
	return cruiseSettings().some((s) => s.name === name) ? null : name;
}

/** The cruise speed (kt) a flight plan that states none flies at: its
 *  setting's on the selected plane's sheet (the default unless it picks
 *  another), the plane's last known speed while it has not resolved, else
 *  DEFAULT_CRUISE_KT (no plane, or a sheet without a cruise section). The
 *  Route tab's grey placeholder, so a grey number is always the value in
 *  use. Pure $state reads, tracked by any $derived. */
export function automaticCruiseSpeedKt(): number {
	const key = aircraftState.selectedKey;
	if (key) {
		const plane = aircraftByKey(key);
		if (plane) {
			return planCruiseSetting()?.speedKt ?? DEFAULT_CRUISE_KT;
		}
		if (knownCruise?.key === key) {
			return knownCruise.kt;
		}
	}
	return DEFAULT_CRUISE_KT;
}

/** Whose speed the automatic one is, as the Route tab's summary names it:
 *  the selected plane's registration (its type for a sheet without one, a
 *  generic sheet among them) while its sheet supplies the speed, its key
 *  while only its last known speed does (a generic key without its prefix),
 *  null when it is DEFAULT_CRUISE_KT. Tracked. */
export function automaticCruiseFrom(): string | null {
	const key = aircraftState.selectedKey;
	if (!key) {
		return null;
	}
	const plane = aircraftByKey(key);
	if (plane) {
		return plane.cruise ? (plane.identity.registration ?? plane.identity.type) : null;
	}
	if (knownCruise?.key !== key) {
		return null;
	}
	return key.startsWith(GENERIC_KEY_PREFIX) ? key.slice(GENERIC_KEY_PREFIX.length) : key;
}

/** The fuel flow (L/h) a flight plan that states none burns: its setting's
 *  (the default's being fuel.consumptionLph), else the sheet's consumption,
 *  else null (no fuel figures). Tracked. */
export function automaticConsumptionLph(): number | null {
	return planCruiseSetting()?.consumptionLph ?? selectedAircraft()?.fuel?.consumptionLph ?? null;
}

/** The fuel flow (L/h) the fuel plan, the trip loads and the endurance read:
 *  the flight plan's own beside its own speed (the Route tab), else the
 *  automatic one, so a different speed comes with its own burn. Tracked. */
export function effectiveConsumptionLph(): number | null {
	return routeSettings.cruiseConsumptionLph ?? automaticConsumptionLph();
}

/** The cruise speed (kt) every ETE consumer plans with: the flight plan's
 *  own when it states one (the Route tab's Cruise box), else the automatic
 *  speed. Pure $state reads, tracked by any $derived. */
export function effectiveCruiseSpeedKt(): number {
	return routeSettings.cruiseSpeedKt ?? automaticCruiseSpeedKt();
}

/** Still-air climb gradient (ft/NM) from the selected aircraft's data
 *  sheet, or null (the route profile then draws its 3-degree default).
 *  Pure $state reads, tracked like effectiveCruiseSpeedKt. */
export function effectiveClimbGradFtPerNM(): number | null {
	const c = selectedAircraft()?.climb;
	return c ? gradientFtPerNM(c) : null;
}

/** Still-air descent gradient (ft/NM), the climb accessor's twin. */
export function effectiveDescentGradFtPerNM(): number | null {
	const d = selectedAircraft()?.descent;
	return d ? gradientFtPerNM(d) : null;
}

/** A user plane shadowing a library entry (the "edited" badge / revert). */
export function isShadowed(key: string): boolean {
	return (
		key in aircraftState.user && aircraftState.library.some((a) => aircraftKey(a) === key)
	);
}

/** A plane that exists only in the user store (the "custom" badge / delete). */
export function isUserOnly(key: string): boolean {
	return (
		key in aircraftState.user && !aircraftState.library.some((a) => aircraftKey(a) === key)
	);
}

function persistSelected(): void {
	if (aircraftState.selectedKey) {
		writeItem(SELECTED_KEY, aircraftState.selectedKey);
	} else {
		removeItem(SELECTED_KEY);
	}
}

function persistUser(): boolean {
	const planes: Record<string, string> = {};
	for (const [key, a] of Object.entries(aircraftState.user)) {
		planes[key] = stringifyAircraftYaml(a);
	}
	return writeJson(USER_KEY, { v: 1, planes });
}

function persistTankedFuel(): void {
	writeJson(TANKED_KEY, {
		v: 1,
		types: { ...tankedForeign, ...$state.snapshot(aircraftState.tankedFuel) },
	});
}

/** The grade actually tanked: the per-plane selection when it names one of
 *  the plane's grades, else the data sheet's own grade. What sits in the
 *  tanks is operational state, not a data-sheet edit: it lives beside the
 *  fleet, so picking a grade never shadows a library plane (no "edited"
 *  badge) and never pins an outdated sheet against library updates. */
export function tankedFuelType(key: string, fuel: AircraftFuel): FuelType {
	const sel = aircraftState.tankedFuel[key];
	return fuel.types.includes(sel) ? sel : fuel.type;
}

/** The tanked grade's density (kg/L), for every fuel-mass consumer. */
export function tankedFuelDensityKgPerL(key: string, fuel: AircraftFuel): number {
	return FUEL_TYPE_INFO[tankedFuelType(key, fuel)].densityKgPerL;
}

/** Select the tanked grade (one of the plane's `fuel.types`). Selecting the
 *  sheet's own grade drops the entry, so an untouched plane stores nothing. */
export function setTankedFuel(key: string, type: FuelType): void {
	const fuel = aircraftByKey(key)?.fuel;
	if (!fuel || !fuel.types.includes(type)) {
		return;
	}
	if (type === fuel.type) {
		delete aircraftState.tankedFuel[key];
	} else {
		aircraftState.tankedFuel[key] = type;
	}
	delete tankedForeign[key]; // a local pick overrides a foreign one
	persistTankedFuel();
}

export function selectAircraft(key: string | null): void {
	aircraftState.selectedKey = key;
	persistSelected();
	rememberCruiseSpeed();
}

/** A pilot's own plane never carries the generic flag: it marks a LIBRARY
 *  sheet built from a flight manual alone, keyed apart and read-only. Every
 *  way a user plane comes in (an import, a bundle, a synced copy, an editor
 *  save) passes through here, so an imported or pasted generic sheet becomes
 *  the pilot's plane under its own key, never an "edited" generic. */
function withoutGeneric(a: Aircraft): Aircraft {
	if (a.identity.generic === undefined) {
		return a;
	}
	const identity = { ...a.identity };
	delete identity.generic;
	return { ...a, identity };
}

/** Is this key a generic library sheet's? The tab offers it no edit, and
 *  `updateAircraft` refuses one. */
export function isGenericKey(key: string): boolean {
	return aircraftByKey(key)?.identity.generic !== undefined;
}

/** The registration an export writes for a fleet key (the logbook CSV, the
 *  trace files): the plane's own, else the key a registration-less plane
 *  goes by (its type, accepted for v1), and nothing for a generic library
 *  sheet, which is no aircraft: never its "generic:" key, even once the
 *  library no longer holds that sheet. */
export function exportRegistration(key: string | null | undefined): string {
	if (!key || key.startsWith(GENERIC_KEY_PREFIX)) {
		return '';
	}
	return aircraftByKey(key)?.identity.registration ?? key;
}

/** Add / replace a user plane (an imported YAML) and select it. Same key as
 *  a library plane shadows it; an import identical to the library just
 *  selects it (and clears any stale shadow). Returns the plane's key. */
export function importUserAircraft(a: Aircraft): string {
	const key = addUserAircraft(a);
	selectAircraft(key);
	return key;
}

/** The pilot's own sheet an import of this one would REPLACE with other
 *  figures, by key, or null when the import loses nothing: a plane not in
 *  the fleet, a sheet identical to theirs, or a library plane they never
 *  changed (its Revert brings the library sheet back). An import replaces
 *  by key, by design, and the sheet it replaces may hold an evening's work
 *  in the editor: the import asks first then (state/openFile). */
export function importOverwrites(raw: Aircraft): string | null {
	const a = withoutGeneric(raw);
	const key = aircraftKey(a);
	const own = aircraftState.user[key];
	if (own === undefined) {
		return null;
	}
	return stringifyAircraftYaml($state.snapshot(own)) === stringifyAircraftYaml(a) ? null : key;
}

/** The same, WITHOUT selecting: restoring a whole fleet out of a flights
 *  bundle must not leave the workspace flying whichever sheet the archive
 *  happened to list last. Returns the plane's key. */
export function addUserAircraft(raw: Aircraft): string {
	const a = withoutGeneric(raw);
	const key = aircraftKey(a);
	applyUserAircraft(key, a);
	persistUser();
	return key;
}

function applyUserAircraft(key: string, a: Aircraft): void {
	if (sameAsLibrary(key, a)) {
		dropUserPlane(key);
	} else {
		aircraftState.user[key] = a;
	}
}

/** Add a whole fleet at once (a flights bundle's `aircraft/` members).
 *
 *  Two things a per-sheet loop got wrong. It persisted per sheet, and
 *  `persistUser` re-serialises EVERY user plane, so fifteen sheets meant
 *  fifteen full-fleet writes in the middle of an import. And it overwrote
 *  silently: a bundle exported from the phone before an evening's work on a
 *  performance grid would have destroyed that work, with no confirm and no
 *  undo, under a notice reading "added". Every sibling path here is
 *  deliberately non-destructive - traces are id-keyed upserts, plans dedupe
 *  by bytes, a CSV row never overwrites a filed trace - so this one is too:
 *  an existing user sheet STANDS and is reported as kept.
 *
 *  Returns what happened, so the caller can word it: `added` is new sheets,
 *  `kept` is ones already yours, `persisted` says whether the store took it. */
export function addUserAircraftMany(planes: readonly Aircraft[]): {
	added: number;
	kept: number;
	persisted: boolean;
} {
	let added = 0;
	let kept = 0;
	for (const raw of planes) {
		const a = withoutGeneric(raw);
		const key = aircraftKey(a);
		if (key in aircraftState.user) {
			kept++;
			continue;
		}
		applyUserAircraft(key, a);
		added++;
	}
	return { added, kept, persisted: added === 0 || persistUser() };
}

/** Copy-on-write edit: clones the resolved plane into the user store (the
 *  shadow is born here), applies the mutation, persists. An edit landing
 *  back on the library values drops the shadow instead. */
export function updateAircraft(key: string, mutate: (a: Aircraft) => void): void {
	const current = aircraftByKey(key);
	// A generic sheet is read-only: a pilot's figures go on a Duplicate.
	if (!current || current.identity.generic !== undefined) {
		return;
	}
	const next = $state.snapshot(current);
	mutate(next);
	if (sameAsLibrary(key, next)) {
		dropUserPlane(key);
	} else {
		aircraftState.user[key] = next;
	}
	persistUser();
	rememberCruiseSpeed();
}

/** A key the committed library owns (shadowed or not). Its data sheet can
 *  be edited, but its key (registration, else type) must not change;
 *  duplicating is the way to a variant under a new key. */
export function isLibraryKey(key: string): boolean {
	return aircraftState.library.some((a) => aircraftKey(a) === key);
}

/** Commit an aircraft-editor result. originalKey is the fleet key being
 *  edited, null for create (new plane or duplicate). Returns a user-facing
 *  error THUNK (key collision, library re-key, a generic sheet; docs/i18n.md
 *  rule 7, so the editor footer re-renders it on a locale switch), or null on
 *  success. The caller passes a schema-validated Aircraft only, so
 *  persistUser never stores a sheet that would fail to parse next session. */
export function saveEditedAircraft(originalKey: string | null, edited: Aircraft): ErrorText | null {
	// A generic sheet is read-only, like updateAircraft's refusal: the editor
	// shows one and never saves it, and a pilot's figures go on a Duplicate.
	// Without this the flag's removal re-keyed it into a library-key error.
	if (originalKey !== null && originalKey.startsWith(GENERIC_KEY_PREFIX)) {
		return () => t.aircraft.errGenericSheet;
	}
	const a = withoutGeneric(edited);
	const newKey = aircraftKey(a);
	if (originalKey !== newKey) {
		if (originalKey !== null && isLibraryKey(originalKey)) {
			const key = originalKey;
			return () => t.aircraft.errLibraryKey(key);
		}
		if (fleet().some((x) => aircraftKey(x) === newKey)) {
			return () => t.aircraft.errKeyInFleet(newKey);
		}
	}
	if (originalKey !== null && originalKey !== newKey) {
		dropUserPlane(originalKey);
		// The tanked-grade selection follows the plane through a re-key (the
		// read-side validity check covers a sheet whose grades changed too).
		if (originalKey in aircraftState.tankedFuel) {
			aircraftState.tankedFuel[newKey] = aircraftState.tankedFuel[originalKey];
			delete aircraftState.tankedFuel[originalKey];
			persistTankedFuel();
		}
	}
	if (originalKey === newKey && sameAsLibrary(newKey, a)) {
		// An edit landing back on the library values drops the shadow.
		dropUserPlane(newKey);
	} else {
		aircraftState.user[newKey] = a;
	}
	persistUser();
	if (originalKey === null || (originalKey !== newKey && aircraftState.selectedKey === originalKey)) {
		selectAircraft(newKey);
	} else {
		rememberCruiseSpeed();
	}
	return null;
}

/** Drop the user shadow so the library version shows again. */
export function revertToLibrary(key: string): void {
	if (isShadowed(key)) {
		dropUserPlane(key);
		persistUser();
		rememberCruiseSpeed();
	}
}

/** Remove a user-only plane (clears the selection when it was selected). */
export function removeUserAircraft(key: string): void {
	if (!isUserOnly(key)) {
		return;
	}
	dropUserPlane(key);
	persistUser();
	if (key in aircraftState.tankedFuel) {
		delete aircraftState.tankedFuel[key];
		persistTankedFuel();
	}
	if (aircraftState.selectedKey === key) {
		selectAircraft(null);
	}
}

// --- sync seams ------------------------------------------------------------
// The remote side of docs/accounts-sync.md. Appliers land policy-resolved
// content as-is, NOT through the import path's keep-existing rule (which
// protects a manual gesture), and never record tombstones (a remote apply
// is not a user-intent delete).

/** The user planes' stored YAML text by key: the sync payloads, the
 *  exact strings persistUser writes. */
export function userPlaneYamls(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, a] of Object.entries(aircraftState.user)) {
		out[key] = stringifyAircraftYaml($state.snapshot(a));
	}
	return out;
}

/** Apply a remote aircraft doc. Returns the plane's key, or null when
 *  the sheet does not parse (the doc is skipped, never crashes a pass). */
export function applyRemoteAircraft(yamlText: string): string | null {
	let a: Aircraft;
	try {
		a = withoutGeneric(parseAircraftYaml(yamlText));
	} catch {
		return null;
	}
	const key = aircraftKey(a);
	// Kept as a shadow even when it equals the committed library: the
	// registry tracks this doc, and deleting the local copy here would
	// read as an eviction (a full re-pull every pass) until the origin's
	// own prune tombstone lands. pruneIdenticalShadows resolves it, with
	// the tombstone that propagates the cleanup.
	aircraftState.user[key] = a;
	persistUser();
	rememberCruiseSpeed();
	return key;
}

/** Remove a remotely-deleted user plane. */
export function applyRemoteAircraftDelete(key: string): void {
	if (!(key in aircraftState.user)) {
		return;
	}
	delete aircraftState.user[key];
	persistUser();
	rememberCruiseSpeed();
}

/** The tanked-grade map snapshot (the acstate payload's source),
 *  foreign entries included so an unknown grade round-trips. */
export function tankedFuelSnapshot(): Record<string, string> {
	return { ...tankedForeign, ...$state.snapshot(aircraftState.tankedFuel) };
}

/** Apply the remote tanked-grade map whole (lww whole-doc on purpose:
 *  the map is a few bytes and the rare collision costs one re-pick).
 *  Grades this build does not know park in the foreign carry-through
 *  rather than being dropped (dropping would push their erasure). */
export function applyRemoteTankedFuel(types: Record<string, string>): void {
	const next: Record<string, FuelType> = {};
	const foreign: Record<string, string> = {};
	for (const [key, type] of Object.entries(types)) {
		if (type in FUEL_TYPE_INFO) {
			next[key] = type as FuelType;
		} else {
			foreign[key] = type;
		}
	}
	aircraftState.tankedFuel = next;
	tankedForeign = foreign;
	persistTankedFuel();
}

/** Restore the tanked grades an account data download carries, never over a
 *  choice this device already holds: an aircraft with no pick here takes the
 *  file's grade when the fleet knows it and it takes that grade; one with a
 *  pick keeps it, counted as kept when the two differ. An aircraft the fleet
 *  does not know, or a grade it does not take, restores nothing, so the
 *  caller adds the file's own sheets and loads the library first. */
export function restoreTankedFuel(types: Readonly<Record<string, string>>): {
	restored: number;
	kept: number;
} {
	let restored = 0;
	let kept = 0;
	for (const [key, type] of Object.entries(types)) {
		const mine = aircraftState.tankedFuel[key] ?? tankedForeign[key];
		if (mine !== undefined) {
			if (mine !== type) {
				kept++;
			}
			continue;
		}
		const fuel = aircraftByKey(key)?.fuel;
		if (!fuel || !Object.hasOwn(FUEL_TYPE_INFO, type)) {
			continue;
		}
		const grade = type as FuelType;
		if (!fuel.types.includes(grade) || grade === fuel.type) {
			continue;
		}
		aircraftState.tankedFuel[key] = grade;
		restored++;
	}
	if (restored > 0) {
		persistTankedFuel();
	}
	return { restored, kept };
}

// A persisted selection means the automatic cruise speed is that plane's:
// load the library eagerly so it resolves at startup, not only once an
// aircraft surface is opened (its last known speed flies meanwhile). (The
// NOTAM Viewer starts with none.)
if (aircraftState.selectedKey) {
	void ensureAircraftLibrary();
}
