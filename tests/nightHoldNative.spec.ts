/* The automatic night over an INTERRUPTED flight on Android
 * (state/navRecording.svelte.ts nav.interrupted, state/nightDim.svelte.ts):
 * MIUI kills the WebView and the recorder service together mid-night, the
 * app restarts, the boot reconcile finds the service gone and drains the
 * journal's tail into the trace. The pilot has not stopped anything, so the
 * flight stays interrupted, and the crash-recovery copy must keep saying so:
 * a flush of that tail used to write recording:false, and a SECOND restart
 * before the pilot tapped Fly forgot the flight and flashed the day theme. A
 * stop the pilot or the safety valve made ends the flight instead. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage, type MemoryStorage } from './helpers/storage';

const NIGHT_MS = Date.parse('2026-06-21T23:30:00Z');
const PARIS = { lat: 48.85, lon: 2.35 };

const recorder = vi.hoisted(() => ({
	drained: [] as unknown[],
	/** The drain fails (an unreadable journal, a bridge error). */
	drainFails: false,
	running: false,
	stoppedReason: null as 'user' | 'autostop' | null,
	fix: null as ((raw: unknown) => void) | null,
	provider: null as ((enabled: boolean) => void) | null,
}));

vi.mock('$lib/native/platform', () => ({ isNativeApp: () => true }));
vi.mock('$lib/native/navRecorder', () => ({
	startNativeRecorder: vi.fn(() => Promise.resolve('ok')),
	stopNativeRecorder: vi.fn(() => Promise.resolve()),
	drainNativeAfter: vi.fn(() => Promise.resolve(recorder.drainFails ? null : recorder.drained.splice(0))),
	getNativeRecorderState: vi.fn(() =>
		Promise.resolve({
			running: recorder.running,
			startedAtMs: null,
			stoppedReason: recorder.stoppedReason,
			stoppedAtMs: null,
		}),
	),
	clearNativeJournal: vi.fn(() => Promise.resolve()),
	setNativeAutoStop: vi.fn(() => Promise.resolve()),
	watchNativeFixes: vi.fn((h: (raw: unknown) => void) => {
		recorder.fix = h;
		return Promise.resolve();
	}),
	watchNativeStopped: vi.fn(() => Promise.resolve()),
	watchNativeProvider: vi.fn((h: (enabled: boolean) => void) => {
		recorder.provider = h;
		return Promise.resolve();
	}),
	nativeBatteryStatus: vi.fn(() => Promise.resolve(null)),
	nativeOpenBatterySettings: vi.fn(() => Promise.resolve()),
}));

let ls: MemoryStorage;

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers();
	vi.setSystemTime(new Date(NIGHT_MS));
	recorder.drained = [
		{ tMs: NIGHT_MS - 120_000, lat: PARIS.lat, lon: PARIS.lon, accM: 5 },
		{ tMs: NIGHT_MS - 60_000, lat: PARIS.lat + 0.01, lon: PARIS.lon, accM: 5 },
	];
	recorder.drainFails = false;
	recorder.running = false;
	recorder.stoppedReason = null;
	recorder.fix = null;
	recorder.provider = null;
	ls = memoryStorage({
		'loxodrome:auto-night': '1',
		'loxodrome:nav-trace': JSON.stringify({
			v: 1,
			altDatum: 'msl',
			recording: true,
			points: [
				{ lat: 48.6, lon: 2.4, timeMs: NIGHT_MS - 300_000, altFt: 1500, speedKt: 95 },
				{ lat: 48.7, lon: 2.37, timeMs: NIGHT_MS - 240_000, altFt: 1500, speedKt: 95 },
			],
		}),
	});
	vi.stubGlobal('localStorage', ls);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function boot() {
	const theme = await import('$lib/state/theme.svelte');
	const night = await import('$lib/state/nightDim.svelte');
	const nav = await import('$lib/state/navRecording.svelte');
	return { ...theme, ...night, ...nav };
}

/** One reconcile of App.svelte's effect. */
function reconcile(m: Awaited<ReturnType<typeof boot>>): void {
	const at = m.autoNightFix();
	if (at !== undefined) {
		m.applyAutoNight(at?.lat ?? null, at?.lon ?? null, Date.now(), at?.canStart ?? true);
	}
}

const docRecording = (): unknown =>
	(JSON.parse(ls.getItem('loxodrome:nav-trace') ?? '{}') as { recording?: unknown }).recording;

