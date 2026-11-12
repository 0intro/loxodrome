/* Where a place joins a route (route/bestInsertion.ts): on the leg it
 * lengthens least, never before the departure or after the destination. */

import { describe, expect, it } from 'vitest';
import { bestInsertionIndex } from '$lib/route/bestInsertion';

// A staircase on the equator, one degree a leg: A-B east, B-C north, C-D east.
const A = { lat: 0, lon: 0 };
const B = { lat: 0, lon: 1 };
const C = { lat: 1, lon: 1 };
const D = { lat: 1, lon: 2 };

describe('bestInsertionIndex', () => {
	it('has no leg to offer a route of fewer than two points', () => {
		expect(bestInsertionIndex([], A)).toBeNull();
		expect(bestInsertionIndex([A], B)).toBeNull();
	});

	it('takes the one leg there is, even for a point past its end', () => {
		expect(bestInsertionIndex([A, B], { lat: 0, lon: 3 })).toBe(0);
	});

	it('takes the leg the point lengthens least', () => {
		const route = [A, B, C, D];
		expect(bestInsertionIndex(route, { lat: 0.02, lon: 0.5 })).toBe(0);
		expect(bestInsertionIndex(route, { lat: 0.5, lon: 1.02 })).toBe(1);
		expect(bestInsertionIndex(route, { lat: 1.01, lon: 1.6 })).toBe(2);
	});

	it('gives a tie to the earlier leg', () => {
		// A there-and-back: both legs run along the same line.
		expect(bestInsertionIndex([A, B, A], { lat: 0, lon: 0.5 })).toBe(0);
	});

	it('measures across the antimeridian the short way', () => {
		const fiji = { lat: -17.75, lon: 177.44 };
		const samoa = { lat: -13.83, lon: -171.76 };
		const tonga = { lat: -21.24, lon: -175.15 };
		// About 8 km off Fiji-Samoa, which crosses 180°; some 390 km of
		// detour on Samoa-Tonga. Measured the long way round, Fiji-Samoa
		// would cost thousands.
		expect(bestInsertionIndex([fiji, samoa, tonga], { lat: -15.8, lon: -177.4 })).toBe(0);
	});
});
