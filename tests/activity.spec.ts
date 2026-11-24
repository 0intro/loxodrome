/* A zone's activity: the rules' periods and the one reading of them
 * (data/activity.ts). The ladder is one table, each rung's case beside the
 * rungs above it that must not catch it; the periods are pinned on both
 * paths, a dated rule read whole and a dateless one walked over the days of
 * the question; and over the shipped supplements the reading answers as the
 * eager windows it replaces did, period for period. */

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
	nextChange,
	resolveActivity,
	rulePeriods,
	type ActivePeriod,
	type ActivityInput,
	type ActivityMode,
	type ActivityRule,
	type ConfirmedPeriod,
	type NotedState,
} from '$lib/data/activity';
import {
	activationHolds,
	hasDayRule,
	hasSunEnd,
	loadSupAip,
	supZoneSun,
	sunWindow,
	validityEmpty,
	zoneSchedule,
	SUPAIP_URL,
	type SupAip,
	type SupAipActivation,
	type SupAipStanding,
} from '$lib/data/supaip';
import { supaipVolumes } from '$lib/nav/alertVolumes';
import { parseItemD, type SunLookup } from '$lib/notam/schedule';
import { fromNotamLimit } from '$lib/vertical/limits';

const H = 3_600_000;
const DAY = 24 * H;
const T = Date.UTC(2026, 10, 23, 10, 0); // Monday 23 November 2026, 10:00Z

function input(over: Partial<ActivityInput>): ActivityInput {
	return { rules: [], briefed: false, ...over };
}

