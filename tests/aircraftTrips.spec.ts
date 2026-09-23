/* Trip / alternate pairing (src/lib/aircraft/trips.ts): the interleave
 * convention trip 1, alternate 1, trip 2, ... and the orphan cases. */

import { describe, it, expect } from 'vitest';
import { orderedTrips, orphanAlternates } from '$lib/aircraft/trips';

interface R {
	id: string;
	alternate?: boolean | undefined;
}

const r = (id: string, alternate?: boolean): R => ({ id, alternate });

describe('orderedTrips', () => {
	it('pairs the interleaved convention', () => {
		const list = [r('t1'), r('a1', true), r('t2'), r('a2', true), r('t3')];
		const trips = orderedTrips(list);
		expect(trips.map((t) => t.route.id)).toEqual(['t1', 't2', 't3']);
		expect(trips.map((t) => t.alternate?.id ?? null)).toEqual(['a1', 'a2', null]);
		expect(trips.map((t) => t.index)).toEqual([0, 1, 2]);
	});

	it('attaches an alternate to the nearest preceding trip without one', () => {
		const trips = orderedTrips([r('t1'), r('t2'), r('a2', true)]);
		expect(trips.map((t) => t.alternate?.id ?? null)).toEqual([null, 'a2']);
	});

	it('ignores leading and extra alternates', () => {
		const trips = orderedTrips([r('a0', true), r('t1'), r('a1', true), r('a1b', true)]);
		expect(trips).toHaveLength(1);
		expect(trips[0].alternate!.id).toBe('a1');
	});

	it('handles an empty list and an all-trips list', () => {
		expect(orderedTrips([])).toEqual([]);
		const trips = orderedTrips([r('t1'), r('t2')]);
		expect(trips.map((t) => t.alternate)).toEqual([null, null]);
	});
});

describe('orphanAlternates', () => {
	it('reports leading and doubled alternates', () => {
		const list = [r('a0', true), r('t1'), r('a1', true), r('a1b', true), r('t2')];
		expect(orphanAlternates(list).map((x) => x.id)).toEqual(['a0', 'a1b']);
	});

	it('is empty for the clean interleave', () => {
		expect(orphanAlternates([r('t1'), r('a1', true), r('t2')])).toEqual([]);
	});
});
