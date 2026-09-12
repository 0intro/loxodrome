/* The flights library's IndexedDB layer (state/flightsDb.ts,
 * docs/flights-library.md "Storage"): the upgrade path from every shipped
 * version, the read chokepoint's normalize, and the connection handling
 * that decides whether the surface can list at all.
 *
 * It ran untested until now because there was no IndexedDB in the node
 * environment; fake-indexeddb supplies one. Each case gets a FRESH
 * factory and a fresh module instance, because the module memoises its
 * connection deliberately. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { FlightSummary } from '$lib/nav/logbook';
import type { OutingMeta } from '$lib/state/flightsDb';

const T0 = Date.UTC(2026, 6, 7, 9, 30);

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	vi.resetModules();
});

async function db(): Promise<typeof import('$lib/state/flightsDb')> {
	return import('$lib/state/flightsDb');
}

function flight(over: Partial<FlightSummary> = {}): FlightSummary {
	return {
		blockOffMs: T0,
		takeoffMs: T0 + 60_000,
		landingMs: T0 + 50 * 60_000,
		blockOnMs: T0 + 54 * 60_000,
		distanceNM: 61.2,
		depPlace: 'LFPL',
		arrPlace: 'LFFN',
		landingsDay: 1,
		landingsNight: 0,
		nightMin: 0,
		touchPlaces: [],
		...over,
	};
}

/** Open the database at an OLD version and seed it exactly as that
 *  version's code did, then close: the next open goes through the real
 *  upgrade path. */
function seedLegacy(
	version: number,
	build: (d: IDBDatabase) => void,
	fill: (d: IDBDatabase) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open('loxodrome-flights', version);
		req.onupgradeneeded = () => build(req.result);
		req.onerror = () => reject(new Error('seed open failed'));
		req.onsuccess = () => {
			const d = req.result;
			fill(d);
			// Let the fill transactions settle before the connection closes.
			setTimeout(() => {
				d.close();
				resolve();
			}, 0);
		};
	});
}

