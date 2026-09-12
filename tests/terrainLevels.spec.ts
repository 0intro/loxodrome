/* The level machinery: which zoom a terrain read is answered at, and the
 * invariant that the offline pin holds exactly what a reduction will ask for.
 *
 * A pooled maximum IS the maximum of everything under it, so reading a
 * coarser level costs granularity and never correctness; it costs bytes NOT
 * to. That is the whole argument for the pyramid, and `pickLevel` is where it
 * is spent. A picker that disagrees with the pin is a plan that answers "no
 * data" over the Alps, which is why the two are held together by test rather
 * than by both being written from the same idea.
 *
 * The tile fetch is stubbed to miss, so the reduction runs its geometry and
 * reports what it chose without touching the network. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('$lib/offline/passiveStore', () => ({
	passiveFetchBlob: (): Promise<Blob | null> => Promise.resolve(null),
}));

import {
	pickLevel,
	reduceCapsule,
	setTerrainLevels,
	terrainLevels,
	type TerrainLevels,
} from '$lib/map/terrain';
import { corridorTerrainLevels, computeCorridorGround } from '$lib/route/minAltitude';
import { corridorTerrainTiles } from '$lib/offline/terrainPin';
import { NM_TO_METERS } from '$lib/notam/units';

/** A source publishing exactly one level. This used to be read off
 *  `terrainLevels()`, which was true while the legacy source was in force and
 *  silently stopped being a degenerate case the moment the module default
 *  became a pyramid. It is the CASE that is under test, not the default, so
 *  it is stated here. */
const ONE_LEVEL: TerrainLevels = { deepest: 12, coarsest: 12 };

/** What the module ships with, captured before any test moves it, so a block
 *  that restores "the default" restores the real one. */
const DEFAULT_LEVELS = terrainLevels();
/** A source publishing a pyramid, which is what the mosaic will be. */
const PYRAMID: TerrainLevels = { deepest: 14, coarsest: 6 };

const A = { lat: 45.9294, lon: 6.0994 };
const B = { lat: 45.8208, lon: 6.6522 };

describe('pickLevel', () => {
	it('takes the coarsest level whose pixel still fits four times across a bin', () => {
		// A 1 NM bin at 45 N: a z8 pixel is 432 m, so four of them span the
		// bin and its extremes come from about sixteen pooled pixels.
		expect(pickLevel(NM_TO_METERS, 45, PYRAMID)).toBe(8);
		// A tenth of that wants four levels deeper, one per halving squared.
		expect(pickLevel(NM_TO_METERS / 16, 45, PYRAMID)).toBe(12);
	});

	it('never needs a deeper level toward the pole, where a pixel covers less ground', () => {
		// Not one level per step: the latitude factor is cos, and a level is
		// a factor of two, so it crosses a boundary only where it lands.
		for (const lat of [0, 30, 45, 60, 70, 80]) {
			expect(pickLevel(NM_TO_METERS, lat, PYRAMID)).toBeLessThanOrEqual(
				pickLevel(NM_TO_METERS, 0, PYRAMID),
			);
		}
		expect(pickLevel(NM_TO_METERS, 80, PYRAMID)).toBeLessThan(
			pickLevel(NM_TO_METERS, 45, PYRAMID),
		);
		// The hemisphere is not a direction.
		expect(pickLevel(NM_TO_METERS, -60, PYRAMID)).toBe(pickLevel(NM_TO_METERS, 60, PYRAMID));
	});

	it('never asks for a level the source does not publish', () => {
		expect(pickLevel(1e9, 45, PYRAMID)).toBe(6);
		expect(pickLevel(0.001, 45, PYRAMID)).toBe(14);
		// The degenerate source: one level, so every read lands on it.
		expect(pickLevel(NM_TO_METERS, 45, ONE_LEVEL)).toBe(ONE_LEVEL.deepest);
	});

	it('answers the deepest level for a bin it cannot reason about', () => {
		expect(pickLevel(0, 45, PYRAMID)).toBe(14);
		expect(pickLevel(-1, 45, PYRAMID)).toBe(14);
		expect(pickLevel(NaN, 45, PYRAMID)).toBe(14);
	});
});

