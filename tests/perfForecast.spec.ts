/* The performance page's forecast aerodrome conditions
 * (flightprep/runwayPerf.ts wxPick and the autos over it): a column's empty
 * weather fields read the METAR while the phase is flown within its two
 * hours, the forecast at the phase's own instant past them, the METAR still
 * where no forecast reaches, and the estimates (dossier QNH, ISA, calm)
 * only where neither speaks; one source for all four fields, typed values
 * winning, and the placeholder the value in force whichever source shows.
 * The strip over the grids lists those sources by kind (wxStrip), never a
 * METAR among the forecasts nor one no column reads. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Airport } from '$lib/data/airports';
import { memoryStorage } from './helpers/storage';

/** LFPL, its paved 08/26 alone: the case the wind is projected on. */
const LFPL = {
	ident: 'LFPL',
	type: 'small_airport',
	name: 'LOGNES EMERAINVILLE',
	lat: 48.82194,
	lon: 2.62278,
	elevFt: 359,
	runways: [
		{
			le: '08',
			he: '26',
			lengthFt: 2297,
			widthFt: 66,
			surface: 'ASPH',
			lit: false,
			leLdaFt: 2297,
			leToraFt: 2297,
			leTodaFt: 2297,
			leAsdaFt: 2297,
			heLdaFt: 2297,
			heToraFt: 2297,
			heTodaFt: 2297,
			heAsdaFt: 2297,
			leLighting: null,
			heLighting: null,
			lePos: null,
			hePos: null,
		},
	],
	radios: [],
	source: 'fr',
} as unknown as Airport;

/** Valence, the strip's second aerodrome: no runway is computed there. */
const LFLU = {
	ident: 'LFLU',
	type: 'medium_airport',
	name: 'VALENCE CHABEUIL',
	lat: 44.9216,
	lon: 4.9699,
	elevFt: 525,
	runways: [],
	radios: [],
	source: 'fr',
} as unknown as Airport;

vi.mock('$lib/state/data.svelte', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/state/data.svelte')>();
	const known: Record<string, Airport> = { LFPL, LFLU };
	return { ...real, airportByIdent: (i: string) => known[i.toUpperCase()] ?? null };
});
vi.stubGlobal('localStorage', memoryStorage());

const { weatherState } = await import('$lib/state/weather.svelte');
const { setLiveWeather } = await import('$lib/state/display.svelte');
const { aerodromeForecasts, resetAerodromeForecastsForTest } = await import('$lib/state/aerodromeForecast.svelte');
const { servedStamp } = await import('$lib/weather/forecastCache');
const fp = await import('$lib/state/flightPrep.svelte');
const rp = await import('$lib/components/flightprep/runwayPerf');

const H = 3_600_000;
const NOW = Date.now();
/** The forecast's first hour, two hours back. */
const T0 = Math.floor(NOW / H) * H - 2 * H;

/** The nearest station observed ten minutes ago (or `agoS` seconds):
 *  080/10, 22 °C, Q1028. */
function observe(icao = 'LFPL', agoS = 600): void {
	weatherState.nearest[icao] = {
		status: 'ok',
		metar: {
			icaoId: 'LFPO',
			obsTime: Math.floor(NOW / 1000) - agoS,
			wdir: 80,
			wspd: 10,
			temp: 22,
			altim: 1028,
			rawOb: 'METAR LFPO',
			lat: 48.7233,
			lon: 2.3794,
		},
		distanceM: 21_000,
		fetchedAt: NOW,
	} as never;
}

/** A grid point standing 400 m high, as an IFS one does beside a field in
 *  hilly country: a day of 260/12 kt, 14.0 °C and 961.7 hPa, which is QNH
 *  1008.6 (so the round-down shows) and 15.9 °C at the field's 109 m (so
 *  the lapse correction shows). */
function forecast(icao = 'LFPL'): void {
	const timesMs = Array.from({ length: 24 }, (_, i) => T0 + i * H);
	const flat = (v: number) => timesMs.map(() => v);
	aerodromeForecasts.byIcao[icao] = {
		lat: LFPL.lat,
		lon: LFPL.lon,
		model: 'auto_chain',
		col: {
			lat: 48.825,
			lon: 2.625,
			elevationM: 400,
			timesMs,
			hourly: {
				wind_speed_10m: flat(12),
				wind_direction_10m: flat(260),
				wind_gusts_10m: flat(20),
				temperature_2m: flat(14),
				surface_pressure: flat(961.7),
			},
			source: 'nwp',
			runs: { arome0025: T0 },
		},
		stamp: servedStamp({ arome0025: T0 }),
		fetchedMs: NOW,
		startMs: T0,
		endMs: T0 + 23 * H,
		failedMs: 0,
	};
}

/** The ISA height of a pressure (m): where a standard day's surface
 *  pressure stands. */
