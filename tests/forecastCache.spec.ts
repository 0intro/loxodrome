/* When a fetched forecast column is still the forecast
 * (src/lib/weather/forecastCache.ts): stale once a run covering its point
 * lands, anchored by the runs known when it was asked for, aged out only when
 * no run anchors it, and never by comparing a server time with the device
 * clock. */

import { describe, expect, it } from 'vitest';
import {
	FALLBACK_TTL_MS,
	LruStore,
	covers,
	groupBbox,
	groupRun,
	inBbox,
	isCellCurrent,
	stampRuns,
	type RunTable,
} from '$lib/weather/forecastCache';

const H = 3600_000;
const T = Date.UTC(2026, 9, 2, 12);
const AROME: [number, number, number, number] = [37.5, -12, 55.4, 16];
const ARPEGE: [number, number, number, number] = [20, -32, 72, 42];

/** meteofrance_seamless's two cycle groups, twins each. */
const SEAMLESS = [
	['arome_hd', 'arome_0025'],
	['arpege_eu', 'arpege_world'],
] as const;

function runs(r: Record<string, number>, bboxes: Record<string, typeof AROME | null> = {}): RunTable {
	const out: Record<string, { initMs: number; bbox: typeof AROME | null; intervalMs: number }> = {};
	for (const [dir, initMs] of Object.entries(r)) {
		const arome = dir.startsWith('arome');
		out[dir] = { initMs, bbox: dir in bboxes ? bboxes[dir] : arome ? AROME : ARPEGE, intervalMs: (arome ? 3 : 6) * H };
	}
	return out;
}

const PARIS = { lat: 48.85, lon: 2.35 };
const MADEIRA = { lat: 32.7, lon: -16.9 };

describe('a cycle group', () => {
	it('runs at its oldest member, once every member has published', () => {
		expect(groupRun(SEAMLESS[0], runs({ arome_hd: T, arome_0025: T - 3 * H }))).toBe(T - 3 * H);
		expect(groupRun(SEAMLESS[0], runs({ arome_hd: T, arome_0025: T }))).toBe(T);
		expect(groupRun(SEAMLESS[0], runs({ arome_hd: T }))).toBeNull();
		expect(groupRun([], runs({}))).toBeNull();
	});

	it('ignores a member stalled more than its own cadence behind its twin', () => {
		// AROME 0.025 three cycles behind: the HD grid's run stands.
		expect(groupRun(SEAMLESS[0], runs({ arome_hd: T, arome_0025: T - 9 * H }))).toBe(T);
	});

	it('spans its members’ grids, and every point while one is unknown', () => {
		expect(groupBbox(SEAMLESS[0], runs({ arome_hd: T, arome_0025: T }))).toEqual(AROME);
		expect(groupBbox(SEAMLESS[0], runs({ arome_hd: T }))).toBeNull();
		expect(groupBbox(SEAMLESS[0], runs({ arome_hd: T, arome_0025: T }, { arome_hd: null }))).toBeNull();
	});
});

describe('a grid', () => {
	it('holds the points inside it, and an antimeridian grid both sides', () => {
		expect(inBbox(PARIS, AROME)).toBe(true);
		expect(inBbox(MADEIRA, AROME)).toBe(false);
		expect(inBbox({ lat: 10, lon: 179 }, [0, 170, 20, -170])).toBe(true);
		expect(inBbox({ lat: 10, lon: -175 }, [0, 170, 20, -170])).toBe(true);
		expect(inBbox({ lat: 10, lon: 0 }, [0, 170, 20, -170])).toBe(false);
		expect(inBbox(MADEIRA, null)).toBe(true);
	});
});

