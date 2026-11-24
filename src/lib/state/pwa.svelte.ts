/* Service-worker state bridge. vite-plugin-pwa's `virtual:pwa-register` gives
 * a callback API; this mirrors it into a reactive $state object so
 * UpdateBanner can show a "new version" prompt, matching the AiracBanner
 * reload pattern. The worker itself is generated at build time
 * (vite.config.ts); in dev (no devOptions) `registerSW` is a no-op stub. */

import { registerSW } from 'virtual:pwa-register';
import { isNativeApp } from '$lib/native/platform';

export const pwa = $state<{ needRefresh: boolean; busy: boolean }>({
	needRefresh: false,
	// A Reload is under way: every banner offering one says so, one reload
	// answering every notice.
	busy: false,
});

/** How long a Reload waits for the new worker to take over before it
 *  reloads anyway, and then for the page to go before it hands the button
 *  back. */
export const RELOAD_WAIT_MS = 10_000;

let replacing = false;

/** Ask the browser to replace the page, once: the new worker's activation
 *  and workbox-window's own `controlling` event can both ask. A page still
 *  here RELOAD_WAIT_MS later stayed (a leave question refused it), and the
 *  next ask reloads again. */
function replacePage(): void {
	if (replacing) {
		return;
	}
	replacing = true;
	location.reload();
	setTimeout(() => {
		replacing = false;
	}, RELOAD_WAIT_MS);
}

// registerType is 'prompt', so a freshly deployed worker waits rather than
// swapping itself in; reloadApp() is what activates it (SKIP_WAITING) and
// reloads. registerSW defers to the window load event, so importing this
// module for its side effect does not compete with first paint.
// The Android shell skips registration outright: its assets ship inside the
// APK (updates arrive as app updates, so the prompt is meaningless there) and
// the live-data routes are network-only with or without a worker.
//
// `onOfflineReady` is deliberately NOT handled. It fires on the first install
// of the worker and on nothing else, so a banner over it reports the success
// path alone: every way the app can fail to become offline-capable (no
// service-worker support, a registration error, a precache install that 404s
// or exceeds the quota, a later eviction) stays silent, and the absence of
// the message reads the same as a dev build, the Android shell or a private
// window. It also returned on every session that started without a
// controlling worker, so cleared site data or an evicted registration showed
// it again on an ordinary visit, claiming the whole app at the moment the
// least data was cached. Offline coverage a pilot can act on is stated per
// resource instead, by the Layers tab's chart packs and the Route tab's
// terrain pins.
if (!isNativeApp()) {
	registerSW({
		onNeedRefresh() {
			pwa.needRefresh = true;
		},
		// Another tab let the new worker in, and this page, which the old one
		// controlled, follows it.
		onNeedReload: replacePage,
	});
}

/** What a Reload came to, for a page still there to hear it: 'current',
 *  the site serves no newer version (asked with `check`); 'unreachable',
 *  the site could not be asked or its new version did not install; null,
 *  the reload was asked and the page stayed (a leave question refused it). */
export type ReloadOutcome = 'current' | 'unreachable' | null;

/** Reload onto the newest version the device holds, or with `check` the
 *  newest the site serves. A worker waiting is let in and the page reloads
 *  once it is active, whether or not the old worker controlled this page
 *  (workbox-window reloads only a page it did), and with nothing waiting the
 *  page reloads plainly: a plain reload with a worker waiting came back
 *  under the old one, on the old precached bundle, whose build-time stamps
 *  (the data-validity date among them) are what the reload was asked to
 *  replace. `check` first waits for a worker still installing, or asks the
 *  site for one (`registration.update()`), and answers 'current' rather
 *  than reload a controlled page onto the bundle it already runs. Pending
 *  while the page goes. pwa.busy holds every Reload label meanwhile, and a
 *  press while it runs starts nothing. */
export async function reloadApp(opts: { check?: boolean } = {}): Promise<ReloadOutcome> {
	if (pwa.busy) {
		return null;
	}
	pwa.busy = true;
	try {
		const reg = await registration();
		let next = reg?.waiting ?? null;
		if (!next && reg && opts.check) {
			next = reg.installing;
			if (!next) {
				try {
					await reg.update();
				} catch {
					return 'unreachable';
				}
				next = reg.installing ?? reg.waiting;
			}
			if (!next && navigator.serviceWorker.controller) {
				return 'current';
			}
		}
		if (next) {
			// Installing: the new version's precache downloads first, bounded by
			// the browser's own event timeout.
			if ((await stateIn(next, ['installed', 'activating', 'activated', 'redundant'], Infinity)) === 'redundant') {
				return 'unreachable';
			}
			await letIn(next);
		}
		return await replace();
	} finally {
		pwa.busy = false;
	}
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
	if (isNativeApp() || typeof navigator === 'undefined' || !navigator.serviceWorker) {
		return undefined;
	}
	try {
		return await navigator.serviceWorker.getRegistration();
	} catch {
		return undefined;
	}
}

/** Tell a waiting worker to take over and wait for it to be active, at most
 *  RELOAD_WAIT_MS: the old worker's fetches still in flight hold the
 *  activation, and the reload that follows ends them. */
async function letIn(sw: ServiceWorker): Promise<void> {
	if (sw.state === 'installed') {
		sw.postMessage({ type: 'SKIP_WAITING' });
	}
	await stateIn(sw, ['activated', 'redundant'], RELOAD_WAIT_MS);
}

/** Reload, and settle RELOAD_WAIT_MS later if the page is still here. */
async function replace(): Promise<null> {
	replacePage();
	await new Promise((r) => setTimeout(r, RELOAD_WAIT_MS));
	return null;
}

/** The worker's state once it is one of `states`, or after `ms` (never,
 *  for Infinity). */
function stateIn(sw: ServiceWorker, states: readonly ServiceWorkerState[], ms: number): Promise<ServiceWorkerState> {
	return new Promise((resolve) => {
		const finish = (): void => {
			sw.removeEventListener('statechange', check);
			clearTimeout(timer);
			resolve(sw.state);
		};
		const check = (): void => {
			if (states.includes(sw.state)) {
				finish();
			}
		};
		const timer = ms === Infinity ? undefined : setTimeout(finish, ms);
		sw.addEventListener('statechange', check);
		check();
	});
}
