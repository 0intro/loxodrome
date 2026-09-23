/* The sync registry (docs/accounts-sync.md, "The protocol"): the
 * device's sync bookkeeping in `loxodrome:sync`, a LEAF module beside
 * persist.ts so the delete chokepoints across the state tree can record
 * tombstones without an import cycle. localStorage on purpose, the
 * tombstones especially: an IndexedDB eviction must not take the record
 * of a real deletion with it, and an eviction itself records nothing.
 *
 * DELETE versus DEVICE-WIPE is the invariant this module's API shape
 * carries: only user-intent deletions call recordSyncTombstone (a row's
 * Delete, a plan's Delete, dropping a user plane, a supersede). The
 * device-wipe paths (sign-out wipe, the shared boot sweep, Reset) remove
 * local data through the store-level deletes and NEVER this API: wiping
 * a club PC must not delete the account's data on the server.
 *
 * Every mutation runs under the exclusive WRITER Web Lock: localStorage
 * has no transactions and two tabs are ordinary in this PWA, so an
 * unserialized read-modify-write could clobber revs or erase a freshly
 * recorded tombstone, resurrecting a deleted record. Where the Web Locks
 * API is absent (node specs shim it; no supported platform lacks it) the
 * wrapper degrades to an in-module queue, the single-tab truth. */

import { WRITER_LOCK, SYNC_REGISTRY_KEY } from '$lib/sync/keys';
import { newUuid } from '$lib/sync/fingerprint';
import { SYNC_COLLECTIONS, type BlobRef, type SyncCollection } from '$lib/sync/model';
import { readJson, writeJson } from './persist';

/** One synced doc's bookkeeping: the server rev adopted, the content
 *  hash last synced, the cheap outing fingerprint, the blob refs already
 *  uploaded, and the fetch-retry counter that stops a wrongly-addressed
 *  blob's discard-and-refetch loop. */
export interface RegistryDocEntry {
	rev: number;
	hash: string;
	fp?: string;
	blobs?: BlobRef[];
	/** The wire doc meta for blob-carrying docs (which ref is the points
	 *  and which the pristine source): what the on-demand fetch decodes
	 *  by. */
	meta?: Record<string, unknown>;
	tries?: number;
}

/** A recorded local deletion awaiting its push; dropped once the server
 *  acknowledges it. Carries the server rev the entry held when the
 *  delete happened, since the entry itself is gone by push time (the
 *  tombstone's baseRev). */
export interface RegistryTombstone {
	col: SyncCollection;
	id: string;
	updatedAt: number;
	rev: number;
}

export interface SyncRegistry {
	v: 1;
	deviceId: string;
	lastSeq: number;
	docs: Record<string, RegistryDocEntry>;
	tombstones: RegistryTombstone[];
	/** The doc keys held back from adoption: stamped at a sign-in that
	 *  found pre-existing local data (every one of them in shared mode,
	 *  the not-yet-confirmed set in personal), cleared by the merge
	 *  confirm's "add". A doc key in here never pushes
	 *  (docs/accounts-sync.md, the provenance rule). */
	preexisting?: string[];
}

/** The registry's per-doc key. */
export function docKey(col: SyncCollection, id: string): string {
	return `${col}/${id}`;
}

function freshRegistry(): SyncRegistry {
	return { v: 1, deviceId: '', lastSeq: 0, docs: {}, tombstones: [] };
}

/** The registry as stored, validated field-by-field; a missing or
 *  malformed doc reads as fresh (convergence is by content, so a lost
 *  registry heals through the reconcile, never through guesswork). */
