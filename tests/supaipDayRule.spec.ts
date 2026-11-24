/* A SUP AIP activation's day rule (cmd/supaip: "tous les jours sauf Samedi,
 * Dimanche et jours fériés"): the French public holidays, the days it holds,
 * the map's reading per run of held days, and its words in both catalogs. */

import { describe, expect, it } from 'vitest';
import { easterSunday, isPublicHoliday, publicHolidays } from '$lib/data/frHolidays';
import {
	activationHolds,
	activationRunsOverlap,
	zoneSchedule,
	type SupAip,
	type SupAipActivation,
	type SupAipZone,
} from '$lib/data/supaip';
import { dayRuleText } from '$lib/format/dayRule';
import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';

const DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);
const day = (date: string) => Date.parse(`${date}T00:00:00Z`);

// 235/2026's ZRT BARRERE, Monday to Friday off the public holidays.
const barrere: SupAipActivation = {
	date: '2026-11-15',
	dateTo: '2027-04-01',
	days: [1, 2, 3, 4, 5],
	exceptHolidays: true,
};

describe('the French public holidays (Code du travail L3133-1)', () => {
	it('places Easter by the Gregorian computus', () => {
		expect(easterSunday(2024)).toEqual([3, 31]);
		expect(easterSunday(2025)).toEqual([4, 20]);
		expect(easterSunday(2026)).toEqual([4, 5]);
		expect(easterSunday(2027)).toEqual([3, 28]);
		expect(easterSunday(2028)).toEqual([4, 16]);
	});

	it('holds the eleven fêtes légales', () => {
		expect([...publicHolidays(2026)].sort()).toEqual([
			'2026-01-01',
			'2026-04-06',
			'2026-05-01',
			'2026-05-08',
			'2026-05-14',
			'2026-05-25',
			'2026-07-14',
			'2026-08-15',
			'2026-11-01',
			'2026-11-11',
			'2026-12-25',
		]);
		expect(isPublicHoliday('2027-03-29')).toBe(true);
		expect(isPublicHoliday('2026-12-26')).toBe(false);
	});
});

describe('activationHolds', () => {
	it('holds the weekdays the rule names, off its holidays and their eves', () => {
		expect(activationHolds(barrere, day('2026-11-16'))).toBe(true); // Monday
		expect(activationHolds(barrere, day('2026-11-21'))).toBe(false); // Saturday
		expect(activationHolds(barrere, day('2026-11-15'))).toBe(false); // Sunday
		expect(activationHolds(barrere, day('2026-12-25'))).toBe(false); // Christmas, a Friday
		expect(activationHolds(barrere, day('2026-12-24'))).toBe(true);
		expect(activationHolds({ ...barrere, exceptHolidayEves: true }, day('2026-12-24'))).toBe(false);
		expect(activationHolds({}, day('2026-11-15'))).toBe(true);
	});
});

describe('activationRunsOverlap (the map hides a zone on its days off)', () => {
	it('shows the zone on the days its rule holds and hides it on the others', () => {
		expect(activationRunsOverlap(barrere, at('2026-11-16T12:00:00Z'), at('2026-11-16T13:00:00Z'))).toBe(true);
		expect(activationRunsOverlap(barrere, at('2026-11-21T08:00:00Z'), at('2026-11-21T18:00:00Z'))).toBe(false);
		expect(activationRunsOverlap(barrere, at('2026-12-25T08:00:00Z'), at('2026-12-25T18:00:00Z'))).toBe(false);
		// A window from Friday night into Saturday reaches the Friday.
		expect(activationRunsOverlap(barrere, at('2026-11-20T23:00:00Z'), at('2026-11-21T01:00:00Z'))).toBe(true);
	});

	it('keeps a daily slot one block across the days a run holds', () => {
		const slot: SupAipActivation = { date: '2026-11-16', dateTo: '2026-11-20', from: '08:00', to: '12:00', days: [1, 2, 3, 4, 5] };
		// 15:00 on a Tuesday lies between two slots of the run's block.
		expect(activationRunsOverlap(slot, at('2026-11-17T15:00:00Z'), at('2026-11-17T15:30:00Z'))).toBe(true);
		// Friday's slot closes the run at 12:00.
		expect(activationRunsOverlap(slot, at('2026-11-20T15:00:00Z'), at('2026-11-20T16:00:00Z'))).toBe(false);
	});

	it('rolls a night slot into the morning after its last held day', () => {
		const night: SupAipActivation = { date: '2026-11-16', dateTo: '2026-11-20', from: '22:00', to: '04:00', days: [5] };
		expect(activationRunsOverlap(night, at('2026-11-21T03:00:00Z'), at('2026-11-21T03:30:00Z'))).toBe(true);
		expect(activationRunsOverlap(night, at('2026-11-18T23:00:00Z'), at('2026-11-18T23:30:00Z'))).toBe(false);
	});

	it('keeps a zone drawn when its dates cannot be read', () => {
		expect(activationRunsOverlap({ date: 'garbage', days: [1] }, 0, DAY)).toBe(true);
	});
});

describe('zoneSchedule', () => {
	it('keeps the day rule of an activation it cuts to the validity', () => {
		const sup = { validFrom: '2026-11-15', validTo: '2026-12-03' } as SupAip;
		const zone = { activations: [barrere] } as SupAipZone;
		expect(zoneSchedule(sup, zone)).toEqual([{ ...barrere, dateTo: '2026-12-03' }]);
	});
});

describe('dayRuleText', () => {
	const words = (t: typeof en) => ({
		weekdays: t.common.weekdays,
		run: t.detail.supDaysRun,
		list: t.detail.supDaysList,
		except: t.detail.supExceptDays,
	});

	it('words a rule in English', () => {
		expect(dayRuleText(barrere, words(en))).toBe('Monday to Friday, except public holidays');
		expect(dayRuleText({ date: '2026-04-23', days: [2, 4], exceptHolidays: true, exceptHolidayEves: true }, words(en))).toBe(
			'Tuesday and Thursday, except public holidays and the days before them',
		);
		expect(dayRuleText({ date: '2026-04-23', days: [1, 2, 3, 5] }, words(en))).toBe('Monday to Wednesday and Friday');
		expect(dayRuleText({ date: '2026-04-23' }, words(en))).toBe('');
	});

	it('words a rule in French', () => {
		expect(dayRuleText(barrere, words(fr))).toBe('du lundi au vendredi, sauf jours fériés');
		expect(dayRuleText({ date: '2026-04-23', days: [6, 7] }, words(fr))).toBe('samedi et dimanche');
		expect(dayRuleText({ date: '2026-04-23', exceptHolidayEves: true }, words(fr))).toBe('sauf veilles de jours fériés');
	});
});
