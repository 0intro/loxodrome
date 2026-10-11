/* The GNSS altitude datum (src/lib/nav/altitudeDatum.ts): which reference a
 * device's reported altitude is on, and the conversion to MSL. Contract:
 * docs/nav-live.md. */

import { describe, expect, it } from 'vitest';
import {
	altCorrectionFt,
	ellipsoidAltFt,
	mslAltFt,
	resolveAltDatum,
} from '../src/lib/nav/altitudeDatum';
import { geoidHeightFt } from '../src/lib/nav/geoid';

// Lognes, where the undulation is around +45 m (about 148 ft).
const LAT = 48.75;
const LON = 2.62;

describe('resolveAltDatum', () => {
	it('follows the platform on auto', () => {
		expect(resolveAltDatum('auto', 'ellipsoid')).toBe('ellipsoid');
		expect(resolveAltDatum('auto', 'msl')).toBe('msl');
	});

	it('pins the datum against the platform when chosen', () => {
		expect(resolveAltDatum('msl', 'ellipsoid')).toBe('msl');
		expect(resolveAltDatum('ellipsoid', 'msl')).toBe('ellipsoid');
	});
});

describe('altCorrectionFt', () => {
	it('subtracts the undulation from an ellipsoidal height', () => {
		expect(altCorrectionFt(LAT, LON, 'ellipsoid')).toBeCloseTo(-geoidHeightFt(LAT, LON), 6);
		// The France figure, in the direction that matters: an uncorrected
		// ellipsoidal altitude READS HIGH, so the correction is negative.
		expect(altCorrectionFt(LAT, LON, 'ellipsoid')).toBeLessThan(-140);
	});

	it('leaves a device already reporting MSL alone', () => {
		expect(altCorrectionFt(LAT, LON, 'msl')).toBe(0);
	});
});

describe('mslAltFt', () => {
	it('corrects an ellipsoidal altitude down to MSL', () => {
		const reported = 3000;
		const msl = mslAltFt(reported, LAT, LON, 'ellipsoid');
		expect(msl).not.toBeNull();
		expect(msl!).toBeLessThan(reported);
		expect(reported - msl!).toBeCloseTo(geoidHeightFt(LAT, LON), 6);
	});

	it('passes an MSL altitude through untouched', () => {
		expect(mslAltFt(3000, LAT, LON, 'msl')).toBe(3000);
	});

	it('invents no altitude for a device that reports none', () => {
		expect(mslAltFt(null, LAT, LON, 'ellipsoid')).toBeNull();
		expect(mslAltFt(undefined, LAT, LON, 'ellipsoid')).toBeNull();
		expect(mslAltFt(Number.NaN, LAT, LON, 'ellipsoid')).toBeNull();
	});

	it('is the identity on both datums where the geoid crosses zero', () => {
		// Somewhere on the zero undulation contour the two datums coincide, so
		// the correction has to vanish there rather than being a constant.
		const n = geoidHeightFt(-10, -35);
		expect(Math.abs(n)).toBeLessThan(40);
	});
});

describe('ellipsoidAltFt', () => {
	// The IGC B record's GNSS column is defined on the ellipsoid, the inverse
	// of every other export here (docs/trace-export.md), so the two directions
	// must differ by the undulation WHICHEVER datum the device reports. A sign
	// flip in either helper cannot pass this pair.
	it('separates from MSL by the undulation on both datums', () => {
		for (const datum of ['ellipsoid', 'msl'] as const) {
			const ell = ellipsoidAltFt(3000, LAT, LON, datum);
			const msl = mslAltFt(3000, LAT, LON, datum);
			expect(ell! - msl!).toBeCloseTo(geoidHeightFt(LAT, LON), 6);
			expect(ell!).toBeGreaterThan(msl!); // France: the ellipsoid reads high
		}
	});

	it('raises an MSL altitude and passes an ellipsoidal one through', () => {
		expect(ellipsoidAltFt(3000, LAT, LON, 'msl')).toBeCloseTo(3000 + geoidHeightFt(LAT, LON), 6);
		expect(ellipsoidAltFt(3000, LAT, LON, 'ellipsoid')).toBe(3000);
	});

	it('invents no altitude for a device that reports none', () => {
		expect(ellipsoidAltFt(null, LAT, LON, 'msl')).toBeNull();
		expect(ellipsoidAltFt(undefined, LAT, LON, 'msl')).toBeNull();
		expect(ellipsoidAltFt(Number.NaN, LAT, LON, 'msl')).toBeNull();
	});
});
