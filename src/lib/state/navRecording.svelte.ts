/* Live GPS navigation recording + replay state.
 *
 * Reactivity contract (docs/i18n.md-style note): the geolocation watch callback
 * and the tab's play-loop interval write `nav.*` from OUTSIDE any $effect; the
 * map layer effects only READ nav and call Leaflet imperatively. One active
 * trace serves both live recording (the tip) and replay (the playhead). The
 * trace is auto-saved to localStorage (throttled) purely for crash recovery;
 * archiving is done through GPX, not storage.
 *
 * On ANDROID the GPS source is the native recorder instead of watchPosition
 * (docs/android.md): a location-type foreground service that keeps fixes
 * flowing with the app backgrounded or closed, journals each one, and emits
 * it live; the native section below folds both paths into the same ingest
 * gate, and the boot reconcile resumes a recording the service kept alive. */

import { readItem, writeItem, writeJson, removeItem } from './persist';
import { t } from './i18n.svelte';
import { equirectangularDistanceM } from '$lib/notam/geometry';
import { isNativeApp } from '$lib/native/platform';
import {
	startNativeRecorder,
	stopNativeRecorder,
	drainNativeAfter,
	getNativeRecorderState,
	clearNativeJournal,
	watchNativeFixes,
	watchNativeStopped,
} from '$lib/native/navRecorder';
import { toTrackPoint, takeNewer } from '$lib/nav/nativeFix';
import { positionQualityAt, type PositionQuality } from '$lib/nav/positionQuality';
import { mslAltFt, resolveAltDatum, type AltDatum } from '$lib/nav/altitudeDatum';
import type { TraceSource } from './flightsDb';
import { geoidHeightFt } from '$lib/nav/geoid';
import { platformAltDatum } from '$lib/ui/platform';
import { acquireWakeLock, releaseWakeLock } from '$lib/ui/wakeLock';
import { display } from './display.svelte';
import {
	positionAt,
	fixOf,
	deriveMotion,
	downsample,
	hasAbsoluteTime,
	traceStartMs,
	traceEndMs,
	MS_PER_KT,
	type TrackPoint,
	type Fix,
} from '$lib/nav/trace';
import { traceMotion } from './navMotion';

const KEY = 'loxodrome:nav-trace';
/** The parked-flight outbox: a finished flight the boot holds back moves to
 *  its OWN key the moment it is parked, so a new recording's clearTrace and
 *  flushes on the live key can never touch the only copy of a flight whose
 *  flights row is not confirmed yet (the double-failure the shared slot
 *  allowed: archive refused + recording started in the same seconds).
 *  Written only by the park move in restore(); removed by dropPendingTrace
 *  once the row is confirmed, or by a successful adopt-back. Listed in
 *  reset.ts's briefing group. */
const PARKED_KEY = 'loxodrome:nav-trace-parked';

/** A trace whose last fix is younger than this is the SAME outing: the
 *  flight button continues it silently rather than starting fresh, and the
 *  boot keeps it on the map for the same reason. One definition, here
 *  rather than in state/flightAction (which imports this module, never the
 *  other way round), so the two answers cannot drift. */
export const OUTING_MS = 6 * 60 * 60 * 1000;

/** Metres in one foot (GeolocationCoordinates.altitude is metres). */
const M_PER_FT = 0.3048;

/** Drop fixes coarser than this once a track is going (metres). */
const MAX_ACCURACY_M = 100;
/** Treat a fix that moved less than this AND arrived within MIN_DT_MS as
 *  stationary jitter and skip it (keeps a parked aircraft from bloating). */
const MIN_MOVE_M = 3;
const MIN_DT_MS = 2000;
/** Defensive in-memory cap (drop-oldest); far above any real flight. */
const MAX_POINTS = 200_000;
/** Crash-recovery write cadence and the decimated size that is persisted. */
const PERSIST_MS = 8000;
const PERSIST_MAX_POINTS = 20_000;

export type IconKind = 'plane' | 'helicopter' | 'glider';
export type NavError = 'denied' | 'unavailable' | 'timeout' | 'insecure' | null;

