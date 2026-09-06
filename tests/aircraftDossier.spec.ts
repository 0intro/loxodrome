/* Pins the dossier timeline (src/lib/aircraft/dossier.ts) to the workbook's
 * Dossier tab for the Brienne trip (LFPL -> LFQH -> LFGP -> LFPL, departure
 * 07:30, the fuel sheet's with-wind burn-offs 84/33/64 min). Two deliberate
 * deviations from the sheet's displayed values are asserted as such: the
 * sheet chained the STILL-AIR minutes (arrivals 08:54/09:24/10:24) and
 * carried unrounded floats (limit 11:06); the app chains with wind
 * (08:54/09:27/10:31) on integer minutes (limit 11:07). */

import { describe, it, expect } from 'vitest';
import {
	dossierChain,
	computeDossierTimeline,
	nightMarginMin,
	timelineAtNight,
	timelineWindowMin,
	fmtClock,
	parseClock,
	parseDuration,
	fmtDuration,
	DOSSIER_CHECKS,
	type DossierTripInput,
} from '$lib/aircraft/dossier';
import type { SunTimes } from '$lib/route/sun';

const LFPL = { label: 'LFPL', lat: 48.82103, lon: 2.62597 };
const LFQH = { label: 'LFQH', lat: 47.84392, lon: 4.58005 };
const LFGP = { label: 'LFGP', lat: 47.98019, lon: 3.77558 };

function brienneTrips(stops: [number, number] = [0, 0]): DossierTripInput[] {
	return [
		{
			from: LFPL,
			to: LFQH,
			burnOffMin: 84, // taxi 5 + trip 69 + procedure 10 + wind 0
			stopMin: stops[0],
			alternate: { label: 'LFQB', timeMin: 24, procedureMin: 10, windAllowanceMin: 2 },
		},
		{
			from: LFQH,
			to: LFGP,
			burnOffMin: 33, // taxi 0 + trip 20 + procedure 10 + wind 3
			stopMin: stops[1],
			alternate: { label: 'LFLA', timeMin: 8, procedureMin: 10, windAllowanceMin: 1 },
		},
		{
			from: LFGP,
			to: LFPL,
			burnOffMin: 64, // taxi 5 + trip 45 + procedure 10 + wind 4
			stopMin: 0,
			alternate: { label: 'LFPK', timeMin: 10, procedureMin: 10, windAllowanceMin: 0 },
		},
	];
}

// Departure 07:30; fuel on board = the plan minimum 247 min (Carburant!B27);
// day VFR final reserve 30 min.
const PARAMS = { departureMin: 450, fuelOnBoardMin: 247, finalReserveMin: 30 };

describe('dossierChain', () => {
	it('heads the columns with departure + every destination', () => {
		expect(dossierChain(brienneTrips()).map((e) => e.label)).toEqual([
			'LFPL',
			'LFQH',
			'LFGP',
			'LFPL',
		]);
	});

	it('is empty without trips', () => {
		expect(dossierChain([])).toEqual([]);
	});
});

describe('computeDossierTimeline', () => {
	it('reproduces the Brienne timeline (with wind)', () => {
		const t = computeDossierTimeline(brienneTrips(), PARAMS);
		expect(t.departuresMin).toEqual([450, 534, 567]); // 07:30 08:54 09:27
		expect(t.arrivalsMin).toEqual([534, 567, 631]); // 08:54 09:27 10:31
		// Destination arrival + alternate time + its procedure + its wind.
		expect(t.alternateArrivalsMin).toEqual([570, 586, 651]); // 09:30 09:46 10:51
		// 07:30 + 0 stops + (247 - 30); the sheet displayed 11:06 off its
		// unrounded internals.
		expect(t.fuelLimitMin).toBe(667); // 11:07
	});

	it('ground stops shift the chain and the fuel limit later', () => {
		const t = computeDossierTimeline(brienneTrips([20, 15]), PARAMS);
		expect(t.departuresMin).toEqual([450, 554, 602]);
		expect(t.arrivalsMin).toEqual([534, 587, 666]);
		expect(t.fuelLimitMin).toBe(702); // 11:42
	});

	it('hides the fuel limit without fuel data', () => {
		const t = computeDossierTimeline(brienneTrips(), { ...PARAMS, fuelOnBoardMin: null });
		expect(t.fuelLimitMin).toBeNull();
	});

	it('is empty without trips', () => {
		const t = computeDossierTimeline([], PARAMS);
		expect(t.departuresMin).toEqual([]);
		expect(t.arrivalsMin).toEqual([]);
		expect(t.alternateArrivalsMin).toEqual([]);
		expect(t.fuelLimitMin).toBeNull();
	});

	it('handles a trip without an alternate', () => {
		const trips = brienneTrips();
		trips[1] = { ...trips[1], alternate: null };
		const t = computeDossierTimeline(trips, PARAMS);
		expect(t.alternateArrivalsMin).toEqual([570, null, 651]);
	});
});

