/* Pins the shared-mode boot sweep (docs/accounts-sync.md, Device
 * modes): the ended-session signature (flag without marker) defers the
 * mount behind a presence query; a live holder means JOIN and never
 * wipe; no holder means the localStorage half is swept before paint;
 * and both non-sweep paths raise the presence BRIDGE so the joined
 * session cannot go holderless between this decision and the account
 * module's own hold. Module state forces the resetModules idiom. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_KEY, PRESENCE_LOCK, SHARED_FLAG_KEY, SHARED_MARKER_KEY } from '$lib/sync/keys';

function workingStorage(): Storage {
	const store = new Map<string, string>();
	return {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	} as unknown as Storage;
}

interface LockRow {
	name: string;
	released: boolean;
}

function fakeLocks(heldNames: string[]): { nav: unknown; requests: LockRow[] } {
	const requests: LockRow[] = [];
	const locks = {
		query: () => Promise.resolve({ held: heldNames.map((name) => ({ name })) }),
		request: (name: string, _opts: unknown, cb: () => Promise<void>) => {
			const row: LockRow = { name, released: false };
			requests.push(row);
			const p = cb();
			void p.then(() => {
				row.released = true;
			});
			return p;
		},
	};
	return { nav: { locks }, requests };
}

async function freshSweep(): Promise<typeof import('$lib/sync/bootSweep')> {
	vi.resetModules();
	return import('$lib/sync/bootSweep');
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('bootSweepGate', () => {
	it('boots normally with no shared signature', async () => {
		vi.stubGlobal('localStorage', workingStorage());
		vi.stubGlobal('sessionStorage', workingStorage());
		vi.stubGlobal('navigator', fakeLocks([]).nav);
		const { bootSweepGate } = await freshSweep();
		expect(bootSweepGate()).toBeNull();
	});

	it('treats a marker-present boot as a reload and bridges presence', async () => {
		vi.stubGlobal('localStorage', workingStorage());
		vi.stubGlobal('sessionStorage', workingStorage());
		const fake = fakeLocks([]);
		vi.stubGlobal('navigator', fake.nav);
		localStorage.setItem(SHARED_FLAG_KEY, '1');
		localStorage.setItem(ACCOUNT_KEY, '{"v":1}');
		sessionStorage.setItem(SHARED_MARKER_KEY, '1');
		const { bootSweepGate, releaseBootPresence } = await freshSweep();
		expect(bootSweepGate()).toBeNull();
		// The reload dropped this tab's own hold: the bridge takes over
		// until the account module re-holds, then hands off.
		expect(fake.requests).toHaveLength(1);
		expect(fake.requests[0].name).toBe(PRESENCE_LOCK);
		expect(localStorage.getItem(ACCOUNT_KEY)).not.toBeNull();
		releaseBootPresence();
		await Promise.resolve();
		expect(fake.requests[0].released).toBe(true);
	});

	it('joins a live session: marker written, nothing wiped, bridge up', async () => {
		vi.stubGlobal('localStorage', workingStorage());
		vi.stubGlobal('sessionStorage', workingStorage());
		const fake = fakeLocks([PRESENCE_LOCK]);
		vi.stubGlobal('navigator', fake.nav);
		localStorage.setItem(SHARED_FLAG_KEY, '1');
		localStorage.setItem(ACCOUNT_KEY, '{"v":1}');
		localStorage.setItem('loxodrome:routes', '{}');
		const { bootSweepGate } = await freshSweep();
		const gate = bootSweepGate();
		expect(gate).not.toBeNull();
		await gate;
		expect(sessionStorage.getItem(SHARED_MARKER_KEY)).toBe('1');
		expect(localStorage.getItem(ACCOUNT_KEY)).not.toBeNull();
		expect(localStorage.getItem('loxodrome:routes')).not.toBeNull();
		expect(fake.requests.some((r) => r.name === PRESENCE_LOCK)).toBe(true);
	});

	it('sweeps a holderless ended session before mount', async () => {
		vi.stubGlobal('localStorage', workingStorage());
		vi.stubGlobal('sessionStorage', workingStorage());
		vi.stubGlobal('navigator', fakeLocks([]).nav);
		localStorage.setItem(SHARED_FLAG_KEY, '1');
		localStorage.setItem(ACCOUNT_KEY, '{"v":1}');
		localStorage.setItem('loxodrome:routes', '{}');
		localStorage.setItem('loxodrome:nav-trace', '{}');
		const { bootSweepGate } = await freshSweep();
		const gate = bootSweepGate();
		expect(gate).not.toBeNull();
		await gate;
		expect(localStorage.getItem(ACCOUNT_KEY)).toBeNull();
		expect(localStorage.getItem('loxodrome:routes')).toBeNull();
		expect(localStorage.getItem('loxodrome:nav-trace')).toBeNull();
		expect(localStorage.getItem(SHARED_FLAG_KEY)).toBeNull();
	});

	it('sweeps when no locks API exists (single-tab assumption)', async () => {
		vi.stubGlobal('localStorage', workingStorage());
		vi.stubGlobal('sessionStorage', workingStorage());
		vi.stubGlobal('navigator', {});
		localStorage.setItem(SHARED_FLAG_KEY, '1');
		localStorage.setItem(ACCOUNT_KEY, '{"v":1}');
		const { bootSweepGate } = await freshSweep();
		await bootSweepGate();
		expect(localStorage.getItem(ACCOUNT_KEY)).toBeNull();
	});
});
