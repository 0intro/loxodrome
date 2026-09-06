/* Pins the sync registry (docs/accounts-sync.md): tombstones are
 * RECORDED, never inferred (and only for account-tracked docs, so the
 * chokepoint wiring is a no-op ahead of any sign-in), every mutation
 * serializes under the writer lock (or its single-tab fallback queue),
 * and a malformed stored doc reads as fresh rather than as guesses. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	docKey,
	ensureDeviceId,
	mutateSyncRegistry,
	readSyncRegistry,
	recordSyncTombstone,
	withSyncWriter,
} from '$lib/state/syncRegistry';
import { SYNC_REGISTRY_KEY, WRITER_LOCK } from '$lib/sync/keys';

function workingStorage(): Storage {
	const store = new Map<string, string>();
	return {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	} as unknown as Storage;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('reading', () => {
	it('reads fresh on absent or malformed storage', () => {
		vi.stubGlobal('localStorage', workingStorage());
		expect(readSyncRegistry()).toEqual({
			v: 1,
			deviceId: '',
			lastSeq: 0,
			docs: {},
			tombstones: [],
		});
		localStorage.setItem(SYNC_REGISTRY_KEY, '{"v":2}');
		expect(readSyncRegistry().docs).toEqual({});
	});

	it('drops a tombstone whose collection is not one of ours', () => {
		vi.stubGlobal('localStorage', workingStorage());
		localStorage.setItem(
			SYNC_REGISTRY_KEY,
			JSON.stringify({
				v: 1,
				deviceId: 'd',
				lastSeq: 3,
				docs: { 'plans/p1': { rev: 2, hash: 'h' } },
				tombstones: [
					{ col: 'plans', id: 'p2', updatedAt: 9 },
					{ col: 'garbage', id: 'x', updatedAt: 9 },
				],
			}),
		);
		const reg = readSyncRegistry();
		expect(reg.lastSeq).toBe(3);
		expect(reg.docs['plans/p1']).toEqual({ rev: 2, hash: 'h' });
		expect(reg.tombstones).toEqual([{ col: 'plans', id: 'p2', updatedAt: 9, rev: 0 }]);
	});
});

describe('the device id', () => {
	it('mints once, lazily, and stays stable', async () => {
		vi.stubGlobal('localStorage', workingStorage());
		expect(readSyncRegistry().deviceId).toBe('');
		const id = await ensureDeviceId();
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
		expect(await ensureDeviceId()).toBe(id);
	});
});

describe('tombstones', () => {
	it('records nothing for a doc the account never tracked', async () => {
		vi.stubGlobal('localStorage', workingStorage());
		await recordSyncTombstone('outings', '123');
		expect(readSyncRegistry().tombstones).toEqual([]);
	});

	it('moves a tracked doc entry into a tombstone, once', async () => {
		vi.stubGlobal('localStorage', workingStorage());
		await mutateSyncRegistry((reg) => {
			reg.docs[docKey('outings', '123')] = { rev: 4, hash: 'h' };
		});
		await recordSyncTombstone('outings', '123');
		await recordSyncTombstone('outings', '123');
		const reg = readSyncRegistry();
		expect(reg.docs).toEqual({});
		expect(reg.tombstones).toHaveLength(1);
		expect(reg.tombstones[0]).toMatchObject({ col: 'outings', id: '123' });
	});
});

describe('the writer lock', () => {
	it('serializes concurrent mutations through the fallback queue', async () => {
		vi.stubGlobal('localStorage', workingStorage());
		// No navigator.locks in node: the in-module queue is the path here.
		await Promise.all([
			mutateSyncRegistry((reg) => {
				reg.docs['plans/a'] = { rev: 1, hash: 'a' };
			}),
			mutateSyncRegistry((reg) => {
				reg.docs['plans/b'] = { rev: 1, hash: 'b' };
			}),
		]);
		const reg = readSyncRegistry();
		expect(Object.keys(reg.docs).sort()).toEqual(['plans/a', 'plans/b']);
	});

	it('rides navigator.locks when the API exists', async () => {
		vi.stubGlobal('localStorage', workingStorage());
		const names: string[] = [];
		let chain: Promise<unknown> = Promise.resolve();
		vi.stubGlobal('navigator', {
			locks: {
				request: (name: string, _opts: unknown, cb: () => unknown) => {
					names.push(name);
					const run = chain.then(cb, cb);
					chain = run.catch(() => undefined);
					return run;
				},
			},
		});
		const out = await withSyncWriter(() => 42);
		expect(out).toBe(42);
		expect(names).toEqual([WRITER_LOCK]);
	});
});
