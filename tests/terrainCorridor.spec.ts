/* The capsule reduction over REAL terrain.
 *
 * Fixture: a frozen int16 grid at z12/2125/1464
 * (tests/fixtures/alpine-12-2125-1464.i16.gz). It covers 45.520..45.563 N,
 * 6.797..6.885 E, the ridge between Albertville and Bourg-St-Maurice, and
 * holds 1212..3550 m of relief in one tile.
 *
 * Those bytes came from the terrain source this app used before its own
 * mosaic, and they stay because what is pinned here is the ALGORITHM, not the
 * source: the numbers below would be a shade different read from the mosaic
 * today, and nothing in these assertions depends on which grid it is. It is
 * also the input to the committed Go-written .tile fixture, so the two move
 * together or not at all. The claim that the mosaic reads better ground is
 * tests/terrainSummits.spec.ts, against our own tiles.
 *
 * Two things are pinned here that synthetic tiles cannot pin: that the fast
 * separable reduction agrees with the obvious slow one over real ground, and
 * how much the one-point-per-cell probe it replaced used to miss. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
	bilinear,
	binMax,
	binMin,
	capsuleFrame,
	makeCapsuleBins,
	metresToFeet,
	reduceTileIntoCapsule,
	tileColLon,
	tilePixel,
	tileRowLat,
	TILE_SIZE,
	type DecodedTile,
} from '$lib/map/terrain';
import { corridorSamplePoints } from '$lib/route/minAltitude';
import { pointToSegmentDistanceM } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';

const Z = 12;
const TX = 2125;
const TY = 1464;

/** The fixture as metres, row-major. */
const metres = new Int16Array(
	gunzipSync(readFileSync('tests/fixtures/alpine-12-2125-1464.i16.gz')).buffer,
);

/** The same tile as the app holds it after decoding: three bands, equal
 *  here because this grid has one value per pixel. */
const tile: DecodedTile = { z: Z, tx: TX, ty: TY, mean: metres, max: metres, min: metres };

const at = (row: number, col: number): number => metres[row * TILE_SIZE + col];

// A leg across the ridge, inside the fixture tile.
const A = { lat: 45.525, lon: 6.802 };
const B = { lat: 45.558, lon: 6.879 };
const HALF_WIDTH_NM = 1;

/** The obvious implementation: every pixel of the tile, kept by its own
 *  distance to the leg. */
function bruteForce(halfWidthNM: number): { max: number; min: number } {
	const limitM = halfWidthNM * NM_TO_METERS;
	let max = -Infinity;
	let min = Infinity;
	for (let row = 0; row < TILE_SIZE; row++) {
		const lat = tileRowLat(Z, TY, row);
		for (let col = 0; col < TILE_SIZE; col++) {
			const lon = tileColLon(Z, TX, col);
			if (pointToSegmentDistanceM(lat, lon, A.lat, A.lon, B.lat, B.lon) > limitM) {
				continue;
			}
			const m = Math.max(0, at(row, col));
			if (m > max) {
				max = m;
			}
			if (m < min) {
				min = m;
			}
		}
	}
	return { max, min };
}

/** What the app used to do: one bilinear point per corridor cell. */
function pointGridMax(halfWidthNM: number, alongStepNM: number, crossStepNM: number): number {
	let max = -Infinity;
	for (const p of corridorSamplePoints(A, B, halfWidthNM, alongStepNM, crossStepNM)) {
		const { tx, ty, fx, fy } = tilePixel(p.lat, p.lon, Z);
		if (tx !== TX || ty !== TY) {
			continue; // outside the fixture: the caps reach past it
		}
		const sx = fx - 0.5;
		const sy = fy - 0.5;
		const x0 = Math.max(0, Math.min(TILE_SIZE - 2, Math.floor(sx)));
		const y0 = Math.max(0, Math.min(TILE_SIZE - 2, Math.floor(sy)));
		const v = bilinear(
			at(y0, x0),
			at(y0, x0 + 1),
			at(y0 + 1, x0),
			at(y0 + 1, x0 + 1),
			sx - x0,
			sy - y0,
		);
		const m = Math.max(0, v);
		if (m > max) {
			max = m;
		}
	}
	return max;
}

function reduce(halfWidthNM: number, alongBins: number, crossStepNM: number) {
	const frame = capsuleFrame(A, B, {
		halfWidthM: halfWidthNM * NM_TO_METERS,
		alongBins,
		crossBinM: crossStepNM * NM_TO_METERS,
		crossMax: Math.floor(halfWidthNM / crossStepNM + 1e-9),
	});
	const bins = makeCapsuleBins(frame);
	reduceTileIntoCapsule(tile, frame, bins);
	let max = -Infinity;
	let min = Infinity;
	for (let ai = frame.alongMin; ai <= frame.alongMax; ai++) {
		for (let ci = -frame.crossMax; ci <= frame.crossMax; ci++) {
			const hi = binMax(bins, ai, ci);
			const lo = binMin(bins, ai, ci);
			if (hi != null && hi > max) {
				max = hi;
			}
			if (lo != null && lo < min) {
				min = lo;
			}
		}
	}
	return { max, min };
}

describe('capsule reduction over a real tile', () => {
	it('reads the tile the fixture says it is', () => {
		expect(metres.length).toBe(TILE_SIZE * TILE_SIZE);
		let lo = Infinity;
		let hi = -Infinity;
		for (const v of metres) {
			if (v < lo) {
				lo = v;
			}
			if (v > hi) {
				hi = v;
			}
		}
		expect(lo).toBe(1212);
		expect(hi).toBe(3550);
	});

	it('agrees with the obvious pixel-by-pixel implementation', () => {
		const fast = reduce(HALF_WIDTH_NM, 4, 1);
		const slow = bruteForce(HALF_WIDTH_NM);
		expect(fast.max).toBe(slow.max);
		expect(fast.min).toBe(slow.min);
	});

	it('agrees at a wider corridor too', () => {
		const fast = reduce(2, 4, 1);
		const slow = bruteForce(2);
		expect(fast.max).toBe(slow.max);
		expect(fast.min).toBe(slow.min);
	});

	it('finds ground the one-point-per-cell probe stepped over', () => {
		// The regression this whole reduction exists to prevent: on real
		// Alpine ground a 1 NM cell hides hundreds of feet from a probe that
		// reads only its centre.
		const reduced = metresToFeet(reduce(HALF_WIDTH_NM, 4, 1).max);
		const probed = metresToFeet(pointGridMax(HALF_WIDTH_NM, 1, 1));
		expect(reduced).toBeGreaterThan(probed + 300);
	});
});