const isaHeight = (hPa: number) => (288.15 / 0.0065) * (1 - (hPa / 1013.25) ** (287.05287 * 0.0065 / 9.80665));

/** A standard day at LFPL whose answer states `stated` metres of ground,
 *  each hour's surface pressure `ps(hour)` standing on the hourly ground
 *  the service names (or none, `byHour` false): a chain switching models
 *  under the first one's elevation. */
function columnOnAStandardDay(stated: number, ps: (i: number) => number, byHour = true): void {
	const timesMs = Array.from({ length: 24 }, (_, i) => T0 + i * H);
	aerodromeForecasts.byIcao.LFPL = {
		lat: LFPL.lat,
		lon: LFPL.lon,
		model: 'auto_chain',
		col: {
			lat: 48.825,
			lon: 2.625,
			elevationM: stated,
			timesMs,
			hourly: {
				wind_speed_10m: timesMs.map(() => 12),
				wind_direction_10m: timesMs.map(() => 260),
				temperature_2m: timesMs.map(() => 14),
				surface_pressure: timesMs.map((_, i) => ps(i)),
				...(byHour ? { elevation: timesMs.map((_, i) => isaHeight(ps(i))) } : {}),
			},
			source: 'nwp',
			runs: { arpege01: T0 },
		},
		stamp: servedStamp({ arpege01: T0 }),
		fetchedMs: NOW,
		startMs: T0,
		endMs: T0 + 23 * H,
		failedMs: 0,
	};
}

const ctx = (atMs: number | null) => ({ perf: null, massKg: null, nowMs: NOW, wmmYear: 2026.75, atMs });
const autos = (atMs: number | null) => rp.perfColumn('LFPL', 'takeoff', ctx(atMs)).autos;

beforeEach(() => {
	setLiveWeather(true);
	resetAerodromeForecastsForTest();
	delete weatherState.nearest.LFPL;
	delete weatherState.nearest.LFLU;
	fp.resetPerfWeather();
	fp.setDossier({ qnhHpa: null });
});

describe('which source a column reads', () => {
	it('reads the METAR when nothing times the phase, as before', () => {
		observe();
		forecast();
		const a = autos(null);
		expect(a.qnhHpa).toEqual({ value: 1028, source: 'metar' });
		expect(a.tempC).toEqual({ value: 22, source: 'metar' });
	});

	it('reads the METAR within its two hours, the forecast past them', () => {
		observe();
		forecast();
		expect(autos(NOW + 1.5 * H).qnhHpa.source).toBe('metar');
		const later = autos(NOW + 5 * H);
		// 961.7 hPa at 400 m through the standard atmosphere (1008.6), rounded
		// down as a METAR rounds it.
		expect(later.qnhHpa).toEqual({ value: 1008, source: 'forecast' });
		// 14.0 °C carried down from 400 m to the field's 359 ft (109 m).
		expect(later.tempC).toEqual({ value: 16, source: 'forecast' });
		// 260/12 on 26: the forecast's headwind, not the METAR's 080 tailwind.
		expect(later.headwindKt.source).toBe('forecast');
		expect(later.headwindKt.value + later.tailwindKt.value).toBeGreaterThan(0);
		expect(rp.perfColumn('LFPL', 'takeoff', ctx(NOW + 5 * H)).end?.id).toBe('26');
		expect(rp.perfColumn('LFPL', 'takeoff', ctx(NOW + 1.5 * H)).end?.id).toBe('08');
	});

	it('keeps the METAR for a phase before the observation: its two hours run forward', () => {
		// An ETD left three hours in the past: the take-off meets what is
		// observed now, not the forecast for an hour gone.
		observe();
		forecast();
		expect(autos(NOW - 3 * H).qnhHpa).toEqual({ value: 1028, source: 'metar' });
	});

	it('keeps the METAR where the forecast does not reach the phase', () => {
		observe();
		forecast();
		expect(autos(T0 + 40 * H).qnhHpa).toEqual({ value: 1028, source: 'metar' });
	});

	it('reads the forecast without any METAR, which is then no estimate', () => {
		forecast();
		expect(autos(NOW + 5 * H).qnhHpa.source).toBe('forecast');
		expect(rp.weatherEstimated('LFPL', ctx(NOW + 5 * H))).toBe(false);
		// Untimed, the same column has nothing to read: an estimate.
		expect(rp.weatherEstimated('LFPL', ctx(null))).toBe(true);
	});

	it('falls to the estimates only where neither speaks', () => {
		const a = autos(NOW + 5 * H);
		expect(a.qnhHpa).toEqual({ value: 1013, source: 'standard' });
		expect(a.tempC.source).toBe('isa');
		expect(a.headwindKt).toEqual({ value: 0, source: 'calm' });
		expect(rp.weatherEstimated('LFPL', ctx(NOW + 5 * H))).toBe(true);
	});

	it('reads no forecast with live weather off', () => {
		forecast();
		setLiveWeather(false);
		expect(autos(NOW + 5 * H).qnhHpa.source).toBe('standard');
		expect(rp.weatherEstimated('LFPL', ctx(NOW + 5 * H))).toBe(false);
	});
});