export const nav = $state<{
	/** The ONE active trace; serves live recording AND replay. */
	points: TrackPoint[];
	recording: boolean;
	iconKind: IconKind;
	showTrace: boolean;
	follow: boolean;
	/** Draw the live dead-reckoning trajectory vector (2/3/5/10 min ahead). */
	vector: boolean;
	/** Draw the current / next airspace-to-contact clones on the map
	 *  (map/navContactLayer.ts). The live nav log itself needs no switch:
	 *  it is on for any route with two waypoints (state/navLive.svelte.ts,
	 *  docs/nav-live.md), and without a trace it simply has nothing to
	 *  stamp. */
	contactMap: boolean;
	/** Latest live sample: drives the readout and the live marker. */
	lastFix: TrackPoint | null;
	/** Wall clock, refreshed once a second WHILE RECORDING only. The position
	 *  quality turns on how old the last fix is, and nothing else ticks when
	 *  the fixes stop arriving, which is exactly the case it has to catch. */
	nowMs: number;
	/** Fixes rejected (too coarse) since the last accepted one: a stalled
	 *  trace with a working sensor has to say so rather than just stop. */
	rejected: number;
	/** The datum the loaded trace's altitudes are on. A GPX <ele> is MSL by
	 *  convention, so an imported file must not be corrected a second time;
	 *  a live recording carries whatever the device reports. Null on an empty
	 *  trace, where the live answer applies (nav/altitudeDatum.ts). */
	traceDatum: AltDatum | null;
	/** Replay instant, ms UTC (mirrors windAloft.validTimeMs). */
	playheadMs: number;
	playing: boolean;
	/** Replay playback acceleration (a realtime multiple). */
	playbackSpeed: number;
	error: NavError;
	/** When the NATIVE recorder's safety valve stopped a recording with the
	 *  web app gone (docs/android.md); the auto-stop reconcile consumes it
	 *  into its own note, so the pilot learns of the stop on return. */
	nativeAutoStopMs: number | null;
	/** Whether the loaded trace still has the file it was imported from, so
	 *  the export surfaces can say what they will actually write. The FLAG is
	 *  reactive and the file itself is not (see traceSource below): a label
	 *  needs to know that there is one, never what is in it. */
	traceHasSource: boolean;
}>({
	points: [],
	recording: false,
	iconKind: 'plane',
	showTrace: true,
	follow: true,
	vector: true,
	contactMap: true,
	lastFix: null,
	nowMs: 0,
	rejected: 0,
	traceDatum: null,
	playheadMs: 0,
	playing: false,
	playbackSpeed: 4,
	error: null,
	nativeAutoStopMs: null,
	traceHasSource: false,
});

// Non-reactive module state (browser handles, timers).
let watchId: number | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let lifecycleBound = false;
let clockTimer: ReturnType<typeof setInterval> | null = null;
/** Whether the NATIVE recorder owns the GPS for the current recording
 *  (docs/android.md); false on the web and on an old shell's fallback. */
let nativeMode = false;
let nativeListenersBound = false;
/** Bumped whenever the trace changes IDENTITY (clear, import): an async
 *  native drain or finalize captured under an older generation must not
 *  touch the new trace or its journal. */
let traceGeneration = 0;
/** The PRISTINE file the live trace was imported from, when the points still
 *  ARE that file's own (docs/trace-files.md). Three-state, matching
 *  putOuting's own: a source, `null` for "knowingly not a file's any more"
 *  (a recording, an extend, the MAX_POINTS splice), `undefined` for "no
 *  opinion" so the archive leaves a stored source alone. Deliberately a
 *  plain module let rather than a `nav` field: nothing renders it, and a
 *  megabyte of text in reactive state would be read by every effect that
 *  touches the trace. */
let traceSource: TraceSource | null | undefined = undefined;

/** The ONE writer, so the reactive flag beside it cannot drift from it. */
function setTraceSource(v: TraceSource | null | undefined): void {
	traceSource = v;
	nav.traceHasSource = v != null;
}

/** What the live trace's archive should do with its stored source. Not
 *  reactive on purpose; read `nav.traceHasSource` to RENDER anything. */
export function currentTraceSource(): TraceSource | null | undefined {
	return traceSource;
}

// --- Persistence (throttled crash recovery) --------------------------------

function schedulePersist(): void {
	if (persistTimer != null) {
		return;
	}
	persistTimer = setTimeout(flushPersist, PERSIST_MS);
}

function flushPersist(): void {
	if (persistTimer != null) {
		clearTimeout(persistTimer);
		persistTimer = null;
	}
	const snap = $state.snapshot(nav.points);
	writeJson(KEY, {
		v: 1,
		iconKind: nav.iconKind,
		// Absent on a trace stored before the datum was tracked, which reads
		// back as unknown and so takes the live answer: right for a recording
		// made on this device, which is what crash recovery restores.
		altDatum: nav.traceDatum,
		// Whether the app went away MID-RECORDING. Written every 8 s while
		// recording and once at the stop, which runs after nav.recording is
		// already false, so a crash leaves true and a clean stop leaves
		// false with no bookkeeping of its own. The boot reads it to decide
		// whether the trace is still the flight you are on.
		recording: nav.recording,
		points: downsample(snap, PERSIST_MAX_POINTS),
	});
}

/** A restored trace that is HISTORY, not the flight you are on: parked
 *  here instead of adopted, for the flights library to file and then
 *  release (state/flightLibrary.svelte.ts drives it; this module imports
 *  no consumer, the standing-host inversion). Null in every other case,
 *  including a plain crash-recovery trace, which is adopted as before. */
let pendingTrace: { points: TrackPoint[]; datum: AltDatum } | null = null;

