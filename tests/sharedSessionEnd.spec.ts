/* A shared session's end from inside the app (state/sync.svelte.ts
 * endSharedSession, through signOutDevice; docs/accounts-sync.md "Device
 * modes"). The order is the contract, each step for a reason the contract
 * states: the session revoke sent, the route writer disarmed, the wipe under
 * the WRITER lock with the IndexedDB half first and the flag last, presence
 * dropped only after it, storage sealed, and a navigation to the pathname
 * alone, so the previous pilot's ?file= and #map= do not come back. A
 * wiping sign-out is refused under a recording; the personal ones keep their
 * own scope; and a pass another tab had waiting behind the end writes
 * nothing once the stored session is gone. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage, type MemoryStorage } from './helpers/storage';
import { fakeLocks } from './helpers/locks';
import { KEEP_SEEDS, PREF_SEEDS } from './helpers/prefSeeds';
import {
	ACCOUNT_KEY,
	PRESENCE_LOCK,
	RECORDING_LOCK,
	SHARED_FLAG_KEY,
	SHARED_MARKER_KEY,
	SYNC_REGISTRY_KEY,
	WRITER_LOCK,
} from '$lib/sync/keys';

interface Hooks {
	/** What happened, in order. */
	events: string[];
	/** The state of storage and locks at each labelled moment. */
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
	listLocalDocs: vi.fn(() => Promise.resolve([])),
}));

vi.mock('$lib/sync/protocol', async (original) => {
	const real = await original<typeof import('$lib/sync/protocol')>();
	return {
		...real,
		signOutSession: vi.fn(() => {
			hooks.events.push('revoke');
			return Promise.resolve();
		}),
		fetchChanges: vi.fn(() => {
			hooks.events.push('changes');
			return Promise.reject(new real.ApiError('network', 0));
		}),
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
		wipeSharedSession: vi.fn((...args: Parameters<typeof real.wipeSharedSession>) => {
			hooks.snap('storage');
			return real.wipeSharedSession(...args);
		}),
		wipeLocalSync: vi.fn(() => {
			hooks.snap('storage');
			return real.wipeLocalSync();
		}),
	};
});

vi.mock('$lib/state/routePersist', async (original) => ({
	...(await original<typeof import('$lib/state/routePersist')>()),
	disarmRoutesPersist: vi.fn(() => {
		hooks.events.push('disarm');
	}),
}));

const REGISTRY = JSON.stringify({
	v: 1,
	deviceId: 'd1',
	lastSeq: 5,
	docs: {
		'plans/p1': { rev: 1, hash: 'h' },
		'outings/7': { rev: 1, hash: 'h' },
		'aircraft/F-OURS': { rev: 1, hash: 'h' },
	},
	tombstones: [],
	// On the device at the sign-in (the stamp): an anonymous leftover.
	preexisting: ['aircraft/F-LEFT'],
});

function accountOf(mode: 'personal' | 'shared'): string {
	return JSON.stringify({
		v: 1,
		token: 'T',
		email: 'a@example.com',
		userId: 'u1',
		mode,
		status: 'active',
		signedInAtMs: Date.now(),
	});
}

let ls: MemoryStorage;
let locks: ReturnType<typeof fakeLocks>;
let replace: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;

function world(mode: 'personal' | 'shared'): void {
	const seed: Record<string, string> = {
		...PREF_SEEDS,
		...KEEP_SEEDS,
		[ACCOUNT_KEY]: accountOf(mode),
		[SYNC_REGISTRY_KEY]: REGISTRY,
		'loxodrome:aircraft-user': JSON.stringify({
			v: 1,
			// F-MINE: added in the session, never synced.
			planes: { 'F-OURS': {}, 'F-LEFT': {}, 'F-MINE': {} },
		}),
	};
	delete seed['loxodrome:shared-marker'];
	if (mode === 'shared') {
		seed[SHARED_FLAG_KEY] = '1';
	} else {
		delete seed[SHARED_FLAG_KEY];
	}
	ls = memoryStorage(seed);
	vi.stubGlobal('localStorage', ls);
	vi.stubGlobal('sessionStorage', memoryStorage({ [SHARED_MARKER_KEY]: '1' }));
	locks = fakeLocks();
	vi.stubGlobal('navigator', { locks, languages: ['en-GB'], language: 'en-GB' });
	replace = vi.fn(() => {
		hooks.snap('replace');
	});
	reload = vi.fn(() => {
		hooks.snap('reload');
	});
	vi.stubGlobal('location', {
		pathname: '/app/',
		search: '?file=theirs.yaml',
		hash: '#map=9/47.50000/-2.80000&charts=fr500',
		replace,
		reload,
	});
}

