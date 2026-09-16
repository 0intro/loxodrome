/* What a boot does with the crash-recovery trace (state/navRecording's
 * restore + the flights library's boot archive).
 *
 * The rule: draw it only while it is still the flight you are on. A
 * FINISHED flight is a row in the flights library, and redrawing it on the
 * map at every startup asserts something live. So it is PARKED at restore,
 * filed by the boot archive, and released only once that row is confirmed
 * written; anything else adopts it, because this side would otherwise be
 * holding the only copy.
 *
 * Fresh module graph per case: the restore runs at module evaluation. */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { TrackPoint } from '$lib/nav/trace';

const KEY = 'loxodrome:nav-trace';
const PARKED = 'loxodrome:nav-trace-parked';
const HOUR = 60 * 60 * 1000;

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

/** A trace that taxis, flies and lands: enough for the motion fold to
 *  commit a takeoff, which is what makes it a flight the library files. */
function flightTrace(endMs: number): TrackPoint[] {
	const pts: TrackPoint[] = [];
	const startMs = endMs - 500_000;
	for (let i = 0; i < 30; i++) {
		pts.push({ lat: 48, lon: 2, timeMs: startMs + i * 1000, altFt: 1500, speedKt: 5 });
	}
	for (let i = 30; i < 400; i++) {
		pts.push({
			lat: 48,
			lon: 2 + (i - 30) * 0.0004,
			timeMs: startMs + i * 1000,
			altFt: 1500,
			speedKt: 90,
		});
	}
	for (let i = 400; i < 500; i++) {
		pts.push({ lat: 48, lon: 2.148, timeMs: startMs + i * 1000, altFt: 1500, speedKt: 0 });
	}
	return pts;
}

/** Points that never leave the apron: the library refuses these, so the
 *  boot must keep them itself. */
function taxiTrace(endMs: number): TrackPoint[] {
	const startMs = endMs - 60_000;
	return Array.from({ length: 60 }, (_, i) => ({
		lat: 48,
		lon: 2,
		timeMs: startMs + i * 1000,
		altFt: 700,
		speedKt: 4,
	}));
}

function storeTrace(points: TrackPoint[], recording: boolean): void {
	store.set(KEY, JSON.stringify({ v: 1, iconKind: 'plane', altDatum: 'msl', recording, points }));
}

async function navMod(): Promise<typeof import('$lib/state/navRecording.svelte')> {
	return import('$lib/state/navRecording.svelte');
}

describe('the trace a boot draws', () => {
	it('keeps one the app died in the middle of recording', async () => {
		storeTrace(flightTrace(Date.now() - 30_000), true);
		const nav = await navMod();
		expect(nav.nav.points.length).toBeGreaterThan(0);
		expect(nav.pendingRestoredTrace()).toBeNull();
	});

	/* Inside the outing window a stopped trace is still the day's flying:
	 * the flight button offers Continue, so the map has to show what would
	 * be continued. */
	it('keeps a recently stopped one, which Continue would extend', async () => {
		storeTrace(flightTrace(Date.now() - HOUR), false);
		const nav = await navMod();
		expect(nav.nav.points.length).toBeGreaterThan(0);
		expect(nav.pendingRestoredTrace()).toBeNull();
	});

	it('parks a finished flight from another day, MOVING it to the outbox', async () => {
		storeTrace(flightTrace(Date.now() - 30 * HOUR), false);
		const raw = store.get(KEY);
		const nav = await navMod();
		expect(nav.nav.points).toHaveLength(0);
		expect(nav.pendingRestoredTrace()?.points.length).toBeGreaterThan(0);
		// The move is what takes the copy out of the live slot's blast radius:
		// a new recording's clearTrace / flushes touch only KEY from here.
		expect(store.get(KEY)).toBeUndefined();
		expect(store.get(PARKED)).toBe(raw); // raw bytes, no re-serialization
	});

	/* A taxi-only trace is never filed (the library's own takeoff gate), so
	 * parking it would be dropping it. */
	it('keeps an old trace the library would refuse', async () => {
		storeTrace(taxiTrace(Date.now() - 30 * HOUR), false);
		const nav = await navMod();
		expect(nav.nav.points.length).toBeGreaterThan(0);
		expect(nav.pendingRestoredTrace()).toBeNull();
	});
});