/** The trace held back at boot, if any. Its datum is already RESOLVED (a
 *  doc from before the datum was tracked reads as the live answer, right
 *  for a recording made on this device), so the archive needs nothing
 *  else from here. */
export function pendingRestoredTrace(): { points: TrackPoint[]; datum: AltDatum } | null {
	return pendingTrace;
}

/** Put the parked trace into the live slot after all: the archive could
 *  not confirm a copy, so this side keeps the only one there is. Refused
 *  while the slot is busy (a recording, an import), and safely: the OUTBOX
 *  KEY stays, so the next boot re-parks and re-files what this one could
 *  not. */
export function adoptPendingTrace(): void {
	const held = pendingTrace;
	pendingTrace = null;
	if (!held || nav.recording || nav.points.length > 0) {
		return;
	}
	nav.points = held.points;
	nav.playheadMs = held.points[held.points.length - 1].timeMs;
	nav.traceDatum = held.datum;
	flushPersist();
	// The copy moved back to the live key; the outbox comes down only once
	// that write is CONFIRMED. writeJson swallows quota failures and this
	// instant briefly holds both docs, which is exactly when quota can
	// refuse; presence is confirmation enough, since the park move deleted
	// the live key.
	if (readItem(KEY) !== null) {
		removeItem(PARKED_KEY);
	}
}

/** Let the parked trace go: it is filed in the flights library, whose row
 *  loads it back on demand (restoreOuting). The outbox has done its job;
 *  the live key is not this function's to touch, it was emptied by the
 *  park move and may belong to a new recording's flushes by now. */
export function dropPendingTrace(): void {
	pendingTrace = null;
	removeItem(PARKED_KEY);
}

/** Tolerant reader of a persisted trace doc; the crash copy and the parked
 *  outbox share the shape, so both restores below share this. Points come
 *  back sorted; datum / icon only when well-typed. */
function parseTraceDoc(doc: unknown): {
	pts: TrackPoint[];
	datum: AltDatum | null;
	iconKind: 'plane' | 'helicopter' | 'glider' | null;
	wasRecording: boolean;
} | null {
	if (!doc || typeof doc !== 'object') {
		return null;
	}
	const d = doc as Record<string, unknown>;
	if (d.v !== 1 || !Array.isArray(d.points)) {
		return null;
	}
	const pts: TrackPoint[] = [];
	for (const raw of d.points) {
		if (!raw || typeof raw !== 'object') {
			continue;
		}
		const r = raw as Record<string, unknown>;
		const { lat, lon, timeMs } = r;
		if (
			typeof lat !== 'number' ||
			typeof lon !== 'number' ||
			typeof timeMs !== 'number' ||
			!Number.isFinite(lat) ||
			!Number.isFinite(lon) ||
			!Number.isFinite(timeMs)
		) {
			continue;
		}
		pts.push({
			lat,
			lon,
			timeMs,
			altFt: typeof r.altFt === 'number' ? r.altFt : null,
			speedKt: typeof r.speedKt === 'number' ? r.speedKt : null,
			trackDeg: typeof r.trackDeg === 'number' ? r.trackDeg : null,
			accuracyM: typeof r.accuracyM === 'number' ? r.accuracyM : null,
		});
	}
	pts.sort((a, b) => a.timeMs - b.timeMs);
	return {
		pts,
		datum: d.altDatum === 'ellipsoid' || d.altDatum === 'msl' ? d.altDatum : null,
		iconKind:
			d.iconKind === 'plane' || d.iconKind === 'helicopter' || d.iconKind === 'glider'
				? d.iconKind
				: null,
		wasRecording: d.recording === true,
	};
}