beforeEach(() => {
	vi.resetModules();
	hooks.events = [];
	hooks.at = {};
	hooks.snap = (label: string): void => {
		hooks.events.push(label);
		hooks.at[label] = {
			flag: ls.getItem(SHARED_FLAG_KEY) !== null,
			account: ls.getItem(ACCOUNT_KEY) !== null,
			pref: ls.getItem('loxodrome:theme') !== null,
			writer: locks.isHeld(WRITER_LOCK),
			presence: locks.isHeld(PRESENCE_LOCK),
		};
	};
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function load() {
	const persist = await import('$lib/state/persist');
	const nav = await import('$lib/state/navRecording.svelte');
	const account = await import('$lib/state/account.svelte');
	const s = await import('$lib/state/sync.svelte');
	return { ...s, ...persist, ...nav, ...account };
}

/** Whether a write through the persist wrappers still lands. */
function writesLand(m: Awaited<ReturnType<typeof load>>): boolean {
	m.writeItem('loxodrome:probe', '1');
	const landed = ls.getItem('loxodrome:probe') !== null;
	ls.removeItem('loxodrome:probe');
	return landed;
}

describe('a shared sign-out', () => {
	it('ends the session in the contract order and leaves on a clean URL', { timeout: 30_000 }, async () => {
		world('shared');
		const m = await load();
		expect(locks.isHeld(PRESENCE_LOCK)).toBe(true);
		let sealedAtExit: boolean | null = null;
		replace.mockImplementation(() => {
			hooks.snap('replace');
			sealedAtExit = !writesLand(m);
		});
		const t0 = Date.now();
		expect(await m.signOutDevice({ wipe: false })).toBe('signed-out');
		expect(hooks.events.filter((e) => e !== 'changes')).toEqual([
			'revoke',
			'disarm',
			'idb',
			'storage',
			'replace',
		]);
		// The IndexedDB half under the writer lock, before anything of the
		// session is gone from storage and while presence still holds it.
		expect(hooks.at.idb).toEqual({
			flag: true,
			account: true,
			pref: true,
			writer: true,
			presence: true,
		});
		expect(hooks.at.storage).toMatchObject({ writer: true, presence: true });
		// Out on the pathname alone: no ?file=, no #map=, and nothing written
		// after the wipe.
		expect(replace).toHaveBeenCalledWith('/app/');
		expect(reload).not.toHaveBeenCalled();
		expect(sealedAtExit).toBe(true);
		expect(hooks.at.replace).toMatchObject({ flag: false, account: false, pref: false });
		expect(locks.isHeld(PRESENCE_LOCK)).toBe(false);
		expect(locks.isHeld(WRITER_LOCK)).toBe(false);
		// The account's plane went, and the one the session added and never
		// synced; the anonymous leftover stayed.
		expect(JSON.parse(ls.getItem('loxodrome:aircraft-user') ?? '{}')).toEqual({
			v: 1,
			planes: { 'F-LEFT': {} },
		});
		// The IndexedDB half judged the same snapshot, the stamp not owed,
		// up to the end's own start.
		const wipe = await import('$lib/sync/wipe');
		const [end, untilMs] = vi.mocked(wipe.wipeSessionIdb).mock.calls[0] ?? [];
		expect(Object.keys(end?.reg.docs ?? {})).toEqual(['plans/p1', 'outings/7', 'aircraft/F-OURS']);
		expect(end?.reg.preexisting).toEqual(['aircraft/F-LEFT']);
		expect(untilMs).toBeGreaterThanOrEqual(t0);
		expect(untilMs).toBeLessThanOrEqual(Date.now());
		expect(end?.owed).toBe(false);
		// The storage half judged the very same inputs.
		expect(vi.mocked(wipe.wipeSharedSession).mock.calls[0]?.[0]).toBe(end);
	});

	it('is not taken by the 12-hour cap over a flight the library never took', { timeout: 30_000 }, async () => {
		world('shared');
		ls.setItem(
			ACCOUNT_KEY,
			JSON.stringify({ ...JSON.parse(accountOf('shared')), signedInAtMs: Date.now() - 13 * 3_600_000 }),
		);
		const m = await load();
		// The session's own recording, stopped, its archive refused: a flight
		// the end would erase, never uploaded.
		const t0 = Date.now() - 3_600_000;
		m.nav.points = Array.from({ length: 300 }, (_, i) => ({
			lat: 48,
			lon: 2 + i * 0.0004,
			timeMs: t0 + i * 1000,
			altFt: 1500,
			speedKt: i < 20 ? 5 : i < 280 ? 90 : 0,
		}));
		m.nav.origin = 'recording';
		await m.checkSharedExpiry();
		expect(replace).not.toHaveBeenCalled();
		expect(m.sync.expiredPendingAsk).toBe(true);
		expect(ls.getItem(SHARED_FLAG_KEY)).toBe('1');
	});

	it('is the end the 12-hour cap takes too', { timeout: 30_000 }, async () => {
		world('shared');
		ls.setItem(
			ACCOUNT_KEY,
			JSON.stringify({ ...JSON.parse(accountOf('shared')), signedInAtMs: Date.now() - 13 * 3_600_000 }),
		);
		const m = await load();
		await m.checkSharedExpiry();
		expect(hooks.events.filter((e) => e !== 'changes')).toEqual([
			'revoke',
			'disarm',
			'idb',
			'storage',
			'replace',
		]);
		expect(replace).toHaveBeenCalledWith('/app/');
	});
});

describe('a sign-out that wipes', () => {
	it('is refused while a recording runs, touching nothing', { timeout: 30_000 }, async () => {
		for (const [mode, wipe] of [
			['shared', false],
			['personal', true],
		] as const) {
			vi.resetModules();
			world(mode);
			const m = await load();
			m.nav.recording = true;
			const before = ls.dump();
			expect(await m.signOutDevice({ wipe })).toBe('recording');
			expect(ls.dump()).toEqual(before);
			expect(hooks.events).not.toContain('revoke');
			expect(replace).not.toHaveBeenCalled();
			expect(reload).not.toHaveBeenCalled();
			expect(m.accountToken()).toBe('T');
		}
	});
});

describe('a recording in another tab', () => {
	/** Another tab's recording: it holds the RECORDING lock until released. */
	function recordElsewhere(): () => void {
		let stop = (): void => {};
		void locks.request(
			RECORDING_LOCK,
			{ mode: 'shared' },
			() =>
				new Promise<void>((resolve) => {
					stop = resolve;
				}),
		);
		return () => {
			stop();
		};
	}

	it('refuses a sign-out that would wipe, touching nothing', { timeout: 30_000 }, async () => {
		for (const [mode, wipe] of [
			['shared', false],
			['personal', true],
		] as const) {
			vi.resetModules();
			world(mode);
			const m = await load();
			const stop = recordElsewhere();
			await Promise.resolve();
			const before = ls.dump();
			expect(await m.signOutDevice({ wipe })).toBe('recording-elsewhere');
			expect(ls.dump()).toEqual(before);
			expect(hooks.events).not.toContain('revoke');
			expect(replace).not.toHaveBeenCalled();
			expect(reload).not.toHaveBeenCalled();
			stop();
		}
	});

	it('holds the 12-hour cap until it stops', { timeout: 30_000 }, async () => {
		world('shared');
		ls.setItem(
			ACCOUNT_KEY,
			JSON.stringify({ ...JSON.parse(accountOf('shared')), signedInAtMs: Date.now() - 13 * 3_600_000 }),
		);
		const m = await load();
		const stop = recordElsewhere();
		await Promise.resolve();
		await m.checkSharedExpiry();
		expect(replace).not.toHaveBeenCalled();
		expect(ls.getItem(SHARED_FLAG_KEY)).toBe('1');
		stop();
		await new Promise((r) => setTimeout(r, 0));
		await m.checkSharedExpiry();
		expect(replace).toHaveBeenCalledWith('/app/');
	});

	it('is what the lock this tab holds while recording says', async () => {
		world('personal');
		const { holdRecordingLock, recordingInAnyTab } = await import('$lib/sync/recordingLock');
		expect(await recordingInAnyTab()).toBe(false);
		const release = holdRecordingLock();
		await new Promise((r) => setTimeout(r, 0));
		expect(await recordingInAnyTab()).toBe(true);
		release();
		await new Promise((r) => setTimeout(r, 0));
		expect(await recordingInAnyTab()).toBe(false);
		// Released before the grant: the grant lets go at once.
		holdRecordingLock()();
		await new Promise((r) => setTimeout(r, 0));
		expect(await recordingInAnyTab()).toBe(false);
	});
});

describe('a personal sign-out', () => {
	it('that keeps the data may run under a recording, and keeps the preferences', { timeout: 30_000 }, async () => {
		world('personal');
		const m = await load();
		m.nav.recording = true;
		expect(await m.signOutDevice({ wipe: false })).toBe('signed-out');
		expect(ls.getItem(ACCOUNT_KEY)).toBeNull();
		expect(ls.getItem(SYNC_REGISTRY_KEY)).toBeNull();
		expect(ls.getItem('loxodrome:theme')).toBe('night');
		expect(ls.getItem('loxodrome:routes')).not.toBeNull();
		expect(replace).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
		expect(writesLand(m)).toBe(true);
	});

	it("that wipes takes the account's data alone, then reloads sealed", { timeout: 30_000 }, async () => {
		world('personal');
		const m = await load();
		let sealedAtExit: boolean | null = null;
		reload.mockImplementation(() => {
			hooks.snap('reload');
			sealedAtExit = !writesLand(m);
		});
		expect(await m.signOutDevice({ wipe: true })).toBe('signed-out');
		expect(hooks.events.filter((e) => e !== 'changes')).toEqual([
			'revoke',
			'disarm',
			'idb',
			'storage',
			'reload',
		]);
		expect(hooks.at.idb).toMatchObject({ account: true, writer: true });
		expect(sealedAtExit).toBe(true);
		expect(replace).not.toHaveBeenCalled();
		expect(ls.getItem(ACCOUNT_KEY)).toBeNull();
		expect(ls.getItem('loxodrome:routes')).toBeNull();
		expect(ls.getItem('loxodrome:theme')).toBe('night');
	});
});

describe('a pass in another tab', () => {
	it('writes nothing once the stored session is gone, even queued behind the end', { timeout: 30_000 }, async () => {
		world('personal');
		const m = await load();
		// The control: with the session stored, a pass reaches the wire.
		await m.syncNow();
		expect(hooks.events).toEqual(['changes']);
		// Another tab ends the session while this one's pass waits for the
		// writer lock behind it.
		let releaseOther = (): void => {};
		void locks.request(
			WRITER_LOCK,
			{ mode: 'exclusive' },
			() =>
				new Promise<void>((resolve) => {
					releaseOther = resolve;
				}),
		);
		await Promise.resolve();
		const before = ls.getItem(SYNC_REGISTRY_KEY);
		const pass = m.syncNow();
		await new Promise((r) => setTimeout(r, 0));
		ls.removeItem(ACCOUNT_KEY);
		releaseOther();
		await pass;
		expect(hooks.events).toEqual(['changes']);
		expect(ls.getItem(SYNC_REGISTRY_KEY)).toBe(before);
		// And a later trigger does not reach the wire either.
		await m.syncNow();
		expect(hooks.events).toEqual(['changes']);
	});
});

describe('a tab following an end made in another', () => {
	it('reads the end off the storage event', async () => {
		const { sharedSessionEndedBy } = await import('$lib/sync/keys');
		const ev = (key: string | null, oldValue: string | null, newValue: string | null) =>
			sharedSessionEndedBy({ key, oldValue, newValue });
		expect(ev(SHARED_FLAG_KEY, '1', null)).toBe(true);
		expect(ev(null, null, null)).toBe(true);
		// A new shared session, a flag rewritten, another key: no end.
		expect(ev(SHARED_FLAG_KEY, null, '1')).toBe(false);
		expect(ev(SHARED_FLAG_KEY, '1', '1')).toBe(false);
		expect(ev(ACCOUNT_KEY, accountOf('shared'), null)).toBe(false);
		expect(ev('loxodrome:theme', 'night', null)).toBe(false);
	});

	it('seals and leaves on its pathname, and no pass runs after', { timeout: 30_000 }, async () => {
		world('shared');
		const m = await load();
		expect(m.followEndedSession()).toBe(true);
		expect(replace).toHaveBeenCalledWith('/app/');
		expect(writesLand(m)).toBe(false);
		await m.syncNow();
		expect(hooks.events).toEqual(['replace']);
	});

	it('waits while a recording runs in it', { timeout: 30_000 }, async () => {
		world('shared');
		const m = await load();
		m.nav.recording = true;
		expect(m.followEndedSession()).toBe(false);
		expect(replace).not.toHaveBeenCalled();
		expect(writesLand(m)).toBe(true);
		m.nav.recording = false;
		expect(m.followEndedSession()).toBe(true);
		expect(replace).toHaveBeenCalledWith('/app/');
	});
});
