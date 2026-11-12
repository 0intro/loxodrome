/* Pins the shared-mode boot sweep (docs/accounts-sync.md, Device
 * modes): the ended-session signature (flag without marker) defers the
 * mount behind a presence query; a live holder means JOIN and never
 * wipe; no holder means the localStorage half is swept before paint;
 * and both non-sweep paths raise the presence BRIDGE so the joined
 * session cannot go holderless between this decision and the account
 * module's own hold. Module state forces the resetModules idiom. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	ACCOUNT_KEY,
	PRESENCE_LOCK,
	RECORDING_LOCK,
	SHARED_FLAG_KEY,
	SHARED_MARKER_KEY,
} from '$lib/sync/keys';
import { IDBFactory } from 'fake-indexeddb';
import { staticClosure } from './helpers/staticClosure';
import { memoryStorage } from './helpers/storage';
import { KEEP_SEEDS, PREF_SEEDS } from './helpers/prefSeeds';

function workingStorage(): Storage {
	const store = new Map<string, string>();
	return {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	} as unknown as Storage;
}

interface LockRow {
	name: string;
	released: boolean;
}

function fakeLocks(heldNames: string[]): { nav: unknown; requests: LockRow[] } {
	const requests: LockRow[] = [];
	const locks = {
		query: () => Promise.resolve({ held: heldNames.map((name) => ({ name })) }),
		request: (name: string, _opts: unknown, cb: () => Promise<void>) => {
			const row: LockRow = { name, released: false };
			requests.push(row);
			const p = cb();
			void p.then(() => {
				row.released = true;
			});
			return p;
		},
	};
	return { nav: { locks }, requests };
}

async function freshSweep(): Promise<typeof import('$lib/sync/bootSweep')> {
	vi.resetModules();
	return import('$lib/sync/bootSweep');
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('bootSweepGate', () => {
	it('boots normally with no shared signature', async () => {
		vi.stubGlobal('localStorage', workingStorage());
		vi.stubGlobal('sessionStorage', workingStorage());
		vi.stubGlobal('navigator', fakeLocks([]).nav);
		const { bootSweepGate } = await freshSweep();
		expect(bootSweepGate()).toBeNull();
	});

	it('treats a marker-present boot as a reload and bridges presence', async () => {
		vi.stubGlobal('localStorage', workingStorage());
		vi.stubGlobal('sessionStorage', workingStorage());
		const fake = fakeLocks([]);
		vi.stubGlobal('navigator', fake.nav);
		localStorage.setItem(SHARED_FLAG_KEY, '1');
		localStorage.setItem(ACCOUNT_KEY, '{"v":1}');
		sessionStorage.setItem(SHARED_MARKER_KEY, '1');
		const { bootSweepGate, releaseBootPresence } = await freshSweep();
		expect(bootSweepGate()).toBeNull();
		// The reload dropped this tab's own hold: the bridge takes over
		// until the account module re-holds, then hands off.
		expect(fake.requests).toHaveLength(1);
		expect(fake.requests[0].name).toBe(PRESENCE_LOCK);
		expect(localStorage.getItem(ACCOUNT_KEY)).not.toBeNull();
		releaseBootPresence();
		await Promise.resolve();
		expect(fake.requests[0].released).toBe(true);
	});

	it('joins a live session: marker written, nothing wiped, bridge up', async () => {
		vi.stubGlobal('localStorage', workingStorage());
		vi.stubGlobal('sessionStorage', workingStorage());
		const fake = fakeLocks([PRESENCE_LOCK]);
		vi.stubGlobal('navigator', fake.nav);
		localStorage.setItem(SHARED_FLAG_KEY, '1');
		localStorage.setItem(ACCOUNT_KEY, '{"v":1}');
		localStorage.setItem('loxodrome:routes', '{}');
		const { bootSweepGate } = await freshSweep();
		const gate = bootSweepGate();
		expect(gate).not.toBeNull();
		await gate;
		expect(sessionStorage.getItem(SHARED_MARKER_KEY)).toBe('1');
		expect(localStorage.getItem(ACCOUNT_KEY)).not.toBeNull();
		expect(localStorage.getItem('loxodrome:routes')).not.toBeNull();
		expect(fake.requests.some((r) => r.name === PRESENCE_LOCK)).toBe(true);
	});

	it('sweeps a holderless ended session before mount', async () => {
		vi.stubGlobal('localStorage', workingStorage());
		vi.stubGlobal('sessionStorage', workingStorage());
		vi.stubGlobal('navigator', fakeLocks([]).nav);
		localStorage.setItem(SHARED_FLAG_KEY, '1');
		localStorage.setItem(ACCOUNT_KEY, '{"v":1}');
		localStorage.setItem('loxodrome:routes', '{}');
		localStorage.setItem('loxodrome:nav-trace', '{}');
		// The session's recording night goes with its trace: left behind,
		// the next pilot's first paint was the night theme.
		localStorage.setItem('loxodrome:auto-night', '1');
		const { bootSweepGate } = await freshSweep();
		const gate = bootSweepGate();
		expect(gate).not.toBeNull();
		await gate;
		expect(localStorage.getItem(ACCOUNT_KEY)).toBeNull();
		expect(localStorage.getItem('loxodrome:routes')).toBeNull();
		expect(localStorage.getItem('loxodrome:nav-trace')).toBeNull();
		expect(localStorage.getItem('loxodrome:auto-night')).toBeNull();
		expect(localStorage.getItem(SHARED_FLAG_KEY)).toBeNull();
	});

	it("takes the session's unsynced rows behind the mount, never one saved after the sweep began", async () => {
		vi.stubGlobal('localStorage', workingStorage());
		vi.stubGlobal('sessionStorage', workingStorage());
		vi.stubGlobal('navigator', fakeLocks([]).nav);
		globalThis.indexedDB = new IDBFactory();
		localStorage.setItem(SHARED_FLAG_KEY, '1');
		localStorage.setItem(
			'loxodrome:sync',
			JSON.stringify({
				v: 1,
				deviceId: 'd',
				lastSeq: 1,
				docs: { 'plans/p-sync': { rev: 1, hash: 'h' } },
				tombstones: [],
				preexisting: ['plans/p-club'],
			}),
		);
		const { bootSweepGate } = await freshSweep();
		const db = await import('$lib/state/flightsDb');
		const past = Date.now() - 3_600_000;
		for (const [id, savedAtMs] of [
			['p-sync', past],
			['p-club', past],
			['p-mine', past],
			// The next pilot's, stored once the app is up.
			['p-next', Date.now() + 60_000],
		] as const) {
			await db.putStoredPlan({ id, yaml: 'version: 1\n', savedAtMs });
		}
		await bootSweepGate();
		await vi.waitFor(async () => {
			expect((await db.getStoredPlans()).map((p) => p.id).sort()).toEqual(['p-club', 'p-next']);
		});
	});

	it('sweeps the rows first, before the mount, the registry still naming them', async () => {
		vi.stubGlobal('localStorage', workingStorage());
		vi.stubGlobal('sessionStorage', workingStorage());
		vi.stubGlobal('navigator', fakeLocks([]).nav);
		globalThis.indexedDB = new IDBFactory();
		localStorage.setItem(SHARED_FLAG_KEY, '1');
		localStorage.setItem(
			'loxodrome:sync',
			JSON.stringify({ v: 1, deviceId: 'd', lastSeq: 1, docs: { 'plans/p-sync': { rev: 1, hash: 'h' } }, tombstones: [] }),
		);
		const { bootSweepGate } = await freshSweep();
		const db = await import('$lib/state/flightsDb');
		await db.putStoredPlan({ id: 'p-sync', yaml: 'version: 1\n', savedAtMs: Date.now() - 3_600_000 });
		// What a tab closed at this instant would leave: the registry, still
		// naming the row, and the flag that brings the next boot back here.
		let left: { registry: boolean; flag: boolean } | null = null;
		const remove = db.deleteStoredPlan;
		vi.spyOn(db, 'deleteStoredPlan').mockImplementation((id: string) => {
			left = {
				registry: localStorage.getItem('loxodrome:sync') !== null,
				flag: localStorage.getItem(SHARED_FLAG_KEY) !== null,
			};
			return remove(id);
		});
		await bootSweepGate();
		expect(left).toEqual({ registry: true, flag: true });
		// Done by the mount, not behind it.
		expect(await db.getStoredPlans()).toEqual([]);
		expect(localStorage.getItem(SHARED_FLAG_KEY)).toBeNull();
	});

	it('holds no mount past its bound on a store that never answers', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		try {
			vi.stubGlobal('localStorage', workingStorage());
			vi.stubGlobal('sessionStorage', workingStorage());
			vi.stubGlobal('navigator', fakeLocks([]).nav);
			globalThis.indexedDB = new IDBFactory();
			localStorage.setItem(SHARED_FLAG_KEY, '1');
			localStorage.setItem(ACCOUNT_KEY, '{"v":1}');
			const sweep = await freshSweep();
			const db = await import('$lib/state/flightsDb');
			vi.spyOn(db, 'getStoredPlansStrict').mockImplementation(() => new Promise(() => {}));
			let mounted = false;
			void sweep.bootSweepGate()?.then(() => {
				mounted = true;
			});
			await vi.advanceTimersByTimeAsync(sweep.IDB_HALF_MS - 10);
			expect(mounted).toBe(false);
			await vi.advanceTimersByTimeAsync(20);
			expect(mounted).toBe(true);
			expect(localStorage.getItem(ACCOUNT_KEY)).toBeNull();
			expect(localStorage.getItem(SHARED_FLAG_KEY)).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('puts back what the sign-in found, all of it before the mount', async () => {
		vi.stubGlobal('localStorage', workingStorage());
		vi.stubGlobal('sessionStorage', workingStorage());
		vi.stubGlobal('navigator', fakeLocks([]).nav);
		globalThis.indexedDB = new IDBFactory();
		const PILOT = JSON.stringify({ name: 'CLUB PC', sepValidUntil: '2027-05-31', medicalValidUntil: null });
		localStorage.setItem(SHARED_FLAG_KEY, '1');
		localStorage.setItem(
			'loxodrome:sync',
			JSON.stringify({ v: 1, deviceId: 'd', lastSeq: 1, docs: {}, tombstones: [], preexisting: ['plans/p-club'] }),
		);
		// The session set the club's pilot block aside and typed its own, and
		// typed over the club's plan.
		localStorage.setItem('loxodrome:pilot', JSON.stringify({ name: 'BOB BAKER', sepValidUntil: null, medicalValidUntil: null }));
		localStorage.setItem(
			'loxodrome:sync-found',
			JSON.stringify({
				v: 1,
				userId: 'u',
				keys: ['pilot/pilot', 'plans/p-club'],
				pilot: PILOT,
				fuel: null,
				parked: true,
				planes: {},
				trace: null,
				rows: true,
			}),
		);
		const { bootSweepGate } = await freshSweep();
		const db = await import('$lib/state/flightsDb');
		const found = await import('$lib/sync/found');
		const past = Date.now() - 3_600_000;
		await db.putStoredPlan({ id: 'p-club', yaml: 'edited', savedAtMs: past });
		await found.saveFoundRows([{ key: 'plans/p-club', plan: { id: 'p-club', yaml: 'club', savedAtMs: past - 60_000 } }]);
		await bootSweepGate();
		// Before the first paint: the next pilot never sees the session's block.
		expect(localStorage.getItem('loxodrome:pilot')).toBe(PILOT);
		expect(localStorage.getItem('loxodrome:sync-found')).toBeNull();
		await vi.waitFor(async () => {
			expect((await db.getStoredPlans()).map((p) => p.yaml)).toEqual(['club']);
		});
		await vi.waitFor(async () => {
			expect((await found.readFoundRows())?.size ?? 0).toBe(0);
		});
	});

	it('ends the session at the defaults, preferences included, and re-stamps the pre-paint', async () => {
		vi.stubGlobal(
			'localStorage',
			memoryStorage({ ...PREF_SEEDS, ...KEEP_SEEDS, [SHARED_FLAG_KEY]: '1', 'loxodrome:locale': 'fr' }),
		);
		vi.stubGlobal('sessionStorage', workingStorage());
		vi.stubGlobal('navigator', { ...(fakeLocks([]).nav as object), languages: ['en-GB'] });
		// What index.html's pre-paint stamped from the keys about to go: the
		// previous pilot's pinned French and their automatic night.
		const html = { lang: 'fr', dataset: { theme: 'night' } as Record<string, string> };
		vi.stubGlobal('document', { documentElement: html });
		vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
		const { bootSweepGate } = await freshSweep();
		await bootSweepGate();
		expect(Object.keys((localStorage as ReturnType<typeof memoryStorage>).dump()).sort()).toEqual([
			'loxodrome:account-api',
			'loxodrome:aircraft-fuel',
			'loxodrome:aircraft-user',
			'loxodrome:autorouter-proxy',
			'loxodrome:last-account',
			'loxodrome:last-mode',
			'loxodrome:pilot',
		]);
		expect(html.lang).toBe('en');
		expect(html.dataset.theme).toBe('day');
	});

	it('holds off while a recording runs in another tab: no sweep, no join', async () => {
		vi.stubGlobal('localStorage', workingStorage());
		vi.stubGlobal('sessionStorage', workingStorage());
		const fake = fakeLocks([RECORDING_LOCK]);
		vi.stubGlobal('navigator', fake.nav);
		localStorage.setItem(SHARED_FLAG_KEY, '1');
		localStorage.setItem(ACCOUNT_KEY, '{"v":1}');
		localStorage.setItem('loxodrome:nav-trace', '{"v":1,"recording":true}');
		localStorage.setItem('loxodrome:routes', '{}');
		const { bootSweepGate } = await freshSweep();
		await bootSweepGate();
		expect(localStorage.getItem('loxodrome:nav-trace')).not.toBeNull();
		expect(localStorage.getItem('loxodrome:routes')).not.toBeNull();
		// The flag stays for the first boot after the flight to sweep, and
		// this tab joined nothing.
		expect(localStorage.getItem(SHARED_FLAG_KEY)).toBe('1');
		expect(sessionStorage.getItem(SHARED_MARKER_KEY)).toBeNull();
		expect(fake.requests).toEqual([]);
	});

	it("the viewer's gate sweeps an ended session like the flight app", async () => {
		vi.stubGlobal('localStorage', memoryStorage());
		vi.stubGlobal('sessionStorage', workingStorage());
		const fake = fakeLocks([]);
		vi.stubGlobal('navigator', fake.nav);
		localStorage.setItem(SHARED_FLAG_KEY, '1');
		localStorage.setItem(ACCOUNT_KEY, '{"v":1}');
		localStorage.setItem('loxodrome:notam-kind', 'area');
		const { bootSweepGate } = await freshSweep();
		await bootSweepGate({ join: false });
		expect(localStorage.getItem(ACCOUNT_KEY)).toBeNull();
		expect(localStorage.getItem('loxodrome:notam-kind')).toBeNull();
		expect(localStorage.getItem(SHARED_FLAG_KEY)).toBeNull();
		expect(fake.requests).toEqual([]);
	});

	it("the viewer's gate joins a live session never: no marker, no bridge", async () => {
		vi.stubGlobal('localStorage', workingStorage());
		vi.stubGlobal('sessionStorage', workingStorage());
		const fake = fakeLocks([PRESENCE_LOCK]);
		vi.stubGlobal('navigator', fake.nav);
		localStorage.setItem(SHARED_FLAG_KEY, '1');
		localStorage.setItem(ACCOUNT_KEY, '{"v":1}');
		const { bootSweepGate } = await freshSweep();
		const gate = bootSweepGate({ join: false });
		expect(gate).not.toBeNull();
		await gate;
		expect(localStorage.getItem(ACCOUNT_KEY)).not.toBeNull();
		expect(sessionStorage.getItem(SHARED_MARKER_KEY)).toBeNull();
		expect(fake.requests).toEqual([]);
		// Nor over this tab's own marker, a flight-app tab navigated here.
		sessionStorage.setItem(SHARED_MARKER_KEY, '1');
		expect(bootSweepGate({ join: false })).toBeNull();
		expect(fake.requests).toEqual([]);
	});

	it('sweeps when no locks API exists (single-tab assumption)', async () => {
		vi.stubGlobal('localStorage', workingStorage());
		vi.stubGlobal('sessionStorage', workingStorage());
		vi.stubGlobal('navigator', {});
		localStorage.setItem(SHARED_FLAG_KEY, '1');
		localStorage.setItem(ACCOUNT_KEY, '{"v":1}');
		const { bootSweepGate } = await freshSweep();
		await bootSweepGate();
		expect(localStorage.getItem(ACCOUNT_KEY)).toBeNull();
	});
});

/* The NOTAM Viewer reads many of the flight app's keys on the origin the two
 * share, so it sweeps an ended shared session before its App loads too, with
 * the sweep-only gate. What its entry evaluates before that: the viewer's
 * mark, the layer module it resets before mounting (read, never written
 * back: tests/layersViewerReset.spec.ts), and the sweep's own leaves. */
