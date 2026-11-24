/* The pilot's notes of what a unit said of a zone
 * (state/zoneNotes.svelte.ts): kept on the device under one key of the
 * briefing's class, sparse (the key goes with the last note), each note's
 * time kept to its minute, a note past its end dropped at load and at the
 * next write. And the next occurrence of the clock time a unit gives
 * (format/datetime.ts nextClockMs). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextClockMs } from '$lib/format/datetime';
import type { ZoneNote } from '$lib/state/zoneNotes.svelte';
import { memoryStorage } from './helpers/storage';

const KEY = 'loxodrome:zone-notes';
const T = Date.UTC(2026, 10, 23, 10, 0, 30); // Monday 23 November 2026, 10:00:30Z
const H = 3_600_000;

function note(over: Partial<ZoneNote> = {}): ZoneNote {
	return { state: 'inactive', notedAtMs: T, untilMs: T + H, unit: 'BLOIS INFO', name: 'ZRT BLOIS', ...over };
}

/** A fresh store over `seed`, read at its module's evaluation. */
async function fresh(seed: Record<string, string> = {}) {
	const storage = memoryStorage(seed);
	vi.stubGlobal('localStorage', storage);
	vi.resetModules();
	return { m: await import('$lib/state/zoneNotes.svelte'), storage };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("the pilot's notes on zones", () => {
	it('keeps a note under its key at its minute, the key going with the last note', async () => {
		const { m, storage } = await fresh();
		m.setZoneNote('metropole-2026-153#0', note());
		expect(JSON.parse(storage.dump()[KEY])).toEqual({
			'metropole-2026-153#0': note({ notedAtMs: Date.UTC(2026, 10, 23, 10) }),
		});
		expect(m.zoneNote('metropole-2026-153#0')?.unit).toBe('BLOIS INFO');
		m.clearZoneNote('metropole-2026-153#0');
		expect(storage.dump()[KEY]).toBeUndefined();
		expect(m.zoneNote('metropole-2026-153#0')).toBeNull();
	});

	it('reads back the notes in force, dropping the ended and the malformed', async () => {
		const seed = { [KEY]: JSON.stringify({ a: note(), b: note({ untilMs: T - 1 }), c: { state: 'closed' }, d: 'x' }) };
		const { m } = await fresh(seed);
		expect(Object.keys(m.zoneNotes.byZone)).toEqual(['a']);
		const { m: empty } = await fresh({ [KEY]: 'not json' });
		expect(empty.zoneNotes.byZone).toEqual({});
	});

	it('holds a note to its end, inclusive', async () => {
		const { m } = await fresh();
		m.setZoneNote('a', note());
		expect(m.zoneNote('a', T + H)).not.toBeNull();
		expect(m.zoneNote('a', T + H + 1)).toBeNull();
		expect(m.notesInForce(T + H + 1)).toEqual([]);
	});

	it('drops the notes that have ended at the next write', async () => {
		const { m, storage } = await fresh();
		m.setZoneNote('a', note());
		vi.setSystemTime(T + 2 * H);
		m.setZoneNote('b', note({ notedAtMs: T + 2 * H, untilMs: T + 3 * H }));
		expect(Object.keys(m.zoneNotes.byZone)).toEqual(['b']);
		expect(Object.keys(JSON.parse(storage.dump()[KEY]) as Record<string, ZoneNote>)).toEqual(['b']);
	});

	it("reads a unit's clock time as its next occurrence, within a day", () => {
		expect(nextClockMs('16:00', T)).toBe(Date.UTC(2026, 10, 23, 16));
		expect(nextClockMs('06:00', T)).toBe(Date.UTC(2026, 10, 24, 6));
		// Strictly after: the current minute is tomorrow's.
		expect(nextClockMs('10:00', Date.UTC(2026, 10, 23, 10))).toBe(Date.UTC(2026, 10, 24, 10));
		expect(nextClockMs('24:00', T)).toBeNull();
		expect(nextClockMs('', T)).toBeNull();
	});
});