describe('timelineWindowMin', () => {
	it('spans first departure to the latest alternate arrival', () => {
		// Brienne: departure 07:30; last arrival 10:31 but the LFPK alternate
		// would land 10:51, and a diversion is part of the flight window.
		const w = timelineWindowMin(computeDossierTimeline(brienneTrips(), PARAMS));
		expect(w).toEqual({ startMin: 450, endMin: 651 });
	});

	it('without alternates the last arrival closes the window', () => {
		const trips = brienneTrips().map((t) => ({ ...t, alternate: null }));
		const w = timelineWindowMin(computeDossierTimeline(trips, PARAMS));
		expect(w).toEqual({ startMin: 450, endMin: 631 });
	});

	it('null without trips', () => {
		expect(timelineWindowMin(computeDossierTimeline([], PARAMS))).toBeNull();
	});
});

describe('timelineAtNight', () => {
	// Lognes-like day: sunrise 04:42Z, sunset 18:52Z -> day window
	// [04:12, 19:22] with the 30 min aeronautical-night margin.
	const DAY: SunTimes = {
		sunrise: { kind: 'time', minutesUtc: 282 },
		sunset: { kind: 'time', minutesUtc: 1132 },
	};
	const POLAR_DAY: SunTimes = {
		sunrise: { kind: 'polar-day' },
		sunset: { kind: 'polar-day' },
	};
	const POLAR_NIGHT: SunTimes = {
		sunrise: { kind: 'polar-night' },
		sunset: { kind: 'polar-night' },
	};
	const SUN4 = [DAY, DAY, DAY, DAY];

	function at(departureMin: number) {
		return computeDossierTimeline(brienneTrips(), { ...PARAMS, departureMin });
	}

	it('the Brienne 07:30 departure is a day flight', () => {
		expect(timelineAtNight(at(450), SUN4)).toBe(false);
	});

	it('a departure before sunrise - 30 is night', () => {
		expect(timelineAtNight(at(240), SUN4)).toBe(true); // 04:00 < 04:12
	});

	it('an arrival after sunset + 30 is night', () => {
		// dep 16:40 -> last arrival 19:41 > 19:22.
		expect(timelineAtNight(at(1000), SUN4)).toBe(true);
	});

	it('an alternate arrival alone can be the night trigger', () => {
		// dep 16:10: last arrival 19:11 (day) but its alternate lands 19:31.
		expect(timelineAtNight(at(970), SUN4)).toBe(true);
		const trips = brienneTrips();
		trips[2] = { ...trips[2], alternate: null };
		const t = computeDossierTimeline(trips, { ...PARAMS, departureMin: 970 });
		expect(timelineAtNight(t, SUN4)).toBe(false);
	});

	it('polar night is always night, polar day never', () => {
		expect(timelineAtNight(at(450), [POLAR_NIGHT, DAY, DAY, DAY])).toBe(true);
		expect(timelineAtNight(at(240), [POLAR_DAY, POLAR_DAY, POLAR_DAY, POLAR_DAY])).toBe(false);
	});

	it('unknown sun times are skipped', () => {
		expect(timelineAtNight(at(240), [null, null, null, null])).toBe(false);
	});

	it('a low-latitude aerodrome narrows the margin to 15 min (DGAC SERA)', () => {
		// Departure 04:24, 18 min before sunrise: day within the temperate
		// 30 min window, night within the tropical 15 min one. Every later
		// event (last alternate arrival 07:45) is mid-day either way.
		const tropics = [14.6, 14.6, 14.6, 14.6]; // Fort-de-France-like
		expect(timelineAtNight(at(264), SUN4)).toBe(false);
		expect(timelineAtNight(at(264), SUN4, tropics)).toBe(true);
		// The Brienne-chain latitudes (~48 deg) keep the 30 min window.
		expect(timelineAtNight(at(264), SUN4, [48.8, 47.8, 48.0, 48.8])).toBe(false);
	});

	it('a civil-twilight column overrides the margin model (EASA, > 60 deg)', () => {
		const lats = [68, 68, 68, 68];
		const dawn = (min: number): SunTimes => ({
			sunrise: { kind: 'time', minutesUtc: min },
			sunset: { kind: 'time', minutesUtc: 1320 },
		});
		// 04:24 departure: day under the 30 min margin model (>= 04:12)...
		expect(timelineAtNight(at(264), SUN4, lats)).toBe(false);
		// ...but before a 04:30 civil dawn it is night, margin-free...
		expect(timelineAtNight(at(264), SUN4, lats, [dawn(270), dawn(270), dawn(270), dawn(270)])).toBe(true);
		// ...and dawn at 04:24 sharp is already day (strictly before only).
		expect(timelineAtNight(at(264), SUN4, lats, [dawn(264), dawn(264), dawn(264), dawn(264)])).toBe(false);
	});

	it('polar civil twilight: continuous day is never night, continuous night always', () => {
		const lats = [78, 78, 78, 78];
		const pd = [POLAR_DAY, POLAR_DAY, POLAR_DAY, POLAR_DAY];
		const pn = [POLAR_NIGHT, POLAR_NIGHT, POLAR_NIGHT, POLAR_NIGHT];
		// 04:00 departure is night under the margin model, day under a
		// never-ending civil day.
		expect(timelineAtNight(at(240), SUN4, lats)).toBe(true);
		expect(timelineAtNight(at(240), SUN4, lats, pd)).toBe(false);
		expect(timelineAtNight(at(450), SUN4, lats, pn)).toBe(true);
	});
});

