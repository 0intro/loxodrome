/* The fuel on board before the departure's refuel (src/lib/aircraft/
 * onBoard.ts): the journey log run line by line, the way the tanks lived it,
 * and a typed figure never clamped into a plausible one. */

import { describe, it, expect } from 'vitest';
import {
	aboardOf,
	computeOnBoard,
	onBoardStale,
	type LogFlight,
	type OnBoardInputs,
	type OnBoardSpec,
} from '$lib/aircraft/onBoard';

const SPEC: OnBoardSpec = { aircraftKey: 'F-GORQ', usableL: 100, tabsL: 60, sheetLph: 25 };

function reading(over: Partial<OnBoardInputs> = {}): OnBoardInputs {
	return {
		aircraft: 'F-GORQ',
		readOn: '2026-10-06',
		last: { kind: 'full' },
		flights: [],
		lph: null,
		measuredL: null,
		...over,
	};
}

const flown = (min: number | null, addedL: number | null = null): LogFlight => ({ min, addedL });

describe('computeOnBoard: the journey log', () => {
	it('full tanks, then 0:45 and 0:40 at the sheet consumption', () => {
		const r = computeOnBoard(reading({ flights: [flown(45), flown(40)] }), SPEC);
		expect(r.kind).toBe('estimate');
		if (r.kind !== 'estimate') return;
		expect(r.anchorL).toBe(100);
		expect(r.flownMin).toBe(85);
		expect(r.flights).toBe(2);
		expect(r.addedL).toBe(0);
		expect(r.lph).toBe(25);
		expect(r.burntL).toBeCloseTo(35.4167, 4);
		expect(r.litres).toBeCloseTo(64.5833, 4);
		expect(r.overflowL).toBe(0);
	});

	it('the anchors: to the tabs, a quantity', () => {
		const tabs = computeOnBoard(reading({ last: { kind: 'tabs' }, flights: [flown(60)] }), SPEC);
		expect(tabs).toMatchObject({ kind: 'estimate', anchorL: 60, litres: 35 });
		const litres = computeOnBoard(reading({ last: { kind: 'litres', litres: 70 }, flights: [flown(24)] }), SPEC);
		expect(litres).toMatchObject({ kind: 'estimate', anchorL: 70, litres: 60 });
	});

	it('a refuel and no flight since: the anchor itself', () => {
		expect(computeOnBoard(reading(), SPEC)).toMatchObject({ kind: 'estimate', litres: 100, flownMin: 0, flights: 0 });
	});

	it('what is missing to read it', () => {
		expect(computeOnBoard(reading({ last: null, flights: [flown(45)] }), SPEC)).toEqual({
			kind: 'unresolved',
			reason: 'noAnchor',
		});
		expect(computeOnBoard(reading({ last: { kind: 'tabs' } }), { ...SPEC, tabsL: null })).toEqual({
			kind: 'unresolved',
			reason: 'noTabs',
		});
		expect(computeOnBoard(reading({ last: { kind: 'litres', litres: null } }), SPEC)).toEqual({
			kind: 'unresolved',
			reason: 'noLitres',
		});
		expect(computeOnBoard(reading({ flights: [flown(45)] }), { ...SPEC, sheetLph: null })).toEqual({
			kind: 'unresolved',
			reason: 'noConsumption',
		});
	});

	it('no time flown needs no consumption', () => {
		const r = computeOnBoard(
			reading({ last: { kind: 'litres', litres: 40 }, flights: [flown(null, 30)] }),
			{ ...SPEC, sheetLph: null },
		);
		expect(r).toMatchObject({ kind: 'estimate', litres: 70, addedL: 30, flownMin: 0 });
	});

	it('nothing stated at all is unknown, blank lines included', () => {
		expect(computeOnBoard(null, SPEC)).toEqual({ kind: 'unknown' });
		expect(computeOnBoard(reading({ last: null, flights: [flown(null), flown(0, 0)] }), SPEC)).toEqual({
			kind: 'unknown',
		});
	});

	it('blank lines are no flights', () => {
		const r = computeOnBoard(reading({ flights: [flown(null), flown(60), flown(0, 0)] }), SPEC);
		expect(r).toMatchObject({ kind: 'estimate', flights: 1, flownMin: 60, litres: 75 });
	});

	it('litres added after the last flight', () => {
		const r = computeOnBoard(reading({ flights: [flown(60), flown(null, 20)] }), SPEC);
		expect(r).toMatchObject({ kind: 'estimate', litres: 95, addedL: 20, flights: 1 });
	});

	it('run line by line: an addition the tanks could not hold is counted, never carried', () => {
		// Full, 0:30 (12.5 L), 15 L added, 1:00 (25 L): 75 L, where summing
		// first and clamping the end would read 77.5.
		const r = computeOnBoard(reading({ flights: [flown(30), flown(60, 15)] }), SPEC);
		expect(r.kind).toBe('estimate');
		if (r.kind !== 'estimate') return;
		expect(r.litres).toBeCloseTo(75, 9);
		expect(r.overflowL).toBeCloseTo(2.5, 9);
		expect(r.addedL).toBe(15);
	});

	it('a log burning more than its fuel misses a refuel', () => {
		expect(
			computeOnBoard(reading({ last: { kind: 'litres', litres: 20 }, flights: [flown(60)] }), SPEC),
		).toEqual({ kind: 'impossible', anchorL: 20, flownMin: 60, addedL: 0, burntL: 25, lph: 25 });
		// Mid-log: a later addition does not make the earlier line possible.
		const mid = computeOnBoard(
			reading({ last: { kind: 'litres', litres: 20 }, flights: [flown(60), flown(30, 50)] }),
			SPEC,
		);
		expect(mid).toMatchObject({ kind: 'impossible', flownMin: 90, addedL: 50 });
	});

	it('burnt to exactly empty is a quantity, not a missing refuel', () => {
		expect(
			computeOnBoard(reading({ last: { kind: 'litres', litres: 25 }, flights: [flown(60)] }), SPEC),
		).toMatchObject({ kind: 'estimate', litres: 0 });
	});

	it('a typed consumption replaces the sheet one', () => {
		const r = computeOnBoard(reading({ flights: [flown(60)], lph: 30 }), SPEC);
		expect(r).toMatchObject({ kind: 'estimate', litres: 70, lph: 30, burntL: 30 });
	});
});

