/* The chart notes' times (src/lib/format/datetime.ts formatZuluNear): a
 * bare "13:00Z" on the reader's own UTC day, the full stamp on another. */
import { describe, expect, it } from 'vitest';
import { formatZulu, formatZuluNear } from '$lib/format/datetime';

describe('formatZuluNear', () => {
	const NOW = Date.UTC(2026, 9, 2, 10, 47);

	it('prints a time of the same UTC day bare', () => {
		expect(formatZuluNear(Date.UTC(2026, 9, 2, 13, 0), NOW)).toBe('13:00Z');
		expect(formatZuluNear(Date.UTC(2026, 9, 2, 0, 0), NOW)).toBe('00:00Z');
	});

	it('prints another day in full', () => {
		const tomorrow = Date.UTC(2026, 9, 3, 7, 0);
		expect(formatZuluNear(tomorrow, NOW)).toBe(formatZulu(new Date(tomorrow)));
		expect(formatZuluNear(tomorrow, NOW)).toBe('2026-10-03 07:00Z');
	});

	it('prints nothing it cannot read', () => {
		expect(formatZuluNear(Number.NaN, NOW)).toBe('–');
	});
});