describe('resolveActivity: the ladder', () => {
	const at = (startH: number, endH: number): ConfirmedPeriod => ({
		startMs: T + startH * H,
		endMs: T + endH * H,
		by: 'notam',
	});
	const today = '2026-11-23';
	const noted = (state: NotedState['state'], fromH: number, toH: number): NotedState => ({
		state,
		notedAtMs: T + fromH * H,
		untilMs: T + toH * H,
	});
	const cases: [string, Partial<ActivityInput>, string, string][] = [
		['a firm rule holding at all times', { rules: [{ mode: 'firm' }] }, 'active', 'permanent'],
		// The permanent rung answers before a NOTAM: the zone holds anyway.
		['a permanent zone a NOTAM activates', { rules: [{ mode: 'firm' }], confirmed: [at(-1, 1)] }, 'active', 'permanent'],
		['an activation NOTAM over the range', { rules: [{ mode: 'notam' }], confirmed: [at(-1, 1)] }, 'active', 'notam'],
		// A NOTAM's D) item: in force in its windows alone, whole where unread.
		[
			'an activation NOTAM in a window of its D)',
			{ rules: [{ mode: 'notam' }], confirmed: [{ ...at(-48, 48), schedule: parseItemD('MON 0900-1100') }] },
			'active',
			'notam',
		],
		[
			'an activation NOTAM between the windows of its D)',
			{ rules: [{ mode: 'notam' }], confirmed: [{ ...at(-48, 48), schedule: parseItemD('TUE-FRI H24') }], briefed: true },
			'inactive',
			'notam-none',
		],
		[
			'an activation NOTAM whose D) is unread',
			{ rules: [{ mode: 'notam' }], confirmed: [{ ...at(-48, 48), schedule: null }], briefed: true },
			'active',
			'notam-unread',
		],
		[
			'an activation NOTAM whose D) needs a sun it lacks',
			{ rules: [{ mode: 'notam' }], confirmed: [{ ...at(-48, 48), schedule: parseItemD('SR-SS') }], briefed: true },
			'active',
			'notam-unread',
		],
		[
			'the RTBA programme over the range',
			{ rules: [{ mode: 'notam' }], rtba: true, confirmed: [{ ...at(-1, 1), by: 'rtba' }] },
			'active',
			'rtba',
		],
		['a firm period', { rules: [{ mode: 'firm', date: today, from: '09:00', to: '11:00' }] }, 'active', 'published'],
		// A firm period beats an activable one beside it.
		[
			'a firm period beside an activable one',
			{
				rules: [
					{ mode: 'activable', date: today },
					{ mode: 'firm', date: today, from: '09:00', to: '11:00' },
				],
			},
			'active',
			'published',
		],
		['an activable period', { rules: [{ mode: 'activable', date: today }] }, 'activable', 'activable'],
		['an unread period', { rules: [{ mode: 'unread' }] }, 'activable', 'unread'],
		['activation by NOTAM, the briefing silent', { rules: [{ mode: 'notam' }] }, 'activable', 'notam-unbriefed'],
		['activation by NOTAM, briefed', { rules: [{ mode: 'notam' }], briefed: true }, 'inactive', 'notam-none'],
		['the RTBA before its release', { rules: [{ mode: 'notam' }], rtba: true }, 'activable', 'rtba-unbriefed'],
		['the RTBA briefed', { rules: [{ mode: 'notam' }], rtba: true, briefed: true }, 'inactive', 'rtba-none'],
		// A notice bounds the silence: an activation published since the
		// briefing holds no earlier than its time plus the notice.
		[
			'activation by NOTAM at 30 minutes\' notice, briefed an hour ago',
			{ rules: [{ mode: 'notam', noticeMin: 30 }], briefed: true, briefedAtMs: T - H },
			'activable',
			'notam-notice',
		],
		[
			'the same, briefed ten minutes ago',
			{ rules: [{ mode: 'notam', noticeMin: 30 }], briefed: true, briefedAtMs: T - 10 * 60_000 },
			'inactive',
			'notam-none',
		],
		[
			'the notice running out inside the range',
			{ rules: [{ mode: 'notam', noticeMin: 30 }], briefed: true, briefedAtMs: T - 27 * 60_000 },
			'activable',
			'notam-notice',
		],
		[
			'activation by NOTAM at 48 hours\' notice, briefed a day ago',
			{ rules: [{ mode: 'notam', noticeMin: 2880 }], briefed: true, briefedAtMs: T - DAY },
			'inactive',
			'notam-none',
		],
		[
			'activation by NOTAM stating no notice, briefed a day ago',
			{ rules: [{ mode: 'notam' }], briefed: true, briefedAtMs: T - DAY },
			'inactive',
			'notam-none',
		],
		[
			'a notice the briefing\'s silence never reached',
			{ rules: [{ mode: 'notam', noticeMin: 30 }], briefedAtMs: T - H },
			'activable',
			'notam-unbriefed',
		],
		// A NOTAM over another range confirms nothing over this one.
		['a NOTAM over another range', { rules: [{ mode: 'notam' }], confirmed: [at(2, 3)], briefed: true }, 'inactive', 'notam-none'],
		['a firm period over another day', { rules: [{ mode: 'firm', date: '2026-11-24' }] }, 'inactive', 'outside'],
		['no rule at all', { rules: [] }, 'inactive', 'outside'],
		// A NOTAM changing the zone lifts an inactive answer, never an active one.
		['a briefed by-NOTAM zone a NOTAM changes', { rules: [{ mode: 'notam' }], briefed: true, amended: true }, 'activable', 'amended'],
		['outside its periods, a NOTAM changing it', { rules: [{ mode: 'firm', date: '2026-11-24' }], amended: true }, 'activable', 'amended'],
		['a firm period a NOTAM changes', { rules: [{ mode: 'firm', date: today, from: '09:00', to: '11:00' }], amended: true }, 'active', 'published'],
		// The pilot's note settles a zone that may be active over a range it
		// covers whole, and nothing firm.
		['a zone the unit says is inactive', { rules: [{ mode: 'activable' }], note: noted('inactive', -1, 1) }, 'inactive', 'noted'],
		['a zone the unit says is active', { rules: [{ mode: 'activable' }], note: noted('active', -1, 1) }, 'active', 'noted'],
		['a zone the briefing leaves open, noted', { rules: [{ mode: 'notam' }], note: noted('inactive', -1, 1) }, 'inactive', 'noted'],
		['a zone a NOTAM changes, noted', { rules: [{ mode: 'notam' }], briefed: true, amended: true, note: noted('inactive', -1, 1) }, 'inactive', 'noted'],
		['a note taken after the range begins', { rules: [{ mode: 'activable' }], note: noted('inactive', 0.5, 2) }, 'activable', 'activable'],
		['a note ending inside the range', { rules: [{ mode: 'activable' }], note: { state: 'inactive', notedAtMs: T - H, untilMs: T + 60_000 } }, 'activable', 'activable'],
		['a firm period noted inactive', { rules: [{ mode: 'firm', date: today, from: '09:00', to: '11:00' }], note: noted('inactive', -1, 1) }, 'active', 'published'],
		['outside its periods, noted active', { rules: [{ mode: 'firm', date: '2026-11-24' }], note: noted('active', -1, 1) }, 'inactive', 'outside'],
	];
	it.each(cases)('%s', (_, over, state, reason) => {
		const a = resolveActivity(input(over), T, T + 5 * 60_000);
		expect([a.state, a.reason]).toEqual([state, reason]);
	});

	it('names the period behind the answer', () => {
		const a = resolveActivity(input({ rules: [{ mode: 'activable', date: '2026-11-23', from: '09:00', to: '11:00' }] }), T, T);
		expect(a.period).toEqual({ startMs: T - H, endMs: T + H });
		expect(resolveActivity(input({ rules: [{ mode: 'firm' }] }), T, T).period).toBeNull();
		// A note's period is its own, from its time to its end.
		const n = resolveActivity(input({ rules: [{ mode: 'activable' }], note: noted('inactive', -1, 2) }), T, T);
		expect(n.period).toEqual({ startMs: T - H, endMs: T + 2 * H });
	});

	it('names a NOTAM\'s window of its D) as its period, and its validity where the D) is unread', () => {
		const confirmed = (schedule: ConfirmedPeriod['schedule']) =>
			input({ confirmed: [{ ...at(-48, 48), schedule }] });
		expect(resolveActivity(confirmed(parseItemD('MON 0900-1100')), T, T).period).toEqual({ startMs: T - H, endMs: T + H });
		expect(resolveActivity(confirmed(null), T, T).period).toEqual({ startMs: T - 48 * H, endMs: T + 48 * H });
		// The sun the period carries sets an SR/SS window.
		const sun: SunLookup = () => ({ sunriseMin: 7 * 60, sunsetMin: 16 * 60 });
		const a = resolveActivity(input({ confirmed: [{ ...at(-48, 48), schedule: parseItemD('SR-SS'), sun }] }), T, T);
		expect([a.reason, a.period]).toEqual(['notam', { startMs: T - 3 * H, endMs: T + 6 * H }]);
	});
});

