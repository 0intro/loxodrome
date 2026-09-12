/* Aircraft fleet state: the committed library (public/data/aircraft/, loaded
 * once on demand) plus the user's planes, which shadow library entries by
 * key (registration, else type) and persist to localStorage as YAML text so
 * the data sheet stays the one canonical format (a stored sheet that no
 * longer parses is dropped, not crashed on). The selected aircraft key also
 * persists; it may name a plane that isn't in the fleet (a route file from
 * another machine), which the UI surfaces as "unknown aircraft". The tanked
 * fuel grade is per-plane OPERATIONAL state kept beside the fleet (see
 * tankedFuelType), never a data-sheet edit. */

import { loadCommittedAircraft } from '$lib/data/aircraft';
import {
	parseAircraftYaml,
	stringifyAircraftYaml,
	aircraftKey,
	gradientFtPerNM,
	FUEL_TYPE_INFO,
	type Aircraft,
	type AircraftFuel,
	type FuelType,
} from '$lib/aircraft/schema';
import type { ErrorText } from '$lib/i18n/errorText';
import { t } from './i18n.svelte';
import { readItem, readJson, removeItem, writeItem, writeJson } from './persist';
import { routeSettings } from './route.svelte';
import { recordSyncTombstone } from './syncRegistry';

const SELECTED_KEY = 'loxodrome:aircraft-selected';
const USER_KEY = 'loxodrome:aircraft-user';
const TANKED_KEY = 'loxodrome:aircraft-fuel';

function initialSelected(): string | null {
	return readItem(SELECTED_KEY);
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
			out[key] = parseAircraftYaml(text);
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

/** Idempotent committed-library load; safe to call from effects. */
export function ensureAircraftLibrary(): Promise<void> {
	if (!libraryPromise) {
		libraryPromise = loadCommittedAircraft()
			.then((list) => {
				aircraftState.library = list.map((c) => c.aircraft);
				aircraftState.libraryLoaded = true;
				aircraftState.libraryError = null;
				pruneIdenticalShadows();
				// The persisted selection resolves only now; apply its speed.
				syncCruiseSpeed();
			})
			.catch((e: unknown) => {
				aircraftState.libraryError = e instanceof Error ? e.message : String(e);
				libraryPromise = null;
			});
	}
	return libraryPromise;
}

/** The cruise speed is ONE shared value: the selected plane's data sheet and
 *  routeSettings.cruiseSpeedKt always show the same number. Called from
 *  every mutation that can change which plane (or which speed) is current;
 *  the Route tab's field mirrors back into the data sheet via
 *  updateAircraft, which lands here too. */
function syncCruiseSpeed(): void {
	const a = selectedAircraft();
	if (a?.cruise) {
		routeSettings.cruiseSpeedKt = a.cruise.speedKt;
	}
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

/** Drop shadows that no longer differ from the library (older sessions may
 *  have stored them before edits started reconverging). A shadow whose ONLY
 *  difference is the fuel grade (stored by the Aircraft-tab selector before
 *  the tanked grade moved out of the data sheet) is absorbed into the
 *  per-plane selection instead, so the plane stops reading as edited. */
function pruneIdenticalShadows(): void {
	let changed = false;
	for (const [key, a] of Object.entries(aircraftState.user)) {
		const snap = $state.snapshot(a);
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

/** The cruise speed (kt) every ETE consumer plans with: the Route-tab value
 *  when set, else the selected aircraft's data-sheet speed (the field's
 *  placeholder, so a grey number is always the value in use), else null
 *  (ETE columns omitted). Pure $state reads, tracked by any $derived. */
export function effectiveCruiseSpeedKt(): number | null {
	return routeSettings.cruiseSpeedKt ?? selectedAircraft()?.cruise?.speedKt ?? null;
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
	syncCruiseSpeed();
}

/** Add / replace a user plane (an imported YAML) and select it. Same key as
 *  a library plane shadows it; an import identical to the library just
 *  selects it (and clears any stale shadow). Returns the plane's key. */
export function importUserAircraft(a: Aircraft): string {
	const key = addUserAircraft(a);
	selectAircraft(key);
	return key;
}

/** The same, WITHOUT selecting: restoring a whole fleet out of a flights
 *  bundle must not leave the workspace flying whichever sheet the archive
 *  happened to list last. Returns the plane's key. */
export function addUserAircraft(a: Aircraft): string {
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
	for (const a of planes) {
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
	if (!current) {
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
	syncCruiseSpeed();
}

/** A key the committed library owns (shadowed or not). Its data sheet can
 *  be edited, but its key (registration, else type) must not change;
 *  duplicating is the way to a variant under a new key. */
export function isLibraryKey(key: string): boolean {
	return aircraftState.library.some((a) => aircraftKey(a) === key);
}

/** Commit an aircraft-editor result. originalKey is the fleet key being
 *  edited, null for create (new plane or duplicate). Returns a user-facing
 *  error THUNK (key collision, library re-key; docs/i18n.md rule 7, so the
 *  editor footer re-renders it on a locale switch), or null on success. The
 *  caller passes a schema-validated Aircraft only, so persistUser never
 *  stores a sheet that would fail to parse next session. */
export function saveEditedAircraft(originalKey: string | null, a: Aircraft): ErrorText | null {
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
		syncCruiseSpeed();
	}
	return null;
}

/** Drop the user shadow so the library version shows again. */
export function revertToLibrary(key: string): void {
	if (isShadowed(key)) {
		dropUserPlane(key);
		persistUser();
		syncCruiseSpeed();
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
		a = parseAircraftYaml(yamlText);
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
	syncCruiseSpeed();
	return key;
}

/** Remove a remotely-deleted user plane. */
export function applyRemoteAircraftDelete(key: string): void {
	if (!(key in aircraftState.user)) {
		return;
	}
	delete aircraftState.user[key];
	persistUser();
	syncCruiseSpeed();
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

// A persisted selection means the route cruise speed is that plane's: load
// the library eagerly so the shared value applies at startup, not only once
// an aircraft surface is opened.
if (aircraftState.selectedKey) {
	void ensureAircraftLibrary();
}