describe('nightMarginMin', () => {
	it('follows the DGAC SERA latitude bands: |lat| <= 30 deg is 15 min, else 30', () => {
		expect(nightMarginMin(48.8)).toBe(30); // the Brienne chain
		expect(nightMarginMin(30)).toBe(15); // boundary inclusive ("<= 30")
		expect(nightMarginMin(-14.6)).toBe(15); // southern hemisphere too
		expect(nightMarginMin(68)).toBe(30); // above 60 deg: backs the no-twilight fallback only
		expect(nightMarginMin(null)).toBe(30); // unknown latitude
	});
});

describe('fmtClock / parseClock', () => {
	it('formats wall-clock times, wrapping into one day', () => {
		expect(fmtClock(450)).toBe('07:30');
		expect(fmtClock(667)).toBe('11:07');
		expect(fmtClock(1494)).toBe('00:54');
		expect(fmtClock(-10)).toBe('23:50');
	});

	it('parses strict HH:MM only', () => {
		expect(parseClock('07:30')).toBe(450);
		expect(parseClock('23:59')).toBe(1439);
		expect(parseClock('7:30')).toBeNull();
		expect(parseClock('24:00')).toBeNull();
		expect(parseClock('')).toBeNull();
	});

	it('parses durations as h:mm or bare minutes', () => {
		expect(parseDuration('03:00')).toBe(180);
		expect(parseDuration('0:45')).toBe(45);
		expect(parseDuration('00:00')).toBe(0);
		expect(parseDuration(' 90 ')).toBe(90);
		expect(parseDuration('28:08')).toBe(1688); // an airframe potential
		expect(parseDuration('1:60')).toBeNull();
		expect(parseDuration(':30')).toBeNull();
		expect(parseDuration('-5')).toBeNull();
		expect(parseDuration('')).toBeNull();
	});

	it('formats durations without a day wrap', () => {
		expect(fmtDuration(0)).toBe('00:00');
		expect(fmtDuration(180)).toBe('03:00');
		expect(fmtDuration(1688)).toBe('28:08');
	});

	it('carries a fractional minute rounding over the hour (never HH:60)', () => {
		expect(fmtDuration(119.6)).toBe('02:00');
		expect(fmtDuration(359.712)).toBe('06:00'); // 100 L / 16.68 L/h endurance
		expect(fmtDuration(59.4)).toBe('00:59');
	});
});

describe('DOSSIER_CHECKS', () => {
	it('ids are unique snake_case (the saved contract)', () => {
		const ids = DOSSIER_CHECKS.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) {
			expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
		}
	});
});
