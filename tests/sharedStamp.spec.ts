/* A SHARED sign-in's stamp (state/sync.svelte.ts stampSharedSession,
 * docs/accounts-sync.md "The wipe knows what is the account's"): beside the
 * held-back set every sign-in stamps, it takes a copy of what it FOUND, from
 * the stores (sync/found.ts), which the session's end puts back as found,
 * and it sets the found pilot block aside, the session's pilot block being
 * its own pilot's. A same-account sign-in inside the session takes nothing
 * new, or the session's own unsynced work would be taken for found; an owed
 * stamp lands from the copy it took; a store that cannot be read leaves the
 * rows to be listed before the session's first write lands, everything else
 * taken at once; the flights the device held unfiled are found by their
 * outing ids; a found plan Stored while the stamp is owed is not held back
 * when it lands; a copy storage refuses leaves the stamp as it was before
 * the copy existed. The sign-out valve counts what the next pass would push,
 * the found documents the session made its pilot's among it. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { memoryStorage, type MemoryStorage } from './helpers/storage';
import { ACCOUNT_KEY, FOUND_KEY, SHARED_FLAG_KEY, SYNC_REGISTRY_KEY } from '$lib/sync/keys';
import type { OutingMeta } from '$lib/state/flightsDb';

const local = vi.hoisted(() => ({
	docs: [] as { col: string; id: string; payloadText: string }[],
}));

// The sync module reaches Leaflet through the flight import (fitRoute ->
// map/focus), which needs a window to evaluate; nothing here draws.
vi.mock('leaflet', () => ({ default: {} }));

vi.mock('$lib/sync/adapters', async (original) => ({
	...(await original<typeof import('$lib/sync/adapters')>()),
	listLocalDocs: vi.fn(() => Promise.resolve(local.docs)),
}));

vi.mock('$lib/sync/protocol', async (original) => {
	const real = await original<typeof import('$lib/sync/protocol')>();
	return {
		...real,
		fetchChanges: vi.fn(() => Promise.reject(new real.ApiError('network', 0))),
	};
});

const T0 = Date.UTC(2026, 9, 1, 9, 0);
const PILOT = JSON.stringify({ name: 'CLUB PC', sepValidUntil: '2027-05-31', medicalValidUntil: null });
const BLANK = JSON.stringify({ name: '', sepValidUntil: null, medicalValidUntil: null });
const FUEL = JSON.stringify({ v: 1, types: { 'F-CLUB': 'UL91' } });

const doc = (key: string) => {
	const [col, id] = key.split('/');
	return { col, id, payloadText: key };
};

const FOUND = ['aircraft/F-CLUB', 'acstate/tanked-fuel', 'pilot/pilot', 'plans/p1', 'outings/8'];

let ls: MemoryStorage;

function account(userId = 'uA'): void {
	ls.setItem(
		ACCOUNT_KEY,
		JSON.stringify({ v: 1, token: 'T', email: 'a@example.com', userId, mode: 'shared', status: 'active', signedInAtMs: T0 }),
	);
	ls.setItem(SHARED_FLAG_KEY, '1');
}

beforeEach(async () => {
	vi.resetModules();
	globalThis.indexedDB = new IDBFactory();
	ls = memoryStorage({
		'loxodrome:pilot': PILOT,
		'loxodrome:aircraft-fuel': FUEL,
		'loxodrome:aircraft-user': JSON.stringify({ v: 1, planes: { 'F-CLUB': 'club' } }),
	});
	vi.stubGlobal('localStorage', ls);
	vi.stubGlobal('sessionStorage', memoryStorage());
	vi.stubGlobal(
		'fetch',
		vi.fn(() => Promise.reject(new Error('offline'))),
	);
	account();
	local.docs = FOUND.map(doc);
	const db = await import('$lib/state/flightsDb');
	await db.putStoredPlan({ id: 'p1', yaml: 'version: 1\n', savedAtMs: T0 });
	await db.putOuting(
		{ id: 8, savedAtMs: T0, datum: 'msl', aircraftKey: null, remarks: '', source: 'trace', derivedV: 0, flights: [] } as unknown as OutingMeta,
		[{ lat: 48, lon: 2, altFt: null, timeMs: 8 }],
		null,
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const stored = (key: string): Record<string, unknown> =>
	JSON.parse(ls.getItem(key) ?? 'null') as Record<string, unknown>;

/** The sign-in's engine half. A FRESH sign-in owes its stamp from the
 *  commit, which records the debt before the account
 *  (state/account.svelte.ts commitSignIn); the same account signing back
 *  into its own session owes nothing new. */