describe('a window the sun and the clock bound, its hours printed in winter UTC', () => {
	// A summer Monday, the sun rising at 04:00Z and setting at 19:00Z.
	const D = Date.UTC(2026, 5, 15);
	const sun: SunLookup = () => ({ sunriseMin: 4 * 60, sunsetMin: 19 * 60 });
	const around = (r: ActivityRule, atMs: number) =>
		rulePeriods(r, atMs, atMs, sun).find((p) => p.startMs <= atMs && p.endMs >= atMs);

	it('moves its clock bounds an hour earlier in summer, the sun\'s staying', () => {
		// The RTBA's "SS+30 - 2400 ... SUM : -1HR": sunset plus 30 min to 23:00Z.
		expect(around({ mode: 'notam', sunFrom: 'SS+30', to: '24:00', summerEarlier: true }, D + 20 * H)).toEqual({
			startMs: D + 19.5 * H,
			endMs: D + 23 * H,
		});
		// Its morning half, "0000 - SR-30", opens at 23:00Z the day before, so
		// the night holds whole.
		expect(around({ mode: 'notam', from: '00:00', sunTo: 'SR-30', summerEarlier: true }, D)).toEqual({
			startMs: D - H,
			endMs: D + 3.5 * H,
		});
		// A clock opening before a sun close, "0800 - SS".
		expect(around({ mode: 'activable', from: '08:00', sunTo: 'SS', summerEarlier: true }, D + 12 * H)).toEqual({
			startMs: D + 7 * H,
			endMs: D + 19 * H,
		});
	});

	it('keeps them as printed in winter', () => {
		const W = Date.UTC(2026, 0, 12);
		expect(around({ mode: 'notam', sunFrom: 'SS+30', to: '24:00', summerEarlier: true }, W + 20 * H)).toEqual({
			startMs: W + 19.5 * H,
			endMs: W + 24 * H,
		});
	});
});

