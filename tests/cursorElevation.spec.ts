/* What the cursor badge is allowed to ask the terrain worker for.
 *
 * The readout hangs off mousemove, which fires at pointer rate over ground
 * the mosaic serves one tile at a time, and terrain.ts's concurrency cap is a
 * FIFO queue rather than a dropper: an ungated readout would not be refused,
 * it would build a backlog behind six sockets and keep fetching tiles nobody
 * will look at. These are the rules that stop it, pinned as behaviour rather
 * than left to a comment.
 *
 * The mosaic stands in for itself here: one fetch decodes a whole tile, after
 * which every point inside it is a synchronous read, which is the property
 * the rules lean on. That the two readers agree on the NUMBER is a separate
 * question, pinned against real tiles in tests/terrainPeek.spec.ts. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** One "tile": the ground a single fetch brings in. */
function tileOf(lat: number, lon: number): string {
	return `${Math.round(lat * 10)}/${Math.round(lon * 10)}`;
}
/** Ground under one point, distinct for every point in a tile. */
function groundFt(lat: number, lon: number): number {
	return Math.round((lat + lon) * 1000);
}

const asked: string[] = [];
const decoded = new Set<string>();
/** Tiles the source has no ground for: decoded, and still an answer. */
const voids = new Set<string>();
/** Parks a fetch mid-flight, for the single-flight rule. */
let hold: Promise<void> | null = null;

vi.mock('$lib/map/terrain', () => ({
	elevationFtAt: async (lat: number, lon: number): Promise<number | null> => {
		const tile = tileOf(lat, lon);
		asked.push(tile);
		if (hold) {
			await hold;
		}
		decoded.add(tile);
		return voids.has(tile) ? null : groundFt(lat, lon);
	},
	peekElevationFtAt: (lat: number, lon: number): number | null | undefined => {
		const tile = tileOf(lat, lon);
		if (!decoded.has(tile)) {
			return undefined;
		}
		return voids.has(tile) ? null : groundFt(lat, lon);
	},
}));

import {
	cancelCursorElevation,
	cursorElevation,
	probeCursorElevation,
	resetCursorElevation,
} from '$lib/state/cursorElevation.svelte';

/** Past the module's own idle delay, so the debounce has fired. */
const PAST_IDLE_MS = 200;

/** Everything the fired probe set going, to the end. */
async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) {
		await Promise.resolve();
	}
}

/** The pointer stops long enough to be a rest. */
async function rest(): Promise<void> {
	vi.advanceTimersByTime(PAST_IDLE_MS);
	await flush();
}

const LAT = 45.63;
const LON = 6.79;
/** A step onto fresh ground. */
const NEW_TILE_DEG = 0.2;

describe('the cursor elevation probe', () => {
	beforeEach(() => {
		// Only the debounce clock: the bucket refills against the real one, so
		// the budget test measures the ceiling and not the loop's speed.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		asked.length = 0;
		decoded.clear();
		voids.clear();
		hold = null;
		resetCursorElevation();
	});
	afterEach(() => {
		resetCursorElevation();
		vi.useRealTimers();
	});

	it('asks for nothing while the pointer is moving', async () => {
		for (let i = 0; i < 50; i++) {
			probeCursorElevation(LAT, LON + i * NEW_TILE_DEG);
			vi.advanceTimersByTime(PAST_IDLE_MS / 2); // never long enough to rest
		}
		await flush();
		expect(asked).toEqual([]);
		expect(cursorElevation.ft).toBeNull();
	});

	it('asks once when the pointer comes to rest, and shows the ground', async () => {
		probeCursorElevation(LAT, LON);
		await rest();

		expect(asked).toEqual([tileOf(LAT, LON)]);
		expect(cursorElevation.ft).toBe(groundFt(LAT, LON));
	});

	it('answers the rest of that tile for free, in the same frame', async () => {
		probeCursorElevation(LAT, LON);
		await rest();
		asked.length = 0;

		// A tile is 256 pixels of ground; every other point in it is a Map
		// lookup, answered before the timer could even be armed.
		probeCursorElevation(LAT, LON + 0.01);
		expect(cursorElevation.ft).toBe(groundFt(LAT, LON + 0.01));
		await rest();
		expect(asked).toEqual([]);
	});

	it('says nothing rather than the last place the pointer was', async () => {
		probeCursorElevation(LAT, LON);
		await rest();
		expect(cursorElevation.ft).not.toBeNull();

		// Fresh ground: the badge blanks until its own answer arrives. An
		// elevation from 20 km away is worse than no elevation.
		probeCursorElevation(LAT, LON + NEW_TILE_DEG);
		expect(cursorElevation.ft).toBeNull();
		await rest();
		expect(cursorElevation.ft).toBe(groundFt(LAT, LON + NEW_TILE_DEG));
	});

	it('takes a decoded void for an answer, and does not re-ask', async () => {
		voids.add(tileOf(LAT, LON));
		probeCursorElevation(LAT, LON);
		await rest();
		expect(asked.length).toBe(1);
		expect(cursorElevation.ft).toBeNull();

		probeCursorElevation(LAT, LON + 0.01);
		await rest();
		await rest();
		expect(asked.length).toBe(1);
	});

	it('keeps one query in flight, and picks the pointer up again after it', async () => {
		let release = (): void => {};
		hold = new Promise<void>((r) => {
			release = r;
		});

		probeCursorElevation(LAT, LON);
		await rest();
		expect(asked.length).toBe(1); // asked for, and parked mid-flight

		// A second rest elsewhere while the first is unresolved is DROPPED,
		// never queued: that is what stops a backlog forming.
		probeCursorElevation(LAT, LON + NEW_TILE_DEG);
		await rest();
		expect(asked.length).toBe(1);

		hold = null;
		release();
		await flush();

		// The settling probe re-read what is under the pointer now, found it
		// still unknown, and asked for that instead.
		await rest();
		expect(asked).toEqual([tileOf(LAT, LON), tileOf(LAT, LON + NEW_TILE_DEG)]);
		expect(cursorElevation.ft).toBe(groundFt(LAT, LON + NEW_TILE_DEG));
	});

	it('stops asking once its budget is spent', async () => {
		const rests = 120;
		for (let i = 0; i < rests; i++) {
			probeCursorElevation(LAT, LON + i * NEW_TILE_DEG);
			await rest();
		}
		// PROBE_BUDGET is 60, refilled one token a second of real time, which
		// barely moves here: the badge cannot ask once per rest however the
		// pointer behaves.
		expect(asked.length).toBeLessThan(rests);
		expect(asked.length).toBeGreaterThanOrEqual(60);
		expect(asked.length).toBeLessThanOrEqual(65);
	});

	// The map's TEARDOWN is the only caller. Not the pointer leaving the map
	// and not a view change: the badge freezes its coordinate at that same
	// instant, so an armed probe is answering for the point still on screen,
	// and dropping it strands the line on its placeholder for as long as the
	// map keeps moving, which under follow mode is the whole flight.
	it('drops the pending fetch when the map goes away', async () => {
		probeCursorElevation(LAT, LON);
		cancelCursorElevation();
		await rest();
		await rest();
		expect(asked).toEqual([]);
	});
});
