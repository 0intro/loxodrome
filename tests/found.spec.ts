/* What a shared session's sign-in found (sync/found.ts): the copy is read
 * defensively, a damaged one being no copy at all (the end then removes
 * nothing found and puts nothing back), parsed once per stored value, since
 * the flight button asks it at every decision, and taken from the STORES,
 * never a document's memory: each plane, the grades and the pilot block when
 * they hold anything, every plan and flight row, and the traces the device
 * holds unfiled. A store that cannot be read leaves the rows unlisted, and
 * no write of a plan or a flight lands until they are listed and copied:
 * the flights store's write guard completes the copy first, or fails the
 * write. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { memoryStorage, type MemoryStorage } from './helpers/storage';
import { FOUND_KEY } from '$lib/sync/keys';

let ls: MemoryStorage;

beforeEach(() => {
	vi.resetModules();
	ls = memoryStorage({
		'loxodrome:pilot': '{"name":"CLUB PC"}',
		'loxodrome:aircraft-user': JSON.stringify({ v: 1, planes: { 'F-CLUB': 'club', 'F-OTHER': 'other' } }),
	});
	vi.stubGlobal('localStorage', ls);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the found copy', () => {
	it('reads a damaged copy as none', async () => {
		const found = await import('$lib/sync/found');
		for (const raw of ['x', '{"v":2}', JSON.stringify({ v: 1, userId: 'u', keys: 'all', planes: {} })]) {
			ls.setItem(FOUND_KEY, raw);
			expect(found.readFoundCopy(), raw).toBeNull();
		}
		ls.setItem(FOUND_KEY, JSON.stringify({ v: 1, userId: 'u', keys: ['a', 7], planes: {}, trace: 'soon' }));
		expect(found.readFoundCopy()).toEqual({
			v: 1,
			userId: 'u',
			keys: ['a'],
			pilot: null,
			fuel: null,
			parked: false,
			planes: {},
			trace: null,
			listed: true,
			rows: false,
		});
	});

	it('parses once per stored value', async () => {
		const found = await import('$lib/sync/found');
		ls.setItem(FOUND_KEY, JSON.stringify({ v: 1, userId: 'u', keys: [], planes: {}, trace: 42 }));
		const first = found.readFoundCopy();
		expect(found.foundTrace()).toBe(42);
		expect(found.readFoundCopy()).toBe(first);
		ls.setItem(FOUND_KEY, JSON.stringify({ v: 1, userId: 'u', keys: [], planes: {}, trace: 43 }));
		expect(found.foundTrace()).toBe(43);
		ls.removeItem(FOUND_KEY);
		expect(found.foundTrace()).toBeNull();
	});

	it('takes the storage-held half from storage, and leaves the rows unlisted when no store can be read', async () => {
		// No IndexedDB at all; a blank grades map and a parked outbox beside.
		ls.setItem('loxodrome:aircraft-fuel', JSON.stringify({ v: 1, types: {} }));
		ls.setItem(
			'loxodrome:nav-trace-parked',
			JSON.stringify({ v: 1, recording: false, points: [{ lat: 48, lon: 2, timeMs: 9_000 }, { lat: 48, lon: 2, timeMs: 7_000 }] }),
		);
		const found = await import('$lib/sync/found');
		const { copy, stored } = await found.takeFoundCopy('u', 5_000);
		expect(stored).toBe(true);
		expect(copy).toMatchObject({
			// Every plane, the pilot block holding something, no grades map
			// that holds none, the live trace found stopped and the outbox's
			// flight by its first fix; no rows, none could be listed.
			keys: ['aircraft/F-CLUB', 'aircraft/F-OTHER', 'pilot/pilot', 'outings/5000', 'outings/7000'],
			pilot: '{"name":"CLUB PC"}',
			fuel: null,
			planes: { 'F-CLUB': 'club', 'F-OTHER': 'other' },
			trace: 5_000,
			listed: false,
			rows: false,
		});
		expect(found.readFoundCopy()).toEqual(copy);
		expect(found.foundOuting(7_000)).toBe(true);
		expect(found.foundOuting(8_000)).toBe(false);
		await expect(found.clearFoundRows()).resolves.toBeUndefined();
	});

	it('finds the live trace from its crash copy, unless a recording runs', async () => {
		// Written by another tab, or kept by the end of the session a sign-in
		// over it ended: no document's memory names it.
		ls.setItem(
			'loxodrome:nav-trace',
			JSON.stringify({ v: 1, recording: false, points: [{ lat: 48, lon: 2, timeMs: 6_000 }] }),
		);
		const found = await import('$lib/sync/found');
		const { copy } = await found.takeFoundCopy('u', null);
		expect(copy.keys).toContain('outings/6000');
		expect(copy.trace).toBe(6_000);
		expect(found.holdsFoundTrace('loxodrome:nav-trace', copy)).toBe(true);
		expect(found.holdsFoundTrace('loxodrome:nav-trace-parked', copy)).toBe(false);
		// A recording in some tab owns the crash copy: that flight is the
		// session's, whose stamp came late.
		const flying = await found.takeFoundCopy('u', null, true);
		expect(flying.copy.keys).not.toContain('outings/6000');
		expect(flying.copy.trace).toBeNull();
	});

	it('copies every row it lists', async () => {
		globalThis.indexedDB = new IDBFactory();
		const found = await import('$lib/sync/found');
		const db = await import('$lib/state/flightsDb');
		await db.putStoredPlan({ id: 'p1', yaml: 'one', savedAtMs: 1 });
		await db.putStoredPlan({ id: 'p2', yaml: 'two', savedAtMs: 2 });
		const { copy } = await found.takeFoundCopy('u', null);
		expect(copy).toMatchObject({ listed: true, rows: true });
		expect(copy.keys).toEqual(['aircraft/F-CLUB', 'aircraft/F-OTHER', 'pilot/pilot', 'plans/p1', 'plans/p2']);
		const rows = await found.readFoundRows();
		expect(rows?.get('plans/p1')?.plan).toEqual({ id: 'p1', yaml: 'one', savedAtMs: 1 });
		await found.clearFoundRows();
		expect((await found.readFoundRows())?.size).toBe(0);
	});

	it('lets no plan or flight be written until a copy missing its rows is whole', async () => {
		globalThis.indexedDB = new IDBFactory();
		const found = await import('$lib/sync/found');
		const db = await import('$lib/state/flightsDb');
		await db.putStoredPlan({ id: 'p1', yaml: 'one', savedAtMs: 1 });
		await db.putStoredPlan({ id: 'p2', yaml: 'two', savedAtMs: 2 });
		// A sign-in whose store could not be read: the rows unlisted.
		ls.setItem(FOUND_KEY, JSON.stringify({ v: 1, userId: 'u', keys: ['pilot/pilot'], planes: {}, listed: false }));
		// The store reads again. Still unreadable for the first write: it fails,
		// and lands nothing.
		const read = vi.spyOn(db, 'getStoredPlansStrict').mockRejectedValueOnce(new Error('blocked'));
		await expect(db.putStoredPlan({ id: 'p3', yaml: 'three', savedAtMs: 1 })).rejects.toThrow();
		expect((await db.getStoredPlans()).map((p) => p.id)).toEqual(['p1', 'p2']);
		read.mockRestore();
		// The session's next writes: a plan a bundle restores with an OLD time,
		// a found plan stored back over, another renamed under its own time.
		await db.putStoredPlan({ id: 'p3', yaml: 'three', savedAtMs: 1 });
		await db.putStoredPlan({ id: 'p1', yaml: 'one, edited', savedAtMs: 99 });
		await db.putStoredPlan({ id: 'p2', yaml: 'two, renamed', savedAtMs: 2 });
		// The copy was completed before the first of them landed: the found
		// set is what the sign-in found, and the rows as they were.
		expect(found.readFoundCopy()).toMatchObject({ listed: true, keys: ['pilot/pilot', 'plans/p1', 'plans/p2'] });
		const rows = await found.readFoundRows();
		expect(rows?.get('plans/p1')?.plan?.yaml).toBe('one');
		expect(rows?.get('plans/p2')?.plan?.yaml).toBe('two');
		expect(rows?.has('plans/p3')).toBe(false);
	});

	/** A store holding p1, a copy missing its rows, and the first listing of
	 *  the plans held until `release` (what a slow store does to the stamp's
	 *  own completion). */
	async function heldListing() {
		globalThis.indexedDB = new IDBFactory();
		const found = await import('$lib/sync/found');
		const db = await import('$lib/state/flightsDb');
		await db.putStoredPlan({ id: 'p1', yaml: 'one', savedAtMs: 1 });
		const copy = { v: 1 as const, userId: 'u', keys: [], pilot: null, fuel: null, parked: false, planes: {}, trace: null, listed: false, rows: false };
		ls.setItem(FOUND_KEY, JSON.stringify(copy));
		const real = db.getStoredPlansStrict;
		let release = (): void => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		vi.spyOn(db, 'getStoredPlansStrict').mockImplementationOnce(async () => {
			await gate;
			return real();
		});
		return { found, db, copy, release };
	}

	const ticks = async (n = 20): Promise<void> => {
		for (let i = 0; i < n; i++) {
			await new Promise((r) => setTimeout(r, 0));
		}
	};

	it('completes one copy at a time, so no later listing copies an edit for found', async () => {
		const { found, db, copy, release } = await heldListing();
		// The stamp's completion, held in its listing; meanwhile the pilot
		// edits the found plan, its write's guard completing too (as another
		// tab's completion would). Neither may run beside the other: the edit
		// would land, and the held listing copy it as found.
		const first = found.completeFoundCopy(copy);
		const write = db.putStoredPlan({ id: 'p1', yaml: 'one, edited', savedAtMs: 2 });
		await ticks();
		release();
		await Promise.all([first, write]);
		expect((await found.readFoundRows())?.get('plans/p1')?.plan?.yaml).toBe('one');
		expect((await db.getStoredPlans())[0].yaml).toBe('one, edited');
	});

	it('writes no copy back once an end has taken it', async () => {
		const { found, copy, release } = await heldListing();
		const done = found.completeFoundCopy(copy);
		await ticks();
		ls.removeItem(FOUND_KEY); // the session ends meanwhile, in another tab
		release();
		expect((await done).stored).toBe(false);
		expect(ls.getItem(FOUND_KEY)).toBeNull();
		// Nor the rows it had just copied.
		expect((await found.readFoundRows())?.size).toBe(0);
	});

	it('holds every write of a plan or a flight back', async () => {
		globalThis.indexedDB = new IDBFactory();
		await import('$lib/sync/found');
		const db = await import('$lib/state/flightsDb');
		ls.setItem(FOUND_KEY, JSON.stringify({ v: 1, userId: 'u', keys: [], planes: {}, listed: false }));
		const meta = { id: 1, savedAtMs: 1, datum: 'msl', aircraftKey: null, remarks: '', source: 'trace', derivedV: 0, flights: [] } as unknown as Parameters<typeof db.putMeta>[0];
		const writes = [
			() => db.putStoredPlan({ id: 'p', yaml: '', savedAtMs: 1 }),
			() => db.deleteStoredPlan('p'),
			() => db.putOuting(meta, [], null),
			() => db.putMeta(meta),
			() => db.deleteOuting(1),
		];
		for (const write of writes) {
			vi.spyOn(db, 'getMetasStrict').mockRejectedValueOnce(new Error('blocked'));
			await expect(write()).rejects.toThrow();
		}
		expect(await db.getStoredPlans()).toEqual([]);
		expect(await db.getMetas()).toEqual([]);
	});

	it('fails the write while the rows cannot be copied, though they list', async () => {
		// The sync-owned store refuses (an origin out of space, say): the copy
		// would hold no originals, so nothing may change the rows it lists.
		const factory = new IDBFactory();
		const open = factory.open.bind(factory);
		factory.open = (name: string, version?: number) => {
			if (name === 'loxodrome-sync') {
				throw new Error('QuotaExceededError');
			}
			return open(name, version);
		};
		globalThis.indexedDB = factory;
		await import('$lib/sync/found');
		const db = await import('$lib/state/flightsDb');
		ls.setItem(FOUND_KEY, JSON.stringify({ v: 1, userId: 'u', keys: [], planes: {}, listed: false }));
		await expect(db.putStoredPlan({ id: 'p', yaml: '', savedAtMs: 1 })).rejects.toThrow('found copy incomplete');
		expect(await db.getStoredPlans()).toEqual([]);
	});

	it('lets every write through once no copy is missing its rows', async () => {
		globalThis.indexedDB = new IDBFactory();
		await import('$lib/sync/found');
		const db = await import('$lib/state/flightsDb');
		// No copy at all (no shared session), and a whole one.
		await db.putStoredPlan({ id: 'p1', yaml: 'one', savedAtMs: 1 });
		ls.setItem(FOUND_KEY, JSON.stringify({ v: 1, userId: 'u', keys: [], planes: {}, listed: true }));
		const read = vi.spyOn(db, 'getStoredPlansStrict');
		await db.putStoredPlan({ id: 'p2', yaml: 'two', savedAtMs: 2 });
		expect(read).not.toHaveBeenCalled();
		expect((await db.getStoredPlans()).map((p) => p.id)).toEqual(['p1', 'p2']);
	});

	it('finds no pilot block that holds nothing, so the one the session types is its own', async () => {
		ls.setItem('loxodrome:pilot', JSON.stringify({ name: '', sepValidUntil: null, medicalValidUntil: null }));
		const found = await import('$lib/sync/found');
		const { copy } = await found.takeFoundCopy('u', null);
		expect(copy.keys).not.toContain('pilot/pilot');
		expect(copy.pilot).toBeNull();
		ls.removeItem('loxodrome:pilot');
		expect((await found.takeFoundCopy('u', null)).copy.keys).not.toContain('pilot/pilot');
	});

	it('sets the found pilot block aside only while it holds what was found', async () => {
		const found = await import('$lib/sync/found');
		const { copy } = await found.takeFoundCopy('u', null);
		ls.setItem('loxodrome:pilot', '{"name":"TYPED"}');
		expect((await found.parkFoundPilot(copy)).parked).toBe(false);
		expect(ls.getItem('loxodrome:pilot')).toBe('{"name":"TYPED"}');
		ls.setItem('loxodrome:pilot', '{"name":"CLUB PC"}');
		const parked = await found.parkFoundPilot(copy);
		expect(parked.parked).toBe(true);
		expect(JSON.parse(ls.getItem('loxodrome:pilot') ?? '')).toEqual({ name: '', sepValidUntil: null, medicalValidUntil: null });
		expect(found.readFoundCopy()?.parked).toBe(true);
	});
});
