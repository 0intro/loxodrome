/* When a layer that paints away from its canvas sends a painting and which it
 * shows (map/paintScheduler.ts). Scripted sequences for each rule (a
 * request made now going at once unless one is on its way, queued or held),
 * then a
 * seeded random walk over requests, holds, releases, landings and failures
 * that checks the invariants after every step: one painting in flight at
 * most, nothing sent while held, nothing shown that was made before a hold,
 * no request lost (once idle, the last painting shown was sent after the last
 * request), and whenIdle resolving exactly when idle. */

import { describe, expect, it } from 'vitest';
import { PaintScheduler } from '$lib/map/paintScheduler';

interface Log {
	sent: number[];
	shown: number[];
	dropped: number[];
}

function scheduler(): { s: PaintScheduler<number>; log: Log } {
	const log: Log = { sent: [], shown: [], dropped: [] };
	const s = new PaintScheduler<number>({
		send: (seq) => log.sent.push(seq),
		present: (frame) => log.shown.push(frame),
		discard: (frame) => log.dropped.push(frame),
	});
	return { s, log };
}

/** Let the queued pump run. */
const tick = (): Promise<void> => Promise.resolve();

describe('PaintScheduler', () => {
	it('sends one painting for a burst of requests, after the task that made them', async () => {
		const { s, log } = scheduler();
		s.request();
		s.request();
		s.request();
		expect(log.sent).toEqual([]);
		await tick();
		expect(log.sent).toEqual([1]);
		s.arrived(1, 1);
		expect(log.shown).toEqual([1]);
		expect(s.idle).toBe(true);
	});

	it('sends a request made now at once, unless one is on its way or a pump is queued', async () => {
		const { s, log } = scheduler();
		s.requestNow();
		expect(log.sent).toEqual([1]);
		// On its way: owed, and sent when it lands.
		s.requestNow();
		expect(log.sent).toEqual([1]);
		s.arrived(1, 1);
		expect(log.sent).toEqual([1, 2]);
		s.arrived(2, 2);
		// A pump queued in this task takes it: one painting, after the task.
		s.request();
		s.requestNow();
		expect(log.sent).toEqual([1, 2]);
		await tick();
		expect(log.sent).toEqual([1, 2, 3]);
		// Held: nothing goes until the release.
		s.arrived(3, 3);
		s.hold();
		s.requestNow();
		expect(log.sent).toEqual([1, 2, 3]);
		s.release();
		await tick();
		expect(log.sent).toEqual([1, 2, 3, 4]);
	});

	it('owes a request made while a painting is in flight, and sends it when that lands', async () => {
		const { s, log } = scheduler();
		s.request();
		await tick();
		s.request();
		s.request();
		await tick();
		expect(log.sent).toEqual([1]);
		s.arrived(1, 1);
		// The landed one shows (it is newer than the screen), the owed one goes.
		expect(log.shown).toEqual([1]);
		expect(log.sent).toEqual([1, 2]);
		expect(s.idle).toBe(false);
		s.arrived(2, 2);
		expect(log.shown).toEqual([1, 2]);
		expect(s.idle).toBe(true);
	});

	it('sends nothing while held, drops what lands meanwhile, and sends what is owed at release', async () => {
		const { s, log } = scheduler();
		s.request();
		await tick();
		s.hold();
		s.request();
		await tick();
		expect(log.sent).toEqual([1]);
		// Made for the view before the zoom: dropped, and owed again.
		s.arrived(1, 1);
		expect(log.shown).toEqual([]);
		expect(log.dropped).toEqual([1]);
		await tick();
		expect(log.sent).toEqual([1]);
		s.release();
		await tick();
		expect(log.sent).toEqual([1, 2]);
		s.arrived(2, 2);
		expect(log.shown).toEqual([2]);
		expect(s.idle).toBe(true);
	});

	it('drops a painting it is not waiting for', async () => {
		const { s, log } = scheduler();
		s.request();
		await tick();
		s.arrived(7, 70);
		expect(log.dropped).toEqual([70]);
		expect(s.pending).toBe(1);
	});

	it('owes a failed painting again without sending it, and forgets everything at reset', async () => {
		const { s, log } = scheduler();
		s.request();
		await tick();
		s.failed(1);
		await tick();
		expect(log.sent).toEqual([1]);
		expect(s.idle).toBe(false);
		let done = false;
		void s.whenIdle().then(() => {
			done = true;
		});
		s.reset();
		await tick();
		expect(done).toBe(true);
		expect(s.idle).toBe(true);
	});

	it('resolves whenIdle once what is shown is the view as it stands', async () => {
		const { s } = scheduler();
		await expect(s.whenIdle()).resolves.toBeUndefined();
		s.request();
		let done = false;
		void s.whenIdle().then(() => {
			done = true;
		});
		await tick();
		await tick();
		expect(done).toBe(false);
		s.arrived(1, 1);
		await tick();
		expect(done).toBe(true);
	});

	it('paints and shows at once when the painting lands inside its own send', async () => {
		const log: number[] = [];
		const s: PaintScheduler<number> = new PaintScheduler<number>({
			send: (seq) => s.arrived(seq, seq),
			present: (f) => log.push(f),
			discard: () => undefined,
		});
		s.request();
		await tick();
		expect(log).toEqual([1]);
		expect(s.idle).toBe(true);
	});

	it('keeps its invariants over a random walk', async () => {
		let seed = 42;
		const rnd = (): number => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed / 2 ** 32;
		};
		for (let run = 0; run < 40; run++) {
			const { s, log } = scheduler();
			let held = false;
			let lastRequestAt = -1;
			let shownAtHold = 0;
			const inFlightFromLog = (): number[] => log.sent.filter((q) => !log.shown.includes(q) && !log.dropped.includes(q) && !failed.has(q));
			const failed = new Set<number>();
			for (let step = 0; step < 60; step++) {
				const r = rnd();
				if (r < 0.35) {
					s.request();
					lastRequestAt = log.sent.length;
				} else if (r < 0.45) {
					if (!held) {
						shownAtHold = log.shown.length;
					}
					s.hold();
					held = true;
				} else if (r < 0.55) {
					s.release();
					held = false;
				} else if (r < 0.85) {
					const p = s.pending;
					if (p !== null) {
						s.arrived(p, p);
					}
				} else if (r < 0.9) {
					const p = s.pending;
					if (p !== null) {
						s.failed(p);
						failed.add(p);
						s.request();
						lastRequestAt = log.sent.length;
					}
				} else {
					await tick();
				}
				// One painting in flight at most.
				expect(inFlightFromLog().length).toBeLessThanOrEqual(1);
				// Nothing is shown while it holds: whatever lands then was made
				// for the view before the zoom.
				if (held) {
					expect(log.shown.length).toBe(shownAtHold);
				}
			}
			// Let it settle: release, run the pumps, land whatever flies.
			s.release();
			for (let k = 0; k < 20; k++) {
				await tick();
				const p = s.pending;
				if (p !== null) {
					s.arrived(p, p);
				}
			}
			expect(s.idle).toBe(true);
			// No request lost: something sent after the last request was shown.
			if (lastRequestAt >= 0) {
				const after = log.sent.slice(lastRequestAt);
				expect(after.some((q) => log.shown.includes(q))).toBe(true);
			}
			await expect(s.whenIdle()).resolves.toBeUndefined();
		}
	});
});
