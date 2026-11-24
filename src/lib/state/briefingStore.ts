/* The NOTAM briefing kept across a restart: one record in the IndexedDB
 * database loxodrome-briefing, valid only while the briefing-class key
 * loxodrome:notam-briefing holds its id. Every wipe of that class (Reset's
 * briefing group, a sign-out's wipe, a shared session's end, the boot sweep)
 * removes the key, so the record it leaves is refused and deleted at the
 * next read. A write sets the key before it opens the database, so a read
 * that finds no key finds no write under way either. IndexedDB rather than
 * localStorage: the recording's crash copy
 * fills the origin's localStorage quota, and a briefing beside it would take
 * the room that copy's writes need.
 *
 * A LEAF at run time (types only from the NOTAM state): the wipes in
 * sync/wipe.ts run before any state module evaluates, and delete it too.
 * The flight app alone reads and writes it (state/briefingKeep.ts), so the
 * NOTAM Viewer never opens the database. */

import { readItem, removeItem, storageSealed, writeItem } from './persist';
import type { AerodromeFetch, BriefingSnapshot } from './notam.svelte';

/** The key holding the kept record's id. */
export const BRIEFING_KEY = 'loxodrome:notam-briefing';

const DB_NAME = 'loxodrome-briefing';
const DB_VERSION = 1;
const STORE = 'briefing';
/** The one record's key in its store. */
const RECORD = 'current';

const HOUR_MS = 3_600_000;
/** A fetched briefing is kept until the period it covers ends, this long
 *  after its fetch at most. */
export const KEEP_FETCHED_MS = 48 * HOUR_MS;
/** A bulletin pasted or opened is kept this long after it was loaded: it
 *  states no period of its own. */
export const KEEP_BY_HAND_MS = 24 * HOUR_MS;

/** The record's shape version: a record of another is dropped at the read,
 *  never parsed. Records written before it was stamped are the first. */
const RECORD_V = 1;

/** Set by disarmBriefingStore: a wipe leaving the page is under way. */
let disarmed = false;

/** Stand the writes down for a wipe that leaves the page (Reset, a
 *  sign-out's wipe, a shared session's end, a sign-in over one), as
 *  disarmRoutesPersist stands the route writer down. No write starts any
 *  more, and one under way puts nothing once it has opened the database:
 *  the wipe's awaits run before its seal, and a write landing in them
 *  would mint a key and bring the briefing back at the next boot. */
export function disarmBriefingStore(): void {
	disarmed = true;
}

interface StoredRecord {
	key: typeof RECORD;
	v?: typeof RECORD_V;
	id: string;
	savedAt: number;
	doc: BriefingSnapshot;
}

/** The instant a kept briefing is dropped: the end of the period it covers,
 *  at most KEEP_FETCHED_MS after its fetch, or KEEP_BY_HAND_MS after a
 *  bulletin loaded by hand. A briefing of aerodrome fetches alone is judged
 *  by the newest of them. */
export function briefingKeptUntil(doc: BriefingSnapshot): number {
	if (doc.byHand) {
		return doc.byHand.at + KEEP_BY_HAND_MS;
	}
	const f = doc.lastFetch ?? newest(doc.aerodromeFetches);
	if (!f) {
		return 0;
	}
	return Math.min(f.at + KEEP_FETCHED_MS, f.briefed?.to ?? Infinity);
}

function newest(fetches: Record<string, AerodromeFetch>): AerodromeFetch | null {
	let out: AerodromeFetch | null = null;
	for (const f of Object.values(fetches)) {
		if (!out || f.at > out.at) {
			out = f;
		}
	}
	return out;
}

function open(healed = false): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		if (typeof indexedDB === 'undefined') {
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			reject(new Error('indexedDB unavailable'));
			return;
		}
		// Set once this promise has failed: a request completing later
		// opens nothing it would leave open. A connection nobody closes
		// blocks every later deletion, and every open queues behind that.
		let failed = false;
		const fail = (err: Error) => {
			failed = true;
			reject(err);
		};
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(STORE)) {
				req.result.createObjectStore(STORE, { keyPath: 'key' });
			}
		};
		req.onsuccess = () => {
			const db = req.result;
			if (failed) {
				db.close();
				return;
			}
			// A deletion asked elsewhere (a wipe, a Clear, another tab)
			// waits on none of our connections.
			db.onversionchange = () => db.close();
			if (db.objectStoreNames.contains(STORE) || healed) {
				resolve(db);
				return;
			}
			// Opened elsewhere at our version with no upgrade (a probe
			// naming the database), it holds no store and every transaction
			// throws: deleted, then opened afresh, which creates the store.
			db.close();
			const del = indexedDB.deleteDatabase(DB_NAME);
			del.onsuccess = () => {
				if (!failed) {
					open(true).then(resolve, reject);
				}
			};
			// i18n-ignore: wire diagnostic, stays EN
			del.onerror = () => fail(new Error('briefing store reset failed'));
			// i18n-ignore: wire diagnostic, stays EN
			del.onblocked = () => fail(new Error('briefing store blocked'));
		};
		// i18n-ignore: wire diagnostic, stays EN
		req.onerror = () => fail(new Error('briefing store open failed'));
		// i18n-ignore: wire diagnostic, stays EN
		req.onblocked = () => fail(new Error('briefing store blocked'));
	});
}

function txDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		// i18n-ignore: wire diagnostic, stays EN
		tx.onerror = () => reject(new Error('briefing store transaction failed'));
		// i18n-ignore: wire diagnostic, stays EN
		tx.onabort = () => reject(new Error('briefing store transaction aborted'));
	});
}

/** Keep `doc`, or drop what is kept when it is null. Best-effort. The id
 *  is the key's while it holds one, so only the first write after a wipe
 *  writes the key, and a write that fails leaves the record as it was.
 *  Nothing lands once storage is sealed (a reset or a session's end
 *  leaving the page) or the store disarmed. */
export async function writeStoredBriefing(doc: BriefingSnapshot | null): Promise<void> {
	if (storageSealed() || disarmed) {
		return;
	}
	if (!doc) {
		removeItem(BRIEFING_KEY);
		await deleteStoredBriefing();
		return;
	}
	let id = readItem(BRIEFING_KEY);
	if (!id) {
		id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		writeItem(BRIEFING_KEY, id);
	}
	let db: IDBDatabase | null = null;
	try {
		db = await open();
		if (disarmed) {
			return;
		}
		const tx = db.transaction(STORE, 'readwrite');
		const record: StoredRecord = { key: RECORD, v: RECORD_V, id, savedAt: Date.now(), doc };
		tx.objectStore(STORE).put(record);
		await txDone(tx);
	} catch {
		/* the briefing stays in memory only */
	} finally {
		db?.close();
	}
}

/** Is `record` the kept briefing at `nowMs`? */
function kept(record: StoredRecord, nowMs: number): boolean {
	return (
		record.id === readItem(BRIEFING_KEY) &&
		(record.v ?? RECORD_V) === RECORD_V &&
		typeof record.doc?.text === 'string' &&
		briefingKeptUntil(record.doc) > nowMs
	);
}

/** The kept briefing, or null: none kept, its key gone or naming another
 *  record, or kept past briefingKeptUntil. `restore`, when given, takes it
 *  inside the read. A record refused, or one `restore` throws on, is
 *  deleted in the transaction that read it, the key left as it is: a
 *  briefing written meanwhile lands after the delete and stands, and the
 *  boot goes on. */
export async function readStoredBriefing(
	nowMs: number,
	restore?: (doc: BriefingSnapshot) => void,
): Promise<BriefingSnapshot | null> {
	if (!readItem(BRIEFING_KEY)) {
		await deleteStoredBriefing();
		return null;
	}
	let db: IDBDatabase | null = null;
	try {
		db = await open();
		const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
		return await new Promise<BriefingSnapshot | null>((resolve, reject) => {
			const req = store.get(RECORD);
			req.onsuccess = () => {
				const record = req.result as StoredRecord | undefined;
				try {
					if (record && kept(record, nowMs)) {
						restore?.(record.doc);
						resolve(record.doc);
						return;
					}
				} catch {
					/* refused below */
				}
				if (record) {
					store.delete(RECORD);
				}
				resolve(null);
			};
			// i18n-ignore: wire diagnostic, stays EN
			req.onerror = () => reject(new Error('briefing store read failed'));
		});
	} catch {
		return null;
	} finally {
		db?.close();
	}
}

/** Delete the database, the kept briefing with it. Best-effort, never
 *  rejects: a deletion another connection blocks completes when it
 *  closes. */
export function deleteStoredBriefing(): Promise<void> {
	return new Promise((resolve) => {
		try {
			if (typeof indexedDB === 'undefined') {
				resolve();
				return;
			}
			const req = indexedDB.deleteDatabase(DB_NAME);
			req.onsuccess = () => resolve();
			req.onerror = () => resolve();
			req.onblocked = () => resolve();
		} catch {
			resolve();
		}
	});
}
