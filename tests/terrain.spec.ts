/* Pure-math coverage for the terrain sampler (src/lib/map/terrain.ts): the
 * Web-Mercator slippy projection, bilinear blending, the metres->feet
 * conversion, and the capsule reduction that reads every pixel of a corridor
 * rather than one per cell. The reduction is driven with synthetic tiles,
 * which is how a spike is placed exactly where a test wants it. */

import { describe, it, expect } from 'vitest';
import {
	binMax,
	binMin,
	bilinear,
	capsuleFrame,
	lngLatToTile,
	makeCapsuleBins,
	metresToFeet,
	minGroundPerLeg,
	reduceTileIntoCapsule,
	sampleCeilingFt,
	sampleFloorFt,
	tileColLon,
	tileGroundM,
	tileLatBounds,
	tilePixel,
	tileRowLat,
	tilesCoveringCapsule,
	TILE_SIZE,
	type DecodedTile,
	type TerrainSample,
} from '$lib/map/terrain';
import { NO_DATA } from '$lib/map/terrain';
import { TERRAIN_PIXELS } from '$lib/map/terrainTile';
import { NM_TO_METERS } from '$lib/notam/units';


describe('lngLatToTile', () => {
	it('Null Island at z0 is the centre of the single world tile', () => {
		const t = lngLatToTile(0, 0, 0);
		expect(t.x).toBeCloseTo(0.5, 10);
		expect(t.y).toBeCloseTo(0.5, 10);
	});
	it('Null Island at z1 is the 2x2 meeting corner', () => {
		const t = lngLatToTile(0, 0, 1);
		expect(t.x).toBeCloseTo(1, 10);
		expect(t.y).toBeCloseTo(1, 10);
	});
	it('the equator maps to y = n/2 at any zoom/longitude', () => {
		expect(lngLatToTile(0, 45, 5).y).toBeCloseTo(16, 10); // 2**5 / 2
		expect(lngLatToTile(0, -123, 3).y).toBeCloseTo(4, 10); // 2**3 / 2
	});
	it('the antimeridian edges map x to 0 and n', () => {
		expect(lngLatToTile(0, -180, 4).x).toBeCloseTo(0, 10);
		expect(lngLatToTile(0, 180, 4).x).toBeCloseTo(16, 10); // 2**4
	});
	it('clamps latitude to the Mercator limit (no NaN/Infinity past it)', () => {
		const yAt89 = lngLatToTile(89, 0, 6).y;
		const yAtLimit = lngLatToTile(85.05112878, 0, 6).y;
		expect(Number.isFinite(yAt89)).toBe(true);
		expect(yAt89).toBeCloseTo(yAtLimit, 6);
		expect(Math.abs(yAt89)).toBeLessThan(0.01); // pinned to the north (top) edge, y ~= 0
	});
});

describe('bilinear', () => {
	it('returns each corner at its weight extreme', () => {
		expect(bilinear(1, 2, 3, 4, 0, 0)).toBe(1);
		expect(bilinear(1, 2, 3, 4, 1, 0)).toBe(2);
		expect(bilinear(1, 2, 3, 4, 0, 1)).toBe(3);
		expect(bilinear(1, 2, 3, 4, 1, 1)).toBe(4);
	});
	it('the centre is the mean of the four corners', () => {
		expect(bilinear(1, 2, 3, 4, 0.5, 0.5)).toBeCloseTo(2.5, 10);
	});
	it('a flat field is invariant to the weights', () => {
		expect(bilinear(5, 5, 5, 5, 0.3, 0.7)).toBe(5);
		expect(bilinear(5, 5, 5, 5, 0, 1)).toBe(5);
	});
});

describe('metresToFeet', () => {
	it('0 m is 0 ft', () => {
		expect(metresToFeet(0)).toBe(0);
	});
	it('1000 m is ~3280.84 ft', () => {
		expect(metresToFeet(1000)).toBeCloseTo(3280.84, 2);
	});
});

