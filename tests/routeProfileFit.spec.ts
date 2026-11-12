import { describe, expect, it } from 'vitest';
import { fitWpLabels } from '../src/lib/components/routeProfileFit';

// The chart's own metric (routeProfileFit CHAR_W).
const CH = 5.4;

describe('fitWpLabels', () => {
	it('renders both ends whole, anchored outward', () => {
		const out = fitWpLabels(
			[
				{ x: 46, label: 'LFPL' },
				{ x: 700, label: 'LFQV' },
			],
			46,
			730,
		);
		expect(out[0]).toEqual({ text: 'LFPL', anchor: 'start' });
		expect(out[1]).toEqual({ text: 'LFQV', anchor: 'end' });
	});

	it('ellipsizes a long interior into the room between its neighbours', () => {
		const out = fitWpLabels(
			[
				{ x: 46, label: 'LFPL' },
				{ x: 150, label: 'Pont de Saint-Jean-les-Deux-Jumeaux' },
				{ x: 300, label: 'LFQV' },
			],
			46,
			320,
		);
		const mid = out[1];
		expect(mid).not.toBeNull();
		expect(mid!.anchor).toBe('middle');
		expect(mid!.text.endsWith('…')).toBe(true);
		expect(mid!.text.length).toBeLessThan('Pont de Saint-Jean-les-Deux-Jumeaux'.length);
		// The rendered width stays inside the granted room on both sides.
		const w = mid!.text.length * CH;
		expect(150 - w / 2).toBeGreaterThanOrEqual(46 + 4 * CH); // past the kept departure
		expect(150 + w / 2).toBeLessThanOrEqual(300 - 4 * CH); // clear of the destination
	});

	it('drops an interior with no room instead of colliding', () => {
		const out = fitWpLabels(
			[
				{ x: 46, label: 'LFPL' },
				{ x: 72, label: 'Marolles' }, // right on the departure label
				{ x: 300, label: 'LFQV' },
			],
			46,
			320,
		);
		expect(out[1]).toBeNull();
	});

	it('the destination outranks the interior beside it', () => {
		const out = fitWpLabels(
			[
				{ x: 46, label: 'LFPL' },
				{ x: 292, label: 'Coulommiers' }, // under the destination label
				{ x: 300, label: 'LFQV' },
			],
			46,
			320,
		);
		expect(out[2]).toEqual({ text: 'LFQV', anchor: 'end' });
		expect(out[1]).toBeNull();
	});

	it('a blank label never reserves space', () => {
		const out = fitWpLabels(
			[
				{ x: 46, label: 'LFPL' },
				{ x: 80, label: '' },
				{ x: 120, label: 'REM' },
				{ x: 300, label: 'LFQV' },
			],
			46,
			320,
		);
		expect(out[1]).toBeNull();
		expect(out[2]).not.toBeNull();
	});

	it('interiors chain off the previously KEPT label, not the previous tick', () => {
		const out = fitWpLabels(
			[
				{ x: 46, label: 'LFPL' },
				{ x: 70, label: 'Dropped one' },
				{ x: 160, label: 'REM' },
				{ x: 400, label: 'LFQV' },
			],
			46,
			430,
		);
		expect(out[1]).toBeNull();
		// REM fits because the drop freed the room back to the departure.
		expect(out[2]).toEqual({ text: 'REM', anchor: 'middle' });
	});

	it('handles the empty and single-item cases', () => {
		expect(fitWpLabels([], 46, 320)).toEqual([]);
		expect(fitWpLabels([{ x: 46, label: 'LFPL' }], 46, 320)).toEqual([
			{ text: 'LFPL', anchor: 'start' },
		]);
	});
});
