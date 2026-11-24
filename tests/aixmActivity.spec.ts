/* A UK zone's activity from its activations' AIXM status
 * (data/aixmActivity.ts over the rmkWorkHr internal/aixm5 writes): each
 * line as NATS files it, read against the UK AIP of 29 October 2026, the
 * census over the shipped rows, and the alerts reading it. A German R or D
 * zone reads its DFS status the same way, active in its timetable and may
 * be active outside it. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveActivity, type ActivityRule } from '$lib/data/activity';
import { aixmActivityRules } from '$lib/data/aixmActivity';
import { rowToAirspace, type Airspace } from '$lib/data/airspaces';
import { airspaceVolumes } from '$lib/nav/alertVolumes';

const WEEK = { mode: 'firm', summerEarlier: true } as const;

describe('a status line', () => {
	const cases: [string, string, ActivityRule[] | null][] = [
		// ENR 5.1 EGD141 HYTHE RANGES: "Hours: H24".
		['Active, no hours', 'Active', [{ mode: 'firm' }]],
		// ENR 5.1 EGD061 WOODBURY COMMON: "Hours: Activated by NOTAM."
		['by NOTAM', 'Available for activation: Activated by NOTAM.; activity periods to be published by NOTAM', [{ mode: 'notam' }]],
		// ENR 5.5 ALDEBURGH KITE FLYING SITE: "Hours: SR-SS. Activated by NOTAM."
		['by NOTAM in a window', 'Active: Activated by NOTAM.; SR-SS.', [{ mode: 'notam', sunFrom: 'SR', sunTo: 'SS' }]],
		// ENR 5.1 EGD006A FALMOUTH BAY.
		[
			'a timetable, by NOTAM at other times',
			'Active: Mon-Thu 0800-1700 (0700-1600), Fri 0800-1400 (0700-1300); and as activated by NOTAM.; OTHER',
			[
				{ ...WEEK, days: [1, 2, 3, 4], from: '08:00', to: '17:00' },
				{ ...WEEK, days: [5], from: '08:00', to: '14:00' },
				{ mode: 'notam' },
			],
		],
		[
			'a timetable and its NOTAM statement in one clause',
			'Active: Mon-Fri 0700-1900 (0600-1800), other times by NOTAM.; OTHER',
			[{ ...WEEK, days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00' }, { mode: 'notam' }],
		],
		// ENR 5.2 NSGA AREA 6A: "Hours: HJ. Daylight hours."
		['a sun window', 'Active: SR-SS', [{ mode: 'firm', sunFrom: 'SR', sunTo: 'SS' }]],
		// ENR 5.2 AARA AREA 02: an area available for use at any time.
		['permanently available', 'Active: Permanently available.', [{ mode: 'activable' }]],
		['available for activation', 'Available for activation', [{ mode: 'activable' }]],
		['available in a window', 'Available for activation: SS-SR', [{ mode: 'activable', sunFrom: 'SS', sunTo: 'SR' }]],
		// The internal/aixm5 timesheet form.
		['a timesheet', 'Active: MON-FRI 05:00-17:00 (04:00-16:00)', [{ ...WEEK, days: [1, 2, 3, 4, 5], from: '05:00', to: '17:00' }]],
		// Read in part: firm widens to unread, by NOTAM holds at all times.
		['ENR 5.1 EGD118 PEMBREY, its start alone an hour earlier', 'Active: Mon-Thu 0900-1600 (0800-1600), Fri 0900-1400 (0800-1300); and as activated by NOTAM.; OTHER', [{ mode: 'unread' }, { mode: 'notam' }]],
		['normally', 'Active: Normally during daylight hours.; OTHER', [{ mode: 'unread' }]],
		[
			'a holiday',
			'Active: Mon-Fri 0830-1700 (0730-1630). Excluding English Public Holidays. TRA may be activated at other times by NOTAM.; OTHER',
			[{ mode: 'unread' }, { mode: 'notam' }],
		],
		['by NOTAM on days read in part', 'Available for activation: Not available Sat/Sun/PH.; Activated by NOTAM.', [{ mode: 'notam' }]],
		['a status the reader cannot vouch for', 'Other: SS-SR.', [{ mode: 'unread' }]],
		['a NOTAM statement alone under Active', 'Active: and as activated by NOTAM.', [{ mode: 'unread' }, { mode: 'notam' }]],
		// A French hours remark is none of these.
		['no status', 'Activité réelle connue de : SEINE INFO\\\\Actual activity known on SEINE INFO', null],
	];
	for (const [label, text, want] of cases) {
		it(label, () => {
			expect(aixmActivityRules(text)).toEqual(want);
		});
	}
});

describe('the shipped UK zones', () => {
	const d = JSON.parse(readFileSync('public/data/uk-airspaces.json', 'utf8')) as { rows: unknown[][] };
	const rows = d.rows.map((r) => rowToAirspace(r, 'uk')).filter((a): a is Airspace => a !== null && a.category === 'restricted');
	const stated = rows.filter((a) => a.rmkWorkHr !== '');

	it('read every status line, firm at all times only where the line says Active alone', () => {
		expect(stated.length).toBeGreaterThan(400);
		for (const a of stated) {
			const rules = aixmActivityRules(a.rmkWorkHr);
			expect(rules, a.id).not.toBeNull();
			const always = rules!.some((r) => r.mode === 'firm' && !r.from && !r.sunFrom && !r.days);
			expect(always ? a.rmkWorkHr.split('\n').includes('Active') : true, `${a.id}: ${a.rmkWorkHr}`).toBe(true);
		}
	});

	it('reach the alerts, the other publishers keeping their way', () => {
		const egd061 = rows.find((a) => a.id === 'EGD061')!;
		const hythe = rows.find((a) => a.id === 'EGD141')!;
		const [v061] = airspaceVolumes([egd061]);
		const [v141] = airspaceVolumes([hythe]);
		expect(v061.activity.rules).toEqual([{ mode: 'notam' }]);
		expect(v141.activity.rules).toEqual([{ mode: 'firm' }]);
		// A UK row with no status line keeps the way its activity is known.
		const bare = rows.find((a) => a.rmkWorkHr === '' && a.type === 'D');
		if (bare) {
			expect(airspaceVolumes([bare])[0]?.activity.rules).toEqual([{ mode: 'unread' }]);
		}
	});
});

describe('the shipped German zones', () => {
	const d = JSON.parse(readFileSync('public/data/de-airspaces.json', 'utf8')) as { rows: unknown[][] };
	const rows = d.rows.map((r) => rowToAirspace(r, 'de')).filter((a): a is Airspace => a !== null);
	const stateAt = (a: Airspace, iso: string) => {
		const [v] = airspaceVolumes([a]);
		const t = Date.parse(iso);
		return resolveActivity({ ...v.activity, briefed: false }, t, t).state;
	};

	it('read an R or D zone active in its timetable and may be active outside it, never inactive', () => {
		// ED-R 32 A MUNSTER A, "Active: MON-FRI 05:00-17:00 (04:00-16:00)".
		const munster = rows.find((a) => a.id === 'EDR32A')!;
		expect(munster.rmkWorkHr).toBe('Active: MON-FRI 05:00-17:00 (04:00-16:00)');
		expect(stateAt(munster, '2026-11-23T10:00:00Z')).toBe('active');
		expect(stateAt(munster, '2026-11-23T20:00:00Z')).toBe('activable');
		expect(stateAt(munster, '2026-11-21T10:00:00Z')).toBe('activable');
		const zones = rows.filter((a) => (a.type === 'R' || a.type === 'D') && a.rmkWorkHr !== '');
		expect(zones.length).toBeGreaterThan(150);
		for (const a of zones) {
			for (const iso of ['2026-11-21T03:00:00Z', '2026-11-23T10:00:00Z', '2026-11-25T22:00:00Z']) {
				expect([a.id, stateAt(a, iso)]).not.toEqual([a.id, 'inactive']);
			}
		}
	});

	it('leave the other German rows to the way their activity is known', () => {
		const alert = rows.find((a) => a.type === 'A' && a.category === 'restricted' && a.rmkWorkHr !== '')!;
		const rules = airspaceVolumes([alert])[0]?.activity.rules ?? [];
		expect(rules.some((r) => r.days !== undefined || r.from !== undefined || r.sunFrom !== undefined)).toBe(false);
	});
});