function restore(): void {
	// The parked OUTBOX first: a finished flight a previous session's boot
	// held back but whose flights row was never confirmed. Only the park
	// move below ever writes this key and it already judged isHistory, so
	// the doc is taken at its word; one that no longer parses or lost its
	// points is REMOVED (the depositRescue "unreadable" idiom), because the
	// boot archive dereferences points[0] and a doc it can never file would
	// throw there every session. Without an IndexedDB nothing could file it,
	// so it is left standing for a boot that has one.
	const parkedRaw = readItem(PARKED_KEY);
	if (parkedRaw !== null) {
		let parked: ReturnType<typeof parseTraceDoc>;
		try {
			parked = parseTraceDoc(JSON.parse(parkedRaw));
		} catch {
			parked = null;
		}
		if (parked === null || parked.pts.length === 0) {
			removeItem(PARKED_KEY);
		} else if (typeof indexedDB !== 'undefined') {
			pendingTrace = { points: parked.pts, datum: parked.datum ?? liveAltDatum() };
			if (parked.iconKind !== null) {
				// Parking MOVES the live key, so on a boot whose only doc is
				// the outbox the icon pref rides it; the live doc below is
				// newer and overrides.
				nav.iconKind = parked.iconKind;
			}
		}
	}
	const raw = readItem(KEY);
	if (raw === null) {
		return;
	}
	let live: ReturnType<typeof parseTraceDoc>;
	try {
		live = parseTraceDoc(JSON.parse(raw));
	} catch {
		live = null;
	}
	if (live === null) {
		return;
	}
	if (live.iconKind !== null) {
		nav.iconKind = live.iconKind;
	}
	if (live.pts.length === 0) {
		return;
	}
	if (pendingTrace === null && isHistory(live.pts, live.wasRecording)) {
		// Park it. The map must not redraw a flight that is over: it is a row
		// in the flights library (or about to be) and reads as something
		// live. The doc MOVES to the outbox, raw bytes, and the live key is
		// deleted only once the read-back confirms the write landed: writeItem
		// is best-effort and this instant briefly holds two full docs, the
		// one moment quota can refuse. A refused move falls through to
		// adopting live, the pre-outbox behavior, so nothing is lost either
		// way. Released only once the flights row is CONFIRMED
		// (flightLibrary), never on a promise. An outbox already occupied
		// (the collision above) also adopts live: at most one flight is ever
		// sheltered, none silently dropped.
		writeItem(PARKED_KEY, raw);
		if (readItem(PARKED_KEY) === raw) {
			removeItem(KEY);
			pendingTrace = { points: live.pts, datum: live.datum ?? liveAltDatum() };
			return;
		}
	}
	nav.points = live.pts;
	nav.playheadMs = live.pts[live.pts.length - 1].timeMs;
	if (live.datum !== null) {
		nav.traceDatum = live.datum;
	}
}

/** Whether a restored trace is a finished flight rather than the one being
 *  flown. Every condition has to hold, and together they mirror the gates
 *  archiveOuting itself applies (noClock / noTakeoff / unavailable), so
 *  "the library will take this" is a well-founded expectation and not a
 *  hope: the app was NOT recording when it went away, the trace holds a
 *  committed takeoff (the same test the flight button uses to decide a
 *  fresh start is safe), it is on absolute time, its last fix is older
 *  than the outing window, and there is a store to file it in. */
function isHistory(points: TrackPoint[], wasRecording: boolean): boolean {
	if (wasRecording || typeof indexedDB === 'undefined' || !hasAbsoluteTime(points)) {
		return false;
	}
	const end = traceEndMs(points);
	if (end == null || Date.now() - end < OUTING_MS) {
		return false;
	}
	return traceMotion(points).takeoffMs != null;
}

// --- Page-lifecycle listeners (only while recording) -----------------------
// The screen wake lock rides the shared refcounted holder (ui/wakeLock.ts,
// tag 'recording'), which owns its own visibility re-acquire.

function onVisibility(): void {
	if (document.visibilityState === 'hidden') {
		flushPersist();
	} else if (nativeMode && nav.recording) {
		// Back to the foreground: the journal covers whatever the live events
		// missed while hidden (usually nothing, since the foreground service
		// keeps the whole process, WebView included, running).
		void drainIntoTrace(traceGeneration);
	}
}

function onPageHide(): void {
	flushPersist();
}

function bindLifecycle(): void {
	if (lifecycleBound || typeof document === 'undefined') {
		return;
	}
	document.addEventListener('visibilitychange', onVisibility);
	window.addEventListener('pagehide', onPageHide);
	lifecycleBound = true;
}

function unbindLifecycle(): void {
	if (!lifecycleBound || typeof document === 'undefined') {
		return;
	}
	document.removeEventListener('visibilitychange', onVisibility);
	window.removeEventListener('pagehide', onPageHide);
	lifecycleBound = false;
}

// --- Geolocation lifecycle -------------------------------------------------

function onFix(pos: GeolocationPosition): void {
	// A position callback means the sensor is working: clear a stale error even
	// if this fix is about to be filtered out.
	nav.error = null;
	const c = pos.coords;
	ingestFix({
		lat: c.latitude,
		lon: c.longitude,
		altFt: c.altitude == null ? null : c.altitude / M_PER_FT,
		timeMs: pos.timestamp,
		speedKt: c.speed == null ? null : c.speed / MS_PER_KT,
		trackDeg: c.heading != null && Number.isFinite(c.heading) ? c.heading : null,
		accuracyM: c.accuracy,
	});
}

/** Filter (accuracy + jitter), backfill missing motion, and append one fix.
 *  Shared by the geolocation callback and the dev flight simulator. */
