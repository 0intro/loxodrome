/* The sync engine (docs/accounts-sync.md): the pass runner over the
 * pure replicator, the lifecycle flows (sign-in, adoption, sign-out, a
 * shared session's end in this tab and its following in the others, the
 * shared expiry), the trace download, and the status the Account group
 * renders.
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
import { recordingInAnyTab } from '$lib/sync/recordingLock';
import {
	readSessionEnd,
	unsentBySession,
	wipeLocalIdb,
	wipeLocalSync,
	wipeSessionIdb,
	wipeSharedSession,
} from '$lib/sync/wipe';
import {
	completeFoundCopy,
	parkFoundPilot,
	PILOT_DOC,
	readFoundCopy,
	takeFoundCopy,
} from '$lib/sync/found';
import { SYNC_REGISTRY_KEY } from '$lib/sync/keys';
import {
	account,
	accountToken,
	clearStoredAccount,
	commitSignIn,
	commitSignInOverSharedSession,
	markAuthExpired,
	signedIn,
	signInEndsSharedSession,
	tokenStillStored,
	verifySignIn,
} from './account.svelte';
import { ensureLinks } from './flightLinks.svelte';
import { clearPilot } from './flightPrep.svelte';
import { flightImportRunning } from './flightImport.svelte';
import { hasPoints, pointIds } from './flightsDb';
import { nav, unfiledFlight } from './navRecording.svelte';
import { refreshPlans } from './planCatalog.svelte';
import { removeItem, sealStorage } from './persist';
import { disarmRoutesPersist, whenRoutesRestored } from './routePersist';
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
// doc would adopt itself without consent. The registry's stampPending
// carries the same debt across a reload; this is its in-document twin,
// for when even the registry could not be written.
let adoptStampPending = false;

/** Whether the pre-existing stamp is owed (see adoptStampPending). Every
 *  shared end reads it, as the sign-out valve does: with the stamp owed,
 *  nothing untracked can be told for the session's own work (sync/wipe.ts). */
export function stampOwed(): boolean {
	return adoptStampPending || readSyncRegistry().stampPending === true;
}

// The boot's workspace restore has settled (routePersist). An owed stamp
// waits for it, as the first pass does (SyncHost), so a held workspace
// rescued into the catalog is in the stamp rather than pushed as this
// account's. It never settles in node specs, where PersistHost does not
// mount: an owed stamp then simply holds every pass, which is the safe way.
let routesSettled = false;
void whenRoutesRestored().then(() => {
	routesSettled = true;
});

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
	// The token this tab remembers must still be the stored one: another
	// tab's sign-out, a shared session's end or a sign-in over it rewrites
	// the stored account under this tab's memory.
	if (!token || !tokenStillStored(token)) {
		return;
	}
	const deviceId = await ensureDeviceId();
	if (stampOwed()) {
		if (!routesSettled) {
			return; // behind the workspace restore, as the first pass is
		}
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
			// Asked again under the lock, which every wipe holds: a pass that
			// waited behind another tab's end of the session finds the token
			// gone here, and pulls nothing back into what that end erased.
			if (!tokenStillStored(token)) {
				return;
			}
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
	for (const ctl of demandInFlight.keys()) {
		ctl.abort();
	}
	await traceRun;
	// The on-demand fetches run outside the download: joined too, landings
	// included, so a wipe that follows cannot see a deleted outing's points
	// land back behind it.
	await Promise.allSettled([...demandInFlight.values()]);
	await landTail;
}

