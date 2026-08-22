/* Kneeboard-card chunking (src/lib/components/navlogCards.ts), all three
 * packers: packMeasuredChunks packs MEASURED per-leg band heights (the
 * primary, closing-cost-aware path fed by navlogMeasure's print-prep DOM
 * mount), packScheduleChunks packs MEASURED schedule row heights (rows
 * are self-closing, so interior cuts cost nothing and only the final part
 * closes with the foot), kneeboardCardChunks packs estimated per-leg line
 * costs (the nav-log no-DOM fallback). All fill greedily, balance, and
 * reserve the closing block on the last card. Estimator calibration
 * anchors: a standard six-line leg fits 7 per card; a frequency-heavy
 * ten-line aerodrome leg fits 4 (both measured with the printToPDF
 * harness). */

import { describe, it, expect } from 'vitest';
import {
	affordablePadWaypoints,
	partPadWaypoints,
	KNEEBOARD_BUDGET_LINES,
	LEG_BASE_LINES,
	TOTALS_LINES,
	cardKey,
	estimatorCardChunks,
	expandCards,
	kneeboardCardChunks,
	kneeboardLegCosts,
	packMeasuredChunks,
	packScheduleChunks,
	pairCards,
} from '$lib/components/navlogCards';

const STD = 6; // plain leg: the two 40px rows, content absorbed
const HEAVY = 10; // aerodrome banner with frequency + enroute + radial growth

function coverage(chunks: { from: number; to: number }[], n: number): void {
	expect(chunks[0]?.from).toBe(0);
	expect(chunks.at(-1)?.to).toBe(n);
	for (let i = 1; i < chunks.length; i++) {
		expect(chunks[i].from).toBe(chunks[i - 1].to);
	}
}

describe('kneeboardCardChunks', () => {
	it('fits seven standard legs on one card (the calibration anchor)', () => {
		const chunks = kneeboardCardChunks(new Array<number>(7).fill(STD));
		expect(chunks).toEqual([{ from: 0, to: 7 }]);
		expect(7 * STD + TOTALS_LINES).toBeLessThanOrEqual(KNEEBOARD_BUDGET_LINES);
		expect(8 * STD + TOTALS_LINES).toBeGreaterThan(KNEEBOARD_BUDGET_LINES);
	});

	it('splits eight standard legs into two balanced cards', () => {
		const chunks = kneeboardCardChunks(new Array<number>(8).fill(STD));
		expect(chunks.length).toBe(2);
		coverage(chunks, 8);
		const sizes = chunks.map((c) => c.to - c.from);
		expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
	});

	it('fits four heavy aerodrome legs per card (the worst-case anchor)', () => {
		const chunks = kneeboardCardChunks(new Array<number>(4).fill(HEAVY));
		expect(chunks).toEqual([{ from: 0, to: 4 }]);
		const five = kneeboardCardChunks(new Array<number>(5).fill(HEAVY));
		expect(five.length).toBe(2);
		coverage(five, 5);
	});

	it('reserves the totals band on the last card', () => {
		// 6 standard legs + one leg sized so that leg + totals overflow:
		// the final leg moves to its own card instead of orphaning totals.
		const costs = [...new Array<number>(6).fill(STD), KNEEBOARD_BUDGET_LINES - 6 * STD];
		const chunks = kneeboardCardChunks(costs);
		expect(chunks.length).toBe(2);
		const last = chunks.at(-1)!;
		const lastSum = costs.slice(last.from).reduce((a, b) => a + b, 0);
		expect(lastSum + TOTALS_LINES).toBeLessThanOrEqual(KNEEBOARD_BUDGET_LINES);
	});

	it('gives a single over-budget leg its own card instead of dropping it', () => {
		const chunks = kneeboardCardChunks([STD, KNEEBOARD_BUDGET_LINES + 5, STD]);
		coverage(chunks, 3);
		expect(chunks.some((c) => c.to - c.from === 1)).toBe(true);
	});

	it('returns no cards for empty costs', () => {
		expect(kneeboardCardChunks([])).toEqual([]);
	});

	it('covers [0, n) contiguously within budget across a sweep', () => {
		for (let n = 1; n <= 40; n++) {
			const costs = Array.from({ length: n }, (_, i) => 4 + ((i * 7) % 9));
			const chunks = kneeboardCardChunks(costs);
			coverage(chunks, n);
			for (const [i, c] of chunks.entries()) {
				const reserve = i === chunks.length - 1 ? TOTALS_LINES : 0;
				const s = costs.slice(c.from, c.to).reduce((a, b) => a + b, 0);
				if (c.to - c.from > 1) {
					expect(s + reserve).toBeLessThanOrEqual(KNEEBOARD_BUDGET_LINES);
				}
			}
		}
	});
});

