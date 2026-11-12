import { describe, it, expect } from 'vitest';
import { bboxIntersectsRing, bboxesOverlap, ringBbox, type Bbox } from '$lib/notam/geometry';
import { corridorIntersectsRing } from '$lib/route/notamCorridor';
import { NM_TO_METERS } from '$lib/notam/units';
import type { LatLon } from '$lib/notam/types';

// A lopsided FIR shaped like London (EGTT): a high-latitude band across the top
// plus a western arm dropping down the Western Approaches, so its bounding box
// dips to ~48.8N far south of where the polygon actually is. [lat, lon] ring.
const LOPSIDED_FIR: [number, number][] = [
	[48.8, -8],
	[55, -8],
	[55, 5],
	[50, 5],
	[50, -4],
	[48.8, -4],
];

// A Paris-area corridor box + route: inside the FIR's bounding box but nowhere
// near its polygon (Paris sits in the empty south-east notch).
const PARIS_BOX: Bbox = { minLat: 48.5, maxLat: 49.1, minLon: 2.2, maxLon: 3.6 };
const PARIS_ROUTE: LatLon[] = [
	{ lat: 48.83, lon: 2.62 },
	{ lat: 48.85, lon: 3.02 },
];
const HALF_15NM = 15 * NM_TO_METERS;

describe('FIR selection tests the polygon, not the bounding box', () => {
	it('the FIR bounding box does clip Paris (the old false positive)', () => {
		expect(bboxesOverlap(PARIS_BOX, ringBbox(LOPSIDED_FIR))).toBe(true);
	});

	it('but the FIR polygon does not, so the viewport path rejects it', () => {
		expect(bboxIntersectsRing(PARIS_BOX, LOPSIDED_FIR)).toBe(false);
	});

	it('and the route corridor does not reach it either', () => {
		expect(corridorIntersectsRing(PARIS_ROUTE, HALF_15NM, LOPSIDED_FIR)).toBe(false);
	});

	it('a viewport / route actually inside the FIR is still selected', () => {
		const inBox: Bbox = { minLat: 51.5, maxLat: 52.5, minLon: -1, maxLon: 1 };
		expect(bboxIntersectsRing(inBox, LOPSIDED_FIR)).toBe(true);
		const inRoute: LatLon[] = [
			{ lat: 52, lon: -1 },
			{ lat: 52, lon: 1 },
		];
		expect(corridorIntersectsRing(inRoute, HALF_15NM, LOPSIDED_FIR)).toBe(true);
	});

	it('a viewport straddling the FIR boundary is selected (edge crossing)', () => {
		// Spans the northern band's southern edge at lat 50, lon 0.
		const straddle: Bbox = { minLat: 49.5, maxLat: 50.5, minLon: -0.5, maxLon: 0.5 };
		expect(bboxIntersectsRing(straddle, LOPSIDED_FIR)).toBe(true);
	});
});
