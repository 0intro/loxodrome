/* Live-weather helpers (src/lib/weather/metar.ts) over real AWC JSON
 * captures (tests/fixtures/awc-*.json, taken 2026-06-11): QNH rounding,
 * the nearest-station pick from Lognes (the workbook club's field, no METAR
 * of its own), runway wind components through the WMM declination, the
 * freshness gates, and the display formatters. */

import { describe, it, expect } from 'vitest';
import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';
import { readFileSync } from 'node:fs';
import type { AwcMetar, AwcTaf } from '$lib/weather/awc';
import {
	METAR_AMBER_AGE_MIN,
	flightCategory,
	formatAge,
	isMetarCapableIdent,
	formatClouds,
	formatWeather,
	formatDistanceNM,
	formatVisib,
	formatWind,
	latestByStation,
	metarAgeMin,
	metarFreshness,
	nearestMetar,
	nearestSearchBbox,
	parseWeather,
	precipSuggestsWet,
	qfuDeg,
	qnhFromMetar,
	splitRawTaf,
	stationName,
	tafBlockText,
	usableForDefaults,
	windComponents,
} from '$lib/weather/metar';

function load<T>(file: string): T {
	return JSON.parse(
		readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf-8'),
	) as T;
}

const metars = load<AwcMetar[]>('awc-metar.json');
const tafs = load<AwcTaf[]>('awc-taf.json');
const byId = new Map(metars.map((m) => [m.icaoId, m]));
const lfpo = byId.get('LFPO')!;
const lfpn = byId.get('LFPN')!;
const kjfk = byId.get('KJFK')!;

// Lognes-Emerainville: no METAR station, Orly is the nearest (about 11 NM).
const LFPL = { lat: 48.82103, lon: 2.62597 };

// The fixtures' observation time (2026-06-11 21:00Z), as milliseconds.
const T0_MS = 1781211600_000;
const MIN_MS = 60_000;

describe('qnhFromMetar', () => {
	it('keeps the European integral hPa', () => {
		expect(qnhFromMetar(lfpo)).toBe(1024);
		expect(qnhFromMetar(lfpn)).toBe(1023);
	});

	it('floors the inHg-converted value (A2972 -> 1006.5 -> 1006)', () => {
		expect(qnhFromMetar(kjfk)).toBe(1006);
	});

	it('is null without an altimeter', () => {
		expect(qnhFromMetar({ altim: null })).toBeNull();
	});
});

describe('age and freshness', () => {
	it('ages from obsTime', () => {
		expect(metarAgeMin(lfpo, T0_MS + 25 * MIN_MS)).toBe(25);
		expect(metarAgeMin(lfpo, T0_MS)).toBe(0);
	});

	it('tints after one missed hourly cycle, expires after 3 h', () => {
		expect(metarFreshness(30)).toBe('ok');
		expect(metarFreshness(METAR_AMBER_AGE_MIN)).toBe('ok');
		expect(metarFreshness(76)).toBe('aging');
		expect(metarFreshness(180)).toBe('aging');
		expect(metarFreshness(181)).toBe('expired');
	});

	it('gates default injection on age', () => {
		const pick = { metar: lfpo, distanceM: 21_172 };
		expect(usableForDefaults(pick, T0_MS + 25 * MIN_MS)).toBe(true);
		expect(usableForDefaults(pick, T0_MS + 200 * MIN_MS)).toBe(false);
	});
});

describe('latestByStation', () => {
	it('keeps the most recent observation per station', () => {
		const newer = { ...lfpo, obsTime: lfpo.obsTime + 1800, rawOb: 'SPECI LFPO 112130Z ...' };
		const out = latestByStation([lfpo, newer, lfpn]);
		expect(out).toHaveLength(2);
		expect(out.find((m) => m.icaoId === 'LFPO')?.obsTime).toBe(newer.obsTime);
	});
});

