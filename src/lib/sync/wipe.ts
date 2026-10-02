/* The device-WIPE half of the delete-versus-wipe invariant
 * (docs/accounts-sync.md): removing the ACCOUNT'S data from this device
 * without recording a single tombstone, since wiping a club PC must
 * never delete anything server-side.
 *
 * Import discipline: the boot sweep runs at main.ts import time, BEFORE
 * any state module may evaluate (routePersist's module-eval pristine
 * capture), so this module touches storage RAW and imports only leaves:
 * keys, the registry reader (persist + keys + model, all leaf-safe), the
 * storage-key classification (no imports at all), flightsDb (deflate +
 * type-only nav imports, no state init) and the found copy (keys and
 * flightsDb).
 *
 * Two scopes. wipeLocalSync is the ACCOUNT'S data: every registry-listed
 * doc, the sync keys, and the BRIEFING key group (a plan pulled from the
 * account and Activated lands in loxodrome:routes, which would otherwise
 * stay drawn on the club PC's map); the personal "also remove my data"
 * option and delete-with-wipe run it. wipeSharedSession is a SHARED
 * session's end (the shared sign-out, the 12 h cap, the boot sweep, a sign-in
 * over an expired session, Reset's settings group): every other key but the
 * SESSION_SURVIVORS below goes too, preferences, layout, notices and view
 * state included, so the next pilot on the club PC finds the app at its
 * defaults rather than the previous one's filters, switched-off alerts and
 * acknowledged cautions (docs/preferences.md). And the library is left as
 * the session's sign-in FOUND it (user-decided 2026-10-01, privacy first):
 * what the session made and never synced goes, all of which the sign-out
 * valve counts as not uploaded (state/sync.svelte.ts countPendingDocs), and
 * every document the sign-in found is put back as found from the copy its
 * stamp took (sync/found.ts), whatever the session did to it, its edits and
 * the account's own copy pulled over it alike. In both scopes, the two
 * map-shaped aircraft keys are edited PER-ENTRY so anonymous leftovers
 * survive, and `loxodrome:last-account` deliberately survives (the
 * misused-mode guard's memory). */

import {
	ACCOUNT_KEY,
	FOUND_KEY,
	LAST_ACCOUNT_KEY,
	LAST_MODE_KEY,
	SHARED_FLAG_KEY,
	SHARED_MARKER_KEY,
	SYNC_REGISTRY_KEY,
} from './keys';
import {
	deleteOuting,
	deleteStoredPlan,
	getMetasStrict,
	getStoredPlansStrict,
	putMeta,
	putStoredPlan,
	type OutingMeta,
	type StoredPlan,
} from '$lib/state/flightsDb';
import { keysWithPrefix } from '$lib/state/persist';
import { keysOfClass, STORAGE_PREFIX, storageClassOf } from '$lib/state/storageKeys';
import { readSyncRegistry, type SyncRegistry } from '$lib/state/syncRegistry';
import {
	AIRCRAFT_FUEL_KEY,
	AIRCRAFT_USER_KEY,
	clearFoundRows,
	holdsFoundTrace,
	PILOT_DOC,
	PILOT_KEY,
	pilotHoldsSomething,
	readFoundCopy,
	readFoundRows,
	storedMap,
	type FoundCopy,
} from './found';

/** The Reset dialog's briefing group, from the one classification both
 *  read (state/storageKeys.ts, a leaf, so the import discipline holds). */
const BRIEFING_KEYS = keysOfClass('briefing');

/** What a shared session's end leaves on the device, each for its reason:
 *  - the last account and the last mode make the NEXT sign-in safer (the
 *    misused-mode guard, the checkbox's default);
 *  - the pilot's aircraft sheets, their tanked grades and the pilot block
 *    are what is left of them once the session's are settled (per entry,
 *    or whole): what the sign-in found, put back as found, and the
 *    anonymous leftovers nothing tells apart.
 *  The DevTools overrides survive too, by class (sessionSurvivor). */
const SESSION_SURVIVORS: ReadonlySet<string> = new Set([
	LAST_ACCOUNT_KEY,
	LAST_MODE_KEY,
	AIRCRAFT_USER_KEY,
	AIRCRAFT_FUEL_KEY,
	PILOT_KEY,
]);

/** Whether a key outlives a shared session's end. */
export function sessionSurvivor(key: string): boolean {
	return SESSION_SURVIVORS.has(key) || storageClassOf(key) === 'override';
}

function rawRemove(key: string): void {
	try {
		localStorage.removeItem(key);
	} catch {
		/* storage unavailable: nothing stored, nothing to wipe */
	}
}

