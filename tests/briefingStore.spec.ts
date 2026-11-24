/* The NOTAM briefing kept across a restart (state/briefingStore.ts,
 * state/briefingKeep.ts): one IndexedDB record, valid only while its
 * briefing-class key names it. A restart finds the briefing as it was, its
 * fetch's own instant included, so the verdict still judges its age. It is
 * kept until the period it covers ends, two days at most, a day for one
 * loaded by hand, and every wipe of the class takes it. */

import { execFileSync } from 'node:child_process';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/storage';

vi.mock('$lib/state/data.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/state/data.svelte')>()),
	ensureAirports: () => Promise.resolve([]),
}));

const store = await import('$lib/state/briefingStore');
const { BRIEFING_KEY, KEEP_BY_HAND_MS, KEEP_FETCHED_MS, briefingKeptUntil, readStoredBriefing, writeStoredBriefing } =
	store;
const {
	amendBriefing,
	briefingGeneration,
	clearNotams,
	commitBriefing,
	notamState,
	parseInput,
	restoreBriefing,
	setAerodromesMissed,
	setBriefingChangeHook,
	snapshotBriefing,
} = await import('$lib/state/notam.svelte');
const { wipeLocalIdb } = await import('$lib/sync/wipe');
import type { BriefingSnapshot } from '$lib/state/notam.svelte';

const H = 3_600_000;
const T = Date.UTC(2026, 10, 24, 8, 0);

function notam(id: string, a = 'LFPN'): string {
	return [
		`${id} NOTAMN`,
		'Q) LFFF/QMRLC/IV/NBO/A/000/999/4845N00207E005',
		`A) ${a} B) 2601010000 C) PERM`,
		'E) RWY 07/25 CLSD.',
	].join('\n');
}

/** The record as stored, or undefined. */
function storedRecord(): Promise<{ id: string; doc: BriefingSnapshot } | undefined> {
	return new Promise((resolve, reject) => {
		const r = indexedDB.open('loxodrome-briefing', 1);
		r.onupgradeneeded = () => r.result.createObjectStore('briefing', { keyPath: 'key' });
		r.onsuccess = () => {
			const db = r.result;
			const get = db.transaction('briefing', 'readonly').objectStore('briefing').get('current');
			get.onsuccess = () => {
				db.close();
				resolve(get.result as { id: string; doc: BriefingSnapshot } | undefined);
			};
			get.onerror = () => reject(get.error ?? new Error('store read failed'));
		};
	});
}

/** Let IndexedDB's work run, its tasks being setImmediate's (the case's
 *  fake timers leave it real), until `done` holds or 200 turns pass. */
