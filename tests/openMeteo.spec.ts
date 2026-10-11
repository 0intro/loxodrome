import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	FORECAST_BASE,
	HISTORICAL_BASE,
	NO_PRESSURE_WIND_MODELS,
	WIND_MODELS,
	FORECAST_MAX_AHEAD_DAYS,
	OpenMeteoError,
	bracketLevelsHpa,
	columnsProvenance,
	IFS_LEVELS,
	NWP_DIR_NAMES,
	NWP_MEMBERS,
	OM_LEVELS,
	polledRunsAt,
	ladderTopM,
	buildForecastUrl,
	cloudAmountLabel,
	cloudCoverProfileAt,
	cloudOktas,
	columnReachMs,
	fetchWindColumns,
	forecastBaseFor,
	forecastRangeEndMs,
	freezingLevelAt,
	freezingLevelFt,
	gridDegAt,
	fmtIsaDev,
	hourlyVariables,
	isaTempC,
	isobarLevels,
	sampleMslpAt,
	normalizeForecast,
	openMeteoFallbackModel,
	openMeteoTwin,
	parseRunMeta,
	requestWeight,
	resolveAutoModel,
	sampleSurfaceAt,
	sampleWindAt,
	uvToWind,
	windModel,
	windToUV,
	type WindColumn,
} from '$lib/weather/openMeteo';
import { isaPressureAltFt } from '$lib/weather/qnh';
import { NWP_SERVICE } from '$lib/net/endpoints';

/* Recorded 2026-07-03 from the live API (meteofrance_seamless, forecast_hours=3,
 * kn / unixtime): Paris plus an Alps grid cell whose 925 and 850 hPa surfaces
 * both resolve BELOW the cell ground (elevation 1987 m), the extrapolation
 * case the sampler must refuse. Trimmed to the fields the client reads. */
const PARIS = {
	latitude: 48.85,
	longitude: 2.3499994,
	utc_offset_seconds: 0,
	elevation: 46.0,
	hourly_units: { time: 'unixtime', wind_speed_925hPa: 'kn' },
	hourly: {
		time: [1783083600, 1783087200, 1783090800],
		wind_speed_925hPa: [7.3, 7.7, 9.2],
		wind_direction_925hPa: [343, 335, 330],
		geopotential_height_925hPa: [901.0, 900.0, 899.0],
		temperature_925hPa: [17.0, 17.7, 18.2],
		wind_speed_850hPa: [6.6, 6.9, 8.1],
		wind_direction_850hPa: [345, 339, 331],
		geopotential_height_850hPa: [1614.0, 1614.0, 1615.0],
		wind_speed_10m: [5.5, 6.3, 6.5],
		wind_direction_10m: [328, 324, 337],
	},
};
const ALPS = {
	latitude: 45.3,
	longitude: 6.799999,
	elevation: 1987.0,
	location_id: 1,
	hourly: {
		time: [1783083600, 1783087200, 1783090800],
		wind_speed_925hPa: [4.0, 4.1, 3.1],
		wind_direction_925hPa: [135, 133, 135],
		geopotential_height_925hPa: [863.0, 863.0, 862.0],
		wind_speed_850hPa: [3.8, 4.0, 3.0],
		wind_direction_850hPa: [135, 133, 132],
		geopotential_height_850hPa: [1580.0, 1581.0, 1580.0],
		wind_speed_10m: [5.4, 3.5, 3.7],
		wind_direction_10m: [145, 146, 155],
	},
};
const T0 = 1783083600_000;
const HOUR = 3600_000;

const M_TO_FT = 1 / 0.3048;

describe('normalizeForecast', () => {
	it('decodes a multi-location array, tolerating extra fields', () => {
		const cols = normalizeForecast([PARIS, ALPS]);
		expect(cols).toHaveLength(2);
		expect(cols[0].elevationM).toBe(46);
		expect(cols[1].elevationM).toBe(1987);
		expect(cols[0].timesMs[0]).toBe(T0);
		expect(cols[0].hourly.wind_speed_925hPa?.[2]).toBe(9.2);
	});

	it('decodes the bare single-location object', () => {
		const cols = normalizeForecast(PARIS);
		expect(cols).toHaveLength(1);
		expect(cols[0].lat).toBe(48.85);
	});

	it('drops entries without hourly data', () => {
		expect(normalizeForecast([{ latitude: 1 }, PARIS])).toHaveLength(1);
	});

	it('degrades a null / primitive body to an empty decode, not a TypeError', () => {
		// fetchWindColumns nulls an unreadable 200 body before calling this.
		expect(normalizeForecast(null)).toEqual([]);
		expect(normalizeForecast('bad gateway')).toEqual([]);
		expect(normalizeForecast([null, PARIS])).toHaveLength(1);
	});
});

describe('wind vector components', () => {
	it('round-trips direction and speed', () => {
		const { u, v } = windToUV(90, 10);
		expect(u).toBeCloseTo(-10, 6);
		expect(v).toBeCloseTo(0, 6);
		const back = uvToWind(u, v);
		expect(back.dirFromDeg).toBeCloseTo(90, 6);
		expect(back.speedKt).toBeCloseTo(10, 6);
	});

	it('averages 350 and 010 through north, never south', () => {
		const a = windToUV(350, 10);
		const b = windToUV(10, 10);
		const mid = uvToWind((a.u + b.u) / 2, (a.v + b.v) / 2);
		expect(mid.dirFromDeg).toBeCloseTo(0, 6);
		expect(mid.speedKt).toBeCloseTo(10 * Math.cos((10 * Math.PI) / 180), 6);
	});

	it('reports calm as 0/0', () => {
		expect(uvToWind(0, 0)).toEqual({ dirFromDeg: 0, speedKt: 0 });
	});
});

