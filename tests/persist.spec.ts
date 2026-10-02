/* The persist helpers ($lib/state/persist) must be best-effort: a missing,
 * throwing, or full localStorage never propagates to the caller; reads
 * degrade to null. Vitest runs in a node environment, so localStorage is
 * stubbed per case via vi.stubGlobal. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readItem, readJson, removeItem, writeItem, writeJson } from '$lib/state/persist';

function workingStorage(): Storage {
	const store = new Map<string, string>();
	return {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	} as unknown as Storage;
}

function throwingStorage(): Storage {
	const deny = (): never => {
		throw new Error('storage denied');
	};
	return { getItem: deny, setItem: deny, removeItem: deny } as unknown as Storage;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('persist with working storage', () => {
	it('round-trips strings and removes them', () => {
		vi.stubGlobal('localStorage', workingStorage());
		expect(readItem('k')).toBeNull();
		writeItem('k', 'v');
		expect(readItem('k')).toBe('v');
		removeItem('k');
		expect(readItem('k')).toBeNull();
	});

	it('round-trips JSON and returns null on malformed JSON', () => {
		vi.stubGlobal('localStorage', workingStorage());
		writeJson('j', { v: 1, items: [1, 2] });
		expect(readJson('j')).toEqual({ v: 1, items: [1, 2] });
		writeItem('j', '{not json');
		expect(readJson('j')).toBeNull();
	});

	it('swallows an unserialisable value instead of throwing', () => {
		vi.stubGlobal('localStorage', workingStorage());
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(() => writeJson('c', cyclic)).not.toThrow();
		expect(readItem('c')).toBeNull();
	});
});

describe('persist with throwing storage (private mode, quota)', () => {
	it('reads degrade to null', () => {
		vi.stubGlobal('localStorage', throwingStorage());
		expect(readItem('k')).toBeNull();
		expect(readJson('k')).toBeNull();
	});

	it('writes and removals are swallowed', () => {
		vi.stubGlobal('localStorage', throwingStorage());
		expect(() => writeItem('k', 'v')).not.toThrow();
		expect(() => writeJson('k', { v: 1 })).not.toThrow();
		expect(() => removeItem('k')).not.toThrow();
	});
});
