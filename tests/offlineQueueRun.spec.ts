/* The offline queue's DRAIN (state/offlineQueue.svelte.ts): the part that
 * replaced three ad-hoc mutexes, and so the part that has to pin the five
 * defects they had. Sequencing, the synchronous latch, cancel's two
 * meanings, a failing job not stranding the queue, and one balanced wake
 * lock for the whole drain rather than one per job.
 *
 * The latch is module state, so every case takes a fresh module (the
 * resetModules idiom, tests/bootSweep.spec.ts). */
import { describe, expect, it, vi } from 'vitest';

const CHART = { kind: 'chart', id: 'fr500' } as const;
const DOC = { kind: 'doc', id: 'fr-vac' } as const;
const TERRAIN = { kind: 'terrain', id: 'plan' } as const;

/** A fresh queue module with the wake lock stubbed, so each case counts its
 *  own acquires. */
async function freshQueue(): Promise<{
	q: typeof import('../src/lib/state/offlineQueue.svelte');
	wake: { acquired: string[]; released: string[] };
}> {
	vi.resetModules();
	const wake = { acquired: [] as string[], released: [] as string[] };
	vi.doMock('$lib/ui/wakeLock', () => ({
		acquireWakeLock: (tag: string) => void wake.acquired.push(tag),
		releaseWakeLock: (tag: string) => void wake.released.push(tag),
	}));
	const q = await import('../src/lib/state/offlineQueue.svelte');
	return { q, wake };
}

/** A job that resolves after `ticks` microtask turns, recording when it ran
 *  against a shared in-flight counter. */
function tracker() {
	const log: string[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const make =
		(name: string, opts: { ticks?: number; fail?: boolean } = {}) =>
		async (signal: AbortSignal): Promise<void> => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			log.push(`${name}:start`);
			try {
				for (let i = 0; i < (opts.ticks ?? 2); i++) {
					await Promise.resolve();
					if (signal.aborted) {
						log.push(`${name}:aborted`);
						throw new DOMException('aborted', 'AbortError');
					}
				}
				if (opts.fail) {
					log.push(`${name}:fail`);
					throw new Error('boom');
				}
				log.push(`${name}:done`);
			} finally {
				inFlight--;
			}
		};
	return {
		log,
		make,
		get maxInFlight() {
			return maxInFlight;
		},
	};
}

const job = (run: (s: AbortSignal) => Promise<void>, size = 100) => ({
	sizeBytes: size,
	localBytes: 0,
	run,
});

describe('the drain', () => {
	it('runs two jobs enqueued in the SAME TICK strictly one at a time', async () => {
		const { q } = await freshQueue();
		const t = tracker();
		// The defect this replaces: both guards were read synchronously and
		// written three awaits later, so two same-tick taps both proceeded.
		q.enqueueDownload(CHART, job(t.make('chart')));
		q.enqueueDownload(DOC, job(t.make('doc')));
		await q.whenDrained();
		expect(t.maxInFlight).toBe(1);
		expect(t.log).toEqual(['chart:start', 'chart:done', 'doc:start', 'doc:done']);
	});

	it('runs a repeated tap on one job exactly once', async () => {
		const { q } = await freshQueue();
		const t = tracker();
		q.enqueueDownload(CHART, job(t.make('chart')));
		q.enqueueDownload(CHART, job(t.make('chart')));
		q.enqueueDownload(CHART, job(t.make('chart')));
		await q.whenDrained();
		expect(t.log.filter((l) => l === 'chart:start')).toHaveLength(1);
	});

	it('drains in tap order across all three kinds', async () => {
		const { q } = await freshQueue();
		const t = tracker();
		q.enqueueDownload(TERRAIN, job(t.make('terrain')));
		q.enqueueDownload(CHART, job(t.make('chart')));
		q.enqueueDownload(DOC, job(t.make('doc')));
		await q.whenDrained();
		expect(t.log.filter((l) => l.endsWith(':start'))).toEqual([
			'terrain:start',
			'chart:start',
			'doc:start',
		]);
	});

	it('runs a job enqueued between the loop exiting and the latch clearing', async () => {
		// The drain-exit window. An enqueue landing there sees `draining`
		// still set and declines to start a drain, while the drain it was
		// counting on has already left its loop; the job would sit in the
		// queue forever with nothing running. A click is a whole macrotask
		// late, but a promise continuation is not.
		const { q } = await freshQueue();
		let ran = false;
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		q.enqueueDownload(CHART, { sizeBytes: 1, localBytes: 0, run: () => gate });
		// Registered AFTER the drain's own await, so it resumes once the
		// drain has left the loop and before its finally callback.
		void gate.then(() => {
			q.enqueueDownload(DOC, {
				sizeBytes: 1,
				localBytes: 0,
				run: () => {
					ran = true;
					return Promise.resolve();
				},
			});
		});
		release();
		await q.whenDrained();
		expect({ ran, waiting: q.offlineQueue.queue.length }).toEqual({ ran: true, waiting: 0 });
	});

	it('keeps going after a job FAILS', async () => {
		const { q } = await freshQueue();
		const t = tracker();
		q.enqueueDownload(CHART, job(t.make('chart', { fail: true })));
		q.enqueueDownload(DOC, job(t.make('doc')));
		await q.whenDrained();
		expect(t.log).toContain('chart:fail');
		expect(t.log).toContain('doc:done');
	});

	it('reports busy while it has work and idle when it is done', async () => {
		const { q } = await freshQueue();
		const t = tracker();
		expect(q.pendingCount()).toBe(0);
		q.enqueueDownload(CHART, job(t.make('chart')));
		expect(q.offlineQueue.busy).toBe(true);
		expect(q.pendingCount()).toBe(1);
		await q.whenDrained();
		expect(q.offlineQueue.busy).toBe(false);
		expect(q.pendingCount()).toBe(0);
	});
});