describe('sampleWindAt', () => {
	const paris = normalizeForecast([PARIS])[0];
	const alps = normalizeForecast([PARIS, ALPS])[1];

	it('returns the level values at an exact level height and hour', () => {
		const s = sampleWindAt(paris, 901 * M_TO_FT, T0);
		expect(s).not.toBeNull();
		expect(s!.dirTrueDeg).toBeCloseTo(343, 3);
		expect(s!.speedKt).toBeCloseTo(7.3, 3);
		expect(s!.tempC).toBeCloseTo(17.0, 3);
		expect(s!.belowGround).toBe(false);
	});

	it('interpolates u/v between bracketing levels', () => {
		const midHM = (901 + 1614) / 2;
		const s = sampleWindAt(paris, midHM * M_TO_FT, T0);
		const a = windToUV(343, 7.3);
		const b = windToUV(345, 6.6);
		const want = uvToWind((a.u + b.u) / 2, (a.v + b.v) / 2);
		expect(s!.dirTrueDeg).toBeCloseTo(want.dirFromDeg, 3);
		expect(s!.speedKt).toBeCloseTo(want.speedKt, 3);
	});

	it('interpolates linearly between forecast hours', () => {
		const col: WindColumn = {
			lat: 0,
			lon: 0,
			elevationM: 0,
			timesMs: [0, HOUR],
			hourly: {
				geopotential_height_925hPa: [1000, 1000],
				wind_speed_925hPa: [10, 20],
				wind_direction_925hPa: [90, 90],
				wind_speed_10m: [5, 5],
				wind_direction_10m: [90, 90],
			},
		};
		const s = sampleWindAt(col, 1000 * M_TO_FT, HOUR / 2);
		expect(s!.speedKt).toBeCloseTo(15, 6);
		expect(s!.dirTrueDeg).toBeCloseTo(90, 6);
	});

	it('refuses underground extrapolations: below-ground targets get the 10 m wind', () => {
		const s = sampleWindAt(alps, 2500, T0);
		expect(s!.belowGround).toBe(true);
		expect(s!.speedKt).toBeCloseTo(5.4, 3);
		expect(s!.dirTrueDeg).toBeCloseTo(145, 3);
	});

	it('clamps to the 10 m wind when every pressure surface is underground', () => {
		const s = sampleWindAt(alps, 8000, T0);
		expect(s!.belowGround).toBe(false);
		expect(s!.speedKt).toBeCloseTo(5.4, 3);
	});

	it('flags a target above the pressure ladder aboveTop (the belowGround twin)', () => {
		// PARIS ladder tops at 850 hPa (~1614 m): 10 000 ft is above it, the
		// clamped top-level wind must arrive flagged; an in-ladder target not.
		const above = sampleWindAt(paris, 10000, T0);
		expect(above!.aboveTop).toBe(true);
		expect(above!.speedKt).toBeCloseTo(6.6, 3);
		const inside = sampleWindAt(paris, 901 * M_TO_FT, T0);
		expect(inside!.aboveTop).toBe(false);
		expect(inside!.belowGround).toBe(false);
	});

	it('returns null outside the fetched window', () => {
		expect(sampleWindAt(paris, 2500, T0 - 1)).toBeNull();
		expect(sampleWindAt(paris, 2500, T0 + 2 * HOUR + 1)).toBeNull();
	});
});

describe('sampleSurfaceAt', () => {
	it('interpolates the 10 m wind and passes gusts through', () => {
		const col: WindColumn = {
			lat: 0,
			lon: 0,
			elevationM: 0,
			timesMs: [0, HOUR],
			hourly: {
				wind_speed_10m: [10, 20],
				wind_direction_10m: [180, 180],
				wind_gusts_10m: [20, 40],
				temperature_2m: [10, 12],
			},
		};
		const s = sampleSurfaceAt(col, HOUR / 2);
		expect(s!.speedKt).toBeCloseTo(15, 6);
		expect(s!.dirTrueDeg).toBeCloseTo(180, 6);
		expect(s!.gustKt).toBeCloseTo(30, 6);
		expect(s!.tempC).toBeCloseTo(11, 6);
	});
});

