/* The sync engine (docs/accounts-sync.md): the pass runner over the
 * pure replicator, the lifecycle flows (adoption, sign-out, the shared
 * expiry), the blob trickle, and the status the Account group renders.
 * Downstream of every state module (the appliers and adapters it wires
 * reach across the whole tree); nothing imports it back except the UI
 * and SyncHost.
 *
 * Standing rules, each the contract's: a pass never runs while
 * `nav.recording` (sync never blocks or delays a flight) nor while the
 * batch importer runs; the whole pass holds the exclusive WRITER lock
 * and the registry is written ONCE at its end, so an aborted pass
 * (a busy plans store, a network drop) leaves lastSeq untouched and the
 * next trigger simply replays idempotently; 'network' failures are the
 * quiet offline state, a 401 flips the signed-out badge, and quota
 * codes surface once through the errorText wording at render. */

import {
	landOutingBlobs,
	listLocalDocs,
	refileDoc,
	applyWireDoc,
	takePlansTouched,
} from '$lib/sync/adapters';
import { syncPass, type SyncPassOutcome } from '$lib/sync/replicate';
import {
	ApiError,
	fetchChanges,
	getBlob,
	pushDocs,
	putBlob,
	signOutSession,
} from '$lib/sync/protocol';
import { contentHashInput } from '$lib/sync/model';
import { sha256HexOfText } from '$lib/sync/fingerprint';
import { wipeLocalIdb, wipeLocalSync } from '$lib/sync/wipe';
import { SYNC_REGISTRY_KEY } from '$lib/sync/keys';
import {
	account,
	accountToken,
	clearStoredAccount,
	dropPresenceLock,
	markAuthExpired,
	signedIn,
} from './account.svelte';
import { ensureLinks } from './flightLinks.svelte';
import { flightImportRunning } from './flightImport.svelte';
import { getPoints } from './flightsDb';
import { nav } from './navRecording.svelte';
import { refreshPlans } from './planCatalog.svelte';
import { removeItem } from './persist';
import {
	docKey,
	ensureDeviceId,
	mutateSyncRegistry,
	readSyncRegistry,
	withSyncWriter,
	writeSyncRegistry,
} from './syncRegistry';

const SHARED_SESSION_MS = 12 * 3_600_000;
const BLOB_TRIES_MAX = 3;

export const sync = $state<{
	syncing: boolean;
	lastSyncMs: number | null;
	/** The server's typed refusal code, worded at render; null = quiet
	 *  (offline included). */
	errorCode: string | null;
	/** Local docs held back from adoption (the Account group's standing
	 *  affordance and the merge confirm's counts). */
	unadopted: number;
	/** The shared session's 12 h cap lapsed with work pending: the UI
	 *  asks instead of wiping (the one valve on the unconditional wipe). */
	expiredPendingAsk: boolean;
	/** Live upload progress of the running pass (a first adoption is
	 *  minutes of blob uploads; without this the status reads as stuck). */
	progress: { done: number; total: number } | null;
}>({
	syncing: false,
	lastSyncMs: null,
	errorCode: null,
	unadopted: 0,
	expiredPendingAsk: false,
	progress: null,
});

let running: Promise<void> | null = null;
let queued = false;
let trickleScanned = false;
// The sign-out latch: once a sign-out begins, no NEW pass may start
// (a trigger firing between the flush and the wipe would re-write the
// registry the wipe just cleared). Joining the running pass stays fine.
let closing = false;
// afterSignIn could not stamp the pre-existing set (a blocked store):
// no pass may push until the stamping lands, or every held-back local
// doc would adopt itself without consent.
let adoptStampPending = false;

/** One replication pass now (coalesced: a trigger landing mid-pass runs
 *  one more, and the CALLER JOINS the running pass rather than
 *  returning early: signOutDevice's flush must not proceed to a wipe
 *  while a pass still holds the token and would write the registry
 *  back). Quietly refuses while signed out, pending deletion,
 *  recording or importing. */
export function syncNow(): Promise<void> {
	if (!signedIn() || account.status === 'pending_delete' || account.authExpired) {
		return Promise.resolve();
	}
	if (closing || nav.recording || flightImportRunning()) {
		return Promise.resolve();
	}
	if (running) {
		queued = true;
		return running;
	}
	sync.syncing = true;
	running = (async () => {
		try {
			do {
				queued = false;
				await passOnce();
			} while (queued);
		} finally {
			running = null;
			sync.syncing = false;
		}
	})();
	return running;
}

