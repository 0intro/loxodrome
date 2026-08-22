/* Pure-math coverage for the terrain sampler (src/lib/map/terrain.ts): the
 * Terrarium RGB decode, the Web-Mercator slippy projection, bilinear blending,
 * and the metres->feet conversion. The fetch / canvas path needs a browser and
 * is exercised manually, so it isn't tested here. */

import { describe, it, expect } from 'vitest';
import {
	decodeTerrarium,
	lngLatToTile,
	bilinear,
	metresToFeet,
	minGroundPerLeg,
	type TerrainSample,
} from '$lib/map/terrain';

describe('decodeTerrarium', () => {
	it('128,0,0 is the zero point', () => {
		expect(decodeTerrarium(128, 0, 0)).toBe(0);
	});
	it('0,0,0 is the floor (-32768 m)', () => {
		expect(decodeTerrarium(0, 0, 0)).toBe(-32768);
	});
	it('255,255,255 is the ceiling (~32768 m)', () => {
		expect(decodeTerrarium(255, 255, 255)).toBeCloseTo(32767.996, 3);
	});
	it('+1 in the red channel adds exactly 256 m', () => {
		expect(decodeTerrarium(129, 0, 0) - decodeTerrarium(128, 0, 0)).toBe(256);
	});
	it('+1 in the blue channel adds 1/256 m', () => {
		expect(decodeTerrarium(128, 0, 1) - decodeTerrarium(128, 0, 0)).toBeCloseTo(1 / 256, 10);
	});
	it('round-trips a 1000 m encoding', () => {
		// 1000 m -> v = 33768 -> R=131, G=232, B=0.
		expect(decodeTerrarium(131, 232, 0)).toBe(1000);
	});
});

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

describe('minGroundPerLeg', () => {
	const s = (distNM: number, elevFt: number | null): TerrainSample => ({ distNM, elevFt });

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
});
