/* The flight gesture: one action behind the toolbar flight button, the
 * search palette's flight row and the Navigation tab's Start / Continue,
 * that starts (or asks to stop) the recording and ends ON THE MAP.
 *
 * Reactivity contract: every side-effect here runs from an event handler,
 * NEVER from an $effect on nav.recording. The recording flag also rises
 * from the Android boot reconcile and falls from native stops
 * (docs/android.md), and an effect would collapse the sidebar or re-show
 * the strip on every app resume with a live service.
 *
 * The pending confirms render in Toolbar.svelte, which is always mounted
 * (the FileOpenHost idiom: module $state + a standing host); this module
 * imports no catalog, so it can never freeze a language. The two Android
 * asides live here too, shared by every entry point: the location
 * disclosure that must precede the first permission prompt, and the
 * battery-optimisation offer that follows a first start.
 *
 * Semantics (user-decided; docs/nav-live.md "In-flight ergonomics"):
 * - idle tap, no trace: fresh start, no dialog;
 * - idle tap, trace whose last fix is under OUTING_MS old: continue
 *   silently (a multi-leg day appends its legs, the log's takeoff /
 *   landing folds keep the flights apart);
 * - idle tap, older trace: fresh start, SILENTLY when the trace holds a
 *   committed takeoff (recording or import, it is filed in the flights
 *   library, so nothing is lost; docs/flights-library.md), behind the
 *   replace confirm for taxi-only traces and fragments, which the
 *   library never files;
 * - tap while recording: stop behind the stop confirm.
 * The tab's explicit Restart bypasses the outing rule through its own
 * confirm and calls goFlying(true) directly. */

import { readItem, writeItem } from './persist';
import { ui, closeDetail } from './ui.svelte';
import { mapState } from './map.svelte';
import {
	nav,
	startRecording,
	continueRecording,
	stopRecording,
	setFollow,
	OUTING_MS,
} from './navRecording.svelte';
import { setStripHidden } from './navStrip.svelte';
import { traceMotion } from './navMotion';
import { traceEndMs } from '$lib/nav/trace';
import { rearmFollow, recenterNav } from '$lib/map/navLayer';
import { isNativeApp } from '$lib/native/platform';
import { nativeBatteryStatus, nativeOpenBatterySettings } from '$lib/native/navRecorder';

export const flightAction = $state<{
	/** The confirm the standing host (Toolbar.svelte) renders. */
	pending: 'replace' | 'stop' | 'battery' | 'location' | null;
}>({ pending: null });

/** Whether the app is exempt from battery optimization (Android; null =
 *  unknown or not native). The Navigation tab's hint row reads it. */
export const battery = $state<{ ignoring: boolean | null }>({ ignoring: null });

/** The one-tap flight gesture. */
export function startFlight(): void {
	if (nav.recording) {
		flightAction.pending = 'stop';
		return;
	}
	if (nav.points.length === 0) {
		goFlying(true);
		return;
	}
	const end = traceEndMs(nav.points);
	if (end != null && Date.now() - end < OUTING_MS) {
		goFlying(false);
		return;
	}
	// An outing with a committed takeoff is FILED in the flights library
	// (at its stop or its import), so starting fresh over it loses nothing
	// and the confirm would protect nothing. A taxi-only trace or a
	// fragment, which the library never files, keeps it.
	if (traceMotion(nav.points).takeoffMs != null) {
		goFlying(true);
		return;
	}
	flightAction.pending = 'replace';
}

/** Start (fresh) or continue the recording, then end on the map: strip up,
 *  sidebar panel / phone sheet collapsed, detail closed, follow re-armed.
 *  The collapse pair is the fullscreen button's exact "reveal the map"
 *  move. A fresh start must NOT pan (navLayer's lastPose still holds the
 *  OLD trace's endpoint until the MapView effect re-syncs); continuing
 *  centres on the trace tip, roughly where the aircraft is. */