describe('packMeasuredChunks', () => {
	// Px-flavoured fixtures: a 194mm A5 card allowance minus a header is in
	// the ~650px range; a plain measured band (two 40px rows) is >= 80px.
	const BUDGET = 650;

	/** Closing-inclusive load of one part (the fit the packer guarantees). */
	function load(costs: number[], c: { from: number; to: number }, totalsPx: number): number {
		const closing = c.to >= costs.length ? totalsPx : costs[c.to];
		return costs.slice(c.from, c.to).reduce((a, b) => a + b, 0) + closing;
	}

	it('fills one card greedily while legs plus the totals block fit', () => {
		// 6 x 80 + totals 100 = 580 <= 650; a seventh leg would overflow.
		expect(packMeasuredChunks(new Array<number>(6).fill(80), BUDGET, 100)).toEqual([
			{ from: 0, to: 6 },
		]);
	});

	it('splits and balances with closing-inclusive loads', () => {
		const costs = new Array<number>(7).fill(80);
		const chunks = packMeasuredChunks(costs, BUDGET, 100);
		expect(chunks.length).toBe(2);
		coverage(chunks, 7);
		// Balanced 4/3, not the greedy 6/1: loads 400+80 vs 240+100.
		expect(chunks.map((c) => c.to - c.from)).toEqual([4, 3]);
		for (const c of chunks) {
			expect(load(costs, c, 100)).toBeLessThanOrEqual(BUDGET);
		}
	});

	it('charges the repeated boundary band as a non-final closing cost', () => {
		// Two 300px legs sum to 600 <= 650, but a cut after them repeats the
		// 300px boundary band: the measured packer cuts after ONE leg where
		// the reserve-only estimator chunker would keep two.
		const costs = [300, 300, 300];
		expect(packMeasuredChunks(costs, BUDGET, 50)).toEqual([
			{ from: 0, to: 1 },
			{ from: 1, to: 3 },
		]);
		expect(kneeboardCardChunks(costs, BUDGET, 50)).toEqual([
			{ from: 0, to: 2 },
			{ from: 2, to: 3 },
		]);
	});

	it('reserves the measured totals block on the last card', () => {
		// 3 x 200 = 600 <= 650 alone, but the 100px totals block overflows,
		// so the log splits; the balancing pass then evens the parts to
		// 1 + 2 legs (closing-inclusive loads 400 / 500, not 600 / 300),
		// and the last card fits WITH its totals.
		const costs = [200, 200, 200];
		const chunks = packMeasuredChunks(costs, BUDGET, 100);
		expect(chunks).toEqual([
			{ from: 0, to: 1 },
			{ from: 1, to: 3 },
		]);
		expect(load(costs, chunks.at(-1)!, 100)).toBeLessThanOrEqual(BUDGET);
	});

	it('gives a single over-budget band its own card instead of dropping it', () => {
		const chunks = packMeasuredChunks([80, 800, 80], BUDGET, 50);
		coverage(chunks, 3);
		expect(chunks).toEqual([
			{ from: 0, to: 1 },
			{ from: 1, to: 2 },
			{ from: 2, to: 3 },
		]);
	});

	it('returns no cards for empty costs', () => {
		expect(packMeasuredChunks([], BUDGET, 100)).toEqual([]);
	});

	it('covers [0, n) contiguously within closing-inclusive budget across a sweep', () => {
		for (let n = 1; n <= 40; n++) {
			const costs = Array.from({ length: n }, (_, i) => 60 + ((i * 37) % 90));
			const chunks = packMeasuredChunks(costs, 500, 80);
			coverage(chunks, n);
			for (const c of chunks) {
				if (c.to - c.from > 1) {
					expect(load(costs, c, 80)).toBeLessThanOrEqual(500);
				}
			}
		}
	});
});

