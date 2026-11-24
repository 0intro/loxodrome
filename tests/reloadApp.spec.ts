/* The web's Reload lands the new version when one is waiting, whatever the
 * page it is pressed in.
 *
 * The service worker registers with the 'prompt' type, so a freshly deployed
 * version WAITS. vite-plugin-pwa's own update only posts SKIP_WAITING, and its
 * reload comes from workbox-window's `controlling` event, for a page the old
 * worker controlled when it registered: pressed in a page opened with a hard
 * reload, or on a first visit, while another tab kept the new version
 * waiting, the press let it in, reloaded the OTHER tabs and left this one as
 * it was, every further press doing nothing. And the expiry banner's plain
 * reload came back under the old worker, on the old precached bundle, with
 * the same expired date (baked in at build time) and the same banner.
 * reloadApp lets the waiting worker in and reloads once it is active,
 * controlled page or not, and reloads plainly when nothing waits. */

import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sw = vi.hoisted(() => ({
	onNeedRefresh: null as (() => void) | null,
	onNeedReload: null as (() => void) | null,
}));
vi.mock('virtual:pwa-register', () => ({
	registerSW: (opts: { onNeedRefresh?: () => void; onNeedReload?: () => void }) => {
		sw.onNeedRefresh = opts.onNeedRefresh ?? null;
		sw.onNeedReload = opts.onNeedReload ?? null;
		return () => Promise.resolve();
	},
}));

/** A service worker as the page sees it: a state and its changes. */
class FakeWorker extends EventTarget {
	state: ServiceWorkerState;
	posted: unknown[] = [];
	constructor(state: ServiceWorkerState) {
		super();
		this.state = state;
	}
	postMessage(m: unknown): void {
		this.posted.push(m);
	}
	to(state: ServiceWorkerState): void {
		this.state = state;
		this.dispatchEvent(new Event('statechange'));
	}
}

const reg = {
	waiting: null as FakeWorker | null,
	installing: null as FakeWorker | null,
	update: vi.fn(() => Promise.resolve()),
};
const container = {
	controller: null as object | null,
	getRegistration: vi.fn(() => Promise.resolve(reg)),
};
const reload = vi.fn();
vi.stubGlobal('location', { reload });
vi.stubGlobal('navigator', { serviceWorker: container });
afterAll(() => {
	vi.unstubAllGlobals();
});

const { pwa, reloadApp, RELOAD_WAIT_MS } = await import('$lib/state/pwa.svelte');

beforeEach(() => {
	vi.useFakeTimers();
	reload.mockClear();
	reg.waiting = null;
	reg.installing = null;
	reg.update.mockReset();
	reg.update.mockResolvedValue(undefined);
	container.controller = null;
	pwa.needRefresh = false;
});

afterEach(async () => {
	// Let every Reload of the case hand its button back.
	await vi.advanceTimersByTimeAsync(3 * RELOAD_WAIT_MS);
	vi.useRealTimers();
});