describe('nearestMetar', () => {
	it('picks Orly from Lognes (about 21 km), ignoring far stations', () => {
		const pick = nearestMetar(metars, LFPL.lat, LFPL.lon);
		expect(pick?.metar.icaoId).toBe('LFPO');
		expect(pick!.distanceM).toBeGreaterThan(20_500);
		expect(pick!.distanceM).toBeLessThan(22_000);
	});

	it('prefers a station reporting an altimeter over a closer one without', () => {
		const onField: AwcMetar = { ...lfpn, icaoId: 'XXXX', lat: LFPL.lat, lon: LFPL.lon, altim: null };
		const pick = nearestMetar([...metars, onField], LFPL.lat, LFPL.lon);
		expect(pick?.metar.icaoId).toBe('LFPO');
		const altimless = nearestMetar([onField], LFPL.lat, LFPL.lon);
		expect(altimless?.metar.icaoId).toBe('XXXX');
	});

	it('returns null when nothing reports within 50 NM', () => {
		const far: AwcMetar = { ...lfpn, lat: LFPL.lat + 1.0 };
		expect(nearestMetar([far, kjfk], LFPL.lat, LFPL.lon)).toBeNull();
	});
});

describe('nearestSearchBbox', () => {
	it('spans 0.85 deg of latitude, the longitude widened by 1/cos(lat)', () => {
		const box = nearestSearchBbox(48, 2);
		expect(box.minLat).toBeCloseTo(47.15, 10);
		expect(box.maxLat).toBeCloseTo(48.85, 10);
		const dLon = 0.85 / Math.cos((48 * Math.PI) / 180);
		expect(box.minLon).toBeCloseTo(2 - dLon, 10);
		expect(box.maxLon).toBeCloseTo(2 + dLon, 10);
	});

	it('is the plain square at the equator', () => {
		expect(nearestSearchBbox(0, 0)).toEqual({
			minLat: -0.85,
			maxLat: 0.85,
			minLon: -0.85,
			maxLon: 0.85,
		});
	});

	it('caps the widening at 2 deg (the proxy allows a 4 deg span)', () => {
		const box = nearestSearchBbox(78, 10);
		expect(box.minLon).toBe(8);
		expect(box.maxLon).toBe(12);
	});

	it('clamps to world bounds near the pole and the antimeridian', () => {
		const box = nearestSearchBbox(89.5, 179.8);
		expect(box.maxLat).toBe(90);
		expect(box.minLat).toBeCloseTo(88.65, 10);
		expect(box.maxLon).toBe(180);
		expect(box.minLon).toBeCloseTo(177.8, 10);
	});
});

describe('isMetarCapableIdent', () => {
	it('accepts 4-character letter-first station ids', () => {
		expect(isMetarCapableIdent('LFPO')).toBe(true);
		expect(isMetarCapableIdent('K1V4')).toBe(true);
	});

	it('rejects local codes that can never report', () => {
		expect(isMetarCapableIdent('FR-JCA')).toBe(false);
		expect(isMetarCapableIdent('AD-ALV')).toBe(false);
		expect(isMetarCapableIdent('LF5722')).toBe(false);
		expect(isMetarCapableIdent('07FA')).toBe(false);
	});
});

describe('qfuDeg', () => {
	it('reads the designator heading', () => {
		expect(qfuDeg('08L')).toBe(80);
		expect(qfuDeg('26')).toBe(260);
		expect(qfuDeg('36')).toBe(360);
		expect(qfuDeg('03')).toBe(30);
	});

	it('rejects non-runway ids', () => {
		expect(qfuDeg('H1')).toBeNull();
		expect(qfuDeg('')).toBeNull();
		expect(qfuDeg('00')).toBeNull();
	});
});

