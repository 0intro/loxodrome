/* Unit tests for the cross-route NOTAM-fetch helper: the ICAO union, dedup and
 * cap. Pure, no network or map.
 *
 * The bounding-box envelope used to live here too. It went when the corridor
 * fetches stopped gating their display on a box: the union of corridor boxes
 * had no caller left, and a function kept alive only by its own test is not
 * covered, it is dead. */

import { describe, it, expect } from 'vitest';
import { unionRouteIcaos, MAX_ICAOS_PER_FETCH } from '$lib/autorouter/viewport';

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