function ingestFix(pt: TrackPoint): void {
	// The accuracy gate applies to the FIRST fix too. A recording seeded by a
	// cell-tower position anchors the projection fold's seed, the one decision
	// it is most sensitive to (docs/nav-live.md), so a bad seed is worse than
	// a late start.
	if (pt.accuracyM != null && pt.accuracyM > MAX_ACCURACY_M) {
		nav.rejected++;
		return;
	}
	// One trace, one datum: continuing a recording onto an imported track (a
	// GPX <ele> is MSL by convention) would otherwise mix two references in
	// one altitude column. The incoming fix is converted into the trace's own
	// datum here, the single append boundary, so everything downstream reads
	// one reference and the tag stays true.
	const target = nav.traceDatum;
	if (target != null && pt.altFt != null) {
		const live = liveAltDatum();
		if (live !== target) {
			pt.altFt =
				target === 'msl'
					? mslAltFt(pt.altFt, pt.lat, pt.lon, live)
					: pt.altFt + geoidHeightFt(pt.lat, pt.lon);
		}
	}
	const last = nav.points.length ? nav.points[nav.points.length - 1] : undefined;
	if (last) {
		const distM = equirectangularDistanceM(last.lat, last.lon, pt.lat, pt.lon);
		if (distM < MIN_MOVE_M && pt.timeMs - last.timeMs < MIN_DT_MS) {
			return;
		}
		if (pt.speedKt == null || pt.trackDeg == null) {
			const m = deriveMotion(last, pt);
			if (pt.speedKt == null) pt.speedKt = m.speedKt;
			if (pt.trackDeg == null) pt.trackDeg = m.trackDeg;
		}
	}
	nav.points.push(pt);
	if (nav.points.length > MAX_POINTS) {
		nav.points.splice(0, nav.points.length - MAX_POINTS);
		setTraceSource(null); // dropping fixes makes the source file a lie
	}
	nav.lastFix = pt;
	nav.playheadMs = pt.timeMs;
	// The quality turns on the fix's age, so the instant it is judged against
	// has to move with the fix as well as with the second tick; without this
	// the state would stay stale until the next tick.
	nav.nowMs = Date.now();
	nav.rejected = 0;
	schedulePersist();
}

function onGeoError(e: GeolocationPositionError): void {
	nav.error = e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable';
	if (e.code === 1) {
		// A denied permission won't recover without a fresh user gesture.
		stopRecording();
	}
}

/* The one-second clock behind the position quality. It runs ONLY while the
 * watch is up: a fix ageing out is the one live transition no other signal
 * announces (no fix arrives to trigger it), and outside a recording there is
 * nothing to age. */
function startClock(): void {
	nav.nowMs = Date.now();
	if (clockTimer == null) {
		clockTimer = setInterval(() => {
			nav.nowMs = Date.now();
		}, 1000);
	}
}

function stopClock(): void {
	if (clockTimer != null) {
		clearInterval(clockTimer);
		clockTimer = null;
	}
}

function startWebWatch(): void {
	if (watchId == null) {
		watchId = navigator.geolocation.watchPosition(onFix, onGeoError, {
			enableHighAccuracy: true,
			maximumAge: 0,
			timeout: 15000,
		});
	}
}

function beginWatch(fresh: boolean): boolean {
	if (typeof window === 'undefined' || !window.isSecureContext) {
		nav.error = 'insecure';
		return false;
	}
	if (!isNativeApp() && !('geolocation' in navigator)) {
		nav.error = 'unavailable';
		return false;
	}
	// A recording owns the playhead: a replay still running here (Continue
	// tapped mid-replay) would keep its timer racing ingestFix for
	// nav.playheadMs, one write per tick until the first fix.
	stopPlayback();
	nav.error = null;
	nav.recording = true;
	nav.rejected = 0;
	// A fresh trace takes the device's datum; continuing onto an imported one
	// keeps the tag it came with, and ingestFix converts into it.
	nav.traceDatum ??= liveAltDatum();
	startClock();
	if (isNativeApp()) {
		// The native recorder owns the GPS (docs/android.md): its foreground
		// service keeps fixes flowing with the app backgrounded, the screen
		// off or the task swiped away, which the WebView watch cannot.
		nativeMode = true;
		bindNativeListeners();
		void startNativeWatch(fresh, traceGeneration);
	} else {
		startWebWatch();
	}
	acquireWakeLock('recording');
	bindLifecycle();
	return true;
}

async function startNativeWatch(fresh: boolean, gen: number): Promise<void> {
	// The strings go straight to the OS notification, never into state; read
	// at start time so they carry the locale then in force.
	const res = await startNativeRecorder({
		title: t.navigation.bgNotifTitle,
		text: t.navigation.bgNotifText,
		stopLabel: t.navigation.stop,
		fresh,
	});
	if (gen !== traceGeneration || !nav.recording || !nativeMode) {
		return; // superseded by a stop, clear or import meanwhile
	}
	if (res === 'ok') {
		return;
	}
	if (res === 'denied') {
		// The onGeoError code-1 posture: a denied permission won't recover
		// without a fresh user gesture.
		nav.error = 'denied';
		stopRecording();
		return;
	}
	// An older shell without the plugin: record through the WebView as before.
	nativeMode = false;
	if (!('geolocation' in navigator)) {
		nav.error = 'unavailable';
		stopRecording();
		return;
	}
	startWebWatch();
}

/** Start a fresh recording (clears the current trace). */
export function startRecording(): void {
	clearTrace();
	beginWatch(true);
}

