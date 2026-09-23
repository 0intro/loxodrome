/* The archive path and the dynamic-link cache over a real (faked)
 * IndexedDB: state/flightLibrary.svelte.ts and state/flightLinks.svelte.ts
 * (docs/flights-library.md). Both ran untested for want of a store.
 *
 * The pins here are the ones whose failure is INVISIBLE in the app: an
 * archive that refuses for the wrong reason, a listing that drops a row
 * it raced, a link cache that will not notice the catalog moved. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { TrackPoint } from '$lib/nav/trace';

const T0 = Date.UTC(2026, 6, 7, 9, 30);

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	vi.resetModules();
});

async function lib(): Promise<typeof import('$lib/state/flightLibrary.svelte')> {
	return import('$lib/state/flightLibrary.svelte');
}

/** A trace that taxis, flies a leg and lands: enough for the motion fold
 *  to commit a takeoff and a landing. One fix a second, moving east. */
function flightTrace(startMs = T0): TrackPoint[] {
	const pts: TrackPoint[] = [];
	const push = (i: number, lat: number, lon: number, speedKt: number): void => {
		pts.push({ lat, lon, timeMs: startMs + i * 1000, altFt: 1500, speedKt });
	};
	// Taxi, then a sustained 90 kt airborne run, then a stop.
	for (let i = 0; i < 30; i++) {
		push(i, 48, 2, 5);
	}
	for (let i = 30; i < 400; i++) {
		push(i, 48, 2 + (i - 30) * 0.0004, 90);
	}
	for (let i = 400; i < 500; i++) {
		push(i, 48, 2 + 370 * 0.0004, 0);
	}
	return pts;
}

describe('archiveOuting refuses for the RIGHT reason', () => {
	it('adds a trace that flew', async () => {
		const m = await lib();
		const out = await m.archiveOuting(flightTrace(), { datum: 'msl', aircraftKey: 'F-GORQ' });
		expect(out).toEqual({ kind: 'archived' });
		await m.refreshList();
		expect(m.flightLibrary.rows.map((r) => r.id)).toEqual([T0]);
	});

	it('reports a trace with NO WALL CLOCK as noClock, not as a store failure', async () => {
		const m = await lib();
		// parseGpx synthesises a 1 Hz clock from zero for a GPX with no
		// <time>. The importer's own takeoff gate cannot see this: the
		// synthetic clock reads as several hundred knots and commits one.
		// Only the archive knows, and calling it a database failure is what
		// it used to say.
		const out = await m.archiveOuting(flightTrace(0), { datum: 'msl', aircraftKey: null });
		expect(out).toEqual({ kind: 'noClock' });
		await m.refreshList();
		expect(m.flightLibrary.rows).toEqual([]);
	});

	it('reports a taxi-only trace as noTakeoff', async () => {
		const m = await lib();
		const taxi: TrackPoint[] = Array.from({ length: 60 }, (_, i) => ({
			lat: 48,
			lon: 2,
			altFt: null,
			timeMs: T0 + i * 1000,
			speedKt: 6,
		}));
		expect(await m.archiveOuting(taxi, { datum: 'msl', aircraftKey: null })).toEqual({
			kind: 'noTakeoff',
		});
	});

	it('reports an empty trace as noTakeoff', async () => {
		const m = await lib();
		expect(await m.archiveOuting([], { datum: 'msl', aircraftKey: null })).toEqual({
			kind: 'noTakeoff',
		});
	});

	it('surfaces a store failure and keeps it until it is dismissed', async () => {
		const m = await lib();
		const db = await import('$lib/state/flightsDb');
		vi.spyOn(db, 'putOuting').mockRejectedValue(new Error('QuotaExceededError'));
		const out = await m.archiveOuting(flightTrace(), { datum: 'msl', aircraftKey: null });
		expect(out).toEqual({ kind: 'failed', detail: 'QuotaExceededError' });
		// The flight was real and the store refused it: the one failure
		// nobody may swallow, so it stands in state for a banner to show.
		expect(m.flightLibrary.archiveError).toBe('QuotaExceededError');
		m.clearArchiveError();
		expect(m.flightLibrary.archiveError).toBeNull();
	});

	it('clears a standing failure once an archive succeeds', async () => {
		const m = await lib();
		const db = await import('$lib/state/flightsDb');
		const spy = vi.spyOn(db, 'putOuting').mockRejectedValueOnce(new Error('QuotaExceededError'));
		await m.archiveOuting(flightTrace(), { datum: 'msl', aircraftKey: null });
		expect(m.flightLibrary.archiveError).not.toBeNull();
		spy.mockRestore();
		await m.archiveOuting(flightTrace(), { datum: 'msl', aircraftKey: null });
		expect(m.flightLibrary.archiveError).toBeNull();
	});

	it('is an idempotent upsert on the outing id', async () => {
		const m = await lib();
		await m.archiveOuting(flightTrace(), { datum: 'msl', aircraftKey: null });
		// A Continue-extend keeps the first fix, so the id is stable and the
		// second archive replaces rather than duplicates.
		await m.archiveOuting(flightTrace(), { datum: 'ellipsoid', aircraftKey: 'F-GIKP' });
		await m.refreshList();
		expect(m.flightLibrary.rows).toHaveLength(1);
		expect(m.flightLibrary.rows[0].datum).toBe('ellipsoid');
		expect(m.flightLibrary.rows[0].aircraftKey).toBe('F-GIKP');
	});
});