describe('one aerodrome, two phases', () => {
	it('reads each phase at its own instant, and typing the QNH one shows leaves the other alone', () => {
		// The take-off within the METAR's two hours, the landing hours later
		// on the forecast: Q1028 beside Q1008 at one field.
		observe();
		forecast();
		const toCtx = ctx(NOW + 1.5 * H);
		const ldCtx = ctx(NOW + 5 * H);
		const to = rp.perfColumn('LFPL', 'takeoff', toCtx);
		const ld = rp.perfColumn('LFPL', 'landing', ldCtx);
		expect(to.autos.qnhHpa).toEqual({ value: 1028, source: 'metar' });
		expect(ld.autos.qnhHpa).toEqual({ value: 1008, source: 'forecast' });
		const landing = () => rp.conditionsForEnd('LFPL', 'landing', ld.end, { ...ldCtx, massKg: 1000 });
		const before = landing();
		fp.setPerfBlock('LFPL', 'takeoff', { qnhHpa: 1028 });
		expect(landing()).toEqual(before);
		expect(rp.perfColumn('LFPL', 'landing', ldCtx).autos.qnhHpa.value).toBe(1008);
	});
});

describe('the ground the forecast QNH is reduced from', () => {
	it('is the ground under the hour, the model that served it, where a chain switches', () => {
		// Courchevel at the 51 h handover: AROME's surface pressure on its
		// 2 062 m for the first hours, ARPEGE's on its 1 816 m after, under
		// the AROME elevation the column states. Reduced from it, ARPEGE's
		// hours read QNH 1051.
		const SWITCH = 7;
		const ps = (i: number) => (i < SWITCH ? 790.6 : 818.6);
		columnOnAStandardDay(2062, ps);
		for (const at of [T0 + 6 * H, T0 + 6.5 * H, T0 + 7 * H, T0 + 9 * H]) {
			expect(autos(at).qnhHpa).toEqual({ value: 1013, source: 'forecast' });
		}
		columnOnAStandardDay(2062, ps, false);
		expect(autos(T0 + 9 * H).qnhHpa.value).toBe(1051);
	});

	it('carries the temperature from the ground under the hour too', () => {
		// A 2 m 14 °C on ARPEGE's 1 816 m ground: 6.5 °C a kilometre warmer
		// at Lognes' 109 m than reduced from the 2 062 m stated.
		columnOnAStandardDay(2062, () => 818.6);
		const byHour = autos(T0 + 9 * H).tempC.value;
		columnOnAStandardDay(2062, () => 818.6, false);
		const stated = autos(T0 + 9 * H).tempC.value;
		expect(byHour).toBe(Math.round(14 + 0.0065 * (isaHeight(818.6) - 109.4)));
		expect(stated - byHour).toBe(Math.round(14 + 0.0065 * (2062 - 109.4)) - byHour);
	});

	it('is the stated elevation where the answer names no ground by hour', () => {
		forecast();
		expect(autos(NOW + 5 * H).qnhHpa.value).toBe(1008);
	});
});

describe('the forecast in the fields', () => {
	it('gives way to a typed value', () => {
		forecast();
		fp.setPerfBlock('LFPL', 'takeoff', { qnhHpa: 1020 });
		const c = rp.conditionsForEnd('LFPL', 'takeoff', rp.perfColumn('LFPL', 'takeoff', ctx(NOW + 5 * H)).end, {
			...ctx(NOW + 5 * H),
			massKg: 1000,
		});
		// 359 ft at QNH 1020: a pressure altitude below the elevation.
		expect(c?.pressureAltFt).toBeLessThan(359);
	});

	it('changes nothing when the value a placeholder shows is typed', () => {
		forecast();
		const at = NOW + 5 * H;
		const conds = () => {
			const col = rp.perfColumn('LFPL', 'takeoff', ctx(at));
			return { end: col.end?.id, c: rp.conditionsForEnd('LFPL', 'takeoff', col.end, { ...ctx(at), massKg: 1000 }) };
		};
		const before = conds();
		const a = autos(at);
		fp.setPerfBlock('LFPL', 'takeoff', {
			qnhHpa: a.qnhHpa.value,
			tempC: a.tempC.value,
			headwindKt: a.headwindKt.value,
			tailwindKt: a.tailwindKt.value,
		});
		expect(conds()).toEqual(before);
	});
});

