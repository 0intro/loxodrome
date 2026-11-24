/* The tile store's database across versions (offline/passiveStore.ts), over
 * fake-indexeddb. Its connection set no onversionchange and its open no
 * onblocked, and a failed open was kept for the session: a later build's
 * upgrade waited for every tab of this one to close, and a tab of this build
 * opened beside an older one waited for good. pinnedGet is awaited before any
 * terrain fetch, so the shading, the MSA, the AGL and the alerts waited with
 * it. A tab steps aside now, and a blocked open answers nothing rather than
 * hang, the reads going to the network. */

import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DB = 'loxodrome-tiles';

beforeEach(() => {
	vi.resetModules();
	globalThis.indexedDB = new IDBFactory();
});

/** How a promise ends within a few event-loop turns: its value, or 'pending'. */
async function within<T>(p: Promise<T>, ms = 200): Promise<T | 'pending'> {
	return Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))]);
}

/** Open the database at a version, as another tab's build would. */
function openAt(version: number): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB, version);
		req.onupgradeneeded = () => {
			for (const name of ['tiles', 'pinned']) {
				if (!req.result.objectStoreNames.contains(name)) {
					req.result.createObjectStore(name, { keyPath: 'url' });
				}
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('open failed'));
	});
}

describe('the tile database', () => {
	it('lets a later build upgrade it while this one holds it open', async () => {
		const store = await import('$lib/offline/passiveStore');
		expect(await store.pinnedGet('https://charts.example/terrain/12/1/1')).toBeNull();
		const upgraded = await within(openAt(4));
		expect(upgraded).not.toBe('pending');
		(upgraded as IDBDatabase).close();
		// This build's reads answer, from the network, rather than wait.
		expect(await within(store.pinnedGet('https://charts.example/terrain/12/1/1'))).toBeNull();
	});

	it('answers nothing, never waits, while an older tab blocks its open', async () => {
		const old = await openAt(2);
		const store = await import('$lib/offline/passiveStore');
		expect(await within(store.pinnedGet('https://charts.example/terrain/12/1/1'))).toBeNull();
		// Once the older tab goes, the next read opens the store.
		old.close();
		const tile = new Blob([new Uint8Array(4)]);
		await store.pinnedPut('https://charts.example/terrain/12/1/1', tile);
		expect(await within(store.pinnedGet('https://charts.example/terrain/12/1/1'))).not.toBeNull();
	});
});