async function passOnce(): Promise<void> {
	const token = accountToken();
	if (!token) {
		return;
	}
	const deviceId = await ensureDeviceId();
	if (adoptStampPending) {
		try {
			await stampPreexisting();
			adoptStampPending = false;
		} catch {
			return; // still unreadable: no pass until the stamping lands
		}
	}
	let outcome: SyncPassOutcome | null = null;
	try {
		await withSyncWriter(async () => {
			const reg = readSyncRegistry();
			const out = await syncPass({
				deviceId,
				mode: account.mode,
				now: () => Date.now(),
				registry: reg,
				store: {
					list: () => listLocalDocs((col, id) => reg.docs[docKey(col, id)]),
					apply: applyWireDoc,
					refile: refileDoc,
				},
				transport: {
					changes: (since, full) => fetchChanges(token, since, full),
					push: (docs) => pushDocs(token, docs),
					putBlob: (hash, bytes) => putBlob(token, hash, bytes),
				},
				progress: (done, total) => {
					sync.progress = total > 0 ? { done, total } : null;
				},
			});
			writeSyncRegistry(out.registry);
			outcome = out;
		});
	} catch (err) {
		sync.progress = null;
		handleSyncError(err);
		return;
	}
	sync.progress = null;
	const out = outcome as SyncPassOutcome | null;
	if (!out) {
		return;
	}
	sync.lastSyncMs = Date.now();
	// A typed push refusal (quota, a doc past the cap) survives the pass:
	// the pulls landed and the registry stands, but the user must hear it.
	sync.errorCode = out.pushRefused ?? (out.oversized > 0 ? 'doc-too-large' : null);
	sync.unadopted = out.unadopted;
	if (takePlansTouched()) {
		void refreshPlans();
		void ensureLinks();
	}
	if (account.mode === 'personal') {
		// The pulled docs' blobs, plus (once per session, and again after
		// any pull) a registry scan for rows whose points went missing
		// underneath (an eviction healed by re-fetch): the trickle.
		const wants = [...out.wantBlobs];
		if (!trickleScanned || out.pulled > 0) {
			trickleScanned = true;
			const reg = readSyncRegistry();
			for (const [key, e] of Object.entries(reg.docs)) {
				if (!key.startsWith('outings/') || !e.blobs || e.blobs.length === 0) {
					continue;
				}
				const id = key.slice('outings/'.length);
				if (!wants.some((w) => w.id === id)) {
					wants.push({ col: 'outings', id, refs: e.blobs, meta: e.meta ?? {} });
				}
			}
		}
		if (wants.length > 0) {
			// Newest first: the outing id is its first fix's timeMs, and
			// the flight the pilot looks for is the recent one.
			wants.sort((x, y) => Number(y.id) - Number(x.id));
			await fetchWantedBlobs(token, wants);
		}
	}
}

async function fetchWantedBlobs(
	token: string,
	wants: SyncPassOutcome['wantBlobs'],
): Promise<void> {
	for (const w of wants) {
		if (nav.recording) {
			return; // a flight started under the trickle: it must not compete
		}
		if (w.col !== 'outings') {
			continue;
		}
		const id = Number(w.id);
		if (!Number.isFinite(id)) {
			continue;
		}
		// Already landed here (this device recorded or previously fetched
		// it): don't re-pull megabytes. The cross-device Continue-extend
		// refresh is the accepted miss; the extend happens on the device
		// that holds the points.
		if (((await getPoints(id))?.length ?? 0) > 0) {
			continue;
		}
		const entry = readSyncRegistry().docs[docKey('outings', w.id)];
		if ((entry?.tries ?? 0) >= BLOB_TRIES_MAX) {
			continue;
		}
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient download buffer, not state
		const fetched = new Map<string, Uint8Array>();
		try {
			for (const r of w.refs) {
				fetched.set(r.h, await getBlob(token, r.h));
			}
		} catch (err) {
			handleSyncError(err);
			return;
		}
		if (!(await landOutingBlobs(id, w.meta, fetched))) {
			// A wrongly-addressed or corrupt blob: count the try so the
			// discard-and-refetch loop is bounded, surfaced via errorCode.
			await mutateSyncRegistry((reg) => {
				const e = reg.docs[docKey('outings', w.id)];
				if (e) {
					e.tries = (e.tries ?? 0) + 1;
				}
			});
			sync.errorCode = 'blob-invalid';
		}
	}
}

function handleSyncError(err: unknown): void {
	if (err instanceof ApiError) {
		if (err.code === 'network') {
			return; // offline is a quiet state, never an error surface
		}
		if (err.status === 401) {
			markAuthExpired();
			return;
		}
		sync.errorCode = err.code;
		return;
	}
	// A busy plans store or a transient local read: silent, the next
	// trigger replays the pass idempotently.
}

// --- pending work ----------------------------------------------------------

/** How many local docs would push right now (the sign-out valve's count
 *  and the status line's "N pending"); null when the stores cannot be
 *  read, which every caller must treat as "assume pending" (a blocked
 *  tab must not wave a wipe through as if the outbox were empty). */
