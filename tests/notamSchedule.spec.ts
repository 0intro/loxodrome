/* The D) item interpreter behind the service-closure feature: the parsed
 * subset, and the asymmetric unknown (an unparseable D) must never close a
 * frequency, so it answers null, not a guess). docs/notam-relationships.md. */

import { describe, it, expect } from 'vitest';
import { parseItemD, scheduleActiveIn } from '$lib/notam/schedule';

const AUG = (day: number, h = 0, m = 0): number => Date.UTC(2026, 7, day, h, m);
const SPAN_AUG = { start: AUG(1), end: AUG(31, 23, 59) };

describe('parseItemD', () => {
	it('parses the real A4694/26 day list with H24', () => {
		const d = parseItemD('01-07 09-12 14 16-26 28-31  H24');
		expect(d).not.toBeNull();
		expect(d!.daily).toBeNull();
		expect(d!.days!.has(18)).toBe(true);
		expect(d!.days!.has(14)).toBe(true);
		// The staffed days: the sector is OPEN on these.
		for (const open of [8, 13, 15, 27]) {
			expect(d!.days!.has(open)).toBe(false);
		}
		expect(d!.days!.size).toBe(27);
	});

	it('parses the real A1576/26 daily window', () => {
		const d = parseItemD('0600-1800');
		expect(d).toEqual({ days: null, daily: [{ fromMin: 360, toMin: 1080 }] });
	});

	it('parses a bare H24 and a lone day', () => {
		expect(parseItemD('H24')).toEqual({ days: null, daily: null });
		expect(parseItemD('22')).toEqual({ days: new Set([22]), daily: null });
	});

	it('splits a window crossing midnight', () => {
		expect(parseItemD('2200-0400')).toEqual({
			days: null,
			daily: [
				{ fromMin: 1320, toMin: 1440 },
				{ fromMin: 0, toMin: 240 },
			],
		});
	});

	it('answers unknown for everything outside the subset', () => {
		// Weekday names, sunrise/sunset, month-day dates, impossible values,
		// a descending day pair, H24 contradicting a daily window: the whole
		// schedule reads unknown, never a half-parse that silently drops the
		// tokens it did not understand.
		for (const text of [
			'MON-FRI 0800-1600',
			'SR-SS',
			'AUG 01-07',
			'32',
			'07-05',
			'0600-2500',
			'H24 0600-1800',
			'',
			'  ',
		]) {
			expect(parseItemD(text)).toBeNull();
		}
	});
});

describe('scheduleActiveIn', () => {
	const D_AUG = parseItemD('01-07 09-12 14 16-26 28-31 H24');

	it('closes on a listed day and stays open on a staffed one', () => {
		// Aug 18 (the user's real flight day) is listed; Aug 15 is staffed.
		expect(scheduleActiveIn(SPAN_AUG, D_AUG, { fromMs: AUG(18, 9), toMs: AUG(18, 9) })).toBe(
			true,
		);
		expect(scheduleActiveIn(SPAN_AUG, D_AUG, { fromMs: AUG(15, 9), toMs: AUG(15, 9) })).toBe(
			false,
		);
	});

	it('a window spanning staffed and closed days reads closed', () => {
		expect(scheduleActiveIn(SPAN_AUG, D_AUG, { fromMs: AUG(15, 12), toMs: AUG(16, 12) })).toBe(
			true,
		);
	});

	it('the validity alone decides when there is no D) item', () => {
		expect(scheduleActiveIn(SPAN_AUG, undefined, { fromMs: AUG(15), toMs: AUG(15) })).toBe(true);
		expect(scheduleActiveIn(SPAN_AUG, undefined, { fromMs: AUG(31, 23, 59) + 60_000, toMs: Infinity })).toBe(
			false,
		);
	});

	it('an unparseable D) answers unknown inside the validity, false outside', () => {
		expect(scheduleActiveIn(SPAN_AUG, null, { fromMs: AUG(18), toMs: AUG(18) })).toBeNull();
		expect(scheduleActiveIn(SPAN_AUG, null, { fromMs: Date.UTC(2026, 8, 5), toMs: Infinity })).toBe(
			false,
		);
	});

	it('judges a daily window at the instant, UTC', () => {
		const d = parseItemD('0600-1800');
		expect(scheduleActiveIn(SPAN_AUG, d, { fromMs: AUG(10, 12), toMs: AUG(10, 12) })).toBe(true);
		expect(scheduleActiveIn(SPAN_AUG, d, { fromMs: AUG(10, 5, 59), toMs: AUG(10, 5, 59) })).toBe(
			false,
		);
		expect(scheduleActiveIn(SPAN_AUG, d, { fromMs: AUG(10, 19), toMs: AUG(10, 22) })).toBe(false);
		// A window reaching into the next morning crosses 0600.
		expect(scheduleActiveIn(SPAN_AUG, d, { fromMs: AUG(10, 19), toMs: AUG(11, 7) })).toBe(true);
	});

	it('an unbounded planning window resolves without walking it', () => {
		// activeEvalWindow's unbounded horizon: any listed day occurs within
		// three months, so the fast path answers true.
		expect(scheduleActiveIn(SPAN_AUG, D_AUG, { fromMs: AUG(2), toMs: Infinity })).toBe(true);
	});

	it('clamps to the validity before judging', () => {
		// The window starts before B): only the in-validity part counts.
		expect(
			scheduleActiveIn(SPAN_AUG, D_AUG, { fromMs: Date.UTC(2026, 6, 20), toMs: AUG(1, 6) }),
		).toBe(true);
		expect(
			scheduleActiveIn(SPAN_AUG, D_AUG, { fromMs: Date.UTC(2026, 6, 20), toMs: Date.UTC(2026, 6, 25) }),
		).toBe(false);
	});
});