function rawSet(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* storage refused: what was there stays */
	}
}

/** Mark for an entry editMap removes. */
const REMOVE = Symbol('remove');

/** Edit one map-shaped key entry by entry ({v: 1, <field>: Record<key,
 *  ...>}): `next` answers each entry's new value, or REMOVE. Leaves an
 *  absent or unreadable key alone: absence must never cascade. */
function editMap(
	storageKey: string,
	field: string,
	next: (key: string, value: unknown) => unknown,
): void {
	try {
		const raw = localStorage.getItem(storageKey);
		if (raw === null) {
			return;
		}
		const doc = JSON.parse(raw) as { v?: number } & Record<string, unknown>;
		const map = doc[field];
		if (doc.v !== 1 || !map || typeof map !== 'object') {
			return;
		}
		const entries = map as Record<string, unknown>;
		let changed = false;
		for (const key of Object.keys(entries)) {
			const value = next(key, entries[key]);
			if (value === REMOVE) {
				delete entries[key];
				changed = true;
			} else if (value !== entries[key]) {
				entries[key] = value;
				changed = true;
			}
		}
		if (changed) {
			localStorage.setItem(storageKey, JSON.stringify(doc));
		}
	} catch {
		/* unreadable: leave it, absence must never cascade */
	}
}

/** The registry-listed entries of one map-shaped key, leftovers untouched. */
function surgicalMapRemove(storageKey: string, field: string, doomed: Set<string>): void {
	editMap(storageKey, field, (key, value) => (doomed.has(key) ? REMOVE : value));
}

/** The SYNCHRONOUS wipe of the account's data: everything paint-visible
 *  or localStorage-held. Answers the registry snapshot so the caller can
 *  run the async IDB half. Callable before any state module evaluates. */
export function wipeLocalSync(): SyncRegistry {
	const reg = readSyncRegistry();
	removeAccountEntries(reg);
	removeAccountKeys();
	rawRemove(SHARED_FLAG_KEY);
	removeMarker();
	return reg;
}

/** The account's keys beside its entries: the briefing, the account
 *  session, the registry, and a found copy left by a shared session. A
 *  briefing key `keep` names stays (a shared end's found flights). */
function removeAccountKeys(keep: (key: string) => boolean = () => false): void {
	for (const key of BRIEFING_KEYS) {
		if (!keep(key)) {
			rawRemove(key);
		}
	}
	rawRemove(ACCOUNT_KEY);
	rawRemove(SYNC_REGISTRY_KEY);
	rawRemove(FOUND_KEY);
}

/** The account's own entries in the two map-shaped aircraft keys, and the
 *  tanked grades and the pilot block when the registry lists them: the
 *  personal wipe's scope. */
export function removeAccountEntries(reg: SyncRegistry): void {
	const planes = new Set<string>();
	let wipeFuel = false;
	let wipePilot = false;
	for (const key of Object.keys(reg.docs)) {
		if (key.startsWith('aircraft/')) {
			planes.add(key.slice('aircraft/'.length));
		} else if (key === 'acstate/tanked-fuel') {
			wipeFuel = true;
		} else if (key === PILOT_DOC) {
			wipePilot = true;
		}
	}
	surgicalMapRemove(AIRCRAFT_USER_KEY, 'planes', planes);
	if (wipeFuel) {
		rawRemove(AIRCRAFT_FUEL_KEY);
	}
	if (wipePilot) {
		rawRemove(PILOT_KEY);
	}
}

function removeMarker(): void {
	try {
		sessionStorage.removeItem(SHARED_MARKER_KEY);
	} catch {
		/* no session storage */
	}
}

// --- a SHARED session's end ---------------------------------------------------

/** What a shared session's end judges by, read ONCE before either half
 *  removes anything (the storage half takes the registry and the copy's
 *  key with it): the registry, what the sign-in found (null when its stamp
 *  kept no copy: still owed, refused by storage, or taken by a build before
 *  the copy existed), and whether the stamp is owed. */
export interface SessionEnd {
	reg: SyncRegistry;
	found: FoundCopy | null;
	owed: boolean;
}

/** Read the end's inputs. `owed` defaults to the registry's own debt; the
 *  in-app ends pass the engine's (state/sync.svelte.ts stampOwed), which
 *  also knows a debt storage could not record. */
export function readSessionEnd(owed?: boolean): SessionEnd {
	const reg = readSyncRegistry();
	return { reg, found: readFoundCopy(), owed: owed ?? reg.stampPending === true };
}