describe('sampleFloorFt / sampleCeilingFt', () => {
	it('read the two ends of a sample band', () => {
		const s: TerrainSample = { distNM: 0, elevFt: 1000, minFt: 800, maxFt: 1400 };
		expect(sampleFloorFt(s)).toBe(800);
		expect(sampleCeilingFt(s)).toBe(1400);
	});

	it('fall back to the point value when a sample carries no band', () => {
		const s: TerrainSample = { distNM: 0, elevFt: 1000 };
		expect(sampleFloorFt(s)).toBe(1000);
		expect(sampleCeilingFt(s)).toBe(1000);
	});

	it('keep a failed tile null on both ends', () => {
		const s: TerrainSample = { distNM: 0, elevFt: null };
		expect(sampleFloorFt(s)).toBeNull();
		expect(sampleCeilingFt(s)).toBeNull();
	});
});

describe('minGroundPerLeg', () => {
	const s = (distNM: number, elevFt: number | null, minFt = elevFt): TerrainSample => ({
		distNM,
		elevFt,
		minFt,
		maxFt: elevFt,
	});

	it('takes the minimum of each leg span, boundary samples counting for both legs', () => {
		const samples = [s(0, 100), s(5, 50), s(10, 20), s(15, 30), s(20, 80)];
		expect(minGroundPerLeg(samples, [10, 20])).toEqual([20, 20]);
	});
	it('keeps legs independent away from the boundary', () => {
		const samples = [s(0, 100), s(5, 50), s(10, 200), s(15, 30), s(20, 80)];
		expect(minGroundPerLeg(samples, [10, 20])).toEqual([50, 30]);
	});
	it('propagates a failed sample as null for its leg only', () => {
		const samples = [s(0, 100), s(5, null), s(10, 200), s(15, 30), s(20, 80)];
		expect(minGroundPerLeg(samples, [10, 20])).toEqual([null, 30]);
	});
	it('yields null for a leg with no samples', () => {
		expect(minGroundPerLeg([], [10, 20])).toEqual([null, null]);
	});
	it('handles a single-leg route', () => {
		expect(minGroundPerLeg([s(0, 40), s(1, 10)], [1])).toEqual([10]);
	});
	it('takes the valley a sample point stepped over, not the point itself', () => {
		// The footprint minimum is what the applicability floor is
		// conservative in: a 1 NM cell can straddle a valley the point misses.
		const samples = [s(0, 3000, 2400), s(1, 3000, 1800), s(2, 3000, 2600)];
		expect(minGroundPerLeg(samples, [2])).toEqual([1800]);
	});
});
// --- Capsule reduction ---------------------------------------------------

const Z = 12;

/** A synthetic decoded tile: `base` metres everywhere, plus spikes at the
 *  pixels covering the given lat/lons. Three bands, all equal except where a
 *  test says otherwise, which is what a single-value source decodes to. */
function tileOf(
	tx: number,
	ty: number,
	base: number,
	spikes: { lat: number; lon: number; m: number }[],
): DecodedTile {
	const band = new Int16Array(TERRAIN_PIXELS).fill(base);
	for (const sp of spikes) {
		const p = tilePixel(sp.lat, sp.lon, Z);
		if (p.tx !== tx || p.ty !== ty) {
			continue;
		}
		band[p.py * TILE_SIZE + p.px] = sp.m;
	}
	return { z: Z, tx, ty, mean: band, max: band, min: band };
}

const A = { lat: 45, lon: 6 };
const B = { lat: 45, lon: 6.25 };

/** `northNM` / `eastNM` from a point, in the app's flat frame. */
function offset(p: { lat: number; lon: number }, northNM: number, eastNM: number) {
	const cosLat = Math.cos((p.lat * Math.PI) / 180);
	return {
		lat: p.lat + (northNM * NM_TO_METERS) / 111320,
		lon: p.lon + (eastNM * NM_TO_METERS) / (111320 * cosLat),
	};
}

