/* The one screen wake lock (ui/wakeLock.ts), refcounted by holder tag: the
 * offline queue's drain and the recording both hold it. A sentinel stays
 * live until it is released or the page hides, so one the module loses
 * track of keeps the screen on after the last holder lets go. A fake
 * navigator.wakeLock counts the live sentinels; fresh module state per
 * case. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeSentinel {
	released: boolean;
	release(): Promise<void>;
}

let live: Set<FakeSentinel>;
/** Requests not answered yet, answered by settle(). */
let waiting: (() => void)[];

function request(): Promise<FakeSentinel> {
	return new Promise((resolve) => {
		waiting.push(() => {
			const s: FakeSentinel = {
				released: false,
				release() {
					this.released = true;
					live.delete(this);
					return Promise.resolve();
				},
			};
			live.add(s);
			resolve(s);
		});
	});
}

/** Answer every request in flight, then let the module's awaits run. */
async function settle(): Promise<void> {
	for (const answer of waiting.splice(0)) {
		answer();
	}
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

beforeEach(() => {
	live = new Set();
	waiting = [];
	vi.stubGlobal('navigator', { wakeLock: { request } });
	vi.stubGlobal('document', { addEventListener: () => {}, visibilityState: 'visible' });
	vi.resetModules();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the screen wake lock', () => {
	it('holds one sentinel for two holders', async () => {
		const w = await import('$lib/ui/wakeLock');
		w.acquireWakeLock('offline');
		await settle();
		w.acquireWakeLock('recording');
		await settle();
		expect(live.size).toBe(1);
	});

	it('holds one sentinel for two holders asked at once', async () => {
		const w = await import('$lib/ui/wakeLock');
		w.acquireWakeLock('offline');
		w.acquireWakeLock('recording');
		await settle();
		expect(live.size).toBe(1);
	});

	it('lets the screen go once the last holder does, in either order', async () => {
		for (const order of [
			['offline', 'recording'],
			['recording', 'offline'],
		]) {
			vi.resetModules();
			const w = await import('$lib/ui/wakeLock');
			w.acquireWakeLock('offline');
			await settle();
			w.acquireWakeLock('recording');
			await settle();
			w.releaseWakeLock(order[0]);
			expect(live.size).toBe(1);
			w.releaseWakeLock(order[1]);
			await settle();
			expect(live.size).toBe(0);
		}
	});

	it('lets go of a sentinel granted after its holder left', async () => {
		const w = await import('$lib/ui/wakeLock');
		w.acquireWakeLock('offline');
		w.releaseWakeLock('offline');
		await settle();
		expect(live.size).toBe(0);
	});
});