describe('model registry', () => {
	it('lists unique models that all serve pressure levels', () => {
		const ids = WIND_MODELS.map((m) => m.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const m of WIND_MODELS) {
			expect(m.levelsHpa.length).toBeGreaterThan(0);
			expect(NO_PRESSURE_WIND_MODELS).not.toContain(m.id);
		}
	});

	it('makes Auto our chain everywhere, failing over to the regional Open-Meteo model', () => {
		for (const [lat, lon] of [[48.85, 2.35], [51.5, -0.12], [39.7, -104.9], [35.6, 139.7]]) {
			expect(resolveAutoModel(lat, lon)).toBe('auto_chain');
		}
		expect(openMeteoFallbackModel(48.85, 2.35)).toBe('meteofrance_seamless');
		expect(openMeteoFallbackModel(51.5, -0.12)).toBe('meteofrance_seamless');
		expect(openMeteoFallbackModel(39.7, -104.9)).toBe('ecmwf_ifs025');
		expect(openMeteoFallbackModel(35.6, 139.7)).toBe('ecmwf_ifs025');
		expect(openMeteoTwin('auto_chain', 35.6, 139.7)).toBe('ecmwf_ifs025');
		expect(openMeteoTwin('arome_france', 35.6, 139.7)).toBe('arome_france');
		// Past Météo-France's reach Open-Meteo pads its hours with nulls:
		// a window starting there is asked of IFS, the chain's own last member.
		const H = 3600_000;
		expect(openMeteoFallbackModel(48.85, 2.35, 90 * H)).toBe('meteofrance_seamless');
		expect(openMeteoFallbackModel(48.85, 2.35, 91 * H)).toBe('ecmwf_ifs025');
		expect(openMeteoTwin('auto_chain', 48.85, 2.35, 120 * H)).toBe('ecmwf_ifs025');
		// The Météo-France pick stays Météo-France's, ending where it ends.
		expect(openMeteoTwin('meteofrance_seamless', 48.85, 2.35, 120 * H)).toBe('meteofrance_seamless');
		// The chain is Auto itself, never offered twice in the picker.
		expect(windModel('auto_chain').listed).toBe(false);
		expect(WIND_MODELS.filter((m) => m.transport === 'nwp').map((m) => m.id)).toEqual([
			'auto_chain',
			'meteofrance_seamless',
			'arome_france',
			'arpege_europe',
			'ecmwf_ifs025',
		]);
	});

	it('clamps the chain lattice to the member under the view', () => {
		const chain = windModel('auto_chain');
		expect(gridDegAt(chain, 48.85, 2.35)).toBe(0.025);
		expect(gridDegAt(chain, 60.2, -1.2)).toBe(0.1);
		expect(gridDegAt(chain, 39.7, -104.9)).toBe(0.25);
		expect(gridDegAt(windModel('icon_seamless'), 48.85, 2.35)).toBe(0.0625);
		// Past AROME's reach the hour shown is ARPEGE's, past ARPEGE's IFS's.
		const H = 3600_000;
		expect(gridDegAt(chain, 48.85, 2.35, 30 * H)).toBe(0.025);
		expect(gridDegAt(chain, 48.85, 2.35, 60 * H)).toBe(0.1);
		expect(gridDegAt(chain, 48.85, 2.35, 120 * H)).toBe(0.25);
		expect(gridDegAt(windModel('meteofrance_seamless'), 48.85, 2.35, 60 * H)).toBe(0.1);
		expect(gridDegAt(windModel('meteofrance_seamless'), 48.85, 2.35)).toBe(0.025);
		expect(gridDegAt(windModel('meteofrance_seamless'), 39.7, -104.9)).toBe(0.25);
		// AROME-OM over five overseas territories, while its newest run
		// reaches the hour (33 h at worst): Fort-de-France, Cayenne,
		// Saint-Denis de la Réunion, Nouméa, Papeete (west of 180, or east).
		for (const [lat, lon] of [
			[14.59, -61.0],
			[4.82, -52.36],
			[-20.89, 55.52],
			[-22.01, 166.21],
			[-17.56, -149.61],
			[-17.56, 210.39],
		]) {
			expect(gridDegAt(chain, lat, lon)).toBe(0.025);
			expect(gridDegAt(chain, lat, lon, 30 * H)).toBe(0.025);
			expect(gridDegAt(chain, lat, lon, 34 * H)).toBe(0.25);
			// The Météo-France pick keeps its two: Open-Meteo's ARPEGE World there.
			expect(gridDegAt(windModel('meteofrance_seamless'), lat, lon)).toBe(0.25);
		}
		// Wallis lies in no domain.
		expect(gridDegAt(chain, -13.24, -176.2)).toBe(0.25);
	});

	it('keeps the reduced ECMWF ladder', () => {
		const vars = hourlyVariables(windModel('ecmwf_ifs025'), {});
		expect(vars).toContain('wind_speed_925hPa');
		expect(vars).not.toContain('wind_speed_975hPa');
	});

	it('brackets a target altitude with two levels each side', () => {
		// Our Météo-France ladder, to 300 hPa with the 750 / 650 / 550 levels.
		const mf = windModel('meteofrance_seamless');
		expect(bracketLevelsHpa(mf, 2500)).toEqual([1000, 950, 925, 900]);
		expect(bracketLevelsHpa(mf, 500)).toEqual([1000, 950, 925]);
		expect(bracketLevelsHpa(mf, 10_000)).toEqual([750, 700, 650, 600]);
		expect(bracketLevelsHpa(mf, 30_000)).toEqual([400, 350, 300]);
		expect(bracketLevelsHpa(mf, 60_000)).toEqual([350, 300]);
		expect(bracketLevelsHpa(windModel('ecmwf_ifs025'), 2500)).toEqual([1000, 925, 850]);
		// Open-Meteo's own ladder, for the models only it serves.
		const om = windModel('ukmo_seamless');
		expect(bracketLevelsHpa(om, 2500)).toEqual([975, 950, 925, 900]);
		expect(bracketLevelsHpa(om, 10_000)).toEqual([800, 700, 600, 500]);
	});

	it("knows how high each model's ladder reaches", () => {
		// 300 hPa for ours, 500 hPa for Open-Meteo's own ladder.
		expect(ladderTopM(windModel('auto_chain'))).toBeGreaterThan(9000);
		expect(ladderTopM(windModel('ukmo_seamless'))).toBeLessThan(6000);
	});

	it("brackets the chain on every member's ladder, so a point IFS serves keeps two levels each side", () => {
		const chain = windModel('auto_chain');
		// 5 000 ft: Météo-France's 900 / 850 / 800 / 750, and IFS's 925 / 850
		// / 700 / 600, of which IFS would hold 850 alone on the first.
		const five = bracketLevelsHpa(chain, 5000);
		expect(five).toEqual([925, 900, 850, 800, 750, 700, 600]);
		const ifs = five.filter((l) => (IFS_LEVELS as readonly number[]).includes(l));
		expect(ifs).toEqual([925, 850, 700, 600]);
		expect(bracketLevelsHpa(chain, 2500)).toEqual([1000, 950, 925, 900, 850]);
		// 10 000 ft: AROME-OM, with no 750 or 650, takes 800 to bracket.
		const ten = bracketLevelsHpa(chain, 10_000);
		expect(ten).toEqual([850, 800, 750, 700, 650, 600, 500]);
		expect(ten.filter((l) => (OM_LEVELS as readonly number[]).includes(l))).toEqual([850, 800, 700, 600, 500]);
	});

	it('honours a fetch-level subset (the lattice weight cut)', () => {
		const spec = windModel('meteofrance_seamless');
		const vars = hourlyVariables(spec, { levelsHpa: [950, 925] });
		expect(vars).toContain('wind_speed_925hPa');
		expect(vars).not.toContain('wind_speed_850hPa');
		// Surface mode requests no pressure levels at all.
		expect(hourlyVariables(spec, { levelsHpa: [], surface: true })).toEqual([
			'wind_speed_10m',
			'wind_direction_10m',
			'wind_gusts_10m',
			'temperature_2m',
		]);
	});
});