/** Reduce a whole capsule over synthetic tiles and report every bin's max. */
function reduceOver(
	spikes: { lat: number; lon: number; m: number }[],
	halfWidthNM = 5,
	alongBins = 10,
) {
	const frame = capsuleFrame(A, B, {
		halfWidthM: halfWidthNM * NM_TO_METERS,
		alongBins,
		crossBinM: NM_TO_METERS,
		crossMax: halfWidthNM,
	});
	const bins = makeCapsuleBins(frame);
	for (const t of tilesCoveringCapsule(A, B, halfWidthNM, Z)) {
		reduceTileIntoCapsule(tileOf(t.x, t.y, 0, spikes), frame, bins);
	}
	let max = -Infinity;
	for (let ai = frame.alongMin; ai <= frame.alongMax; ai++) {
		for (let ci = -frame.crossMax; ci <= frame.crossMax; ci++) {
			const v = binMax(bins, ai, ci);
			if (v != null && v > max) {
				max = v;
			}
		}
	}
	return { frame, bins, max };
}

describe('tileRowLat / tileColLon', () => {
	it('name the pixel centre lngLatToTile lands in', () => {
		const lat = 45.9294;
		const lon = 6.0994;
		const p = tilePixel(lat, lon, Z);
		const rlat = tileRowLat(Z, p.ty, p.py);
		const rlon = tileColLon(Z, p.tx, p.px);
		// The centre is inside the same pixel, so it re-projects to it exactly.
		const back = tilePixel(rlat, rlon, Z);
		expect(back.tx).toBe(p.tx);
		expect(back.ty).toBe(p.ty);
		expect(back.px).toBe(p.px);
		expect(back.py).toBe(p.py);
		// And within half a pixel (27 m at 45 deg N) of where we asked.
		const pixelM = tileGroundM(lat, Z) / TILE_SIZE;
		expect(Math.abs(rlat - lat) * 111320).toBeLessThan(pixelM);
		expect(Math.abs(rlon - lon) * 111320 * Math.cos((lat * Math.PI) / 180)).toBeLessThan(pixelM);
	});

	it('agrees with the tile row bounds', () => {
		const b = tileLatBounds(Z, 1409);
		expect(b.north).toBeGreaterThan(b.south);
		expect(tileRowLat(Z, 1409, 0)).toBeLessThan(b.north);
		expect(tileRowLat(Z, 1409, TILE_SIZE - 1)).toBeGreaterThan(b.south);
	});
});

describe('tilesCoveringCapsule', () => {
	it('covers both endpoints and the ground between them', () => {
		const keys = new Set(tilesCoveringCapsule(A, B, 5, Z).map((t) => `${t.x}/${t.y}`));
		for (const p of [A, B, { lat: 45, lon: 6.125 }]) {
			const px = tilePixel(p.lat, p.lon, Z);
			expect(keys.has(`${px.tx}/${px.ty}`)).toBe(true);
		}
	});

	it('reaches beyond the ends, because the corridor is a capsule', () => {
		const keys = new Set(tilesCoveringCapsule(A, B, 5, Z).map((t) => `${t.x}/${t.y}`));
		const beyond = tilePixel(offset(B, 0, 4).lat, offset(B, 0, 4).lon, Z);
		expect(keys.has(`${beyond.tx}/${beyond.ty}`)).toBe(true);
	});

	it('leaves out ground well outside the radius', () => {
		const keys = new Set(tilesCoveringCapsule(A, B, 5, Z).map((t) => `${t.x}/${t.y}`));
		const far = offset(A, 20, 0);
		const px = tilePixel(far.lat, far.lon, Z);
		expect(keys.has(`${px.tx}/${px.ty}`)).toBe(false);
	});

	it('wraps x across the antimeridian and stays in the grid', () => {
		const tiles = tilesCoveringCapsule(
			{ lat: 10, lon: 179.9 },
			{ lat: 10, lon: -179.9 },
			5,
			Z,
		);
		expect(tiles.length).toBeGreaterThan(0);
		const xs = new Set(tiles.map((t) => t.x));
		expect(xs.has(0)).toBe(true);
		expect(xs.has((1 << Z) - 1)).toBe(true);
		for (const t of tiles) {
			expect(t.x).toBeGreaterThanOrEqual(0);
			expect(t.x).toBeLessThan(1 << Z);
		}
	});

	it('clamps to the Mercator grid near the poles', () => {
		const tiles = tilesCoveringCapsule({ lat: 85, lon: 0 }, { lat: 85, lon: 1 }, 30, Z);
		for (const t of tiles) {
			expect(t.y).toBeGreaterThanOrEqual(0);
			expect(t.y).toBeLessThan(1 << Z);
		}
	});
});

