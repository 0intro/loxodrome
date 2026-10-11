/* Pins the back-entry accounting (ui/backClose.ts): the entries above the
 * app's base stay equal to the open-surface stack through the same-tick
 * swaps (a menu closing while a page opens; a surface evicting another),
 * which used to drift the history position one entry per swap until a
 * release navigated the page away. A tiny history stub stands in for the
 * browser: pushes are synchronous, back() lands asynchronously with a
 * popstate, as in the real one. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = () => void;
/* One stub for the whole file: the module hooks popstate once, on the first
 * registration, so the window must be the same object throughout; only the
 * counters reset per test. */
const stub = {
	entries: 1, // the app's own entry
	position: 1,
	listeners: [] as Listener[],
	pops: 0,
};
vi.stubGlobal('window', {
	addEventListener: (_type: string, fn: Listener) => {
		stub.listeners.push(fn);
	},
});
vi.stubGlobal('history', {
	state: null,
	pushState: () => {
		stub.entries = stub.position + 1;
		stub.position += 1;
	},
	replaceState: () => {},
	back: () => {
		queueMicrotask(() => {
			stub.position -= 1;
			stub.pops += 1;
			for (const fn of stub.listeners) {
				fn();
			}
		});
	},
});
vi.stubGlobal('location', { href: 'http://app/' });

beforeEach(() => {
	stub.entries = 1;
	stub.position = 1;
	stub.pops = 0;
});

const settle = async (): Promise<void> => {
	for (let i = 0; i < 4; i += 1) {
		await new Promise((r) => queueMicrotask(() => r(null)));
	}
};

describe('registerBackClose', () => {
	it('balances a plain open and close', async () => {
		const { registerBackClose } = await import('$lib/ui/backClose');
		const release = registerBackClose(() => {});
		expect(stub.position).toBe(2);
		await settle();
		release();
		await settle();
		expect(stub.position).toBe(1);
	});

	it('reuses the entry when a registration follows a release in the same tick', async () => {
		const { registerBackClose } = await import('$lib/ui/backClose');
		const releaseMenu = registerBackClose(() => {});
		expect(stub.position).toBe(2);
		await settle();
		// The menu row: close the menu, open the page, one tick.
		releaseMenu();
		const releasePage = registerBackClose(() => {});
		await settle();
		expect(stub.position).toBe(2);
		expect(stub.pops).toBe(0);
		releasePage();
		await settle();
		expect(stub.position).toBe(1);
	});

	it('keeps one entry per open surface when a release follows a push in the same tick', async () => {
		const { registerBackClose } = await import('$lib/ui/backClose');
		const releaseA = registerBackClose(() => {});
		await settle();
		// Open B, then close A, one tick: the back() pops the fresh entry and
		// the older one serves B.
		const releaseB = registerBackClose(() => {});
		releaseA();
		await settle();
		expect(stub.position).toBe(2);
		releaseB();
		await settle();
		expect(stub.position).toBe(1);
	});

	it('closes the top surface on a user Back and keeps the count', async () => {
		const { registerBackClose } = await import('$lib/ui/backClose');
		let closed = 0;
		const release = registerBackClose(() => {
			closed += 1;
			release();
		});
		await settle();
		// The user's Back: the browser pops first, then we replace and close.
		stub.position -= 1;
		for (const fn of stub.listeners) {
			fn();
		}
		await settle();
		expect(closed).toBe(1);
		expect(stub.position).toBe(1);
	});
});
