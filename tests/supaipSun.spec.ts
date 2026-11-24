// The hours a SUP AIP schedule's sun sets (cmd/supaip's sun codes): the
// window each day holds at the zone (data/supaip.ts sunWindow), the alerts'
// windows (nav/alertVolumes.ts supActivationWindows), the map's block on a
// day rule (activationRunsOverlap) and the panel's words (activationTimes).
import { describe, expect, it } from 'vitest';
import {
	activationRunsOverlap,
	activationTimes,
	sunWindow,
	type SupAipActivation,
} from '$lib/data/supaip';
import { supActivationWindows } from '$lib/nav/alertVolumes';
import type { SunLookup } from '$lib/notam/schedule';
import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const D = Date.parse('2026-09-14T00:00:00Z');

/** Sunrise and sunset at fixed minutes after 00:00 UTC every day. */
function sunAt(sunriseMin: number, sunsetMin: number): SunLookup {
	return () => ({ sunriseMin, sunsetMin });
}

const SUN = sunAt(6 * 60, 19 * 60);

function act(a: Partial<SupAipActivation>): SupAipActivation {
	return { date: '2026-09-14', ...a };
}

describe('sunWindow', () => {
	it('reads each end the sun sets on that day at the zone', () => {
		const cases: [Partial<SupAipActivation>, number, number][] = [
			[{ sunFrom: 'SR', sunTo: 'SS' }, 6 * H, 19 * H],
			[{ sunFrom: 'SR-15', to: '09:00' }, 5 * H + 45 * MIN, 9 * H],
			[{ from: '13:00', sunTo: 'SS' }, 13 * H, 19 * H],
			[{ from: '07:00', sunTo: 'SS+30' }, 7 * H, 19 * H + 30 * MIN],
			// A stretch's opening and close on its end days.
			[{ from: '07:00', to: '24:00', sunFrom: 'SR', sunTo: 'SS' }, 7 * H, 19 * H],
			[{ from: '00:00', to: '18:00', sunFrom: 'SR', sunTo: 'SS' }, 6 * H, 18 * H],
			// "1300-SS MAX 1830"
			[{ from: '13:00', to: '18:30', sunTo: 'SS' }, 13 * H, 18 * H + 30 * MIN],
		];
		for (const [a, start, end] of cases) {
			expect(sunWindow(act(a), D, SUN), JSON.stringify(a)).toEqual([D + start, D + end]);
		}
	});

	it('cuts a night stretch at midnight on its end days', () => {
		// "Du 14 à 1800 au 15 à 0500, de SS à SR": the first day's night
		// ends at 24:00, and the last day holds the night before it to 05:00,
		// never the night opening at its own sunset.
		expect(sunWindow(act({ from: '18:00', to: '24:00', sunFrom: 'SS', sunTo: 'SR' }), D, SUN)).toEqual([
			D + 19 * H,
			D + DAY,
		]);
		expect(sunWindow(act({ from: '00:00', to: '05:00', sunFrom: 'SS', sunTo: 'SR' }), D, SUN)).toEqual([
			D,
			D + 5 * H,
		]);
		expect(sunWindow(act({ from: '00:00', to: '08:00', sunFrom: 'SS', sunTo: 'SR' }), D, SUN)).toEqual([
			D,
			D + 6 * H,
		]);
	});

	it('closes a night window the next day', () => {
		expect(sunWindow(act({ sunFrom: 'SS+30', sunTo: 'SR-30' }), D, SUN)).toEqual([
			D + 19 * H + 30 * MIN,
			D + DAY + 5 * H + 30 * MIN,
		]);
		expect(sunWindow(act({ sunFrom: 'SS', to: '02:00' }), D, SUN)).toEqual([
			D + 19 * H,
			D + DAY + 2 * H,
		]);
	});

	it('reads a sun past midnight UTC as the same solar day', () => {
		// French Polynesia: sunrise near 16:00 UTC, sunset near 03:50 the
		// next UTC day, which sunTimesUtc gives as 1670 minutes.
		expect(sunWindow(act({ sunFrom: 'SR', sunTo: 'SS' }), D, sunAt(960, 1670))).toEqual([
			D + 16 * H,
			D + 27 * H + 50 * MIN,
		]);
		// A night stretch's first day there opens after its own midnight:
		// the night runs on to the next sunrise, never closing before it opens.
		expect(
			sunWindow(act({ from: '18:00', to: '24:00', sunFrom: 'SS', sunTo: 'SR' }), D, sunAt(960, 1670)),
		).toEqual([D + 27 * H + 50 * MIN, D + DAY + 16 * H]);
	});

	it('holds the day and the next where the sun is unknown', () => {
		expect(sunWindow(act({ sunFrom: 'SR', sunTo: 'SS' }), D, undefined)).toEqual([D, D + 2 * DAY]);
		expect(sunWindow(act({ from: '08:00', to: '19:30', sunTo: 'SS+30' }), D, () => null)).toEqual([
			D + 8 * H,
			D + DAY + 19 * H + 30 * MIN,
		]);
	});
});

