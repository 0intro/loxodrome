/* The shared mode's on-demand trace fetch (state/sync.svelte.ts
 * fetchOutingOnDemand) runs outside the download's own run, so standing
 * sync down (haltSync: a sign-out, a reset) must stop it too. Left running,
 * it landed a wiped outing's points back into the store the wipe had just
 * emptied. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/storage';
import { ACCOUNT_KEY, SYNC_REGISTRY_KEY } from '$lib/sync/keys';

const net = vi.hoisted(() => ({
	getBlob: vi.fn(
		(_token: string, _hash: string, signal?: AbortSignal) =>
			new Promise<Uint8Array>((_resolve, reject) => {
				signal?.addEventListener('abort', () => reject(new Error('aborted')));
			}),
	),
	land: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('leaflet', () => ({ default: {} }));
vi.mock('$lib/sync/protocol', async (original) => ({
	...(await original<typeof import('$lib/sync/protocol')>()),
	getBlob: net.getBlob,
}));
vi.mock('$lib/sync/adapters', async (original) => ({
	...(await original<typeof import('$lib/sync/adapters')>()),
	landOutingBlobs: net.land,
}));

beforeEach(() => {
	vi.resetModules();
	net.getBlob.mockClear();
	net.land.mockClear();
	vi.stubGlobal(
		'localStorage',
		memoryStorage({
			[ACCOUNT_KEY]: JSON.stringify({
				v: 1,
				token: 't',
				email: 'pilot@example.org',
				userId: 'u',
				mode: 'shared',
				status: 'active',
				signedInAtMs: Date.now(),
			}),
			[SYNC_REGISTRY_KEY]: JSON.stringify({
				v: 1,
				deviceId: 'd',
				lastSeq: 1,
				docs: { 'outings/7': { rev: 1, hash: 'h', blobs: [{ h: 'b1', n: 10 }], meta: {} } },
				tombstones: [],
			}),
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the on-demand trace fetch', () => {
	it('is stopped and joined when sync stands down, landing nothing', { timeout: 30_000 }, async () => {
		const s = await import('$lib/state/sync.svelte');
		const fetch = s.fetchOutingOnDemand(7);
		await vi.waitFor(() => expect(net.getBlob).toHaveBeenCalledOnce());
		await s.haltSync();
		expect(await fetch).toBe(false);
		expect(net.land).not.toHaveBeenCalled();
	});

	it('does not start once sync is standing down', { timeout: 30_000 }, async () => {
		const s = await import('$lib/state/sync.svelte');
		await s.haltSync();
		expect(await s.fetchOutingOnDemand(7)).toBe(false);
		expect(net.getBlob).not.toHaveBeenCalled();
	});
});
