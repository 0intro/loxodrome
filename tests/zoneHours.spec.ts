/* A French restricted area's published hours as activity rules
 * (data/zoneHours.ts): the HOR column of AIP France ENR 5.1, read off the
 * shipped rows. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveActivity, type ActivityRule } from '$lib/data/activity';
import { zoneHoursRules } from '$lib/data/zoneHours';
import { isRtba } from '$lib/map/airspaceSymbology';

const d = JSON.parse(readFileSync('public/data/fr-airspaces.json', 'utf8')) as {
	fields: string[];
	rows: unknown[][];
};
const col = (k: string) => d.fields.indexOf(k);
const cell = (v: unknown): string => (typeof v === 'string' ? v : '');
const ROWS = d.rows.filter((r) => ['R', 'D', 'P', 'TRA'].includes(cell(r[col('type')])));
const rulesOf = (r: unknown[]): ActivityRule[] => {
	const id = cell(r[col('id')]);
	return zoneHoursRules(cell(r[col('workHr')]), cell(r[col('rmkWorkHr')]), isRtba(id));
};
const row = (id: string): unknown[] => {
	const r = ROWS.find((x) => x[col('id')] === id);
	if (!r) {
		throw new Error(`fr-airspaces has no row ${id}`);
	}
	return r;
};
const WEEKDAYS = [1, 2, 3, 4, 5];

describe('zoneHoursRules over the shipped rows', () => {
	const cases: [string, ActivityRule[]][] = [
		// H24, and "Possible activation H24" beside an H24 code.
		['LFR275', [{ mode: 'firm' }]],
		['LFR151', [{ mode: 'activable' }]],
		// A sun window, "LS+2HR - CS" in the French half.
		['LFR212', [{ mode: 'activable', sunFrom: 'SR-30', sunTo: 'SS+30' }]],
		['LFR204L4', [{ mode: 'activable', sunFrom: 'SR+120', sunTo: 'SS' }]],
		// Days and hours: firm under HJ or "Active", activable under HX.
		['LFR224', [{ mode: 'firm', from: '08:00', to: '19:00', summerEarlier: true }]],
		['LFR242', [{ mode: 'activable', from: '08:00', to: '17:00', summerEarlier: true }]],
		['LFD59', [{ mode: 'firm', days: WEEKDAYS, exceptHolidays: true }]],
		[
			'LFR230',
			[
				{ mode: 'firm', days: [2, 4], exceptHolidays: true, from: '06:00', to: '23:00', summerEarlier: true },
				{ mode: 'firm', days: [3], exceptHolidays: true, from: '06:00', to: '16:00', summerEarlier: true },
			],
		],
		['LFR208', [{ mode: 'activable', days: WEEKDAYS, exceptHolidays: true }]],
		['LFR174', [{ mode: 'notam', days: WEEKDAYS, exceptHolidays: true }]],
		// An exception holds for its own group, and other hours are by NOTAM.
		[
			'LFR49L1',
			[
				{ mode: 'activable', days: WEEKDAYS, exceptHolidays: true, from: '07:00', to: '23:00', summerEarlier: true },
				{ mode: 'activable', days: [6], from: '07:00', to: '11:00', summerEarlier: true },
				{ mode: 'notam' },
			],
		],
		// Each clause in its own mode, a clause stating none in the one before.
		[
			'LFR71A',
			[
				{ mode: 'activable', days: WEEKDAYS, from: '06:00', to: '23:00', summerEarlier: true },
				{ mode: 'notam', days: [6], from: '06:00', to: '11:00', summerEarlier: true },
			],
		],
		[
			'LFR235',
			[
				{ mode: 'activable', days: WEEKDAYS, exceptHolidays: true, from: '06:30', to: '18:30', summerEarlier: true },
				{ mode: 'activable', days: [2, 3, 4], exceptHolidays: true, from: '06:30', to: '22:00', summerEarlier: true },
				{ mode: 'notam', days: [6] },
			],
		],
		// Days a clause gives a mode and no window hold all day: "SAT : by NOTAM".
		[
			'LFD122A',
			[
				{ mode: 'activable', days: WEEKDAYS, exceptHolidays: true, from: '07:00', to: '17:00', summerEarlier: true },
				{ mode: 'notam', days: [6] },
			],
		],
		['LFR229A', [{ mode: 'activable', days: WEEKDAYS, exceptHolidays: true }, { mode: 'notam', days: [6] }]],
		// By NOTAM outside the hours, however worded.
		[
			'LFD192S',
			[
				{ mode: 'activable', days: WEEKDAYS, exceptHolidays: true, from: '07:00', to: '20:00', summerEarlier: true },
				{ mode: 'notam', noticeMin: 2880 },
			],
		],
		[
			'LFR49H1',
			[
				{ mode: 'activable', days: WEEKDAYS, exceptHolidays: true, from: '07:00', to: '23:00', summerEarlier: true },
				{ mode: 'activable', days: [6], from: '07:00', to: '11:00', summerEarlier: true },
				{ mode: 'notam' },
			],
		],
		[
			'LFR55A',
			[
				{ mode: 'activable', days: [1, 2, 3, 4] },
				{ mode: 'activable', days: [5], sunFrom: 'SR', sunTo: 'SS' },
				{ mode: 'notam' },
			],
		],
		// The notice of an activation by NOTAM, on its rules by NOTAM.
		['LFR602', [{ mode: 'notam', noticeMin: 4320 }]],
		['LFR607A', [{ mode: 'notam', noticeMin: 4320 }]],
		['LFR239', [{ mode: 'notam', noticeMin: 1440 }]],
		['LFR163A', [{ mode: 'notam', days: WEEKDAYS, exceptHolidays: true, noticeMin: 2880 }]],
		['LFR301', [{ mode: 'notam', days: WEEKDAYS, exceptHolidays: true, noticeMin: 2880 }]],
		['LFD31', [{ mode: 'activable' }, { mode: 'notam', noticeMin: 10080 }]],
		// Read in part: a yearly date range, the holidays as days of activity,
		// another unit's hours. A zone that may be activated may be so at all
		// times, activable where any clause says so.
		['LFR294B', [{ mode: 'activable' }]],
		['LFR220B', [{ mode: 'notam' }]],
		['LFR209', [{ mode: 'activable' }]],
		['LFR14', [{ mode: 'activable' }, { mode: 'notam' }]],
		['LFR105A', [{ mode: 'activable' }]],
		['LFR51', [{ mode: 'activable' }]],
	];
	it.each(cases)('%s', (id, want) => {
		expect(rulesOf(row(id))).toEqual(want);
	});

	it('bounds a briefing\'s silence on LF-R 602 by its 72 hours\' notice', () => {
		const rules = rulesOf(row('LFR602'));
		const t = Date.UTC(2026, 10, 23, 10);
		const reason = (agoH: number) =>
			resolveActivity({ rules, briefed: true, briefedAtMs: t - agoH * 3_600_000 }, t, t).reason;
		expect(reason(24)).toBe('notam-none');
		expect(reason(96)).toBe('notam-notice');
	});

	it('reads the RTBA timetable as the slots activation by NOTAM holds in', () => {
		const rules = rulesOf(row('LFR590A'));
		expect(rules.every((r) => r.mode === 'notam' && r.exceptHolidays === true)).toBe(true);
		expect(rules[0]).toEqual({ mode: 'notam', days: [1], exceptHolidays: true, from: '08:30', to: '11:00', summerEarlier: true });
		expect(rules).toContainEqual({ mode: 'notam', days: [2], exceptHolidays: true, sunFrom: 'SS+30', to: '23:59', summerEarlier: true });
		// Outside its slots the zone is inactive before any briefing: Sunday.
		const sunday = Date.UTC(2026, 10, 22, 10);
		expect(resolveActivity({ rules, rtba: true, briefed: false }, sunday, sunday).state).toBe('inactive');
		// In a slot, a NOTAM it lacks says nothing without the day's release.
		const monday = Date.UTC(2026, 10, 23, 9);
		const a = resolveActivity({ rules, rtba: true, briefed: false }, monday, monday);
		expect([a.state, a.reason]).toEqual(['activable', 'rtba-unbriefed']);
	});
});

describe('zoneHoursRules: the census', () => {
	it('gives every row a rule, in the four modes', () => {
		for (const r of ROWS) {
			const rules = rulesOf(r);
			expect(rules.length, cell(r[col('id')])).toBeGreaterThan(0);
			for (const x of rules) {
				expect(['firm', 'activable', 'notam', 'unread']).toContain(x.mode);
			}
		}
	});

	it('reads 41 RTBA timetables, and leaves the seasonal ones by NOTAM at all times', () => {
		const rtba = ROWS.filter((r) => isRtba(cell(r[col('id')])));
		const timetables = rtba.filter((r) => rulesOf(r).some((x) => x.days !== undefined));
		const seasonal = rtba.filter((r) => /july|august|juillet|aout|vacances|school/i.test(cell(r[col('rmkWorkHr')])));
		expect(timetables.length).toBeGreaterThanOrEqual(41);
		for (const r of seasonal) {
			expect(rulesOf(r), cell(r[col('id')])).toEqual([{ mode: 'notam' }]);
		}
	});

	it('finds every time a row read whole prints in one of its rules', () => {
		// Independent of the reader's grammar: the four-figure times of the
		// English half, against the clock ends its rules carry.
		let checked = 0;
		for (const r of ROWS) {
			const rules = rulesOf(r);
			const ends = new Set(rules.flatMap((x) => [x.from, x.to]).filter((t): t is string => !!t));
			if (ends.size === 0) {
				continue;
			}
			const text = cell(r[col('rmkWorkHr')]);
			const english = text.slice(text.lastIndexOf('\\') + 1);
			for (const m of english.matchAll(/\b(\d{2})(\d{2})\b/g)) {
				expect(ends, `${cell(r[col('id')])}: ${m[0]}`).toContain(`${m[1]}:${m[2]}`);
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(300);
	});
});
