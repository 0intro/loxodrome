/* A shared session's end (sync/wipe.ts wipeSharedSession) leaves the club
 * PC at its defaults: the account's data AND everything else of the
 * session, preferences, layout, notices and view state included, keeping
 * only what makes the next sign-in safer and the anonymous leftovers the
 * wipe has always spared. What the session MADE and never synced goes too
 * (user-decided 2026-10-01, privacy first): a document the registry neither
 * tracks nor names as found at the sign-in, in storage (removeSessionEntries)
 * and in IndexedDB (wipeSessionIdb). The personal wipe (wipeLocalSync, the
 * "also remove my data" option) keeps its scope: the account's data alone. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { memoryStorage, type MemoryStorage } from './helpers/storage';
import type { OutingMeta } from '$lib/state/flightsDb';
import { KEEP_SEEDS, PREF_SEEDS } from './helpers/prefSeeds';
import { STORAGE_KEYS } from '$lib/state/storageKeys';
import { FOUND_KEY, SHARED_FLAG_KEY, SHARED_MARKER_KEY, SYNC_REGISTRY_KEY } from '$lib/sync/keys';
import type { FoundCopy } from '$lib/sync/found';

/** Every registered key seeded (the pref seeds, the kept seeds, a value for
 *  any other), plus one nobody registers. */
function everyKey(): Record<string, string> {
	const seed: Record<string, string> = { ...PREF_SEEDS, ...KEEP_SEEDS };
	for (const key of Object.keys(STORAGE_KEYS)) {
		seed[key] ??= 'x';
	}
	seed['loxodrome:zzz'] = 'nobody registers me';
	seed[SHARED_FLAG_KEY] = '1';
	return seed;
}

/** What survives a shared session's end, each for its reason (wipe.ts). */
const SURVIVORS = [
	'loxodrome:account-api',
	'loxodrome:aircraft-fuel',
	'loxodrome:aircraft-user',
	'loxodrome:autorouter-proxy',
	'loxodrome:last-account',
	'loxodrome:last-mode',
	'loxodrome:pilot',
];

let ls: MemoryStorage;
let removed: string[];