describe('partPadWaypoints', () => {
	const BUDGET = 650;

	it('pads each part of the pinned 4/3 split from its own leftover', () => {
		const costs = new Array<number>(7).fill(80);
		const chunks = packMeasuredChunks(costs, BUDGET, 100);
		expect(chunks.map((c) => c.to - c.from)).toEqual([4, 3]);
		// Closing-inclusive loads 400 and 340 leave 250 and 310 px: 3 blank
		// pairs each, so minWaypoints 5+3 (capped at the 8-row form) and 4+3.
		expect(chunks.map((c) => partPadWaypoints(costs, c, BUDGET, 100, 80))).toEqual([8, 7]);
	});

	it('never pads past the closing-inclusive budget across a sweep', () => {
		for (let n = 1; n <= 40; n++) {
			const costs = Array.from({ length: n }, (_, i) => 60 + ((i * 37) % 90));
			const chunks = packMeasuredChunks(costs, 500, 80);
			for (const c of chunks) {
				const wps = c.to - c.from + 1;
				const minWps = partPadWaypoints(costs, c, 500, 80, 80);
				const closing = c.to >= costs.length ? 80 : costs[c.to];
				const partLoad = costs.slice(c.from, c.to).reduce((a, b) => a + b, 0) + closing;
				if (c.to - c.from > 1) {
					expect(partLoad + (minWps - wps) * 80).toBeLessThanOrEqual(500);
				}
			}
		}
	});

	it('pads nothing at or past the form size, totals counted on the final part', () => {
		const costs = new Array<number>(8).fill(40);
		expect(partPadWaypoints(costs, { from: 0, to: 8 }, BUDGET, 100, 80)).toBe(8);
		// A final part whose totals block eats the leftover affords nothing.
		expect(partPadWaypoints([80], { from: 0, to: 1 }, 200, 120, 80)).toBe(2);
	});

	it('matches the single-card afford for an unsplit log', () => {
		// chunks.length === 1 reduces to the same formula
		// measuredMinWaypoints uses, so single cards stay bit-identical.
		const costs = [90, 70, 60];
		expect(partPadWaypoints(costs, { from: 0, to: 3 }, BUDGET, 100, 80)).toBe(
			affordablePadWaypoints(4, 90 + 70 + 60 + 100, BUDGET, 80),
		);
	});
});