describe('computeOnBoard: a typed figure is never clamped', () => {
	it('above the usable fuel: said, never read as full', () => {
		expect(computeOnBoard(reading({ measuredL: 450 }), SPEC)).toEqual({ kind: 'unresolved', reason: 'aboveTank' });
		expect(computeOnBoard(reading({ last: { kind: 'litres', litres: 450 } }), SPEC)).toEqual({
			kind: 'unresolved',
			reason: 'aboveTank',
		});
		expect(computeOnBoard(reading({ flights: [flown(30, 450)] }), SPEC)).toEqual({
			kind: 'unresolved',
			reason: 'aboveTank',
		});
	});

	it('the usable fuel itself is a quantity', () => {
		expect(computeOnBoard(reading({ measuredL: 100 }), SPEC)).toEqual({ kind: 'measured', litres: 100 });
	});
});

describe('computeOnBoard: measured, another aircraft', () => {
	it('a measured quantity replaces the estimate', () => {
		expect(computeOnBoard(reading({ flights: [flown(45)], measuredL: 42 }), SPEC)).toEqual({
			kind: 'measured',
			litres: 42,
		});
		expect(computeOnBoard(reading({ last: null, measuredL: 0 }), SPEC)).toEqual({ kind: 'measured', litres: 0 });
	});

	it('a reading for another aircraft is not this one', () => {
		expect(computeOnBoard(reading({ aircraft: 'F-GKQC', measuredL: 42 }), SPEC)).toEqual({
			kind: 'otherAircraft',
			aircraft: 'F-GKQC',
		});
	});
});

describe('aboardOf, onBoardStale', () => {
	it('litres only from a reading that gives them', () => {
		expect(aboardOf({ kind: 'measured', litres: 42 })).toBe(42);
		expect(aboardOf(computeOnBoard(reading({ flights: [flown(60)] }), SPEC))).toBe(75);
		expect(aboardOf({ kind: 'unknown' })).toBeNull();
		expect(aboardOf({ kind: 'otherAircraft', aircraft: 'F-GKQC' })).toBeNull();
		expect(aboardOf({ kind: 'unresolved', reason: 'noAnchor' })).toBeNull();
		expect(
			aboardOf({ kind: 'impossible', anchorL: 20, flownMin: 60, addedL: 0, burntL: 25, lph: 25 }),
		).toBeNull();
	});

	it('stale on any other day than the flight', () => {
		expect(onBoardStale('2026-10-06', '2026-10-06')).toBe(false);
		expect(onBoardStale('2026-10-06', '2026-10-07')).toBe(true);
		expect(onBoardStale('2026-10-07', '2026-10-06')).toBe(true);
	});
});