describe('the run directories', () => {
	it('name the display run among the directories each model is refreshed by', () => {
		for (const m of WIND_MODELS) {
			const dirs = m.runDirs.flat();
			expect(new Set(dirs).size).toBe(dirs.length);
			if (m.metaDir) {
				expect(dirs).toContain(m.metaDir);
			}
		}
		// AROME's 3-hourly runs refresh the seamless model, not ARPEGE's alone;
		// the chain's three members are three cycles of their own.
		expect(windModel('meteofrance_seamless').runDirs).toEqual([['arome0025'], ['arpege01']]);
		expect(windModel('auto_chain').runDirs).toEqual([
			['arome0025'],
			['aromeomantil'],
			['aromeomguyane'],
			['aromeomindien'],
			['aromeomncaled'],
			['aromeompolyn'],
			['arpege01'],
			['ifs025'],
		]);
		expect(windModel('best_match').runDirs).toEqual([]);
	});

	it('are named per model, the five AROME-OM domains as one', () => {
		const col = (runs: Record<string, number>): WindColumn => ({ lat: 0, lon: 0, elevationM: 0, timesMs: [], hourly: {}, source: 'nwp', runs });
		const R = Date.UTC(2026, 9, 8, 0);
		// A route from Guadeloupe to Cayenne spans two domains of one run.
		const prov = columnsProvenance([col({ aromeomantil: R, ifs025: R }), col({ aromeomguyane: R, ifs025: R })]);
		expect(prov.runs.map((r) => `${r.name} ${r.runMs}`)).toEqual([`AROME-OM ${R}`, `IFS ${R}`]);
		expect(NWP_DIR_NAMES.aromeompolyn).toBe('AROME-OM');
	});

	it('name the runs polled for the members whose grid holds the view', () => {
		const H = 3600_000;
		const R = Date.UTC(2026, 9, 8, 0);
		const byDir = { arome0025: R + 3 * H, aromeomantil: R, aromeomguyane: R, aromeomindien: R - 6 * H, arpege01: R, ifs025: R - 6 * H };
		const dirs = windModel('auto_chain').runDirs.flat();
		expect(polledRunsAt(dirs, byDir, 14.6, -61)).toEqual([
			{ name: 'AROME-OM', ms: R },
			{ name: 'IFS', ms: R - 6 * H },
		]);
		expect(polledRunsAt(dirs, byDir, 48.85, 2.35).map((r) => r.name)).toEqual(['AROME', 'ARPEGE', 'IFS']);
		expect(polledRunsAt(dirs, byDir, 39.7, -104.9).map((r) => r.name)).toEqual(['IFS']);
	});

	it('state each member’s grid as the service does (loxodrome-nwp models.json)', () => {
		const models = JSON.parse(readFileSync(new URL('../loxodrome-nwp/test/fixtures/models.json', import.meta.url), 'utf8')) as {
			id: string;
			grid: { ni: number; nj: number; northE6: number; westE6: number; diE6: number; djE6: number; wraps: boolean };
		}[];
		expect(NWP_MEMBERS.map((m) => m.dir)).toEqual(models.map((m) => m.id));
		for (const m of NWP_MEMBERS) {
			const g = models.find((x) => x.id === m.dir)!.grid;
			expect(m.stepDeg, m.dir).toBe(g.diE6 / 1e6);
			if (g.wraps) {
				expect(m.box, m.dir).toBeNull();
				continue;
			}
			expect(m.box, m.dir).toEqual({
				south: (g.northE6 - (g.nj - 1) * g.djE6) / 1e6,
				west: g.westE6 / 1e6,
				north: g.northE6 / 1e6,
				east: (g.westE6 + (g.ni - 1) * g.diE6) / 1e6,
			});
		}
	});

	it('read a latitude/longitude grid’s extent, and no other', () => {
		const geog = parseRunMeta({
			last_run_initialisation_time: 1790521200,
			update_interval_seconds: 10800,
			crs_wkt: 'GEOGCRS["WGS 84",\n    USAGE[\n        SCOPE["grid"],\n        BBOX[37.5,-12.0,55.4,16.0]]]',
		});
		expect(geog).toEqual({ initMs: 1790521200_000, bbox: [37.5, -12, 55.4, 16], intervalMs: 10_800_000 });
		// A projected grid's BBOX is its corners, not its outline (HRRR).
		const proj = parseRunMeta({
			last_run_initialisation_time: 1790521200,
			crs_wkt: 'PROJCRS["Lambert",USAGE[SCOPE["grid"],BBOX[21.14,-122.72,47.84,-60.92]]]',
		});
		expect(proj).toEqual({ initMs: 1790521200_000, bbox: null, intervalMs: null });
		// A global grid holds every point.
		expect(
			parseRunMeta({ last_run_initialisation_time: 1, crs_wkt: 'GEOGCRS[USAGE[BBOX[-90.0,-180.0,90.0,179.75]]]' })?.bbox,
		).toBeNull();
		expect(parseRunMeta({ crs_wkt: 'GEOGCRS' })).toBeNull();
		expect(parseRunMeta(null)).toBeNull();
	});
});

