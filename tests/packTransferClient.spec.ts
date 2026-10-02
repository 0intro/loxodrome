/* The page's side of the pack transfer worker
 * (offline/packTransferClient.ts), over a worker stood in by a message
 * recorder, timers faked:
 *   - ready, then the start; progress and done reach the caller, the worker
 *     is terminated;
 *   - a worker that never takes the attempt (unsupported, an error before
 *     ready, no ready in time while the page shows) resolves null for the
 *     page path, once per session; a hidden page is never judged, a deadline
 *     the page ran late is re-armed;
 *   - a pause before ready starts nothing; while running it asks the worker
 *     and settles on its answer, the bytes kept reported first, or after the
 *     grace by terminate(); done crossing a pause wins;
 *   - failures come back as the errors the state modules test;
 *   - an error after the start rejects, gives up on the worker, and never
 *     falls back within the attempt. */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { PackHttpError } from '$lib/offline/packTransfer';
import {
	ABORT_GRACE_MS,
	READY_TIMEOUT_MS,
	STALL_MS,
	resetPackWorker,
	transferInWorker,
	type TransferJob,
	type WorkerLike,
} from '$lib/offline/packTransferClient';
import type { FromWorker, ToWorker } from '$lib/offline/packTransferProtocol';

class FakeWorker implements WorkerLike {
	readonly sent: ToWorker[] = [];
	terminated = false;
	onmessage: WorkerLike['onmessage'] = null;
	onerror: WorkerLike['onerror'] = null;
	onmessageerror: WorkerLike['onmessageerror'] = null;
	postMessage(m: ToWorker): void {
		this.sent.push(m);
	}
	terminate(): void {
		this.terminated = true;
	}
	answer(data: FromWorker): void {
		this.onmessage?.({ data } as MessageEvent<FromWorker>);
	}
}

const doc = Object.assign(new EventTarget(), { hidden: false });
const JOB: TransferJob = { dir: 'basemap-packs', part: 'planign.pmtiles.part', etagFile: 'planign.pmtiles.etag', url: 'https://charts.example/planign/archive' };

let worker: FakeWorker;
let spawns: number;
const spawn = (): WorkerLike => {
	spawns++;
	worker = new FakeWorker();
	return worker;
};
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	doc.hidden = false;
	vi.stubGlobal('document', doc);
	resetPackWorker();
	spawns = 0;
	warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	warn.mockRestore();
});

/** A promise's state without waiting for it. */
async function state<T>(p: Promise<T>): Promise<'pending' | { value: T } | { error: unknown }> {
	const out = await Promise.race([
		p.then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		),
		Promise.resolve('pending' as const),
	]);
	return out;
}

describe('a transfer in the worker', () => {
	it('starts on ready, reports progress, and resolves done with the worker stopped', async () => {
		const progress: unknown[] = [];
		const p = transferInWorker(JOB, { onProgress: (x) => progress.push(x) }, spawn);
		expect(worker.sent).toEqual([]);
		worker.answer({ type: 'ready' });
		expect(worker.sent).toEqual([{ type: 'start', ...JOB }]);
		worker.answer({ type: 'progress', received: 400, total: 1000 });
		worker.answer({ type: 'done', received: 1000, total: 1000, etag: '"e"' });
		expect(await p).toEqual({ received: 1000, total: 1000, etag: '"e"' });
		expect(progress).toEqual([
			{ received: 400, total: 1000 },
			{ received: 1000, total: 1000 },
		]);
		expect(worker.terminated).toBe(true);
	});

	it('hands an unsupported worker to the page, and stops asking for one', async () => {
		const p = transferInWorker(JOB, {}, spawn);
		worker.answer({ type: 'unsupported', reason: 'no sync access handles' });
		expect(await p).toBeNull();
		expect(worker.terminated).toBe(true);
		expect(warn).toHaveBeenCalledOnce();
		expect(await transferInWorker(JOB, {}, spawn)).toBeNull();
		expect(spawns).toBe(1);
	});

	it('hands the attempt to the page when the worker refuses it after the start', async () => {
		const p = transferInWorker(JOB, {}, spawn);
		worker.answer({ type: 'ready' });
		worker.answer({ type: 'unsupported', reason: 'createSyncAccessHandle: NotSupportedError' });
		expect(await p).toBeNull();
	});

	it('hands the attempt to the page on an error or a message error before ready', async () => {
		const a = transferInWorker(JOB, {}, spawn);
		worker.onerror?.({ message: 'script failed', preventDefault: () => undefined });
		expect(await a).toBeNull();
		resetPackWorker();
		const b = transferInWorker(JOB, {}, spawn);
		worker.onmessageerror?.({});
		expect(await b).toBeNull();
	});

	it('gives up on a worker silent past the deadline, but never judges a hidden page', async () => {
		const p = transferInWorker(JOB, {}, spawn);
		doc.hidden = true;
		vi.advanceTimersByTime(READY_TIMEOUT_MS + 1000);
		expect(await state(p)).toBe('pending');
		doc.hidden = false;
		doc.dispatchEvent(new Event('visibilitychange'));
		vi.advanceTimersByTime(READY_TIMEOUT_MS - 1);
		expect(await state(p)).toBe('pending');
		vi.advanceTimersByTime(1);
		expect(await p).toBeNull();
	});

	it('re-arms a deadline the page itself ran late', async () => {
		const p = transferInWorker(JOB, {}, spawn);
		vi.setSystemTime(Date.now() + STALL_MS + 1000);
		vi.advanceTimersByTime(READY_TIMEOUT_MS);
		expect(await state(p)).toBe('pending');
		vi.advanceTimersByTime(READY_TIMEOUT_MS);
		expect(await p).toBeNull();
	});
});

