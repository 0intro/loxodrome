/* The journal drain over the bridge (native/navRecorder.ts drainNativeAfter).
 * The web side clears the journal once a drain is done, so a drain that
 * fails part-way must say so: a partial page passed off as the whole would
 * have the journal cleared over fixes the trace never received. The plugin
 * is a fake behind a mocked @capacitor/core; fresh module state per case,
 * the handle being parked in the module. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const plugin = vi.hoisted(() => ({
	pages: [] as ({ fixes: unknown[]; done: boolean } | Error)[],
	calls: [] as number[],
}));

vi.mock('$lib/native/platform', () => ({ isNativeApp: () => true }));
vi.mock('@capacitor/core', () => ({
	registerPlugin: () => ({
		drain: ({ afterMs }: { afterMs: number }) => {
			plugin.calls.push(afterMs);
			const page = plugin.pages.shift() ?? { fixes: [], done: true };
			return page instanceof Error ? Promise.reject(page) : Promise.resolve(page);
		},
	}),
}));

beforeEach(() => {
	plugin.pages = [];
	plugin.calls = [];
	vi.resetModules();
});

const fix = (tMs: number): unknown => ({ tMs, lat: 48.6, lon: 2.4, accM: 5 });

describe('drainNativeAfter', () => {
	it('pages through the journal from its cursor', async () => {
		plugin.pages = [
			{ fixes: [fix(1000), fix(2000)], done: false },
			{ fixes: [fix(3000)], done: true },
		];
		const { drainNativeAfter } = await import('$lib/native/navRecorder');
		expect(await drainNativeAfter(0)).toEqual([fix(1000), fix(2000), fix(3000)]);
		expect(plugin.calls).toEqual([0, 2000]);
	});

	it('answers null, never the pages before it, when a page fails', async () => {
		plugin.pages = [{ fixes: [fix(1000), fix(2000)], done: false }, new Error('read')];
		const { drainNativeAfter } = await import('$lib/native/navRecorder');
		expect(await drainNativeAfter(0)).toBeNull();
	});

	it('answers null when the first call fails', async () => {
		plugin.pages = [new Error('read')];
		const { drainNativeAfter } = await import('$lib/native/navRecorder');
		expect(await drainNativeAfter(0)).toBeNull();
	});
});