describe('supActivationWindows with sun ends', () => {
	it('holds each day its own window, on the days its rule holds', () => {
		const days = [{ sunFrom: 'SR', sunTo: 'SS', dateTo: '2026-09-16' }];
		expect(supActivationWindows(days.map(act), SUN)).toEqual(
			[0, 1, 2].map((i) => ({ startMs: D + i * DAY + 6 * H, endMs: D + i * DAY + 19 * H })),
		);
		// 14 September 2026 is a Monday.
		const mondays = act({ sunFrom: 'SR', sunTo: 'SS', dateTo: '2026-09-27', days: [1] });
		expect(supActivationWindows([mondays], SUN)).toEqual([
			{ startMs: D + 6 * H, endMs: D + 19 * H },
			{ startMs: D + 7 * DAY + 6 * H, endMs: D + 7 * DAY + 19 * H },
		]);
	});

	it('holds a night stretch from its opening to its close and no night after', () => {
		// cmd/supaip's "Du 14 à 1800 au 15 à 0500, de SS à SR".
		const night = [
			act({ from: '18:00', to: '24:00', sunFrom: 'SS', sunTo: 'SR' }),
			act({ date: '2026-09-15', from: '00:00', to: '05:00', sunFrom: 'SS', sunTo: 'SR' }),
		];
		expect(supActivationWindows(night, SUN)).toEqual([
			{ startMs: D + 19 * H, endMs: D + DAY },
			{ startMs: D + DAY, endMs: D + DAY + 5 * H },
		]);
	});
});

describe('activationRunsOverlap with sun ends', () => {
	it('blocks each run of held days from its first sunrise to its last sunset', () => {
		const a = act({ sunFrom: 'SR', sunTo: 'SS', dateTo: '2026-09-15', days: [1, 2] });
		expect(activationRunsOverlap(a, D + 5 * H, D + 5 * H + MIN, SUN)).toBe(false);
		expect(activationRunsOverlap(a, D + 23 * H, D + 23 * H + MIN, SUN)).toBe(true);
		expect(activationRunsOverlap(a, D + DAY + 20 * H, D + DAY + 20 * H + MIN, SUN)).toBe(false);
	});
});

describe('activationTimes', () => {
	const words = (c: typeof en) => ({ earliest: c.detail.supTimeEarliest, latest: c.detail.supTimeLatest });

	it('prints the sun codes and the clock bounds beside them', () => {
		const cases: [Partial<SupAipActivation>, string, string][] = [
			[{ from: '12:00', to: '18:00' }, '12:00 - 18:00', '12:00 - 18:00'],
			[{}, '', ''],
			[{ sunFrom: 'SS+30', sunTo: 'SR-30' }, 'SS+30 - SR-30', 'SS+30 - SR-30'],
			[{ from: '12:00', sunTo: 'SS' }, '12:00 - SS', '12:00 - SS'],
			[
				{ from: '08:00', to: '19:30', sunTo: 'SS+30' },
				'08:00 - SS+30, 19:30 at the latest',
				'08:00 - SS+30, 19:30 au plus tard',
			],
			[
				{ from: '06:00', to: '24:00', sunFrom: 'SR', sunTo: 'SS' },
				'SR - SS, 06:00 at the earliest',
				'SR - SS, 06:00 au plus tôt',
			],
			// A night stretch's end days, cut at midnight.
			[
				{ from: '18:00', to: '24:00', sunFrom: 'SS', sunTo: 'SR' },
				'SS - 24:00, 18:00 at the earliest',
				'SS - 24:00, 18:00 au plus tôt',
			],
			[
				{ from: '00:00', to: '05:00', sunFrom: 'SS', sunTo: 'SR' },
				'00:00 - SR, 05:00 at the latest',
				'00:00 - SR, 05:00 au plus tard',
			],
		];
		for (const [a, inEn, inFr] of cases) {
			expect(activationTimes(act(a), words(en))).toBe(inEn);
			expect(activationTimes(act(a), words(fr))).toBe(inFr);
		}
	});
});
