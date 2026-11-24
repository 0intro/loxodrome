/* Pins frenchFirPresence (src/lib/route/airspaces.ts), the printed-chart
 * zone pick's FIR test: inside/outside the LF metropolitan FIR rows, with
 * STEP_NM leg sampling so a leg between two inside waypoints still reports
 * an excursion across a concave boundary, and null (FRANCE fallback) when
 * the dataset or its French FIR rows are missing. */

import { describe, it, expect } from 'vitest';
import { frenchFirPresence } from '$lib/route/airspaces';
import type { Airspace } from '$lib/data/airspaces';

function bboxOf(ring: [number, number][]): Airspace['bbox'] {
	let minLat = Infinity;
	let minLon = Infinity;
	let maxLat = -Infinity;
	let maxLon = -Infinity;
	for (const [lat, lon] of ring) {
		minLat = Math.min(minLat, lat);
		maxLat = Math.max(maxLat, lat);
		minLon = Math.min(minLon, lon);
		maxLon = Math.max(maxLon, lon);
	}
	return { minLat, minLon, maxLat, maxLon };
}

function fir(id: string, ring: [number, number][]): Airspace {
	return {
		id,
		key: id,
		type: 'FIR',
		name: id,
		category: 'fir',
		ring,
		bbox: bboxOf(ring),
	} as unknown as Airspace;
}

// A France-like square FIR, lat 42..51 x lon -5..8.
const LFFF = fir('LFFF', [
	[42, -5],
	[51, -5],
	[51, 8],
	[42, 8],
]);

// A C-shaped FIR: the square above with a slot cut from the south edge up to
// lat 49 between lon 1 and 3, so a straight leg between the two arms leaves
// the FIR mid-way.
const NOTCHED = fir('LFRR', [
	[42, -5],
	[51, -5],
	[51, 8],
	[42, 8],
	[42, 3],
	[49, 3],
	[49, 1],
	[42, 1],
]);

const PARIS = { lat: 48.8, lon: 3.6 };
const NANTES = { lat: 47.2, lon: -1.6 };
const LONDON = { lat: 51.5, lon: -0.5 };

describe('frenchFirPresence', () => {
	it('a domestic route is inside only', () => {
		expect(frenchFirPresence([[PARIS, NANTES]], [LFFF])).toEqual({
			inside: true,
			outside: false,
		});
	});

	it('a border-crossing route reports both sides', () => {
		expect(frenchFirPresence([[PARIS, LONDON]], [LFFF])).toEqual({
			inside: true,
			outside: true,
		});
	});

	it('a wholly foreign route is outside only', () => {
		expect(frenchFirPresence([[LONDON]], [LFFF])).toEqual({ inside: false, outside: true });
	});

	it('leg sampling catches an excursion between two inside waypoints', () => {
		// Both endpoints sit in the C's arms; the straight leg crosses the
		// notch (lon 1..3 below lat 49), which is outside the FIR.
		const inLeftArm = { lat: 45, lon: 0 };
		const inRightArm = { lat: 45, lon: 4 };
		expect(frenchFirPresence([[inLeftArm, inRightArm]], [NOTCHED])).toEqual({
			inside: true,
			outside: true,
		});
	});

	it('null without the dataset or without LF FIR rows', () => {
		expect(frenchFirPresence([[PARIS]], null)).toBeNull();
		expect(frenchFirPresence([[PARIS]], [])).toBeNull();
		// An overseas FIR (non-LF prefix) does not count as metropolitan.
		expect(frenchFirPresence([[PARIS]], [fir('SOCA', LFFF.ring)])).toBeNull();
	});

	it('empty routes report neither side', () => {
		expect(frenchFirPresence([], [LFFF])).toEqual({ inside: false, outside: false });
	});
});
