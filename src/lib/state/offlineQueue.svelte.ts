/* The one offline download queue's runner (docs/offline-maps.md, "The
 * download queue"): the $state the rows read, the ONE drain, the ONE abort
 * and the ONE wake lock.
 *
 * It knows nothing about charts, documents or terrain: a job carries the
 * closure that runs it, which is what keeps the imports strictly one way
 * (the three modules -> here -> offline/downloadQueue.ts -> nothing) and
 * what makes a job's payload resolve when it RUNS rather than when it is
 * queued. It replaces three separate ad-hoc mutexes whose rule was
 * one-directional, whose flags were read a full three awaits before they
 * were written, and whose refusal was a silent `return`.
 *
 * Errors are the owning module's business: this file renders nothing and
 * stores no codes.
 */

import {
	dequeue,
	enqueue,
	jobKey,
	queuePosition,
	queuedBytes,
	removeJob,
	sameJob,
	type JobKey,
	type JobKind,
	type JobRef,
	type QueueJob,
} from '$lib/offline/downloadQueue';
import { acquireWakeLock, releaseWakeLock } from '$lib/ui/wakeLock';

/** What a module hands the queue. Resolving means the job did its work;
 *  throwing means it did not, and the module has already said so in its own
 *  view. The drain is outcome-blind on purpose: paused-versus-failed is a
 *  fact about a file on disk, and only the pack module can map an AbortError
 *  onto it. */
export type JobRun = (signal: AbortSignal, onProgress: (fraction: number) => void) => Promise<void>;

/** One holder tag for the WHOLE drain. ui/wakeLock.ts refcounts by tag, so
 *  acquiring twice and releasing once would silently strand the lock; the
 *  `draining` latch below is what guarantees the pair stays balanced. */
const WAKE_TAG = 'offline-queue';

export const offlineQueue = $state<{
	/** Jobs waiting, head first. The RUNNING job is NOT in here. */
	queue: QueueJob[];
	/** What the drain is running, null when idle. */
	running: JobRef | null;
	/** 0..1 for the running job. A mirror: each module writes its own richer
	 *  progress (bytes, tile counts) into its own view from the same
	 *  callback. One fraction is all a queue-level line can honestly show,
	 *  the three kinds not measuring the same thing. */
	progress: number;
	/** True from the first enqueue until the drain exits. For the UI only;
	 *  the re-entrancy guard is `draining`, which is not reactive. */
	busy: boolean;
}>({ queue: [], running: null, progress: 0, busy: false });

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- run closures, never rendered
const runs = new Map<JobKey, JobRun>();

/* The re-entrancy guard, in two parts on purpose. `draining` is the
 * SYNCHRONOUS latch: it is set between the test and any call, in the same
 * tick, which is exactly what the three flags this replaces could not do
 * (each was read, then written one to three awaits later). `drain` is only
 * the join handle haltDownloads() awaits. */
let draining = false;
let drain: Promise<void> | null = null;
let running: AbortController | null = null;
let stopped = false;

/** Whether this exact job is the one being run right now. */
export function isRunning(ref: JobRef): boolean {
	const r = offlineQueue.running;
	return r !== null && sameJob(r, ref);
}

/** 0-based place among the WAITING jobs, -1 when not waiting (the running
 *  job included: its row shows progress, not a position). */
export function queuedAt(ref: JobRef): number {
	return queuePosition(offlineQueue.queue, jobKey(ref));
}

export function isQueued(ref: JobRef): boolean {
	return queuedAt(ref) >= 0;
}

/** Bytes still owed, unknown sizes counted separately and never as zero. */
export function pendingBytes(): { known: number; unknown: number } {
	return queuedBytes(offlineQueue.queue);
}

/** How many jobs are outstanding, the running one included. */
export function pendingCount(): number {
	return offlineQueue.queue.length + (offlineQueue.running === null ? 0 : 1);
}

/** Ask for a job. Idempotent by key, and SYNCHRONOUS to its last line: there
 *  is no await anywhere on this path, so no window exists in which a second
 *  tap can act on a stale queue. That is the whole of the TOCTOU fix. */
export function enqueueDownload(
	ref: JobRef,
	job: { sizeBytes: number | null; localBytes: number; run: JobRun },
): void {
	if (isRunning(ref)) {
		return; // already going; the row shows progress, not a Download button
	}
	const key = jobKey(ref);
	runs.set(key, job.run);
	offlineQueue.queue = enqueue(offlineQueue.queue, {
		kind: ref.kind,
		id: ref.id,
		sizeBytes: job.sizeBytes,
		localBytes: job.localBytes,
	});
	kick();
}