/** Resume recording, appending to the existing trace. */
export function continueRecording(): void {
	// Appending to an IMPORTED trace makes its source file describe only a
	// prefix of the outing, so the stored bytes have to go.
	setTraceSource(null);
	beginWatch(false);
}

/** Stop the watch, release the wake lock, and flush the trace to storage.
 *  Stays synchronous (auto-stop, reset and importTrace call it inline); the
 *  native finalize hangs off it fire-and-forget. */
export function stopRecording(): void {
	if (watchId != null) {
		navigator.geolocation.clearWatch(watchId);
		watchId = null;
	}
	const finalize = nativeMode;
	nativeMode = false;
	nav.recording = false;
	nav.rejected = 0;
	stopClock();
	releaseWakeLock('recording');
	unbindLifecycle();
	flushPersist();
	if (finalize) {
		// The outing settles at the END of the native finalize: the last
		// journalled fixes drain there, and an archive fired here would
		// miss the tail (docs/flights-library.md).
		void finalizeNativeStop(traceGeneration);
	} else {
		outingSettledHook?.('stop');
	}
}

/** WHY an outing settled. The library archives all of them alike, but only
 *  a RECORDING says anything about the flight plan in the workspace: an
 *  import is a trace that arrived as a file and has nothing to do with
 *  what happens to be planned on screen, and `refile` is the boot archive
 *  re-upserting a flight the library already holds (a crash copy inside
 *  the outing window), which says nothing about today's workspace either. */
export type OutingSettleReason = 'stop' | 'native-stop' | 'reconcile' | 'import' | 'boot' | 'refile';

/* The flights library's archive hook (state/flightLibrary.svelte.ts): the
 * library registers it at its module init (the Toolbar / FileOpenHost
 * standing-host inversion, so this module imports no consumer). Called at
 * the instants an outing SETTLES; the hook captures what it needs
 * synchronously before its own awaits. */
let outingSettledHook: ((reason: OutingSettleReason) => void) | null = null;

export function setOutingSettledHook(fn: (reason: OutingSettleReason) => void): void {
	outingSettledHook = fn;
}

/** Discard the active trace. */
export function clearTrace(): void {
	traceGeneration++;
	setTraceSource(null);
	stopPlayback();
	nav.points = [];
	nav.lastFix = null;
	nav.playheadMs = 0;
	nav.traceDatum = null;
	removeItem(KEY);
	if (isNativeApp()) {
		void clearNativeJournal();
	}
}

// --- The native recorder (Android; docs/android.md) ------------------------
// The foreground service journals every raw fix and emits it live; the
// JOURNAL is the source of truth, the events the low-latency path. Every
// native append runs through toTrackPoint + the monotonic take + ingestFix,
// so the trace's quality gate and datum handling are identical to the web
// watch. The journal is cleared ONLY here, after a successful drain: "not
// running + journal non-empty" then unambiguously means a native-side stop
// (notification action, safety valve, force-stop) this side has not seen.

function lastTraceMs(): number | null {
	return nav.points.length ? nav.points[nav.points.length - 1].timeMs : null;
}

function bindNativeListeners(): void {
	if (nativeListenersBound) {
		return;
	}
	nativeListenersBound = true;
	void watchNativeFixes((raw) => {
		if (!nav.recording || !nativeMode) {
			return;
		}
		const pt = toTrackPoint(raw);
		if (!pt) {
			return;
		}
		const tail = lastTraceMs();
		if (tail != null && pt.timeMs <= tail) {
			return; // already ingested through a drain
		}
		// A fix means the sensor works: clear a stale error even if the fix
		// is about to be filtered out (the onFix posture).
		nav.error = null;
		ingestFix(pt);
	});
	void watchNativeStopped((reason) => {
		if (reason === 'autostop') {
			nav.nativeAutoStopMs = Date.now();
		}
		if (nav.recording) {
			stopRecording();
		}
	});
}

/** Drain the journal's tail into the trace; the count of points appended.
 *  Bails without touching the trace when the generation moved under it. */
async function drainIntoTrace(gen: number): Promise<number> {
	const raws = await drainNativeAfter(lastTraceMs() ?? 0);
	if (gen !== traceGeneration || raws.length === 0) {
		return 0;
	}
	const mapped: TrackPoint[] = [];
	for (const raw of raws) {
		const p = toTrackPoint(raw);
		if (p) {
			mapped.push(p);
		}
	}
	const fresh = takeNewer(lastTraceMs(), mapped);
	for (const p of fresh) {
		ingestFix(p);
	}
	return fresh.length;
}

/* Stop the service FIRST so the journal freezes, then drain its tail into
 * the trace, then clear it: the clear happens only after a successful drain,
 * so a failure leaves the fixes recoverable by the next boot reconcile. The
 * generation guard covers a clearTrace / importTrace racing this: the trace
 * mutation and the journal clear are skipped (the new owner clears it), the
 * service stop stands. */