describe('upgrades', () => {
	it('v1 (outings + points only) gains the plans and links stores', async () => {
		await seedLegacy(
			1,
			(d) => {
				d.createObjectStore('outings', { keyPath: 'id' });
				d.createObjectStore('points', { keyPath: 'id' });
			},
			(d) => {
				const tx = d.transaction(['outings', 'points'], 'readwrite');
				tx.objectStore('outings').put({
					id: T0,
					savedAtMs: T0,
					datum: 'msl',
					aircraftKey: 'F-GORQ',
					remarks: '',
					source: 'trace',
					derivedV: 4,
					flights: [flight()],
				});
				tx.objectStore('points').put({ id: T0, points: [{ lat: 1, lon: 2, altFt: null, timeMs: T0 }] });
			},
		);
		const m = await db();
		// The v1 rows survive, and the two stores added since are usable.
		expect((await m.getMetas()).map((r) => r.id)).toEqual([T0]);
		expect(await m.getPoints(T0)).toHaveLength(1);
		await m.putStoredPlan({ id: 'p1', yaml: 'routes:\n', savedAtMs: T0 });
		expect(await m.getStoredPlans()).toEqual([{ id: 'p1', yaml: 'routes:\n', savedAtMs: T0 }]);
		await m.putStoredLink({ id: T0, catalogHash: 'h', planId: 'p1', labels: ['LFPL - LFFN'] });
		expect(await m.getStoredLinks()).toHaveLength(1);
	});

	it('v2 re-keys the plan catalog from the file name to an id', async () => {
		await seedLegacy(
			2,
			(d) => {
				d.createObjectStore('outings', { keyPath: 'id' });
				d.createObjectStore('points', { keyPath: 'id' });
				// v2 keyed a remembered plan by the imported FILE NAME.
				d.createObjectStore('plans', { keyPath: 'name' });
			},
			(d) => {
				const tx = d.transaction('plans', 'readwrite');
				tx.objectStore('plans').put({ name: 'montargis.yaml', yaml: 'routes:\n', savedAtMs: T0 });
				tx.objectStore('plans').put({ name: 'brienne.yaml', yaml: 'routes: []\n', savedAtMs: 7 });
			},
		);
		const m = await db();
		const plans = (await m.getStoredPlans()).sort((a, b) => a.id.localeCompare(b.id));
		// The old name becomes the id, so a persisted provenance pointer
		// still matches; the name itself is not kept anywhere.
		expect(plans).toEqual([
			{ id: 'brienne.yaml', yaml: 'routes: []\n', savedAtMs: 7 },
			{ id: 'montargis.yaml', yaml: 'routes:\n', savedAtMs: T0 },
		]);
		// And the store now takes an id-keyed put, which the v2 keyPath
		// would have rejected for ever.
		await m.putStoredPlan({ id: 'p2', yaml: 'routes:\n#x\n', savedAtMs: 9 });
		expect((await m.getStoredPlans()).some((p) => p.id === 'p2')).toBe(true);
	});

	it('v2 rows with no usable yaml are dropped rather than re-keyed', async () => {
		await seedLegacy(
			2,
			(d) => {
				d.createObjectStore('outings', { keyPath: 'id' });
				d.createObjectStore('points', { keyPath: 'id' });
				d.createObjectStore('plans', { keyPath: 'name' });
			},
			(d) => {
				const tx = d.transaction('plans', 'readwrite');
				tx.objectStore('plans').put({ name: 'broken.yaml', savedAtMs: T0 });
			},
		);
		const m = await db();
		expect(await m.getStoredPlans()).toEqual([]);
	});

	/* The upgrade EVERY existing user makes. The v1 and v2 cases above cover
	 * the stores that were added with a migration; this one covers the
	 * ordinary case, where a full library gains an empty store and keeps
	 * every row it had. */
	it('v4 gains the sources store and keeps the library', async () => {
		await seedLegacy(
			4,
			(d) => {
				for (const name of ['outings', 'points', 'plans', 'links']) {
					d.createObjectStore(name, { keyPath: 'id' });
				}
			},
			(d) => {
				const tx = d.transaction(['outings', 'points', 'plans'], 'readwrite');
				tx.objectStore('outings').put({
					id: T0,
					savedAtMs: T0,
					datum: 'msl',
					aircraftKey: 'F-GORQ',
					remarks: '',
					source: 'trace',
					derivedV: 4,
					flights: [flight()],
				});
				tx.objectStore('points').put({ id: T0, points: [{ lat: 1, lon: 2, altFt: null, timeMs: T0 }] });
				tx.objectStore('plans').put({ id: 'p1', yaml: 'routes:\n', savedAtMs: T0 });
			},
		);
		const m = await db();
		const metas = await m.getMetas();
		expect(metas).toHaveLength(1);
		expect(metas[0].aircraftKey).toBe('F-GORQ');
		expect(await m.getPoints(T0)).toHaveLength(1);
		expect(await m.getStoredPlans()).toHaveLength(1);
		// The new store exists and is simply empty: a row filed before v5 has
		// no source and synthesises on export, exactly as it did.
		expect(await m.getTraceSource(T0)).toBeNull();
		// And it takes one now, so the upgrade left it usable.
		const gpx = new TextEncoder().encode('<gpx/>');
		await m.putOuting(metas[0], [{ lat: 1, lon: 2, altFt: null, timeMs: T0 }], {
			name: 'a.gpx',
			format: 'gpx',
			bytes: gpx,
		});
		expect(await m.getTraceSource(T0)).toEqual({ name: 'a.gpx', format: 'gpx', bytes: gpx });
	});
});

describe('normalizeMeta at the read chokepoint', () => {
	/** Seed one row straight into the CURRENT schema's store, shaped as an
	 *  older era wrote it. */
	async function seedRaw(row: Record<string, unknown>): Promise<void> {
		const m = await db();
		// Touch the module's own connection first, so the stores exist.
		await m.getMetas();
		await new Promise<void>((resolve, reject) => {
			const req = indexedDB.open('loxodrome-flights');
			req.onerror = () => reject(new Error('raw open failed'));
			req.onsuccess = () => {
				const d = req.result;
				const tx = d.transaction('outings', 'readwrite');
				tx.objectStore('outings').put(row);
				tx.oncomplete = () => {
					d.close();
					resolve();
				};
				tx.onerror = () => reject(new Error('raw put failed'));
			};
		});
	}

	it('strips the frozen-copy era fields and PERSISTS the strip', async () => {
		await seedRaw({
			id: T0,
			savedAtMs: T0,
			datum: 'msl',
			aircraftKey: null,
			remarks: '',
			source: 'trace',
			derivedV: 4,
			flights: [flight()],
			// The era when an outing carried its plan: kilobytes per row,
			// and an assertion the dynamic link replaced.
			planYaml: 'routes:\n  - name: old\n',
			planId: 'p-old',
			routeLabels: ['LFPL - LFFN'],
		});
		const m = await db();
		const [row] = await m.getMetas();
		expect(row).not.toHaveProperty('planYaml');
		expect(row).not.toHaveProperty('planId');
		expect(row).not.toHaveProperty('routeLabels');
		// The reclaim reaches the STORE, not only this read: a row already
		// at DERIVED_V is never re-derived, so nothing else would ever drop
		// the blob.
		await new Promise((r) => setTimeout(r, 0));
		vi.resetModules();
		const again = await db();
		const [stored] = await again.getMetas();
		expect(stored).not.toHaveProperty('planYaml');
	});

	it('carries an old logbook row routeLabels into remarks', async () => {
		await seedRaw({
			id: T0,
			savedAtMs: T0,
			datum: 'msl',
			aircraftKey: 'F-GIKP',
			source: 'logbook',
			derivedV: 4,
			flights: [flight()],
			// No `remarks` at all, the shape before the field existed.
			routeLabels: ['LFPL - LFOX', 'LFOX - LFPL'],
		});
		const m = await db();
		const [row] = await m.getMetas();
		expect(row.remarks).toBe('LFPL - LFOX / LFOX - LFPL');
		expect(row.source).toBe('logbook');
	});

	it('stamps a row written before `source` existed as a trace', async () => {
		await seedRaw({
			id: T0,
			savedAtMs: T0,
			datum: 'msl',
			aircraftKey: null,
			remarks: '',
			derivedV: 4,
			flights: [flight()],
		});
		const m = await db();
		const [row] = await m.getMetas();
		expect(row.source).toBe('trace');
		expect(row.remarks).toBe('');
	});
});