describe('refreshList', () => {
	it('does not drop a row archived while it was listing', async () => {
		const m = await lib();
		const db = await import('$lib/state/flightsDb');
		const realGetMetas = db.getMetas;
		let hold: () => void = () => undefined;
		vi.spyOn(db, 'getMetas').mockImplementationOnce(async () => {
			// A listing whose read is still in flight when an archive lands:
			// the assignment below is wholesale, so without the rerun the
			// fresh row is simply gone until something else re-lists.
			await new Promise<void>((r) => {
				hold = r;
			});
			return realGetMetas();
		});
		const listing = m.refreshList();
		await m.archiveOuting(flightTrace(), { datum: 'msl', aircraftKey: null });
		// The archive asked for a re-list while the first one was parked.
		void m.refreshList();
		hold();
		await listing;
		expect(m.flightLibrary.rows.map((r) => r.id)).toEqual([T0]);
	});

	it('lists newest first', async () => {
		const m = await lib();
		await m.archiveOuting(flightTrace(T0), { datum: 'msl', aircraftKey: null });
		await m.archiveOuting(flightTrace(T0 + 86_400_000), { datum: 'msl', aircraftKey: null });
		await m.refreshList();
		expect(m.flightLibrary.rows.map((r) => r.id)).toEqual([T0 + 86_400_000, T0]);
	});
});

describe('the imported logbook row', () => {
	it('keeps its pilot-declared cells, which the export writes back', async () => {
		const m = await lib();
		const { parseLogbookCsv, buildLogbookCsv } = await import('$lib/nav/logbook');
		const { libraryLogbookRows } = await import('$lib/state/flightRows');
		const csv =
			'date,departure_place,departure_time,arrival_place,arrival_time,aircraft_make,' +
			'aircraft_model,aircraft_registration,sp_se,sp_me,mp_time,total_time,pic_name,' +
			'landings_day,landings_night,night_time,ifr_time,pic_time,copilot_time,dual_time,' +
			'instructor_time,fstd_date,fstd_type,fstd_time,remarks\r\n' +
			'2026-07-07,LFPL,09:30,LFFN,10:24,ROBIN,DR400,F-GORQ,0:54,,,0:54,DUPONT,1,0,,,' +
			'0:54,,,,,,,LFPL - LFFN\r\n';
		const parsed = parseLogbookCsv(csv);
		expect(parsed.rows).toHaveLength(1);
		await m.archiveLogbookFlights(parsed.rows);
		await m.refreshList();
		const rows = libraryLogbookRows(m.flightLibrary.rows, {
			make: () => 'SOMEONE ELSE',
			model: () => 'X',
			registration: (k) => k ?? '',
			// The current device's pilot: exactly what must NOT end up on an
			// imported row, which names whoever commanded THAT flight.
			picName: 'MARTIN',
			labelsFor: () => null,
		});
		const out = buildLogbookCsv(rows);
		const cells = out.split('\r\n')[1].split(',');
		const header = out.split('\r\n')[0].split(',');
		const at = (name: string): string => cells[header.indexOf(name)];
		expect(at('pic_name')).toBe('DUPONT');
		expect(at('sp_se')).toBe('0:54');
		expect(at('pic_time')).toBe('0:54');
		expect(at('remarks')).toBe('LFPL - LFFN');
	});

	it('a trace-derived row still gets the resolved pilot', async () => {
		const m = await lib();
		const { buildLogbookCsv } = await import('$lib/nav/logbook');
		const { libraryLogbookRows } = await import('$lib/state/flightRows');
		await m.archiveOuting(flightTrace(), { datum: 'msl', aircraftKey: 'F-GORQ' });
		await m.refreshList();
		const rows = libraryLogbookRows(m.flightLibrary.rows, {
			make: () => '',
			model: () => '',
			registration: (k) => k ?? '',
			picName: 'SELF',
			labelsFor: () => null,
		});
		const out = buildLogbookCsv(rows);
		const cells = out.split('\r\n')[1].split(',');
		const header = out.split('\r\n')[0].split(',');
		expect(cells[header.indexOf('pic_name')]).toBe('SELF');
		// Never derived, so never asserted.
		expect(cells[header.indexOf('pic_time')]).toBe('');
	});
});

