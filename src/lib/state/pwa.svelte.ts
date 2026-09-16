/* Service-worker state bridge. vite-plugin-pwa's `virtual:pwa-register` gives
 * a callback API; this mirrors it into a reactive $state object so
 * UpdateBanner can show a "new version" prompt, matching the AiracBanner
 * reload pattern. The worker itself is generated at build time
 * (vite.config.ts); in dev (no devOptions) `registerSW` is a no-op stub. */

import { registerSW } from 'virtual:pwa-register';
import { isNativeApp } from '$lib/native/platform';

export const pwa = $state<{ needRefresh: boolean }>({
	needRefresh: false,
});

// registerType is 'prompt', so a freshly deployed worker waits rather than
// swapping itself in; applyUpdate() is what activates it (skipWaiting) and
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
const updateSW = isNativeApp()
	? null
	: registerSW({
			onNeedRefresh() {
				pwa.needRefresh = true;
			},
		});

export function applyUpdate(): void {
	void updateSW?.(true);
}

export function dismissUpdate(): void {
	pwa.needRefresh = false;
}