describe('packScheduleChunks', () => {
	const BUDGET = 650;

	/** Closing-inclusive load of one part: rows plus the final foot only. */
	function load(costs: number[], c: { from: number; to: number }, footPx: number): number {
		const closing = c.to >= costs.length ? footPx : 0;
		return costs.slice(c.from, c.to).reduce((a, b) => a + b, 0) + closing;
	}

	it('charges no interior closing cost (rows are self-closing)', () => {
		// Two 300px rows fill 600 <= 650 because a schedule cut repeats no
		// boundary row; the nav-log packer, charging the repeated band,
		// would cut after ONE.
		const costs = [300, 300, 300];
		expect(packScheduleChunks(costs, BUDGET, 0)).toEqual([
			{ from: 0, to: 2 },
			{ from: 2, to: 3 },
		]);
		expect(packMeasuredChunks(costs, BUDGET, 0)).toEqual([
			{ from: 0, to: 1 },
			{ from: 1, to: 3 },
		]);
	});

	it('fills one card while the rows plus the foot fit', () => {
		expect(packScheduleChunks(new Array<number>(6).fill(100), BUDGET, 50)).toEqual([
			{ from: 0, to: 6 },
		]);
	});

	it('reserves the foot on the last card and balances', () => {
		// 6 x 100 = 600 <= 650 alone, but the 100px foot overflows, so the
		// schedule splits; the balancing pass evens the greedy 5/1 to 4/2.
		const costs = new Array<number>(6).fill(100);
		const chunks = packScheduleChunks(costs, BUDGET, 100);
		expect(chunks).toEqual([
			{ from: 0, to: 4 },
			{ from: 4, to: 6 },
		]);
		coverage(chunks, 6);
		for (const c of chunks) {
			expect(load(costs, c, 100)).toBeLessThanOrEqual(BUDGET);
		}
	});

	it('gives a single over-budget row its own card instead of dropping it', () => {
		const chunks = packScheduleChunks([100, 800, 100], BUDGET, 50);
		coverage(chunks, 3);
		expect(chunks).toEqual([
			{ from: 0, to: 1 },
			{ from: 1, to: 2 },
			{ from: 2, to: 3 },
		]);
	});

	it('returns no cards for empty costs', () => {
		expect(packScheduleChunks([], BUDGET, 100)).toEqual([]);
	});

	it('covers [0, n) contiguously within closing-inclusive budget across a sweep', () => {
		for (let n = 1; n <= 40; n++) {
			const costs = Array.from({ length: n }, (_, i) => 20 + ((i * 37) % 60));
			const chunks = packScheduleChunks(costs, 500, 80);
			coverage(chunks, n);
			for (const c of chunks) {
				if (c.to - c.from > 1) {
					expect(load(costs, c, 80)).toBeLessThanOrEqual(500);
				}
			}
		}
	});
});

describe('kneeboardLegCosts', () => {
	const wp = (over: Record<string, unknown> = {}) =>
		({ kind: 'free', ident: undefined, label: 'PT A', notes: undefined, freqsManual: null, ...over }) as never;

	it('prices a standard leg at the six-unit base (two lines absorbed)', () => {
		// Short name + a note wrapping to two lines: both stacks fit the
		// absorbed allowance, so the leg stays at the base.
		const costs = kneeboardLegCosts([wp({ notes: 'Follow the river then the railway' }), wp()]);
		expect(costs).toEqual([LEG_BASE_LINES]);
	});

	it('prices airport frequency banners from the radio lookup', () => {
		const costs = kneeboardLegCosts(
			[wp({ kind: 'airport', ident: 'LFPL' }), wp()],
			{ radioLines: () => 4 },
		);
		// name 1 + freq 4 = 5 banner lines, 2 absorbed -> base + 3.
		expect(costs).toEqual([LEG_BASE_LINES + 3]);
	});

	it('counts manual frequency lines and the enroute / radial columns', () => {
		const costs = kneeboardLegCosts(
			[wp({ freqsManual: 'TWR: 118.1\nATIS: 128.4' }), wp()],
			{ enrouteLine: true, radialLine: true },
		);
		// name 1 + manual 2 + enroute 1 + radial 1 = 5, 2 absorbed -> +3.
		expect(costs).toEqual([LEG_BASE_LINES + 3]);
	});

	it('wraps long names and multi-line notes', () => {
		const long = wp({ label: 'A'.repeat(50), notes: 'x\ny\nz\nw' });
		const [cost] = kneeboardLegCosts([long, wp()]);
		// 4 note lines beat the ceil(50/24) = 3 name lines; 2 absorbed -> +2.
		expect(cost).toBe(LEG_BASE_LINES + 2);
	});

	it('prices one cost per leg (waypoints - 1)', () => {
		expect(kneeboardLegCosts([wp(), wp(), wp()]).length).toBe(2);
		expect(kneeboardLegCosts([wp()])).toEqual([]);
	});
});