describe('reduceTileIntoCapsule', () => {
	it('finds a peak the old one-point-per-cell grid would step over', () => {
		// 0.3 NM off the track, between two 1 NM sample points: invisible to a
		// point probe, and the whole reason this reduction exists.
		const peak = offset({ lat: 45, lon: 6.125 }, 0.3, 0.4);
		const { max } = reduceOver([{ ...peak, m: 2400 }]);
		expect(max).toBe(2400);
	});

	it('bins a peak at the leg midpoint into the middle bin', () => {
		const mid = { lat: 45, lon: 6.125 };
		const { frame, bins } = reduceOver([{ ...mid, m: 1500 }], 5, 10);
		expect(frame.alongMin).toBeLessThan(0);
		expect(binMax(bins, 5, 0)).toBe(1500);
	});

	it('keeps ground abeam inside the half-width and drops it outside', () => {
		const mid = { lat: 45, lon: 6.125 };
		expect(reduceOver([{ ...offset(mid, 4.5, 0), m: 3000 }]).max).toBe(3000);
		// 0 is the synthetic field the corridor is otherwise made of: the
		// capsule was read, the spike outside it simply did not count.
		expect(reduceOver([{ ...offset(mid, 5.6, 0), m: 3000 }]).max).toBe(0);
	});

	it('counts ground BEYOND the last waypoint, within the end cap', () => {
		// SERA.5015(b) is a disc about the estimated position: swept along the
		// leg that is a capsule, so terrain 3 NM past the turn still counts.
		expect(reduceOver([{ ...offset(B, 0, 3), m: 4000 }]).max).toBe(4000);
		expect(reduceOver([{ ...offset(A, 0, -3), m: 4000 }]).max).toBe(4000);
	});

	it('drops ground past the cap radius', () => {
		expect(reduceOver([{ ...offset(B, 0, 6), m: 4000 }]).max).toBe(0);
	});

	it('rounds the cap: the corner of a rectangle is outside it', () => {
		// 4 NM past the end and 4 NM abeam is 5.66 NM from the waypoint: inside
		// a 5 NM-wide rectangle extended by 5 NM, outside the capsule.
		expect(reduceOver([{ ...offset(B, 4, 4), m: 4000 }]).max).toBe(0);
		expect(reduceOver([{ ...offset(B, 2, 2), m: 4000 }]).max).toBe(4000);
	});

	it('skips no-data rather than folding it in as an elevation', () => {
		// The sentinel is a source's way of saying it never looked; a void
		// that reaches a bin is a void that reads as ground. (The legacy
		// mosaic's sea clamp lives in its own decoder now: it says bathymetry
		// is ground at sea level, which is a fact about that source.)
		const mid = { lat: 45, lon: 6.125 };
		const frame = capsuleFrame(A, B, {
			halfWidthM: NM_TO_METERS,
			alongBins: 10,
			crossBinM: NM_TO_METERS,
			crossMax: 1,
		});
		const bins = makeCapsuleBins(frame);
		for (const t of tilesCoveringCapsule(A, B, 1, Z)) {
			reduceTileIntoCapsule(tileOf(t.x, t.y, NO_DATA, [{ ...mid, m: 200 }]), frame, bins);
		}
		expect(binMax(bins, 5, 0)).toBe(200);
		expect(binMax(bins, 2, 0)).toBeNull();
	});

	it('reports an empty bin as null, never as zero', () => {
		const frame = capsuleFrame(A, B, {
			halfWidthM: NM_TO_METERS,
			alongBins: 10,
			crossBinM: NM_TO_METERS,
			crossMax: 1,
		});
		const bins = makeCapsuleBins(frame);
		expect(binMax(bins, 3, 0)).toBeNull();
		expect(binMin(bins, 3, 0)).toBeNull();
	});
});