/** Which documents a shared session MADE: neither tracked by the registry
 *  nor found at its sign-in (the found copy's keys, which never shrink, and
 *  the registry's held-back set). With no copy, a stamp still OWED has told
 *  nothing apart, so nothing reads as made; with a copy whose rows a store
 *  kept unlisted, no plan or flight does (its storage-held half was taken).
 *  The sign-out valve counts these among the rest (unsentBySession). */
export function madeBySession(end: SessionEnd): (key: string) => boolean {
	const { reg, found, owed } = end;
	if (found === null && owed) {
		return () => false;
	}
	const known = new Set([...(found?.keys ?? []), ...(reg.preexisting ?? [])]);
	return (key) => reg.docs[key] === undefined && !known.has(key) && !rowsUntold(found, key);
}

/** Which untracked documents the next pass PUSHES: the sign-out valve's
 *  rule (state/sync.svelte.ts countPendingDocs), every one of them lost
 *  unsent. The session's own (madeBySession), and two documents its sign-in
 *  found which the session made its pilot's: a plan Stored back over (let
 *  go, syncRegistry releaseHeldBack) and the pilot block typed where the
 *  found one was set aside. The end puts both back as found, so unsent,
 *  that pilot's version is lost with the rest; an edit of a document still
 *  held back was never going to upload, and is not counted. With the stamp
 *  owed it answers by the stamp to come: the copy's keys held back, less
 *  the pilot block set aside and what a Store let go, and nothing at all
 *  while there is no copy to tell anything apart. */
export function unsentBySession(end: SessionEnd): (key: string) => boolean {
	const { reg, found, owed } = end;
	if (found === null && owed) {
		return () => false;
	}
	let held: Set<string>;
	if (owed && found !== null) {
		const released = new Set(reg.released ?? []);
		held = new Set(
			found.keys.filter((k) => !(found.parked && k === PILOT_DOC) && !released.has(k)),
		);
	} else {
		held = new Set(reg.preexisting ?? []);
	}
	return (key) => reg.docs[key] === undefined && !held.has(key) && !rowsUntold(found, key);
}

/** A plan or a flight while the copy's rows are unlisted: no write of one
 *  lands before they are (sync/found.ts ensureFoundComplete), so any such
 *  document is one the sign-in found. */
function rowsUntold(found: FoundCopy | null, key: string): boolean {
	return (
		found !== null &&
		!found.listed &&
		(key.startsWith('plans/') || key.startsWith('outings/'))
	);
}

/** A SHARED session's entries in the three storage-held kinds, settled at
 *  its end. What its sign-in found goes back as found: the pilot block and
 *  the tanked grades whole whatever became of them (a blank block or an
 *  empty map is a value, and the found pilot block was set aside for the
 *  session), the planes entry by entry while the session left them there.
 *  What is the account's (the registry's) or the session's own
 *  (madeBySession) goes; an entry nothing tells apart stays. Reset runs it
 *  over a shared session its settings group ends (state/reset.ts). */
export function settleSessionEntries(end: SessionEnd): void {
	const { reg, found } = end;
	const made = madeBySession(end);
	const theirs = (key: string): boolean => reg.docs[key] !== undefined || made(key);
	editMap(AIRCRAFT_USER_KEY, 'planes', (key, value) => {
		if (found !== null && Object.prototype.hasOwnProperty.call(found.planes, key)) {
			return found.planes[key];
		}
		return theirs(`aircraft/${key}`) ? REMOVE : value;
	});
	if (found?.fuel != null) {
		rawSet(AIRCRAFT_FUEL_KEY, found.fuel);
	} else if (
		reg.docs['acstate/tanked-fuel'] !== undefined ||
		(Object.keys(storedMap(AIRCRAFT_FUEL_KEY, 'types')).length > 0 && made('acstate/tanked-fuel'))
	) {
		rawRemove(AIRCRAFT_FUEL_KEY);
	}
	if (found?.pilot != null) {
		rawSet(PILOT_KEY, found.pilot);
	} else if (reg.docs[PILOT_DOC] !== undefined || (pilotHoldsSomething() && made(PILOT_DOC))) {
		rawRemove(PILOT_KEY);
	}
}

/** The SYNCHRONOUS end of a shared session: its storage-held entries
 *  settled (settleSessionEntries), the account's keys by name, so that
 *  storage failing to enumerate cannot leave them behind, then every other
 *  `loxodrome:` key but the sessionSurvivor ones (preferences, layout,
 *  notices, view state, the briefing, the account and its registry, the
 *  found copy, the preparation inputs, the aircraft selection, anything
 *  unregistered), the shared flag LAST: it is what other tabs react to and
 *  what a boot reads as the session's signature, so it must not go while
 *  anything of the session is left. Takes the end the caller read first
 *  (an in-app end runs the IDB half from it before this). Callable before
 *  any state module evaluates. */