describe('the level a reduction is answered at', () => {
	beforeEach(() => {
		setTerrainLevels(PYRAMID);
	});
	afterEach(() => {
		setTerrainLevels(DEFAULT_LEVELS);
	});

	it('is chosen from the bins, not from the caller', async () => {
		const g = await reduceCapsule(A, B, {
			halfWidthM: 5 * NM_TO_METERS,
			alongBins: 24,
			crossBinM: NM_TO_METERS,
			crossMax: 5,
		});
		expect(g.z).toBe(pickLevel(NM_TO_METERS, (A.lat + B.lat) / 2, PYRAMID));
		expect(g.z).toBeLessThan(PYRAMID.deepest);
	});

	it('is the deepest for the strip under the track, which is a point query in disguise', async () => {
		const g = await reduceCapsule(A, B, { halfWidthM: 'track', alongBins: 24, crossMax: 0 });
		expect(g.z).toBe(PYRAMID.deepest);
		// And the strip is sized FROM that level: half a pixel diagonal, the
		// lattice's covering radius, so every point of the track has a pixel.
		expect(g.frame.halfWidthM).toBeGreaterThan(0);
		expect(g.frame.halfWidthM).toBeLessThan(20);
	});

	it('honours a level a caller pins, which is how the pin enumerates', async () => {
		const g = await reduceCapsule(A, B, { halfWidthM: 5 * NM_TO_METERS, alongBins: 24, z: 11 });
		expect(g.z).toBe(11);
	});

	it('counts the tiles that never arrived', async () => {
		const g = await reduceCapsule(A, B, { halfWidthM: 5 * NM_TO_METERS, alongBins: 24 });
		expect(g.tiles).toBe(0);
		expect(g.missing).toBeGreaterThan(0);
	});
});

describe('a leg that lost tiles', () => {
	it('is unknown, not the extremes of the tiles that did arrive', async () => {
		const ground = await computeCorridorGround([A, B], { halfWidthNM: 5 });
		expect(ground.legMaxFt).toEqual([null]);
		expect(ground.legMinFt).toEqual([null]);
	});
});

describe('the pin holds what the reduction asks for', () => {
	beforeEach(() => {
		setTerrainLevels(PYRAMID);
	});
	afterEach(() => {
		setTerrainLevels(DEFAULT_LEVELS);
	});

	it('enumerates every level the corridor reduction actually read at', async () => {
		// The invariant the pin rests on. Both sides come from the same
		// corridorPlan, so this is a pin against divergence, not a guess.
		for (const route of [
			[A, B],
			[A, B, { lat: 45.62, lon: 6.77 }],
			[{ lat: 48.75, lon: 2.1 }, { lat: 49.39, lon: 1.18 }],
		]) {
			const pinned = corridorTerrainLevels(route, { halfWidthNM: 5 });
			const read = await computeCorridorGround(route, { halfWidthNM: 5 });
			expect(read.legZ).toHaveLength(route.length - 1);
			for (const z of read.legZ) {
				expect(pinned).toContain(z);
			}
		}
	});

	it('keeps two levels apart: z8 (0,0) is not z14 (0,0)', () => {
		const one = corridorTerrainTiles([[A, B]], 5, [8]);
		const two = corridorTerrainTiles([[A, B]], 5, [8, 12]);
		const deep = corridorTerrainTiles([[A, B]], 5, [12]);
		expect(one.length).toBeGreaterThan(0);
		expect(two.length).toBe(one.length + deep.length);
		expect(new Set(two.map((t) => `${t.z}/${t.x}/${t.y}`)).size).toBe(two.length);
	});
});