async function finalizeNativeStop(gen: number): Promise<void> {
	await stopNativeRecorder();
	const drained = await drainIntoTrace(gen);
	if (gen !== traceGeneration) {
		return;
	}
	await clearNativeJournal();
	if (drained > 0 && gen === traceGeneration) {
		flushPersist();
	}
	if (gen === traceGeneration) {
		// The outing has settled WITH its journal tail; now it can file.
		outingSettledHook?.('native-stop');
	}
}

/** Boot reconcile (called once from native/init.ts): the running service IS
 *  the persisted recording flag, and the journal holds whatever a dead
 *  WebView missed. Also ensures the plugin handle early, so reset's
 *  fire-and-forget calls dispatch off the cached module before its reload. */
export async function reconcileNativeRecording(): Promise<void> {
	if (!isNativeApp()) {
		return;
	}
	const st = await getNativeRecorderState();
	if (!st) {
		return; // an older shell without the plugin
	}
	const gen = traceGeneration;
	const drained = await drainIntoTrace(gen);
	if (gen !== traceGeneration) {
		return;
	}
	if (st.running) {
		// Resume the recording posture the interrupted session held.
		nav.error = null;
		nav.recording = true;
		nav.rejected = 0;
		nav.traceDatum ??= liveAltDatum();
		nativeMode = true;
		bindNativeListeners();
		startClock();
		acquireWakeLock('recording');
		bindLifecycle();
		// Close the gap between the bulk drain and the listeners arming; the
		// monotonic take drops the overlap.
		await drainIntoTrace(gen);
	} else {
		// No recording is running, so after the drain above the journal is
		// fully consumed however it ended: a native-side stop (notification
		// action, safety valve) as well as an outside kill that stamped no
		// reason but whose fixes the crash-recovery copy already carried (a
		// MIUI swipe kill, measured on the Redmi: drained can be 0 with a
		// non-empty journal). Clear unconditionally, or the leftovers would
		// linger and muddy "journal non-empty means an unreconciled stop".
		if (st.stoppedReason === 'autostop') {
			// Surface the safety valve's stop through the auto-stop note.
			nav.nativeAutoStopMs = st.stoppedAtMs ?? Date.now();
		}
		await clearNativeJournal();
		if (drained > 0 && gen === traceGeneration) {
			flushPersist();
		}
		if (gen === traceGeneration) {
			// A service-side stop this side never saw: the outing settles
			// here, journal tail included.
			outingSettledHook?.('reconcile');
		}
	}
}

// --- Replay + selectors ----------------------------------------------------

/** The interpolated pose at the replay playhead. */
export function positionAtPlayhead(): Fix | null {
	return positionAt(nav.points, nav.playheadMs);
}

/** The single pose the map aircraft reads: the live tip while recording, else
 *  the replay playhead. */
export function currentPose(): Fix | null {
	if (nav.recording) {
		return nav.lastFix ? fixOf(nav.lastFix) : null;
	}
	return positionAtPlayhead();
}

/** The datum the DEVICE is reporting on right now: the Display-tab choice,
 *  else the platform default (nav/altitudeDatum.ts). Reads reactive state. */
export function liveAltDatum(): AltDatum {
	return resolveAltDatum(display.gpsAltDatum, platformAltDatum());
}

/** The datum the LOADED TRACE's altitudes are on: an imported GPX carries its
 *  own (MSL), a live recording the device's. */
export function traceAltDatum(): AltDatum {
	return nav.traceDatum ?? liveAltDatum();
}

/** A pose's altitude referenced to mean sea level, so it can be read against
 *  a chart, an airspace limit or a field elevation. THE chokepoint: every
 *  altitude the navigation surfaces show goes through it. */
export function poseAltMslFt(fix: { lat: number; lon: number; altFt: number | null }): number | null {
	return mslAltFt(fix.altFt, fix.lat, fix.lon, traceAltDatum());
}

/** How much the pose above can be trusted: 'good' unless the live watch has
 *  gone quiet or is reporting coarse fixes. Always 'good' off a recording,
 *  where the pose is an interpolation of a recorded fact rather than a claim
 *  about now (nav/positionQuality.ts). Reads reactive state; call inside a
 *  $derived / $effect. */
export function positionQuality(): PositionQuality {
	return positionQualityAt({
		recording: nav.recording,
		lastFixMs: nav.lastFix?.timeMs ?? null,
		nowMs: nav.nowMs,
		accuracyM: nav.lastFix?.accuracyM ?? null,
		rejected: nav.rejected,
	});
}

export function setPlayhead(ms: number): void {
	nav.playheadMs = ms;
}

/* The replay loop lives here, not in the Navigation tab that shows the
 * transport: the sidebar unmounts a tab as soon as another is selected, and
 * with the trace profile docked beside the map the pilot browses other tabs
 * mid-replay. A module timer keeps playing through that. It reads the speed
 * every tick, so a speed change needs no re-arm. */