describe('the request budget', () => {
	it('weighs a request as Open-Meteo does', () => {
		// The map lattice: 126 points x 14 variables.
		expect(requestWeight(126, 14, 1)).toBeCloseTo(176.4, 9);
		// Under ten variables a location still costs one call.
		expect(requestWeight(5, 3, 1)).toBe(5);
		// Hours cost nothing until two weeks; four weeks double it.
		expect(requestWeight(1, 20, 14)).toBe(2);
		expect(requestWeight(1, 20, 28)).toBe(4);
	});

	it('counts the variables each route tier asks for', () => {
		const mf = windModel('meteofrance_seamless');
		const ec = windModel('ecmwf_ifs025');
		const om = windModel('ukmo_seamless');
		// The winds with temperatures: the full ladder, and the 10 m wind:
		// our 16 Météo-France levels, IFS's 8, Open-Meteo's 10.
		expect(hourlyVariables(mf, { temps: true })).toHaveLength(66);
		expect(hourlyVariables(windModel('auto_chain'), { temps: true })).toHaveLength(66);
		expect(hourlyVariables(ec, { temps: true })).toHaveLength(34);
		expect(hourlyVariables(om, { temps: true })).toHaveLength(42);
		// The clouds alone: each level's height and cover, no wind at all.
		const clouds = hourlyVariables(mf, { winds: false, clouds: true });
		expect(clouds).toHaveLength(32);
		expect(clouds.some((v) => v.startsWith('wind_'))).toBe(false);
		expect(clouds).toContain('geopotential_height_850hPa');
		expect(clouds).toContain('cloud_cover_300hPa');
		expect(hourlyVariables(ec, { winds: false, clouds: true })).toHaveLength(16);
		expect(hourlyVariables(om, { winds: false, clouds: true })).toHaveLength(20);
	});
});

describe('buildForecastUrl', () => {
	const points = [{ lat: 48.85, lon: 2.35 }];
	const base = { model: 'meteofrance_seamless' as const, startMs: T0, endMs: T0 + HOUR, nowMs: T0 };

	it('asks our service for a model of ours, Open-Meteo for the others', () => {
		expect(buildForecastUrl(points, base).startsWith(`${NWP_SERVICE}/v1/forecast?`)).toBe(true);
		expect(buildForecastUrl(points, base, 'open-meteo').startsWith(FORECAST_BASE)).toBe(true);
		expect(buildForecastUrl(points, { ...base, model: 'gfs_seamless' }).startsWith(FORECAST_BASE)).toBe(true);
	});

	it('requests knots, unixtime and the hour window', () => {
		const url = buildForecastUrl(points, base, 'open-meteo');
		expect(url.startsWith(FORECAST_BASE)).toBe(true);
		expect(url).toContain('models=meteofrance_seamless');
		expect(url).toContain('wind_speed_unit=kn');
		expect(url).toContain('timeformat=unixtime');
		expect(url).toContain('wind_speed_925hPa');
		expect(url).toContain('geopotential_height_500hPa');
		expect(url).toContain('wind_speed_10m');
		expect(url).toMatch(/start_hour=\d{4}-\d{2}-\d{2}T\d{2}%3A00/);
	});

	it('adds temperatures and surface extras only when asked', () => {
		expect(buildForecastUrl(points, base)).not.toContain('temperature_925hPa');
		expect(buildForecastUrl(points, { ...base, temps: true })).toContain('temperature_925hPa');
		const surf = buildForecastUrl(points, { ...base, surface: true });
		expect(surf).toContain('wind_gusts_10m');
		expect(surf).toContain('temperature_2m');
	});

	it('adds per-level cloud cover only when flagged (the route fetch)', () => {
		expect(buildForecastUrl(points, base)).not.toContain('cloud_cover_925hPa');
		expect(buildForecastUrl(points, { ...base, clouds: true })).toContain('cloud_cover_925hPa');
	});

	it('batches locations as comma lists', () => {
		const url = buildForecastUrl([{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }], base);
		expect(url).toContain('latitude=1.0000%2C3.0000');
		expect(url).toContain('longitude=2.0000%2C4.0000');
	});

	it('swaps to the historical endpoint deep in the past', () => {
		const now = T0;
		expect(forecastBaseFor(now - 100 * 24 * HOUR, now)).toBe(HISTORICAL_BASE);
		expect(forecastBaseFor(now - 2 * 24 * HOUR, now)).toBe(FORECAST_BASE);
	});
});