beforeEach(() => {
	vi.resetModules();
	ls = memoryStorage(everyKey());
	removed = [];
	const remove = ls.removeItem.bind(ls);
	ls.removeItem = (k: string) => {
		removed.push(k);
		remove(k);
	};
	vi.stubGlobal('localStorage', ls);
	vi.stubGlobal('sessionStorage', memoryStorage({ [SHARED_MARKER_KEY]: '1' }));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("a shared session's end", () => {
	it('leaves exactly the survivors, every registered key decided', async () => {
		const { wipeSharedSession } = await import('$lib/sync/wipe');
		wipeSharedSession();
		expect(Object.keys(ls.dump()).sort()).toEqual(SURVIVORS);
		for (const key of Object.keys(STORAGE_KEYS)) {
			expect(ls.getItem(key) !== null, key).toBe(SURVIVORS.includes(key));
		}
		expect(sessionStorage.getItem(SHARED_MARKER_KEY)).toBeNull();
	});

	it('removes the shared flag last', async () => {
		const { wipeSharedSession } = await import('$lib/sync/wipe');
		wipeSharedSession();
		expect(removed.at(-1)).toBe(SHARED_FLAG_KEY);
		expect(removed.filter((k) => k === SHARED_FLAG_KEY)).toHaveLength(1);
	});

	it("still removes the account's own aircraft entries, grades and pilot block", async () => {
		ls.setItem(
			SYNC_REGISTRY_KEY,
			JSON.stringify({
				v: 1,
				deviceId: 'd',
				lastSeq: 1,
				docs: {
					'aircraft/F-SYNC': { rev: 1, hash: 'h' },
					'acstate/tanked-fuel': { rev: 1, hash: 'h' },
					'pilot/pilot': { rev: 1, hash: 'h' },
				},
				tombstones: [],
				// On the device at the sign-in: the club's own plane.
				preexisting: ['aircraft/F-CLUB'],
			}),
		);
		ls.setItem('loxodrome:aircraft-user', JSON.stringify({ v: 1, planes: { 'F-SYNC': 'a', 'F-CLUB': 'b' } }));
		const { wipeSharedSession } = await import('$lib/sync/wipe');
		wipeSharedSession();
		expect(JSON.parse(ls.getItem('loxodrome:aircraft-user') ?? '{}')).toEqual({ v: 1, planes: { 'F-CLUB': 'b' } });
		expect(ls.getItem('loxodrome:aircraft-fuel')).toBeNull();
		expect(ls.getItem('loxodrome:pilot')).toBeNull();
	});
});

describe('what the session made and never synced', () => {
	/** A registry for a session that synced F-SYNC and found F-CLUB, and,
	 *  unless `found` says otherwise, nothing else at its sign-in. */
	function registry(found: string[] = ['aircraft/F-CLUB'], extra: Record<string, unknown> = {}): void {
		ls.setItem(
			SYNC_REGISTRY_KEY,
			JSON.stringify({
				v: 1,
				deviceId: 'd',
				lastSeq: 1,
				docs: { 'aircraft/F-SYNC': { rev: 1, hash: 'h' }, 'plans/p-sync': { rev: 1, hash: 'h' }, 'outings/7': { rev: 1, hash: 'h' } },
				tombstones: [],
				...(found.length > 0 ? { preexisting: found } : {}),
				...extra,
			}),
		);
	}

	function storageWork(): void {
		ls.setItem('loxodrome:aircraft-user', JSON.stringify({ v: 1, planes: { 'F-SYNC': 'a', 'F-CLUB': 'b', 'F-MINE': 'c' } }));
		ls.setItem('loxodrome:aircraft-fuel', JSON.stringify({ v: 1, types: { 'F-MINE': 'UL91' } }));
		ls.setItem('loxodrome:pilot', JSON.stringify({ name: 'ALICE ANDERSON', sepValidUntil: null, medicalValidUntil: '2027-01-31' }));
	}

	it('goes from storage: the planes it added, the grades and the pilot block it wrote', async () => {
		registry();
		storageWork();
		const { wipeSharedSession } = await import('$lib/sync/wipe');
		wipeSharedSession();
		expect(JSON.parse(ls.getItem('loxodrome:aircraft-user') ?? '{}')).toEqual({ v: 1, planes: { 'F-CLUB': 'b' } });
		expect(ls.getItem('loxodrome:aircraft-fuel')).toBeNull();
		expect(ls.getItem('loxodrome:pilot')).toBeNull();
	});

	it('leaves what the session found at its sign-in, even written over', async () => {
		registry(['aircraft/F-CLUB', 'aircraft/F-MINE', 'acstate/tanked-fuel', 'pilot/pilot']);
		storageWork();
		const { wipeSharedSession } = await import('$lib/sync/wipe');
		wipeSharedSession();
		expect(JSON.parse(ls.getItem('loxodrome:aircraft-user') ?? '{}')).toEqual({ v: 1, planes: { 'F-CLUB': 'b', 'F-MINE': 'c' } });
		expect(ls.getItem('loxodrome:aircraft-fuel')).not.toBeNull();
		expect(ls.getItem('loxodrome:pilot')).not.toBeNull();
	});

	it('tells nothing apart while the sign-in stamp is owed', async () => {
		registry([], { stampPending: true });
		storageWork();
		const { wipeSharedSession } = await import('$lib/sync/wipe');
		wipeSharedSession();
		// The account's own plane goes; the rest is kept, untold.
		expect(JSON.parse(ls.getItem('loxodrome:aircraft-user') ?? '{}')).toEqual({ v: 1, planes: { 'F-CLUB': 'b', 'F-MINE': 'c' } });
		expect(ls.getItem('loxodrome:pilot')).not.toBeNull();
		// And the caller's own word on the debt counts as much as the registry's.
		vi.resetModules();
		registry([]);
		storageWork();
		const again = await import('$lib/sync/wipe');
		again.wipeSharedSession(again.readSessionEnd(true));
		expect(ls.getItem('loxodrome:pilot')).not.toBeNull();
	});

	describe('in IndexedDB', () => {
		const T = Date.UTC(2026, 8, 30, 10, 0);
		const meta = (id: number, savedAtMs: number): OutingMeta =>
			({ id, savedAtMs, datum: 'msl', aircraftKey: null, remarks: '', source: 'trace', derivedV: 0, flights: [] }) as unknown as OutingMeta;

		async function seedRows(): Promise<typeof import('$lib/state/flightsDb')> {
			globalThis.indexedDB = new IDBFactory();
			const db = await import('$lib/state/flightsDb');
			for (const [id, at] of [['p-sync', T], ['p-club', T], ['p-mine', T], ['p-late', T + 60_000]] as const) {
				await db.putStoredPlan({ id, yaml: 'version: 1\n', savedAtMs: at });
			}
			for (const [id, at] of [[7, T], [8, T], [9, T], [10, T + 60_000]] as const) {
				await db.putOuting(meta(id, at), [{ lat: 48, lon: 2, altFt: null, timeMs: id }], null);
			}
			return db;
		}

		it('takes the rows it made, and spares one saved after the end began', async () => {
			registry(['plans/p-club', 'outings/8']);
			const db = await seedRows();
			const { readSessionEnd, wipeSessionIdb } = await import('$lib/sync/wipe');
			await wipeSessionIdb(readSessionEnd(), T + 30_000);
			expect((await db.getStoredPlans()).map((p) => p.id).sort()).toEqual(['p-club', 'p-late']);
			expect((await db.getMetas()).map((m) => m.id).sort((a, b) => a - b)).toEqual([8, 10]);
			// The whole row, its points with it.
			expect(await db.getPoints(9)).toBeNull();
		});

		it('takes only the registry-listed rows while the sign-in stamp is owed', async () => {
			registry([], { stampPending: true });
			const db = await seedRows();
			const { readSessionEnd, wipeSessionIdb } = await import('$lib/sync/wipe');
			await wipeSessionIdb(readSessionEnd(), T + 30_000);
			expect((await db.getStoredPlans()).map((p) => p.id).sort()).toEqual(['p-club', 'p-late', 'p-mine']);
			expect((await db.getMetas()).map((m) => m.id).sort((a, b) => a - b)).toEqual([8, 9, 10]);
		});
	});
});

describe('what the sign-in found', () => {
	const E = { rev: 1, hash: 'h' };
	const PILOT_FOUND = JSON.stringify({ name: 'CLUB PC', sepValidUntil: '2027-05-31', medicalValidUntil: null });
	const FUEL_FOUND = JSON.stringify({ v: 1, types: { 'F-CLUB': 'UL91' } });

	function copy(over: Partial<FoundCopy>): void {
		ls.setItem(
			FOUND_KEY,
			JSON.stringify({
				v: 1,
				userId: 'u',
				keys: [],
				pilot: null,
				fuel: null,
				parked: false,
				planes: {},
				trace: null,
				rows: false,
				...over,
			}),
		);
	}

	function registry(docs: string[], preexisting: string[]): void {
		ls.setItem(
			SYNC_REGISTRY_KEY,
			JSON.stringify({
				v: 1,
				deviceId: 'd',
				lastSeq: 1,
				docs: Object.fromEntries(docs.map((k) => [k, E])),
				tombstones: [],
				...(preexisting.length > 0 ? { preexisting } : {}),
			}),
		);
	}

	it("leaves the device's flights in the crash copy and the outbox, and takes the session's", async () => {
		const doc = (timeMs: number): string =>
			JSON.stringify({ v: 1, recording: false, points: [{ lat: 48, lon: 2, timeMs }] });
		// Found unfiled at the sign-in: their keys are the only copy there is.
		copy({ keys: ['outings/5000', 'outings/7000'], trace: 5_000 });
		ls.setItem('loxodrome:nav-trace', doc(5_000));
		ls.setItem('loxodrome:nav-trace-parked', doc(7_000));
		const { wipeSharedSession } = await import('$lib/sync/wipe');
		wipeSharedSession();
		expect(ls.getItem('loxodrome:nav-trace')).toBe(doc(5_000));
		expect(ls.getItem('loxodrome:nav-trace-parked')).toBe(doc(7_000));
		// The session's own recording in the slot goes with it.
		vi.resetModules();
		copy({ keys: ['outings/7000'], trace: null });
		ls.setItem('loxodrome:nav-trace', doc(9_000));
		const again = await import('$lib/sync/wipe');
		again.wipeSharedSession();
		expect(ls.getItem('loxodrome:nav-trace')).toBeNull();
		expect(ls.getItem('loxodrome:nav-trace-parked')).toBe(doc(7_000));
	});

	it('goes back as found in storage, whatever the session did to it', async () => {
		// The account's F-SYNC, and its F-CLUB pulled over the club's own; the
		// club's F-EDIT typed over in the session; F-GONE deleted in it; F-MINE
		// the session's. The pilot block was set aside, then the account's was
		// pulled; the grades map is the account's, emptied.
		registry(['aircraft/F-SYNC', 'aircraft/F-CLUB', 'acstate/tanked-fuel', 'pilot/pilot'], ['aircraft/F-EDIT']);
		copy({
			keys: ['aircraft/F-CLUB', 'aircraft/F-GONE', 'aircraft/F-EDIT', 'pilot/pilot', 'acstate/tanked-fuel'],
			pilot: PILOT_FOUND,
			fuel: FUEL_FOUND,
			parked: true,
			planes: { 'F-CLUB': 'club', 'F-GONE': 'gone', 'F-EDIT': 'orig' },
		});
		ls.setItem(
			'loxodrome:aircraft-user',
			JSON.stringify({ v: 1, planes: { 'F-SYNC': 'a', 'F-CLUB': 'account', 'F-EDIT': 'edited', 'F-MINE': 'mine' } }),
		);
		ls.setItem('loxodrome:aircraft-fuel', JSON.stringify({ v: 1, types: {} }));
		ls.setItem('loxodrome:pilot', JSON.stringify({ name: 'BOB BAKER', sepValidUntil: null, medicalValidUntil: null }));
		const { wipeSharedSession } = await import('$lib/sync/wipe');
		wipeSharedSession();
		expect(JSON.parse(ls.getItem('loxodrome:aircraft-user') ?? '{}')).toEqual({
			v: 1,
			planes: { 'F-CLUB': 'club', 'F-EDIT': 'orig' },
		});
		expect(ls.getItem('loxodrome:aircraft-fuel')).toBe(FUEL_FOUND);
		expect(ls.getItem('loxodrome:pilot')).toBe(PILOT_FOUND);
		// The copy goes with the session.
		expect(ls.getItem(FOUND_KEY)).toBeNull();
	});

	it('tells the session made from the found even with the stamp owed', async () => {
		// The copy was taken, the registry write was not: the copy still says
		// what the sign-in found, so what came after is the session's.
		registry([], []);
		ls.setItem(
			SYNC_REGISTRY_KEY,
			JSON.stringify({ ...JSON.parse(ls.getItem(SYNC_REGISTRY_KEY) ?? '{}'), stampPending: true }),
		);
		copy({ keys: ['aircraft/F-CLUB'], planes: { 'F-CLUB': 'club' } });
		ls.setItem('loxodrome:aircraft-user', JSON.stringify({ v: 1, planes: { 'F-CLUB': 'club', 'F-MINE': 'mine' } }));
		ls.setItem('loxodrome:pilot', JSON.stringify({ name: 'BOB BAKER', sepValidUntil: null, medicalValidUntil: null }));
		const { wipeSharedSession } = await import('$lib/sync/wipe');
		wipeSharedSession();
		expect(JSON.parse(ls.getItem('loxodrome:aircraft-user') ?? '{}')).toEqual({ v: 1, planes: { 'F-CLUB': 'club' } });
		expect(ls.getItem('loxodrome:pilot')).toBeNull();
	});

	describe('in IndexedDB', () => {
		const T = Date.UTC(2026, 8, 30, 10, 0);
		const meta = (id: number, remarks: string): OutingMeta =>
			({ id, savedAtMs: T, datum: 'msl', aircraftKey: null, remarks, source: 'trace', derivedV: 0, flights: [] }) as unknown as OutingMeta;
		const plan = (id: string, yaml: string) => ({ id, yaml, savedAtMs: T });

		async function seed(): Promise<typeof import('$lib/state/flightsDb')> {
			globalThis.indexedDB = new IDBFactory();
			const db = await import('$lib/state/flightsDb');
			// p-club typed over in the session, p-over the account's copy pulled
			// over the device's under the same id, p-same untouched, p-gone
			// deleted in the session; p-sync the account's, p-mine the session's.
			for (const p of [
				plan('p-sync', 'account'),
				plan('p-club', 'edited'),
				plan('p-over', 'account'),
				plan('p-same', 'same'),
				plan('p-mine', 'mine'),
			]) {
				await db.putStoredPlan(p);
			}
			for (const [id, remarks] of [[7, 'account'], [8, 'session note'], [9, 'account']] as const) {
				await db.putOuting(meta(id, remarks), [{ lat: 48, lon: 2, altFt: null, timeMs: id }], null);
			}
			registry(['plans/p-sync', 'plans/p-over', 'outings/7', 'outings/9'], ['plans/p-club', 'plans/p-same', 'outings/8']);
			return db;
		}

		const FOUND = ['plans/p-club', 'plans/p-over', 'plans/p-same', 'plans/p-gone', 'outings/8', 'outings/9'];

		it('goes back as found, and is never taken away with the account', async () => {
			const db = await seed();
			const found = await import('$lib/sync/found');
			expect(
				await found.saveFoundRows([
					{ key: 'plans/p-club', plan: plan('p-club', 'club') },
					{ key: 'plans/p-over', plan: plan('p-over', 'device') },
					{ key: 'plans/p-same', plan: plan('p-same', 'same') },
					{ key: 'plans/p-gone', plan: plan('p-gone', 'gone') },
					{ key: 'outings/8', meta: meta(8, '') },
					{ key: 'outings/9', meta: meta(9, 'device') },
				]),
			).toBe(true);
			copy({ keys: FOUND, rows: true });
			const { readSessionEnd, wipeSessionIdb } = await import('$lib/sync/wipe');
			await wipeSessionIdb(readSessionEnd(), T + 30_000);
			const plans = Object.fromEntries((await db.getStoredPlans()).map((p) => [p.id, p.yaml]));
			expect(plans).toEqual({ 'p-club': 'club', 'p-over': 'device', 'p-same': 'same' });
			const metas = Object.fromEntries((await db.getMetas()).map((m) => [m.id, m.remarks]));
			expect(metas).toEqual({ 8: '', 9: 'device' });
			// The rows go back by their meta alone: a flight's points stay.
			expect(await db.getPoints(9)).toHaveLength(1);
			// And the copy goes with the session.
			expect((await found.readFoundRows())?.size ?? 0).toBe(0);
		});

		it('tells no plan or flight apart when a store kept the rows unlisted', async () => {
			// The stamp could take the storage-held half alone: the rows the
			// device held are unknown, so none reads as the session's own.
			const db = await seed();
			copy({ keys: ['pilot/pilot'], listed: false, rows: false });
			const { readSessionEnd, wipeSessionIdb } = await import('$lib/sync/wipe');
			await wipeSessionIdb(readSessionEnd(), T + 30_000);
			// The account's rows still go.
			expect((await db.getStoredPlans()).map((p) => p.id).sort()).toEqual(['p-club', 'p-mine', 'p-same']);
			expect((await db.getMetas()).map((m) => m.id).sort((a, b) => a - b)).toEqual([8]);
		});

		it('keeps a found row as it stands when its copy could not be saved', async () => {
			const db = await seed();
			copy({ keys: FOUND, rows: false });
			const { readSessionEnd, wipeSessionIdb } = await import('$lib/sync/wipe');
			await wipeSessionIdb(readSessionEnd(), T + 30_000);
			// Nothing to put back, and nothing found taken away; the account's
			// and the session's own rows still go.
			expect((await db.getStoredPlans()).map((p) => p.id).sort()).toEqual(['p-club', 'p-over', 'p-same']);
			expect((await db.getMetas()).map((m) => m.id).sort((a, b) => a - b)).toEqual([8, 9]);
		});
	});
});

describe('the personal wipe', () => {
	it("keeps its scope: the account's data, never the preferences", async () => {
		const before = ls.dump();
		const { wipeLocalSync } = await import('$lib/sync/wipe');
		wipeLocalSync();
		const after = ls.dump();
		for (const key of Object.keys(PREF_SEEDS)) {
			expect(after[key], key).toBe(before[key]);
		}
		for (const key of ['loxodrome:routes', 'loxodrome:nav-trace', 'loxodrome:account', SYNC_REGISTRY_KEY, SHARED_FLAG_KEY]) {
			expect(after[key], key).toBeUndefined();
		}
		expect(after['loxodrome:flight-prep']).toBe(before['loxodrome:flight-prep']);
		expect(after['loxodrome:radar-caution']).toBe(before['loxodrome:radar-caution']);
	});
});