export function readSyncRegistry(): SyncRegistry {
	const stored = readJson<Partial<SyncRegistry>>(SYNC_REGISTRY_KEY);
	if (!stored || stored.v !== 1) {
		return freshRegistry();
	}
	const out = freshRegistry();
	if (typeof stored.deviceId === 'string') {
		out.deviceId = stored.deviceId;
	}
	if (typeof stored.lastSeq === 'number' && Number.isFinite(stored.lastSeq)) {
		out.lastSeq = stored.lastSeq;
	}
	if (stored.docs && typeof stored.docs === 'object') {
		for (const [key, e] of Object.entries(stored.docs)) {
			if (
				e &&
				typeof e === 'object' &&
				typeof e.rev === 'number' &&
				typeof e.hash === 'string'
			) {
				out.docs[key] = e;
			}
		}
	}
	if (Array.isArray(stored.tombstones)) {
		for (const t of stored.tombstones) {
			if (
				t &&
				(SYNC_COLLECTIONS as readonly string[]).includes(t.col) &&
				typeof t.id === 'string'
			) {
				out.tombstones.push({
					col: t.col,
					id: t.id,
					updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : 0,
					rev: typeof t.rev === 'number' ? t.rev : 0,
				});
			}
		}
	}
	if (Array.isArray(stored.preexisting)) {
		out.preexisting = stored.preexisting.filter((k) => typeof k === 'string');
	}
	return out;
}

/** Write the registry back. CALLER MUST HOLD the writer lock (or be a
 *  spec): the engine's sync pass takes withSyncWriter ONCE and uses
 *  read + write directly inside it, since the exclusive lock is not
 *  reentrant and a nested request would deadlock. Everything outside a
 *  held pass goes through mutateSyncRegistry instead. */
export function writeSyncRegistry(reg: SyncRegistry): void {
	writeJson(SYNC_REGISTRY_KEY, reg);
}

// Serialize registry mutations when the Web Locks API is missing (node
// specs, nothing shipped): a promise chain is the single-tab degradation.
let fallbackTail: Promise<unknown> = Promise.resolve();

/** Run `fn` holding the exclusive writer lock. Every sync pass and every
 *  registry mutation goes through here. */
export async function withSyncWriter<T>(fn: () => T | Promise<T>): Promise<T> {
	const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
	if (!locks) {
		const run = fallbackTail.then(fn, fn);
		fallbackTail = run.catch(() => {
			/* the queue survives a failed task */
		});
		return run;
	}
	return locks.request(WRITER_LOCK, { mode: 'exclusive' }, async () => fn());
}

/** Mutate the registry atomically under the writer lock. Never call
 *  from code already inside withSyncWriter (see writeSyncRegistry). */
export async function mutateSyncRegistry(fn: (reg: SyncRegistry) => void): Promise<void> {
	await withSyncWriter(() => {
		const reg = readSyncRegistry();
		fn(reg);
		writeSyncRegistry(reg);
	});
}

/** The device id, minted lazily on first need (a device that never signs
 *  in never stores one). */
export async function ensureDeviceId(): Promise<string> {
	let id = readSyncRegistry().deviceId;
	if (id !== '') {
		return id;
	}
	await mutateSyncRegistry((reg) => {
		if (reg.deviceId === '') {
			reg.deviceId = newUuid();
		}
		id = reg.deviceId;
	});
	return id;
}

/** Record a USER-INTENT deletion of a synced doc. A doc with no registry
 *  entry is not the account's (never adopted, or the device is signed
 *  out): deleting it is purely local and records nothing, which is what
 *  keeps this call free to sit on every delete chokepoint today, ahead
 *  of the engine existing. Fire-and-forget from synchronous callers;
 *  the writer lock orders concurrent records. */
export async function recordSyncTombstone(col: SyncCollection, id: string): Promise<void> {
	await mutateSyncRegistry((reg) => {
		const key = docKey(col, id);
		const entry = reg.docs[key];
		if (!entry) {
			return;
		}
		delete reg.docs[key];
		if (!reg.tombstones.some((t) => t.col === col && t.id === id)) {
			reg.tombstones.push({ col, id, updatedAt: Date.now(), rev: entry.rev });
		}
	});
}