export async function countPendingDocs(): Promise<number | null> {
	const reg = readSyncRegistry();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local lookup, not state
	const preexisting = new Set(reg.preexisting ?? []);
	let dirty = reg.tombstones.length;
	let locals;
	try {
		locals = await listLocalDocs((col, id) => reg.docs[docKey(col, id)]);
	} catch {
		return null;
	}
	for (const d of locals) {
		const key = docKey(d.col, d.id);
		const entry = reg.docs[key];
		if (!entry) {
			if (!preexisting.has(key)) {
				dirty++;
			}
			continue;
		}
		const hash = await sha256HexOfText(contentHashInput(d.payloadText, entry.blobs));
		if (hash !== entry.hash) {
			dirty++;
		}
	}
	return dirty;
}

// --- the lifecycle flows ---------------------------------------------------

/** After completeSignIn: stamp the adoption state and run the first
 *  pass. Creation in personal mode adopts everything (the contract's
 *  automatic upload), UNLESS the device's last account was someone
 *  else's: then the misused-mode guard applies to creation as to any
 *  sign-in, and the merge confirm asks with its flipped default rather
 *  than the previous pilot's library uploading wholesale into a fresh
 *  account. Every other sign-in holds the pre-existing local docs back
 *  until the merge confirm answers (personal) or per-item Store moves
 *  them (shared). */
export async function afterSignIn(created: boolean, differentAccount: boolean): Promise<void> {
	closing = false;
	const adoptAll = created && !differentAccount && account.mode === 'personal';
	if (!adoptAll) {
		try {
			await stampPreexisting();
		} catch {
			adoptStampPending = true; // passOnce retries before any push
		}
	}
	await syncNow();
}

async function stampPreexisting(): Promise<void> {
	const locals = await listLocalDocs(() => undefined);
	const keys = locals.map((d) => docKey(d.col, d.id));
	if (keys.length > 0) {
		await mutateSyncRegistry((reg) => {
			reg.preexisting = keys;
		});
	}
}

/** The merge confirm's "add": everything held back adopts and pushes. */
export async function adoptPreexisting(): Promise<void> {
	await mutateSyncRegistry((reg) => {
		delete reg.preexisting;
	});
	await syncNow();
}

/** Sign this device out. Personal keeps local data by default (the
 *  local-first posture; `wipe` is the fine-print option); shared wipes
 *  unconditionally. Flushing first is the caller's (the UI runs the
 *  outbox valve with countPendingDocs before committing). */
export async function signOutDevice(opts: { wipe: boolean }): Promise<void> {
	try {
		await syncNow();
	} catch {
		/* best-effort flush */
	}
	closing = true;
	const token = accountToken();
	if (token) {
		void signOutSession(token).catch(() => {
			/* the session row expires on its own */
		});
	}
	dropPresenceLock();
	if (opts.wipe || account.mode === 'shared') {
		const reg = wipeLocalSync();
		await wipeLocalIdb(reg);
		clearStoredAccount();
		location.reload();
		return;
	}
	clearStoredAccount();
	removeItem(SYNC_REGISTRY_KEY);
	sync.lastSyncMs = null;
	sync.errorCode = null;
	sync.unadopted = 0;
	closing = false;
}

/** The shared session's absolute cap, checked at the visibility trigger:
 *  lapsed with an empty outbox and no recording, the device signs out
 *  and wipes on its own (it is all on the server); anything pending
 *  keeps the data and asks (docs/accounts-sync.md, Lifecycle). */
export async function checkSharedExpiry(): Promise<void> {
	if (!signedIn() || account.mode !== 'shared') {
		return;
	}
	if (Date.now() - account.signedInAtMs < SHARED_SESSION_MS) {
		return;
	}
	if (nav.recording) {
		return;
	}
	const pending = await countPendingDocs();
	if (pending === 0) {
		await signOutDevice({ wipe: true });
	} else {
		sync.expiredPendingAsk = true; // pending, or unreadable (null)
	}
}

/** The one collection whose blobs a shared-mode device fetches ON
 *  DEMAND (the Flights surface's fetch-trace affordance). */
export async function fetchOutingOnDemand(id: number): Promise<boolean> {
	const token = accountToken();
	if (!token) {
		return false;
	}
	const reg = readSyncRegistry();
	const entry = reg.docs[docKey('outings', String(id))];
	if (!entry || !entry.blobs || entry.blobs.length === 0) {
		return false;
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient download buffer, not state
	const fetched = new Map<string, Uint8Array>();
	try {
		for (const r of entry.blobs) {
			fetched.set(r.h, await getBlob(token, r.h));
		}
	} catch (err) {
		handleSyncError(err);
		return false;
	}
	return landOutingBlobs(id, entry.meta ?? {}, fetched);
}
