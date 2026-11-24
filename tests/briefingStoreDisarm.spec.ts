/* The kept NOTAM briefing's writes stood down by a wipe that leaves the
 * page (state/briefingStore.ts disarmBriefingStore). A file of its own: the
 * stand-down lasts as long as the module, as it lasts the document. */

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BriefingSnapshot } from '$lib/state/notam.svelte';
import { memoryStorage } from './helpers/storage';

const { BRIEFING_KEY, disarmBriefingStore, writeStoredBriefing } = await import('$lib/state/briefingStore');

const H = 3_600_000;
const T = Date.UTC(2026, 10, 24, 8, 0);

/** A route briefing fetched at T, briefed `hours` from then. */
function briefing(hours: number): BriefingSnapshot {
	return {
		text: 'A0001/26 NOTAMN\nQ) LFFF/QMRLC/IV/NBO/A/000/999/4845N00207E005\nA) LFPN B) 2601010000 C) PERM\nE) RWY 07/25 CLSD.',
		lastFetch: { source: 'sofia', kind: 'route', at: T, count: 1, briefed: { from: T, to: T + hours * H } },
		gaps: null,
		fetchScope: null,
		aerodromeFetches: {},
		aerodromesMissed: [],
		byHand: null,
		origins: [],
		seen: null,
	};
}

/** The record's briefed end as stored, or undefined. */
function storedEnd(): Promise<number | undefined> {
	return new Promise((resolve, reject) => {
		const r = indexedDB.open('loxodrome-briefing', 1);
		r.onupgradeneeded = () => r.result.createObjectStore('briefing', { keyPath: 'key' });
		r.onsuccess = () => {
			const db = r.result;
			const get = db.transaction('briefing', 'readonly').objectStore('briefing').get('current');
			get.onsuccess = () => {
				db.close();
				resolve((get.result as { doc: BriefingSnapshot } | undefined)?.doc.lastFetch?.briefed?.to);
			};
			get.onerror = () => reject(get.error ?? new Error('store read failed'));
		};
	});
}

beforeEach(() => {
	vi.stubGlobal('indexedDB', new IDBFactory());
	vi.stubGlobal('localStorage', memoryStorage({}));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('a wipe that leaves the page', () => {
	it('stands the writes down, a write under way included', async () => {
		await writeStoredBriefing(briefing(24));
		// A write starts, then the wipe stands the store down and takes the key.
		const writing = writeStoredBriefing(briefing(48));
		disarmBriefingStore();
		localStorage.removeItem(BRIEFING_KEY);
		await writing;
		await writeStoredBriefing(briefing(12));
		expect(localStorage.getItem(BRIEFING_KEY)).toBeNull();
		expect(await storedEnd()).toBe(T + 24 * H);
	});
});