describe('an interrupted flight across two restarts', () => {
	it('keeps the night at the second restart', async () => {
		let m = await boot();
		await m.reconcileNativeRecording();
		reconcile(m);
		expect(m.nav.interrupted).toBe(true);
		expect(m.theme.value).toBe('night');
		// The drained tail is flushed at once and again by the 8 s timer:
		// still the flight you are on.
		expect(docRecording()).toBe(true);
		vi.advanceTimersByTime(10_000);
		expect(docRecording()).toBe(true);
		vi.resetModules();
		m = await boot();
		expect(m.nav.interrupted).toBe(true);
		reconcile(m);
		expect(m.theme.value).toBe('night');
		expect(ls.getItem('loxodrome:auto-night')).toBe('1');
	});

	it('ends with a stop the pilot made from the notification', async () => {
		recorder.stoppedReason = 'user';
		const m = await boot();
		await m.reconcileNativeRecording();
		expect(m.nav.interrupted).toBe(false);
		expect(docRecording()).toBe(false);
		reconcile(m);
		expect(m.theme.value).toBe('day');
		expect(ls.getItem('loxodrome:auto-night')).toBeNull();
	});

	it('ends with a stop the pilot made even when nothing was left to drain', async () => {
		// The copy was only written when the journal had a tail: with none, it
		// kept saying recording, and the journal's clear took the stop reason
		// with it, so the next boot read the stopped flight as a killed one.
		recorder.drained = [];
		recorder.stoppedReason = 'user';
		let m = await boot();
		await m.reconcileNativeRecording();
		expect(m.nav.interrupted).toBe(false);
		expect(docRecording()).toBe(false);
		recorder.stoppedReason = null;
		vi.resetModules();
		m = await boot();
		await m.reconcileNativeRecording();
		expect(m.nav.interrupted).toBe(false);
	});
});

/* The phone's Location switch, which the recorder service passes on as its
 * provider event: off, the recording reads the position unavailable, the
 * web watch's POSITION_UNAVAILABLE posture, until a fix proves the sensor
 * works again. */
describe('the Location switch under a native recording', () => {
	it('reads unavailable while Location is off, until the next fix', async () => {
		recorder.running = true;
		const m = await boot();
		await m.reconcileNativeRecording();
		expect(m.nav.recording).toBe(true);
		recorder.provider?.(false);
		expect(m.nav.error).toBe('unavailable');
		recorder.fix?.({ tMs: NIGHT_MS + 1_000, lat: PARIS.lat + 0.02, lon: PARIS.lon, accM: 5 });
		expect(m.nav.error).toBeNull();
		recorder.provider?.(false);
		recorder.provider?.(true);
		expect(m.nav.error).toBeNull();
		m.stopRecording();
		recorder.provider?.(false);
		expect(m.nav.error).toBeNull();
	});
});

/* The service stamps a fix with Location.getTime(), satellite time, and the
 * quality ages it against the phone's clock: a live fix reads on that clock,
 * whatever the two disagree by. */
describe('the quality of a native fix', () => {
	it('reads a fresh fix as good with the phone clock ahead of its stamp', async () => {
		recorder.running = true;
		const m = await boot();
		await m.reconcileNativeRecording();
		recorder.fix?.({ tMs: NIGHT_MS - 10_000, lat: PARIS.lat + 0.02, lon: PARIS.lon, accM: 5 });
		expect(m.positionQuality()).toBe('good');
		m.stopRecording();
	});
});

/* The journal is the only copy of the fixes a dead WebView never received,
 * and the web side clears it once a drain is done. A drain that failed
 * clears nothing, so the next boot reconcile drains it again, and the
 * outing still settles with the trace it has. */
describe('a drain that fails', () => {
	it('leaves the journal at the boot reconcile', async () => {
		const nr = await import('$lib/native/navRecorder');
		recorder.drainFails = true;
		recorder.stoppedReason = 'user';
		const m = await boot();
		const settled: string[] = [];
		m.setOutingSettledHook((reason) => settled.push(reason));
		await m.reconcileNativeRecording();
		expect(settled).toEqual(['reconcile']);
		expect(nr.clearNativeJournal).not.toHaveBeenCalled();
		expect(m.nav.points).toHaveLength(2);
	});

	it('leaves the journal at a stop', async () => {
		const nr = await import('$lib/native/navRecorder');
		recorder.running = true;
		const m = await boot();
		await m.reconcileNativeRecording();
		expect(m.nav.recording).toBe(true);
		const settled: string[] = [];
		m.setOutingSettledHook((reason) => settled.push(reason));
		recorder.drainFails = true;
		m.stopRecording();
		await vi.waitFor(() => expect(settled).toEqual(['native-stop']));
		expect(nr.clearNativeJournal).not.toHaveBeenCalled();
	});

	it('clears the journal after a drain that completed', async () => {
		const nr = await import('$lib/native/navRecorder');
		const m = await boot();
		await m.reconcileNativeRecording();
		expect(nr.clearNativeJournal).toHaveBeenCalledTimes(1);
	});
});
