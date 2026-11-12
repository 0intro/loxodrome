/* The flight gesture behind every entry point (state/flightAction.svelte.ts):
 * the toolbar button, the palette row, the folded strip's stop and the Flight
 * page's buttons all take ONE decision over the loaded trace
 * (nav/flightStart.ts), and its questions act only on the trace they were
 * asked about. Driven through the real recording state with the platform's
 * geolocation watch faked, so a start, a resume and a stop are the real ones.
 *
 * Fresh module graph per case: the trace, the question and the auto-stop
 * edges live in module state. The clock is pinned (Date only), since the
 * decision reads how long ago the trace stopped. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { TrackPoint } from '$lib/nav/trace';
import { memoryStorage } from './helpers/storage';

vi.mock('$lib/map/navLayer', () => ({ rearmFollow: () => {}, recenterNav: () => {} }));

// Each case imports a fresh module graph, which a loaded machine can take
// past the default five seconds to transform.
vi.setConfig({ testTimeout: 30_000 });

const NOW = Date.UTC(2026, 6, 21, 12, 0);
const MIN = 60_000;

let watches = 0;
let onFix: ((p: unknown) => void) | null = null;
/** The case's module graph, so a recording it leaves running is stopped
 *  (its 1 Hz clock is a real interval). */
let current: Mods | null = null;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	watches = 0;
	onFix = null;
	globalThis.indexedDB = new IDBFactory();
	vi.stubGlobal('localStorage', memoryStorage());
	vi.stubGlobal('window', { isSecureContext: true, addEventListener: () => {}, removeEventListener: () => {} });
	vi.stubGlobal('document', {
		addEventListener: () => {},
		removeEventListener: () => {},
		visibilityState: 'visible',
		documentElement: { lang: 'en' },
	});
	vi.stubGlobal('navigator', {
		geolocation: {
			watchPosition: (cb: (p: unknown) => void) => {
				watches++;
				onFix = cb;
				return watches;
			},
			clearWatch: () => {},
		},
	});
	vi.resetModules();
});

