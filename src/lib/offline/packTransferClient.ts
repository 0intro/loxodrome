/* packTransferClient.ts: the page's side of the pack transfer worker
 * (packTransfer.worker.ts, docs/offline-maps.md "Downloads"), loaded by
 * packStore only when a download runs, so the NOTAM Viewer, which reaches
 * packStore through the aerodrome panel, never ships the worker.
 *
 * One worker per transfer, terminated whenever it settles. The page hears
 * progress, then one terminal message posted after the worker closed its
 * handles, so the part may be measured, moved or deleted the moment this
 * settles. What a settle means for the caller:
 *   - an outcome: the bytes are written, the page commits them;
 *   - null: the worker never took the attempt (no Worker, `unsupported`, a
 *     load error or no `ready` in time) and nothing was written: the caller
 *     runs it on the page, and the session gives up on the worker, saying so
 *     once in the console;
 *   - a rejection: the transfer's own failure, in the very error the three
 *     state modules already test (an AbortError, a PackHttpError, a
 *     DOMException keeping its name). An error AFTER the start rejects too
 *     and gives up on the worker, but never falls back within the attempt:
 *     a lock may still be held.
 * Deadlines count visible time only (a hidden page's timers wait), with the
 * airspace worker client's stall rule. */

import { PackHttpError } from './packTransfer';
import type { FromWorker, StartJob, ToWorker, TransferFailure } from './packTransferProtocol';

/** How long a worker may take to say it is ready, while the page shows. */
export const READY_TIMEOUT_MS = 20_000;
/** How long a worker may take to answer a pause before it is stopped (which
 *  releases its lock too; the bytes it wrote stay). */
export const ABORT_GRACE_MS = 15_000;
/** A deadline that fires this late says the PAGE did not run. */
export const STALL_MS = 250;

export interface TransferJob {
	dir: string;
	part: string;
	etagFile: string;
	/** Absolute: the worker resolves against its own script. */
	url: string;
}

export interface WorkerOutcome {
	received: number;
	total: number | null;
	etag: string | null;
}

/** The part of a Worker this client uses, so a test can stand one in. */
export interface WorkerLike {
	postMessage(message: ToWorker): void;
	terminate(): void;
	onmessage: ((e: MessageEvent<FromWorker>) => void) | null;
	onerror: ((e: { message?: string; preventDefault?(): void }) => void) | null;
	onmessageerror: ((e: unknown) => void) | null;
}

/** The worker, as the page makes one: the constructor call is written out
 *  where Vite finds it and bundles the worker beside the app. */
