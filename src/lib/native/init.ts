/* One-time wiring of the Capacitor Android shell (docs/android.md), called
 * from main.ts; a no-op on the web.
 *
 * Hardware Back: @capacitor/app delivers the button to JS once a listener
 * exists. Surfaces close through closeTopBackClose (the backClose stack
 * itself, position-independent): WebView.canGoBack() counts no
 * pushState-only entries and the backClose same-tick drift can strand the
 * session at the base entry, so neither the event flag nor history.back()
 * can be trusted to dismiss a modal (both measured; see backClose.ts). At
 * the history root the app minimizes: Android convention, where Capacitor's
 * own default would swallow the press.
 *
 * Deliberately NO system-bar styling: the shell renders between OPAQUE bars
 * whose background follows the SYSTEM day/night theme (stock DayNight
 * template), so forcing icon style from the APP theme could paint light
 * icons on a light bar. Bars go transparent together with true edge-to-edge
 * as one follow-up (docs/android.md). */

import { isNativeApp } from './platform';
import { closeTopBackClose } from '$lib/ui/backClose';
import { reconcileNativeRecording } from '$lib/state/navRecording.svelte';

export function initNativeApp(): void {
	if (!isNativeApp()) {
		return;
	}
	void wireBackButton();
	// The background flight recorder: if its foreground service is running,
	// resume the recording posture and drain the journalled fixes; if it
	// stopped natively (notification action, safety valve, force-stop),
	// finish the trace (docs/android.md). Every module init, restore()
	// included, has already run: static imports evaluate before main.ts
	// calls this.
	void reconcileNativeRecording();
}

async function wireBackButton(): Promise<void> {
	const { App } = await import('@capacitor/app');
	void App.addListener('backButton', ({ canGoBack }) => {
		if (closeTopBackClose()) {
			return;
		}
		if (canGoBack) {
			window.history.back();
		} else {
			void App.minimizeApp();
		}
	});
}