describe('columnReachMs', () => {
	/* Live-verified 2026-08-21: past a model's own horizon the API answers
	   HTTP 200 with the hour PRESENT and every value null (meteofrance_seamless
	   at +136 h), so the time array alone never says how far it reaches. */
	const col = (speeds: (number | null)[]): WindColumn => ({
		lat: 0,
		lon: 0,
		elevationM: 0,
		timesMs: speeds.map((_, i) => i * HOUR),
		hourly: {
			geopotential_height_925hPa: speeds.map(() => 800),
			wind_speed_925hPa: speeds,
			wind_direction_925hPa: speeds.map((v) => (v == null ? null : 270)),
		},
	});

	it('reports the last hour a full column carries', () => {
		expect(columnReachMs(col([10, 11, 12]))).toBe(2 * HOUR);
	});

	it('stops at the last covered hour of a null-padded tail', () => {
		expect(columnReachMs(col([10, 11, null, null]))).toBe(HOUR);
	});

	it('is null when the model covers none of the window', () => {
		expect(columnReachMs(col([null, null]))).toBeNull();
		expect(columnReachMs(col([]))).toBeNull();
	});

	it('counts the 10 m wind alone as reach (a ladder-less hour)', () => {
		const surface: WindColumn = {
			lat: 0,
			lon: 0,
			elevationM: 0,
			timesMs: [0, HOUR],
			hourly: { wind_speed_10m: [null, 8], wind_direction_10m: [null, 270] },
		};
		expect(columnReachMs(surface)).toBe(HOUR);
	});
});

describe('forecast range', () => {
	/* Live-verified 2026-08-21 (from that day): start_hour 2026-09-05T23:00
	   answers, 2026-09-06T00:00 answers "Parameter 'start_hour' is out of
	   allowed range from 2026-05-20 to 2026-09-05". The ceiling is stated in
	   whole UTC dates and includes its last one. */
	it('ends at 23:00 UTC on the fifteenth day ahead', () => {
		expect(FORECAST_MAX_AHEAD_DAYS).toBe(15);
		const now = Date.UTC(2026, 7, 21, 19, 58);
		expect(forecastRangeEndMs(now)).toBe(Date.UTC(2026, 8, 5, 23));
		expect(forecastRangeEndMs(now)).toBeLessThan(Date.UTC(2026, 8, 6));
	});

	it('moves with the day, not with the hour', () => {
		expect(forecastRangeEndMs(Date.UTC(2026, 7, 21, 0, 1))).toBe(
			forecastRangeEndMs(Date.UTC(2026, 7, 21, 23, 59)),
		);
	});
});

describe('fetchWindColumns error classification', () => {
	/* The endpoint meters four windows and names the refused one in the
	   reason; the day and month ones outlast any backoff, so they are a state
	   to report rather than a wait to sit through. Bodies as seen live
	   (2026-08-21, the daily one) and as documented for the rest. */
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const failWith = (reason: string, status = 400): void => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve(
					new Response(JSON.stringify({ error: true, reason }), {
						status,
						headers: { 'content-type': 'application/json' },
					}),
				),
			),
		);
	};
	// A model Open-Meteo serves itself: our service's classification has
	// specs of its own (nwpTransport.spec.ts).
	const opts = { model: 'gfs_seamless' as const, startMs: T0, endMs: T0 + HOUR, nowMs: T0 };
	const caught = async (): Promise<OpenMeteoError> => {
		try {
			await fetchWindColumns([{ lat: 48, lon: 2 }], opts);
		} catch (err) {
			return err as OpenMeteoError;
		}
		throw new Error('expected a rejection');
	};

	it('marks the daily budget spent, not merely rate limited', async () => {
		failWith('Daily API request limit exceeded. Please try again tomorrow.');
		const err = await caught();
		expect(err.rateLimited).toBe(true);
		expect(err.quotaExhausted).toBe(true);
		expect(err.outOfRange).toBe(false);
	});

	it('marks the monthly budget the same way', async () => {
		failWith('Monthly API request limit exceeded. Please try again next month.');
		expect((await caught()).quotaExhausted).toBe(true);
	});

	it('leaves the minute and hour windows outwaitable', async () => {
		failWith('Minutely API request limit exceeded. Please try again in one minute.');
		const err = await caught();
		expect(err.rateLimited).toBe(true);
		expect(err.quotaExhausted).toBe(false);
	});

	it('flags the refused window, which no retry heals', async () => {
		failWith("Parameter 'start_hour' is out of allowed range from 2026-05-20 to 2026-09-05");
		const err = await caught();
		expect(err.outOfRange).toBe(true);
		expect(err.rateLimited).toBe(false);
	});

	it('leaves an ordinary failure unflagged', async () => {
		failWith('Internal error', 500);
		const err = await caught();
		expect(err.rateLimited).toBe(false);
		expect(err.quotaExhausted).toBe(false);
		expect(err.outOfRange).toBe(false);
	});
});

describe('MSLP isobars', () => {
	it('requests pressure_msl only when flagged', () => {
		const spec = windModel('meteofrance_seamless');
		expect(hourlyVariables(spec, { levelsHpa: [925] })).not.toContain('pressure_msl');
		expect(hourlyVariables(spec, { levelsHpa: [925], mslp: true })).toContain('pressure_msl');
	});

	it('hour-interpolates the pressure and nulls without the field', () => {
		const col: WindColumn = {
			lat: 0,
			lon: 0,
			elevationM: 0,
			timesMs: [0, HOUR],
			hourly: { pressure_msl: [1010, 1014] },
		};
		expect(sampleMslpAt(col, HOUR / 2)).toBeCloseTo(1012, 6);
		expect(sampleMslpAt(col, -1)).toBeNull();
		expect(sampleMslpAt({ ...col, hourly: {} }, 0)).toBeNull();
	});

	it('enumerates 4 hPa multiples inside the span, capped', () => {
		expect(isobarLevels(1009.5, 1022)).toEqual([1012, 1016, 1020]);
		expect(isobarLevels(1012.2, 1013.1)).toEqual([]);
		expect(isobarLevels(1000, 1001, 4)).toEqual([1000]);
		expect(isobarLevels(0, 1000, 4, 5)).toHaveLength(5);
		expect(isobarLevels(Number.NaN, 1020)).toEqual([]);
	});
});

