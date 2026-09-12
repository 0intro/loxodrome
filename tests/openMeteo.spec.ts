import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	FORECAST_BASE,
	HISTORICAL_BASE,
	NO_PRESSURE_WIND_MODELS,
	WIND_MODELS,
	FORECAST_MAX_AHEAD_DAYS,
	OpenMeteoError,
	bracketLevelsHpa,
	buildForecastUrl,
	cloudAmountLabel,
	cloudCoverProfileAt,
	cloudOktas,
	columnReachMs,
	fetchWindColumns,
	forecastBaseFor,
	forecastRangeEndMs,
	freezingLevelFt,
	hourlyVariables,
	isaDevC,
	isaTempC,
	isobarLevels,
	sampleMslpAt,
	normalizeForecast,
	resolveAutoModel,
	sampleSurfaceAt,
	sampleWindAt,
	uvToWind,
	windModel,
	windToUV,
	type WindColumn,
} from '$lib/weather/openMeteo';

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

	it('picks the regional model', () => {
		expect(resolveAutoModel(48.85, 2.35)).toBe('meteofrance_seamless');
		expect(resolveAutoModel(51.5, -0.12)).toBe('ukmo_seamless');
		expect(resolveAutoModel(60.2, -1.2)).toBe('ukmo_seamless');
		expect(resolveAutoModel(39.7, -104.9)).toBe('gfs_seamless');
		expect(resolveAutoModel(35.6, 139.7)).toBe('ecmwf_ifs025');
	});

	it('keeps the reduced ECMWF ladder', () => {
		const vars = hourlyVariables(windModel('ecmwf_ifs025'), {});
		expect(vars).toContain('wind_speed_925hPa');
		expect(vars).not.toContain('wind_speed_975hPa');
	});

	it('brackets a target altitude with two levels each side', () => {
		const mf = windModel('meteofrance_seamless');
		expect(bracketLevelsHpa(mf, 2500)).toEqual([975, 950, 925, 900]);
		expect(bracketLevelsHpa(mf, 500)).toEqual([1000, 975, 950]);
		expect(bracketLevelsHpa(mf, 10_000)).toEqual([800, 700, 600, 500]);
		expect(bracketLevelsHpa(mf, 60_000)).toEqual([600, 500]);
		expect(bracketLevelsHpa(windModel('ecmwf_ifs025'), 2500)).toEqual([1000, 925, 850]);
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

describe('buildForecastUrl', () => {
	const points = [{ lat: 48.85, lon: 2.35 }];
	const base = { model: 'meteofrance_seamless' as const, startMs: T0, endMs: T0 + HOUR, nowMs: T0 };

	it('requests knots, unixtime and the hour window', () => {
		const url = buildForecastUrl(points, base);
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
	const opts = { model: 'meteofrance_seamless' as const, startMs: T0, endMs: T0 + HOUR, nowMs: T0 };
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
		expect(isaDevC(2500, 17)).toBeCloseTo(6.953, 3);
	});
});
