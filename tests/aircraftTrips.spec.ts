/* Trip / alternate pairing (src/lib/aircraft/trips.ts): the interleave
 * convention trip 1, alternate 1, trip 2, ... and the orphan cases. */

import { describe, it, expect } from 'vitest';
import { orderedTrips, orphanAlternates, stopBaseKey, tripStopKeys } from '$lib/aircraft/trips';

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

describe('tripStopKeys', () => {
	interface W {
		kind: string;
		ident?: string | undefined;
		lat: number;
		lon: number;
	}
	interface RW {
		id: string;
		alternate?: boolean | undefined;
		waypoints: W[];
	}
	const ap = (ident: string): W => ({ kind: 'airport', ident, lat: 0, lon: 0 });
	const leg = (id: string, ...waypoints: W[]): RW => ({ id, waypoints });
	const keys = (list: RW[]) => Object.fromEntries(tripStopKeys(orderedTrips(list)));

	it('names the stop before each trip but the first by its aerodrome', () => {
		expect(keys([leg('t1', ap('LFPL'), ap('LFQH')), leg('t2', ap('LFQH'), ap('LFGP')), leg('t3', ap('LFGP'), ap('LFPL'))])).toEqual({
			1: 'LFQH',
			2: 'LFGP',
		});
		expect(keys([leg('t1', ap('LFPL'), ap('LFQH'))])).toEqual({});
		expect(keys([])).toEqual({});
	});

	it('a field left twice keeps one key per visit, the second visit #2', () => {
		// A-B, B-A, A-B: the stops are B then A, no repeat.
		expect(keys([leg('t1', ap('LFPL'), ap('LFQH')), leg('t2', ap('LFQH'), ap('LFPL')), leg('t3', ap('LFPL'), ap('LFQH'))])).toEqual({
			1: 'LFQH',
			2: 'LFPL',
		});
		// A-B, B-C, C-B, B-D: B is a stop twice.
		expect(
			keys([
				leg('t1', ap('LFPL'), ap('LFQH')),
				leg('t2', ap('LFQH'), ap('LFGP')),
				leg('t3', ap('LFGP'), ap('LFQH')),
				leg('t4', ap('LFQH'), ap('LFPK')),
			]),
		).toEqual({ 1: 'LFQH', 2: 'LFGP', 3: 'LFQH#2' });
	});

	it('is the previous trip\'s LAST waypoint (the uplift point), upper-cased, a free point by position', () => {
		const strip: W = { kind: 'free', lat: 48.5, lon: 3.81234 };
		expect(keys([leg('t1', ap('LFPL'), ap('lfqh')), leg('t2', ap('LFAB'), strip), leg('t3', strip, ap('LFPL'))])).toEqual({
			1: 'LFQH',
			2: '48.5000,3.8123',
		});
		expect(stopBaseKey({ kind: 'navaid', ident: 'MTD', lat: 48.97, lon: 2.62 })).toBe('48.9700,2.6200');
	});

	it('skips a trip that cannot fly (fewer than two waypoints), and the alternates', () => {
		const list: RW[] = [
			leg('t1', ap('LFPL'), ap('LFQH')),
			{ id: 'a1', alternate: true, waypoints: [ap('LFQH'), ap('LFQB')] },
			leg('t2', ap('LFQH')),
			leg('t3', ap('LFQH'), ap('LFPL')),
		];
		// The trip indices stay orderedTrips' own: t3 is trip index 2.
		expect(keys(list)).toEqual({ 2: 'LFQH' });
	});
});
