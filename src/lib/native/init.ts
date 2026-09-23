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
import { nav, reconcileNativeRecording } from '$lib/state/navRecording.svelte';
import { leaveFlightScreen } from '$lib/ui/flightScreen';

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
	void reconcileNativeRecording().then(() => {
		/* And the SCREEN with it. Immersive mode lives on the Activity and
		 * outlives the WebView, so a reload (the AIRAC or update banner, a
		 * renderer kill) whose recording does NOT come back leaves the phone
		 * with its system bars hidden, no recording, and nothing in the app
		 * that would ever give them back: `leaveFlightScreen` rides the STOP,
		 * and no stop happens for a recording that was never resumed.
		 * Measured on the Redmi, the WebView 838 px tall with the Fly button
		 * reading Start. Showing bars already shown costs nothing, which is
		 * why this can simply run whenever the boot settles out of flight. */
		if (!nav.recording) {
			leaveFlightScreen();
		}
	}).catch(() => {
		// The reconcile threw (a journal read, a plugin call): the bars are
		// exactly what must not be left hidden on that path.
		leaveFlightScreen();
	});
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
