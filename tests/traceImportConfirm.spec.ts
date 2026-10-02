/* Opening a trace file over the loaded one (state/openFile.svelte.ts
 * openTrace). It asks only when the replaced trace would be LOST: a trace the
 * flights library holds goes in silence, and one it does not (no takeoff, no
 * wall clock, a store that refused it) is named by the reason, read when the
 * question is raised (nav/flightStart.ts discardReason). "Replace the current
 * trace?" used to be asked of every loaded trace and promised a loss that, for
 * a filed flight, never happened.
 *
 * The web picker also asked TWICE once: the Navigation tab asked, then the
 * dispatcher it hands the file to. The question is the dispatcher's alone,
 * after the file has parsed; that half is pinned at the source, since the
 * node project renders no component to click through. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackPoint } from '$lib/nav/trace';
import { memoryStorage } from './helpers/storage';

// The dispatcher reaches Leaflet through the map fit; nothing here draws.
vi.mock('leaflet', () => ({ default: {} }));

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="spec" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
<trkpt lat="48.85" lon="2.35"><ele>100</ele><time>2026-09-01T12:00:00Z</time></trkpt>
<trkpt lat="48.86" lon="2.35"><ele>120</ele><time>2026-09-01T12:00:10Z</time></trkpt>
</trkseg></trk></gpx>`;
const FILE_START = Date.parse('2026-09-01T12:00:00Z');

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A taxi, a 90 kt run and a stop: the motion fold commits a takeoff. */
function flight(startMs: number): TrackPoint[] {
	return Array.from({ length: 300 }, (_, i) => ({
		lat: 48.6,
		lon: 2.4 + Math.min(i, 250) * 0.0004,
		timeMs: startMs + i * 1000,
		altFt: 1500,
		speedKt: i < 30 ? 5 : i < 250 ? 90 : 0,
	}));
}

/** A taxi that never took off. */
const taxi = (startMs: number): TrackPoint[] =>
	Array.from({ length: 60 }, (_, i) => ({ lat: 48.6, lon: 2.4 + i * 1e-5, timeMs: startMs + i * 1000, altFt: 300, speedKt: 8 }));

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('localStorage', memoryStorage());
	vi.stubGlobal(
		'fetch',
		vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function load() {
	const nav = await import('$lib/state/navRecording.svelte');
	const open = await import('$lib/state/openFile.svelte');
	return { ...nav, ...open };
}

const T = Date.parse('2026-08-30T09:00:00Z');

describe('opening a trace over the loaded one', () => {
	it('replaces a trace the flights library holds without asking', { timeout: 30_000 }, async () => {
		const m = await load();
		m.restoreOuting(flight(T), 'msl');
		expect(m.traceFiled()).toBe(true);
		await m.openIncomingBytes('lesson.gpx', bytes(GPX));
		expect(m.openFile.pendingTrace).toBeNull();
		expect(m.nav.points[0].timeMs).toBe(FILE_START);
	});

	it('asks before dropping a trace with no takeoff, and opens once answered', { timeout: 30_000 }, async () => {
		const m = await load();
		m.importTrace(taxi(T), 'msl');
		await m.openIncomingBytes('lesson.gpx', bytes(GPX));
		expect(m.openFile.pendingTrace?.discard).toBe('noTakeoff');
		expect(m.nav.points[0].timeMs).toBe(T);
		m.applyPendingTrace();
		await vi.waitFor(() => {
			expect(m.nav.points[0].timeMs).toBe(FILE_START);
		});
	});

	it('asks before dropping a flight the store refused, and keeps it on Cancel', { timeout: 30_000 }, async () => {
		const m = await load();
		m.restoreOuting(flight(T), 'msl');
		m.noteTraceArchived(m.archiveTicket(), { kind: 'failed', detail: 'QuotaExceededError' });
		await m.openIncomingBytes('lesson.gpx', bytes(GPX));
		expect(m.openFile.pendingTrace?.discard).toBe('unsaved');
		m.dismissPendingTrace();
		expect(m.nav.points[0].timeMs).toBe(T);
	});

	it('asks before dropping a trace with no wall clock', { timeout: 30_000 }, async () => {
		const m = await load();
		// A drawn line on the synthesised clock from the epoch.
		m.importTrace(flight(0), 'msl');
		await m.openIncomingBytes('lesson.gpx', bytes(GPX));
		expect(m.openFile.pendingTrace?.discard).toBe('noClock');
	});

	it('is asked once, by the dispatcher, in the reason it was raised for', () => {
		const tab = read('src/lib/components/tabs/NavigationTab.svelte');
		const onImport = tab.slice(tab.indexOf('function onImport('), tab.indexOf('async function readTrace('));
		expect(onImport).toContain('void readTrace(file);');
		expect(onImport).not.toMatch(/ask\(|discard/);
		expect(read('src/lib/components/FileOpenHost.svelte')).toContain(
			'message={t.navigation.discard[openFile.pendingTrace.discard]}',
		);
	});
});