async function signIn(fresh = true): Promise<typeof import('$lib/state/sync.svelte')> {
	if (fresh) {
		const reg = JSON.parse(ls.getItem(SYNC_REGISTRY_KEY) ?? 'null') as Record<string, unknown> | null;
		ls.setItem(
			SYNC_REGISTRY_KEY,
			JSON.stringify({ v: 1, deviceId: 'd', lastSeq: 0, docs: {}, tombstones: [], ...reg, stampPending: true }),
		);
	}
	const s = await import('$lib/state/sync.svelte');
	await s.afterSignIn(false, false);
	return s;
}

describe("a shared sign-in's stamp", () => {
	it('takes what it found, and sets the pilot block aside', { timeout: 30_000 }, async () => {
		const { nav } = await import('$lib/state/navRecording.svelte');
		nav.points = [{ lat: 48, lon: 2, timeMs: T0 - 3_600_000, altFt: 400 }];
		nav.recording = false;
		await signIn();
		const live = `outings/${T0 - 3_600_000}`;
		// The storage-held half first (the live trace's flight with it), then
		// the rows.
		const keys = ['aircraft/F-CLUB', 'acstate/tanked-fuel', 'pilot/pilot', live, 'plans/p1', 'outings/8'];
		expect(stored(FOUND_KEY)).toMatchObject({
			v: 1,
			userId: 'uA',
			keys,
			pilot: PILOT,
			fuel: FUEL,
			parked: true,
			planes: { 'F-CLUB': 'club' },
			trace: T0 - 3_600_000,
			listed: true,
			rows: true,
		});
		const found = await import('$lib/sync/found');
		expect([...((await found.readFoundRows())?.keys() ?? [])].sort()).toEqual(['outings/8', 'plans/p1']);
		// Held back as at any sign-in, but the pilot block: the session's is
		// its own pilot's, blank until typed or pulled. The flight the device
		// held stopped is found too, filed yet or not.
		expect(stored(SYNC_REGISTRY_KEY).preexisting).toEqual(keys.filter((k) => k !== 'pilot/pilot'));
		expect(ls.getItem('loxodrome:pilot')).toBe(BLANK);
		const { flightPrep } = await import('$lib/state/flightPrep.svelte');
		expect(flightPrep.dossier.pilot.name).toBe('');
	});

	it('takes nothing new when the same account signs in again inside the session', { timeout: 30_000 }, async () => {
		await signIn();
		const copy = ls.getItem(FOUND_KEY);
		const held = stored(SYNC_REGISTRY_KEY).preexisting;
		// The session goes on: its pilot types theirs, stores a plan, the
		// token lapses, the pilot signs in again.
		ls.setItem('loxodrome:pilot', JSON.stringify({ name: 'BOB BAKER', sepValidUntil: null, medicalValidUntil: null }));
		const db = await import('$lib/state/flightsDb');
		await db.putStoredPlan({ id: 'p-mine', yaml: 'version: 1\n', savedAtMs: Date.now() });
		vi.resetModules();
		await signIn(false);
		expect(ls.getItem(FOUND_KEY)).toBe(copy);
		expect(stored(SYNC_REGISTRY_KEY).preexisting).toEqual(held);
		expect(stored('loxodrome:pilot').name).toBe('BOB BAKER');
	});

	it('lands an owed stamp from the copy it took', { timeout: 30_000 }, async () => {
		// The copy was written, the registry not: the retry finds both.
		ls.setItem(
			FOUND_KEY,
			JSON.stringify({ v: 1, userId: 'uA', keys: FOUND, pilot: PILOT, fuel: FUEL, parked: false, planes: {}, trace: null, rows: true }),
		);
		ls.setItem(SYNC_REGISTRY_KEY, JSON.stringify({ v: 1, deviceId: 'd', lastSeq: 0, docs: {}, tombstones: [], stampPending: true }));
		local.docs = [...FOUND, 'plans/p-mine'].map(doc);
		await signIn();
		expect(stored(SYNC_REGISTRY_KEY).stampPending).toBeUndefined();
		// What came after the copy is the session's, and is not held back.
		expect(stored(SYNC_REGISTRY_KEY).preexisting).toEqual(FOUND.filter((k) => k !== 'pilot/pilot'));
		expect(stored(FOUND_KEY).parked).toBe(true);
		expect(ls.getItem('loxodrome:pilot')).toBe(BLANK);
	});

	it('holds a found pilot block back rather than set aside one already edited', { timeout: 30_000 }, async () => {
		// An owed stamp lands after the pilot typed into the found block: what
		// it holds is no longer what was found, so it stays held back (and the
		// end puts the found one back).
		ls.setItem(
			FOUND_KEY,
			JSON.stringify({ v: 1, userId: 'uA', keys: FOUND, pilot: PILOT, fuel: FUEL, parked: false, planes: {}, trace: null, rows: true }),
		);
		ls.setItem(SYNC_REGISTRY_KEY, JSON.stringify({ v: 1, deviceId: 'd', lastSeq: 0, docs: {}, tombstones: [], stampPending: true }));
		const typed = JSON.stringify({ name: 'BOB BAKER', sepValidUntil: '2027-05-31', medicalValidUntil: null });
		ls.setItem('loxodrome:pilot', typed);
		await signIn();
		expect(ls.getItem('loxodrome:pilot')).toBe(typed);
		expect(stored(SYNC_REGISTRY_KEY).preexisting).toEqual(FOUND);
	});

	it("takes its own copy over another account's", { timeout: 30_000 }, async () => {
		ls.setItem(
			FOUND_KEY,
			JSON.stringify({ v: 1, userId: 'uB', keys: ['plans/old'], pilot: null, fuel: null, parked: false, planes: {}, trace: null, rows: false }),
		);
		await signIn();
		expect(stored(FOUND_KEY)).toMatchObject({ userId: 'uA', keys: FOUND });
	});

	it('stamps as before when storage refuses the copy, setting nothing aside', { timeout: 30_000 }, async () => {
		const set = ls.setItem.bind(ls);
		ls.setItem = (k: string, v: string) => {
			if (k === FOUND_KEY) {
				throw new Error('quota');
			}
			set(k, v);
		};
		await signIn();
		expect(ls.getItem(FOUND_KEY)).toBeNull();
		expect(stored(SYNC_REGISTRY_KEY).preexisting).toEqual(FOUND);
		expect(stored(SYNC_REGISTRY_KEY).stampPending).toBeUndefined();
		expect(ls.getItem('loxodrome:pilot')).toBe(PILOT);
	});

	it('finds no trace a recording carries through the sign-in', { timeout: 30_000 }, async () => {
		const { nav } = await import('$lib/state/navRecording.svelte');
		nav.points = [{ lat: 48, lon: 2, timeMs: T0, altFt: 400 }];
		nav.recording = true;
		// Its crash copy in storage is the session's flight too.
		ls.setItem('loxodrome:nav-trace', JSON.stringify({ v: 1, recording: true, points: nav.points }));
		await signIn();
		expect(stored(FOUND_KEY).trace).toBeNull();
		expect(stored(FOUND_KEY).keys).not.toContain(`outings/${T0}`);
	});

	it('takes the rest at once when a store cannot be read, and lists the rows before the first write', { timeout: 30_000 }, async () => {
		const db = await import('$lib/state/flightsDb');
		vi.spyOn(db, 'getStoredPlansStrict').mockRejectedValueOnce(new Error('blocked'));
		await signIn();
		// Owed, with the storage-held half taken and the pilot block set
		// aside already: nothing the pilot types next is taken for found.
		expect(stored(FOUND_KEY)).toMatchObject({ listed: false, parked: true, keys: ['aircraft/F-CLUB', 'acstate/tanked-fuel', 'pilot/pilot'] });
		expect(ls.getItem('loxodrome:pilot')).toBe(BLANK);
		expect(stored(SYNC_REGISTRY_KEY).stampPending).toBe(true);
		// The store reads again; the pilot stores a plan, one a backup restores
		// under an OLD time, before the owed stamp is taken again (the next
		// pass's first step, here the same call): its write completed the copy
		// first, so it is no leftover whatever its time.
		await db.putStoredPlan({ id: 'p-mine', yaml: 'version: 1\n', savedAtMs: 1 });
		expect(stored(FOUND_KEY)).toMatchObject({ listed: true });
		await signIn();
		expect(stored(SYNC_REGISTRY_KEY).stampPending).toBeUndefined();
		expect(stored(SYNC_REGISTRY_KEY).preexisting).toEqual(FOUND.filter((k) => k !== 'pilot/pilot'));
		expect(stored(FOUND_KEY)).toMatchObject({ listed: true, rows: true });
	});

	it('finds the flight the device held unfiled, which the session then files as the device\'s', { timeout: 30_000 }, async () => {
		// A boot parked a finished flight the library has not filed yet.
		const parked = T0 - 7_200_000;
		ls.setItem(
			'loxodrome:nav-trace-parked',
			JSON.stringify({ v: 1, recording: false, origin: 'recording', points: [{ lat: 48, lon: 2, timeMs: parked, altFt: 400 }] }),
		);
		await signIn();
		const key = `outings/${parked}`;
		expect(stored(SYNC_REGISTRY_KEY).preexisting).toContain(key);
		// The next boot's archive files it, and the session records one of its own.
		const db = await import('$lib/state/flightsDb');
		const meta = (id: number) =>
			({ id, savedAtMs: Date.now(), datum: 'msl', aircraftKey: null, remarks: '', source: 'trace', derivedV: 0, flights: [] }) as unknown as OutingMeta;
		await db.putOuting(meta(parked), [{ lat: 48, lon: 2, altFt: null, timeMs: parked }], null);
		await db.putOuting(meta(T0 + 60_000), [{ lat: 48, lon: 2, altFt: null, timeMs: T0 + 60_000 }], null);
		const { readSessionEnd, wipeSessionIdb } = await import('$lib/sync/wipe');
		await wipeSessionIdb(readSessionEnd(), Date.now() + 60_000);
		// The device's flight stays with the device; the session's goes.
		expect((await db.getMetas()).map((m) => m.id).sort((a, b) => a - b)).toEqual([8, parked]);
	});

	it('holds back no found plan a Store let go while the stamp was owed', { timeout: 30_000 }, async () => {
		const db = await import('$lib/state/flightsDb');
		vi.spyOn(db, 'getStoredPlansStrict').mockRejectedValueOnce(new Error('blocked'));
		await signIn();
		expect(stored(SYNC_REGISTRY_KEY).stampPending).toBe(true);
		// The store reads again; the pilot Activates the found plan and Stores
		// it back (state/activePlan storePlan): the write lists the rows first,
		// and the Store lets the plan go with nothing held back yet to let go.
		await db.putStoredPlan({ id: 'p1', yaml: 'version: 1\nname: MINE\n', savedAtMs: Date.now() });
		const { releaseHeldBack } = await import('$lib/state/syncRegistry');
		await releaseHeldBack('plans/p1');
		expect(stored(SYNC_REGISTRY_KEY).released).toEqual(['plans/p1']);
		// The owed stamp lands (the next pass's first step): the Store stands.
		await signIn();
		expect(stored(SYNC_REGISTRY_KEY).stampPending).toBeUndefined();
		expect(stored(SYNC_REGISTRY_KEY).released).toBeUndefined();
		expect(stored(SYNC_REGISTRY_KEY).preexisting).toEqual(
			FOUND.filter((k) => k !== 'pilot/pilot' && k !== 'plans/p1'),
		);
		// The device's own copy, as found, for the end to put back.
		const found = await import('$lib/sync/found');
		expect((await found.readFoundRows())?.get('plans/p1')?.plan?.yaml).toBe('version: 1\n');
	});

	it("counts the session's own work as unsent, by the stamp to come while it is owed", { timeout: 30_000 }, async () => {
		ls.setItem(
			FOUND_KEY,
			JSON.stringify({ v: 1, userId: 'uA', keys: FOUND, pilot: PILOT, fuel: FUEL, parked: true, planes: {}, trace: null, rows: true }),
		);
		ls.setItem(SYNC_REGISTRY_KEY, JSON.stringify({ v: 1, deviceId: 'd', lastSeq: 0, docs: {}, tombstones: [], stampPending: true }));
		// The found pilot block set aside lists as nothing (a blank block).
		local.docs = [...FOUND.filter((k) => k !== 'pilot/pilot'), 'plans/p-mine'].map(doc);
		const s = await import('$lib/state/sync.svelte');
		expect(await s.countPendingDocs()).toBe(1);
		// The pilot types theirs, and Stores the found plan back: both go to
		// the account once the stamp lands, and both are lost unsent.
		local.docs.push(doc('pilot/pilot'));
		const { releaseHeldBack } = await import('$lib/state/syncRegistry');
		await releaseHeldBack('plans/p1');
		expect(await s.countPendingDocs()).toBe(3);
	});

	it('counts no plan or flight while the rows are unlisted, every one of them found', { timeout: 30_000 }, async () => {
		// No write of one lands before the rows are listed, so the plans and
		// flights the device holds are the ones the stamp to come holds back.
		ls.setItem(
			FOUND_KEY,
			JSON.stringify({ v: 1, userId: 'uA', keys: ['aircraft/F-CLUB', 'acstate/tanked-fuel', 'pilot/pilot'], pilot: PILOT, fuel: FUEL, parked: true, planes: {}, trace: null, listed: false, rows: false }),
		);
		ls.setItem(SYNC_REGISTRY_KEY, JSON.stringify({ v: 1, deviceId: 'd', lastSeq: 0, docs: {}, tombstones: [], stampPending: true }));
		local.docs = FOUND.filter((k) => k !== 'pilot/pilot').map(doc);
		const s = await import('$lib/state/sync.svelte');
		expect(await s.countPendingDocs()).toBe(0);
	});

	it('counts what the next pass would push: the found documents the session made its pilot\'s, never one still held back', { timeout: 30_000 }, async () => {
		const s = await signIn();
		local.docs = FOUND.filter((k) => k !== 'pilot/pilot').map(doc);
		expect(await s.countPendingDocs()).toBe(0);
		// The pilot types theirs where the found block was set aside: not held
		// back, so the end, which puts the found block back, would lose it.
		local.docs.push(doc('pilot/pilot'));
		expect(await s.countPendingDocs()).toBe(1);
		// A found plan Stored back is let go, the same way; a found plane the
		// session edited is still held back, and was never going to upload.
		const { releaseHeldBack } = await import('$lib/state/syncRegistry');
		await releaseHeldBack('plans/p1');
		expect(await s.countPendingDocs()).toBe(2);
		expect(stored(SYNC_REGISTRY_KEY).released).toBeUndefined();
	});
});
