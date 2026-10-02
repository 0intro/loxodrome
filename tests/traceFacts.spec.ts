/* Two facts on the live trace (state/navRecording.svelte.ts), which the
 * flight button decides on (nav/flightStart.ts): WHERE it came from (this
 * device's recording, an import, a library replay), and WHETHER the flights
 * library holds it as it stands. The second used to be inferred from "has a
 * takeoff", which let a failed archive or a clockless import be replaced in
 * silence; it is now the library's own answer, tied to the trace state it was
 * asked about, carried across a boot by a marker the crash copy holds.
 *
 * Fresh module graph per case: the restore runs at module evaluation. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { TrackPoint } from '$lib/nav/trace';

const KEY = 'loxodrome:nav-trace';
const PARKED = 'loxodrome:nav-trace-parked';
const HOUR = 3_600_000;

let store: Map<string, string>;

beforeEach(() => {
	store = new Map<string, string>();
	globalThis.indexedDB = new IDBFactory();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
	vi.resetModules();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** A taxi, a 90 kt run and a stop: the motion fold commits a takeoff. */
function flightTrace(endMs: number): TrackPoint[] {
	const pts: TrackPoint[] = [];
	const startMs = endMs - 500_000;
	for (let i = 0; i < 500; i++) {
		const kt = i < 30 ? 5 : i < 400 ? 90 : 0;
		pts.push({ lat: 48, lon: 2 + Math.min(i, 400) * 0.0004, timeMs: startMs + i * 1000, altFt: 1500, speedKt: kt });
	}
	return pts;
}

const doc = (): Record<string, unknown> => JSON.parse(store.get(KEY) ?? '{}') as Record<string, unknown>;
const source = { name: 'lesson.gpx', format: 'gpx' as const, bytes: new Uint8Array([60, 103, 112, 120]) };

async function navMod(): Promise<typeof import('$lib/state/navRecording.svelte')> {
	return import('$lib/state/navRecording.svelte');
}
async function lib(): Promise<typeof import('$lib/state/flightLibrary.svelte')> {
	return import('$lib/state/flightLibrary.svelte');
}

describe('where the trace came from', () => {
	it('is said by every way a trace arrives, and forgotten by a clear', async () => {
		const n = await navMod();
		n.importTrace(flightTrace(Date.now() - HOUR), 'msl', source);
		expect([n.nav.origin, n.nav.sourceName]).toEqual(['import', 'lesson.gpx']);
		n.restoreOuting(flightTrace(Date.now() - 2 * HOUR), 'msl');
		expect([n.nav.origin, n.nav.sourceName]).toEqual(['library', null]);
		// Whatever was loaded, what an append grows is this device's recording.
		n.continueRecording();
		expect([n.nav.origin, n.nav.sourceName]).toEqual(['recording', null]);
		n.clearTrace();
		expect(n.nav.origin).toBeNull();
	});

	it('crosses a boot with the crash copy, the file name with it', async () => {
		const n = await navMod();
		n.importTrace(flightTrace(Date.now() - HOUR), 'msl', source);
		expect(doc()).toMatchObject({ origin: 'import', sourceName: 'lesson.gpx' });
		vi.resetModules();
		const again = await navMod();
		expect([again.nav.origin, again.nav.sourceName]).toEqual(['import', 'lesson.gpx']);
	});

	it('reads an older build doc as unknown, or as a recording when written mid-recording', async () => {
		const pts = flightTrace(Date.now() - HOUR);
		store.set(KEY, JSON.stringify({ v: 1, altDatum: 'msl', recording: false, points: pts }));
		expect((await navMod()).nav.origin).toBe('unknown');
		vi.resetModules();
		store.set(KEY, JSON.stringify({ v: 1, altDatum: 'msl', recording: true, points: pts }));
		expect((await navMod()).nav.origin).toBe('recording');
	});

	it('travels through the parked outbox', async () => {
		const pts = flightTrace(Date.now() - 8 * HOUR);
		store.set(KEY, JSON.stringify({ v: 1, altDatum: 'msl', recording: false, origin: 'import', sourceName: 'old.igc', points: pts }));
		const n = await navMod();
		expect(store.has(PARKED)).toBe(true);
		expect(n.pendingRestoredOrigin()).toBe('import');
	});
});

