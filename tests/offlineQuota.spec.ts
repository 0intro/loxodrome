// The offline headroom rule (src/lib/offline/quota.ts): the 95 % arithmetic
// and, above all, the three fail-open branches. This is the one computation
// in the feature that can REFUSE a pilot's download, and it had no test
// while it lived duplicated in two state modules.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { freeBytes, quotaAllows, storageSpace } from '../src/lib/offline/quota';

function withEstimate(estimate: () => Promise<StorageEstimate>): void {
	vi.stubGlobal('navigator', { storage: { estimate } });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('quotaAllows', () => {
	it('allows a pack that fits under the 95 % headroom', () => {
		withEstimate(() => Promise.resolve({ usage: 0, quota: 1000 }));
		// 950 is exactly the headroom.
		return expect(quotaAllows(950)).resolves.toBe(true);
	});

	it('refuses a pack past the headroom, even though the raw space exists', () => {
		withEstimate(() => Promise.resolve({ usage: 0, quota: 1000 }));
		return expect(quotaAllows(960)).resolves.toBe(false);
	});

	it('counts the bytes already held, so a resume asks only for the rest', () => {
		withEstimate(() => Promise.resolve({ usage: 900, quota: 1000 }));
		// 95 free under the headroom: the whole 1000 does not fit, the last
		// 90 of a part already 910 long does.
		return Promise.all([
			expect(quotaAllows(1000, 0)).resolves.toBe(false),
			expect(quotaAllows(1000, 910)).resolves.toBe(true),
		]);
	});

	it('fails open when the need is unknown', () => {
		withEstimate(() => Promise.resolve({ usage: 999, quota: 1000 }));
		return Promise.all([
			expect(quotaAllows(null)).resolves.toBe(true),
			expect(quotaAllows(undefined)).resolves.toBe(true),
			expect(quotaAllows(0)).resolves.toBe(true),
		]);
	});

	it('fails open when the manager will not state a quota or a usage', () => {
		withEstimate(() => Promise.resolve({ usage: 5 }));
		return expect(quotaAllows(1e12)).resolves.toBe(true);
	});

	it('fails open when the manager throws', () => {
		withEstimate(() => Promise.reject(new Error('denied')));
		return expect(quotaAllows(1e12)).resolves.toBe(true);
	});
});

describe('storageSpace and freeBytes', () => {
	it('report what the manager says', async () => {
		withEstimate(() => Promise.resolve({ usage: 400, quota: 1000 }));
		await expect(storageSpace()).resolves.toEqual({ usage: 400, quota: 1000 });
		await expect(freeBytes()).resolves.toBe(600);
	});

	it('answer null rather than zero when the manager declines', async () => {
		withEstimate(() => Promise.resolve({}));
		await expect(storageSpace()).resolves.toBeNull();
		await expect(freeBytes()).resolves.toBeNull();
	});

	it('never report negative free space', async () => {
		withEstimate(() => Promise.resolve({ usage: 1200, quota: 1000 }));
		await expect(freeBytes()).resolves.toBe(0);
	});
});