export function wipeSharedSession(end: SessionEnd = readSessionEnd()): SessionEnd {
	settleSessionEntries(end);
	// A flight the sign-in found in the crash copy or the outbox is the
	// device's, unfiled perhaps, and goes back as found with the rest: its
	// keys are the only copy there is until the library files it.
	const foundFlight = (key: string): boolean => holdsFoundTrace(key, end.found);
	removeAccountKeys(foundFlight);
	for (const key of keysWithPrefix(STORAGE_PREFIX)) {
		if (key !== SHARED_FLAG_KEY && !sessionSurvivor(key) && !foundFlight(key)) {
			rawRemove(key);
		}
	}
	removeMarker();
	rawRemove(SHARED_FLAG_KEY);
	return end;
}

/** Delete the registry-listed IndexedDB docs (plans, outings) but `spare`. */
async function removeListedRows(reg: SyncRegistry, spare: ReadonlySet<string>): Promise<void> {
	for (const key of Object.keys(reg.docs)) {
		if (spare.has(key)) {
			continue;
		}
		if (key.startsWith('plans/')) {
			try {
				await deleteStoredPlan(key.slice('plans/'.length));
			} catch {
				/* best-effort */
			}
		} else if (key.startsWith('outings/')) {
			const id = Number(key.slice('outings/'.length));
			if (Number.isFinite(id)) {
				try {
					await deleteOuting(id);
				} catch {
					/* best-effort */
				}
			}
		}
	}
}

/** The ASYNC half: the registry-listed IndexedDB docs (plans, outings).
 *  Flights data is not paint-visible (the surface lists on open), so
 *  this may run after mount; store-level deletes on purpose, tombstone
 *  recording structurally bypassed. */
export async function wipeLocalIdb(reg: SyncRegistry): Promise<void> {
	await removeListedRows(reg, new Set());
}

function samePlan(a: StoredPlan, b: StoredPlan): boolean {
	return a.yaml === b.yaml && a.savedAtMs === b.savedAtMs;
}

function sameMeta(a: OutingMeta, b: OutingMeta): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** The ASYNC half of a SHARED session's end, over the plans and the
 *  flights. Every row is judged on a listing taken BEFORE anything is
 *  deleted, the rows the device held as the end began:
 *  - the account's rows go, as wipeLocalIdb removes them;
 *  - what the session MADE and never synced goes (madeBySession), the
 *    rows the sign-out valve counted as not uploaded, but only a row saved
 *    no later than `untilMs`, the end's own start: what is stored after it
 *    is the next pilot's, should this finish behind the mount (a boot sweep
 *    that waited its bound), and a plan a bundle imports keeps its member's
 *    old time, which only the early listing tells apart;
 *  - what the sign-in FOUND is put back as found, never deleted, even
 *    where the account's own copy came over it under the same id; a found
 *    row the session deleted stays deleted (a flight's points cannot be
 *    put back, and a deletion leaves nothing of the session behind).
 *  The stored copy of the found rows goes last. Best-effort: an unreadable
 *  store keeps its rows. */
export async function wipeSessionIdb(end: SessionEnd, untilMs: number): Promise<void> {
	const { reg, found } = end;
	const made = madeBySession(end);
	const foundKeys = new Set(found?.keys ?? []);
	const originals = found?.rows === true ? await readFoundRows() : null;
	let plans: StoredPlan[] = [];
	let metas: OutingMeta[] = [];
	try {
		plans = await getStoredPlansStrict();
	} catch {
		/* unreadable: its rows stay */
	}
	try {
		metas = await getMetasStrict();
	} catch {
		/* unreadable: its rows stay */
	}
	await removeListedRows(reg, foundKeys);
	for (const plan of plans) {
		const key = `plans/${plan.id}`;
		if (foundKeys.has(key)) {
			const was = originals?.get(key)?.plan;
			if (was && !samePlan(was, plan)) {
				await putStoredPlan(was).catch(() => undefined);
			}
		} else if (plan.savedAtMs <= untilMs && made(key)) {
			await deleteStoredPlan(plan.id).catch(() => undefined);
		}
	}
	for (const meta of metas) {
		const key = `outings/${meta.id}`;
		if (foundKeys.has(key)) {
			const was = originals?.get(key)?.meta;
			if (was && !sameMeta(was, meta)) {
				await putMeta(was).catch(() => undefined);
			}
		} else if (meta.savedAtMs <= untilMs && made(key)) {
			await deleteOuting(meta.id).catch(() => undefined);
		}
	}
	await clearFoundRows();
}