const TICK_MS = 100;
let playTimer: ReturnType<typeof setInterval> | null = null;
let lastTickMs = 0;

function stopPlayback(): void {
	if (playTimer !== null) {
		clearInterval(playTimer);
		playTimer = null;
	}
	nav.playing = false;
}

function startPlayback(): void {
	stopPlayback();
	lastTickMs = Date.now();
	nav.playing = true;
	playTimer = setInterval(() => {
		const end = traceEndMs(nav.points);
		if (end == null) {
			stopPlayback();
			return;
		}
		const now = Date.now();
		// Wall clock x the selected speed, so the replay is a realtime multiple.
		const next = nav.playheadMs + (now - lastTickMs) * nav.playbackSpeed;
		lastTickMs = now;
		if (next >= end) {
			nav.playheadMs = end;
			stopPlayback();
		} else {
			nav.playheadMs = next;
		}
	}, TICK_MS);
}

export function togglePlay(): void {
	if (nav.playing) {
		stopPlayback();
		return;
	}
	const start = traceStartMs(nav.points);
	const end = traceEndMs(nav.points);
	if (start == null || end == null || start >= end) {
		return;
	}
	if (nav.playheadMs < start || nav.playheadMs >= end) {
		nav.playheadMs = start;
	}
	startPlayback();
}

export function setIconKind(k: IconKind): void {
	nav.iconKind = k;
	flushPersist();
}

export function setShowTrace(on: boolean): void {
	nav.showTrace = on;
}

export function setFollow(on: boolean): void {
	nav.follow = on;
}

export function setVector(on: boolean): void {
	nav.vector = on;
}

export function setContactMap(on: boolean): void {
	nav.contactMap = on;
}

export function setPlaybackSpeed(mult: number): void {
	nav.playbackSpeed = mult;
}

/** Replace the active trace (an imported file). The playhead lands at the
 *  trace START: an imported file is a flight to fly through, so it opens at
 *  00:00 with an empty log and the aircraft on the first fix, and pressing
 *  play unfolds it. A recording finished in place keeps the end instead (the
 *  debrief posture), as does the crash-recovery reload.
 *
 *  `datum` is what the FILE's altitudes are measured from, which only the
 *  parser (and for an unstated IGC, the user) can say: GPX and KML state
 *  MSL by their own conventions, an IGC B record's GNSS column the WGS84
 *  ellipsoid (docs/trace-files.md). It is stated rather than defaulted
 *  because the difference is ~45 m over France. */
export function importTrace(
	points: TrackPoint[],
	datum: AltDatum,
	source?: TraceSource,
): void {
	if (nav.recording) {
		stopRecording();
	}
	// After the stop, so its native finalize (captured under the old
	// generation) can neither append stale live fixes onto the imported
	// track nor clear the journal this import now owns.
	traceGeneration++;
	stopPlayback();
	nav.points = points.slice().sort((a, b) => a.timeMs - b.timeMs);
	nav.lastFix = null;
	nav.playheadMs = traceStartMs(nav.points) ?? 0;
	// Before the settle hook below: archiveCurrentOuting reads traceAltDatum()
	// and currentTraceSource() synchronously to its first await, and the
	// outing freezes what it reads. `null` rather than undefined when the
	// caller has no file: a drawn or synthesised import must not inherit the
	// source of whatever outing shared its id.
	nav.traceDatum = datum;
	setTraceSource(source ?? null);
	flushPersist();
	if (isNativeApp()) {
		void clearNativeJournal();
	}
	// An import is an outing too: file it into the flights library (whose
	// takeoff gate skips fragments and taxi-only files by itself; a
	// rehearsal or third-party file that does land a row is one Delete
	// away, docs/flights-library.md).
	outingSettledHook?.('import');
}

/** Load an ARCHIVED outing back into the live slot (the flights library's
 *  replay entry): the importTrace body with the outing's own stored datum
 *  and the playhead at the trace END, the debrief posture (a filed flight
 *  is a record to scrub, not a flight to fly through). No settle hook: it
 *  is already filed, and the idempotent upsert makes any re-file free. */
export function restoreOuting(
	points: TrackPoint[],
	datum: AltDatum,
	source?: TraceSource,
): void {
	if (nav.recording) {
		stopRecording();
	}
	traceGeneration++;
	// The outing's OWN file when the caller read one, so the Navigation tab's
	// export writes the same document the flights row does; undefined, never
	// null, when it has none to offer, because this outing may still have a
	// source filed and loading it for replay must not be what deletes it.
	setTraceSource(source);
	stopPlayback();
	nav.points = points.slice().sort((a, b) => a.timeMs - b.timeMs);
	nav.lastFix = null;
	nav.playheadMs = traceEndMs(nav.points) ?? 0;
	nav.traceDatum = datum;
	flushPersist();
	if (isNativeApp()) {
		void clearNativeJournal();
	}
}

export function hasTrace(): boolean {
	return nav.points.length > 0;
}

restore();