describe('the weather strip', () => {
	/** The strip of the aerodromes given, each column at its instant (null:
	 *  untimed). */
	const strip = (at: Record<string, { takeoff: number | null; landing: number | null }>) =>
		rp.wxStrip(Object.keys(at), (icao, phase) => ctx(at[icao][phase]));

	it('lists no METAR where every column reads the forecast, one line per instant in the order flown', () => {
		// Both observed ten minutes ago, every column flown hours later.
		observe();
		observe('LFLU');
		forecast();
		forecast('LFLU');
		const s = strip({
			LFPL: { takeoff: NOW + 5 * H, landing: NOW + 5 * H },
			LFLU: { takeoff: NOW + 9 * H, landing: NOW + 7 * H },
		});
		expect(s.metar).toEqual([]);
		expect(s.estimate).toEqual([]);
		// LFPL's two columns read one instant (the landing no trip flies
		// takes the take-off's), so its line names no phase; LFLU's landing
		// comes before its later take-off.
		expect(s.forecast.map((l) => [l.icao, l.phase, l.fc.atMs])).toEqual([
			['LFPL', null, NOW + 5 * H],
			['LFLU', 'landing', NOW + 7 * H],
			['LFLU', 'takeoff', NOW + 9 * H],
		]);
		// The values its fields hold: the reduced QNH, the lapsed temperature.
		expect(s.forecast[0]).toMatchObject({ qnhHpa: 1008, tempC: 16 });
	});

	it('puts a phase within the METAR’s two hours under the METAR, the later one under the forecast', () => {
		observe();
		forecast();
		const s = strip({ LFPL: { takeoff: NOW + 1.5 * H, landing: NOW + 5 * H } });
		expect(s.metar.map((l) => [l.icao, l.phase])).toEqual([['LFPL', 'takeoff']]);
		expect(s.metar[0]).toMatchObject({ qnhHpa: 1028, tempC: 22, noForecastAt: [], refreshFailed: false });
		expect(s.forecast.map((l) => [l.icao, l.phase])).toEqual([['LFPL', 'landing']]);
	});

	it('lists a METAR both columns read once, naming no phase', () => {
		observe();
		const s = strip({ LFPL: { takeoff: null, landing: null } });
		expect(s.metar.map((l) => [l.icao, l.phase])).toEqual([['LFPL', null]]);
		expect(s.forecast).toEqual([]);
		expect(s.estimate).toEqual([]);
	});

	it('says which instants a METAR stands in for, once the forecast came back without them', () => {
		observe();
		forecast();
		expect(strip({ LFPL: { takeoff: T0 + 40 * H, landing: T0 + 40 * H } }).metar[0].noForecastAt).toEqual([
			T0 + 40 * H,
		]);
		// Still asked for: nothing is said yet.
		resetAerodromeForecastsForTest();
		expect(strip({ LFPL: { takeoff: NOW + 5 * H, landing: NOW + 5 * H } }).metar[0].noForecastAt).toEqual([]);
	});

	it('says why a column reads neither', () => {
		// Nothing answered yet: the lookup and the forecast are both out.
		expect(strip({ LFPL: { takeoff: NOW + 5 * H, landing: NOW + 5 * H } }).estimate).toEqual([
			{ icao: 'LFPL', phase: null, typed: false, metar: { kind: 'fetching' }, forecast: 'pending' },
		]);
		// Nothing reports within 50 NM, and nothing times the columns.
		weatherState.nearest.LFPL = { status: 'ok', metar: null, distanceM: null, fetchedAt: NOW } as never;
		expect(strip({ LFPL: { takeoff: null, landing: null } }).estimate[0]).toMatchObject({
			metar: { kind: 'no-station' },
			forecast: null,
		});
		// The lookup failed with nothing held.
		weatherState.nearest.LFPL = { status: 'error', metar: null, distanceM: null, fetchedAt: NOW } as never;
		expect(strip({ LFPL: { takeoff: null, landing: null } }).estimate[0].metar).toEqual({ kind: 'unavailable' });
		// Four hours old, and a forecast that came back without the hour.
		observe('LFPL', 4 * 3600);
		forecast();
		const e = strip({ LFPL: { takeoff: T0 + 40 * H, landing: T0 + 40 * H } }).estimate[0];
		expect(e.metar.kind).toBe('stale');
		expect(e.forecast).toBe('none');
	});

	it('says typed values in use on the line of the column typed over', () => {
		observe();
		forecast();
		fp.setPerfBlock('LFPL', 'landing', { tempC: 30 });
		const s = strip({ LFPL: { takeoff: NOW + 1.5 * H, landing: NOW + 5 * H } });
		expect(s.metar[0].typed).toBe(false);
		expect(s.forecast[0].typed).toBe(true);
	});

	it('lists nothing with live weather off', () => {
		observe();
		forecast();
		setLiveWeather(false);
		expect(strip({ LFPL: { takeoff: null, landing: null } })).toEqual({ metar: [], forecast: [], estimate: [] });
	});
});
