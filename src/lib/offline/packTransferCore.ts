/* packTransferCore.ts: the pack transfer worker's work (docs/offline-maps.md,
 * "Downloads"), bound to a worker by packTransfer.worker.ts and driven in
 * tests over an in-memory OPFS (tests/packTransferCore.spec.ts).
 *
 * The part is written IN PLACE through a FileSystemSyncAccessHandle, which
 * only a dedicated worker may hold: every byte is written once, where a
 * writable copied the whole part at each checkpoint, and a kill keeps every
 * byte written (they are in the OS page cache; probed on a renderer crash and
 * a force-stop, the tail exact). A power loss is another matter, the size can
 * outlive the data, so every FLUSH_BYTES the part is flushed and the sidecar
 * stamped with the length that is now durable; a resume builds on the stamp.
 *
 * The order of writes is the contract:
 *   1. the part's lock first, before any request (no second writer);
 *   2. a restart empties and flushes the part BEFORE it records the new
 *      edition in the sidecar, so a kill between leaves an empty part under
 *      the new etag, never the old edition's bytes;
 *   3. a resume past the stamp truncates the unvouched tail first;
 *   4. the terminal message only after both handles are closed, so the page
 *      may move or measure the part the moment it hears it. */

import {
	FLUSH_BYTES,
	PackHttpError,
	formatSidecar,
	openTransfer,
	parseSidecar,
	trustedLength,
} from './packTransfer';
import type { FromWorker, StartJob, ToWorker, TransferFailure } from './packTransferProtocol';

/** FileSystemSyncAccessHandle, declared here: its types ship only in
 *  lib.webworker. The four methods became synchronous in Chromium 108;
 *  typed either way and awaited, so an older engine works too. */
export interface SyncAccessHandle {
	read(buffer: Uint8Array, opts?: { at?: number }): number;
	write(buffer: Uint8Array, opts?: { at?: number }): number;
	getSize(): number | Promise<number>;
	truncate(size: number): void | Promise<void>;
	flush(): void | Promise<void>;
	close(): void | Promise<void>;
}

interface SyncCapableFile extends FileSystemFileHandle {
	createSyncAccessHandle?(): Promise<SyncAccessHandle>;
}

export interface CoreEnv {
	post(msg: FromWorker): void;
	root(): Promise<FileSystemDirectoryHandle>;
	/** Null when this scope can hold sync access handles, else why not. */
	probe(): string | null;
	now(): number;
	sleep(ms: number): Promise<void>;
	fetch?: typeof fetch | undefined;
}

export interface CoreOptions {
	flushBytes?: number;
	/** Progress is posted at most this often. */
	progressMs?: number;
	/** A lock another context released can linger: retried this many times,
	 *  this far apart (by default 30 s), before the attempt gives up. A
	 *  terminated worker's goes within 20 ms, but a CRASHED renderer's lives
	 *  as long as its tab: about 2 s after the crashed tab is closed or
	 *  replaced (probed in Chromium; a sad tab left open holds it for good,
	 *  and an Android force-stop takes the whole app and its locks). A pause
	 *  ends the wait at once. */
	lockTries?: number;
	lockWaitMs?: number;
}

/** Thrown before anything is written or fetched: the page may take over. */
class Unsupported extends Error {}

const isLockError = (e: unknown): boolean => (e as DOMException | null)?.name === 'NoModificationAllowedError';

/** The failure a thrown error stands for. Anything raised while the page has
 *  asked to stop is the stop. */
function failureOf(e: unknown, signal: AbortSignal): TransferFailure {
	if (signal.aborted) {
		return { kind: 'abort' };
	}
	if (e instanceof PackHttpError) {
		return { kind: 'http', status: e.status, phase: e.phase };
	}
	const name = (e as { name?: unknown } | null)?.name;
	const message = (e as { message?: unknown } | null)?.message;
	if (name === 'AbortError') {
		return { kind: 'abort' };
	}
	return {
		kind: 'error',
		name: typeof name === 'string' ? name : 'Error',
		message: typeof message === 'string' ? message : String(e),
	};
}

