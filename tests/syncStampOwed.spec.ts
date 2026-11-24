/* The owed pre-existing stamp (state/syncRegistry.ts stampPending,
 * state/sync.svelte.ts): a sign-in holds every local doc back from the new
 * account until the pilot says otherwise (the provenance rule,
 * docs/accounts-sync.md). When that stamp cannot be taken at once, the debt
 * is PERSISTED in the registry, so a reload cannot forget it and let the
 * device's leftovers push themselves into the account: the next pass stamps
 * before anything else, and the sign-out valve does not count those
 * leftovers as this account's unsent work. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/storage';
import { SYNC_REGISTRY_KEY } from '$lib/sync/keys';

const local = vi.hoisted(() => ({
	docs: [] as { col: string; id: string; payloadText: string }[],
	fail: false,
}));

// The sync module reaches Leaflet through the flight import (fitRoute ->
// map/focus), which needs a window to evaluate; nothing here draws.
vi.mock('leaflet', () => ({ default: {} }));

vi.mock('$lib/sync/adapters', async (original) => ({
	...(await original<typeof import('$lib/sync/adapters')>()),
	listLocalDocs: vi.fn(() =>
		local.fail ? Promise.reject(new Error('blocked store')) : Promise.resolve(local.docs),
	),
}));

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('localStorage', memoryStorage());
	local.docs = [
		{ col: 'aircraft', id: 'F-TEST', payloadText: 'a' },
		{ col: 'plans', id: 'p1', payloadText: 'p' },
	];
	local.fail = false;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const registry = (): Record<string, unknown> =>
	JSON.parse(localStorage.getItem(SYNC_REGISTRY_KEY) ?? '{}') as Record<string, unknown>;

describe('the owed stamp', () => {
	it('survives an unrelated registry write', async () => {
		const r = await import('$lib/state/syncRegistry');
		await r.mutateSyncRegistry((reg) => {
			reg.stampPending = true;
		});
		await r.ensureDeviceId();
		expect(r.readSyncRegistry().stampPending).toBe(true);
		expect(registry().stampPending).toBe(true);
	});

	it('is persisted when a sign-in cannot stamp, and not counted as unsent work', { timeout: 30_000 }, async () => {
		const s = await import('$lib/state/sync.svelte');
		expect(await s.countPendingDocs()).toBe(2);
		local.fail = true;
		await s.afterSignIn(false, false);
		expect(registry().stampPending).toBe(true);
		local.fail = false;
		// A reload: the in-document flag is gone, the registry keeps the debt.
		vi.resetModules();
		const again = await import('$lib/state/sync.svelte');
		expect(await again.countPendingDocs()).toBe(0);
	});

	it('is settled by the stamp, which holds every local doc back', { timeout: 30_000 }, async () => {
		const r = await import('$lib/state/syncRegistry');
		await r.mutateSyncRegistry((reg) => {
			reg.stampPending = true;
		});
		const s = await import('$lib/state/sync.svelte');
		await s.afterSignIn(false, false);
		expect(registry().stampPending).toBeUndefined();
		expect(registry().preexisting).toEqual(['aircraft/F-TEST', 'plans/p1']);
		expect(await s.countPendingDocs()).toBe(0);
	});
});
