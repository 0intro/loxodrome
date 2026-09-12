/* The sync engine (docs/accounts-sync.md): the pass runner over the
 * pure replicator, the lifecycle flows (adoption, sign-out, the shared
 * expiry), the trace download, and the status the Account group renders.
 * Downstream of every state module (the appliers and adapters it wires
 * reach across the whole tree); nothing imports it back except the UI,
 * SyncHost, and reset.ts for the one thing a flush cannot reach, the
 * download's stop.
 *
 * Standing rules, each the contract's: a pass never runs while
 * `nav.recording` (sync never blocks or delays a flight) nor while the
 * batch importer runs; the whole pass holds the exclusive WRITER lock
 * and the registry is written ONCE at its end, so an aborted pass
 * (a busy plans store, a network drop) leaves lastSeq untouched and the
 * next trigger simply replays idempotently; 'network' failures are the
 * quiet offline state, a 401 flips the signed-out badge, and quota
 * codes surface once through the errorText wording at render.
 *
 * The trace download is the one thing OUTSIDE that pass promise: a pass
 * starts it and never awaits it, because a device signing in fresh wants
 * every trace it has ever flown and the sign-in button used to hold
 * "Verifying" across all of it. So joining a pass no longer joins the
 * download, and every device-wipe path stops it first: sign-out through
 * stopTraceFetch, which aborts what is in flight and waits for the rest,
 * and reset through haltSync, which joins the pass before doing that,
 * a pass being what starts a download. */

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
import { contentHashInput, type BlobRef } from '$lib/sync/model';
import { mergeWants, type TraceWant } from '$lib/sync/traceQueue';
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
import { hasPoints, pointIds } from './flightsDb';
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
/** Trace downloads in flight. Three, not the six the terrain pinner runs
 *  (state/offlineTerrain.svelte.ts): each landing inflates and parses a
 *  whole points array before it writes, so the pool is a memory choice as
 *  much as a latency one. */
const TRACE_CONCURRENCY = 3;

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
	/** Live progress of the trace download, counted in OUTINGS. Its own
	 *  field rather than a mode of `progress`: the download outlives the
	 *  pass that started it, so an upload and a download can be in flight
	 *  at once and one counter cannot say both. */
	traces: { done: number; total: number } | null;
}>({
	syncing: false,
	lastSyncMs: null,
	errorCode: null,
	unadopted: 0,
	expiredPendingAsk: false,
	progress: null,
	traces: null,
});

let running: Promise<void> | null = null;
let queued = false;
let trickleScanned = false;
// The trace download: the queue every pass folds its wants into, the ONE
// run draining it, the keys that run holds in flight, and the latch a
// wipe sets to stop it. It is deliberately NOT part of the pass promise,
// so nothing here may be reached by joining a pass; stopTraceFetch is.
let traceQueue: TraceWant[] = [];
let traceRun: Promise<void> | null = null;
let traceStop = false;
let traceAbort: AbortController | null = null;
let traceDone = 0;
// Whether the current run got anywhere: a queue that fails wholesale
// must not restart itself on the spot.
let traceWorked = false;
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- one run's in-flight keys, not state
const traceInFlight = new Set<string>();
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
			startTraceFetch(token, wants);
		}
	}
}

/** Fold `wants` into the queue and make sure ONE run is draining it.
 *  Never awaited by the pass: a device signing in fresh wants every
 *  trace it has ever flown, and the sign-in button used to hold
 *  "Verifying" across all of it. The contract has always called this a
 *  background trickle (docs/accounts-sync.md); this is where it becomes
 *  one. */
function startTraceFetch(token: string, wants: TraceWant[]): void {
	traceQueue = mergeWants(traceQueue, wants).filter(
		(w) => !traceInFlight.has(`${w.col}/${w.id}`),
	);
	if (traceRun !== null || traceQueue.length === 0) {
		return;
	}
	traceStop = false;
	traceDone = 0;
	traceWorked = false;
	traceAbort = new AbortController();
	const signal = traceAbort.signal;
	traceRun = (async () => {
		try {
			await runTraceFetch(token, signal);
		} catch (err) {
			// A run must NEVER reject: stopTraceFetch awaits it from inside
			// a sign-out, and a rejection there would take the sign-out with
			// it, leaving the wipe unrun.
			handleSyncError(err);
		} finally {
			traceRun = null;
			traceAbort = null;
			sync.traces = null;
			// A pass that merged after the last worker exited would sit
			// there until the next trigger; start its run here instead. Only
			// after a cycle that got somewhere, so a queue that fails
			// wholesale (offline) waits for a trigger rather than spinning,
			// and never under a recording, which is what the cycle just
			// stood down for.
			if (traceWorked && !traceStop && !closing && !nav.recording && traceQueue.length > 0) {
				startTraceFetch(token, []);
			}
		}
	})();
}

/** Stop the trace download and JOIN it. Every wipe path goes through
 *  this: joining a pass no longer joins the download, so this is what
 *  keeps "nothing writes behind a wipe" true. */
async function stopTraceFetch(): Promise<void> {
	traceStop = true;
	traceQueue = [];
	// Aborting is what makes the join PROMPT: a blob carries a 120 s
	// deadline, and a sign-out cannot sit behind one that is mid-flight.
	traceAbort?.abort();
	await traceRun;
}

/** Stand sync down for the life of this page: no new pass may start, the
 *  running one is joined, the download stopped and joined. What RESET
 *  needs, having no latch of its own: it erases the stores across several
 *  awaits and then reloads, and a trigger firing inside those awaits
 *  would pull and land straight into what is being erased. */
