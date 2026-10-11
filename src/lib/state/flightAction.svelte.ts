/* The flight gesture: one action behind the toolbar flight button, the
 * search palette's flight row, the folded strip's stop and the Navigation
 * tab's buttons, that starts, resumes or asks to stop the recording and ends
 * ON THE MAP.
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
 * Semantics (user-decided; docs/nav-live.md "In-flight ergonomics"): ONE
 * decision over the loaded trace, taken on how it ENDED and where it came
 * from (nav/flightStart.ts), behind every entry point:
 * - no trace: a fresh start, no dialog;
 * - this device's recording, stopped in flight, last fix under
 *   RESUME_SILENT_MS old: resumed silently (the crashed page, the Stop
 *   pressed by mistake), and the button says Resume;
 * - stopped in flight longer ago, slow away from any known field, or before
 *   any takeoff: one question, Resume flight or New flight;
 * - landed, an import, a replayed library flight, anything past OUTING_MS:
 *   a new flight;
 * - a new flight over a trace the flights library does NOT hold (no takeoff,
 *   no wall clock, a store that failed or has not answered) asks to discard
 *   it first; one it holds is replaced in silence, since nothing is lost;
 * - a tap while recording stops, behind the stop confirm only while the
 *   flight is open (airborne): on the ground nothing is cut short.
 * The Navigation tab names the same choices as buttons and calls the
 * intents below, never goFlying, so a stale button cannot bypass the rule. */

import { readItem, writeItem } from './persist';
import { ui, closeDetail, closePage } from './ui.svelte';
import { enterFlightScreen } from '$lib/ui/flightScreen';
import { mapState } from './map.svelte';
import {
	nav,
	archiveTicket,
	foundTraceGoesAside,
	startRecording,
	continueRecording,
	stopRecording,
	setFollow,
	ticketCurrent,
	traceAltDatum,
	traceFiled,
	type ArchiveTicket,
} from './navRecording.svelte';
import { summaryDeps } from './flightLibrary.svelte';
import { notamState } from './notam.svelte';
import { noteRadarInFlight } from './radar.svelte';
import { setStripHidden } from './navStrip.svelte';
import { traceMotion } from './navMotion';
import {
	discardReason,
	flightDecision,
	flightOpen,
	type DiscardReason,
	type FlightDecision,
	type TraceEnd,
} from '$lib/nav/flightStart';
import { rearmFollow, recenterNav } from '$lib/map/navLayer';
import { isNativeApp } from '$lib/native/platform';
import { foundOuting } from '$lib/sync/found';
import { nativeBatteryStatus, nativeOpenBatterySettings } from '$lib/native/navRecorder';

/** What a pending question was asked about, read when it was raised: the
 *  host words it from these, and the answer acts only while the trace is
 *  still the one asked about (the ticket). */
export interface FlightQuestion {
	ticket: ArchiveTicket;
	end: TraceEnd | null;
	lastFixMs: number | null;
	discard: DiscardReason | null;
}

export const flightAction = $state<{
	/** The confirm the standing host (Toolbar.svelte) renders: `resume`
	 *  asks Resume flight or New flight, `discard` asks before a new flight
	 *  drops a trace the library does not hold. */
	pending: 'resume' | 'discard' | 'stop' | 'battery' | 'location' | null;
	/** The facts the resume and discard questions are worded from. */
	question: FlightQuestion | null;
}>({ pending: null, question: null });

/** Whether the app is exempt from battery optimization (Android; null =
 *  unknown or not native). The Navigation tab's hint row reads it. */
export const battery = $state<{ ignoring: boolean | null }>({ ignoring: null });

/** The decision over the live trace (nav/flightStart.ts), at `nowMs`. The
 *  field lookups are the logbook's (a rollout cut short on a known field
 *  reads landed): with the airports not loaded there, the end reads slow
 *  and the pilot is asked, the safe side. */
export function liveFlightDecision(nowMs: number = Date.now()): FlightDecision {
	const points = nav.points;
	return flightDecision({
		points,
		motion: traceMotion(points),
		deps: summaryDeps(traceAltDatum()),
		origin: nav.origin,
		filed: traceFiled(),
		nowMs,
		// A trace a shared computer's sign-in found is the device's: no
		// session of another pilot resumes it or adds a flight to it, and a
		// new flight moves it aside, unfiled, rather than drop it.
		foreign: points.length > 0 && foundOuting(points[0].timeMs),
		setAside: foundTraceGoesAside(),
	});
}

/** What replacing the live trace would drop, or null when the flights
 *  library holds it: the discard confirm's reason for every path that
 *  replaces or closes it (a new flight, an opened file, a library load). */
export function liveDiscard(): DiscardReason | null {
	const points = nav.points;
	return discardReason(points, traceMotion(points), traceFiled(), foundTraceGoesAside());
}

/** The decision a tap would take now, for the surfaces that name it (the
 *  button's label, the Flight page's buttons and status line); null while
 *  recording or with nothing loaded. Reads nav.recording first, so the
 *  per-fix appends never re-run a reader while one runs, and the minute
 *  tick, so a reader lets go of the resume when the window closes, up to a
 *  minute late. */
