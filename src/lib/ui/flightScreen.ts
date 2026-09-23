/* Full screen rides the recording (docs/nav-live.md "In-flight
 * ergonomics", docs/mobile-ui-review.md): there is no menu row for it. On
 * a phone, starting a flight takes the screen and stopping it gives it
 * back, gated on ONE persisted preference (Settings > Interface, "Full
 * screen in flight", default on). Two carriers behind one pair of calls:
 *
 * - the browser / PWA asks the document for fullscreen from the Fly tap
 *   (a user gesture, which the API requires; the disclosure dialog's
 *   confirm is one too) and exits at the stop, whatever ended it, so
 *   the auto-stop after landing needs no gesture to leave;
 * - the Android shell goes IMMERSIVE instead (native/immersive.ts,
 *   ImmersivePlugin.java): the system bars hide and a swipe from an edge
 *   shows them transiently. Capacitor keeps the WebView between opaque
 *   bars, so hiding them only grows the viewport; the safe-area code is
 *   untouched and true edge-to-edge stays docs/android.md's follow-up.
 *
 * ENTERED from the event paths only (goFlying), never from an effect on
 * nav.recording: the Android boot reconcile flips that flag too, and a boot
 * must not take the screen on its own. It is LEFT from the stops, and on
 * the shell also from the boot reconcile's settle (native/init.ts), because
 * immersive lives on the Activity and outlives the WebView: a reload whose
 * recording does not come back has no stop to ride. `leave` otherwise acts
 * only after an `enter` took the screen, so a desktop stop or a preference
 * flipped mid-flight can never call exitFullscreen on a screen it never
 * took. */
import { display } from '$lib/state/display.svelte';
import { isNativeApp } from '$lib/native/platform';
import { setImmersive } from '$lib/native/immersive';

/** The gate: a phone layout and the preference. Pure, spec-pinned. */
export function wantsFlightScreen(isMobile: boolean, pref: boolean): boolean {
	return isMobile && pref;
}

let entered = false;

/** Take the screen for the flight that just started. */
export function enterFlightScreen(isMobile: boolean): void {
	if (!wantsFlightScreen(isMobile, display.flightFullscreen)) {
		return;
	}
	if (isNativeApp()) {
		entered = true;
		void setImmersive(true);
		return;
	}
	const el = document.documentElement;
	// Only a screen this took is a screen this may give back, so the flag is
	// set on the branch that actually asks: a page already full screen when
	// the flight starts was put there by the user, and the stop must leave
	// it alone.
	if (typeof el.requestFullscreen === 'function' && !document.fullscreenElement) {
		entered = true;
		el.requestFullscreen().catch(() => {
			/* refused (no gesture, an iframe, a policy): the page stays as it
			 * is, and the screen was never this module's to give back */
			entered = false;
		});
	}
}

/** Give the screen back at the stop; a no-op unless `enter` took it. */
export function leaveFlightScreen(): void {
	// The shell is the exception to the `entered` rule, because the state
	// lives on the ANDROID side and outlives this module: a WebView reload
	// mid-flight (the AIRAC or update banner's reload, a renderer kill whose
	// recording the boot reconcile resumes) leaves the Activity immersive
	// with the flag back at false, and honouring it would strand the pilot
	// with no system bars for the rest of the session. Showing bars already
	// shown is free, and nothing else in the app hides them.
	if (isNativeApp()) {
		entered = false;
		void setImmersive(false);
		return;
	}
	if (!entered) {
		return;
	}
	entered = false;
	if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
		document.exitFullscreen().catch(() => {
			/* already left (Escape, the back gesture): nothing to undo */
		});
	}
}