async function settle(done: () => boolean): Promise<boolean> {
	for (let i = 0; i < 200 && !done(); i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	return done();
}

/** A route briefing fetched at T, briefed `days` from then. */
function fetched(days: number): void {
	vi.setSystemTime(T);
	commitBriefing([notam('A0001/26'), notam('A0002/26', 'LFOZ')].join('\n\n'), {
		source: 'sofia',
		kind: 'route',
		briefed: { from: T, to: T + days * 24 * H },
		gaps: { total: 2, routes: [{ label: 'LFOZ-LFOQ', cause: 'noAerodrome', detail: 'no aerodrome' }] },
		asked: {
			region: {
				kind: 'tracks',
				tracks: [
					{ label: 'LFPN-LFOZ', path: [{ lat: 48.75, lon: 2.1 }, { lat: 47.9, lon: 2.16 }], landed: true, ends: ['LFPN', 'LFOZ'] },
				],
				halfWidthNM: 15.3,
			},
			aim: 'flight',
		},
	});
}

beforeEach(() => {
	vi.stubGlobal('indexedDB', new IDBFactory());
	vi.stubGlobal('localStorage', memoryStorage({}));
	vi.useFakeTimers({ toFake: ['Date'] });
	clearNotams();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('a kept briefing', () => {
	it('comes back as it was, its fetch 40 h old and still that old', async () => {
		fetched(30);
		amendBriefing('LFPT', [notam('A0009/26', 'LFPT')], { source: 'sofia', at: T + H, briefed: { from: T, to: T + 24 * H } }, () => true);
		const before = snapshotBriefing();
		await writeStoredBriefing(before);
		clearNotams();
		vi.setSystemTime(T + 40 * H);
		const doc = await readStoredBriefing(Date.now());
		expect(doc).not.toBeNull();
		restoreBriefing(doc as BriefingSnapshot);
		expect(snapshotBriefing()).toEqual(before);
		expect(notamState.lastFetch?.at).toBe(T);
		expect(notamState.notams.map((n) => n.id)).toEqual(['A0001/26', 'A0002/26', 'A0009/26']);
		expect(notamState.aerodromeFetches.LFPT?.at).toBe(T + H);
	});

	it('keeps the aerodromes owed by name, which a new fetch still owes and a paste drops', async () => {
		fetched(1);
		setAerodromesMissed(['LFOB'], briefingGeneration() - 1);
		expect(notamState.aerodromesMissed).toEqual([]);
		setAerodromesMissed(['LFOB'], briefingGeneration());
		await writeStoredBriefing(snapshotBriefing());
		clearNotams();
		expect(notamState.aerodromesMissed).toEqual([]);
		restoreBriefing((await readStoredBriefing(T + H)) as BriefingSnapshot);
		expect(notamState.aerodromesMissed).toEqual(['LFOB']);
		fetched(1);
		expect(notamState.aerodromesMissed).toEqual(['LFOB']);
		notamState.rawText = notam('B0001/26');
		parseInput();
		expect(notamState.aerodromesMissed).toEqual([]);
	});

	it('keeps the sources of its NOTAMs, so an aerodrome fetch can still withdraw one', async () => {
		fetched(1);
		await writeStoredBriefing(snapshotBriefing());
		clearNotams();
		restoreBriefing((await readStoredBriefing(T + H)) as BriefingSnapshot);
		// SOFIA answering LFPN with A0003 and without A0001: the same source
		// gave A0001, so it goes. Without its source it would be kept.
		amendBriefing('LFPN', [notam('A0003/26')], { source: 'sofia', at: T + H, briefed: { from: T, to: T + 24 * H } }, () => true);
		expect(notamState.notams.map((n) => n.id)).toEqual(['A0002/26', 'A0003/26']);
	});
});

describe('how long it is kept', () => {
	const doc = (over: Partial<BriefingSnapshot>): BriefingSnapshot => ({
		text: '',
		lastFetch: null,
		gaps: null,
		fetchScope: null,
		aerodromeFetches: {},
		byHand: null,
		origins: [],
		seen: null,
		...over,
	});
	const fetchAt = (at: number, to: number | null) => ({
		source: 'sofia' as const,
		kind: 'route' as const,
		at,
		count: 1,
		briefed: to === null ? null : { from: at, to },
	});
	const cases: [string, BriefingSnapshot, number][] = [
		['a day briefed: until its end', doc({ lastFetch: fetchAt(T, T + 24 * H) }), T + 24 * H],
		['thirty days briefed: two days', doc({ lastFetch: fetchAt(T, T + 720 * H) }), T + KEEP_FETCHED_MS],
		['no period stated: two days', doc({ lastFetch: fetchAt(T, null) }), T + KEEP_FETCHED_MS],
		['loaded by hand: a day', doc({ byHand: { at: T } }), T + KEEP_BY_HAND_MS],
		[
			'aerodrome fetches alone: the newest',
			doc({
				aerodromeFetches: {
					LFPN: { source: 'sofia', at: T, briefed: { from: T, to: T + 24 * H }, count: 0, withdrawn: [], unconfirmed: [], kept: [] },
					LFPT: { source: 'sofia', at: T + 5 * H, briefed: { from: T + 5 * H, to: T + 29 * H }, count: 0, withdrawn: [], unconfirmed: [], kept: [] },
				},
			}),
			T + 29 * H,
		],
	];
	for (const [name, d, want] of cases) {
		it(name, () => {
			expect(briefingKeptUntil(d)).toBe(want);
		});
	}

	it('is dropped once past it, the record deleted', async () => {
		fetched(30);
		await writeStoredBriefing(snapshotBriefing());
		expect(await readStoredBriefing(T + KEEP_FETCHED_MS + 1)).toBeNull();
		expect(await storedRecord()).toBeUndefined();
	});
});

describe('the key it is valid beside', () => {
	it('drops a record whose key a wipe took', async () => {
		fetched(1);
		await writeStoredBriefing(snapshotBriefing());
		const id = localStorage.getItem(BRIEFING_KEY);
		localStorage.removeItem(BRIEFING_KEY);
		expect(await readStoredBriefing(T + H)).toBeNull();
		// Deleted, not just refused: the key put back finds nothing.
		localStorage.setItem(BRIEFING_KEY, id ?? '');
		expect(await readStoredBriefing(T + H)).toBeNull();
	});

	it('drops a record another write replaced the key of', async () => {
		fetched(1);
		await writeStoredBriefing(snapshotBriefing());
		localStorage.setItem(BRIEFING_KEY, 'another');
		expect(await readStoredBriefing(T + H)).toBeNull();
	});

	it('keeps one id across writes, the key written once', async () => {
		fetched(1);
		await writeStoredBriefing(snapshotBriefing());
		const id = localStorage.getItem(BRIEFING_KEY);
		fetched(2);
		await writeStoredBriefing(snapshotBriefing());
		expect(localStorage.getItem(BRIEFING_KEY)).toBe(id);
		expect((await readStoredBriefing(T + H))?.lastFetch?.briefed?.to).toBe(T + 48 * H);
	});

	it('keeps a briefing written while it refused the record it was reading', async () => {
		fetched(1);
		await writeStoredBriefing(snapshotBriefing());
		// Two days later the record is past its keep, and an opened file is
		// written while the boot's read refuses it.
		const reading = readStoredBriefing(T + 60 * H);
		fetched(1);
		const writing = writeStoredBriefing(snapshotBriefing());
		expect(await reading).toBeNull();
		await writing;
		expect((await readStoredBriefing(T + H))?.lastFetch?.at).toBe(T);
	});

	it('heals a storeless database a probe holds open, leaking no connection', async () => {
		const probe = await new Promise<IDBDatabase>((resolve) => {
			const r = indexedDB.open('loxodrome-briefing');
			r.onsuccess = () => resolve(r.result);
		});
		fetched(1);
		// The heal's delete waits on the probe: this write is lost.
		await writeStoredBriefing(snapshotBriefing());
		probe.close();
		await writeStoredBriefing(snapshotBriefing());
		await settle(() => false);
		// A Clear's delete, then the next write: neither waits on a
		// connection the heal left open.
		await writeStoredBriefing(null);
		const done = await Promise.race([
			writeStoredBriefing(snapshotBriefing()).then(() => 'written'),
			new Promise((resolve) => setTimeout(() => resolve('pending'), 2000)),
		]);
		expect(done).toBe('written');
		expect((await readStoredBriefing(T + H))?.lastFetch?.at).toBe(T);
	});

	it('heals a database opened elsewhere with no store', async () => {
		await new Promise<void>((resolve) => {
			const r = indexedDB.open('loxodrome-briefing');
			r.onsuccess = () => {
				r.result.close();
				resolve();
			};
		});
		fetched(1);
		await writeStoredBriefing(snapshotBriefing());
		expect((await readStoredBriefing(T + H))?.lastFetch?.at).toBe(T);
	});

	it('drops a record it cannot read, the boot going on', async () => {
		const { restoreKeptBriefing } = await import('$lib/state/briefingKeep');
		fetched(1);
		await writeStoredBriefing(snapshotBriefing());
		const id = localStorage.getItem(BRIEFING_KEY);
		// A record of another shape, as another version could leave it.
		await new Promise<void>((resolve, reject) => {
			const r = indexedDB.open('loxodrome-briefing', 1);
			r.onsuccess = () => {
				const db = r.result;
				const tx = db.transaction('briefing', 'readwrite');
				tx.objectStore('briefing').put({ key: 'current', id, savedAt: T, doc: { text: 42 } });
				tx.oncomplete = () => {
					db.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error ?? new Error('store write failed'));
			};
		});
		clearNotams();
		await expect(restoreKeptBriefing(10_000)).resolves.toBeUndefined();
		expect(await storedRecord()).toBeUndefined();
		expect(notamState.lastFetch).toBeNull();
	});

	it('drops a record it cannot restore, leaving the briefing loaded as it was', async () => {
		const { restoreKeptBriefing } = await import('$lib/state/briefingKeep');
		fetched(1);
		const doc = snapshotBriefing() as BriefingSnapshot;
		await writeStoredBriefing({ ...doc, origins: [7] as never });
		clearNotams();
		await expect(restoreKeptBriefing(10_000)).resolves.toBeUndefined();
		expect(await storedRecord()).toBeUndefined();
		expect(notamState.lastFetch).toBeNull();
		expect(notamState.notams).toEqual([]);
	});

	it('goes with the account wipe', async () => {
		fetched(1);
		await writeStoredBriefing(snapshotBriefing());
		await wipeLocalIdb({ v: 1, deviceId: 'd', lastSeq: 0, docs: {}, tombstones: {} } as never);
		expect(await readStoredBriefing(T + H)).toBeNull();
	});

	it('goes when the briefing is cleared', async () => {
		fetched(1);
		await writeStoredBriefing(snapshotBriefing());
		clearNotams();
		await writeStoredBriefing(snapshotBriefing());
		expect(localStorage.getItem(BRIEFING_KEY)).toBeNull();
		expect(await readStoredBriefing(T + H)).toBeNull();
	});
});

describe('the flight app keeps it', () => {
	it('writes a pasted bulletin a second after it, and drops it a second after a Clear', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
		vi.setSystemTime(T);
		const { installBriefingKeep } = await import('$lib/state/briefingKeep');
		installBriefingKeep();
		try {
			notamState.rawText = notam('B0001/26');
			parseInput();
			await vi.advanceTimersByTimeAsync(999);
			expect(localStorage.getItem(BRIEFING_KEY)).toBeNull();
			await vi.advanceTimersByTimeAsync(1);
			await vi.waitFor(() => expect(localStorage.getItem(BRIEFING_KEY)).not.toBeNull());
			expect((await readStoredBriefing(T + H))?.byHand).toEqual({ at: T });
			clearNotams();
			await vi.advanceTimersByTimeAsync(1000);
			await vi.waitFor(() => expect(localStorage.getItem(BRIEFING_KEY)).toBeNull());
		} finally {
			setBriefingChangeHook(null);
		}
	});

	it('writes at once a change made while the page is hidden', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
		vi.setSystemTime(T);
		const { installBriefingKeep } = await import('$lib/state/briefingKeep');
		installBriefingKeep();
		try {
			// A phone locked during a run: a frozen page fires no timer, so
			// the coalescing second never passes here.
			vi.stubGlobal('document', { visibilityState: 'hidden' });
			notamState.rawText = notam('B0002/26');
			parseInput();
			expect(await settle(() => localStorage.getItem(BRIEFING_KEY) !== null)).toBe(true);
			expect((await storedRecord())?.doc.byHand).toEqual({ at: T });
		} finally {
			setBriefingChangeHook(null);
		}
	});

	it('restores at boot, and a briefing loaded first wins', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
		const { restoreKeptBriefing } = await import('$lib/state/briefingKeep');
		fetched(1);
		await writeStoredBriefing(snapshotBriefing());
		clearNotams();
		await restoreKeptBriefing(10_000);
		expect(notamState.lastFetch?.at).toBe(T);
		clearNotams();
		notamState.rawText = notam('C0001/26');
		parseInput();
		await restoreKeptBriefing(10_000);
		expect(notamState.notams.map((n) => n.id)).toEqual(['C0001/26']);
	});

	it('leaves a paste the pilot has not displayed in the box', async () => {
		const { restoreKeptBriefing } = await import('$lib/state/briefingKeep');
		fetched(1);
		await writeStoredBriefing(snapshotBriefing());
		clearNotams();
		notamState.rawText = notam('E0001/26');
		await restoreKeptBriefing(10_000);
		expect(notamState.lastFetch?.at).toBe(T);
		expect(notamState.rawText).toBe(notam('E0001/26'));
	});

	it('leaves what the pilot did while the read was pending', async () => {
		// The read lands when it can, after the boot's wait on a slow store:
		// a bulletin opened meanwhile stays, and so does a Clear.
		const { restoreKeptBriefing } = await import('$lib/state/briefingKeep');
		fetched(1);
		await writeStoredBriefing(snapshotBriefing());
		clearNotams();
		let restoring = restoreKeptBriefing(10_000);
		notamState.rawText = notam('C0001/26');
		parseInput();
		await restoring;
		expect(notamState.notams.map((n) => n.id)).toEqual(['C0001/26']);
		clearNotams();
		restoring = restoreKeptBriefing(10_000);
		notamState.rawText = notam('D0001/26');
		parseInput();
		clearNotams();
		await restoring;
		expect(notamState.notams).toEqual([]);
		expect(notamState.lastFetch).toBeNull();
	});
});

describe('the NOTAM Viewer', () => {
	it("never opens the database: the flight app's entry alone imports the keep", () => {
		const importers = execFileSync('git', ['grep', '-l', '--untracked', "briefingKeep'", '--', 'src'], {
			encoding: 'utf8',
		})
			.trim()
			.split('\n');
		expect(importers).toEqual(['src/main.ts']);
	});
});
