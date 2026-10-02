/* What a SHARED session's sign-in FOUND on the device, as found
 * (docs/accounts-sync.md, "The wipe knows what is the account's"), kept so
 * that the session's end puts it back as it was. On a club PC the documents
 * the stamp holds back are another pilot's, or the club's own, and nothing
 * the session did to them may outlive it: an edit typed over one, a Store
 * written back over a found plan, the account's own copy pulled over one
 * under the same id (which the end used to take away with the account's
 * data). The stamp takes the copy (state/sync.svelte.ts), every shared end
 * reads it before anything is removed and puts each found document back
 * (sync/wipe.ts), and the end drops it with the session.
 *
 * Two halves, as the end has: the storage-held kinds (the pilot block, the
 * tanked grades, the planes) RAW under FOUND_KEY, which the boot sweep's
 * synchronous half restores before the first paint; the plans' and flights'
 * rows in a sync-owned IndexedDB store, which the asynchronous half reads.
 * The flights database keeps its shape: sync bookkeeping lives in sync-owned
 * storage. A copy that cannot be kept is no copy: the session then ends as
 * it did before the copy existed.
 *
 * The copy is taken from the STORES, never from a document's memory, which
 * is what lets a sign-in over another pilot's session take it in the old
 * document, right after that session's end and under the same lock: what
 * the device holds then is exactly what the new sign-in finds, and no
 * stamp is left owed for the new session's own work to be taken for found.
 * A store that cannot be read at the sign-in leaves the rows unlisted
 * (`listed` false, the stamp owed), the storage-held half taken at once.
 * No write of a plan or a flight lands while a copy is missing its rows:
 * the flights store awaits ensureFoundComplete first, which completes the
 * copy, so what it lists is exactly what the sign-in found and every found
 * row is copied before the session can change it. The traces the device
 * held unfiled at the sign-in (the live one stopped, the parked outbox's)
 * are found too, by the outing ids they will file under, so the flights
 * library filing one during the session files the device's flight, held
 * back from the account and kept at the end.
 *
 * Import discipline: the boot sweep's (sync/wipe.ts), leaves only. */

import { FOUND_KEY, FOUND_LOCK } from './keys';
import {
	getMetasStrict,
	getStoredPlansStrict,
	setWriteGuard,
	type OutingMeta,
	type StoredPlan,
} from '$lib/state/flightsDb';

/** The three storage-held library keys the device wipe and the found copy
 *  edit raw, their owners being state modules the boot sweep may not load:
 *  the pilot block, the user planes ({v: 1, planes}) and the tanked grades
 *  ({v: 1, types}). */
export const PILOT_KEY = 'loxodrome:pilot';
export const AIRCRAFT_USER_KEY = 'loxodrome:aircraft-user';
export const AIRCRAFT_FUEL_KEY = 'loxodrome:aircraft-fuel';
/** The live trace's crash copy and the parked-flight outbox
 *  (state/navRecording.svelte.ts): the trace on the map, and a finished
 *  flight held back for the flights library to file. */
const TRACE_KEY = 'loxodrome:nav-trace';
const PARKED_TRACE_KEY = 'loxodrome:nav-trace-parked';
/** A blank pilot block, as state/flightPrep.svelte.ts stores one. */
const BLANK_PILOT = JSON.stringify({ name: '', sepValidUntil: null, medicalValidUntil: null });

/** The pilot block's own doc key, the one found document a shared session
 *  sets aside rather than holds back (state/sync.svelte.ts). */
export const PILOT_DOC = 'pilot/pilot';