// The shared mode's on-demand fetches in flight (fetchOutingOnDemand), which
// run outside the download's own run: stopTraceFetch aborts and joins them.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- in-flight bookkeeping, not state
const demandInFlight = new Map<AbortController, Promise<boolean>>();

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
	// it): don't re-pull megabytes. A trace grown on another device (a
	// resume, an add) is the accepted miss; the extend happens on the device
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
	// A session ended in another tab while the bytes were on the way lands
	// nothing (passOnce's rule; the landing is not under the writer lock,
	// so this narrows the window to one landing rather than closing it).
	return landOne(() =>
		tokenStillStored(token) ? landOutingBlobs(id, meta, fetched) : Promise.resolve(false),
	);
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
	// An untracked doc counts when the next pass would push it
	// (sync/wipe.ts unsentBySession): what a shared session's end removes,
	// and a found plan Stored or a pilot block typed over the found one set
	// aside, which the end puts back as found. With no found copy and the
	// stamp still owed, every untracked doc is about to be held back, not
	// pushed, and counting them would make the sign-out valve call the
	// device's leftovers this account's unsent work.
	const end = readSessionEnd(stampOwed());
	const reg = end.reg;
	const unsent = unsentBySession(end);
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
			if (unsent(key)) {
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

/** Why ending a shared session is refused: a recording runs in this tab,
 *  or in another tab of the app (the RECORDING lock it holds). An end
 *  navigates, which would stop a flight here, and erases the crash copy
 *  and the workspace of a flight anywhere. */
export type RecordingRefusal = 'recording' | 'recording-elsewhere';

/** Why no end of a shared session may run now, or null: a recording in this
 *  tab or another (every end asks it first, Reset's included). */
export async function recordingRefusal(): Promise<RecordingRefusal | null> {
	if (nav.recording) {
		return 'recording';
	}
	return (await recordingInAnyTab()) ? 'recording-elsewhere' : null;
}

export type SignInResult =
	| { kind: 'signed-in'; created: boolean; differentAccount: boolean }
	/** Refused: it would end a shared session, and a recording runs. */
	| { kind: 'recording' }
	| { kind: 'recording-elsewhere' }
	/** The page is leaving for a fresh document, the new session in it. */
	| { kind: 'leaving' };

/** Why signing `email` in now is refused, or null: it would have to end the
 *  shared session this device holds (signInEndsSharedSession), which never
 *  happens under a recording. Asked before a code is sent and again before
 *  it is spent, so a refused sign-in costs no code. */
export async function signInRefused(email: string): Promise<RecordingRefusal | null> {
	return (await signInEndsSharedSession(email)) ? recordingRefusal() : null;
}

/** Verify the code and sign in (docs/accounts-sync.md, Lifecycle). The
 *  ordinary sign-in commits in this document and runs afterSignIn. One
 *  that ENDS another account's shared session (an expired club session
 *  someone signs over) does not: sync and the route writer stand down,
 *  the session ends and the new one is written in one step under the
 *  writer lock (account.svelte commitSignInOverSharedSession), a shared
 *  one stamped right there from the STORES the end settled, and the page
 *  leaves for a fresh document. Nothing is stamped from this document's
 *  memory, the previous pilot's aircraft and pilot block included: a
 *  singleton stamped from it would hold the new pilot's own back for good,
 *  which is why a stamp the stores cannot give here is owed to the fresh
 *  document instead. The address is the pathname alone, as at a session's
 *  end, except that the ?account= deep link this sign-in was armed by is
 *  kept for the new pilot. */
export async function signIn(
	email: string,
	code: string,
	remember: boolean,
	thenAccount = false,
): Promise<SignInResult> {
	const refused = await signInRefused(email);
	if (refused !== null) {
		return { kind: refused };
	}
	const verified = await verifySignIn(email, code, remember);
	if (!verified.endsShared) {
		const out = await commitSignIn(verified);
		await afterSignIn(out.created, out.differentAccount);
		return { kind: 'signed-in', created: out.created, differentAccount: out.differentAccount };
	}
	const late = await recordingRefusal();
	if (late !== null) {
		return { kind: late }; // begun under the verify: the code is spent
	}
	await haltSync();
	disarmRoutesPersist();
	await commitSignInOverSharedSession(verified);
	location.replace(thenAccount ? `${location.pathname}?account` : location.pathname);
	return { kind: 'leaving' };
}

/** After an ordinary sign-in's commit: stamp the adoption state and run the first
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
			// The sign-in was refused under a recording anywhere, so nothing
			// is asked here: the copy is written in the account's own task.
			await stampPreexisting(false);
		} catch {
			// passOnce retries before any push, in this document or, the
			// debt being persisted, after a reload.
			adoptStampPending = true;
			try {
				await mutateSyncRegistry((reg) => {
					reg.stampPending = true;
				});
			} catch {
				/* the in-document flag still holds this page's passes */
			}
		}
	}
	await syncNow();
}

/** Stamp every local doc as pre-existing (held back), and settle an owed
 *  stamp with it. A SHARED sign-in takes the found copy too
 *  (stampSharedSession); `flying` says whether a recording runs in any tab,
 *  asked of the RECORDING lock when the caller does not know. */