describe('the connection', () => {
	it('does not memoise a failed open, so a later call retries', async () => {
		const m = await db();
		const real = indexedDB.open.bind(indexedDB);
		let fail = true;
		vi.spyOn(indexedDB, 'open').mockImplementation((name: string, version?: number) => {
			if (!fail) {
				return real(name, version);
			}
			// What a blocked upgrade or a corrupt store does: a request that
			// only ever errors. The promise MUST settle either way; memoised
			// unsettled, the surface would sit on "Loading" for ever and
			// every archive await with it.
			const stub: { onerror: ((e: Event) => void) | null } = { onerror: null };
			setTimeout(() => stub.onerror?.(new Event('error')), 0);
			return stub as unknown as IDBOpenDBRequest;
		});
		// A write propagates its failure (silently losing a flight is the
		// one thing this store may not do), which is what proves the open
		// really failed rather than finding an empty database.
		await expect(
			m.putStoredPlan({ id: 'p1', yaml: 'routes:\n', savedAtMs: T0 }),
		).rejects.toThrow();
		fail = false;
		vi.restoreAllMocks();
		// The rejection was not memoised: this opens for real.
		await m.putStoredPlan({ id: 'p1', yaml: 'routes:\n', savedAtMs: T0 });
		expect(await m.getStoredPlans()).toHaveLength(1);
	});

	it('reopens after the browser closes the connection under it', async () => {
		const m = await db();
		await m.putStoredPlan({ id: 'p1', yaml: 'routes:\n', savedAtMs: T0 });
		// What storage pressure does: the handle stays memoised but every
		// transaction on it throws, which the reads would turn into an
		// empty library for the rest of the session.
		const conn = await new Promise<IDBDatabase>((resolve) => {
			const req = indexedDB.open('loxodrome-flights');
			req.onsuccess = () => resolve(req.result);
		});
		conn.close();
		expect(await m.getStoredPlans()).toHaveLength(1);
	});

	it('clears every store, the plan catalog included', async () => {
		const m = await db();
		await m.putOuting(
			{
				id: T0,
				savedAtMs: T0,
				datum: 'msl',
				aircraftKey: null,
				remarks: '',
				source: 'trace',
				derivedV: 4,
				flights: [flight()],
			},
			[{ lat: 1, lon: 2, altFt: null, timeMs: T0 }],
		);
		await m.putStoredPlan({ id: 'p1', yaml: 'routes:\n', savedAtMs: T0 });
		await m.putStoredLink({ id: T0, catalogHash: 'h', planId: 'p1', labels: [] });
		await m.clearAllOutings();
		expect(await m.getMetas()).toEqual([]);
		expect(await m.getPoints(T0)).toBeNull();
		expect(await m.getStoredPlans()).toEqual([]);
		expect(await m.getStoredLinks()).toEqual([]);
	});

	it('deleting an outing drops its points and its cached link', async () => {
		const m = await db();
		await m.putOuting(
			{
				id: T0,
				savedAtMs: T0,
				datum: 'msl',
				aircraftKey: null,
				remarks: '',
				source: 'trace',
				derivedV: 4,
				flights: [flight()],
			},
			[{ lat: 1, lon: 2, altFt: null, timeMs: T0 }],
		);
		await m.putStoredLink({ id: T0, catalogHash: 'h', planId: 'p1', labels: ['x'] });
		await m.deleteOuting(T0);
		expect(await m.getMeta(T0)).toBeNull();
		expect(await m.getPoints(T0)).toBeNull();
		expect(await m.getStoredLinks()).toEqual([]);
	});
});