export interface FoundCopy {
	v: 1;
	/** The account whose sign-in took it: a same-account sign-in inside the
	 *  session keeps it, or the session's own unsynced work would be taken
	 *  for found. */
	userId: string;
	/** Every doc key the sign-in found, the held-back set as it was taken.
	 *  It never shrinks, where the registry's `preexisting` does (a plan
	 *  Stored, the account's copy pulled over a found one). */
	keys: string[];
	/** The stored pilot block and tanked grades as found, raw; null when
	 *  the sign-in found none. */
	pilot: string | null;
	fuel: string | null;
	/** Whether the found pilot block was set aside for the session (the
	 *  stamp's last step, so a stamp retried after a failure knows). */
	parked: boolean;
	/** The found planes, entry by entry, as stored. */
	planes: Record<string, unknown>;
	/** The live trace the sign-in found STOPPED, by its first fix (the
	 *  outing id it files under): no shared session extends it. */
	trace: number | null;
	/** Whether the plans' and flights' rows were LISTED and copied: false
	 *  while a store the sign-in could not read keeps them unlisted, the
	 *  stamp owed and every write of a plan or a flight held back until the
	 *  copy is whole (ensureFoundComplete). */
	listed: boolean;
	/** Whether the found plans' and flights' rows are in the store below. */
	rows: boolean;
}

/** One found plan or flight row, as the flights store holds it. */
export interface FoundRow {
	key: string;
	plan?: StoredPlan;
	meta?: OutingMeta;
}

let cache: { raw: string | null; copy: FoundCopy | null } = { raw: null, copy: null };

function parse(raw: string | null): FoundCopy | null {
	if (raw === null) {
		return null;
	}
	try {
		const c = JSON.parse(raw) as Partial<FoundCopy> | null;
		if (
			!c ||
			c.v !== 1 ||
			typeof c.userId !== 'string' ||
			!Array.isArray(c.keys) ||
			!c.planes ||
			typeof c.planes !== 'object'
		) {
			return null;
		}
		return {
			v: 1,
			userId: c.userId,
			keys: c.keys.filter((k) => typeof k === 'string'),
			pilot: typeof c.pilot === 'string' ? c.pilot : null,
			fuel: typeof c.fuel === 'string' ? c.fuel : null,
			parked: c.parked === true,
			planes: c.planes,
			trace: typeof c.trace === 'number' && Number.isFinite(c.trace) ? c.trace : null,
			listed: c.listed !== false,
			rows: c.rows === true,
		};
	} catch {
		return null;
	}
}

/** The copy as stored, or null; parsed once per stored value, since the
 *  flight button asks it at every decision (foundTrace). Read-only. */
export function readFoundCopy(): FoundCopy | null {
	let raw: string | null;
	try {
		raw = localStorage.getItem(FOUND_KEY);
	} catch {
		return null;
	}
	if (raw !== cache.raw) {
		cache = { raw, copy: parse(raw) };
	}
	return cache.copy;
}

/** Store the copy; false when storage refused it. */
export function writeFoundCopy(copy: FoundCopy): boolean {
	try {
		localStorage.setItem(FOUND_KEY, JSON.stringify(copy));
		return true;
	} catch {
		return false;
	}
}

/** The trace a shared session's sign-in found stopped (its first fix), or
 *  null: the flight button never extends it (state/flightAction). */
export function foundTrace(): number | null {
	return readFoundCopy()?.trace ?? null;
}

/** Whether the flight that files under `id` is one a shared session's
 *  sign-in found: the device's, whose filing during the session puts no
 *  workspace plan beside it (state/flightLibrary.svelte.ts). */
export function foundOuting(id: number): boolean {
	return readFoundCopy()?.keys.includes(`outings/${id}`) ?? false;
}

