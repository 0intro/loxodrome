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
 * Called from the event paths only (goFlying, stopRecording), never from
 * an effect on nav.recording (the Android boot reconcile flips it too, and
 * a boot must not re-enter immersive on its own). `leave` acts only after
 * an `enter` took the screen, so a desktop stop or a pref flipped
 * mid-flight can never call exitFullscreen on a screen it never took. */
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
	entered = true;
	if (isNativeApp()) {
		void setImmersive(true);
		return;
	}
	const el = document.documentElement;
	if (typeof el.requestFullscreen === 'function' && !document.fullscreenElement) {
		el.requestFullscreen().catch(() => {
			/* refused (no gesture, an iframe, a policy): the page stays as it is */
		});
	}
}

/** Give the screen back at the stop; a no-op unless `enter` took it. */
export function leaveFlightScreen(): void {
	if (!entered) {
		return;
	}
	entered = false;
	if (isNativeApp()) {
		void setImmersive(false);
		return;
	}
	if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
		document.exitFullscreen().catch(() => {
			/* already left (Escape, the back gesture): nothing to undo */
		});
	}
}
