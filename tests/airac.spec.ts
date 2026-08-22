import { describe, it, expect } from 'vitest';
import {
	airacYYNN,
	airacEffective,
	currentAiracString,
	parseEffectiveMs,
	AIRAC_EPOCH_MS,
	AIRAC_PERIOD_MS,
} from '../src/lib/data/airac';

describe('parseEffectiveMs', () => {
	it("takes a '+02:00' stamp's own calendar date at 00:00 UTC", () => {
		// Raw Date.parse would give 2026-08-05T22:00Z, the eve of the cycle.
		expect(parseEffectiveMs('2026-08-06T00:00:00.000+02:00')).toBe(Date.UTC(2026, 7, 6));
	});

	it('keeps a Z stamp on its own date', () => {
		expect(parseEffectiveMs('2026-08-06T00:00:00.000Z')).toBe(Date.UTC(2026, 7, 6));
	});

	it('accepts a bare calendar date', () => {
		expect(parseEffectiveMs('2026-08-06')).toBe(Date.UTC(2026, 7, 6));
	});

	it('is null for unparseable input', () => {
		expect(parseEffectiveMs('not-a-date')).toBeNull();
	});
});

describe('airacYYNN', () => {
	it('returns 2401 at the epoch anchor (2024-01-25)', () => {
		expect(airacYYNN('2024-01-25T00:00:00Z')).toBe('2401');
	});

	it('returns 2605 for the current French SIA cycle (2026-05-14)', () => {
		expect(airacYYNN('2026-05-14T00:00:00+02:00')).toBe('2605');
	});

	it('returns 2606 for the next AIRAC cycle (2026-06-11)', () => {
		expect(airacYYNN('2026-06-11T00:00:00+02:00')).toBe('2606');
	});

	it('returns 2413 for the last cycle of 2024 (2024-12-26)', () => {
		expect(airacYYNN('2024-12-26T00:00:00Z')).toBe('2413');
	});

	it('returns 2501 for the first cycle of 2025 (2025-01-23)', () => {
		expect(airacYYNN('2025-01-23T00:00:00Z')).toBe('2501');
	});

	it('returns the previous cycle one second before an effective boundary', () => {
		// One second before 2026-06-11T00:00:00Z is still within cycle 2605.
		const justBefore = new Date(Date.UTC(2026, 5, 11) - 1000);
		expect(airacYYNN(justBefore)).toBe('2605');
	});

	it('takes a Date instance at its UTC instant', () => {
		// UTC midnight on the cycle boundary should land in the new cycle.
		expect(airacYYNN(new Date(Date.UTC(2026, 4, 14)))).toBe('2605');
		// One second earlier still belongs to the previous cycle.
		expect(airacYYNN(new Date(Date.UTC(2026, 4, 14) - 1000))).toBe('2604');
	});

	it('returns empty string on unparseable input', () => {
		expect(airacYYNN('not-a-date')).toBe('');
	});
});

describe('airacEffective', () => {
	it('is the inverse of airacYYNN on cycle boundaries', () => {
		for (const yynn of ['2401', '2413', '2501', '2605', '2606']) {
			const d = airacEffective(yynn);
			expect(d).not.toBeNull();
			if (d) {
				expect(airacYYNN(d)).toBe(yynn);
			}
		}
	});

	it('returns the epoch date for 2401', () => {
		expect(airacEffective('2401')?.getTime()).toBe(AIRAC_EPOCH_MS);
	});

	it('rejects malformed YYNN', () => {
		expect(airacEffective('260')).toBeNull();
		expect(airacEffective('AIRAC 2605')).toBeNull();
		expect(airacEffective('2600')).toBeNull(); // cycle 0
		expect(airacEffective('2699')).toBeNull(); // cycle 99 > 14
	});
});

describe('currentAiracString', () => {
	it('formats the SIA URL convention', () => {
		const may14 = Date.parse('2026-05-14T12:00:00Z');
		expect(currentAiracString(may14)).toBe('14_MAY_2026');
	});

	it('snaps mid-cycle moments to the cycle start', () => {
		const midCycle = Date.parse('2026-05-25T00:00:00Z');
		expect(currentAiracString(midCycle)).toBe('14_MAY_2026');
	});
});

describe('AIRAC constants', () => {
	it('AIRAC_PERIOD_MS is exactly 28 days', () => {
		expect(AIRAC_PERIOD_MS).toBe(28 * 86_400_000);
	});

	it('AIRAC_EPOCH_MS is 2024-01-25T00:00:00Z', () => {
		expect(new Date(AIRAC_EPOCH_MS).toISOString()).toBe(
			'2024-01-25T00:00:00.000Z',
		);
	});
});