describe("the viewer's entry", () => {
	const BEFORE_SWEEP = new Set([
		'src/lib/state/appIdentity.ts',
		'src/lib/state/layers.svelte.ts',
		'src/lib/state/persist.ts',
		'src/lib/state/storageKeys.ts',
		'src/lib/state/syncRegistry.ts',
		'src/lib/state/flightsDb.ts',
	]);

	it('sweeps, sweep-only, before its App loads', () => {
		const before = staticClosure('src/notam/main.ts');
		expect(before.has('src/lib/sync/bootSweep.ts')).toBe(true);
		const early = [...before].filter((f) => f.startsWith('src/lib/state/') && !BEFORE_SWEEP.has(f));
		expect(early).toEqual([]);
		const src = readFileSync('src/notam/main.ts', 'utf8');
		expect(src).toContain('bootSweepGate({ join: false })');
		expect(src).toContain('gate.then(boot)');
	});
});

/* The sweep can only protect what has not been read yet. main.ts decides it
 * after its own static imports have evaluated, so none of them may reach a
 * state module that reads its storage at evaluation: the native init once
 * did, and its navRecording restored the previous pilot's crash-recovery
 * trace into memory (and the interrupted flight's automatic night with it)
 * before the sweep erased the key, for a Fly tap to continue on the club
 * PC. */
describe("the flight app's entry", () => {
	/** Leaves that read nothing a sweep erases, or read it only when called:
	 *  the storage helpers and the key registry the sweep itself uses, the
	 *  flights database it deletes from, and the service-worker bridge. */
	const LEAF_STATE = new Set([
		'src/lib/state/persist.ts',
		'src/lib/state/storageKeys.ts',
		'src/lib/state/syncRegistry.ts',
		'src/lib/state/flightsDb.ts',
		'src/lib/state/pwa.svelte.ts',
	]);

	it('evaluates no storage-reading state module before the sweep', () => {
		const before = staticClosure('src/main.ts');
		expect(before.has('src/lib/sync/bootSweep.ts')).toBe(true);
		const early = [...before].filter((f) => f.startsWith('src/lib/state/') && !LEAF_STATE.has(f));
		expect(early).toEqual([]);
	});

	it('would load them with the native init imported statically', () => {
		// The scan itself: the native init's own closure does hold the trace.
		expect(staticClosure('src/lib/native/init.ts').has('src/lib/state/navRecording.svelte.ts')).toBe(true);
	});
});
