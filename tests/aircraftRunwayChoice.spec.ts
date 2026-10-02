/* The default runway choice (bestRunwayEnd, src/lib/aircraft/aerodromes.ts):
 * the end needing the least (the normal take-off before the short-field one,
 * with the margin), then paved before grass, then most into wind, ties to
 * the earliest end (dataset order = the main runway). "Paved wins" within a
 * rank: among long-enough runways a paved one beats a more-into-wind grass
 * one; grass is used only when no paved runway is long enough. The rank
 * comes first (user decision, 2026-10-02): an end where the normal take-off
 * fits beats a paved one asking for the short-field procedure. */

import { describe, it, expect } from 'vitest';
import { bestRunwayEnd, type RunwayPick } from '$lib/aircraft/aerodromes';

type End = { id: string };

function pick(
	id: string,
	opts: { grass?: boolean; headwindKt?: number; longEnough?: boolean; rank?: 0 | 1 | 2 } = {},
): RunwayPick<End> {
	return {
		end: { id },
		grass: opts.grass ?? false,
		headwindKt: opts.headwindKt ?? 0,
		// longEnough reads as the two ends of the rank: the normal take-off
		// fits (0) or nothing does (2).
		rank: opts.rank ?? (opts.longEnough === false ? 2 : 0),
	};
}

const choose = (picks: RunwayPick<End>[]): string | null => bestRunwayEnd(picks)?.id ?? null;

describe('bestRunwayEnd', () => {
	it('picks the most into-wind end among long-enough paved runways', () => {
		// One runway 08/26, wind favours 08 (the reciprocal sees a tailwind).
		expect(choose([pick('08', { headwindKt: 3 }), pick('26', { headwindKt: -3 })])).toBe('08');
		// Order-independent: the into-wind end wins from either listing order.
		expect(choose([pick('26', { headwindKt: -3 }), pick('08', { headwindKt: 3 })])).toBe('08');
	});

	it('prefers a long-enough paved runway over a more into-wind grass one', () => {
		expect(
			choose([
				pick('08', { grass: false, headwindKt: 3, longEnough: true }),
				pick('15', { grass: true, headwindKt: 12, longEnough: true }),
			]),
		).toBe('08');
	});

	it('uses grass only when no paved runway is long enough', () => {
		expect(
			choose([
				pick('08', { grass: false, headwindKt: 12, longEnough: false }),
				pick('15', { grass: true, headwindKt: 3, longEnough: true }),
			]),
		).toBe('15');
	});

	it('ranks a long-enough grass runway above a too-short paved one', () => {
		expect(
			choose([
				pick('08', { grass: false, headwindKt: 10, longEnough: false }),
				pick('15', { grass: true, headwindKt: 1, longEnough: true }),
			]),
		).toBe('15');
	});

	describe('no usable wind (every headwind 0)', () => {
		it('prefers a paved runway even when a grass one is listed first', () => {
			expect(
				choose([
					pick('08', { grass: true, longEnough: true }),
					pick('30', { grass: false, longEnough: true }),
				]),
			).toBe('30');
		});

		it('falls back to the main runway as listed when surface and length tie', () => {
			expect(choose([pick('08'), pick('12')])).toBe('08');
		});
	});

	it('keeps the earliest end on a full tie (tier and headwind equal)', () => {
		expect(
			choose([pick('A', { headwindKt: 5 }), pick('B', { headwindKt: 5 })]),
		).toBe('A');
	});

	it('falls back to the least-bad runway when nothing is long enough', () => {
		// Both too short: prefer paved over grass...
		expect(
			choose([
				pick('08', { grass: false, headwindKt: 3, longEnough: false }),
				pick('15', { grass: true, headwindKt: 12, longEnough: false }),
			]),
		).toBe('08');
		// ...then the most into wind among the same (too-short, paved) tier.
		expect(
			choose([
				pick('08', { grass: false, headwindKt: 3, longEnough: false }),
				pick('21', { grass: false, headwindKt: 8, longEnough: false }),
			]),
		).toBe('21');
	});

	describe('the take-off procedure an end calls for', () => {
		it('prefers an end where the normal take-off fits, grass included, to a paved one needing the short-field procedure', () => {
			expect(
				choose([pick('08', { grass: false, headwindKt: 10, rank: 1 }), pick('15', { grass: true, headwindKt: 0, rank: 0 })]),
			).toBe('15');
		});
		it('keeps paved before grass among ends needing the short-field procedure', () => {
			expect(
				choose([pick('15', { grass: true, headwindKt: 10, rank: 1 }), pick('08', { grass: false, headwindKt: 0, rank: 1 })]),
			).toBe('08');
		});
		it('takes a short-field-only end over one where nothing fits', () => {
			expect(
				choose([pick('08', { grass: false, headwindKt: 12, rank: 2 }), pick('15', { grass: true, headwindKt: 0, rank: 1 })]),
			).toBe('15');
		});
		it('lets the wind decide within a rank and surface', () => {
			expect(choose([pick('08', { rank: 1, headwindKt: 2 }), pick('26', { rank: 1, headwindKt: 6 })])).toBe('26');
		});
	});

	it('returns null for an empty list', () => {
		expect(bestRunwayEnd<End>([])).toBeNull();
	});
});
