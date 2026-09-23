/* Validates the WMM2025 port (src/lib/route/magnetic.ts) against the official
 * NOAA WMM2025 test values (declination, field 5 of WMM2025_TestValues.txt).
 * Each case: [decimalYear, altKm, lat, lon, expectedDeclinationDeg]. */

import { describe, it, expect } from 'vitest';
import {
	magneticDeclinationDeg,
	magneticModelExpired,
	decimalYearFromDate,
	legMagneticTrackDeg,
	magneticFromTrue,
} from '$lib/route/magnetic';

const CASES: [number, number, number, number, number][] = [
	[2025.0, 28, 89, -121, -99.77],
	[2025.0, 48, 80, -96, -29.91],
	[2025.0, 65, 43, 93, 0.5],
	[2025.0, 51, -33, 109, -5.49],
	[2025.0, 18, 0, 21, 1.29],
	[2026.0, 33, -3, -147, 9.71],
	[2026.0, 95, 14, 65, -0.51],
	[2027.5, 0, -13, -59, -17.49],
	[2028.0, 30, -36, -64, -4.65],
	[2029.5, 18, 9, -172, 9.24],
	[2029.5, 33, 17, 5, 0.89],
];

describe('WMM2025 magneticDeclinationDeg', () => {
	for (const [yr, alt, lat, lon, exp] of CASES) {
		it(`D at ${yr} ${lat},${lon} ${alt}km ~= ${exp}`, () => {
			const got = magneticDeclinationDeg(lat, lon, yr, alt);
			expect(Math.abs(got - exp)).toBeLessThan(0.1);
		});
	}
});

describe('WMM2025 validity clamp', () => {
	it('holds the declination at the 2030.0 value past the validity end', () => {
		// NCEI validity statement: WMM2025 is valid 2025.0-2030.0. Beyond it
		// the secular-variation term clamps, so 2031 (and any later year)
		// returns exactly the 2030.0 declination instead of extrapolating.
		const atEnd = magneticDeclinationDeg(48.85, 2.35, 2030.0);
		expect(magneticDeclinationDeg(48.85, 2.35, 2031.0)).toBe(atEnd);
		expect(magneticDeclinationDeg(48.85, 2.35, 2040.0)).toBe(atEnd);
	});

	it('leaves in-window years untouched (2026 differs from 2030)', () => {
		expect(magneticDeclinationDeg(48.85, 2.35, 2026.0)).not.toBe(
			magneticDeclinationDeg(48.85, 2.35, 2030.0),
		);
	});

	it('flags expiry strictly past 2030.0', () => {
		expect(magneticModelExpired(new Date(Date.UTC(2031, 5, 1)))).toBe(true);
		expect(magneticModelExpired(new Date(Date.UTC(2026, 5, 1)))).toBe(false);
		expect(magneticModelExpired(new Date(Date.UTC(2029, 11, 31)))).toBe(false);
	});
});

describe('decimalYearFromDate', () => {
	it('start of year is the integer year', () => {
		expect(decimalYearFromDate(new Date(Date.UTC(2026, 0, 1)))).toBeCloseTo(2026, 6);
	});
	it('mid-year is about year + 0.5', () => {
		expect(decimalYearFromDate(new Date(Date.UTC(2026, 6, 2)))).toBeCloseTo(2026.5, 2);
	});
});

describe('magneticFromTrue', () => {
	it('subtracts east declination from the true track and normalises', () => {
		// Near Paris in 2026 the declination is a small positive (east) value,
		// so the magnetic track is a touch less than the true track.
		const decl = magneticDeclinationDeg(48.85, 2.35, 2026.0);
		expect(decl).toBeGreaterThan(0);
		expect(decl).toBeLessThan(4);
		const mag = magneticFromTrue(90, 48.85, 2.35, 2026.0);
		expect(mag).toBeCloseTo(90 - decl, 6);
	});
	it('wraps below zero', () => {
		// true track 1deg, east declination ~+2deg -> ~359deg.
		const mag = magneticFromTrue(1, 48.85, 2.35, 2026.0);
		expect(mag).toBeGreaterThan(355);
		expect(mag).toBeLessThan(360);
	});
});

describe('legMagneticTrackDeg', () => {
	it('samples the variation at the leg midpoint (the nav-log recipe)', () => {
		const a = { lat: 48.6, lon: 2.3 };
		const b = { lat: 49.1, lon: 3.1 };
		expect(legMagneticTrackDeg(80, a, b, 2026.0)).toBeCloseTo(
			magneticFromTrue(80, 48.85, 2.7, 2026.0),
			10,
		);
	});
	it('converts a wind-corrected heading through the same variation', () => {
		const a = { lat: 48.6, lon: 2.3 };
		const b = { lat: 49.1, lon: 3.1 };
		const wca = 7.5;
		expect(legMagneticTrackDeg(80 + wca, a, b, 2026.0)).toBeCloseTo(
			magneticFromTrue(80 + wca, 48.85, 2.7, 2026.0),
			10,
		);
	});
});
