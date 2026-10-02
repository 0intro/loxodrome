/* A sign-in over another pilot's shared session (state/sync.svelte.ts
 * signIn, state/account.svelte.ts commitSignInOverSharedSession;
 * docs/accounts-sync.md, Lifecycle). The expired club session someone signs
 * OVER ends first, at the device's defaults, and the new session is written
 * in the same step under the writer lock with the pre-existing stamp OWED:
 * this document still holds the previous pilot's aircraft and pilot block in
 * memory, so it never stamps, and leaves for a fresh document on the
 * pathname alone. Never under a recording, and refused before the code is
 * spent. The same account signing back in continues its own session. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { fakeLocks } from './helpers/locks';
import { memoryStorage, type MemoryStorage } from './helpers/storage';
import { KEEP_SEEDS, PREF_SEEDS } from './helpers/prefSeeds';
import {
	ACCOUNT_KEY,
	FOUND_KEY,
	LAST_ACCOUNT_KEY,
	PRESENCE_LOCK,
	RECORDING_LOCK,
	SHARED_FLAG_KEY,
	SHARED_MARKER_KEY,
	SYNC_REGISTRY_KEY,
	WRITER_LOCK,
} from '$lib/sync/keys';
import { sha256HexOfText } from '$lib/sync/fingerprint';

interface Hooks {
	events: string[];
	at: Record<string, Record<string, boolean>>;
	snap: (label: string) => void;
}

const hooks = vi.hoisted(
	(): Hooks => ({
		events: [],
		at: {},
		snap: () => {},
	}),
);

// The sync module reaches Leaflet through the flight import (fitRoute ->
// map/focus), which needs a window to evaluate; nothing here draws.
vi.mock('leaflet', () => ({ default: {} }));

vi.mock('$lib/sync/adapters', async (original) => ({
	...(await original<typeof import('$lib/sync/adapters')>()),
	listLocalDocs: vi.fn(() => {
		hooks.events.push('stamp-list');
		return Promise.resolve([]);
	}),
}));

vi.mock('$lib/sync/protocol', async (original) => {
	const real = await original<typeof import('$lib/sync/protocol')>();
	return {
		...real,
		verifyCode: vi.fn(() => {
			hooks.events.push('verify');
			return Promise.resolve({ token: 'TB', userId: 'uB', status: 'active', created: false });
		}),
		fetchChanges: vi.fn(() => Promise.reject(new real.ApiError('network', 0))),
	};
});

vi.mock('$lib/sync/wipe', async (original) => {
	const real = await original<typeof import('$lib/sync/wipe')>();
	return {
		...real,
		wipeLocalIdb: vi.fn(() => {
			hooks.snap('idb');
			return Promise.resolve();
		}),
		// A shared end's IndexedDB half (the registry's rows and what the
		// session made and never synced; sharedWipe.spec pins its scope).
		wipeSessionIdb: vi.fn(() => {
			hooks.snap('idb');
			return Promise.resolve();
		}),
	};
});

vi.mock('$lib/state/routePersist', async (original) => ({
	...(await original<typeof import('$lib/state/routePersist')>()),
	disarmRoutesPersist: vi.fn(() => {
		hooks.events.push('disarm');
	}),
}));

const A = 'a@example.com';
const B = 'B@Example.com ';

let ls: MemoryStorage;
let ss: MemoryStorage;
let locks: ReturnType<typeof fakeLocks>;
let replace: ReturnType<typeof vi.fn>;

async function world(): Promise<void> {
	ls = memoryStorage({
		...PREF_SEEDS,
		...KEEP_SEEDS,
		[ACCOUNT_KEY]: JSON.stringify({
			v: 1,
			token: 'TA',
			email: A,
			userId: 'uA',
			mode: 'shared',
			status: 'active',
			signedInAtMs: Date.now() - 13 * 3_600_000,
		}),
		[SYNC_REGISTRY_KEY]: JSON.stringify({
			v: 1,
			deviceId: 'dA',
			lastSeq: 9,
			docs: { 'plans/p1': { rev: 1, hash: 'h' }, 'pilot/pilot': { rev: 1, hash: 'h' } },
			tombstones: [],
			preexisting: ['aircraft/F-LEFT'],
		}),
		// A plane found at A's sign-in, and one A added and never synced.
		'loxodrome:aircraft-user': JSON.stringify({ v: 1, planes: { 'F-LEFT': 'a', 'F-MINE': 'b' } }),
		[SHARED_FLAG_KEY]: '1',
		[LAST_ACCOUNT_KEY]: await sha256HexOfText(`acct:${A}`),
	});
	vi.stubGlobal('localStorage', ls);
	ss = memoryStorage({ [SHARED_MARKER_KEY]: '1' });
	vi.stubGlobal('sessionStorage', ss);
	locks = fakeLocks();
	vi.stubGlobal('navigator', { locks, languages: ['en-GB'], language: 'en-GB' });
	replace = vi.fn(() => {
		hooks.snap('replace');
	});
	vi.stubGlobal('location', {
		pathname: '/app/',
		search: '?file=theirs.yaml',
		hash: '#map=9/47.50000/-2.80000&charts=fr500',
		replace,
		reload: vi.fn(),
	});
}

beforeEach(async () => {
	vi.resetModules();
	hooks.events = [];
	hooks.at = {};
	hooks.snap = (label: string): void => {
		hooks.events.push(label);
		hooks.at[label] = {
			flag: ls.getItem(SHARED_FLAG_KEY) !== null,
			pref: ls.getItem('loxodrome:theme') !== null,
			writer: locks.isHeld(WRITER_LOCK),
			presence: locks.isHeld(PRESENCE_LOCK),
		};
	};
	await world();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function load() {
	const persist = await import('$lib/state/persist');
	const nav = await import('$lib/state/navRecording.svelte');
	const s = await import('$lib/state/sync.svelte');
	return { ...s, ...persist, ...nav };
}

const stored = (key: string): Record<string, unknown> =>
	JSON.parse(ls.getItem(key) ?? 'null') as Record<string, unknown>;

describe('a sign-in over another pilot\'s shared session', () => {
	it('ends it at the defaults, owes the stamp, and leaves', { timeout: 30_000 }, async () => {
		const m = await load();
		let sealedAtExit: boolean | null = null;
		replace.mockImplementation(() => {
			hooks.snap('replace');
			m.writeItem('loxodrome:probe', '1');
			sealedAtExit = ls.getItem('loxodrome:probe') === null;
		});
		const t0 = Date.now();
		expect(await m.signIn(B, '123456', false)).toEqual({ kind: 'leaving' });
		expect(hooks.events).toEqual(['verify', 'disarm', 'idb', 'replace']);
		// The previous session's IndexedDB half under the lock, before its
		// storage went, while presence still held it.
		expect(hooks.at.idb).toEqual({ flag: true, pref: true, writer: true, presence: true });
		// The new session, and nothing of the old one.
		expect(stored(ACCOUNT_KEY)).toMatchObject({ token: 'TB', email: 'b@example.com', mode: 'shared' });
		expect(ls.getItem(SHARED_FLAG_KEY)).toBe('1');
		expect(ss.getItem(SHARED_MARKER_KEY)).toBe('1');
		expect(ls.getItem(LAST_ACCOUNT_KEY)).toBe(await sha256HexOfText('acct:b@example.com'));
		expect(ls.getItem('loxodrome:theme')).toBeNull();
		expect(ls.getItem('loxodrome:routes')).toBeNull();
		// What A's session made and never synced went with it, in storage and,
		// judged on A's registry, in IndexedDB; what it found stayed.
		expect(stored('loxodrome:aircraft-user')).toEqual({ v: 1, planes: { 'F-LEFT': 'a' } });
		const wipe = await import('$lib/sync/wipe');
		const [end, untilMs] = vi.mocked(wipe.wipeSessionIdb).mock.calls[0] ?? [];
		expect(end?.reg).toMatchObject({ deviceId: 'dA', preexisting: ['aircraft/F-LEFT'] });
		expect(untilMs).toBeGreaterThanOrEqual(t0);
		// A registry owing the stamp, which this document never takes.
		expect(stored(SYNC_REGISTRY_KEY)).toEqual({
			v: 1,
			deviceId: '',
			lastSeq: 0,
			docs: {},
			tombstones: [],
			stampPending: true,
		});
		expect(hooks.events).not.toContain('stamp-list');
		expect(sealedAtExit).toBe(true);
		expect(replace).toHaveBeenCalledWith('/app/');
	});

	it('stamps the new session from the stores the end settled, owing nothing', { timeout: 30_000 }, async () => {
		// The stores can be read here (the case above has no IndexedDB): the
		// club's leftover plan, and A's own pilot block over the club's, which
		// A's sign-in set aside and A's end puts back.
		globalThis.indexedDB = new IDBFactory();
		const db = await import('$lib/state/flightsDb');
		await db.putStoredPlan({ id: 'p-club', yaml: 'version: 1\n', savedAtMs: 1 });
		const CLUB = JSON.stringify({ name: 'CLUB PC', sepValidUntil: null, medicalValidUntil: null });
		ls.setItem('loxodrome:pilot', JSON.stringify({ name: 'ALICE ANDERSON', sepValidUntil: null, medicalValidUntil: null }));
		ls.setItem(
			FOUND_KEY,
			JSON.stringify({
				v: 1,
				userId: 'uA',
				at: 1,
				keys: ['aircraft/F-LEFT', 'pilot/pilot', 'plans/p-club'],
				pilot: CLUB,
				fuel: null,
				parked: true,
				planes: { 'F-LEFT': 'a' },
				trace: null,
				listed: true,
				rows: false,
			}),
		);
		const m = await load();
		expect(await m.signIn(B, '123456', false)).toEqual({ kind: 'leaving' });
		// No stamp left owed to the next document, so nothing B types there
		// before a pass can be taken for found; the stores were read, never
		// this document's memory of A.
		expect(stored(SYNC_REGISTRY_KEY)).toEqual({
			v: 1,
			deviceId: '',
			lastSeq: 0,
			docs: {},
			tombstones: [],
			preexisting: ['aircraft/F-LEFT', 'plans/p-club'],
		});
		expect(hooks.events).not.toContain('stamp-list');
		expect(stored(FOUND_KEY)).toMatchObject({
			userId: 'uB',
			keys: ['aircraft/F-LEFT', 'pilot/pilot', 'plans/p-club'],
			pilot: CLUB,
			parked: true,
			listed: true,
		});
		// The club's pilot block set aside before the next document reads it.
		expect(stored('loxodrome:pilot')).toEqual({ name: '', sepValidUntil: null, medicalValidUntil: null });
	});

	it("finds again the device's flight A's end left in the crash copy", { timeout: 30_000 }, async () => {
		// The club's flight, found unfiled at A's sign-in: A's end leaves it,
		// and B's sign-in finds it, from the store, the old document's memory
		// being A's.
		globalThis.indexedDB = new IDBFactory();
		const crash = JSON.stringify({ v: 1, recording: false, points: [{ lat: 48, lon: 2, timeMs: 5_000 }] });
		ls.setItem('loxodrome:nav-trace', crash);
		ls.setItem(
			FOUND_KEY,
			JSON.stringify({ v: 1, userId: 'uA', keys: ['outings/5000'], pilot: null, fuel: null, parked: false, planes: {}, trace: 5_000, listed: true, rows: false }),
		);
		const m = await load();
		expect(await m.signIn(B, '123456', false)).toEqual({ kind: 'leaving' });
		expect(ls.getItem('loxodrome:nav-trace')).toBe(crash);
		expect(stored(FOUND_KEY)).toMatchObject({ userId: 'uB', trace: 5_000 });
		expect((stored(FOUND_KEY).keys as string[]).includes('outings/5000')).toBe(true);
		expect((stored(SYNC_REGISTRY_KEY).preexisting as string[]).includes('outings/5000')).toBe(true);
	});

	it('into a personal session clears the shared flag and marker', { timeout: 30_000 }, async () => {
		const m = await load();
		expect(await m.signIn(B, '123456', true)).toEqual({ kind: 'leaving' });
		expect(stored(ACCOUNT_KEY)).toMatchObject({ token: 'TB', mode: 'personal' });
		expect(ls.getItem(SHARED_FLAG_KEY)).toBeNull();
		expect(ss.getItem(SHARED_MARKER_KEY)).toBeNull();
		expect(stored(SYNC_REGISTRY_KEY)).toMatchObject({ stampPending: true });
	});

	it('keeps the ?account= deep link it was armed by', { timeout: 30_000 }, async () => {
		const m = await load();
		await m.signIn(B, '123456', false, true);
		expect(replace).toHaveBeenCalledWith('/app/?account');
	});

	it('is refused under a recording, before a code is spent', { timeout: 30_000 }, async () => {
		const m = await load();
		m.nav.recording = true;
		expect(await m.signInRefused(B)).toBe('recording');
		expect(await m.signInRefused(A)).toBeNull();
		const before = ls.dump();
		expect(await m.signIn(B, '123456', false)).toEqual({ kind: 'recording' });
		expect(hooks.events).toEqual([]);
		expect(ls.dump()).toEqual(before);
		expect(replace).not.toHaveBeenCalled();
	});
});

describe('a sign-in over a shared session, a recording in another tab', () => {
	it('is refused before a code is spent', { timeout: 30_000 }, async () => {
		const m = await load();
		void locks.request(RECORDING_LOCK, { mode: 'shared' }, () => new Promise<void>(() => {}));
		await Promise.resolve();
		expect(await m.signInRefused(B)).toBe('recording-elsewhere');
		expect(await m.signIn(B, '123456', false)).toEqual({ kind: 'recording-elsewhere' });
		expect(hooks.events).toEqual([]);
		expect(replace).not.toHaveBeenCalled();
	});
});

describe('the same account signing back in', () => {
	it('continues its own session in this document', { timeout: 30_000 }, async () => {
		const m = await load();
		const out = await m.signIn(A, '123456', false);
		expect(out).toEqual({ kind: 'signed-in', created: false, differentAccount: false });
		expect(replace).not.toHaveBeenCalled();
		expect(ls.getItem('loxodrome:theme')).toBe('night');
		expect(stored(SYNC_REGISTRY_KEY)).toMatchObject({ deviceId: 'dA', lastSeq: 9 });
		expect(stored(ACCOUNT_KEY)).toMatchObject({ token: 'TB', mode: 'shared' });
		expect(hooks.events).toContain('stamp-list');
	});
});
