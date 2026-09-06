/* Unit tests for the multi-route NOTAM-fetch helpers: the bounding-box envelope
 * and the cross-route ICAO union (dedup + cap). Pure, no network or map. */

import { describe, it, expect } from 'vitest';
import { unionBboxes, unionRouteIcaos, MAX_ICAOS_PER_FETCH } from '$lib/autorouter/viewport';
import type { Bbox } from '$lib/notam/geometry';

describe('unionBboxes', () => {
	it('envelopes disjoint boxes so both are covered', () => {
		const a: Bbox = { minLat: 40, maxLat: 41, minLon: 1, maxLon: 2 };
		const b: Bbox = { minLat: 45, maxLat: 47, minLon: 5, maxLon: 8 };
		expect(unionBboxes([a, b])).toEqual({ minLat: 40, maxLat: 47, minLon: 1, maxLon: 8 });
	});

	it('skips nulls and returns null when every box is null / empty', () => {
		const a: Bbox = { minLat: 40, maxLat: 41, minLon: 1, maxLon: 2 };
		expect(unionBboxes([null, a, null])).toEqual(a);
		expect(unionBboxes([null, null])).toBeNull();
		expect(unionBboxes([])).toBeNull();
	});
});

describe('unionRouteIcaos', () => {
	it('dedups a shared airport / FIR across routes, keeping first-seen order', () => {
		const merged = unionRouteIcaos([
			{ airports: ['LFPL', 'LFAI'], firs: ['LFFF'] },
			{ airports: ['LFAI', 'LFPK'], firs: ['LFFF', 'LFRR'] },
		]);
		expect(merged.airports).toEqual(['LFPL', 'LFAI', 'LFPK']);
		expect(merged.firs).toEqual(['LFFF', 'LFRR']);
	});

	it('caps the combined airport list at MAX_ICAOS_PER_FETCH', () => {
		const many = Array.from({ length: MAX_ICAOS_PER_FETCH + 100 }, (_, i) => `A${i}`);
		const merged = unionRouteIcaos([{ airports: many, firs: [] }]);
		expect(merged.airports).toHaveLength(MAX_ICAOS_PER_FETCH);
		expect(merged.airports[0]).toBe('A0');
	});

	it('returns empty sets for no routes', () => {
		expect(unionRouteIcaos([])).toEqual({ airports: [], firs: [] });
	});
});
