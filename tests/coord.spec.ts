/* Unit tests for the shared map-coordinate formatter (format/coord.ts) used
 * by the cursor badge and the right-click "Copy coordinates" action. */

import { describe, it, expect } from 'vitest';
import { wrapLon, clampLat, formatCoord, formatCoordShort } from '$lib/format/coord';

describe('wrapLon', () => {
	it('passes in-range longitudes through', () => {
		expect(wrapLon(0)).toBe(0);
		expect(wrapLon(2.3522)).toBeCloseTo(2.3522, 5);
		expect(wrapLon(-120)).toBe(-120);
	});

	it('wraps longitudes past the antimeridian into [-180, 180]', () => {
		// 540 is the second world copy of the antimeridian; ±180 collapse to -180.
		expect(wrapLon(540)).toBe(-180);
		expect(wrapLon(180)).toBe(-180);
		expect(wrapLon(-180)).toBe(-180);
		expect(wrapLon(360)).toBe(0);
		expect(wrapLon(200)).toBe(-160);
		expect(wrapLon(-200)).toBe(160);
	});
});

describe('clampLat', () => {
	it('clamps latitude to [-90, 90]', () => {
		expect(clampLat(0)).toBe(0);
		expect(clampLat(45)).toBe(45);
		expect(clampLat(120)).toBe(90);
		expect(clampLat(-120)).toBe(-90);
	});
});

describe('formatCoord', () => {
	it('formats the decimal to 5 places', () => {
		expect(formatCoord(48.8566, 2.3522).decimal).toBe('48.85660, 2.35220');
	});

	it('applies wrap and clamp before formatting the decimal', () => {
		expect(formatCoord(95, 200).decimal).toBe('90.00000, -160.00000');
	});

	it('returns a DMS string with hemisphere letters alongside the decimal', () => {
		const f = formatCoord(48.8566, 2.3522);
		expect(f.dms).toMatch(/N/);
		expect(f.dms).toMatch(/E/);
		expect(f.dms.length).toBeGreaterThan(0);
	});
});

describe('formatCoordShort', () => {
	it('drops the seconds decimals and the separator, for a title bar', () => {
		expect(formatCoordShort(48.8566, 2.3522)).toBe('48°51\'24"N 002°21\'08"E');
	});

	it('carries a rounded 60 seconds into the next minute', () => {
		// 48° 35' 59.6" must not print as 59'60".
		expect(formatCoordShort(48 + 35 / 60 + 59.6 / 3600, 0)).toBe('48°36\'00"N 000°00\'00"E');
	});

	it('names the southern and western hemispheres', () => {
		expect(formatCoordShort(-33.94, -118.4)).toBe('33°56\'24"S 118°24\'00"W');
	});

	it('applies wrap and clamp like formatCoord', () => {
		expect(formatCoordShort(95, 200)).toBe('90°00\'00"N 160°00\'00"W');
	});
});
