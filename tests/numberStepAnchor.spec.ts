/* Pins the one judgement in $lib/ui/numberStepAnchor.ts: what an empty number
 * input's spinner steps from. A gray placeholder over an empty box is the value
 * in force (the automatic one), so the arrows must anchor on it instead of on
 * the browser's zero; a placeholder that states no value must anchor nothing,
 * since inventing one would commit a number the pilot never chose. Every case
 * below is a field the app actually renders. */
import { describe, expect, it } from 'vitest';
import { stepAnchor } from '../src/lib/ui/numberStepAnchor';

describe('stepAnchor', () => {
	it('anchors an empty box on the number its placeholder shows', () => {
		expect(stepAnchor('', '80')).toBe('80'); // M&B front seats, default mass
		expect(stepAnchor('', '1013')).toBe('1013'); // QNH, the standard
		expect(stepAnchor('', '5000')).toBe('5000'); // transition altitude
		expect(stepAnchor('', '10')).toBe('10'); // taxi, both ground movements
		expect(stepAnchor('', '30')).toBe('30'); // final reserve, VFR by day
		expect(stepAnchor('', '1.3')).toBe('1.3'); // performance margin factor
		expect(stepAnchor('', '0')).toBe('0'); // a calm wind component
		expect(stepAnchor('', '-5')).toBe('-5'); // temperature below zero
	});

	it('leaves a box that carries its own value alone', () => {
		expect(stepAnchor('80', '80')).toBe(null);
		expect(stepAnchor('0', '80')).toBe(null); // a typed zero is a value
	});

	it('reads no anchor out of a blank placeholder, where Number would read 0', () => {
		// The cruise field's placeholder is empty with no aircraft selected, and
		// the fuel plan's minutes before their column has a computed row.
		expect(stepAnchor('', '')).toBe(null);
		expect(stepAnchor('', '   ')).toBe(null);
	});

	it('reads no anchor out of a worded placeholder', () => {
		expect(stepAnchor('', '—')).toBe(null); // flapless landing factor
		expect(stepAnchor('', '= capacity')).toBe(null); // usable fuel
		expect(stepAnchor('', '= capacité')).toBe(null);
		expect(stepAnchor('', 'hh:mm')).toBe(null);
		expect(stepAnchor('', 'Infinity')).toBe(null);
		expect(stepAnchor('', 'NaN')).toBe(null);
	});

	it('normalises the anchor, since type=number drops what it cannot parse', () => {
		expect(stepAnchor('', ' 80 ')).toBe('80');
		expect(stepAnchor('', '080')).toBe('80');
	});
});