export function flightTapDecision(): FlightDecision | null {
	if (nav.recording || nav.points.length === 0) {
		return null;
	}
	void notamState.tick;
	return liveFlightDecision();
}

/** What the flight button does on a tap, for its label: `resume` names the
 *  silent resume, so the tap that appends is never a surprise. */
export function flightButtonState(): 'fly' | 'resume' | 'stop' {
	if (nav.recording) {
		return 'stop';
	}
	return flightTapDecision()?.kind === 'resume' ? 'resume' : 'fly';
}

function ask(pending: 'resume' | 'discard', d: FlightDecision): void {
	flightAction.question = {
		ticket: archiveTicket(),
		end: d.end,
		lastFixMs: d.lastFixMs,
		discard: d.discard,
	};
	flightAction.pending = pending;
}

/** The one-tap flight gesture (the toolbar, the palette, the folded strip). */
export function startFlight(): void {
	if (nav.recording) {
		requestStop();
		return;
	}
	const d = liveFlightDecision();
	if (d.kind === 'resume') {
		goFlying(false);
	} else if (d.kind === 'ask') {
		ask('resume', d);
	} else {
		startNewFlight();
	}
}

/** A new flight: in silence when the library holds the loaded trace (or
 *  nothing is loaded), else behind the discard confirm. */
export function startNewFlight(): void {
	if (nav.recording) {
		return;
	}
	const d = liveFlightDecision();
	if (d.discard != null) {
		ask('discard', d);
		return;
	}
	goFlying(true);
}

/** Resume the loaded recording, or add to it after a landing (the Flight
 *  page's Resume flight and Add to this trace). Re-read at the tap: a
 *  trace that is no longer this device's recording inside the outing
 *  window takes the one-tap path, which never appends to it. */
export function resumeFlight(): void {
	if (nav.recording) {
		return;
	}
	const d = liveFlightDecision();
	if (nav.points.length === 0 || (d.kind === 'new' && !d.appendable)) {
		startFlight();
		return;
	}
	goFlying(false);
}

/** Stop the recording: behind the stop confirm while the flight is open
 *  (a takeoff and no landing since), at once on the ground, where nothing
 *  is cut short and a tap that meant otherwise resumes in one more. */
export function requestStop(): void {
	if (!nav.recording) {
		return;
	}
	if (flightOpen(traceMotion(nav.points))) {
		flightAction.question = null;
		flightAction.pending = 'stop';
		return;
	}
	stopRecording();
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
	// Full screen / immersive rides the recording (ui/flightScreen.ts):
	// from this gesture, never from an effect on nav.recording, and only
	// once the recording actually runs (an insecure context or a missing
	// geolocation refuses it, and a screen taken then would have no stop
	// to give it back).
	if (nav.recording) {
		enterFlightScreen(ui.isMobile);
		// A radar layer left on from planning is used in flight from this
		// tap: the once-per-device caution rides the same gesture (Toolbar
		// hosts it ahead of the battery offer below).
		noteRadarInFlight();
	}
	setStripHidden(false);
	ui.sidebarCollapsed = true;
	closePage();
	// The replay strip needs no word here: a recording owns the playhead,
	// so it stands down by itself and comes back at the stop, folded still
	// if the pilot folded it on this trace (state/replayStrip.svelte.ts).
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

/** Whether the live trace is still the one a question was asked about. A
 *  trace that changed under it (an import, a library load, a clear) is
 *  asked about anew rather than resumed or discarded on an old answer. */
function stillAsked(q: FlightQuestion | null): boolean {
	return q != null && ticketCurrent(q.ticket);
}

export function confirmPending(): void {
	// Null FIRST: goFlying may later set 'battery' through the async offer,
	// or 'location' at once, and the dialog-close write must not clobber
	// either (the NavigationTab onConfirm idiom).
	const p = flightAction.pending;
	const q = flightAction.question;
	flightAction.pending = null;
	flightAction.question = null;
	if (p === 'resume' || p === 'discard') {
		if (nav.recording) {
			return;
		}
		if (!stillAsked(q)) {
			startFlight();
			return;
		}
		goFlying(p === 'discard');
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

/** The resume question's other answer: a new flight, through the discard
 *  confirm when it would drop a trace the library does not hold. The host
 *  keeps its dialog across the chain and re-arms its settle clock on the
 *  new question. */
export function choosePendingAlt(): void {
	const p = flightAction.pending;
	const q = flightAction.question;
	flightAction.pending = null;
	flightAction.question = null;
	if (p !== 'resume' || nav.recording) {
		return;
	}
	if (!stillAsked(q)) {
		startFlight();
		return;
	}
	startNewFlight();
}

export function dismissPending(): void {
	flightAction.pending = null;
	flightAction.question = null;
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

/** Carries goFlying's argument across the disclosure, the way the resume
 *  and discard confirms carry their own. */
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
