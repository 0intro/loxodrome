/* How the packs pair the trips' loading sheets on their landscape sheets
 * (src/lib/components/flightprep/mbBlocks.ts): two side by side where their
 * measured PAIR fits, a trip alone otherwise, the trips in order. */
import { describe, expect, it } from 'vitest';
import {
	PAIR_BUDGET_MM,
	PAIR_COLUMN_MM,
	PAIR_GAP_MM,
	PAIR_SHEET_MM,
	PX_PER_MM,
	candidatePairs,
	pairBlocks,
	singleBlocks,
} from '../src/lib/components/flightprep/mbBlocks';

const budget = PAIR_BUDGET_MM * PX_PER_MM;

describe('mbBlocks', () => {
	it('a landscape A4 less its 12 mm margins, two columns 8 mm apart', () => {
		expect(PAIR_SHEET_MM).toBe(297 - 24);
		expect(PAIR_COLUMN_MM * 2 + PAIR_GAP_MM).toBe(PAIR_SHEET_MM);
		// Under the 186 mm a sheet holds, less the 12 mm a pair opens on.
		expect(PAIR_BUDGET_MM).toBeLessThanOrEqual(210 - 24 - 12);
	});

	it('the measure\'s own layout: every pair two neighbours could make', () => {
		expect(candidatePairs(1)).toEqual([]);
		expect(candidatePairs(2)).toEqual([[0, 1]]);
		expect(candidatePairs(5)).toEqual([[0, 1], [1, 2], [2, 3], [3, 4]]);
		expect(singleBlocks(3)).toEqual([[0], [1], [2]]);
	});

	it('pairs in order where the pair fits, a trip alone where its pair with the next does not', () => {
		const ok = budget - 10;
		const tall = budget + 1;
		expect(pairBlocks(6, [ok, ok, ok, ok, ok], budget)).toEqual([[0, 1], [2, 3], [4, 5]]);
		expect(pairBlocks(3, [ok, ok], budget)).toEqual([[0, 1], [2]]);
		// A heavy middle trip prints alone, both its pairs too tall; its
		// neighbours pair around it where they can, in order.
		expect(pairBlocks(4, [tall, tall, ok], budget)).toEqual([[0], [1], [2, 3]]);
		expect(pairBlocks(3, [tall, ok], budget)).toEqual([[0], [1, 2]]);
		// Two columns each within the budget can make a pair that is not:
		// level rows add one's notes above its table to the other's lines
		// under its chart.
		expect(pairBlocks(2, [tall], budget)).toEqual([[0], [1]]);
		expect(pairBlocks(1, [], budget)).toEqual([[0]]);
		expect(pairBlocks(0, [], budget)).toEqual([]);
	});

	it('never pairs on a height the measure could not read', () => {
		expect(pairBlocks(2, [0], budget)).toEqual([[0], [1]]);
		expect(pairBlocks(2, [Number.NaN], budget)).toEqual([[0], [1]]);
		expect(pairBlocks(3, [budget - 1], budget)).toEqual([[0, 1], [2]]);
		expect(pairBlocks(3, [budget + 1], budget)).toEqual([[0], [1], [2]]);
	});
});
