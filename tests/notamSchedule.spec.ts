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
		const c = d!.clauses[0];
		expect(d!.clauses.length).toBe(1);
		expect(c.windows).toBeNull();
		expect(c.days!.has(18)).toBe(true);
		expect(c.days!.has(14)).toBe(true);
		// The staffed days: the sector is OPEN on these.
		for (const open of [8, 13, 15, 27]) {
			expect(c.days!.has(open)).toBe(false);
		}
		expect(c.days!.size).toBe(27);
	});

	it('parses the real A1576/26 daily window', () => {
		expect(parseItemD('0600-1800')).toEqual({
			clauses: [
				{
					days: null, weekdays: null, dates: null, range: null, exc: [],
					windows: [{ from: { kind: 'clock', min: 360 }, to: { kind: 'clock', min: 1080 } }],
				},
			],
		});
	});

	it('parses a bare H24 and a lone day', () => {
		expect(parseItemD('H24')!.clauses[0]).toEqual({
			days: null, weekdays: null, dates: null, range: null, windows: null, exc: [],
		});
		expect(parseItemD('22')!.clauses[0].days).toEqual(new Set([22]));
	});

	it('keeps a window crossing midnight as one window', () => {
		// The split is done per DAY at evaluation, not at parse: a sun anchor
		// only resolves against a date.
		expect(parseItemD('2200-0400')!.clauses[0].windows).toEqual([
			{ from: { kind: 'clock', min: 1320 }, to: { kind: 'clock', min: 240 } },
		]);
	});

	it('keeps each comma-separated clause to its own days', () => {
		// F1934/26 and R2685/26: merging the tokens would claim the 19th is
		// in force during the 25th's morning window.
		const d = parseItemD('19 1530-1830, 25 0800-1830');
		expect(d!.clauses.length).toBe(2);
		expect(d!.clauses[0].days).toEqual(new Set([19]));
		expect(d!.clauses[1].days).toEqual(new Set([25]));
	});

	it('reads weekday selectors, in ranges and in lists', () => {
		// M3207/26, W1775/26, P3405/26, W1812/26.
		expect(parseItemD('MON-FRI 0000-0559 1801-2359, SAT-SUN H24')!.clauses.map((c) => [...(c.weekdays ?? [])])).toEqual([
			[1, 2, 3, 4, 5],
			[6, 0],
		]);
		expect(parseItemD('SAT SUN 0700-1800')!.clauses[0].weekdays).toEqual(new Set([6, 0]));
		// A range that wraps the week end.
		expect(parseItemD('FRI-SUN 1400-1830')!.clauses[0].weekdays).toEqual(new Set([5, 6, 0]));
	});

	it('reads calendar dates and a range across months', () => {
		// W2035/26 and P2787/26.
		expect(parseItemD('SEP 21 28 0630-1000')!.clauses[0].dates).toEqual([
			{ month: 9, day: 21 },
			{ month: 9, day: 28 },
		]);
		expect(parseItemD('AUG 03-OCT 24 0500-1600')!.clauses[0].range).toEqual({
			from: { month: 8, day: 3 },
			to: { month: 10, day: 24 },
		});
	});

	it('reads the sun anchors', () => {
		// W1451/26 and C3257/26.
		expect(parseItemD('SR-SS')!.clauses[0].windows).toEqual([
			{ from: { kind: 'sr', offsetMin: 0 }, to: { kind: 'ss', offsetMin: 0 } },
		]);
		expect(parseItemD('SR MINUS30-SS PLUS30')!.clauses[0].windows).toEqual([
			{ from: { kind: 'sr', offsetMin: -30 }, to: { kind: 'ss', offsetMin: 30 } },
		]);
	});

	it('reads an exclusion onto its own clause', () => {
		// R1555/26: the exclusion belongs to the TUE-THU clause, not to MON.
		const d = parseItemD('MON 1100-1600, TUE-THU 0530-1000 EXC JUL 14, FRI 0530-1000');
		expect(d!.clauses.length).toBe(3);
		expect(d!.clauses[0].exc).toEqual([]);
		expect(d!.clauses[1].exc[0].dates).toEqual([{ month: 7, day: 14 }]);
	});

	it('reads the no-op qualifiers its neighbours write', () => {
		// Belgium and Germany write DAILY and EVERY on three D) items in
		// four; France writes neither, which is why the French corpus never
		// showed it. The word says "every day", which is the default.
		expect(parseItemD('DAILY 0700-1800')!.clauses[0].windows).toEqual([
			{ from: { kind: 'clock', min: 420 }, to: { kind: 'clock', min: 1080 } },
		]);
		expect(parseItemD('DAILY SR-SS')!.clauses[0].windows).toEqual([
			{ from: { kind: 'sr', offsetMin: 0 }, to: { kind: 'ss', offsetMin: 0 } },
		]);
		expect(parseItemD('EVERY MON-FRI H24')!.clauses[0].weekdays).toEqual(new Set([1, 2, 3, 4, 5]));
		expect(parseItemD('TOUS LES JOURS 0600-1800')!.clauses[0].days).toBeNull();
	});

	it('answers unknown for everything outside the subset', () => {
		// Impossible values, a descending day pair and H24 contradicting a
		// window: the whole schedule reads unknown, never a half-parse that
		// silently drops the tokens it did not understand.
		for (const text of ['32', '07-05', '0600-2500', 'H24 0600-1800', 'DAILY EXC PUB HOL', '', '  ']) {
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

	it('walks a day-and-weekday clause however wide the range', () => {
		// Three months hold every day of the month and every weekday, not
		// every Friday the 13th: 1 January to 1 May 2027 holds none, and the
		// wide shortcut once answered true for it.
		const d = parseItemD('13 FRI 0800-1200');
		const span = { start: Date.UTC(2026, 0, 1), end: Infinity };
		expect(scheduleActiveIn(span, d, { fromMs: Date.UTC(2027, 0, 1), toMs: Date.UTC(2027, 4, 1) })).toBe(false);
		// August 2027 has one.
		expect(scheduleActiveIn(span, d, { fromMs: Date.UTC(2027, 0, 1), toMs: Date.UTC(2027, 8, 1) })).toBe(true);
		// Either selector alone still takes the shortcut's answer.
		expect(scheduleActiveIn(span, parseItemD('FRI 0800-1200'), { fromMs: Date.UTC(2027, 0, 1), toMs: Date.UTC(2027, 4, 1) })).toBe(true);
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

describe('the clause-aware evaluation', () => {
	const at = (ms: number) => ({ fromMs: ms, toMs: ms });
	const SEP = (day: number, h = 0, m = 0): number => Date.UTC(2026, 8, day, h, m);
	const SPAN_SEP = { start: SEP(1), end: SEP(30, 23, 59) };

	it('holds each clause to its own window', () => {
		// 19 Sep is Saturday; the NOTAM gives it an afternoon window only.
		const d = parseItemD('19 1530-1830, 25 0800-1830');
		expect(scheduleActiveIn(SPAN_SEP, d, at(SEP(19, 16)))).toBe(true);
		expect(scheduleActiveIn(SPAN_SEP, d, at(SEP(19, 9)))).toBe(false);
		expect(scheduleActiveIn(SPAN_SEP, d, at(SEP(25, 9)))).toBe(true);
	});

	it('judges weekdays in UTC', () => {
		// 2026-09-21 is a Monday, 2026-09-19 a Saturday.
		const d = parseItemD('MON-FRI 0000-0559 1801-2359, SAT-SUN H24');
		expect(scheduleActiveIn(SPAN_SEP, d, at(SEP(21, 3)))).toBe(true);
		expect(scheduleActiveIn(SPAN_SEP, d, at(SEP(21, 12)))).toBe(false);
		expect(scheduleActiveIn(SPAN_SEP, d, at(SEP(19, 12)))).toBe(true);
	});

	it('takes an excluded date back out', () => {
		const d = parseItemD('MON-FRI 0700-1700 EXC SEP 21');
		expect(scheduleActiveIn(SPAN_SEP, d, at(SEP(21, 12)))).toBe(false);
		expect(scheduleActiveIn(SPAN_SEP, d, at(SEP(22, 12)))).toBe(true);
	});

	it('excludes by weekday and by bare day number too', () => {
		// P2989/26 writes "EXC SAT SUN", P2178/26 "EXC 10", B3900/26
		// "EXC 14-18": the exclusion is a selector, not only a date list.
		const weekend = parseItemD('0500-1500 EXC SAT SUN');
		expect(scheduleActiveIn(SPAN_SEP, weekend, at(SEP(19, 12)))).toBe(false);
		expect(scheduleActiveIn(SPAN_SEP, weekend, at(SEP(21, 12)))).toBe(true);
		// The day the first clause excludes gets its own window in the second.
		const tenth = parseItemD('0600-1500 EXC 10, 10 0703-1500');
		expect(scheduleActiveIn(SPAN_SEP, tenth, at(SEP(10, 6, 30)))).toBe(false);
		expect(scheduleActiveIn(SPAN_SEP, tenth, at(SEP(10, 8)))).toBe(true);
		expect(scheduleActiveIn(SPAN_SEP, tenth, at(SEP(11, 6, 30)))).toBe(true);
	});

	it('resolves a sun window through the caller lookup, and is unknown without it', () => {
		const d = parseItemD('SR-SS');
		// Without a position the day's sun is unknown, so the schedule is.
		expect(scheduleActiveIn(SPAN_SEP, d, at(SEP(19, 12)))).toBeNull();
		const sun = () => ({ sunriseMin: 5 * 60 + 30, sunsetMin: 18 * 60 + 15 });
		expect(scheduleActiveIn(SPAN_SEP, d, at(SEP(19, 12)), sun)).toBe(true);
		expect(scheduleActiveIn(SPAN_SEP, d, at(SEP(19, 4)), sun)).toBe(false);
		expect(scheduleActiveIn(SPAN_SEP, d, at(SEP(19, 19)), sun)).toBe(false);
	});

	it('carries the sun offsets', () => {
		const d = parseItemD('SR MINUS30-SS PLUS30');
		const sun = () => ({ sunriseMin: 5 * 60 + 30, sunsetMin: 18 * 60 + 15 });
		expect(scheduleActiveIn(SPAN_SEP, d, at(SEP(19, 5, 15)), sun)).toBe(true);
		expect(scheduleActiveIn(SPAN_SEP, d, at(SEP(19, 18, 40)), sun)).toBe(true);
		expect(scheduleActiveIn(SPAN_SEP, d, at(SEP(19, 19)), sun)).toBe(false);
	});

	it('keeps a calendar range inside its own dates', () => {
		const d = parseItemD('AUG 03-OCT 24 0500-1600');
		expect(scheduleActiveIn({ start: Date.UTC(2026, 6, 1), end: Date.UTC(2026, 11, 1) }, d, at(SEP(19, 12)))).toBe(true);
		expect(scheduleActiveIn({ start: Date.UTC(2026, 6, 1), end: Date.UTC(2026, 11, 1) }, d, at(Date.UTC(2026, 10, 5, 12)))).toBe(false);
	});

	it('answers unknown only when no clause answers yes', () => {
		// One clause resolvable, one needing the sun: a yes from the first
		// settles it, and without one the answer is unknown, never false.
		const d = parseItemD('MON-FRI 0700-1700, SAT-SUN SR-SS');
		expect(scheduleActiveIn(SPAN_SEP, d, at(SEP(21, 12)))).toBe(true);
		expect(scheduleActiveIn(SPAN_SEP, d, at(SEP(19, 12)))).toBeNull();
	});
});

// -------------------------------------------------------------------- //
// A WINDOW IS NAMED BY THE DAY IT OPENS (ICAO Doc 8126 5.3.4). The one   //
// place the rewrite of this module had it wrong, and the only one that   //
// reached a safety surface: a cross-midnight period was tested against   //
// the day it opened on TWICE, once for each half, which shifted every    //
// night one day early. With no day selector every day is selected and    //
// the error cancels, which is why the bare "2000-0400" case looked       //
// right; with MON-FRI it does not.                                       //
// -------------------------------------------------------------------- //
describe('a cross-midnight window belongs to the day it opens on', () => {
	// 2026-09-11 is a Friday, 09-12 a Saturday, 09-14 a Monday.
	const SEP = (day: number, h = 0, m = 0): number => Date.UTC(2026, 8, day, h, m);
	const SPAN = { start: SEP(1), end: SEP(30, 23, 59) };
	const at = (t: number) => ({ fromMs: t, toMs: t });

	it('A5855/26 LFSB: MON-FRI 2230-0300 closes the runway into Saturday morning', () => {
		const d = parseItemD('MON-FRI 2230-0300');
		expect(d).not.toBeNull();
		// Friday's period, and the Saturday morning it runs into.
		expect(scheduleActiveIn(SPAN, d, at(SEP(11, 22, 30)))).toBe(true);
		expect(scheduleActiveIn(SPAN, d, at(SEP(12, 1, 30)))).toBe(true);
		expect(scheduleActiveIn(SPAN, d, at(SEP(12, 3, 0)))).toBe(true);
		expect(scheduleActiveIn(SPAN, d, at(SEP(12, 3, 1)))).toBe(false);
		// Saturday opens no period of its own, and Sunday night is nobody's,
		// so Monday's small hours are NOT covered: the period that would
		// reach them would have had to open on Sunday.
		expect(scheduleActiveIn(SPAN, d, at(SEP(12, 22, 30)))).toBe(false);
		expect(scheduleActiveIn(SPAN, d, at(SEP(13, 1, 30)))).toBe(false);
		expect(scheduleActiveIn(SPAN, d, at(SEP(14, 1, 30)))).toBe(false);
		// Monday opens its own, which reaches Tuesday.
		expect(scheduleActiveIn(SPAN, d, at(SEP(14, 22, 30)))).toBe(true);
		expect(scheduleActiveIn(SPAN, d, at(SEP(15, 1, 30)))).toBe(true);
	});

	it('B4221/26 LFMK: MON-FRI 1900-0600 closes the aerodrome into Saturday', () => {
		const d = parseItemD('MON-FRI 1900-0600');
		expect(scheduleActiveIn(SPAN, d, at(SEP(11, 20)))).toBe(true);
		expect(scheduleActiveIn(SPAN, d, at(SEP(12, 3)))).toBe(true);
		expect(scheduleActiveIn(SPAN, d, at(SEP(12, 7)))).toBe(false);
		expect(scheduleActiveIn(SPAN, d, at(SEP(12, 20)))).toBe(false);
		expect(scheduleActiveIn(SPAN, d, at(SEP(14, 3)))).toBe(false);
	});

	it('A5909/26 LFST: a day-of-month selector carries its night too', () => {
		const d = parseItemD('21-25 2245-0400');
		expect(scheduleActiveIn(SPAN, d, at(SEP(21, 23)))).toBe(true);
		expect(scheduleActiveIn(SPAN, d, at(SEP(22, 2)))).toBe(true);
		expect(scheduleActiveIn(SPAN, d, at(SEP(26, 2)))).toBe(true); // the 25th's night
		expect(scheduleActiveIn(SPAN, d, at(SEP(26, 23)))).toBe(false);
		expect(scheduleActiveIn(SPAN, d, at(SEP(21, 2)))).toBe(false); // the 20th opened none
	});

	it('without a selector every day opens one, so the bare case is unchanged', () => {
		const d = parseItemD('2000-0400');
		expect(scheduleActiveIn(SPAN, d, at(SEP(14, 19)))).toBe(false);
		expect(scheduleActiveIn(SPAN, d, at(SEP(14, 21)))).toBe(true);
		expect(scheduleActiveIn(SPAN, d, at(SEP(15, 2)))).toBe(true);
		expect(scheduleActiveIn(SPAN, d, at(SEP(15, 5)))).toBe(false);
	});

	it('a period reaching into the asked range from before it still counts', () => {
		// The range opens at 01:00 on the Saturday; the period covering it
		// opened at 22:30 the previous day, outside the range entirely.
		const d = parseItemD('MON-FRI 2230-0300');
		expect(scheduleActiveIn(SPAN, d, { fromMs: SEP(12, 1), toMs: SEP(12, 2) })).toBe(true);
	});

	it('the stated end minute is still in force', () => {
		// A closure "0600-1500" is closed AT 1500: the printed interval is
		// closed at both ends, and for a closure or an activation that is the
		// conservative reading.
		const d = parseItemD('0600-1500');
		expect(scheduleActiveIn(SPAN, d, at(SEP(14, 5, 59)))).toBe(false);
		expect(scheduleActiveIn(SPAN, d, at(SEP(14, 6, 0)))).toBe(true);
		expect(scheduleActiveIn(SPAN, d, at(SEP(14, 15, 0)))).toBe(true);
		expect(scheduleActiveIn(SPAN, d, at(SEP(14, 15, 1)))).toBe(false);
	});

	it('a schedule never reaches outside its own B)/C) validity', () => {
		// The day loop now starts a day EARLY to catch a period opening before
		// the range; the span clamp is what keeps that from leaking.
		const narrow = { start: SEP(14, 0), end: SEP(14, 23, 59) };
		const d = parseItemD('MON-FRI 2230-0300');
		expect(scheduleActiveIn(narrow, d, at(SEP(13, 23)))).toBe(false);
		expect(scheduleActiveIn(narrow, d, at(SEP(15, 1)))).toBe(false);
	});
});

describe('the day walk is bounded', () => {
	// The viewing period's look-ahead is unbounded by default and so is a
	// NOTAM with no C): both ends at Infinity handed the walk a range it never
	// finished, and the app froze inside a derived. A regression here HANGS
	// this file rather than failing it, which is loud enough.
	const OPEN = { start: Date.UTC(2026, 0, 1), end: Infinity };
	const FROM = Date.UTC(2026, 8, 22, 12, 0);
	const UNBOUNDED = { fromMs: FROM, toMs: Infinity };

	it('an SR/SS window with no position to read the sun at is unknown', () => {
		expect(scheduleActiveIn(OPEN, parseItemD('SR-SS'), UNBOUNDED)).toBe(null);
	});

	it('a clause that can never match is unknown past the horizon, not never', () => {
		expect(scheduleActiveIn(OPEN, parseItemD('APR 31 0600-1800'), UNBOUNDED)).toBe(null);
	});

	it('a clause that does match is still found, however far the range runs', () => {
		expect(scheduleActiveIn(OPEN, parseItemD('JUL 14 H24'), UNBOUNDED)).toBe(true);
		expect(scheduleActiveIn(OPEN, parseItemD('MON-FRI 0800-1600'), UNBOUNDED)).toBe(true);
	});

	it('inside the horizon a range nothing matches is still false', () => {
		const sep = { fromMs: FROM, toMs: Date.UTC(2026, 9, 1) };
		expect(scheduleActiveIn(OPEN, parseItemD('JUL 14 H24'), sep)).toBe(false);
		expect(scheduleActiveIn(OPEN, parseItemD('APR 31 0600-1800'), sep)).toBe(false);
	});
});