export function goFlying(fresh: boolean): void {
	if (needsLocationDisclosure()) {
		// Raised BEFORE the recording starts, because starting it is what
		// asks for the location permission and the disclosure has to come
		// first. confirmPending resumes here with the same `fresh`.
		disclosureFresh = fresh;
		flightAction.pending = 'location';
		return;
	}
	if (fresh) {
		startRecording();
	} else {
		continueRecording();
	}
	setStripHidden(false);
	ui.sidebarCollapsed = true;
	// The next panel / sheet open lands on the in-flight tab rather than
	// wherever planning left off; the panel itself stays closed, and every
	// entry point here is an explicit user gesture (the Android boot
	// reconcile flips nav.recording directly, never through this).
	ui.activeTab = 'navigation';
	closeDetail();
	setFollow(true);
	if (fresh) {
		rearmFollow();
	} else if (mapState.map) {
		recenterNav(mapState.map);
	}
	void maybeOfferBattery();
}

export function confirmPending(): void {
	// Null FIRST: the replace branch's goFlying may later set 'battery'
	// through the async offer, and the dialog-close write must not clobber
	// it (the NavigationTab onConfirm idiom).
	const p = flightAction.pending;
	flightAction.pending = null;
	if (p === 'replace') {
		goFlying(true);
	} else if (p === 'stop') {
		if (nav.recording) {
			stopRecording();
		}
	} else if (p === 'battery') {
		void openBatterySettings();
	} else if (p === 'location') {
		// Consent given: record it, then re-enter the gesture, which now
		// falls straight through to the recording and its permission prompt.
		writeItem(LOCATION_DISCLOSED_KEY, 'done');
		goFlying(disclosureFresh);
	}
}

export function dismissPending(): void {
	flightAction.pending = null;
}

// --- Location disclosure (Android; docs/android.md) -----------------------
// Shown ONCE, immediately before the first recording start, which is the
// only thing in the app that asks for the location permission. Google Play
// treats a foreground service whose location use is equivalent to background
// location as subject to the background-location rules, and an in-app
// disclosure stating why, what and how, right before the runtime prompt, is
// the documented answer; a privacy policy or a store description does not
// count. Native only: the web has its own browser prompt and no store.
//
// Once ever, not once per flight: the cockpit gesture is one tap, and every
// later start keeps it.

const LOCATION_DISCLOSED_KEY = 'loxodrome:nav-location-disclosed';

/** Carries goFlying's argument across the disclosure, the way the replace
 *  confirm carries its own fresh start. */
let disclosureFresh = true;

function needsLocationDisclosure(): boolean {
	return isNativeApp() && readItem(LOCATION_DISCLOSED_KEY) == null;
}

// --- Battery-exemption offer (Android; docs/android.md) --------------------
// The foreground service survives stock Android, but several skins (MIUI
// above all) throttle or kill even foreground-service apps unless the
// battery restriction is lifted. Offered ONCE, at the first flight start;
// afterwards the Navigation tab's hint row re-offers while not exempt.

const BATTERY_ASKED_KEY = 'loxodrome:nav-battery-asked';

export async function refreshBattery(): Promise<void> {
	battery.ignoring = await nativeBatteryStatus();
}

async function maybeOfferBattery(): Promise<void> {
	if (!isNativeApp() || readItem(BATTERY_ASKED_KEY) != null) {
		return;
	}
	writeItem(BATTERY_ASKED_KEY, 'done');
	const ignoring = await nativeBatteryStatus();
	battery.ignoring = ignoring;
	if (ignoring === false) {
		flightAction.pending = 'battery';
	}
}

export async function openBatterySettings(): Promise<void> {
	await nativeOpenBatterySettings();
	// The settings screen answers out of band: re-read shortly after, and
	// again when the app next returns to the foreground.
	setTimeout(() => void refreshBattery(), 3000);
	document.addEventListener('visibilitychange', onBatteryVisibility);
}

function onBatteryVisibility(): void {
	if (document.visibilityState !== 'hidden') {
		void refreshBattery();
		document.removeEventListener('visibilitychange', onBatteryVisibility);
	}
}

if (isNativeApp()) {
	void refreshBattery();
}