async function stampPreexisting(flying?: boolean): Promise<void> {
	if (account.mode === 'shared') {
		await stampSharedSession(flying);
		return;
	}
	const locals = await listLocalDocs(() => undefined);
	const keys = locals.map((d) => docKey(d.col, d.id));
	if (keys.length > 0 || readSyncRegistry().stampPending === true) {
		await mutateSyncRegistry((reg) => {
			if (keys.length > 0) {
				reg.preexisting = keys;
			}
			delete reg.stampPending;
		});
	}
}

/** A SHARED sign-in's stamp (docs/accounts-sync.md, "The wipe knows what is
 *  the account's"). Every local doc is held back, as at any sign-in, and a
 *  copy of what the sign-in FOUND is taken first, from the stores
 *  (sync/found.ts), which the session's end puts back as found. The pilot
 *  block found is SET ASIDE rather than held back: on a shared computer the
 *  pilot block is the signed-in pilot's, so the session starts from a blank
 *  one (or the account's, pulled), what its pilot types there syncs and
 *  leaves with the session, and the found one comes back at the end.
 *
 *  A store that cannot be read leaves the plans' and flights' rows unlisted
 *  and the stamp OWED, the rest of the copy taken and the pilot block set
 *  aside at once; the owed stamp lists them at a later pass, unless the
 *  first write of a plan or a flight has listed them before it lands
 *  (sync/found.ts ensureFoundComplete), and holds back nothing a Store let
 *  go meanwhile (settleStamp). A same-account sign-in inside the session (its
 *  token lapsed) takes no new copy, or the session's own unsynced work
 *  would be taken for found and held back with it; the stamp stands as the
 *  session's first sign-in took it, and an owed one lands from that copy.
 *  The order is what makes a stamp that fails half way safe to take again:
 *  the copy first, then the block set aside (noted in the copy), then the
 *  registry, whose owed stamp is what brings a retry back here. A sign-in
 *  over another pilot's session took its copy before this document existed
 *  (state/account.svelte.ts). */
async function stampSharedSession(flying?: boolean): Promise<void> {
	// Owed from the sign-in's commit until it lands (state/account.svelte.ts
	// commitSignIn), so nothing owed is a stamp already taken: the same
	// account signing back into its own session finds its found set as its
	// first sign-in took it, copy or none.
	if (readSyncRegistry().stampPending !== true) {
		return;
	}
	const who = account.userId ?? '';
	const prior = readFoundCopy();
	let copy = prior !== null && prior.userId === who ? prior : null;
	if (copy === null) {
		// A late stamp asks whether a recording runs in any tab, its crash copy
		// then being the session's flight; a sign-in's knows there is none.
		const recording = nav.recording || (flying ?? (await recordingInAnyTab()));
		const taken = await takeFoundCopy(who, stoppedTrace(), recording);
		if (!taken.stored) {
			// Storage refused the copy: the stamp alone, as before it existed.
			if (!taken.copy.listed) {
				// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
				throw new Error('sync: stores unreadable');
			}
			await settleStamp(taken.copy.keys);
			return;
		}
		copy = taken.copy;
	} else if (!copy.listed) {
		const completed = await completeFoundCopy(copy);
		copy = completed.copy;
	}
	const parked = await parkFoundPilot(copy);
	if (parked.parked && !copy.parked) {
		clearPilot(); // this document's memory along with the stored block
	}
	copy = parked;
	if (!copy.listed) {
		// The rows could not be read: the stamp stays owed, its storage-held
		// half taken, the pilot block set aside.
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new Error('sync: stores unreadable');
	}
	const set = copy.parked;
	await settleStamp(copy.keys.filter((k) => !(set && k === PILOT_DOC)));
}

/** The live trace's first fix when it is stopped (a recording running
 *  through the sign-in is the signed-in pilot's flight). */
function stoppedTrace(): number | null {
	return !nav.recording && nav.points.length > 0 ? nav.points[0].timeMs : null;
}

/** Land the stamp: `keys` held back, less what a Store let go while it was
 *  owed (syncRegistry releaseHeldBack), and nothing owed any more. */
async function settleStamp(keys: string[]): Promise<void> {
	await mutateSyncRegistry((reg) => {
		const released = new Set(reg.released ?? []);
		const held = keys.filter((k) => !released.has(k));
		if (held.length > 0) {
			reg.preexisting = held;
		} else {
			delete reg.preexisting;
		}
		delete reg.stampPending;
		delete reg.released;
	});
}