describe('the dynamic link cache', () => {
	it('keys on the catalog CONTENT, not on when it was stored', async () => {
		const { catalogHash } = await import('$lib/state/flightLinks.svelte');
		const a = [
			{ id: 'p1', yaml: 'routes:\n  - a\n', savedAtMs: 1 },
			{ id: 'p2', yaml: 'routes:\n  - b\n', savedAtMs: 2 },
		];
		// A no-op re-store must not invalidate every link in the library.
		const restamped = a.map((p) => ({ ...p, savedAtMs: p.savedAtMs + 1000 }));
		expect(catalogHash(restamped)).toBe(catalogHash(a));
		// Listing order is not content either.
		expect(catalogHash([...a].reverse())).toBe(catalogHash(a));
		// An edit IS.
		expect(catalogHash([{ ...a[0], yaml: 'routes:\n  - c\n' }, a[1]])).not.toBe(catalogHash(a));
		// So is adding or removing an entry.
		expect(catalogHash([a[0]])).not.toBe(catalogHash(a));
	});

	it('prunes the link of an outing that no longer exists', async () => {
		const m = await lib();
		const links = await import('$lib/state/flightLinks.svelte');
		await m.archiveOuting(flightTrace(), { datum: 'msl', aircraftKey: null });
		await links.primeLink(T0, { planId: 'p1', labels: ['LFPL - LFFN'] });
		expect(links.flightLinks.byOuting[T0]?.planId).toBe('p1');
		await m.removeOuting(T0);
		// The stored row went with the outing; the reactive twin goes on the
		// next pass, or the same trace re-added under the same id would wear
		// the old plan's labels.
		await links.ensureLinks();
		expect(links.flightLinks.byOuting[T0]).toBeUndefined();
	});

	it('serves a primed link from cache rather than re-folding', async () => {
		const m = await lib();
		const links = await import('$lib/state/flightLinks.svelte');
		const db = await import('$lib/state/flightsDb');
		await m.archiveOuting(flightTrace(), { datum: 'msl', aircraftKey: null });
		await links.primeLink(T0, { planId: null, labels: [] });
		// A computed NO-match caches too, so an unmatched trace is not
		// re-folded every session.
		const spy = vi.spyOn(db, 'getPoints');
		await links.ensureLinks();
		expect(spy).not.toHaveBeenCalled();
	});
});

/* The pristine source through the REAL archive path (docs/trace-files.md).
 * What is pinned is the three-state contract, because two of its states look
 * identical from the call site and mean opposite things to a stored file. */
describe('the archive and an imported trace\'s own file', () => {
	const SRC = {
		name: '2026-05-12_LFPL.gpx',
		format: 'gpx',
		bytes: new TextEncoder().encode('<gpx>original</gpx>'),
	} as const;

	it('files the bytes beside the points', async () => {
		const m = await lib();
		const db = await import('$lib/state/flightsDb');
		await m.archiveOuting(flightTrace(), { datum: 'msl', aircraftKey: null, source: { ...SRC } });
		expect(await db.getTraceSource(T0)).toEqual({ ...SRC });
	});

	/* The crash-copy restore re-files a DOWNSAMPLED trace under the same id
	 * and knows nothing about any file. If that dropped the source, a reload
	 * would silently turn an imported flight back into a re-synthesised one. */
	it('a re-archive with no opinion leaves them alone', async () => {
		const m = await lib();
		const db = await import('$lib/state/flightsDb');
		await m.archiveOuting(flightTrace(), { datum: 'msl', aircraftKey: null, source: { ...SRC } });
		await m.archiveOuting(flightTrace(), { datum: 'msl', aircraftKey: null });
		expect(await db.getTraceSource(T0)).not.toBeNull();
	});

	/* Extending the trace makes the file describe a prefix of the outing, so
	 * exporting it as this flight would be a lie. */
	it('a re-archive that says the points moved on drops them', async () => {
		const m = await lib();
		const db = await import('$lib/state/flightsDb');
		await m.archiveOuting(flightTrace(), { datum: 'msl', aircraftKey: null, source: { ...SRC } });
		await m.archiveOuting(flightTrace(), { datum: 'msl', aircraftKey: null, source: null });
		expect(await db.getTraceSource(T0)).toBeNull();
	});

	it('a recording has none, and asking for one is not an error', async () => {
		const m = await lib();
		const db = await import('$lib/state/flightsDb');
		await m.archiveOuting(flightTrace(), { datum: 'msl', aircraftKey: null });
		expect(await db.getTraceSource(T0)).toBeNull();
	});
});