const encoder = new TextEncoder();

export class PackTransferCore {
	private started = false;
	private settled = false;
	private readonly controller = new AbortController();
	private received = 0;
	private total: number | null = null;

	constructor(
		private readonly env: CoreEnv,
		private readonly opts: CoreOptions = {},
	) {}

	/** Say whether this scope can do the work. */
	start(): void {
		const reason = this.env.probe();
		this.env.post(reason === null ? { type: 'ready' } : { type: 'unsupported', reason });
	}

	handle(msg: ToWorker): void {
		if (msg.type === 'abort') {
			this.controller.abort();
			return;
		}
		if (!this.started) {
			this.started = true;
			void this.run(msg);
		}
	}

	/** A rejection nothing caught (the worker's unhandledrejection hook): the
	 *  page still hears one terminal message. */
	fail(reason: unknown): void {
		this.finish({
			type: 'failed',
			received: this.received,
			total: this.total,
			failure: failureOf(reason, this.controller.signal),
		});
	}

	private finish(msg: FromWorker): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.env.post(msg);
	}

	private async run(job: StartJob): Promise<void> {
		let msg: FromWorker;
		try {
			const r = await this.transfer(job, this.controller.signal);
			msg = { type: 'done', ...r };
		} catch (e) {
			msg =
				e instanceof Unsupported
					? { type: 'unsupported', reason: e.message }
					: { type: 'failed', received: this.received, total: this.total, failure: failureOf(e, this.controller.signal) };
		}
		this.finish(msg);
	}

	private async lock(file: SyncCapableFile): Promise<SyncAccessHandle> {
		const tries = this.opts.lockTries ?? 120;
		const wait = this.opts.lockWaitMs ?? 250;
		for (let i = 1; ; i++) {
			try {
				if (typeof file.createSyncAccessHandle !== 'function') {
					// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
					throw new Unsupported('createSyncAccessHandle missing');
				}
				return await file.createSyncAccessHandle();
			} catch (e) {
				if (!isLockError(e) || i >= tries || this.controller.signal.aborted) {
					throw e;
				}
				await this.env.sleep(wait);
			}
		}
	}

	private async transfer(
		job: StartJob,
		signal: AbortSignal,
	): Promise<{ received: number; total: number | null; etag: string | null }> {
		const dir = await (await this.env.root()).getDirectoryHandle(job.dir, { create: true });
		const partCreated = !(await exists(dir, job.part));
		const sideCreated = !(await exists(dir, job.etagFile));
		const partFile = (await dir.getFileHandle(job.part, { create: true })) as SyncCapableFile;

		let part: SyncAccessHandle;
		try {
			part = await this.lock(partFile);
		} catch (e) {
			if (partCreated) {
				await dir.removeEntry(job.part).catch(() => undefined);
			}
			if (isLockError(e) || e instanceof Unsupported) {
				throw e;
			}
			const err = e as { name?: string; message?: string } | null;
			throw new Unsupported(`createSyncAccessHandle: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}`);
		}

		let side: SyncAccessHandle | null = null;
		let etag: string | null = null;
		// What the sidecar must say when the attempt ends: the part's length
		// once flushed, under its etag. Null until the attempt knows both.
		let stampable = false;
		const flushBytes = this.opts.flushBytes ?? FLUSH_BYTES;
		try {
			const size = await part.getSize();
			side = await this.lock(await dir.getFileHandle(job.etagFile, { create: true }));
			const sidecar = parseSidecar(await readAll(side));
			const t = await openTransfer(job.url, { bytes: trustedLength(size, sidecar), etag: sidecar.etag }, signal, this.env.fetch);
			etag = t.etag;
			if (t.kind === 'complete') {
				if (size > t.total) {
					await part.truncate(t.total);
					await part.flush();
				}
				this.track(t.total, t.total);
				return { received: t.total, total: t.total, etag: t.etag };
			}

			if (t.offset === 0) {
				// Empty the part and make that durable, THEN name the new
				// edition: in the other order a kill left the old edition's
				// bytes under the new etag.
				await part.truncate(0);
				await part.flush();
				await rewriteSidecar(side, 0, etag);
			} else {
				if (size > t.offset) {
					// The tail past the stamp is not known to be good.
					await part.truncate(t.offset);
					await part.flush();
				}
				if (sidecar.flushed === null) {
					// A page-path part, trusted to its size: from now on its
					// record is the stamp.
					await rewriteSidecar(side, t.offset, etag);
				}
			}
			stampable = true;
			this.track(t.offset, t.total);

			let at = t.offset;
			let sinceFlush = 0;
			let lastPost = this.env.now();
			const progressMs = this.opts.progressMs ?? 250;
			const reader = t.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				writeAll(part, value, at);
				at += value.byteLength;
				sinceFlush += value.byteLength;
				this.track(at, t.total);
				if (sinceFlush >= flushBytes) {
					await part.flush();
					await stamp(side, at, etag);
					sinceFlush = 0;
				}
				const now = this.env.now();
				if (now - lastPost >= progressMs) {
					lastPost = now;
					this.env.post({ type: 'progress', received: at, total: t.total });
				}
			}
			return { received: at, total: t.total, etag };
		} finally {
			// Whatever ended the attempt, what was written is made durable and
			// recorded, and both locks go before the page hears anything.
			try {
				await part.flush();
				if (side && stampable) {
					await stamp(side, this.received, etag);
				}
			} catch {
				/* the next attempt trusts the last stamp */
			}
			let emptied = false;
			try {
				emptied = partCreated && (await part.getSize()) === 0;
			} catch {
				/* closing regardless */
			}
			await Promise.resolve(side?.close()).catch(() => undefined);
			await Promise.resolve(part.close()).catch(() => undefined);
			if (emptied) {
				// A first attempt that wrote nothing (a 404, an abort before the
				// body) leaves no file behind.
				await dir.removeEntry(job.part).catch(() => undefined);
				if (sideCreated) {
					await dir.removeEntry(job.etagFile).catch(() => undefined);
				}
			}
		}
	}

	private track(received: number, total: number | null): void {
		this.received = received;
		this.total = total;
	}
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
	try {
		await dir.getFileHandle(name);
		return true;
	} catch {
		return false;
	}
}