describe('whether a cell is still the forecast', () => {
	const before = runs({ arome_hd: T, arome_0025: T, arpege_eu: T, arpege_world: T });
	const stamp = stampRuns(SEAMLESS, before);

	it('stays current under the runs it was stamped with, whatever its age', () => {
		expect(isCellCurrent(stamp, T, SEAMLESS, before, PARIS, T + 30 * 24 * H)).toBe(true);
	});

	it('goes stale where a new run of a group covering it lands, and only there', () => {
		const arome = runs({ arome_hd: T + 3 * H, arome_0025: T + 3 * H, arpege_eu: T, arpege_world: T });
		expect(isCellCurrent(stamp, T, SEAMLESS, arome, PARIS, T + H)).toBe(false);
		// Madeira lies outside AROME's grid: its cell stays.
		expect(isCellCurrent(stamp, T, SEAMLESS, arome, MADEIRA, T + H)).toBe(true);
	});

	it('does not move while only one twin of a cycle has published', () => {
		const half = runs({ arome_hd: T + 3 * H, arome_0025: T, arpege_eu: T, arpege_world: T });
		expect(isCellCurrent(stamp, T, SEAMLESS, half, PARIS, T + H)).toBe(true);
	});

	it('ages out when no run anchored it, and reads a clock stepped back as stale', () => {
		const none = stampRuns(SEAMLESS, {});
		expect(isCellCurrent(none, T, SEAMLESS, before, PARIS, T + FALLBACK_TTL_MS - 1)).toBe(true);
		expect(isCellCurrent(none, T, SEAMLESS, before, PARIS, T + FALLBACK_TTL_MS)).toBe(false);
		expect(isCellCurrent(none, T, SEAMLESS, before, PARIS, T - 1)).toBe(false);
		// A model with no run directory (best_match) ages out the same way.
		expect(isCellCurrent({}, T, [], before, PARIS, T + FALLBACK_TTL_MS - 1)).toBe(true);
		expect(isCellCurrent({}, T, [], before, PARIS, T + FALLBACK_TTL_MS)).toBe(false);
	});

	it('takes a first arrival for no new run, and ages the cell out instead', () => {
		// Asked for before any poll answered; the runs then become known.
		const blind = stampRuns(SEAMLESS, {});
		expect(isCellCurrent(blind, T, SEAMLESS, before, PARIS, T + H / 2)).toBe(true);
		expect(isCellCurrent(blind, T, SEAMLESS, before, PARIS, T + 2 * H)).toBe(false);
	});

	it('keeps an anchored cell through polls that answer nothing (offline)', () => {
		// The run table keeps the runs known: nothing changed, nothing stale.
		expect(isCellCurrent(stamp, T, SEAMLESS, before, PARIS, T + 12 * H)).toBe(true);
	});
});

describe('the hours a cell was asked for', () => {
	it('cover a need inside them, never one reaching past', () => {
		expect(covers({ startMs: T, endMs: T + 24 * H }, T + H, T + 3 * H)).toBe(true);
		expect(covers({ startMs: T, endMs: T + 24 * H }, T - H, T + H)).toBe(false);
		expect(covers({ startMs: T, endMs: T + 24 * H }, T + 23 * H, T + 25 * H)).toBe(false);
		expect(covers(undefined, T, T)).toBe(false);
	});
});

describe('the bounded store', () => {
	it('evicts the least recently used past its weight, never the entry just set', () => {
		const s = new LruStore<number>(10, (v) => v);
		s.set('a', 4);
		s.set('b', 4);
		expect(s.get('a')).toBe(4);
		s.set('c', 4);
		// b was the least recently used.
		expect(s.peek('b')).toBeUndefined();
		expect(s.peek('a')).toBe(4);
		expect(s.weight).toBe(8);
		s.set('huge', 50);
		expect(s.peek('huge')).toBe(50);
		expect(s.size).toBe(1);
		s.clear();
		expect(s.size).toBe(0);
		expect(s.weight).toBe(0);
	});

	it('replaces an entry set again, weighing it once', () => {
		const s = new LruStore<number>(10, (v) => v);
		s.set('a', 3);
		s.set('a', 5);
		expect(s.weight).toBe(5);
		s.delete('a');
		expect(s.weight).toBe(0);
	});
});