describe('reloadApp', () => {
	it('reloads plainly when no new version waits', async () => {
		void reloadApp();
		await vi.advanceTimersByTimeAsync(0);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('reloads plainly when the banner still shows but nothing waits any more', async () => {
		// Another tab let the version in, or a newer deploy replaced it.
		sw.onNeedRefresh?.();
		expect(pwa.needRefresh).toBe(true);
		void reloadApp();
		await vi.advanceTimersByTimeAsync(0);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('lets a waiting version in and reloads once it is active, in a page the old worker never controlled', async () => {
		const next = new FakeWorker('installed');
		reg.waiting = next;
		container.controller = null;
		void reloadApp();
		await vi.advanceTimersByTimeAsync(0);
		expect(next.posted).toEqual([{ type: 'SKIP_WAITING' }]);
		expect(reload).not.toHaveBeenCalled();
		next.to('activating');
		await vi.advanceTimersByTimeAsync(0);
		expect(reload).not.toHaveBeenCalled();
		next.to('activated');
		await vi.advanceTimersByTimeAsync(0);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('reloads once when the controlling page hears of the takeover too', async () => {
		const next = new FakeWorker('installed');
		reg.waiting = next;
		container.controller = {};
		void reloadApp();
		await vi.advanceTimersByTimeAsync(0);
		sw.onNeedReload?.();
		next.to('activated');
		await vi.advanceTimersByTimeAsync(0);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('reloads anyway when the activation is held past the bound', async () => {
		reg.waiting = new FakeWorker('installed');
		void reloadApp();
		await vi.advanceTimersByTimeAsync(RELOAD_WAIT_MS - 1);
		expect(reload).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('holds every Reload busy until the page goes, and hands it back when the page stays', async () => {
		let settled = false;
		void reloadApp().then(() => (settled = true));
		await vi.advanceTimersByTimeAsync(0);
		expect(pwa.busy).toBe(true);
		// A second press while it runs starts nothing.
		await reloadApp();
		expect(reload).toHaveBeenCalledTimes(1);
		expect(settled).toBe(false);
		// A leave question refused the reload: the page is still here.
		await vi.advanceTimersByTimeAsync(RELOAD_WAIT_MS);
		expect(settled).toBe(true);
		expect(pwa.busy).toBe(false);
		// And the next press reloads again.
		void reloadApp();
		await vi.advanceTimersByTimeAsync(0);
		expect(reload).toHaveBeenCalledTimes(2);
	});
});

describe('reloadApp with check, the expiry notice', () => {
	it('answers current when the site serves no newer version, and stays', async () => {
		container.controller = {};
		const outcome = await reloadApp({ check: true });
		expect(outcome).toBe('current');
		expect(reg.update).toHaveBeenCalledTimes(1);
		expect(reload).not.toHaveBeenCalled();
		expect(pwa.busy).toBe(false);
	});

	it('answers unreachable when the site cannot be asked', async () => {
		container.controller = {};
		reg.update.mockRejectedValue(new TypeError('Failed to fetch'));
		expect(await reloadApp({ check: true })).toBe('unreachable');
		expect(reload).not.toHaveBeenCalled();
	});

	it('installs the version the site serves, lets it in and reloads onto it', async () => {
		container.controller = {};
		const next = new FakeWorker('installing');
		reg.update.mockImplementation(() => {
			reg.installing = next;
			return Promise.resolve();
		});
		void reloadApp({ check: true });
		await vi.advanceTimersByTimeAsync(RELOAD_WAIT_MS);
		// The download has no bound of ours: the browser times its install out.
		expect(next.posted).toEqual([]);
		expect(reload).not.toHaveBeenCalled();
		next.to('installed');
		await vi.advanceTimersByTimeAsync(0);
		expect(next.posted).toEqual([{ type: 'SKIP_WAITING' }]);
		next.to('activated');
		await vi.advanceTimersByTimeAsync(0);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('waits for a version already downloading rather than reloading onto the old one', async () => {
		container.controller = {};
		const next = new FakeWorker('installing');
		reg.installing = next;
		void reloadApp({ check: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(reg.update).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
		next.to('installed');
		next.to('activated');
		await vi.advanceTimersByTimeAsync(0);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('answers unreachable when the new version does not install', async () => {
		container.controller = {};
		const next = new FakeWorker('installing');
		reg.installing = next;
		let outcome: unknown = 'pending';
		void reloadApp({ check: true }).then((o) => (outcome = o));
		await vi.advanceTimersByTimeAsync(0);
		next.to('redundant');
		await vi.advanceTimersByTimeAsync(0);
		expect(outcome).toBe('unreachable');
		expect(reload).not.toHaveBeenCalled();
	});

	it('reloads a page the old worker never controlled, which may run behind the active one', async () => {
		container.controller = null;
		void reloadApp({ check: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(reg.update).toHaveBeenCalledTimes(1);
		expect(reload).toHaveBeenCalledTimes(1);
	});
});

describe('UpdateBanner', () => {
	it('keeps a dismissal to itself, never clearing what says a version waits', () => {
		const banner = readFileSync('src/lib/components/UpdateBanner.svelte', 'utf8');
		const state = readFileSync('src/lib/state/pwa.svelte.ts', 'utf8');
		expect(banner).toContain('pwa.needRefresh && !dismissed');
		expect(banner).not.toMatch(/needRefresh\s*=/);
		expect(state).not.toMatch(/needRefresh\s*=\s*false/);
	});

	it('reloads through reloadApp and says so while it runs', () => {
		const banner = readFileSync('src/lib/components/UpdateBanner.svelte', 'utf8');
		expect(banner).toContain('reloadApp()');
		expect(banner).toContain('busy={pwa.busy}');
	});
});

describe('AiracBanner', () => {
	it('reloads through reloadApp, never around it', () => {
		const src = readFileSync('src/lib/components/AiracBanner.svelte', 'utf8');
		expect(src).not.toContain('location.reload');
		expect(src).not.toContain('applyUpdate');
		expect(src.match(/reloadApp\(/g)?.length).toBeGreaterThanOrEqual(2);
		expect(src.match(/busy=\{pwa\.busy\}/g)?.length).toBe(2);
	});

	it('updates the expired data by asking the site for its newest version', () => {
		const src = readFileSync('src/lib/components/AiracBanner.svelte', 'utf8');
		expect(src).toContain('reloadApp({ check: true })');
		expect(src).toContain('actionLabel={t.common.updateApp}');
		expect(src).toContain('busyLabel={t.common.updating}');
	});

	it('keeps a dismissal to itself, never clearing what the heartbeat computes', () => {
		// airacSwitchPending is the heartbeat's output, recomputed every minute
		// tick: a dismissal written there came back within a minute.
		const src = readFileSync('src/lib/components/AiracBanner.svelte', 'utf8');
		expect(src).not.toMatch(/airacSwitchPending\s*=/);
		expect(src).toContain('dataState.airacSwitchPending && !switchDismissed');
	});
});