describe("an activation NOTAM's levels", () => {
	it('ride the answer it gives, and only that one', () => {
		const levels = { lower: fromNotamLimit('SFC'), upper: fromNotamLimit('FL235') };
		const notam: ConfirmedPeriod = { startMs: T - H, endMs: T + H, by: 'notam', levels };
		expect(resolveActivity(input({ rules: [{ mode: 'notam' }], confirmed: [notam] }), T, T)).toMatchObject({ reason: 'notam', levels });
		const bare: ConfirmedPeriod = { startMs: T - H, endMs: T + H, by: 'notam' };
		expect(resolveActivity(input({ rules: [{ mode: 'notam' }], confirmed: [bare] }), T, T)).not.toHaveProperty('levels');
		expect(resolveActivity(input({ rules: [{ mode: 'activable' }] }), T, T)).not.toHaveProperty('levels');
	});
});

describe('nextChange', () => {
	const today = '2026-11-23';
	const firm = input({ rules: [{ mode: 'firm', date: today, from: '11:00', to: '13:00' }] });

	it('gives the start of the next period, and the end of the one in force', () => {
		const n = nextChange(firm, T, T + DAY);
		expect([n?.atMs, n?.answer.state, n?.answer.reason]).toEqual([T + H, 'active', 'published']);
		// In the period, its end: the state changes the millisecond after.
		const m = nextChange(firm, T + 2 * H, T + DAY);
		expect([m?.atMs, m?.answer.state]).toEqual([T + 3 * H + 1, 'inactive']);
	});

	it('gives the end of a briefing\'s silence at its notice', () => {
		const z = input({ rules: [{ mode: 'notam', noticeMin: 30 }], briefed: true, briefedAtMs: T - 10 * 60_000 });
		const n = nextChange(z, T, T + DAY);
		expect([n?.atMs, n?.answer.reason]).toEqual([T + 20 * 60_000, 'notam-notice']);
	});

	it('gives the next window of a NOTAM\'s D) item', () => {
		const z = input({
			rules: [{ mode: 'notam' }],
			briefed: true,
			confirmed: [{ startMs: T - DAY, endMs: T + 2 * DAY, by: 'notam', schedule: parseItemD('1400-1600') }],
		});
		const n = nextChange(z, T, T + DAY);
		expect([n?.atMs, n?.answer.state, n?.answer.reason]).toEqual([T + 4 * H, 'active', 'notam']);
	});

	it('reads the days of a D) item meeting at midnight as one stretch', () => {
		// R3338/26, "22 1300-2359, 23-25 0000-2359, 26 0000-1300".
		const z = input({
			rules: [{ mode: 'notam' }],
			briefed: true,
			confirmed: [
				{
					startMs: T - DAY,
					endMs: T + 4 * DAY,
					by: 'notam',
					schedule: parseItemD('22 1300-2359, 23-25 0000-2359, 26 0000-1300'),
				},
			],
		});
		const n = nextChange(z, T, T + 7 * DAY);
		expect([n?.atMs, n?.answer.state]).toEqual([Date.UTC(2026, 10, 26, 13) + 1, 'inactive']);
		// The period it reports is the whole stretch.
		expect(resolveActivity(z, T, T).period).toEqual({
			startMs: Date.UTC(2026, 10, 22, 13),
			endMs: Date.UTC(2026, 10, 26, 13),
		});
	});

	it('gives the end of the pilot\'s note', () => {
		const z = input({ rules: [{ mode: 'activable' }], note: { state: 'inactive', notedAtMs: T - H, untilMs: T + H } });
		const n = nextChange(z, T, T + DAY);
		expect([n?.atMs, n?.answer.state, n?.answer.reason]).toEqual([T + H + 1, 'activable', 'activable']);
	});

	it('is null for a zone whose state holds through', () => {
		expect(nextChange(input({ rules: [{ mode: 'firm' }] }), T, T + DAY)).toBeNull();
		expect(nextChange(firm, T + 4 * H, T + 5 * H)).toBeNull();
	});
});