/** The merge confirm's "add": everything held back adopts and pushes. */
export async function adoptPreexisting(): Promise<void> {
	await mutateSyncRegistry((reg) => {
		delete reg.preexisting;
	});
	await syncNow();
}

/** Sign this device out. Personal keeps local data by default (the
 *  local-first posture; `wipe` is the fine-print option); shared ENDS the
 *  session (endSharedSession), unconditionally. Flushing first is the
 *  caller's (the UI runs the outbox valve with countPendingDocs before
 *  committing).
 *
 *  A sign-out that wipes is REFUSED while a recording runs, here or in
 *  another tab, answering why (RecordingRefusal): it navigates, which would
 *  stop a flight here, and erases the crash copy and the workspace of a
 *  flight anywhere. The Account surface disables its buttons while this tab
 *  records and says so; this is also the backstop for a recording that
 *  begins under its confirm (the Android boot reconcile resumes one). */
export async function signOutDevice(opts: {
	wipe: boolean;
}): Promise<'signed-out' | RecordingRefusal> {
	const refusal = async (): Promise<RecordingRefusal | null> =>
		opts.wipe || account.mode === 'shared' ? recordingRefusal() : null;
	const before = await refusal();
	if (before !== null) {
		return before;
	}
	try {
		await syncNow();
	} catch {
		/* best-effort flush */
	}
	const after = await refusal();
	if (after !== null) {
		return after; // a recording began under the flush
	}
	closing = true;
	// The download is not part of the pass promise the flush just joined,
	// so it is stopped and joined here, ahead of any wipe.
	await stopTraceFetch();
	const token = accountToken();
	const revoked = token
		? signOutSession(token).catch(() => {
				/* the session row expires on its own */
			})
		: Promise.resolve();
	if (account.mode === 'shared') {
		await endSharedSession(revoked);
		return 'signed-out';
	}
	if (opts.wipe) {
		// The personal scope (wipe.ts wipeLocalSync): the account's data,
		// never the preferences. The route writer first, or its debounce and
		// its pagehide flush would put the workspace back behind the wipe.
		disarmRoutesPersist();
		await wipeUnderWriter(async () => {
			await wipeLocalIdb(readSyncRegistry());
			wipeLocalSync();
		});
		clearStoredAccount();
		await briefly(revoked);
		location.reload();
		return 'signed-out';
	}
	clearStoredAccount();
	// Under the lock, the account already forgotten: a pass another tab is
	// running ends first and its registry write goes with this one, and its
	// next pass finds no token (passOnce). A registry left behind would keep
	// recording tombstones for deletions made signed out, to be pushed at
	// the next sign-in.
	await withSyncWriter(() => {
		removeItem(SYNC_REGISTRY_KEY);
	});
	sync.lastSyncMs = null;
	sync.errorCode = null;
	sync.unadopted = 0;
	closing = false;
	return 'signed-out';
}

/** End a shared session on this device (docs/accounts-sync.md, "Device
 *  modes"): the shared sign-out and the 12-hour cap, both through
 *  signOutDevice. The device is handed back at its DEFAULTS, preferences
 *  included, the boot sweep's scope (wipe.ts wipeSharedSession) run from
 *  inside the app. The order is the contract:
 *  - sync stood down, the running pass joined and the downloads stopped,
 *    so nothing lands behind the wipe;
 *  - the route writer disarmed, or its debounce and its pagehide flush
 *    would write the workspace back;
 *  - the wipe under the WRITER lock, so a pass in another tab cannot land
 *    after it: the IndexedDB half first, from the end's inputs read once
 *    (wipe.ts readSessionEnd), so a tab closed half way keeps the registry
 *    and the found copy naming what is left for the next boot's sweep, and
 *    the shared flag last. Both halves take what the session made and never
 *    synced too, the changes the sign-out's valve warned would be lost, read
 *    with the stamp this document may still owe, as the valve read them,
 *    and put back what its sign-in found, as found (sync/found.ts);
 *  - storage SEALED in the same step, so a writer still to run in this
 *    document (an effect, a throttled view, a pagehide flush) writes
 *    nothing, during the brief wait for the session revoke included;
 *  - the account forgotten, its presence dropped only now, so that no tab
 *    booting meanwhile could find the session unheld and sweep beside
 *    this one;
 *  - a CLEAN navigation to the pathname alone: the previous pilot's
 *    ?file= would open their file again, an ?account= link would reopen
 *    their sign-in and their #map= would restore their view, base map and
 *    charts over the defaults (a present hash wins at boot). `replace`,
 *    so Back does not return to their URL either. */