function rawItem(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

/** The entries of one map-shaped key ({v: 1, <field>: Record<key, ...>});
 *  none when it is absent or unreadable. */
export function storedMap(storageKey: string, field: string): Record<string, unknown> {
	try {
		const raw = localStorage.getItem(storageKey);
		const doc = raw === null ? null : (JSON.parse(raw) as ({ v?: number } & Record<string, unknown>) | null);
		const map = doc?.[field];
		return doc && doc.v === 1 && map && typeof map === 'object' ? (map as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Whether the stored pilot block holds anything: a blank one is no
 *  document (the sync listing's own rule, sync/adapters.ts isDefaultPilot). */
export function pilotHoldsSomething(): boolean {
	try {
		const raw = localStorage.getItem(PILOT_KEY);
		if (raw === null) {
			return false;
		}
		const p = JSON.parse(raw) as Record<string, unknown> | null;
		return (
			!!p &&
			typeof p === 'object' &&
			((typeof p.name === 'string' && p.name !== '') ||
				typeof p.sepValidUntil === 'string' ||
				typeof p.medicalValidUntil === 'string')
		);
	} catch {
		return false;
	}
}

/** The flight a trace doc holds (the crash copy, the outbox), by the
 *  outing id it files under (its first fix), or null. */
function traceIdAt(storageKey: string): number | null {
	try {
		const raw = localStorage.getItem(storageKey);
		const doc = raw === null ? null : (JSON.parse(raw) as { points?: unknown } | null);
		if (!doc || !Array.isArray(doc.points)) {
			return null;
		}
		let first: number | null = null;
		for (const p of doc.points as { timeMs?: unknown }[]) {
			const t = p?.timeMs;
			if (typeof t === 'number' && Number.isFinite(t) && (first === null || t < first)) {
				first = t;
			}
		}
		return first;
	} catch {
		return null;
	}
}

/** Whether the trace doc under `storageKey` holds a flight `copy` found:
 *  the device's, unfiled or not, which a shared session's end leaves where
 *  it is (sync/wipe.ts wipeSharedSession). */
export function holdsFoundTrace(storageKey: string, copy: FoundCopy | null): boolean {
	if (copy === null || (storageKey !== TRACE_KEY && storageKey !== PARKED_TRACE_KEY)) {
		return false;
	}
	const id = traceIdAt(storageKey);
	return id !== null && copy.keys.includes(`outings/${id}`);
}

function rowKeys(rows: readonly FoundRow[]): string[] {
	return rows.map((r) => r.key);
}

/** The plans' and flights' rows, as the flights store holds them; throws
 *  when the store cannot be read. */
async function listRows(): Promise<FoundRow[]> {
	const out: FoundRow[] = [];
	for (const plan of await getStoredPlansStrict()) {
		out.push({ key: `plans/${plan.id}`, plan });
	}
	for (const meta of await getMetasStrict()) {
		out.push({ key: `outings/${meta.id}`, meta });
	}
	return out;
}

/** Take the copy of what a shared sign-in found, from the STORES: the
 *  storage-held kinds raw (each plane, the grades when they hold any, the
 *  pilot block when it holds anything: the sync listing's own rules), the
 *  traces the device held, filed or not (the live one, the caller's
 *  stopped `trace` and the crash copy's, and the parked outbox's), and the
 *  plans' and flights' rows, copied into the sync-owned store. The crash
 *  copy is passed over while a recording runs in any tab (`flying`): that
 *  flight is the session's, whose stamp can come late. The storage-held
 *  half is stored FIRST, so a write landing while the rows are read
 *  completes the copy before it does (ensureFoundComplete); a store that
 *  cannot be read leaves the copy incomplete, the rows unlisted. Answers
 *  the copy, and whether storage kept it (when it did not, the keys a
 *  listing gives are still answered, for a stamp to hold back without a
 *  copy). */
export async function takeFoundCopy(
	userId: string,
	trace: number | null,
	flying = false,
): Promise<{ copy: FoundCopy; stored: boolean }> {
	const stored = storedMap(AIRCRAFT_USER_KEY, 'planes');
	const keys = Object.keys(stored).map((k) => `aircraft/${k}`);
	if (Object.keys(storedMap(AIRCRAFT_FUEL_KEY, 'types')).length > 0) {
		keys.push('acstate/tanked-fuel');
	}
	if (pilotHoldsSomething()) {
		keys.push(PILOT_DOC);
	}
	const live = trace ?? (flying ? null : traceIdAt(TRACE_KEY));
	for (const id of [trace, flying ? null : traceIdAt(TRACE_KEY), traceIdAt(PARKED_TRACE_KEY)]) {
		if (id !== null) {
			keys.push(`outings/${id}`);
		}
	}
	const copy: FoundCopy = {
		v: 1,
		userId,
		keys: [...new Set(keys)],
		pilot: keys.includes(PILOT_DOC) ? rawItem(PILOT_KEY) : null,
		fuel: keys.includes('acstate/tanked-fuel') ? rawItem(AIRCRAFT_FUEL_KEY) : null,
		parked: false,
		planes: { ...stored },
		trace: live,
		listed: false,
		rows: false,
	};
	if (!writeFoundCopy(copy)) {
		try {
			const found = await listRows();
			return {
				copy: { ...copy, keys: [...new Set([...copy.keys, ...rowKeys(found)])], listed: true },
				stored: false,
			};
		} catch {
			return { copy, stored: false };
		}
	}
	try {
		return await completeFoundCopy(copy);
	} catch {
		return { copy, stored: true }; // unreadable: the rows wait
	}
}

let fallbackTail: Promise<unknown> = Promise.resolve();

/** Run `fn` holding FOUND_LOCK, the copy's own: what it reads of the copy
 *  and writes back is one step whichever tab takes it. Without the Web
 *  Locks API, an in-module queue, the single-tab truth (the registry's own
 *  fallback, state/syncRegistry.ts). */
function withFoundLock<T>(fn: () => Promise<T>): Promise<T> {
	const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
	if (!locks) {
		const run = fallbackTail.then(fn, fn);
		fallbackTail = run.catch(() => {
			/* the queue survives a failed task */
		});
		return run;
	}
	return locks.request(FOUND_LOCK, { mode: 'exclusive' }, fn);
}

/** List and copy the rows a copy is missing, under the copy's lock: what
 *  the stores hold now is what the sign-in found, no write having landed
 *  since (the guard below), and no other tab completes it in between.
 *  Throws while the store still cannot be read; answers the copy still
 *  incomplete when its rows could not be copied. Only ever over the copy it
 *  completes, read again inside the lock: another tab may have completed
 *  it, or an end taken it, and a copy written back after its session would
 *  be read as the next one's. */
export function completeFoundCopy(
	copy: FoundCopy,
): Promise<{ copy: FoundCopy; stored: boolean }> {
	return withFoundLock(async () => {
		const now = readFoundCopy();
		if (now === null || now.userId !== copy.userId) {
			return { copy, stored: false };
		}
		if (now.listed) {
			return { copy: now, stored: true }; // completed meanwhile, here or elsewhere
		}
		const found = await listRows();
		if (!(await saveFoundRows(found))) {
			return { copy: now, stored: true };
		}
		// Read once more before writing: an end does not wait for this lock
		// (the boot sweep's half is synchronous), and one that took the copy
		// during the listing must not see it written back, nor its rows left.
		const current = readFoundCopy();
		if (current === null) {
			await clearFoundRows();
			return { copy: now, stored: false };
		}
		if (current.userId !== now.userId) {
			return { copy: now, stored: false };
		}
		const next: FoundCopy = {
			...current,
			keys: [...new Set([...current.keys, ...rowKeys(found)])],
			listed: true,
			rows: true,
		};
		return { copy: next, stored: writeFoundCopy(next) };
	});
}

let completing: Promise<void> | null = null;

/** The flights store's write guard (state/flightsDb.ts setWriteGuard,
 *  installed below, so in every document that loads this module, the boot
 *  sweep's included): while a shared session's found copy is missing its
 *  plans' and flights' rows, the first write completes it before landing,
 *  so the copy lists exactly what the sign-in found, nothing of the
 *  session's own among it, and holds every found row as it was before the
 *  session could change it. A copy that still cannot be completed fails
 *  the write, as the store it could not read would have: the session's
 *  work stays where it was, a plan in its workspace, a flight in its crash
 *  copy, the next boot's outbox or the next pass. One completion at a time
 *  per document; a copy already whole costs one cached read. */
export function ensureFoundComplete(): Promise<void> {
	const copy = readFoundCopy();
	if (copy === null || copy.listed) {
		return Promise.resolve();
	}
	completing ??= completeFoundCopy(copy)
		.then(() => {
			// The write goes ahead once no copy is left missing its rows: this
			// one completed, or gone with an end in the meantime.
			if (readFoundCopy()?.listed === false) {
				// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
				throw new Error('sync: found copy incomplete');
			}
		})
		.finally(() => {
			completing = null;
		});
	return completing;
}

setWriteGuard(ensureFoundComplete);

/** Set the found pilot block aside for the session, raw: a blank block
 *  where it was, while it still holds what was found (one the session
 *  already typed over is no longer the found one to set aside). Under the
 *  copy's lock, over the copy as stored then, so a completion running
 *  beside it keeps the mark. Answers the copy, noted `parked` when it was
 *  (the caller brings a document's memory along, state/flightPrep.svelte.ts
 *  clearPilot). */
export function parkFoundPilot(copy: FoundCopy): Promise<FoundCopy> {
	return withFoundLock(() => {
		const now = readFoundCopy();
		if (
			now === null ||
			now.userId !== copy.userId ||
			now.pilot === null ||
			now.parked ||
			rawItem(PILOT_KEY) !== now.pilot
		) {
			return Promise.resolve(now ?? copy);
		}
		try {
			localStorage.setItem(PILOT_KEY, BLANK_PILOT);
		} catch {
			return Promise.resolve(now);
		}
		const next = { ...now, parked: true };
		writeFoundCopy(next);
		return Promise.resolve(next);
	});
}

// --- the rows: a sync-owned IndexedDB store ---------------------------------

const DB_NAME = 'loxodrome-sync';
const DB_VERSION = 1;
const STORE = 'found';

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		if (typeof indexedDB === 'undefined') {
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			reject(new Error('indexedDB unavailable'));
			return;
		}
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(STORE)) {
				req.result.createObjectStore(STORE, { keyPath: 'key' });
			}
		};
		req.onsuccess = () => resolve(req.result);
		// i18n-ignore: wire diagnostic, stays EN
		req.onerror = () => reject(new Error('found store open failed'));
		// i18n-ignore: wire diagnostic, stays EN
		req.onblocked = () => reject(new Error('found store blocked'));
	});
}

function txDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		// i18n-ignore: wire diagnostic, stays EN
		tx.onerror = () => reject(new Error('found store transaction failed'));
		// i18n-ignore: wire diagnostic, stays EN
		tx.onabort = () => reject(new Error('found store transaction aborted'));
	});
}

/** Replace the stored rows with `rows`, in one transaction (a stale copy
 *  from an end that never finished goes with it); false on any failure. */
export async function saveFoundRows(rows: readonly FoundRow[]): Promise<boolean> {
	let db: IDBDatabase | null = null;
	try {
		db = await open();
		const tx = db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		store.clear();
		for (const row of rows) {
			store.put(row);
		}
		await txDone(tx);
		return true;
	} catch {
		return false;
	} finally {
		db?.close();
	}
}

/** The stored rows by doc key, or null when the store cannot be read. */
export async function readFoundRows(): Promise<Map<string, FoundRow> | null> {
	let db: IDBDatabase | null = null;
	try {
		db = await open();
		const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
		const all = await new Promise<FoundRow[]>((resolve, reject) => {
			req.onsuccess = () => resolve(req.result as FoundRow[]);
			// i18n-ignore: wire diagnostic, stays EN
			req.onerror = () => reject(new Error('found store read failed'));
		});
		return new Map(all.map((r) => [r.key, r]));
	} catch {
		return null;
	} finally {
		db?.close();
	}
}

/** Drop the stored rows, the database with them: nothing of the copy
 *  outlives the session. Best-effort; never rejects. */
export function clearFoundRows(): Promise<void> {
	return new Promise((resolve) => {
		try {
			if (typeof indexedDB === 'undefined') {
				resolve();
				return;
			}
			const req = indexedDB.deleteDatabase(DB_NAME);
			req.onsuccess = () => resolve();
			req.onerror = () => resolve();
			// Another connection still open: the deletion completes when it
			// closes; nobody need wait for it.
			req.onblocked = () => resolve();
		} catch {
			resolve();
		}
	});
}