describe('rulePeriods', () => {
	it('holds a rule with a NOTAM\'s D) in its windows between its bounds, whole where unread', () => {
		const week = { startMs: T - DAY, endMs: T + 6 * DAY };
		const r: ActivityRule = { mode: 'firm', ...week, schedule: parseItemD('MON-FRI 0800-1700') };
		const days = rulePeriods(r, -Infinity, Infinity).map((p) => new Date(p.startMs).toISOString().slice(0, 16));
		expect(days).toEqual(['2026-11-23T08:00', '2026-11-24T08:00', '2026-11-25T08:00', '2026-11-26T08:00', '2026-11-27T08:00']);
		expect(rulePeriods({ ...r, schedule: null }, T, T)).toEqual([week]);
		// A D) without bounds holds in its windows, never at all times.
		const perm: ActivityRule = { mode: 'firm', schedule: parseItemD('SAT 0800-1700') };
		expect(resolveActivity(input({ rules: [perm] }), T, T)).toEqual({ state: 'inactive', reason: 'outside', period: null });
	});

	it('walks a dateless weekly rule over the days asked about', () => {
		// "MON-FRI 0830-1100": Monday 23 November to Saturday 28, then the
		// next Monday, three weeks on.
		const r: ActivityRule = { mode: 'notam', days: [1, 2, 3, 4, 5], from: '08:30', to: '11:00' };
		const p = rulePeriods(r, T, T + 5 * DAY);
		expect(p.map((x) => new Date(x.startMs).toISOString())).toEqual([
			'2026-11-23T08:30:00.000Z',
			'2026-11-24T08:30:00.000Z',
			'2026-11-25T08:30:00.000Z',
			'2026-11-26T08:30:00.000Z',
			'2026-11-27T08:30:00.000Z',
		]);
		expect(rulePeriods(r, Date.UTC(2026, 11, 12), Date.UTC(2026, 11, 15), undefined, 1)).toEqual([
			{ startMs: Date.UTC(2026, 11, 14, 8, 30), endMs: Date.UTC(2026, 11, 14, 11, 0) },
		]);
	});

	it('finds a run of held days from its first day to its last', () => {
		// Weekdays H24, asked about on a Wednesday: the run is Monday to
		// Friday whole.
		const r: ActivityRule = { mode: 'firm', days: [1, 2, 3, 4, 5] };
		expect(rulePeriods(r, T + 2 * DAY, T + 2 * DAY)).toEqual([
			{ startMs: Date.UTC(2026, 10, 23), endMs: Date.UTC(2026, 10, 28) },
		]);
		expect(rulePeriods(r, Date.UTC(2026, 10, 28, 12), Date.UTC(2026, 10, 29, 12))).toEqual([]);
	});

	it('cuts its periods at its own bounds, never at the range asked about', () => {
		// The night from 22:00 to 06:00, its source holding from 23:00 to 04:00.
		const r: ActivityRule = { mode: 'firm', from: '22:00', to: '06:00', startMs: T + 13 * H, endMs: T + 18 * H };
		expect(rulePeriods(r, T + 14 * H, T + 14 * H)).toEqual([{ startMs: T + 13 * H, endMs: T + 18 * H }]);
		expect(rulePeriods({ mode: 'firm', startMs: T, endMs: T + H }, T - DAY, T + DAY)).toEqual([
			{ startMs: T, endMs: T + H },
		]);
		expect(rulePeriods({ mode: 'firm', startMs: T, endMs: T + H }, T + 2 * H, T + 3 * H)).toEqual([]);
	});

	it('keeps a dated rule within its days', () => {
		const r: ActivityRule = { mode: 'firm', date: '2026-11-23', dateTo: '2026-11-24', from: '08:00', to: '09:00' };
		expect(rulePeriods(r, -Infinity, Infinity)).toHaveLength(2);
		expect(rulePeriods(r, Date.UTC(2026, 10, 25), Infinity)).toEqual([]);
	});

	it('stops a dateless walk at its last day', () => {
		const r: ActivityRule = { mode: 'notam', dateTo: '2026-11-24', from: '08:00', to: '09:00' };
		expect(rulePeriods(r, T, T + 7 * DAY).map((x) => x.startMs)).toEqual([
			Date.UTC(2026, 10, 24, 8, 0),
		]);
	});
});