describe('freezingLevelFt', () => {
	const col = (t925: number[], t850: number[]): WindColumn => ({
		lat: 0,
		lon: 0,
		elevationM: 0,
		timesMs: [0, HOUR],
		hourly: {
			geopotential_height_925hPa: [800, 800],
			wind_speed_925hPa: [10, 10],
			wind_direction_925hPa: [90, 90],
			temperature_925hPa: t925,
			geopotential_height_850hPa: [1500, 1500],
			wind_speed_850hPa: [10, 10],
			wind_direction_850hPa: [90, 90],
			temperature_850hPa: t850,
			// The 10 m surface entry carries no temperature on route fetches;
			// the scan must skip it rather than read a null crossing.
			wind_speed_10m: [5, 5],
			wind_direction_10m: [90, 90],
		},
	});

	it('interpolates the lowest 0 degC crossing between levels', () => {
		// +4 at 800 m and -3 at 1500 m cross at 800 + (4/7) * 700 = 1200 m.
		expect(freezingLevelFt(col([4, 4], [-3, -3]), 0)).toBeCloseTo(1200 / 0.3048, 3);
	});

	it('clamps sub-zero columns to the lowest measured level, nulls all-warm ones', () => {
		expect(freezingLevelFt(col([-1, -1], [-5, -5]), 0)).toBeCloseTo(800 / 0.3048, 3);
		expect(freezingLevelFt(col([4, 4], [1, 1]), 0)).toBeNull();
	});

	it('interpolates between the bracketing hours', () => {
		// Hour 0 crosses at 1200 m, hour 1 at 800 + (1/7) * 700 = 900 m.
		expect(freezingLevelFt(col([4, 1], [-3, -6]), HOUR / 2)).toBeCloseTo(1050 / 0.3048, 3);
	});

	it('returns null outside the fetched window', () => {
		expect(freezingLevelFt(col([4, 4], [-3, -3]), -1)).toBeNull();
	});

	it('says when the lowest level is already freezing: the level is there or lower', () => {
		// Route fetches carry no 2 m temperature: below the lowest level
		// that has one, the column is unknown down to the ground.
		expect(freezingLevelAt(col([-1, -1], [-5, -5]), 0)).toEqual({ ft: 800 / 0.3048, atOrBelow: true });
		expect(freezingLevelAt(col([4, 4], [-3, -3]), 0)?.atOrBelow).toBe(false);
		expect(freezingLevelAt(col([4, 4], [1, 1]), 0)).toBeNull();
	});

	it('keeps the bound between two hours when either one is at or below', () => {
		// Hour 0 crosses at 1200 m, hour 1 is freezing at its 800 m level.
		const f = freezingLevelAt(col([4, -1], [-3, -5]), HOUR / 2);
		expect(f?.ft).toBeCloseTo(1000 / 0.3048, 3);
		expect(f?.atOrBelow).toBe(true);
	});
});

describe('cloudCoverProfileAt', () => {
	const col = (over: Record<string, (number | null)[]> = {}, elevationM = 0): WindColumn => ({
		lat: 0,
		lon: 0,
		elevationM,
		timesMs: [0, HOUR],
		hourly: {
			geopotential_height_950hPa: [540, 560],
			cloud_cover_950hPa: [80, 40],
			geopotential_height_850hPa: [1457, 1457],
			cloud_cover_850hPa: [0, 20],
			...over,
		},
	});

	it('resolves each level to its geopotential altitude, sorted ascending', () => {
		const p = cloudCoverProfileAt(col(), 0);
		expect(p).toHaveLength(2);
		expect(p[0].altFt).toBeCloseTo(540 / 0.3048, 3);
		expect(p[0].coverPct).toBe(80);
		expect(p[1].altFt).toBeCloseTo(1457 / 0.3048, 3);
		expect(p[1].coverPct).toBe(0);
	});

	it('interpolates cover and height between the bracketing hours', () => {
		const p = cloudCoverProfileAt(col(), HOUR / 2);
		expect(p[0].altFt).toBeCloseTo(550 / 0.3048, 3);
		expect(p[0].coverPct).toBeCloseTo(60, 6);
		expect(p[1].coverPct).toBeCloseTo(10, 6);
	});

	it('skips a null-cover level while its neighbours serve (the 975 hPa trap)', () => {
		const p = cloudCoverProfileAt(
			col({ geopotential_height_975hPa: [323, 323], cloud_cover_975hPa: [null, null] }),
			0,
		);
		expect(p.map((l) => l.coverPct)).toEqual([80, 0]);
	});

	it('drops levels resolving at or below the model surface', () => {
		const p = cloudCoverProfileAt(col({}, 1000), 0);
		expect(p).toHaveLength(1);
		expect(p[0].altFt).toBeCloseTo(1457 / 0.3048, 3);
	});

	it('returns empty outside the fetched window', () => {
		expect(cloudCoverProfileAt(col(), -1)).toEqual([]);
		expect(cloudCoverProfileAt(col(), HOUR + 1)).toEqual([]);
	});
});