/* An outing files itself; the plan it was flown with used to reach the
 * catalog only if the pilot remembered to Store it, and since the
 * trace->plan link is computed against the CATALOG, a plan that never got
 * there could never be linked to its own flight. Flying it is now the
 * second way in. */
describe('the flown plan reaches the catalog', () => {
	/** Put a two-waypoint route in the workspace, the way a plan sits there
	 *  while it is being flown. Free points need no dataset to resolve. */
	async function planWorkspace(): Promise<void> {
		const route = await import('$lib/state/route.svelte');
		route.addWaypoint(48.5, 2.5);
		route.addWaypoint(49, 3);
	}

	it('stores it when a recording settles', async () => {
		const m = await lib();
		const db = await import('$lib/state/flightsDb');
		await planWorkspace();
		const nav = await import('$lib/state/navRecording.svelte');
		nav.restoreOuting(flightTrace(), 'msl');

		expect(await m.archiveCurrentOuting('stop')).toEqual({ kind: 'archived' });
		await vi.waitFor(async () => {
			expect(await db.getStoredPlans()).toHaveLength(1);
		});
		const [kept] = await db.getStoredPlans();
		expect(kept.yaml).toContain('routes:');
	});

	/* A trace that arrived as a file says nothing about what is planned on
	 * screen, so importing one must not fork a catalog entry from it. */
	it('does not store it on an import settle', async () => {
		const m = await lib();
		const db = await import('$lib/state/flightsDb');
		await planWorkspace();
		const nav = await import('$lib/state/navRecording.svelte');
		nav.restoreOuting(flightTrace(), 'msl');

		expect(await m.archiveCurrentOuting('import')).toEqual({ kind: 'archived' });
		expect(await db.getStoredPlans()).toHaveLength(0);
	});

	/* Storing sets the provenance, and the provenance is what the store
	 * refuses to run over: the same plan flown again finds itself there. */
	it('stores it once, however often that plan is flown', async () => {
		const m = await lib();
		const db = await import('$lib/state/flightsDb');
		await planWorkspace();
		const nav = await import('$lib/state/navRecording.svelte');

		nav.restoreOuting(flightTrace(), 'msl');
		await m.archiveCurrentOuting('stop');
		await vi.waitFor(async () => {
			expect(await db.getStoredPlans()).toHaveLength(1);
		});
		// The provenance is the idempotence: the workspace now IS that entry.
		const { activePlan } = await import('$lib/state/activePlan.svelte');
		expect(activePlan.source).not.toBeNull();

		nav.restoreOuting(flightTrace(T0 + 86_400_000), 'msl');
		await m.archiveCurrentOuting('stop');
		expect(await db.getStoredPlans()).toHaveLength(1);
	});

	it('stores nothing when no plan was on screen', async () => {
		const m = await lib();
		const db = await import('$lib/state/flightsDb');
		const nav = await import('$lib/state/navRecording.svelte');
		nav.restoreOuting(flightTrace(), 'msl');

		expect(await m.archiveCurrentOuting('stop')).toEqual({ kind: 'archived' });
		expect(await db.getStoredPlans()).toHaveLength(0);
	});

	/* The boot archive re-upserting an ALREADY-FILED flight (a crash copy
	 * inside the outing window) says nothing about today's workspace: a
	 * 'refile' settle files the outing and never stores the plan, or a
	 * scratch draft on screen would be minted into the catalog by mere
	 * restarts. */
	it('does not store it on a boot refile of an already-filed flight', async () => {
		const m = await lib();
		const db = await import('$lib/state/flightsDb');
		await planWorkspace();
		const nav = await import('$lib/state/navRecording.svelte');
		nav.restoreOuting(flightTrace(), 'msl');

		expect(await m.archiveCurrentOuting('refile')).toEqual({ kind: 'archived' });
		expect(await db.getStoredPlans()).toHaveLength(0);
	});
});