/** Cancel one job, whichever state it is in. Running: ABORT, which each
 *  module maps onto its own paused state, and the drain then moves to the
 *  NEXT job, since cancelling one download is not cancelling the queue.
 *  Waiting: REMOVE, which touches no I/O and leaves the row as it was. Total
 *  by design: a row's state can change between the paint and the tap, and
 *  this has to be right either way. */
export function cancelDownload(ref: JobRef): void {
	if (isRunning(ref)) {
		running?.abort();
		return;
	}
	const key = jobKey(ref);
	runs.delete(key);
	offlineQueue.queue = removeJob(offlineQueue.queue, key);
}

/** Stand the whole queue down. The running job is aborted, so its own module
 *  records it as paused and its part survives. */
export function stopOfflineQueue(): void {
	stopped = true;
	offlineQueue.queue = [];
	runs.clear();
	running?.abort();
}

/** Stand down and JOIN the drain. For the tests, and for any future caller
 *  that erases what a job is writing into. */
export async function haltDownloads(): Promise<void> {
	stopOfflineQueue();
	await whenDrained();
}

function kick(): void {
	if (draining || offlineQueue.queue.length === 0) {
		return;
	}
	draining = true; // set BEFORE any call: no await stands between the test
	stopped = false; //  and this line, so two drains are unreachable
	offlineQueue.busy = true;
	drain = runDrain().finally(() => {
		draining = false;
		drain = null;
		/* A job enqueued in the WINDOW between the loop leaving and this
		 * callback would otherwise sit in the queue forever: that enqueue saw
		 * the latch still set and declined to start a drain, while the drain
		 * it was counting on had already gone. Not reachable from a click,
		 * which is a whole macrotask late, but it is one promise
		 * continuation away, so close it here rather than rely on every
		 * future caller arriving late enough. */
		if (offlineQueue.queue.length > 0) {
			kick();
			return;
		}
		offlineQueue.busy = false;
	});
}

async function runDrain(): Promise<void> {
	/* ONE lock for the WHOLE drain, not one per job. The pilot puts the
	 * phone down at "3 downloads, 4.1 GB": a lock taken and dropped between
	 * jobs opens a doze window exactly where the next stream is opening,
	 * which is the stall docs/offline-maps.md measured on the Redmi. The
	 * wake lock's own visibilitychange re-acquire then covers the whole
	 * drain rather than one job, holders staying non-empty throughout. */
	acquireWakeLock(WAKE_TAG);
	try {
		for (;;) {
			if (stopped) {
				return;
			}
			const { job, rest } = dequeue(offlineQueue.queue);
			if (job === null) {
				return;
			}
			offlineQueue.queue = rest;
			const key = jobKey(job);
			const run = runs.get(key);
			runs.delete(key);
			if (run === undefined) {
				continue; // removed under us; nothing to do
			}
			const controller = new AbortController();
			running = controller;
			offlineQueue.running = { kind: job.kind, id: job.id };
			offlineQueue.progress =
				job.sizeBytes && job.sizeBytes > 0 ? Math.min(1, job.localBytes / job.sizeBytes) : 0;
			try {
				await run(controller.signal, (f) => {
					offlineQueue.progress = f;
				});
			} catch {
				/* A job that fails, or is cancelled, must not stall the ones
				 * behind it: the module has already written its own view, and
				 * the pilot's other two packs are still wanted. The drain must
				 * NEVER reject; haltDownloads awaits it from inside a stop. */
			} finally {
				running = null;
				offlineQueue.running = null;
				offlineQueue.progress = 0;
			}
		}
	} finally {
		releaseWakeLock(WAKE_TAG);
		offlineQueue.running = null;
		offlineQueue.progress = 0;
	}
}

/** Resolves once the queue has gone quiet of its own accord. Unlike
 *  haltDownloads it stops nothing. It LOOPS because a drain can hand over to
 *  a successor (see kick's window note), and a caller asked to wait for
 *  quiet means quiet, not "the first drain ended". Idle resolves at once. */
export async function whenDrained(): Promise<void> {
	while (drain !== null) {
		await drain;
	}
}

export type { JobKind, JobRef };