describe('cloud amount quantisation', () => {
	it('maps percent to oktas to the METAR words, sub-FEW to null', () => {
		expect(cloudAmountLabel(cloudOktas(0))).toBeNull();
		expect(cloudAmountLabel(cloudOktas(5))).toBeNull();
		expect(cloudAmountLabel(cloudOktas(25))).toBe('FEW');
		expect(cloudAmountLabel(cloudOktas(50))).toBe('SCT');
		expect(cloudAmountLabel(cloudOktas(75))).toBe('BKN');
		expect(cloudAmountLabel(cloudOktas(100))).toBe('OVC');
	});
});

describe('ISA', () => {
	it('matches the standard atmosphere', () => {
		expect(isaTempC(0)).toBe(15);
		expect(isaTempC(2500)).toBeCloseTo(10.047, 3);
	});

	it('gives the pressure altitude of a pressure (ICAO Doc 7488)', () => {
		expect(isaPressureAltFt(1013.25)).toBeCloseTo(0, 6);
		expect(isaPressureAltFt(925)).toBeCloseTo(2499.9, 1);
		expect(isaPressureAltFt(850)).toBeCloseTo(4781.2, 1);
		expect(isaPressureAltFt(700)).toBeCloseTo(9882.5, 1);
		expect(isaPressureAltFt(500)).toBeCloseTo(18288.8, 1);
	});

	it('writes a deviation signed, in whole degrees', () => {
		expect(fmtIsaDev(6.4)).toBe('+6');
		expect(fmtIsaDev(-3.2)).toBe('-3');
		expect(fmtIsaDev(-0.4)).toBe('+0');
		expect(fmtIsaDev(0)).toBe('+0');
	});
});

/** A ladder whose levels stand at their pressure altitude plus `dHM` (a high
 *  lifts every level), at the ISA temperature there plus `dT`, over hours
 *  of their own when `dT` is a list. */
function isaColumn(dT: number | number[] = 0, dHM = 0, levels = [1000, 925, 850, 700, 500]): WindColumn {
	const temps = Array.isArray(dT) ? dT : [dT];
	const hourly: Record<string, number[]> = { wind_speed_10m: temps.map(() => 5), wind_direction_10m: temps.map(() => 270) };
	for (const l of levels) {
		const pa = isaPressureAltFt(l);
		hourly[`geopotential_height_${l}hPa`] = temps.map(() => pa * 0.3048 + dHM);
		hourly[`wind_speed_${l}hPa`] = temps.map(() => 10);
		hourly[`wind_direction_${l}hPa`] = temps.map(() => 270);
		hourly[`temperature_${l}hPa`] = temps.map((d) => isaTempC(pa) + d);
	}
	return { lat: 0, lon: 0, elevationM: 0, timesMs: temps.map((_, i) => i * HOUR), hourly };
}

describe('the ISA deviation at the pressure altitude', () => {
	it('reads 0 at any height in a standard atmosphere', () => {
		for (const ft of [500, 2500, 3000, 4781, 7000, 15000]) {
			expect(sampleWindAt(isaColumn(), ft, 0)!.isaDevC).toBeCloseTo(0, 1);
		}
	});

	it('reads 0 on a standard day under a high, where the height above the sea read a degree off', () => {
		// Every level 150 m higher: at 4000 ft the air is at a lower pressure
		// altitude than its height, so the standard temperature there is
		// warmer than the one at 4000 ft.
		const s = sampleWindAt(isaColumn(0, 150), 4000, 0)!;
		expect(s.isaDevC).toBeCloseTo(0, 1);
		expect(Math.abs(s.tempC! - isaTempC(4000))).toBeGreaterThan(0.9);
	});

	it('reads the offset of a warm or a cold air mass', () => {
		expect(sampleWindAt(isaColumn(10), 6000, 0)!.isaDevC).toBeCloseTo(10, 6);
		expect(sampleWindAt(isaColumn(-12), 3000, 0)!.isaDevC).toBeCloseTo(-12, 6);
	});

	it('bridges a level the model leaves out', () => {
		const col = isaColumn(4);
		col.hourly.geopotential_height_850hPa = [null];
		expect(sampleWindAt(col, 4781, 0)!.isaDevC).toBeCloseTo(4, 6);
	});

	it('interpolates between the forecast hours', () => {
		expect(sampleWindAt(isaColumn([0, 10]), 5000, HOUR / 2)!.isaDevC).toBeCloseTo(5, 6);
	});

	it('states none below the model ground nor above the ladder', () => {
		const col = { ...isaColumn(5), elevationM: 1000 };
		expect(sampleWindAt(col, 1000, 0)!.isaDevC).toBeNull();
		expect(sampleWindAt(isaColumn(5, 0, [1000, 925, 850]), 10000, 0)!.isaDevC).toBeNull();
	});

	it('takes the surface deviation at the surface pressure', () => {
		const col: WindColumn = {
			lat: 0,
			lon: 0,
			elevationM: 900,
			timesMs: [0],
			hourly: { wind_speed_10m: [5], wind_direction_10m: [270], temperature_2m: [12], surface_pressure: [910] },
		};
		const s = sampleSurfaceAt(col, 0)!;
		expect(s.isaDevC).toBeCloseTo(12 - isaTempC(isaPressureAltFt(910)), 9);
		expect(sampleSurfaceAt({ ...col, hourly: { ...col.hourly, surface_pressure: [] } }, 0)!.isaDevC).toBeNull();
	});
});