describe('windComponents', () => {
	// Toussus 250 deg true 7 kt, projected at the aerodrome; QFUs chosen so
	// the rounded pins hold for any plausible Paris declination (1-4 deg E).
	const YEAR = 2026.45;
	const at = (end: string) => windComponents(lfpn, end, lfpn.lat, lfpn.lon, YEAR);

	it('projects onto the into-wind runway end', () => {
		expect(at('25')).toEqual({ headwindKt: 7, tailwindKt: 0, crosswindKt: 0 });
	});

	it('flips to tailwind on the reciprocal end', () => {
		expect(at('07')).toEqual({ headwindKt: 0, tailwindKt: 7, crosswindKt: 0 });
	});

	it('goes full crosswind perpendicular to the wind', () => {
		expect(at('16')).toEqual({ headwindKt: 0, tailwindKt: 0, crosswindKt: 7 });
	});

	it('returns null for variable wind and bad QFUs, zeros for calm', () => {
		expect(windComponents({ wdir: 'VRB', wspd: 3 }, '25', lfpn.lat, lfpn.lon, YEAR)).toBeNull();
		expect(windComponents(lfpn, 'H1', lfpn.lat, lfpn.lon, YEAR)).toBeNull();
		expect(windComponents({ wdir: 0, wspd: 0 }, '25', lfpn.lat, lfpn.lon, YEAR)).toEqual({
			headwindKt: 0,
			tailwindKt: 0,
			crosswindKt: 0,
		});
	});
});

describe('precipSuggestsWet', () => {
	it('flags precipitation codes only', () => {
		expect(precipSuggestsWet('-SHRA')).toBe(true);
		expect(precipSuggestsWet('TSRA')).toBe(true);
		expect(precipSuggestsWet('DZ')).toBe(true);
		expect(precipSuggestsWet('BR')).toBe(false);
		expect(precipSuggestsWet('FG')).toBe(false);
		expect(precipSuggestsWet(undefined)).toBe(false);
	});
});

describe('formatters', () => {
	const W = en.weather.metar;
	it('wind', () => {
		expect(formatWind(lfpo, W)).toBe('240° 8 kt');
		expect(formatWind({ wdir: 240, wspd: 8, wgst: 18 }, W)).toBe('240° 8 kt gusting 18 kt');
		expect(formatWind({ wdir: 80, wspd: 5 }, W)).toBe('080° 5 kt');
		expect(formatWind({ wdir: 'VRB', wspd: 3 }, W)).toBe('VRB 3 kt');
		expect(formatWind({ wdir: 0, wspd: 0 }, W)).toBe('calm');
	});

	it('wind in French', () => {
		const F = fr.weather.metar;
		expect(formatWind({ wdir: 240, wspd: 8, wgst: 18 }, F)).toBe('240° 8 kt rafales 18 kt');
		expect(formatWind({ wdir: 0, wspd: 0 }, F)).toBe('calme');
	});

	it('visibility from the statute-mile buckets', () => {
		expect(formatVisib('6+', W)).toBe('10 km or more');
		expect(formatVisib('10+', W)).toBe('16 km or more');
		expect(formatVisib(6, W)).toBe('10 km');
		expect(formatVisib(3, W)).toBe('4800 m');
		expect(formatVisib(0.5, W)).toBe('800 m');
		expect(formatVisib(null, W)).toBeNull();
		expect(formatVisib('6+', fr.weather.metar)).toBe('10 km ou plus');
	});

	it('clouds, age, distance', () => {
		expect(formatClouds(kjfk.clouds)).toBe('FEW 5000 ft, SCT 19000 ft, BKN 25000 ft');
		expect(formatAge(25, W)).toBe('25 min ago');
		expect(formatAge(150, W)).toBe('2 h 30 ago');
		expect(formatAge(25, fr.weather.metar)).toBe('il y a 25 min');
		expect(formatAge(150, fr.weather.metar)).toBe('il y a 2 h 30');
		expect(formatDistanceNM(21_172)).toBe('11 NM');
	});
});

describe('splitRawTaf', () => {
	it('breaks before each change group', () => {
		expect(splitRawTaf(tafs[0].rawTAF)).toEqual([
			'TAF LFPG 111700Z 1118/1224 26011KT CAVOK TX20/1212Z TN14/1204Z',
			'BECMG 1202/1204 BKN012',
			'BECMG 1208/1211 BKN016',
		]);
	});

	it('keeps PROBxx with its TEMPO', () => {
		expect(splitRawTaf(lfpo.rawTaf!)).toEqual([
			'TAF LFPO 111700Z 1118/1224 25005KT 9999 FEW040',
			'PROB30 TEMPO 1202/1206 BKN014',
		]);
	});
});

