/* The waypoint list's drop gap (components/tabs/route/waypointGap.ts). */
import { describe, expect, it } from 'vitest';
import { waypointGap } from '../src/lib/components/tabs/route/waypointGap';

// Four rows, 20 px tall, with 30 px leg rows between them.
const rows = [0, 50, 100, 150].map((top) => ({ top, bottom: top + 20 }));

describe('waypointGap', () => {
	it('the whole first row is before the first', () => {
		expect(waypointGap(rows, -40)).toBe(0);
		expect(waypointGap(rows, 19)).toBe(0);
	});
	it('an interior row splits at its centre, a leg row lands by the next', () => {
		expect(waypointGap(rows, 25)).toBe(1);
		expect(waypointGap(rows, 59)).toBe(1);
		expect(waypointGap(rows, 61)).toBe(2);
		expect(waypointGap(rows, 120)).toBe(3);
	});
	it('the whole last row is after the last', () => {
		expect(waypointGap(rows, 151)).toBe(4);
		expect(waypointGap(rows, 400)).toBe(4);
	});
	it('no rows: the end', () => {
		expect(waypointGap([], 10)).toBe(0);
	});
});