describe('expandCards', () => {
	const route = { id: 'r1' };

	it('keeps a single chunk as one whole-content card (no range, no part)', () => {
		// The whole log renders and no "1/1" marker prints: the card is the
		// unsplit shape both print flows always produced.
		expect(expandCards(route, [{ from: 0, to: 7 }])).toEqual([{ route }]);
	});

	it('keeps empty chunks as one whole-content card (the unmeasured schedule)', () => {
		expect(expandCards(route, [])).toEqual([{ route }]);
	});

	it('numbers continuation cards with their absolute ranges', () => {
		const cards = expandCards(route, [
			{ from: 0, to: 4 },
			{ from: 4, to: 7 },
		]);
		expect(cards).toEqual([
			{ route, range: { from: 0, to: 4 }, part: { index: 1, count: 2 } },
			{ route, range: { from: 4, to: 7 }, part: { index: 2, count: 2 } },
		]);
		// cardKey stays unique across the parts and stable for the unsplit card.
		expect(cards.map(cardKey)).toEqual(['r1:1', 'r1:2']);
		expect(cardKey(expandCards(route, [])[0])).toBe('r1');
	});
});

describe('pairCards', () => {
	it('groups cards two per sheet, the last sheet taking the remainder', () => {
		expect(pairCards([1, 2, 3, 4, 5, 6])).toEqual([
			[1, 2],
			[3, 4],
			[5, 6],
		]);
		expect(pairCards(['a', 'b', 'c'])).toEqual([['a', 'b'], ['c']]);
		expect(pairCards([])).toEqual([]);
	});
});

describe('estimatorCardChunks', () => {
	const wp = (over: Record<string, unknown> = {}) =>
		({ kind: 'free', ident: undefined, label: 'PT A', notes: undefined, freqsManual: null, ...over }) as never;
	const cols = { enrouteFreqs: false, vorRadials: false };

	it('is the line-cost chunker over the leg costs (the fallback both flows share)', () => {
		const wps = new Array(9).fill(null).map(() => wp());
		expect(estimatorCardChunks(wps, null, cols)).toEqual(
			kneeboardCardChunks(kneeboardLegCosts(wps)),
		);
	});

	it('prices airport banners from the coalesced radio lines', () => {
		// Four distinct frequencies coalesce to four banner lines: the same
		// growth as radioLines: () => 4 through the raw chunker.
		const radios = [
			{ freq: '118.100', unit: 'TWR', call: '' },
			{ freq: '121.800', unit: 'GND', call: '' },
			{ freq: '128.425', unit: 'ATIS', call: '' },
			{ freq: '134.875', unit: 'APP', call: '' },
		];
		const wps = new Array(6).fill(null).map(() => wp({ kind: 'airport', ident: 'LFPO' }));
		expect(estimatorCardChunks(wps, () => radios, cols)).toEqual(
			kneeboardCardChunks(kneeboardLegCosts(wps, { radioLines: () => 4 })),
		);
		// The frequency-heavy chain splits where the all-free route does not.
		expect(estimatorCardChunks(wps, () => radios, cols).length).toBeGreaterThan(
			estimatorCardChunks(wps, null, cols).length,
		);
	});

	it('ignores the radio lookup when null (dataset absent or column off)', () => {
		const wps = new Array(6).fill(null).map(() => wp({ kind: 'airport', ident: 'LFPO' }));
		expect(estimatorCardChunks(wps, null, cols)).toEqual(
			kneeboardCardChunks(kneeboardLegCosts(wps, { radioLines: () => 0 })),
		);
	});

	it('adds the enroute and radial column lines', () => {
		const wps = new Array(8).fill(null).map(() => wp());
		expect(
			estimatorCardChunks(wps, null, { enrouteFreqs: true, vorRadials: true }),
		).toEqual(
			kneeboardCardChunks(kneeboardLegCosts(wps, { enrouteLine: true, radialLine: true })),
		);
	});
});

describe('affordablePadWaypoints', () => {
	it('keeps the full form when the card has room', () => {
		expect(affordablePadWaypoints(3, 300, 733, 80)).toBe(8);
	});

	it('caps the pads to what fits beside heavy content', () => {
		// 733 - 650 = 83 px left: one blank pair fits, not five.
		expect(affordablePadWaypoints(3, 650, 733, 80)).toBe(4);
		expect(affordablePadWaypoints(3, 733, 733, 80)).toBe(3);
	});

	it('leaves routes at or past the form size alone', () => {
		expect(affordablePadWaypoints(8, 700, 733, 80)).toBe(8);
		expect(affordablePadWaypoints(12, 700, 733, 80)).toBe(8);
	});
});