/** European summer time, from the last Sunday of March to the last Sunday
 *  of October at 01:00Z, written apart from route/airspaceHours.ts. */
function summer(ms: number): boolean {
	const y = new Date(ms).getUTCFullYear();
	const lastSunday = (month: number) => {
		const d = new Date(Date.UTC(y, month + 1, 0, 1));
		return d.getTime() - d.getUTCDay() * DAY;
	};
	return ms >= lastSunday(2) && ms < lastSunday(9);
}

/** The eager windows of a supplement's schedule as the alerts read them
 *  until the rules replaced them (nav/alertVolumes.ts at 81722f1b), the
 *  reference the reading must answer as, a standing rule's clock hours, a
 *  sun window's clock ends with them, an hour earlier in summer. */
function eagerWindows(
	activations: (Omit<SupAipActivation, 'mode'> & Pick<SupAipStanding, 'summerEarlier'>)[],
	sun?: SunLookup,
): ActivePeriod[] {
	const dayStart = (date: string): number | null => {
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
		return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
	};
	const clock = (t: string | undefined): number | null => {
		const m = t ? /^(\d{2}):(\d{2})$/.exec(t) : null;
		if (!m) {
			return null;
		}
		const min = Number(m[1]) * 60 + Number(m[2]);
		return Number(m[2]) < 60 && min <= 24 * 60 ? min * 60_000 : null;
	};
	const out: ActivePeriod[] = [];
	for (const act of activations) {
		const d0 = dayStart(act.date);
		if (d0 == null) {
			continue;
		}
		const d1 = act.dateTo ? (dayStart(act.dateTo) ?? d0) : d0;
		const from = clock(act.from);
		const to = clock(act.to);
		const rule = hasDayRule(act);
		if (hasSunEnd(act)) {
			for (let d = d0; d <= d1; d += DAY) {
				if (rule && !activationHolds(act, d)) {
					continue;
				}
				const [startMs, endMs] = sunWindow(act, d, sun, act.summerEarlier && summer(d + DAY / 2) ? H : 0);
				out.push({ startMs, endMs });
			}
			continue;
		}
		if (from == null && to == null) {
			if (!rule) {
				if (d1 >= d0) {
					out.push({ startMs: d0, endMs: d1 + DAY });
				}
				continue;
			}
			let run: number | null = null;
			for (let d = d0; d <= d1 + DAY; d += DAY) {
				const held = d <= d1 && activationHolds(act, d);
				if (held && run === null) {
					run = d;
				} else if (!held && run !== null) {
					out.push({ startMs: run, endMs: d });
					run = null;
				}
			}
			continue;
		}
		const open = from ?? 0;
		const close = to ?? DAY;
		for (let d = d0; d <= d1; d += DAY) {
			if (rule && !activationHolds(act, d)) {
				continue;
			}
			const early = act.summerEarlier && summer(d + open) ? H : 0;
			out.push({ startMs: d + open - early, endMs: (close > open ? d + close : d + close + DAY) - early });
		}
	}
	return out;
}

