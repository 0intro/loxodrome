/* The web's Reload lands the new version when one is waiting.
 *
 * The expiry banner (AiracBanner) offers Reload on the web, the site being
 * redeployed with every data refresh. The date it judges by is baked into the
 * bundle at build time, and the service worker registers with the 'prompt'
 * type, so a freshly deployed version WAITS: a plain location.reload() came
 * back under the old worker, on the old precached bundle, with the same expired
 * date and the same banner, as often as it was pressed. reloadApp activates the
 * waiting worker instead (applyUpdate, the "new version" banner's own action),
 * and reloads plainly only when nothing waits. */

import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sw = vi.hoisted(() => ({
	onNeedRefresh: null as (() => void) | null,
	updates: [] as (boolean | undefined)[],
}));
vi.mock('virtual:pwa-register', () => ({
	registerSW: (opts: { onNeedRefresh?: () => void }) => {
		sw.onNeedRefresh = opts.onNeedRefresh ?? null;
		return (reloadPage?: boolean) => {
			sw.updates.push(reloadPage);
			return Promise.resolve();
		};
	},
}));
const reload = vi.fn();
vi.stubGlobal('location', { reload });
afterAll(() => {
	vi.unstubAllGlobals();
});

const { pwa, reloadApp } = await import('$lib/state/pwa.svelte');

beforeEach(() => {
	reload.mockClear();
	sw.updates.length = 0;
	pwa.needRefresh = false;
});

describe('reloadApp', () => {
	it('reloads plainly when no new version waits', () => {
		reloadApp();
		expect(reload).toHaveBeenCalledTimes(1);
		expect(sw.updates).toEqual([]);
	});

	it('lets a waiting version in rather than reloading under the old one', () => {
		sw.onNeedRefresh?.();
		expect(pwa.needRefresh).toBe(true);
		reloadApp();
		expect(sw.updates).toEqual([true]);
		expect(reload).not.toHaveBeenCalled();
	});
});

describe('AiracBanner', () => {
	it('reloads through reloadApp, never around it', () => {
		const src = readFileSync('src/lib/components/AiracBanner.svelte', 'utf8');
		expect(src).not.toContain('location.reload');
		// The expiry banner's update on the web, and the cycle switch's Reload.
		expect(src.match(/reloadApp\b/g)?.length).toBeGreaterThanOrEqual(3);
		expect(src).toContain('onAction={reloadApp}');
	});

	it('keeps a dismissal to itself, never clearing what the heartbeat computes', () => {
		// airacSwitchPending is the heartbeat's output, recomputed every minute
		// tick: a dismissal written there came back within a minute.
		const src = readFileSync('src/lib/components/AiracBanner.svelte', 'utf8');
		expect(src).not.toMatch(/airacSwitchPending\s*=/);
		expect(src).toContain('dataState.airacSwitchPending && !switchDismissed');
	});
});
