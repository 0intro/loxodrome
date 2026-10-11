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
	stoppedReason: null as 'user' | 'autostop' | null,
}));

vi.mock('$lib/native/platform', () => ({ isNativeApp: () => true }));
vi.mock('$lib/native/navRecorder', () => ({
	startNativeRecorder: vi.fn(() => Promise.resolve('ok')),
	stopNativeRecorder: vi.fn(() => Promise.resolve()),
	drainNativeAfter: vi.fn(() => Promise.resolve(recorder.drained.splice(0))),
	getNativeRecorderState: vi.fn(() =>
		Promise.resolve({
			running: false,
			startedAtMs: null,
			stoppedReason: recorder.stoppedReason,
			stoppedAtMs: null,
		}),
	),
	clearNativeJournal: vi.fn(() => Promise.resolve()),
	setNativeAutoStop: vi.fn(() => Promise.resolve()),
	watchNativeFixes: vi.fn(() => Promise.resolve()),
	watchNativeStopped: vi.fn(() => Promise.resolve()),
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
	recorder.stoppedReason = null;
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