/* The pristine source store (v5). The bytes an imported trace arrived as are
 * the one thing in this library that cannot be regenerated, so what is pinned
 * here is that they survive, and that the paths which do NOT know about them
 * cannot delete them by accident. */
describe('the trace source store', () => {
	const META: OutingMeta = {
		id: T0,
		savedAtMs: T0,
		datum: 'msl',
		aircraftKey: null,
		remarks: '',
		source: 'trace',
		derivedV: 4,
		flights: [flight()],
	};
	const PTS = [{ lat: 1, lon: 2, altFt: null, timeMs: T0 }];
	const GPX = '<?xml version="1.0"?><gpx><trk><name>Étampes</name></trk></gpx>';
	const enc = new TextEncoder();
	/* A BOM and an ISO-8859-1 byte: the two things a string round trip
	 * destroys, which is why the store keeps BYTES. */
	const RAW = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('HFPLT:H'), 0xe9, 0x6c, 0x69, 0x6f]);

	it('round-trips a source through deflate, accents and all', async () => {
		const m = await db();
		await m.putOuting(META, PTS, {
			name: '2026-05-12_LFPL.gpx',
			format: 'gpx',
			bytes: enc.encode(GPX),
		});
		expect(await m.getTraceSource(T0)).toEqual({
			name: '2026-05-12_LFPL.gpx',
			format: 'gpx',
			bytes: enc.encode(GPX),
		});
	});

	/* The promise the feature makes. A BOM disappears through
	 * TextDecoder/TextEncoder and a Latin-1 byte becomes U+FFFD, so a source
	 * stored as TEXT would hand back a different document - and an IGC whose
	 * bytes moved is one whose G record no longer validates. */
	it('returns bytes UNCHANGED, BOM and non-UTF-8 alike', async () => {
		const m = await db();
		await m.putOuting(META, PTS, { name: 'logger.igc', format: 'igc', bytes: RAW });
		const back = await m.getTraceSource(T0);
		expect(back?.bytes).toEqual(RAW);
	});

	/* The name reaches ZIP entry names and Filesystem paths. */
	it('reduces a member path to a base name', async () => {
		const m = await db();
		await m.putOuting(META, PTS, { name: 'files/../../doc.kml', format: 'kml', bytes: RAW });
		expect((await m.getTraceSource(T0))?.name).toBe('doc.kml');
	});

	it('has none for a recording, and none for a row written before v5', async () => {
		const m = await db();
		await m.putOuting(META, PTS, null);
		expect(await m.getTraceSource(T0)).toBeNull();
		expect(await m.getTraceSource(T0 + 1)).toBeNull();
	});

	/* The three-state contract. A re-archive that knows nothing about the
	 * file (the crash-copy restore re-files a DOWNSAMPLED trace under the same
	 * id) must leave the bytes alone, while an extend that knowingly no longer
	 * matches them must take them away. */
	it('leaves a stored source alone when the caller has no opinion', async () => {
		const m = await db();
		await m.putOuting(META, PTS, { name: 'a.igc', format: 'igc', bytes: enc.encode('AXLOX') });
		await m.putOuting(META, PTS);
		expect(await m.getTraceSource(T0)).not.toBeNull();
	});

	it('deletes it when the caller says the points are no longer the file', async () => {
		const m = await db();
		await m.putOuting(META, PTS, { name: 'a.igc', format: 'igc', bytes: enc.encode('AXLOX') });
		await m.putOuting(META, [...PTS, { lat: 1, lon: 2, altFt: null, timeMs: T0 + 1000 }], null);
		expect(await m.getTraceSource(T0)).toBeNull();
	});

	it('goes with the outing, and with the wipe', async () => {
		const m = await db();
		await m.putOuting(META, PTS, { name: 'a.kml', format: 'kml', bytes: enc.encode('<kml/>') });
		await m.deleteOuting(T0);
		expect(await m.getTraceSource(T0)).toBeNull();

		await m.putOuting(META, PTS, { name: 'a.kml', format: 'kml', bytes: enc.encode('<kml/>') });
		await m.clearAllOutings();
		expect(await m.getTraceSource(T0)).toBeNull();
	});
});
