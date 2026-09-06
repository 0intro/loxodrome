/* The recording's automatic stop after landing. The decision is the pure
 * fold in nav/autoStop.ts; this module holds the persisted preference, the
 * countdown the strip and the Navigation tab render, and the reconcile
 * App.svelte runs in an effect. The effect ticks on the recorder's own 1 Hz
 * clock (nav.nowMs runs only while the watch is up) and per appended fix,
 * and is inert otherwise. Firing goes through the ordinary stopRecording():
 * the trace flushes, the wake lock releases, and the automatic night
 * restores through the existing effects. Contract: docs/nav-live.md. */

import { readItem, removeItem, writeItem } from './persist';
import { nav, stopRecording } from './navRecording.svelte';
import { traceMotion } from './navMotion';
import { foldAutoStop, newAutoStopFold, type AutoStopState } from '$lib/nav/autoStop';
import { setNativeAutoStop } from '$lib/native/navRecorder';

const KEY = 'loxodrome:nav-auto-stop';

export const autoStop = $state<{
	/** Default ON; only the OFF state is stored (the navStrip.overflight
	 *  idiom, so a default leaves no storage). */
	enabled: boolean;
	/** The armed countdown, for both surfaces; null while disarmed. */
	pending: { stopAtMs: number; landingMs: number } | null;
	/** When the last automatic stop fired (session-only, the tab's note),
	 *  retired when a new recording starts. */
	firedAtMs: number | null;
}>({
	// readItem degrades to null on storage failure, so the default stays on.
	enabled: readItem(KEY) !== 'off',
	pending: null,
	firedAtMs: null,
});

const fold = newAutoStopFold();
/** The last pending written, compared NON-reactively so the reconcile
 *  effect never tracks its own write. */
let lastPending: AutoStopState['pending'] = null;

function setPending(p: AutoStopState['pending']): void {
	const same =
		p == null
			? lastPending == null
			: lastPending != null &&
				p.stopAtMs === lastPending.stopAtMs &&
				p.landingMs === lastPending.landingMs;
	lastPending = p;
	if (!same) {
		autoStop.pending = p;
	}
}

export function setAutoStopEnabled(on: boolean): void {
	autoStop.enabled = on;
	// Mirrored to the native recorder's dead-bridge safety valve, which is
	// the one auto-stop that can run with the web app gone (docs/android.md).
	void setNativeAutoStop(on);
	if (on) {
		removeItem(KEY);
	} else {
		writeItem(KEY, 'off');
	}
}

/** The countdown's escape: cancel the stop for THIS landing. A later
 *  takeoff and landing arm it again (the fold's value rule). */
export function keepRecording(): void {
	if (autoStop.pending) {
		fold.suppressedLandingMs = autoStop.pending.landingMs;
	}
	setPending(null);
}

/** Reconcile the automatic stop; call inside App.svelte's $effect. Reads
 *  nav.recording first, so the idle dependency set stays minimal. */
export function reconcileAutoStop(): void {
	const recording = nav.recording;
	// A native-side automatic stop (the recorder's safety valve, fired with
	// the web app gone) surfaces through the same note as the JS one;
	// consumed here, where the note's lifecycle already lives.
	if (nav.nativeAutoStopMs != null) {
		autoStop.firedAtMs = nav.nativeAutoStopMs;
		nav.nativeAutoStopMs = null;
	}
	if (recording && !fold.recording) {
		// A fresh recording retires the previous stop's note and re-arms the
		// native valve with the preference in force.
		autoStop.firedAtMs = null;
		void setNativeAutoStop(autoStop.enabled);
	}
	if (!recording) {
		// The edges still advance (a stop must read as a falling edge, so
		// the next start is a rising one); the answer is inert by the gate.
		foldAutoStop(fold, {
			recording,
			enabled: autoStop.enabled,
			landingMs: null,
			lastMoveMs: null,
			nowMs: 0,
		});
		setPending(null);
		return;
	}
	const motion = traceMotion(nav.points);
	const st = foldAutoStop(fold, {
		recording,
		enabled: autoStop.enabled,
		landingMs: motion.landingMs,
		lastMoveMs: motion.lastMoveMs,
		nowMs: nav.nowMs,
	});
	if (st.fire) {
		// Convergence: the stop flips nav.recording, the re-run takes the
		// inert branch (the applyAutoNight-calls-setTheme precedent).
		stopRecording();
		autoStop.firedAtMs = Date.now();
		setPending(null);
		return;
	}
	setPending(st.pending);
}
