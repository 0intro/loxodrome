/* Unit tests for the wind triangle (src/lib/route/wind.ts). */

import { describe, it, expect } from 'vitest';
import { windTriangle } from '$lib/route/wind';

describe('windTriangle', () => {
	it('calm air: no correction, ground speed = airspeed', () => {
		const w = windTriangle(0, 100, 0, 0);
		expect(w).not.toBeNull();
		expect(w!.wcaDeg).toBeCloseTo(0, 6);
		expect(w!.gsKt).toBeCloseTo(100, 6);
	});

	it('pure headwind (wind from the course): GS = TAS - WS, no correction', () => {
		const w = windTriangle(0, 100, 0, 20);
		expect(w!.wcaDeg).toBeCloseTo(0, 6);
		expect(w!.gsKt).toBeCloseTo(80, 6);
	});

	it('pure tailwind (wind from behind): GS = TAS + WS, no correction', () => {
		const w = windTriangle(0, 100, 180, 20);
		expect(w!.wcaDeg).toBeCloseTo(0, 6);
		expect(w!.gsKt).toBeCloseTo(120, 6);
	});

	it('pure crosswind from the right: positive WCA, GS = sqrt(TAS^2 - WS^2)', () => {
		const w = windTriangle(0, 100, 90, 20);
		expect(w!.wcaDeg).toBeCloseTo(11.537, 3); // asin(0.2)
		expect(w!.gsKt).toBeCloseTo(Math.sqrt(100 * 100 - 20 * 20), 3); // 97.98
	});

	it('pure crosswind from the left: negative WCA, same GS', () => {
		const w = windTriangle(0, 100, 270, 20);
		expect(w!.wcaDeg).toBeCloseTo(-11.537, 3);
		expect(w!.gsKt).toBeCloseTo(Math.sqrt(100 * 100 - 20 * 20), 3);
	});

	it('crabs into the wind: wind from the right -> +WCA, from the left -> -WCA', () => {
		expect(windTriangle(0, 100, 45, 20)!.wcaDeg).toBeGreaterThan(0);
		expect(windTriangle(0, 100, 315, 20)!.wcaDeg).toBeLessThan(0);
	});

	it('handles the relative angle across the 360 boundary', () => {
		// Track 350, wind from 030: relative angle 40 deg from the right.
		const w = windTriangle(350, 100, 30, 20);
		expect(w!.wcaDeg).toBeCloseTo((Math.asin(0.2 * Math.sin((40 * Math.PI) / 180)) * 180) / Math.PI, 6);
		expect(w!.wcaDeg).toBeGreaterThan(0);
	});

	it('returns null when the wind is too strong to hold the course', () => {
		expect(windTriangle(0, 80, 90, 100)).toBeNull(); // (100/80)*sin90 = 1.25 > 1
	});

	it('returns null when a headwind meets or exceeds the airspeed (GS <= 0)', () => {
		expect(windTriangle(0, 80, 0, 80)).toBeNull(); // GS = 0
		expect(windTriangle(0, 80, 0, 100)).toBeNull(); // GS < 0
	});

	it('returns null for a non-positive airspeed', () => {
		expect(windTriangle(0, 0, 90, 20)).toBeNull();
		expect(windTriangle(0, -10, 90, 20)).toBeNull();
	});
});