describe('the parked trace is released only against a filed row', () => {
	it('drops it once the flight is in the library', async () => {
		storeTrace(flightTrace(Date.now() - 30 * HOUR), false);
		const nav = await navMod();
		const parked = nav.pendingRestoredTrace();
		expect(parked).not.toBeNull();

		const lib = await import('$lib/state/flightLibrary.svelte');
		const db = await import('$lib/state/flightsDb');
		const result = await lib.archiveOuting(parked!.points, {
			datum: parked!.datum,
			aircraftKey: null,
		});
		expect(result).toEqual({ kind: 'archived' });

		nav.dropPendingTrace();
		expect(nav.pendingRestoredTrace()).toBeNull();
		expect(store.get(KEY)).toBeUndefined();
		expect(store.get(PARKED)).toBeUndefined();
		// And it is reachable again: the row's points load back into the slot.
		const metas = await db.getMetas();
		const points = await db.getPoints(metas[0].id);
		expect(points?.length).toBeGreaterThan(0);
	});

	it('adopts it back when the archive could not confirm a row', async () => {
		storeTrace(flightTrace(Date.now() - 30 * HOUR), false);
		const nav = await navMod();
		expect(nav.nav.points).toHaveLength(0);

		nav.adoptPendingTrace();
		expect(nav.nav.points.length).toBeGreaterThan(0);
		expect(nav.pendingRestoredTrace()).toBeNull();
		// Re-persisted to the live slot, so the next boot finds it exactly as
		// this one did; the outbox comes down once that write is confirmed.
		expect(store.get(KEY)).toBeDefined();
		expect(store.get(PARKED)).toBeUndefined();
	});

	/* The parked branch may file DURING a new recording (it runs ahead of
	 * the recording gate, or the old flight would be stranded unfiled). The
	 * live key belongs to that recording's own flushes by then; the release
	 * touches only the outbox. */
	it('leaves the live key to a new recording when dropping', async () => {
		storeTrace(flightTrace(Date.now() - 30 * HOUR), false);
		const nav = await navMod();
		expect(nav.pendingRestoredTrace()).not.toBeNull();
		expect(store.get(PARKED)).toBeDefined();

		nav.nav.recording = true;
		try {
			store.set(KEY, '{"v":1,"points":[]}'); // the new recording's flush
			nav.dropPendingTrace();
			expect(nav.pendingRestoredTrace()).toBeNull();
			expect(store.get(KEY)).toBe('{"v":1,"points":[]}');
			expect(store.get(PARKED)).toBeUndefined();
		} finally {
			nav.nav.recording = false;
		}
	});

	/* THE double failure the outbox exists for: the archive refused AND a
	 * recording started meanwhile. The refused adopt lets the in-memory copy
	 * go, but the outbox stands, and the next boot re-parks and re-files. */
	it('a refused adopt leaves the outbox for the next boot', async () => {
		storeTrace(flightTrace(Date.now() - 30 * HOUR), false);
		let nav = await navMod();
		expect(nav.pendingRestoredTrace()).not.toBeNull();

		nav.nav.recording = true; // a new recording owns the live slot
		nav.adoptPendingTrace();
		expect(nav.pendingRestoredTrace()).toBeNull();
		expect(nav.nav.points).toHaveLength(0);
		expect(store.get(PARKED)).toBeDefined();

		vi.resetModules();
		nav = await navMod();
		expect(nav.pendingRestoredTrace()?.points.length).toBeGreaterThan(0);
	});

	/* writeJson swallows quota failures, and the adopt-back instant briefly
	 * holds two full docs: the outbox may only come down once the live copy
	 * is CONFIRMED present. */
	it('keeps the outbox when the adopt-back write is swallowed', async () => {
		storeTrace(flightTrace(Date.now() - 30 * HOUR), false);
		const nav = await navMod();
		expect(store.get(KEY)).toBeUndefined(); // moved at park

		const realSet = store.set.bind(store);
		vi.stubGlobal('localStorage', {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => {
				if (k === KEY) {
					throw new Error('QuotaExceededError'); // the live write refused
				}
				realSet(k, v);
			},
			removeItem: (k: string) => void store.delete(k),
		});
		nav.adoptPendingTrace();
		expect(nav.nav.points.length).toBeGreaterThan(0); // adopted in memory
		expect(store.get(PARKED)).toBeDefined(); // the only durable copy stands
	});

	/* At most one flight is ever sheltered: an occupied outbox adopts the
	 * second finished flight live instead, WITH its own datum and icon. */
	it('adopts a second finished flight live when the outbox is occupied', async () => {
		const oldFlight = flightTrace(Date.now() - 60 * HOUR);
		store.set(
			PARKED,
			JSON.stringify({ v: 1, iconKind: 'glider', altDatum: 'ellipsoid', recording: false, points: oldFlight }),
		);
		storeTrace(flightTrace(Date.now() - 30 * HOUR), false); // iconKind plane, msl
		const nav = await navMod();
		expect(nav.pendingRestoredTrace()?.points[0].timeMs).toBe(oldFlight[0].timeMs);
		expect(nav.nav.points.length).toBeGreaterThan(0);
		expect(nav.nav.points[0].timeMs).not.toBe(oldFlight[0].timeMs);
		// The adopted (newer) doc's datum and icon win the live slot.
		expect(nav.nav.traceDatum).toBe('msl');
		expect(nav.nav.iconKind).toBe('plane');
	});

	/* An outbox doc the library could never file (no points) is removed, or
	 * the boot archive would throw on points[0] every session. */
	it('removes an empty outbox doc instead of parking it', async () => {
		store.set(PARKED, JSON.stringify({ v: 1, altDatum: 'msl', recording: false, points: [] }));
		const nav = await navMod();
		expect(nav.pendingRestoredTrace()).toBeNull();
		expect(store.get(PARKED)).toBeUndefined();
	});
});
