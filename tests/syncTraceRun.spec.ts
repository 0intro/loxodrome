/* The trace download's run (state/sync.svelte.ts, docs/accounts-sync.md
 * "the trickle"), driven through syncNow over a mocked wire. A run a
 * recording stops leaves its queue standing, and the next pass resumes it
 * even when it pulls nothing. The prune before the pool reads the registry
 * once, whatever the queue holds: the once-per-session scan queues every
 * tracked outing, and a read per want parsed the whole registry each time. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { memoryStorage } from './helpers/storage';
import { ACCOUNT_KEY, SYNC_REGISTRY_KEY } from '$lib/sync/keys';

const net = vi.hoisted(() => {
	const held: (() => void)[] = [];
	return {
		held,
		getBlob: vi.fn(
			(_token: string, _hash: string) =>
				new Promise<Uint8Array>((resolve) => {
					held.push(() => resolve(new Uint8Array()));
				}),
		),
		land: vi.fn(() => Promise.resolve(true)),
		changes: vi.fn(() => Promise.resolve({ seq: 1, more: false, docs: [] })),
	};
});

vi.mock('leaflet', () => ({ default: {} }));
vi.mock('$lib/sync/protocol', async (original) => ({
	...(await original<typeof import('$lib/sync/protocol')>()),
	getBlob: net.getBlob,
	fetchChanges: net.changes,
	pushDocs: vi.fn(() => Promise.resolve([])),
	putBlob: vi.fn(() => Promise.resolve()),
}));
vi.mock('$lib/sync/adapters', async (original) => ({
	...(await original<typeof import('$lib/sync/adapters')>()),
	landOutingBlobs: net.land,
}));

/** A registry tracking `n` traced outings, ids 1..n, none of whose points
 *  this device holds. */
function registry(n: number): string {
	const docs: Record<string, unknown> = {};
	for (let id = 1; id <= n; id++) {
		docs[`outings/${id}`] = { rev: 1, hash: 'h', blobs: [{ h: `b${id}`, n: 10 }], meta: { pts: `b${id}` } };
	}
	return JSON.stringify({ v: 1, deviceId: 'd', lastSeq: 1, docs, tombstones: [] });
}

function signIn(n: number): void {
	vi.stubGlobal(
		'localStorage',
		memoryStorage({
			[ACCOUNT_KEY]: JSON.stringify({
				v: 1,
				token: 't',
				email: 'pilot@example.org',
				userId: 'u',
				mode: 'personal',
				status: 'active',
				signedInAtMs: Date.now(),
			}),
			[SYNC_REGISTRY_KEY]: registry(n),
		}),
	);
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
	vi.resetModules();
	net.held.length = 0;
	net.getBlob.mockClear();
	net.land.mockClear();
	net.changes.mockClear();
	vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the trace download run', () => {
	it('resumes at the next pass after a recording stopped it', { timeout: 30_000 }, async () => {
		signIn(4);
		const s = await import('$lib/state/sync.svelte');
		const { nav } = await import('$lib/state/navRecording.svelte');
		await s.syncNow();
		// Three workers hold the three newest; the oldest waits in the queue.
		await vi.waitFor(() => expect(net.getBlob).toHaveBeenCalledTimes(3));
		nav.recording = true;
		for (const release of net.held.splice(0)) {
			release();
		}
		await settle();
		expect(net.getBlob).toHaveBeenCalledTimes(3);
		nav.recording = false;
		await s.syncNow();
		await vi.waitFor(() => expect(net.getBlob).toHaveBeenCalledTimes(4));
		expect(net.getBlob.mock.calls[3]?.[1]).toBe('b1');
	});

	it('reads the registry once to prune the queue', { timeout: 30_000 }, async () => {
		const n = 60;
		signIn(n);
		const reads = vi.spyOn(localStorage, 'getItem');
		const s = await import('$lib/state/sync.svelte');
		await s.syncNow();
		await vi.waitFor(() => expect(net.getBlob).toHaveBeenCalledTimes(3));
		const registryReads = reads.mock.calls.filter(([k]) => k === SYNC_REGISTRY_KEY).length;
		expect(registryReads).toBeLessThan(n / 4);
	});
});
