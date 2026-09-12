/* Pins the airspace row loader's arcs semantics: a non-empty arcs cell
 * loads, the EMPTY cell survives as [] (a fully-surrounded FIR renders
 * entirely in the de-emphasized internal form, so [] is meaningful and
 * distinct from "no siblings"), and null / absent omit the property. */
import { describe, expect, it } from 'vitest';
import { rowToAirspace } from '$lib/data/airspaces';

const ring: [number, number][] = [
	[50, -1],
	[50, 0],
	[51, 0],
	[51, -1],
];

function row(arcsCell: unknown, len = 15): unknown[] {
	const r: unknown[] = [
		'EGTT001', 'FIR', 'LONDON FIR', 'G',
		null, null, null, null,
		'', '', '',
		[], ring, '',
	];
	if (len >= 15) {
		r.push(arcsCell);
	}
	return r;
}

describe('rowToAirspace arcs cell', () => {
	it('loads a non-empty arcs cell', () => {
		const arcs = [[[50, -1], [50, 0]]];
		const a = rowToAirspace(row(arcs), 'uk');
		expect(a?.arcs).toEqual(arcs);
	});

	it('keeps the EMPTY arcs cell as [] (fully internal ring)', () => {
		const a = rowToAirspace(row([]), 'pruatlas');
		expect(a).not.toBeNull();
		expect(a && 'arcs' in a).toBe(true);
		expect(a?.arcs).toEqual([]);
	});

	it('omits arcs for a null cell and for short legacy rows', () => {
		const withNull = rowToAirspace(row(null), 'uk');
		expect(withNull && 'arcs' in withNull).toBe(false);
		const legacy = rowToAirspace(row(undefined, 13), 'faa');
		expect(legacy && 'arcs' in legacy).toBe(false);
	});
});