afterEach(() => {
	if (current?.nav.recording) {
		current.stopRecording();
	}
	current = null;
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/** A trace in phases of [seconds, knots], one fix a second, ending `agoMs`
 *  before NOW. */
function phased(phases: [number, number][], agoMs: number): TrackPoint[] {
	const total = phases.reduce((n, [d]) => n + d, 0);
	const base = NOW - agoMs - (total - 1) * 1000;
	const pts: TrackPoint[] = [];
	let lon = 2;
	let t = 0;
	for (const [dur, kt] of phases) {
		for (let s = 0; s < dur; s++) {
			pts.push({ lat: 48, lon, timeMs: base + t * 1000, altFt: 1500, speedKt: kt, trackDeg: 90, accuracyM: 5 });
			lon += kt / (3600 * 3600);
			t++;
		}
	}
	return pts;
}

const TAKEOFF: [number, number][] = [
	[20, 5],
	[8, 50],
	[150, 80],
];
/** Stopped at flying speed. */
const inAir = (agoMs: number): TrackPoint[] => phased(TAKEOFF, agoMs);
/** A committed landing: a minute and a half under the landing speed. */
const landed = (agoMs: number): TrackPoint[] => phased([...TAKEOFF, [90, 10]], agoMs);
/** Stopped twenty seconds into the rollout, no known field to confirm it. */
const rollout = (agoMs: number): TrackPoint[] => phased([...TAKEOFF, [20, 10]], agoMs);
/** A taxi that never took off. */
const taxi = (agoMs: number): TrackPoint[] => phased([[60, 8]], agoMs);

async function modules() {
	const n = await import('$lib/state/navRecording.svelte');
	const f = await import('$lib/state/flightAction.svelte');
	return { ...n, ...f };
}
type Mods = Awaited<ReturnType<typeof modules>>;

async function load(): Promise<Mods> {
	current = await modules();
	return current;
}

/** A shared computer's sign-in found this trace (sync/found.ts): its outing
 *  among the copy's keys, as takeFoundCopy writes it. */
function found(points: TrackPoint[]): void {
	const id = points[0].timeMs;
	localStorage.setItem(
		'loxodrome:sync-found',
		JSON.stringify({ v: 1, userId: 'u', keys: [`outings/${id}`], pilot: null, fuel: null, parked: false, planes: {}, trace: id, listed: true, rows: false }),
	);
}

/** This device's recording, stopped, and whether the library holds it. */
function stopped(m: Mods, points: TrackPoint[], filed: boolean): void {
	m.nav.points = points;
	m.nav.origin = 'recording';
	if (filed) {
		m.noteTraceArchived(m.archiveTicket(), { kind: 'archived' });
	}
}

const firstFix = (m: Mods): number | undefined => m.nav.points[0]?.timeMs;

describe('the one tap', () => {
	it('starts a fresh recording with nothing loaded', async () => {
		const m = await load();
		expect(m.flightButtonState()).toBe('fly');
		m.startFlight();
		expect(m.nav.recording).toBe(true);
		expect(m.nav.points).toHaveLength(0);
		expect(m.nav.origin).toBe('recording');
		expect(m.flightButtonState()).toBe('stop');
	});

	it('resumes a recording stopped in flight minutes ago, and says so first', async () => {
		const m = await load();
		const pts = inAir(5 * MIN);
		stopped(m, pts, true);
		expect(m.flightButtonState()).toBe('resume');
		m.startFlight();
		expect(m.flightAction.pending).toBeNull();
		expect(m.nav.recording).toBe(true);
		expect(firstFix(m)).toBe(pts[0].timeMs);
	});

	it('lets go of the resume when the silent window closes', async () => {
		const m = await load();
		stopped(m, inAir(29 * MIN), true);
		expect(m.flightButtonState()).toBe('resume');
		vi.setSystemTime(NOW + 2 * MIN);
		expect(m.flightButtonState()).toBe('fly');
	});

	it('asks past the window, and Resume flight keeps the trace', async () => {
		const m = await load();
		const pts = inAir(2 * 60 * MIN);
		stopped(m, pts, true);
		m.startFlight();
		expect(m.flightAction.pending).toBe('resume');
		expect(m.flightAction.question).toMatchObject({ end: 'airborne', lastFixMs: pts[pts.length - 1].timeMs });
		expect(m.nav.recording).toBe(false);
		m.confirmPending();
		expect(m.flightAction.pending).toBeNull();
		expect(m.nav.recording).toBe(true);
		expect(firstFix(m)).toBe(pts[0].timeMs);
	});

	it('answers New flight in silence over a trace the library holds', async () => {
		const m = await load();
		stopped(m, inAir(2 * 60 * MIN), true);
		m.startFlight();
		m.choosePendingAlt();
		expect(m.flightAction.pending).toBeNull();
		expect(m.nav.recording).toBe(true);
		expect(m.nav.points).toHaveLength(0);
	});

	it('asks about a trace that never took off, and chains New flight into the discard', async () => {
		const m = await load();
		const pts = taxi(3 * MIN);
		stopped(m, pts, false);
		m.startFlight();
		expect(m.flightAction.pending).toBe('resume');
		expect(m.flightAction.question?.end).toBe('ground');
		m.choosePendingAlt();
		expect(m.flightAction.pending).toBe('discard');
		expect(m.flightAction.question?.discard).toBe('noTakeoff');
		expect(firstFix(m)).toBe(pts[0].timeMs);
		m.confirmPending();
		expect(m.nav.recording).toBe(true);
		expect(m.nav.points).toHaveLength(0);
	});

	it('asks about a slow end no known field confirms', async () => {
		const m = await load();
		stopped(m, rollout(3 * MIN), true);
		m.startFlight();
		expect(m.flightAction.question?.end).toBe('slow');
	});

	it('starts a new flight after a landing, in silence when filed', async () => {
		const m = await load();
		stopped(m, landed(20 * MIN), true);
		expect(m.flightButtonState()).toBe('fly');
		m.startFlight();
		expect(m.flightAction.pending).toBeNull();
		expect(m.nav.recording).toBe(true);
		expect(m.nav.points).toHaveLength(0);
	});

	it('asks before a new flight drops a landed flight the library does not hold', async () => {
		const m = await load();
		const pts = landed(20 * MIN);
		stopped(m, pts, false);
		m.startFlight();
		expect(m.flightAction.pending).toBe('discard');
		expect(m.flightAction.question?.discard).toBe('unsaved');
		m.dismissPending();
		expect(m.flightAction.pending).toBeNull();
		expect(m.nav.recording).toBe(false);
		expect(firstFix(m)).toBe(pts[0].timeMs);
	});

	it('never resumes an imported trace, however it ended', async () => {
		const m = await load();
		m.importTrace(inAir(5 * MIN), 'msl');
		m.noteTraceArchived(m.archiveTicket(), { kind: 'archived' });
		expect(m.flightButtonState()).toBe('fly');
		m.startFlight();
		expect(m.nav.recording).toBe(true);
		expect(m.nav.points).toHaveLength(0);
	});
});

describe('the Flight page intents', () => {
	it('names the decision a tap would take, and nothing while recording', async () => {
		const m = await load();
		expect(m.flightTapDecision()).toBeNull();
		const pts = landed(20 * MIN);
		stopped(m, pts, true);
		expect(m.flightTapDecision()).toMatchObject({ kind: 'new', end: 'landed', appendable: true, discard: null });
		expect(m.flightTapDecision()?.landedMs).toBe(pts[20 + 8 + 150].timeMs);
		m.resumeFlight();
		expect(m.flightTapDecision()).toBeNull();
	});

	it('adds to a landed recording when asked, and only to one', async () => {
		const m = await load();
		const pts = landed(20 * MIN);
		stopped(m, pts, true);
		m.resumeFlight();
		expect(m.nav.recording).toBe(true);
		expect(firstFix(m)).toBe(pts[0].timeMs);
	});

	it('takes the one-tap path for a trace that is not this device recording', async () => {
		const m = await load();
		m.restoreOuting(landed(20 * MIN), 'msl');
		m.resumeFlight();
		expect(m.nav.recording).toBe(true);
		expect(m.nav.points).toHaveLength(0);
	});

	it('never extends a trace a shared sign-in found, the one tap starting fresh', async () => {
		const m = await load();
		const pts = landed(20 * MIN);
		stopped(m, pts, true);
		// The club tablet's own recording, found stopped by this pilot's
		// sign-in (sync/found.ts).
		found(pts);
		expect(m.flightTapDecision()).toMatchObject({ kind: 'new', end: 'landed', appendable: false });
		m.resumeFlight();
		expect(m.nav.recording).toBe(true);
		expect(m.nav.points).toHaveLength(0);
		// The library holds it: nothing to move aside.
		expect(localStorage.getItem('loxodrome:nav-trace-parked')).toBeNull();
	});

	it("reads a found flight as the device's by its outing, the copy's live trace or not", async () => {
		const m = await load();
		const pts = landed(20 * MIN);
		stopped(m, pts, true);
		// Found in the outbox at the sign-in, adopted back into the slot since.
		localStorage.setItem(
			'loxodrome:sync-found',
			JSON.stringify({ v: 1, userId: 'u', keys: [`outings/${pts[0].timeMs}`], pilot: null, fuel: null, parked: false, planes: {}, trace: null, listed: true, rows: false }),
		);
		expect(m.flightTapDecision()).toMatchObject({ kind: 'new', appendable: false });
	});

	it('moves a found flight the library does not hold into the outbox rather than drop it', async () => {
		const m = await load();
		const pts = landed(20 * MIN);
		stopped(m, pts, false);
		found(pts);
		// Nothing is lost, so nothing is asked.
		expect(m.liveDiscard()).toBeNull();
		m.startNewFlight();
		expect(m.flightAction.pending).toBeNull();
		expect(m.nav.recording).toBe(true);
		expect(m.nav.points).toHaveLength(0);
		// The device's flight waits in the outbox for the next boot to file.
		const parked = JSON.parse(localStorage.getItem('loxodrome:nav-trace-parked') ?? 'null') as {
			points: TrackPoint[];
		} | null;
		expect(parked?.points[0].timeMs).toBe(pts[0].timeMs);
	});

	it('asks to discard a found flight as before when the outbox is taken', async () => {
		const m = await load();
		const pts = landed(20 * MIN);
		stopped(m, pts, false);
		found(pts);
		localStorage.setItem('loxodrome:nav-trace-parked', JSON.stringify({ v: 1, points: landed(9 * 60 * MIN) }));
		expect(m.liveDiscard()).toBe('unsaved');
		m.startNewFlight();
		expect(m.flightAction.pending).toBe('discard');
	});

	it('moves a found flight aside before an import or a replay replaces it', async () => {
		const outbox = (): number | null =>
			(JSON.parse(localStorage.getItem('loxodrome:nav-trace-parked') ?? 'null') as { points: TrackPoint[] } | null)
				?.points[0].timeMs ?? null;
		const m = await load();
		const pts = landed(20 * MIN);
		stopped(m, pts, false);
		found(pts);
		m.importTrace(landed(3 * 60 * MIN), 'msl');
		expect(outbox()).toBe(pts[0].timeMs);
		localStorage.removeItem('loxodrome:nav-trace-parked');
		stopped(m, pts, false);
		m.restoreOuting(landed(5 * 60 * MIN), 'msl');
		expect(outbox()).toBe(pts[0].timeMs);
	});

	it('drops, never moves aside, a found flight whose row was deleted', async () => {
		const m = await load();
		const pts = landed(20 * MIN);
		stopped(m, pts, false);
		found(pts);
		m.noteOutingRemoved(pts[0].timeMs);
		expect(m.nav.points).toHaveLength(0);
		expect(localStorage.getItem('loxodrome:nav-trace-parked')).toBeNull();
	});

	it('knows a flight of its own the library never took, which a sign-out would erase', async () => {
		const m = await load();
		const pts = landed(20 * MIN);
		stopped(m, pts, false);
		expect(m.unfiledFlight()).toBe(true);
		m.noteTraceArchived(m.archiveTicket(), { kind: 'archived' });
		expect(m.unfiledFlight()).toBe(false);
		// Not a flight, an import (its file is elsewhere), or the device's own;
		// each a trace of its own, the answer above being about that one.
		stopped(m, taxi(20 * MIN), false);
		expect(m.unfiledFlight()).toBe(false);
		const imported = landed(25 * MIN);
		stopped(m, imported, false);
		expect(m.unfiledFlight()).toBe(true);
		m.nav.origin = 'import';
		expect(m.unfiledFlight()).toBe(false);
		const device = landed(30 * MIN);
		stopped(m, device, false);
		expect(m.unfiledFlight()).toBe(true);
		found(device);
		expect(m.unfiledFlight()).toBe(false);
		// A flight waiting in the outbox counts, the device's own or a stub not.
		m.nav.points = [];
		localStorage.removeItem('loxodrome:sync-found');
		const parked = landed(8 * 60 * MIN);
		localStorage.setItem('loxodrome:nav-trace-parked', JSON.stringify({ v: 1, points: parked }));
		expect(m.unfiledFlight()).toBe(true);
		found(parked);
		expect(m.unfiledFlight()).toBe(false);
		localStorage.removeItem('loxodrome:sync-found');
		localStorage.setItem('loxodrome:nav-trace-parked', JSON.stringify({ v: 1, points: parked.slice(0, 1) }));
		expect(m.unfiledFlight()).toBe(false);
	});

	it('moves nothing that is not a flight, nor a trace the sign-in did not find', async () => {
		const m = await load();
		const pts = taxi(20 * MIN);
		stopped(m, pts, false);
		found(pts);
		expect(m.liveDiscard()).toBe('noTakeoff');
		expect(m.foundTraceGoesAside()).toBe(false);
		const own = landed(20 * MIN);
		stopped(m, own, false);
		found(pts);
		expect(m.liveDiscard()).toBe('unsaved');
	});

	it('starts a new flight behind the discard confirm only when something is lost', async () => {
		const m = await load();
		stopped(m, inAir(5 * MIN), false);
		m.startNewFlight();
		expect(m.flightAction.pending).toBe('discard');
		m.dismissPending();
		m.noteTraceArchived(m.archiveTicket(), { kind: 'archived' });
		m.startNewFlight();
		expect(m.flightAction.pending).toBeNull();
		expect(m.nav.points).toHaveLength(0);
	});
});

describe('the stop', () => {
	async function recordingOver(points: TrackPoint[]): Promise<Mods> {
		const m = await load();
		m.startFlight();
		expect(m.nav.recording).toBe(true);
		m.nav.points = points;
		return m;
	}

	it('asks while the flight is open', async () => {
		const m = await recordingOver(inAir(0));
		m.startFlight();
		expect(m.flightAction.pending).toBe('stop');
		expect(m.nav.recording).toBe(true);
		m.confirmPending();
		expect(m.nav.recording).toBe(false);
	});

	it('stops at once before any takeoff', async () => {
		const m = await recordingOver(taxi(0));
		m.requestStop();
		expect(m.flightAction.pending).toBeNull();
		expect(m.nav.recording).toBe(false);
	});

	it('stops at once after a landing', async () => {
		const m = await recordingOver(landed(0));
		m.requestStop();
		expect(m.flightAction.pending).toBeNull();
		expect(m.nav.recording).toBe(false);
	});
});

describe('a question and the trace it was asked about', () => {
	it('is asked anew when the trace changed under it', async () => {
		const m = await load();
		stopped(m, inAir(2 * 60 * MIN), true);
		m.startFlight();
		expect(m.flightAction.pending).toBe('resume');
		// A file opened meanwhile: Resume flight must not append to IT.
		m.importTrace(taxi(10 * MIN), 'msl');
		m.confirmPending();
		expect(m.nav.recording).toBe(false);
		expect(m.flightAction.pending).toBe('discard');
		expect(m.flightAction.question?.discard).toBe('noTakeoff');
	});

	it('does nothing once a recording runs under it', async () => {
		const m = await load();
		stopped(m, inAir(2 * 60 * MIN), true);
		m.startFlight();
		// The shell's boot reconcile resumed its own recording meanwhile.
		m.nav.recording = true;
		m.confirmPending();
		expect(watches).toBe(0);
		expect(m.flightAction.pending).toBeNull();
		m.nav.recording = false;
	});
});

describe('the automatic stop', () => {
	it('does not end a recording resumed onto a rollout it stopped in', async () => {
		const m = await load();
		const auto = await import('$lib/state/autoStop.svelte');
		const { traceMotion } = await import('$lib/state/navMotion');
		stopped(m, rollout(60 * MIN), true);
		m.resumeFlight();
		expect(m.nav.recording).toBe(true);
		auto.reconcileAutoStop();
		const last = m.nav.points[m.nav.points.length - 1];
		onFix?.({
			coords: { latitude: last.lat, longitude: last.lon, altitude: null, altitudeAccuracy: null, accuracy: 5, speed: 0, heading: null },
			timestamp: NOW + 1000,
		});
		// The fix commits the landing the trace stopped in, an hour past its
		// grace: without the suppression, this reconcile stops the recording.
		expect(traceMotion(m.nav.points).landingMs).not.toBeNull();
		auto.reconcileAutoStop();
		expect(m.nav.recording).toBe(true);
		expect(auto.autoStop.pending).toBeNull();
	});
});