type ModePeriod = ActivePeriod & { mode: ActivityMode };

/** A zone's eager windows with the mode each reads in, its standing rules
 *  held day by day over the validity, or 'unknown' where the old model read
 *  none. */
function eagerZone(s: SupAip, i: number): ModePeriod[] | 'unknown' {
	const z = s.zones[i];
	const sun = supZoneSun(s, z);
	const schedule = zoneSchedule(s, z);
	const standing = validityEmpty(s) || !s.validFrom || !s.validTo ? [] : z.standing;
	if (schedule || standing.length > 0) {
		return [
			...(schedule ?? []).flatMap((a) =>
				eagerWindows([a], sun).map((p): ModePeriod => ({ ...p, mode: a.mode ?? 'firm' })),
			),
			...standing.flatMap((st) =>
				eagerWindows([{ ...st, date: s.validFrom!, dateTo: s.validTo! }], sun).map(
					(p): ModePeriod => ({ ...p, mode: st.mode ?? 'firm' }),
				),
			),
		];
	}
	if (validityEmpty(s)) {
		return [];
	}
	const from = s.validFrom ? Date.parse(`${s.validFrom}T00:00:00Z`) : null;
	const to = s.validTo ? Date.parse(`${s.validTo}T00:00:00Z`) : null;
	if (from == null && to == null) {
		return 'unknown';
	}
	return [{ startMs: from ?? 0, endMs: to != null ? to + DAY : Infinity, mode: 'firm' }];
}

/** The ladder's order among a zone's own periods: firm, may be activated,
 *  unread, by NOTAM. */
const RANK: Record<ActivityMode, number> = { firm: 0, activable: 1, unread: 2, notam: 3 };

describe('the shipped supplements', () => {
	let sups: SupAip[] = [];
	beforeAll(async () => {
		vi.stubGlobal('fetch', (url: string) =>
			Promise.resolve(
				new Response(readFileSync(new URL(`../public${url}`, import.meta.url), 'utf-8'), {
					headers: { 'content-type': 'application/json' },
				}),
			),
		);
		try {
			sups = await loadSupAip(SUPAIP_URL);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('read as their eager windows did, at every edge and between', () => {
		let asked = 0;
		let seed = 1;
		for (const s of sups) {
			const vols = supaipVolumes([s]);
			for (const v of vols) {
				const i = Number(v.key.slice(v.key.lastIndexOf('#') + 1));
				const old = eagerZone(s, i);
				const a = (from: number, to: number) => resolveActivity({ ...v.activity, briefed: false }, from, to);
				if (old === 'unknown') {
					expect(a(T, T).reason, v.key).toBe('unread');
					continue;
				}
				// The edges of every window and an hour either side, then 64
				// instants drawn across the zone's days (a fixed seed), each as
				// an instant and as a two-hour traversal.
				const instants = old.flatMap((w) => [w.startMs - H, w.startMs, w.endMs, w.endMs + H]).filter(Number.isFinite);
				const lo = Math.min(...instants, T);
				const hi = Math.min(Math.max(...instants, T), lo + 800 * DAY);
				for (let k = 0; k < 64; k++) {
					seed = (seed * 1103515245 + 12345) % 2147483648;
					instants.push(lo + Math.floor((seed / 2147483648) * (hi - lo + 1)));
				}
				for (const t of instants) {
					for (const span of [0, 2 * H]) {
						const hit = old
							.filter((w) => w.startMs <= t + span && w.endMs >= t)
							.sort((x, y) => RANK[x.mode] - RANK[y.mode])[0];
						const want = hit
							? [hit.mode === 'firm' ? 'active' : 'activable', { startMs: hit.startMs, endMs: hit.endMs }]
							: ['inactive', null];
						const got = a(t, t + span);
						expect([v.key, t, got.state, got.state === 'inactive' ? null : got.period]).toEqual([
							v.key,
							t,
							...want,
						]);
						asked++;
					}
				}
			}
		}
		expect(asked).toBeGreaterThan(100_000);
	});
});