describe('whether the library holds it', () => {
	it('is the row itself for a replay, and an append leaves the answer behind', async () => {
		const n = await navMod();
		n.restoreOuting(flightTrace(Date.now() - HOUR), 'msl');
		expect(n.traceFiled()).toBe(true);
		const last = n.nav.points[n.nav.points.length - 1];
		n.nav.points.push({ ...last, timeMs: last.timeMs + 1000 });
		expect(n.traceFiled()).toBe(false);
	});

	it('is an answer about its own snapshot, never another trace', async () => {
		const n = await navMod();
		n.importTrace(flightTrace(Date.now() - 3 * HOUR), 'msl');
		const stale = n.archiveTicket();
		n.importTrace(flightTrace(Date.now() - HOUR), 'msl');
		n.noteTraceArchived(stale, { kind: 'archived' });
		expect(n.traceFiled()).toBe(false);
		n.noteTraceArchived(n.archiveTicket(), { kind: 'archived' });
		expect(n.traceFiled()).toBe(true);
		// A late answer about the old trace must not overwrite this one's.
		n.noteTraceArchived(stale, { kind: 'failed', detail: 'late' });
		expect(n.traceFiled()).toBe(true);
		expect(n.archiveFailure()).toBeNull();
	});

	it('follows the trace past the point cap, whose splice keeps the length', async () => {
		const n = await navMod();
		n.restoreOuting(flightTrace(Date.now() - HOUR), 'msl');
		const last = n.nav.points[n.nav.points.length - 1];
		n.nav.points.splice(0, 1);
		n.nav.points.push({ ...last, timeMs: last.timeMs + 1000 });
		expect(n.traceFiled()).toBe(false);
	});

	it('says why the store refused it', async () => {
		const n = await navMod();
		n.importTrace(flightTrace(Date.now() - HOUR), 'msl');
		n.noteTraceArchived(n.archiveTicket(), { kind: 'failed', detail: 'QuotaExceededError' });
		expect(n.traceFiled()).toBe(false);
		expect(n.archiveFailure()).toBe('QuotaExceededError');
		// The library's other answers are read off the trace, not stored.
		n.noteTraceArchived(n.archiveTicket(), { kind: 'noTakeoff' });
		expect(n.archiveFailure()).toBe('QuotaExceededError');
	});

	it('is the archive of a recording stop, reported back by the library', async () => {
		const m = await lib();
		const n = await navMod();
		n.restoreOuting(flightTrace(Date.now() - HOUR), 'msl');
		n.nav.archive = null;
		expect(n.traceFiled()).toBe(false);
		expect(await m.archiveCurrentOuting('refile')).toEqual({ kind: 'archived' });
		expect(n.traceFiled()).toBe(true);
	});

	it('crosses a boot only while the doc ends where the filed trace ended', async () => {
		const n = await navMod();
		n.restoreOuting(flightTrace(Date.now() - HOUR), 'msl');
		const written = doc();
		expect(written.filed).toEqual([n.nav.points[0].timeMs, n.nav.points[n.nav.points.length - 1].timeMs]);
		vi.resetModules();
		expect((await navMod()).traceFiled()).toBe(true);
		// A crash copy holding fixes past the filed end, or written mid-recording.
		const pts = written.points as TrackPoint[];
		vi.resetModules();
		store.set(KEY, JSON.stringify({ ...written, points: [...pts, { ...pts[pts.length - 1], timeMs: pts[pts.length - 1].timeMs + 1000 }] }));
		expect((await navMod()).traceFiled()).toBe(false);
		vi.resetModules();
		store.set(KEY, JSON.stringify({ ...written, recording: true }));
		expect((await navMod()).traceFiled()).toBe(false);
	});

	it('goes with its row: deleting the loaded flight closes it', async () => {
		const m = await lib();
		const n = await navMod();
		const pts = flightTrace(Date.now() - HOUR);
		n.restoreOuting(pts, 'msl');
		await m.removeOuting(pts[0].timeMs);
		expect(n.nav.points).toHaveLength(0);
		expect(n.nav.origin).toBeNull();
	});

	it('keeps a recording when its row is deleted, only no longer filed', async () => {
		const m = await lib();
		const n = await navMod();
		const pts = flightTrace(Date.now() - HOUR);
		n.restoreOuting(pts, 'msl');
		n.nav.recording = true;
		await m.removeOuting(pts[0].timeMs);
		expect(n.nav.points.length).toBe(pts.length);
		expect(n.traceFiled()).toBe(false);
		n.nav.recording = false;
	});
});

describe('the boot archive', () => {
	async function fileRow(points: TrackPoint[]): Promise<number> {
		const m = await lib();
		expect(await m.archiveOuting(points, { datum: 'msl', aircraftKey: null })).toEqual({ kind: 'archived' });
		const db = await import('$lib/state/flightsDb');
		return (await db.getMeta(points[0].timeMs))?.savedAtMs ?? -1;
	}

	it('takes a replay whose row is there as filed, without rewriting it', async () => {
		const pts = flightTrace(Date.now() - HOUR);
		const savedAt = await fileRow(pts);
		vi.resetModules();
		store.set(KEY, JSON.stringify({ v: 1, altDatum: 'msl', recording: false, origin: 'library', points: pts }));
		const m = await lib();
		const n = await navMod();
		expect(n.traceFiled()).toBe(false);
		await m.bootArchive();
		expect(n.traceFiled()).toBe(true);
		const db = await import('$lib/state/flightsDb');
		expect((await db.getMeta(pts[0].timeMs))?.savedAtMs).toBe(savedAt);
	});

	it('never brings back a replay whose row was deleted', async () => {
		const pts = flightTrace(Date.now() - HOUR);
		store.set(KEY, JSON.stringify({ v: 1, altDatum: 'msl', recording: false, origin: 'library', points: pts }));
		const m = await lib();
		await m.bootArchive();
		const db = await import('$lib/state/flightsDb');
		expect(await db.getMeta(pts[0].timeMs)).toBeNull();
	});

	it('lets a parked replay go without re-filing it', async () => {
		const pts = flightTrace(Date.now() - 8 * HOUR);
		const savedAt = await fileRow(pts);
		vi.resetModules();
		store.set(KEY, JSON.stringify({ v: 1, altDatum: 'msl', recording: false, origin: 'library', points: pts }));
		const m = await lib();
		expect(store.has(PARKED)).toBe(true);
		await m.bootArchive();
		expect(store.has(PARKED)).toBe(false);
		const db = await import('$lib/state/flightsDb');
		expect((await db.getMeta(pts[0].timeMs))?.savedAtMs).toBe(savedAt);
	});

	it('files a recording crash copy as before, and says so', async () => {
		const pts = flightTrace(Date.now() - HOUR);
		store.set(KEY, JSON.stringify({ v: 1, altDatum: 'msl', recording: false, origin: 'recording', points: pts }));
		const m = await lib();
		const n = await navMod();
		await m.bootArchive();
		await vi.waitFor(() => {
			expect(n.traceFiled()).toBe(true);
		});
		const db = await import('$lib/state/flightsDb');
		expect(await db.getMeta(pts[0].timeMs)).not.toBeNull();
	});
});