export async function haltSync(): Promise<void> {
	closing = true;
	// The pass FIRST: it starts the download at its own end, so stopping
	// the download before joining the pass would stop nothing and let a
	// fresh run begin behind the halt. No new pass can start meanwhile,
	// `closing` being what syncNow refuses on.
	await running;
	await stopTraceFetch();
}

/** Outings, not blobs: what the pilot counts is flights, and an outing
 *  is one or two refs. Null once nothing is left, so the status line
 *  falls back to its resting truth. */
function publishTraceProgress(): void {
	const left = traceQueue.length + traceInFlight.size;
	sync.traces = left > 0 ? { done: traceDone, total: traceDone + left } : null;
}

/** Whether a want still needs BYTES. Asked twice: once over the whole
 *  queue up front, so the counter can promise downloads rather than
 *  queue positions and three workers never churn through a queue of
 *  skips, and once in the worker, where it is the race guard. `landed`
 *  is the prune's one-transaction answer for the whole library; without
 *  it the question is asked of the one outing. */
async function wantsBytes(w: TraceWant, landed: ReadonlySet<number> | null): Promise<boolean> {
	if (w.col !== 'outings') {
		return false;
	}
	const id = Number(w.id);
	if (!Number.isFinite(id)) {
		return false;
	}
	if ((readSyncRegistry().docs[docKey('outings', w.id)]?.tries ?? 0) >= BLOB_TRIES_MAX) {
		return false;
	}
	// Already landed here (this device recorded or previously fetched
	// it): don't re-pull megabytes. The cross-device Continue-extend
	// refresh is the accepted miss; the extend happens on the device
	// that holds the points. EXISTENCE, not the row.
	return landed !== null ? !landed.has(id) : !(await hasPoints(id));
}

/** Everything that needs no download dropped before the pool starts.
 *  Anything a pass merges while this runs folds back in unpruned; the
 *  worker's own test is what catches those. */
async function pruneTraceQueue(): Promise<void> {
	const pending = traceQueue;
	traceQueue = [];
	const landed = await pointIds();
	const kept: TraceWant[] = [];
	for (const w of pending) {
		if (traceStop) {
			return; // the stop cleared the queue and must find it empty
		}
		if (await wantsBytes(w, landed)) {
			kept.push(w);
		}
	}
	traceQueue = mergeWants(kept, traceQueue);
}

async function runTraceFetch(token: string, signal: AbortSignal): Promise<void> {
	await pruneTraceQueue();
	if (traceQueue.length === 0) {
		return; // a scan that found everything already here: no counter, no pool
	}
	publishTraceProgress();
	const worker = async (): Promise<void> => {
		for (;;) {
			if (traceStop) {
				return;
			}
			if (nav.recording) {
				// A flight started under the download: it must not compete
				// (the pass's own gate cannot help, the run outliving it).
				// The queue stands, so the next trigger resumes it.
				return;
			}
			const w = traceQueue.shift();
			if (w === undefined) {
				return;
			}
			const key = `${w.col}/${w.id}`;
			traceInFlight.add(key);
			let downloaded = false;
			let requeued = false;
			try {
				downloaded = await fetchWantedTrace(token, w, signal);
			} catch (err) {
				// Offline, refused, or the stop's own abort: the queue stands
				// and the next trigger resumes it, THIS want included. A
				// wipe's stop cleared the queue and must find it still empty.
				if (!traceStop) {
					traceQueue.unshift(w);
					requeued = true;
				}
				handleSyncError(err);
				return;
			} finally {
				traceInFlight.delete(key);
				if (!requeued) {
					traceWorked = true;
					if (downloaded) {
						// Skips leave the TOTAL instead of advancing the count:
						// the line says traces downloaded, not queue served.
						traceDone++;
					}
				}
				publishTraceProgress();
			}
		}
	};
	await Promise.all(Array.from({ length: TRACE_CONCURRENCY }, worker));
}

/** One want: the guard, then the fetch, then the landing. Answers
 *  whether bytes were actually asked for, and throws what the wire
 *  threw, which is the caller's signal to stop the run. */
async function fetchWantedTrace(
	token: string,
	w: TraceWant,
	signal: AbortSignal,
): Promise<boolean> {
	if (!(await wantsBytes(w, null))) {
		return false;
	}
	if (!(await fetchOutingBlobs(token, Number(w.id), w.refs, w.meta, signal))) {
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
	return true;
}

/** One outing's refs fetched then landed, the sequence the trickle and
 *  the shared-mode on-demand fetch share. Sequential within an outing:
 *  there are one or two refs, and the pool parallelises across outings. */
async function fetchOutingBlobs(
	token: string,
	id: number,
	refs: BlobRef[],
	meta: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<boolean> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient download buffer, not state
	const fetched = new Map<string, Uint8Array>();
	for (const r of refs) {
		fetched.set(r.h, await getBlob(token, r.h, signal));
	}
	return landOne(() => landOutingBlobs(id, meta, fetched));
}

/** Fetches fan out, LANDINGS do not: landOutingBlobs inflates and parses
 *  a whole points array before it writes, so several at once is where a
 *  phone runs out of memory. The tail is syncRegistry's own idiom. */
let landTail: Promise<unknown> = Promise.resolve();
function landOne(fn: () => Promise<boolean>): Promise<boolean> {
	const run = landTail.then(fn, fn);
	landTail = run.catch(() => {
		/* the queue survives a failed landing */
	});
	return run;
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
	// The download is not part of the pass promise the flush just joined,
	// so it is stopped and joined here, ahead of any wipe.
	await stopTraceFetch();
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
	try {
		return await fetchOutingBlobs(token, id, entry.blobs, entry.meta ?? {});
	} catch (err) {
		handleSyncError(err);
		return false;
	}
}