/** Write a chunk whole at `at`, however many calls it takes. A write that
 *  makes no progress is an error, never a loop. */
function writeAll(h: SyncAccessHandle, chunk: Uint8Array, at: number): void {
	let off = 0;
	while (off < chunk.byteLength) {
		const n = h.write(chunk.subarray(off), { at: at + off });
		if (!(n > 0)) {
			// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
			throw new Error(`write made no progress at ${at + off}`);
		}
		off += n;
	}
}

async function readAll(h: SyncAccessHandle): Promise<string> {
	const n = await h.getSize();
	const buf = new Uint8Array(n);
	if (n > 0) {
		h.read(buf, { at: 0 });
	}
	return new TextDecoder().decode(buf);
}

/** The sidecar from scratch: a new edition, or a legacy record becoming a
 *  stamp. */
async function rewriteSidecar(h: SyncAccessHandle, flushed: number, etag: string | null): Promise<void> {
	await h.truncate(0);
	await stamp(h, flushed, etag);
}

/** The flushed length, in place at offset 0: the record is fixed-width for a
 *  given etag, so it is overwritten whole and never truncated. */
async function stamp(h: SyncAccessHandle, flushed: number, etag: string | null): Promise<void> {
	writeAll(h, encoder.encode(formatSidecar(flushed, etag)), 0);
	await h.flush();
}