export function startPackWorker(): WorkerLike | null {
	if (typeof Worker !== 'function') {
		return null;
	}
	try {
		return new Worker(new URL('./packTransfer.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
	} catch {
		return null;
	}
}

let givenUp = false;

/** Whether this session still sends transfers to the worker. */
export function packWorkerUsable(): boolean {
	return !givenUp;
}

/** For tests: a fresh session's verdict. */
export function resetPackWorker(): void {
	givenUp = false;
}

function giveUp(reason: string, quiet = false): void {
	if (givenUp) {
		return;
	}
	givenUp = true;
	if (!quiet) {
		console.warn(`[loxodrome] offline packs written on the page: worker ${reason}`);
	}
}

/** The error a failure stands for, as the callers test it. */
export function errorOf(f: TransferFailure): Error {
	switch (f.kind) {
		case 'abort':
			return new DOMException('aborted', 'AbortError');
		case 'http':
			return new PackHttpError(f.status, f.phase);
		case 'error':
			return new DOMException(f.message, f.name);
	}
}

const aborted = (): DOMException => new DOMException('aborted', 'AbortError');

/** Run one transfer in a worker. See the file comment for what the three
 *  settles mean. */
export function transferInWorker(
	job: TransferJob,
	opts: {
		signal?: AbortSignal | undefined;
		onProgress?: ((p: { received: number; total: number | null }) => void) | undefined;
	} = {},
	spawn: () => WorkerLike | null = startPackWorker,
): Promise<WorkerOutcome | null> {
	if (givenUp) {
		return Promise.resolve(null);
	}
	if (opts.signal?.aborted) {
		return Promise.reject(aborted());
	}
	const w = spawn();
	if (w === null) {
		// No Worker here at all: an engine or a test without them, not a
		// failure worth a warning.
		giveUp('unavailable', true);
		return Promise.resolve(null);
	}
	const signal = opts.signal;
	return new Promise<WorkerOutcome | null>((resolve, reject) => {
		let phase: 'starting' | 'running' | 'settled' = 'starting';
		let timer: ReturnType<typeof setTimeout> | null = null;
		let waiting: { ms: number; why: 'ready' | 'abort' } | null = null;

		const disarm = (): void => {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			waiting = null;
		};
		const arm = (ms: number, why: 'ready' | 'abort'): void => {
			disarm();
			waiting = { ms, why };
			// Wall time: a clock stepped forward reads as a stall and costs
			// one more wait, the safe way to be wrong.
			const due = Date.now() + ms;
			timer = setTimeout(() => {
				timer = null;
				if (document.hidden) {
					return; // judged once the page shows again
				}
				if (Date.now() - due > STALL_MS) {
					arm(ms, why); // the page ran late: an answer may be queued
					return;
				}
				if (why === 'ready') {
					fallback('ready-timeout');
				} else {
					fail(aborted());
				}
			}, ms);
		};
		const onVisibility = (): void => {
			if (!document.hidden && waiting) {
				arm(waiting.ms, waiting.why);
			}
		};
		const onAbort = (): void => {
			if (phase === 'starting') {
				// Nothing is open yet.
				fail(aborted());
			} else if (phase === 'running') {
				w.postMessage({ type: 'abort' });
				arm(ABORT_GRACE_MS, 'abort');
			}
		};
		const settle = (then: () => void): void => {
			if (phase === 'settled') {
				return;
			}
			phase = 'settled';
			disarm();
			document.removeEventListener('visibilitychange', onVisibility);
			signal?.removeEventListener('abort', onAbort);
			w.onmessage = null;
			w.onerror = null;
			w.onmessageerror = null;
			w.terminate();
			then();
		};
		const fallback = (reason: string): void => {
			settle(() => {
				giveUp(reason);
				resolve(null);
			});
		};
		const fail = (err: Error): void => {
			settle(() => {
				reject(err);
			});
		};
		const broke = (reason: string): void => {
			if (phase === 'starting') {
				fallback(reason);
				return;
			}
			// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
			const err = signal?.aborted ? aborted() : new Error(`pack worker ${reason}`);
			settle(() => {
				giveUp(reason);
				reject(err);
			});
		};

		w.onmessage = (e) => {
			const m = e.data;
			switch (m.type) {
				case 'ready':
					if (phase === 'starting') {
						disarm();
						phase = 'running';
						const start: StartJob = { type: 'start', ...job };
						w.postMessage(start);
					}
					return;
				case 'unsupported':
					// Only ever before anything was written or fetched.
					fallback(`unsupported: ${m.reason}`);
					return;
				case 'progress':
					if (phase === 'running') {
						opts.onProgress?.({ received: m.received, total: m.total });
					}
					return;
				case 'done':
					if (phase !== 'settled') {
						opts.onProgress?.({ received: m.received, total: m.total });
						settle(() => {
							resolve({ received: m.received, total: m.total, etag: m.etag });
						});
					}
					return;
				case 'failed':
					if (phase !== 'settled') {
						// The bytes kept, exact, before the caller reads its row.
						opts.onProgress?.({ received: m.received, total: m.total });
						fail(errorOf(m.failure));
					}
					return;
			}
		};
		w.onerror = (e) => {
			e.preventDefault?.();
			broke(`error: ${e.message ?? 'unknown'}`);
		};
		w.onmessageerror = () => {
			broke('messageerror');
		};
		document.addEventListener('visibilitychange', onVisibility);
		signal?.addEventListener('abort', onAbort);
		arm(READY_TIMEOUT_MS, 'ready');
	});
}