describe('cancel', () => {
	it('aborts the RUNNING job and moves on to the next', async () => {
		const { q } = await freshQueue();
		const t = tracker();
		q.enqueueDownload(CHART, job(t.make('chart', { ticks: 50 })));
		q.enqueueDownload(DOC, job(t.make('doc')));
		await Promise.resolve();
		await Promise.resolve();
		expect(q.isRunning(CHART)).toBe(true);
		q.cancelDownload(CHART);
		await q.whenDrained();
		expect(t.log).toContain('chart:aborted');
		// Cancelling ONE download is not cancelling the queue.
		expect(t.log).toContain('doc:done');
	});

	it('removes a WAITING job without ever running it', async () => {
		const { q } = await freshQueue();
		const t = tracker();
		q.enqueueDownload(CHART, job(t.make('chart', { ticks: 20 })));
		q.enqueueDownload(DOC, job(t.make('doc')));
		await Promise.resolve();
		expect(q.isQueued(DOC)).toBe(true);
		q.cancelDownload(DOC);
		expect(q.isQueued(DOC)).toBe(false);
		await q.whenDrained();
		expect(t.log.some((l) => l.startsWith('doc:'))).toBe(false);
	});

	it('reports a waiting job position, and none for the running one', async () => {
		const { q } = await freshQueue();
		const t = tracker();
		q.enqueueDownload(CHART, job(t.make('chart', { ticks: 30 })));
		q.enqueueDownload(DOC, job(t.make('doc')));
		q.enqueueDownload(TERRAIN, job(t.make('terrain')));
		await Promise.resolve();
		await Promise.resolve();
		expect(q.queuedAt(CHART)).toBe(-1); // running
		expect(q.queuedAt(DOC)).toBe(0);
		expect(q.queuedAt(TERRAIN)).toBe(1);
		await q.whenDrained();
	});


	it('stops the whole queue and joins the drain', async () => {
		const { q } = await freshQueue();
		const t = tracker();
		q.enqueueDownload(CHART, job(t.make('chart', { ticks: 50 })));
		q.enqueueDownload(DOC, job(t.make('doc')));
		await Promise.resolve();
		await q.haltDownloads();
		expect(t.log).toContain('chart:aborted');
		expect(t.log.some((l) => l.startsWith('doc:'))).toBe(false);
	});
});

describe('the wake lock', () => {
	it('is taken ONCE for a three-job drain and released once', async () => {
		const { q, wake } = await freshQueue();
		const t = tracker();
		q.enqueueDownload(CHART, job(t.make('chart')));
		q.enqueueDownload(DOC, job(t.make('doc')));
		q.enqueueDownload(TERRAIN, job(t.make('terrain')));
		await q.whenDrained();
		// One per job would open a doze window exactly where the next stream
		// opens, which is the stall docs/offline-maps.md measured.
		expect(wake.acquired).toEqual(['offline-queue']);
		expect(wake.released).toEqual(['offline-queue']);
	});

	it('is released even when every job fails', async () => {
		const { q, wake } = await freshQueue();
		const t = tracker();
		q.enqueueDownload(CHART, job(t.make('chart', { fail: true })));
		await q.whenDrained();
		expect(wake.released).toEqual(['offline-queue']);
	});

	it('is taken again by a drain that starts after the first one ended', async () => {
		const { q, wake } = await freshQueue();
		const t = tracker();
		q.enqueueDownload(CHART, job(t.make('chart')));
		await q.whenDrained();
		q.enqueueDownload(DOC, job(t.make('doc')));
		await q.whenDrained();
		expect(wake.acquired).toHaveLength(2);
		expect(wake.released).toHaveLength(2);
	});
});