describe('tafBlockText', () => {
	it('indents the continuation lines two spaces', () => {
		expect(tafBlockText(tafs[0].rawTAF)).toBe(
			'TAF LFPG 111700Z 1118/1224 26011KT CAVOK TX20/1212Z TN14/1204Z\n' +
				'  BECMG 1202/1204 BKN012\n' +
				'  BECMG 1208/1211 BKN016',
		);
	});
});

describe('flightCategory', () => {
	it('reads AWC\'s precomputed category from the fixture', () => {
		expect(flightCategory(lfpo)).toBe('VFR');
	});

	it('normalises absent or unrecognised values to null (never guesses)', () => {
		expect(flightCategory({})).toBeNull();
		expect(flightCategory({ fltCat: null })).toBeNull();
		expect(flightCategory({ fltCat: 'XXX' as never })).toBeNull();
	});
});

describe('stationName', () => {
	it('trims AWC\'s ", ID, CC" suffix', () => {
		expect(stationName('Toussus-Le-Noble, ID, FR')).toBe('Toussus-Le-Noble');
		expect(stationName('Paris-Orly')).toBe('Paris-Orly');
		expect(stationName(null)).toBe('');
	});
});

describe('present weather (parseWeather / formatWeather)', () => {
	it('parses intensity, descriptor and phenomena', () => {
		expect(parseWeather('-RA BR')).toEqual([
			{ intensity: '-', descriptor: '', phenomena: ['RA'], raw: '-RA' },
			{ intensity: '', descriptor: '', phenomena: ['BR'], raw: 'BR' },
		]);
		expect(parseWeather('+TSRA')).toEqual([
			{ intensity: '+', descriptor: 'TS', phenomena: ['RA'], raw: '+TSRA' },
		]);
		expect(parseWeather('VCSH')).toEqual([
			{ intensity: 'VC', descriptor: 'SH', phenomena: [], raw: 'VCSH' },
		]);
	});

	it('decodes to English', () => {
		expect(formatWeather('-RA BR', en.weather.wx)).toBe('light rain, mist');
		expect(formatWeather('+TSRA', en.weather.wx)).toBe('thunderstorm with heavy rain');
		expect(formatWeather('SHRA', en.weather.wx)).toBe('rain showers');
		expect(formatWeather('FZFG', en.weather.wx)).toBe('freezing fog');
		expect(formatWeather('BLSN', en.weather.wx)).toBe('blowing snow');
		expect(formatWeather('MIFG', en.weather.wx)).toBe('shallow fog');
		expect(formatWeather('VCSH', en.weather.wx)).toBe('showers in the vicinity');
		expect(formatWeather('+FC', en.weather.wx)).toBe('tornado or waterspout');
	});

	it('decodes to French', () => {
		expect(formatWeather('-RA BR', fr.weather.wx)).toBe('pluie faible, brume');
		expect(formatWeather('+TSRA', fr.weather.wx)).toBe('orage avec pluie intense');
		expect(formatWeather('SHRA', fr.weather.wx)).toBe('averse de pluie');
		expect(formatWeather('FZFG', fr.weather.wx)).toBe('brouillard givrant');
		expect(formatWeather('BLSN', fr.weather.wx)).toBe('chasse-neige élevée');
		expect(formatWeather('MIFG', fr.weather.wx)).toBe('brouillard mince');
		expect(formatWeather('VCSH', fr.weather.wx)).toBe('averses à proximité');
		expect(formatWeather('+FC', fr.weather.wx)).toBe('tornade ou trombe marine');
	});

	it('returns null for empty input and surfaces unknown tokens raw', () => {
		expect(formatWeather('', en.weather.wx)).toBeNull();
		expect(formatWeather(null, en.weather.wx)).toBeNull();
		expect(formatWeather('XYZ', en.weather.wx)).toBe('XYZ');
	});
});
