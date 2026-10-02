/* A sign-in's adoption stamp is OWED from the instant the session exists
 * (state/account.svelte.ts commitSignIn, docs/accounts-sync.md "Sign-in"):
 * the debt is recorded before the account, so nothing that runs before the
 * stamp lands can act as if there were none. A pass started meanwhile (the
 * edit debounce three seconds after the account appears, the visibility
 * trigger, the pagehide flush) pushes nothing of the device's into the
 * account, and an end that comes first (a page that died before its stamp,
 * then the boot sweep) takes none of the device's documents for the
 * session's own. A creation that adopts everything owes nothing, and so does
 * the same account signing back into its own shared session. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { memoryStorage, type MemoryStorage } from './helpers/storage';
import { FOUND_KEY, SYNC_REGISTRY_KEY } from '$lib/sync/keys';
import type { OutingMeta } from '$lib/state/flightsDb';
import type { VerifiedSignIn } from '$lib/state/account.svelte';

const wire = vi.hoisted(() => ({ pushed: [] as string[] }));
const local = vi.hoisted(() => ({
	docs: [] as { col: string; id: string; payloadText: string; meta: Record<string, unknown> }[],
}));

// The sync module reaches Leaflet through the flight import (fitRoute ->
// map/focus), which needs a window to evaluate; nothing here draws.
vi.mock('leaflet', () => ({ default: {} }));

// The listing as the adapters give it: a pilot block set aside to a blank
// one is no document (sync/adapters.ts isDefaultPilot).
vi.mock('$lib/sync/adapters', async (original) => ({
	...(await original<typeof import('$lib/sync/adapters')>()),
	listLocalDocs: vi.fn(() =>
		Promise.resolve(
			local.docs.filter(
				(d) => d.col !== 'pilot' || !(localStorage.getItem('loxodrome:pilot') ?? '').includes('"name":""'),
			),
		),
	),
}));

vi.mock('$lib/sync/protocol', async (original) => {
	const real = await original<typeof import('$lib/sync/protocol')>();
	return {
		...real,
		fetchChanges: vi.fn(() => Promise.resolve({ seq: 0, more: false, docs: [] })),
		pushDocs: vi.fn((_token: string, docs: { col: string; id: string }[]) => {
			wire.pushed.push(...docs.map((d) => `${d.col}/${d.id}`));
			return Promise.resolve(docs.map((_, i) => ({ ok: true as const, rev: 1, seq: i + 1 })));
		}),
	};
});

const T0 = Date.UTC(2026, 9, 1, 9, 0);
const PILOT = JSON.stringify({ name: 'CLUB PC', sepValidUntil: '2027-05-31', medicalValidUntil: null });
const PLANES = JSON.stringify({ v: 1, planes: { 'F-CLUB': 'club' } });
const FOUND = ['aircraft/F-CLUB', 'pilot/pilot', 'plans/p1', 'outings/8'];

let ls: MemoryStorage;

function verified(over: Partial<VerifiedSignIn> = {}): VerifiedSignIn {
	return {
		token: 'T',
		userId: 'uA',
		status: 'active',
		created: false,
		email: 'a@example.com',
		mode: 'shared',
		breadcrumb: 'crumb-a',
		differentAccount: false,
		endsShared: false,
		...over,
	};
}

beforeEach(async () => {
	vi.resetModules();
	globalThis.indexedDB = new IDBFactory();
	ls = memoryStorage({ 'loxodrome:pilot': PILOT, 'loxodrome:aircraft-user': PLANES });
	vi.stubGlobal('localStorage', ls);
	vi.stubGlobal('sessionStorage', memoryStorage());
	wire.pushed = [];
	local.docs = FOUND.map((key) => {
		const [col, id] = key.split('/');
		return { col, id, payloadText: key, meta: {} };
	});
	const db = await import('$lib/state/flightsDb');
	await db.putStoredPlan({ id: 'p1', yaml: 'version: 1\n', savedAtMs: T0 });
	await db.putOuting(
		{ id: 8, savedAtMs: T0, datum: 'msl', aircraftKey: null, remarks: '', source: 'trace', derivedV: 0, flights: [] } as unknown as OutingMeta,
		[{ lat: 48, lon: 2, altFt: null, timeMs: 8 }],
		null,
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const registry = (): Record<string, unknown> =>
	JSON.parse(ls.getItem(SYNC_REGISTRY_KEY) ?? '{}') as Record<string, unknown>;

describe("a sign-in's owed stamp", () => {
	it('is recorded before the account, so a pass before the stamp pushes nothing of the device\'s', { timeout: 30_000 }, async () => {
		const acc = await import('$lib/state/account.svelte');
		await acc.commitSignIn(verified());
		expect(registry().stampPending).toBe(true);
		// The edit debounce fires before the stamp has listed the stores.
		const s = await import('$lib/state/sync.svelte');
		await s.syncNow();
		expect(wire.pushed).toEqual([]);
		// The stamp lands, and the pass it runs holds everything found back.
		await s.afterSignIn(false, false);
		expect(registry().stampPending).toBeUndefined();
		expect(wire.pushed).toEqual([]);
	});

	it('holds a personal sign-in\'s leftovers back as well, for the merge confirm to ask', { timeout: 30_000 }, async () => {
		const acc = await import('$lib/state/account.svelte');
		await acc.commitSignIn(verified({ mode: 'personal' }));
		expect(registry().stampPending).toBe(true);
		const s = await import('$lib/state/sync.svelte');
		await s.syncNow();
		expect(wire.pushed).toEqual([]);
	});

	it('leaves the device\'s documents to an end that comes before the stamp', { timeout: 30_000 }, async () => {
		const acc = await import('$lib/state/account.svelte');
		await acc.commitSignIn(verified());
		// The page dies here; the next boot sweeps the session it left.
		const { readSessionEnd, wipeSessionIdb, wipeSharedSession } = await import('$lib/sync/wipe');
		const end = readSessionEnd();
		await wipeSessionIdb(end, Date.now() + 60_000);
		wipeSharedSession(end);
		const db = await import('$lib/state/flightsDb');
		expect((await db.getStoredPlans()).map((p) => p.id)).toEqual(['p1']);
		expect((await db.getMetas()).map((m) => m.id)).toEqual([8]);
		expect(ls.getItem('loxodrome:pilot')).toBe(PILOT);
		expect(ls.getItem('loxodrome:aircraft-user')).toBe(PLANES);
	});

	it('is not owed by a creation that adopts everything', { timeout: 30_000 }, async () => {
		const acc = await import('$lib/state/account.svelte');
		await acc.commitSignIn(verified({ mode: 'personal', created: true }));
		expect(registry().stampPending).toBeUndefined();
	});

	it('is not owed again when the same account signs back into its own shared session', { timeout: 30_000 }, async () => {
		const acc = await import('$lib/state/account.svelte');
		await acc.commitSignIn(verified());
		const s = await import('$lib/state/sync.svelte');
		await s.afterSignIn(false, false);
		const held = registry().preexisting;
		const copy = ls.getItem(FOUND_KEY);
		expect(copy).not.toBeNull();
		// The session's own plan, then the token lapses and the pilot signs in
		// again: the stamp stands as the session's first sign-in took it.
		local.docs.push({ col: 'plans', id: 'p-mine', payloadText: 'mine', meta: {} });
		vi.resetModules();
		const again = await import('$lib/state/account.svelte');
		await again.commitSignIn(verified());
		expect(registry().stampPending).toBeUndefined();
		const s2 = await import('$lib/state/sync.svelte');
		await s2.afterSignIn(false, false);
		expect(registry().preexisting).toEqual(held);
		expect(ls.getItem(FOUND_KEY)).toBe(copy);
	});

	it('takes no copy when the same account signs back into a session whose stamp landed without one', { timeout: 30_000 }, async () => {
		// Storage refused the first sign-in's copy: its stamp landed bare.
		const acc = await import('$lib/state/account.svelte');
		await acc.commitSignIn(verified());
		ls.setItem(
			SYNC_REGISTRY_KEY,
			JSON.stringify({ v: 1, deviceId: 'd', lastSeq: 0, docs: {}, tombstones: [], preexisting: FOUND }),
		);
		// The session's own plan, then the token lapses and the pilot signs in again.
		local.docs.push({ col: 'plans', id: 'p-mine', payloadText: 'mine', meta: {} });
		vi.resetModules();
		const again = await import('$lib/state/account.svelte');
		await again.commitSignIn(verified());
		const s = await import('$lib/state/sync.svelte');
		await s.afterSignIn(false, false);
		expect(ls.getItem(FOUND_KEY)).toBeNull();
		expect(registry().preexisting).toEqual(FOUND);
	});

	it('signs no one in when the debt cannot be recorded', { timeout: 30_000 }, async () => {
		const set = ls.setItem.bind(ls);
		ls.setItem = (k: string, v: string) => {
			if (k === SYNC_REGISTRY_KEY) {
				throw new Error('quota');
			}
			set(k, v);
		};
		const acc = await import('$lib/state/account.svelte');
		await expect(acc.commitSignIn(verified())).rejects.toThrow();
		expect(ls.getItem('loxodrome:account')).toBeNull();
	});

	it('takes a fresh copy over one an earlier session of the same account left behind', { timeout: 30_000 }, async () => {
		// An end that could not remove its copy; the session itself is over.
		ls.setItem(
			FOUND_KEY,
			JSON.stringify({ v: 1, userId: 'uA', keys: ['plans/gone'], pilot: null, fuel: null, parked: false, planes: {}, trace: null, listed: true, rows: true }),
		);
		const acc = await import('$lib/state/account.svelte');
		await acc.commitSignIn(verified());
		const s = await import('$lib/state/sync.svelte');
		await s.afterSignIn(false, false);
		const copy = JSON.parse(ls.getItem(FOUND_KEY) ?? 'null') as { keys: string[] };
		expect([...copy.keys].sort()).toEqual([...FOUND].sort());
	});
});
