/* Validates the NOAA sunrise/sunset port (src/lib/route/sun.ts) against the
 * flight workbook's CSA() sunset values (Dossier tab, flight date
 * 23/04/2026, shown in Europe/Paris local = UTC+2) at the airport dataset's
 * coordinates, NOAA-derived sunrise references, an equatorial reference and
 * the polar branches. Each case:
 * [name, lat, lon, isoDate, expected sunrise, expected sunset] in minutes
 * after 00:00 UTC. */

import { describe, it, expect } from 'vitest';
import {
	civilTwilightUtc,
	isAeroNightUtc,
	isCivilNightUtc,
	sunTimesUtc,
	type SunEvent,
} from '$lib/route/sun';
import { timelineAtNight } from '$lib/aircraft/dossier';

const CASES: [string, number, number, string, number, number][] = [
	// Sheet sunset 20:52 local = 18:52Z; sunrise 06:44 local.
	['LFPL Lognes', 48.82103, 2.62597, '2026-04-23', 4 * 60 + 44, 18 * 60 + 52],
	// Sheet sunset 20:43 local = 18:43Z.
	['LFQH Chatillon-sur-Seine', 47.84392, 4.58005, '2026-04-23', 4 * 60 + 38, 18 * 60 + 43],
	// Sheet sunset 20:46 local = 18:46Z.
	['LFGP Saint-Florentin-Cheu', 47.98019, 3.77558, '2026-04-23', 4 * 60 + 41, 18 * 60 + 46],
	// NOAA reference near the equator (06:09 / 18:15 local UTC-5).
	['Quito', -0.1807, -78.4678, '2026-04-23', 11 * 60 + 9, 23 * 60 + 15],
];

function minutes(e: SunEvent): number {
	expect(e.kind).toBe('time');
	return e.kind === 'time' ? e.minutesUtc : Number.NaN;
}

describe('sunTimesUtc', () => {
	for (const [name, lat, lon, date, rise, set] of CASES) {
		it(`${name} on ${date} rises/sets within 2 min of ${rise}/${set}`, () => {
			const t = sunTimesUtc(lat, lon, date);
			expect(t).not.toBeNull();
			expect(Math.abs(minutes(t!.sunrise) - rise)).toBeLessThanOrEqual(2);
			expect(Math.abs(minutes(t!.sunset) - set)).toBeLessThanOrEqual(2);
		});
	}

	it('midnight sun at Tromso in June', () => {
		expect(sunTimesUtc(69.65, 18.96, '2026-06-21')).toEqual({
			sunrise: { kind: 'polar-day' },
			sunset: { kind: 'polar-day' },
		});
	});

	it('polar night at Tromso in December', () => {
		expect(sunTimesUtc(69.65, 18.96, '2026-12-21')).toEqual({
			sunrise: { kind: 'polar-night' },
			sunset: { kind: 'polar-night' },
		});
	});

	it('rejects malformed dates', () => {
		expect(sunTimesUtc(48, 2, '2026-4-23')).toBeNull();
		expect(sunTimesUtc(48, 2, '')).toBeNull();
		expect(sunTimesUtc(48, 2, '2026-13-45')).toBeNull();
	});

	it('rejects bad coordinates', () => {
		expect(sunTimesUtc(Number.NaN, 2, '2026-04-23')).toBeNull();
		expect(sunTimesUtc(91, 2, '2026-04-23')).toBeNull();
		expect(sunTimesUtc(48, Number.POSITIVE_INFINITY, '2026-04-23')).toBeNull();
	});
});

describe('civilTwilightUtc', () => {
	it('brackets sunrise and sunset at a temperate site', () => {
		const sun = sunTimesUtc(48.6, 4.0, '2026-04-23');
		const tw = civilTwilightUtc(48.6, 4.0, '2026-04-23');
		if (
			sun?.sunrise.kind !== 'time' ||
			sun.sunset.kind !== 'time' ||
			tw?.sunrise.kind !== 'time' ||
			tw.sunset.kind !== 'time'
		) {
			throw new Error('expected time events at 48.6 deg in April');
		}
		// Civil twilight at ~48 deg runs roughly half an hour each side.
		expect(sun.sunrise.minutesUtc - tw.sunrise.minutesUtc).toBeGreaterThan(20);
		expect(sun.sunrise.minutesUtc - tw.sunrise.minutesUtc).toBeLessThan(60);
		expect(tw.sunset.minutesUtc - sun.sunset.minutesUtc).toBeGreaterThan(20);
		expect(tw.sunset.minutesUtc - sun.sunset.minutesUtc).toBeLessThan(60);
	});

	it('polar branches at the 96-degree zenith (Svalbard)', () => {
		expect(civilTwilightUtc(78.2, 15.6, '2026-07-10')?.sunset.kind).toBe('polar-day');
		expect(civilTwilightUtc(78.2, 15.6, '2026-12-21')?.sunrise.kind).toBe('polar-night');
	});

	it('white nights: the sun sets but civil twilight never ends (64 deg, June)', () => {
		expect(sunTimesUtc(64.0, 18.0, '2026-06-21')?.sunset.kind).toBe('time');
		expect(civilTwilightUtc(64.0, 18.0, '2026-06-21')?.sunset.kind).toBe('polar-day');
	});

	it('validates inputs like sunTimesUtc', () => {
		expect(civilTwilightUtc(91, 0, '2026-06-21')).toBeNull();
		expect(civilTwilightUtc(45, 0, '21/06/2026')).toBeNull();
	});
});

