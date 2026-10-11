/* The embedded EGM96 lattice (src/lib/nav/geoid.ts + the generated
 * geoidData.ts): the geoid undulation that turns an ellipsoidal GNSS height
 * into one comparable with a published altitude.
 *
 * Reference values are the EGM96 model's own, read from the full 15-minute
 * grid; the lattice is a whole-degree subsample of it, so nodes agree to the
 * metre of quantisation and points between them to the interpolation error
 * measured in cmd/geoid (0.49 m RMS worldwide). Tolerances below are set from
 * that, not from the implementation. */

import { describe, expect, it } from 'vitest';
import { geoidHeightFt, geoidHeightM } from '../src/lib/nav/geoid';
import { GEOID_COLS, GEOID_ROWS, GEOID_STEP_DEG } from '../src/lib/nav/geoidData';

describe('the lattice', () => {
	it('is a whole-degree global grid with the antimeridian repeated', () => {
		expect(GEOID_STEP_DEG).toBe(1);
		expect(GEOID_ROWS).toBe(181);
		expect(GEOID_COLS).toBe(361);
	});
});

describe('geoidHeightM', () => {
	it('matches EGM96 at the equator on the prime meridian', () => {
		// The model's best-known spot check: N = 17.16 m at 0N 0E.
		expect(geoidHeightM(0, 0)).toBeCloseTo(17.16, 0);
	});

	it('matches EGM96 over metropolitan France', () => {
		// LFPL Lognes and LFBO Toulouse; France runs about +44 to +51 m, which
		// is the whole reason the correction exists.
		expect(geoidHeightM(48.75, 2.62)).toBeGreaterThan(43);
		expect(geoidHeightM(48.75, 2.62)).toBeLessThan(48);
		expect(geoidHeightM(43.63, 1.37)).toBeGreaterThan(46);
		expect(geoidHeightM(43.63, 1.37)).toBeLessThan(52);
	});

	it('reaches the model extremes at the known low and high', () => {
		// The Indian Ocean geoid low and the New Guinea high bound the model.
		expect(geoidHeightM(4.7, 78.7)).toBeLessThan(-90);
		expect(geoidHeightM(-8.4, 147.4)).toBeGreaterThan(50);
	});

	it('is continuous across the antimeridian', () => {
		const west = geoidHeightM(30, -179.999);
		const east = geoidHeightM(30, 179.999);
		expect(Math.abs(west - east)).toBeLessThan(0.5);
	});

	it('wraps longitude outside [-180, 180] instead of reading off the grid', () => {
		expect(geoidHeightM(45, 200)).toBeCloseTo(geoidHeightM(45, -160), 6);
		expect(geoidHeightM(45, -200)).toBeCloseTo(geoidHeightM(45, 160), 6);
	});

	it('clamps beyond the poles rather than extrapolating', () => {
		expect(geoidHeightM(95, 10)).toBeCloseTo(geoidHeightM(90, 10), 6);
		expect(geoidHeightM(-95, 10)).toBeCloseTo(geoidHeightM(-90, 10), 6);
	});

	it('interpolates between nodes rather than stepping', () => {
		const a = geoidHeightM(48, 2);
		const b = geoidHeightM(49, 2);
		const mid = geoidHeightM(48.5, 2);
		expect(mid).toBeCloseTo((a + b) / 2, 6);
		expect(mid).not.toBe(a);
	});

	it('answers a finite value everywhere on a coarse sweep', () => {
		for (let lat = -90; lat <= 90; lat += 7) {
			for (let lon = -180; lon <= 180; lon += 11) {
				const n = geoidHeightM(lat, lon);
				expect(Number.isFinite(n)).toBe(true);
				// The EGM96 undulation range, with room for the quantisation.
				expect(n).toBeGreaterThan(-110);
				expect(n).toBeLessThan(90);
			}
		}
	});
});

describe('geoidHeightFt', () => {
	it('is the metre value in feet', () => {
		expect(geoidHeightFt(48.75, 2.62)).toBeCloseTo(geoidHeightM(48.75, 2.62) / 0.3048, 6);
		// France: the correction a pilot would notice, around 150 ft.
		expect(geoidHeightFt(48.75, 2.62)).toBeGreaterThan(140);
		expect(geoidHeightFt(48.75, 2.62)).toBeLessThan(160);
	});
});