describe('a pause', () => {
	it('before ready rejects at once and starts nothing', async () => {
		const ac = new AbortController();
		const p = transferInWorker(JOB, { signal: ac.signal }, spawn);
		ac.abort();
		await expect(p).rejects.toMatchObject({ name: 'AbortError' });
		expect(worker.sent).toEqual([]);
		expect(worker.terminated).toBe(true);
	});

	it('while running asks the worker, and settles on its answer with the bytes kept', async () => {
		const ac = new AbortController();
		const progress: unknown[] = [];
		const p = transferInWorker(JOB, { signal: ac.signal, onProgress: (x) => progress.push(x) }, spawn);
		worker.answer({ type: 'ready' });
		ac.abort();
		expect(worker.sent.at(-1)).toEqual({ type: 'abort' });
		expect(await state(p)).toBe('pending');
		expect(worker.terminated).toBe(false);
		worker.answer({ type: 'failed', received: 500, total: 1000, failure: { kind: 'abort' } });
		await expect(p).rejects.toMatchObject({ name: 'AbortError' });
		expect(progress.at(-1)).toEqual({ received: 500, total: 1000 });
		expect(worker.terminated).toBe(true);
	});

	it('the worker does not answer is ended by terminate after the grace', async () => {
		const ac = new AbortController();
		const p = transferInWorker(JOB, { signal: ac.signal }, spawn);
		worker.answer({ type: 'ready' });
		ac.abort();
		vi.advanceTimersByTime(ABORT_GRACE_MS - 1);
		expect(await state(p)).toBe('pending');
		vi.advanceTimersByTime(1);
		await expect(p).rejects.toMatchObject({ name: 'AbortError' });
		expect(worker.terminated).toBe(true);
	});

	it('crossing a done loses to it: the pack is complete', async () => {
		const ac = new AbortController();
		const p = transferInWorker(JOB, { signal: ac.signal }, spawn);
		worker.answer({ type: 'ready' });
		ac.abort();
		worker.answer({ type: 'done', received: 1000, total: 1000, etag: null });
		expect(await p).toEqual({ received: 1000, total: 1000, etag: null });
	});
});

describe('failures', () => {
	it('come back as the errors the callers test', async () => {
		const a = transferInWorker(JOB, {}, spawn);
		worker.answer({ type: 'ready' });
		worker.answer({ type: 'failed', received: 0, total: null, failure: { kind: 'http', status: 404, phase: 'HEAD' } });
		const e = await a.catch((x: unknown) => x);
		expect(e).toBeInstanceOf(PackHttpError);
		expect(e).toMatchObject({ status: 404, phase: 'HEAD' });

		const b = transferInWorker(JOB, {}, spawn);
		worker.answer({ type: 'ready' });
		worker.answer({ type: 'failed', received: 10, total: 1000, failure: { kind: 'error', name: 'QuotaExceededError', message: 'full' } });
		await expect(b).rejects.toMatchObject({ name: 'QuotaExceededError', message: 'full' });
	});

	it('an error after the start rejects, gives up on the worker, and never falls back', async () => {
		const p = transferInWorker(JOB, {}, spawn);
		worker.answer({ type: 'ready' });
		worker.onerror?.({ message: 'crashed', preventDefault: () => undefined });
		await expect(p).rejects.toThrow(/pack worker error: crashed/);
		expect(await transferInWorker(JOB, {}, spawn)).toBeNull();
		expect(spawns).toBe(1);
	});

	it('ignores what a worker says after it settled', async () => {
		const progress: unknown[] = [];
		const p = transferInWorker(JOB, { onProgress: (x) => progress.push(x) }, spawn);
		worker.answer({ type: 'ready' });
		worker.answer({ type: 'done', received: 1000, total: 1000, etag: null });
		worker.answer({ type: 'failed', received: 3, total: 1000, failure: { kind: 'abort' } });
		worker.answer({ type: 'progress', received: 7, total: 1000 });
		expect(await p).toMatchObject({ received: 1000 });
		expect(progress).toEqual([{ received: 1000, total: 1000 }]);
	});

	it('rejects a signal already aborted without making a worker, and resolves null quietly with no Worker at all', async () => {
		const ac = new AbortController();
		ac.abort();
		await expect(transferInWorker(JOB, { signal: ac.signal }, spawn)).rejects.toMatchObject({ name: 'AbortError' });
		expect(spawns).toBe(0);
		expect(await transferInWorker(JOB, {}, () => null)).toBeNull();
		expect(warn).not.toHaveBeenCalled();
	});
});