async function endSharedSession(revoked: Promise<unknown>): Promise<void> {
	await haltSync();
	disarmRoutesPersist();
	const startMs = Date.now();
	await wipeUnderWriter(async () => {
		const end = readSessionEnd(stampOwed());
		await wipeSessionIdb(end, startMs);
		wipeSharedSession(end);
	});
	// Memory and presence: the storage it would clear is gone already.
	clearStoredAccount();
	await briefly(revoked);
	location.replace(location.pathname);
}

/** Follow a shared session's end made in ANOTHER tab (SyncHost's `storage`
 *  listener, over sync/keys.ts sharedSessionEndedBy): this document still
 *  holds that session's memory, its preferences, workspace and aircraft,
 *  which any writer here would put back into the storage the end has just
 *  cleared, and its token, which no pass may use again. So it does what the
 *  ending tab did after its wipe: sync stood down, storage sealed, and the
 *  pathname alone. Synchronous on purpose, the seal first: the navigation
 *  aborts this document's fetches and open transactions, and the end held
 *  the writer lock over anything a pass of this tab had under way. Never
 *  under a recording, answered false; the caller retries, and a flight in
 *  this tab is never ended from another. */
export function followEndedSession(): boolean {
	if (nav.recording) {
		return false;
	}
	closing = true;
	traceStop = true;
	traceAbort?.abort();
	sealStorage();
	location.replace(location.pathname);
	return true;
}

/** Wipe this device's copy under the writer lock, the IndexedDB half
 *  first from the inputs `wipe` reads once (a tab closed half way keeps the
 *  registry and the found copy naming what is left, for the next boot's
 *  sweep), then the storage half, and SEAL storage in the same step:
 *  nothing queued behind the callback, an effect included, may write a
 *  wiped key back before the page leaves. */
async function wipeUnderWriter(wipe: () => Promise<void>): Promise<void> {
	await withSyncWriter(async () => {
		await wipe();
		sealStorage();
	});
}

/** Wait a little for `p`, never long: a navigation would cut the session
 *  revoke off in flight, leaving the server's row to its own expiry, and a
 *  pilot is waiting on the sign-out. */
function briefly(p: Promise<unknown>, ms = 2000): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		void p.finally(() => {
			clearTimeout(timer);
			resolve();
		});
	});
}

/** The shared session's absolute cap, checked at the visibility trigger:
 *  lapsed with an empty outbox, no flight the library never took and no
 *  recording in any tab, the device signs out and wipes on its own (it is
 *  all on the server); anything pending keeps the data and asks
 *  (docs/accounts-sync.md, Lifecycle). */
export async function checkSharedExpiry(): Promise<void> {
	if (!signedIn() || account.mode !== 'shared') {
		return;
	}
	if (Date.now() - account.signedInAtMs < SHARED_SESSION_MS) {
		return;
	}
	if ((await recordingRefusal()) !== null) {
		return; // the next visibility trigger after the flight
	}
	// A flight the library never took is work at risk like an unsent change:
	// the end would erase it, never uploaded (navRecording unfiledFlight).
	const pending = await countPendingDocs();
	if (pending === 0 && !unfiledFlight()) {
		await signOutDevice({ wipe: true });
	} else {
		sync.expiredPendingAsk = true; // pending, or unreadable (null)
	}
}

/** The one collection whose blobs a shared-mode device fetches ON
 *  DEMAND (the Flights surface's fetch-trace affordance). */
export async function fetchOutingOnDemand(id: number): Promise<boolean> {
	const token = accountToken();
	// Nothing new once the page is standing sync down (a sign-out, a
	// reset): what it is about to erase must not be fetched back.
	if (!token || closing) {
		return false;
	}
	const reg = readSyncRegistry();
	const entry = reg.docs[docKey('outings', String(id))];
	if (!entry || !entry.blobs || entry.blobs.length === 0) {
		return false;
	}
	const ctl = new AbortController();
	const run = fetchOutingBlobs(token, id, entry.blobs, entry.meta ?? {}, ctl.signal);
	demandInFlight.set(ctl, run);
	try {
		return await run;
	} catch (err) {
		handleSyncError(err);
		return false;
	} finally {
		demandInFlight.delete(ctl);
	}
}
