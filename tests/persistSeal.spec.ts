/* The storage seal (state/persist.ts sealStorage): once a page has erased
 * storage and is about to navigate away, nothing it still runs may write a
 * key back for the next boot to read. Every write in the app goes through
 * these wrappers, so sealing them is sealing the app. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage, type MemoryStorage } from './helpers/storage';

let ls: MemoryStorage;

beforeEach(() => {
	vi.resetModules();
	ls = memoryStorage({ 'loxodrome:kept': 'yes' });
	vi.stubGlobal('localStorage', ls);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the storage seal', () => {
	it('stops every write and removal, and leaves reads alone', async () => {
		const p = await import('$lib/state/persist');
		p.writeItem('loxodrome:a', '1');
		expect(p.writeJson('loxodrome:b', { v: 1 })).toBe(true);
		p.sealStorage();
		p.writeItem('loxodrome:a', '2');
		expect(p.writeJson('loxodrome:b', { v: 2 })).toBe(false);
		p.writeItem('loxodrome:c', 'new');
		p.removeItem('loxodrome:kept');
		expect(ls.dump()).toEqual({
			'loxodrome:kept': 'yes',
			'loxodrome:a': '1',
			'loxodrome:b': '{"v":1}',
		});
		expect(p.readItem('loxodrome:a')).toBe('1');
		expect(p.readJson('loxodrome:b')).toEqual({ v: 1 });
		expect(p.keysWithPrefix('loxodrome:').sort()).toEqual(['loxodrome:a', 'loxodrome:b', 'loxodrome:kept']);
	});
});