describe('isCivilNightUtc', () => {
	it('reads Paris midnight as night and noon as day', () => {
		expect(isCivilNightUtc(48.85, 2.35, Date.parse('2026-06-21T23:30:00Z'))).toBe(true);
		expect(isCivilNightUtc(48.85, 2.35, Date.parse('2026-06-21T12:00:00Z'))).toBe(false);
	});

	it('resolves the polar kinds directly', () => {
		// 78 N in January: continuous night; in June: continuous civil day.
		expect(isCivilNightUtc(78, 16, Date.parse('2026-01-15T12:00:00Z'))).toBe(true);
		expect(isCivilNightUtc(78, 16, Date.parse('2026-06-21T00:00:00Z'))).toBe(false);
	});

	it('never claims night on unresolvable input', () => {
		expect(isCivilNightUtc(91, 0, Date.parse('2026-06-21T00:00:00Z'))).toBe(false);
		expect(isCivilNightUtc(48.85, 2.35, Number.NaN)).toBe(false);
	});
});

describe('isAeroNightUtc (the logbook night: FR margins, civil twilight above 60 deg)', () => {
	// LFPL 2026-04-23: sunrise 04:44Z / sunset 18:52Z (pinned above), 30 min
	// margin at 48.8 N per the arrete du 11.12.2014.
	const LFPL = { lat: 48.82103, lon: 2.62597 };

	it('holds day within the sunset margin and night beyond it', () => {
		expect(isAeroNightUtc(LFPL.lat, LFPL.lon, Date.UTC(2026, 3, 23, 19, 2))).toBe(false);
		expect(isAeroNightUtc(LFPL.lat, LFPL.lon, Date.UTC(2026, 3, 23, 19, 32))).toBe(true);
		// And symmetrically before sunrise (night ends 04:44Z - 30 = 04:14Z).
		expect(isAeroNightUtc(LFPL.lat, LFPL.lon, Date.UTC(2026, 3, 23, 4, 5))).toBe(true);
		expect(isAeroNightUtc(LFPL.lat, LFPL.lon, Date.UTC(2026, 3, 23, 4, 25))).toBe(false);
	});

	it('uses the 15 min margin at latitudes at or below 30 degrees', () => {
		// Quito 2026-04-23: sunset 23:15Z (pinned above), so night from 23:30Z.
		expect(isAeroNightUtc(-0.1807, -78.4678, Date.UTC(2026, 3, 23, 23, 22))).toBe(false);
		expect(isAeroNightUtc(-0.1807, -78.4678, Date.UTC(2026, 3, 23, 23, 40))).toBe(true);
	});

	it('switches to civil twilight above 60 degrees latitude', () => {
		// Tromso: the midnight sun in June is never night; a December midnight
		// is (the margin model would have no sunset to margin from).
		expect(isAeroNightUtc(69.65, 18.96, Date.UTC(2026, 5, 21, 0, 0))).toBe(false);
		expect(isAeroNightUtc(69.65, 18.96, Date.UTC(2026, 11, 21, 0, 0))).toBe(true);
	});

	it('never claims night on unresolvable input', () => {
		expect(isAeroNightUtc(48.85, 2.35, Number.NaN)).toBe(false);
		expect(isAeroNightUtc(Number.NaN, 2.35, Date.UTC(2026, 3, 23, 19, 32))).toBe(false);
	});

	it('agrees with the fuel rule timelineAtNight on the same instants', () => {
		// Two implementations of the same arrete model (per instant here, per
		// timeline column there) must answer identically.
		const sun = [sunTimesUtc(LFPL.lat, LFPL.lon, '2026-04-23')];
		const tl = (min: number) => ({
			departuresMin: [min],
			arrivalsMin: [],
			alternateArrivalsMin: [],
			fuelLimitMin: null,
		});
		for (const [h, m] of [
			[19, 2],
			[19, 32],
			[4, 5],
			[4, 25],
		] as const) {
			expect(timelineAtNight(tl(h * 60 + m), sun, [LFPL.lat])).toBe(
				isAeroNightUtc(LFPL.lat, LFPL.lon, Date.UTC(2026, 3, 23, h, m)),
			);
		}
	});
});
