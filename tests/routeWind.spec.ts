import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';
import { describe, expect, it } from 'vitest';
import {
	chainDepartures,
	effectiveLegWind,
	forecastCoverage,
	legColumnsFromSegments,
	legCumulativeMinutes,
	legMidpoints,
	legSegments,
	legTasKt,
	resolveRouteForecast,
	timeAtNM,
	verticalShearKtPer1000Ft,
	waypointOverride,
	windSummaryNote,
	type LegForecast,
} from '$lib/route/legWind';
import { buildLattice, latticeStepDeg } from '$lib/weather/lattice';
import type { WindColumn } from '$lib/weather/openMeteo';
import type { Waypoint } from '$lib/state/route.svelte';

let nextId = 0;
function wp(lat: number, lon: number, alt = 3000): Waypoint {
	return { id: `w${nextId++}`, lat, lon, kind: 'free', alt, altAuto: true };
}

const HOUR = 3600_000;

/** A column whose wind holds one value over the window. */
function column(lat: number, lon: number, dir: number, spd: number, hours = 6, tempC = 5): WindColumn {
	const n = hours + 1;
	return {
		lat,
		lon,
		elevationM: 0,
		timesMs: Array.from({ length: n }, (_, i) => i * HOUR),
		hourly: {
			geopotential_height_925hPa: new Array<number>(n).fill(800),
			wind_speed_925hPa: new Array<number>(n).fill(spd),
			wind_direction_925hPa: new Array<number>(n).fill(dir),
			temperature_925hPa: new Array<number>(n).fill(tempC),
			geopotential_height_850hPa: new Array<number>(n).fill(1500),
			wind_speed_850hPa: new Array<number>(n).fill(spd),
			wind_direction_850hPa: new Array<number>(n).fill(dir),
			temperature_850hPa: new Array<number>(n).fill(tempC),
			wind_speed_10m: new Array<number>(n).fill(spd / 2),
			wind_direction_10m: new Array<number>(n).fill(dir),
		},
	};
}

describe('legMidpoints', () => {
	it('yields one midpoint per leg', () => {
		const mids = legMidpoints([wp(48, 2), wp(49, 3), wp(50, 3)]);
		expect(mids).toHaveLength(2);
		expect(mids[0]).toEqual({ lat: 48.5, lon: 2.5 });
	});
});

describe('legSegments', () => {
	it('keeps a short leg as its single midpoint segment', () => {
		const segs = legSegments([wp(48, 2), wp(48.2, 2.2)]);
		expect(segs).toHaveLength(1);
		expect(segs[0].legIndex).toBe(0);
		expect(segs[0].lat).toBeCloseTo(48.1, 9);
		expect(segs[0].lon).toBeCloseTo(2.1, 9);
		expect(segs[0].fromNM).toBe(0);
		expect(segs[0].midNM).toBeCloseTo(segs[0].toNM / 2, 9);
	});

	it('subdivides a long leg into an odd count with the middle on the midpoint', () => {
		// ~60 NM at the equator: 3 contiguous segments; ~48 NM would split
		// in 2, which the odd rule bumps to 3 so the midpoint stays sampled.
		const segs = legSegments([wp(0, 0), wp(0, 1)]);
		expect(segs).toHaveLength(3);
		expect(segs.map((s) => s.legIndex)).toEqual([0, 0, 0]);
		expect(segs[1].lon).toBeCloseTo(0.5, 9);
		expect(segs[0].toNM).toBeCloseTo(segs[1].fromNM, 9);
		expect(segs[2].toNM).toBeCloseTo(segs[0].toNM * 3, 6);
		expect(legSegments([wp(0, 0), wp(0, 0.8)])).toHaveLength(3);
	});

	it('widens the spacing on very long routes instead of blowing the cap', () => {
		expect(legSegments([wp(0, 0), wp(0, 33)])).toHaveLength(41);
	});

	it("picks each leg's middle segment for the per-leg wind columns", () => {
		const wps = [wp(0, 0), wp(0, 1), wp(0, 1.2)];
		const segs = legSegments(wps);
		expect(segs.map((s) => s.legIndex)).toEqual([0, 0, 0, 1]);
		const cols = segs.map((s) => column(s.lat, s.lon, 270, 10));
		const legCols = legColumnsFromSegments(cols, segs, 2);
		expect(legCols[0]).toBe(cols[1]);
		expect(legCols[0]?.lon).toBeCloseTo(0.5, 9);
		expect(legCols[1]).toBe(cols[3]);
	});
});

describe('resolveRouteForecast', () => {
	it('samples each leg at its own altitude and chained time', () => {
		// Two ~60 NM northbound legs at 100 kt: leg mid-times near +18 and +54 min.
		const wps = [wp(48, 2, 3000), wp(49, 2, 4500), wp(50, 2, 4500)];
		const cols = [column(48.5, 2, 270, 10), column(49.5, 2, 300, 20)];
		const legs = resolveRouteForecast(cols, wps, 0, 100);
		expect(legs).toHaveLength(2);
		expect(legs[0].ok && legs[0].wind.dirTrueDeg).toBeCloseTo(270, 3);
		expect(legs[1].ok && legs[1].wind.speedKt).toBeCloseTo(20, 3);
		if (legs[0].ok && legs[1].ok) {
			expect(legs[1].wind.validTimeMs).toBeGreaterThan(legs[0].wind.validTimeMs);
			expect(legs[0].wind.isaDevC).toBeCloseTo(5 - (15 - 1.9812 * 3), 2);
		}
	});

	it('re-times later legs against the wind-corrected ground speed', () => {
		// A direct 20 kt headwind on both legs stretches the first leg, so the
		// second leg's valid time moves later than the still-air chain.
		const wps = [wp(48, 2, 3000), wp(49, 2, 3000), wp(50, 2, 3000)];
		const calm = resolveRouteForecast([column(48.5, 2, 0, 0), column(49.5, 2, 0, 0)], wps, 0, 100);
		const head = resolveRouteForecast([column(48.5, 2, 0, 20), column(49.5, 2, 0, 20)], wps, 0, 100);
		if (calm[1].ok && head[1].ok) {
			expect(head[1].wind.validTimeMs).toBeGreaterThan(calm[1].wind.validTimeMs);
		} else {
			expect.unreachable('both forecasts should resolve');
		}
	});

	it('flags legs outside the fetched window as beyond-horizon', () => {
		const wps = [wp(48, 2), wp(49, 2)];
		const legs = resolveRouteForecast([column(48.5, 2, 270, 10, 2)], wps, 30 * HOUR, 100);
		expect(legs[0].ok).toBe(false);
		if (!legs[0].ok) {
			expect(legs[0].reason).toBe('beyond-horizon');
		}
	});

	it('reports a missing column as no-data', () => {
		const wps = [wp(48, 2), wp(49, 2), wp(50, 2)];
		const legs = resolveRouteForecast([column(48.5, 2, 270, 10)], wps, 0, 100);
		expect(legs[0].ok).toBe(true);
		expect(legs[1].ok).toBe(false);
		if (!legs[1].ok) {
			expect(legs[1].reason).toBe('no-data');
		}
	});

	it('flags a leg past a null-padded tail as beyond-horizon', () => {
		// The regime that motivated the reason split: Open-Meteo answers a
		// window past the model's own horizon with the hours PRESENT and every
		// value null, so the fetched window looks complete and only the
		// column's reach tells the leg it is past the forecast.
		const wps = [wp(48, 2), wp(49, 2)];
		const n = 7;
		const tail = (v: number): (number | null)[] =>
			Array.from({ length: n }, (_, i) => (i < 3 ? v : null));
		const col: WindColumn = {
			lat: 48.5,
			lon: 2,
			elevationM: 0,
			timesMs: Array.from({ length: n }, (_, i) => i * HOUR),
			hourly: {
				geopotential_height_925hPa: tail(800),
				wind_speed_925hPa: tail(10),
				wind_direction_925hPa: tail(270),
				wind_speed_10m: tail(5),
				wind_direction_10m: tail(270),
			},
		};
		const inside = resolveRouteForecast([col], wps, HOUR, 100);
		expect(inside[0].ok).toBe(true);
		const beyond = resolveRouteForecast([col], wps, 5 * HOUR, 100);
		expect(beyond[0].ok).toBe(false);
		if (!beyond[0].ok) {
			expect(beyond[0].reason).toBe('beyond-horizon');
		}
	});

	it('threads the sampler aboveTop clamp into the leg provenance', () => {
		// The column's ladder tops out at 1500 m (~4900 ft): a leg planned at
		// 10000 ft samples the topmost level clamped and carries the flag the
		// provenance tips and the level advisor's self-skip read; a leg within
		// the ladder does not.
		const wps = [wp(48, 2, 10000), wp(49, 2, 3000), wp(50, 2, 3000)];
		const cols = [column(48.5, 2, 270, 10), column(49.5, 2, 270, 10)];
		const legs = resolveRouteForecast(cols, wps, 0, 100);
		expect(legs[0].ok && legs[0].wind.aboveTop).toBe(true);
		expect(legs[0].ok && legs[0].wind.belowGround).toBe(false);
		expect(legs[1].ok && legs[1].wind.aboveTop).toBe(false);
	});
});

describe('forecastCoverage', () => {
	const ok = (): LegForecast => ({
		ok: true,
		wind: {
			dirTrueDeg: 270,
			speedKt: 10,
			tempC: null,
			isaDevC: null,
			belowGround: false,
			aboveTop: false,
			validTimeMs: 0,
			altitudeFt: 3000,
			freezingLevelFt: null,
			shearKtPer1000Ft: null,
		},
	});
	const failed = (reason: 'beyond-horizon' | 'no-data'): LegForecast => ({
		ok: false,
		reason,
		validTimeMs: 0,
		altitudeFt: 3000,
	});
	const eff = (source: 'override' | 'forecast' | 'manual') => ({
		dirDeg: 270,
		speedKt: 10,
		source,
		forecast: null,
	});

	it('counts what the forecast served and what it did not', () => {
		const cov = forecastCoverage(
			[eff('forecast'), eff('manual'), eff('manual')],
			[ok(), failed('beyond-horizon'), failed('no-data')],
		);
		expect(cov).toEqual({ forecast: 1, beyondHorizon: 1, unavailable: 1 });
	});

	it("leaves an overridden leg out: the pilot's own wind is not a gap", () => {
		const cov = forecastCoverage(
			[eff('override'), eff('manual')],
			[failed('beyond-horizon'), failed('beyond-horizon')],
		);
		expect(cov.beyondHorizon).toBe(1);
	});

	it('counts nothing while the fetch is unresolved (no warning mid-load)', () => {
		expect(forecastCoverage([eff('manual')], null)).toEqual({
			forecast: 0,
			beyondHorizon: 0,
			unavailable: 0,
		});
	});
});

describe('chainDepartures', () => {
	it('chains still-air arrivals plus ground stops', () => {
		const chain = chainDepartures([60, 30], [45], 0);
		expect(chain[0]).toEqual({ departureMs: 0, arrivalMs: 60 * 60_000 });
		expect(chain[1].departureMs).toBe(105 * 60_000);
		expect(chain[1].arrivalMs).toBe(135 * 60_000);
	});

	it('treats unknown durations and stops as zero', () => {
		const chain = chainDepartures([null, 30], [], 1000);
		expect(chain[1].departureMs).toBe(1000);
	});
});

describe('effectiveLegWind', () => {
	const forecast: LegForecast = {
		ok: true,
		wind: {
			dirTrueDeg: 250,
			speedKt: 15,
			tempC: 2,
			isaDevC: -4,
			belowGround: false,
			aboveTop: false,
			validTimeMs: 0,
			altitudeFt: 3500,
			freezingLevelFt: null,
			shearKtPer1000Ft: null,
		},
	};

	it('applies override, then forecast, then the global wind', () => {
		const override = { dirDeg: 180, speedKt: 30 };
		const global = { dirDeg: 90, speedKt: 5 };
		expect(effectiveLegWind(override, forecast, global, true)?.source).toBe('override');
		expect(effectiveLegWind(null, forecast, global, true)?.source).toBe('forecast');
		expect(effectiveLegWind(null, forecast, global, false)?.source).toBe('manual');
		expect(effectiveLegWind(null, null, global, true)?.source).toBe('manual');
		expect(effectiveLegWind(null, null, null, true)).toBeNull();
	});

	it('keeps the forecast provenance on forecast winds only', () => {
		expect(effectiveLegWind(null, forecast, null, true)?.forecast?.validTimeMs).toBe(0);
		expect(effectiveLegWind({ dirDeg: 1, speedKt: 2 }, forecast, null, true)?.forecast).toBeNull();
	});

	it('reads overrides only when both waypoint fields are set', () => {
		expect(waypointOverride({ windDirDeg: 200, windSpeedKt: 10 })).toEqual({ dirDeg: 200, speedKt: 10 });
		expect(waypointOverride({ windDirDeg: 200 })).toBeNull();
		expect(waypointOverride({})).toBeNull();
	});
});

describe('legCumulativeMinutes / timeAtNM (schedule wind correction)', () => {
	const legs = [{ legNM: 60 }, { legNM: 60 }];

	it('accumulates per-leg minutes at gs, falling back to the cruise speed', () => {
		const b = legCumulativeMinutes(legs, 100, [80, null])!;
		expect(b.cumNM).toEqual([60, 120]);
		expect(b.cumMin[0]).toBeCloseTo(45, 6);
		expect(b.cumMin[1]).toBeCloseTo(45 + 36, 6);
	});

	it('is null without a positive cruise speed (the schedule keeps blank ETEs)', () => {
		expect(legCumulativeMinutes(legs, null, [80, 80])).toBeNull();
		expect(legCumulativeMinutes(legs, 0, [80, 80])).toBeNull();
	});

	it('interpolates within the leg the distance falls in', () => {
		const b = legCumulativeMinutes(legs, 100, [80, null])!;
		expect(timeAtNM(30, b)).toBeCloseTo(22.5, 6); // half of leg 1 at GS 80
		expect(timeAtNM(60, b)).toBeCloseTo(45, 6);
		expect(timeAtNM(90, b)).toBeCloseTo(45 + 18, 6); // half of leg 2, still air
	});

	it('clamps at both ends and skips zero-length legs', () => {
		const b = legCumulativeMinutes(legs, 100, [80, null])!;
		expect(timeAtNM(-5, b)).toBe(0);
		expect(timeAtNM(999, b)).toBeCloseTo(81, 6);
		const z = legCumulativeMinutes([{ legNM: 60 }, { legNM: 0 }, { legNM: 60 }], 100, [null, null, null])!;
		expect(timeAtNM(60, z)).toBeCloseTo(36, 6);
		expect(timeAtNM(120, z)).toBeCloseTo(72, 6);
	});

	it('matches the still-air scalar formula when no leg has a wind', () => {
		const b = legCumulativeMinutes(legs, 100, [null, null])!;
		expect(timeAtNM(75, b)).toBeCloseTo((75 / 100) * 60, 9);
	});
});

describe('verticalShearKtPer1000Ft', () => {
	// Levels exactly 1000 ft and 3000 ft MSL so the +-1000 ft samples land on
	// them: a full 180-degree reversal at 10 kt gives |du| = 20 over 2000 ft.
	function shearCol(dirLo: number, dirHi: number, elevM = 0): WindColumn {
		return {
			lat: 0,
			lon: 0,
			elevationM: elevM,
			timesMs: [0],
			hourly: {
				geopotential_height_925hPa: [304.8],
				wind_speed_925hPa: [10],
				wind_direction_925hPa: [dirLo],
				geopotential_height_850hPa: [914.4],
				wind_speed_850hPa: [10],
				wind_direction_850hPa: [dirHi],
				wind_speed_10m: [5],
				wind_direction_10m: [dirLo],
			},
		};
	}

	it('measures the vector difference per 1000 ft', () => {
		expect(verticalShearKtPer1000Ft(shearCol(90, 270), 2000, 0)).toBeCloseTo(10, 6);
		expect(verticalShearKtPer1000Ft(shearCol(90, 90), 2000, 0)).toBeCloseTo(0, 6);
	});

	it('is null when the lower sample sits below the model ground', () => {
		// Ground at ~1640 ft: the 1000 ft lower sample is underground.
		expect(verticalShearKtPer1000Ft(shearCol(90, 270, 500), 2000, 0)).toBeNull();
	});
});

describe('windSummaryNote', () => {
	it('reads headwind and tailwind effects', () => {
		// 100 NM at 100 kt still air (60 min); 75 min into the wind.
		expect(windSummaryNote(60, 75, 100, 100, en.navlog)).toBe('wind +15 min (avg 20 kt headwind)');
		expect(windSummaryNote(60, 50, 100, 100, en.navlog)).toBe('wind -10 min (avg 20 kt tailwind)');
		expect(windSummaryNote(60, 75, 100, 100, fr.navlog)).toBe('vent +15 min (en moyenne 20 kt de face)');
	});

	it('omits the component when it rounds away (pure crab loss)', () => {
		expect(windSummaryNote(600, 600.6, 1000, 100, en.navlog)).toBe('wind +1 min');
	});

	it('is null when nothing is computable or the effect rounds to zero', () => {
		expect(windSummaryNote(null, 60, 100, 100, en.navlog)).toBeNull();
		expect(windSummaryNote(60, null, 100, 100, en.navlog)).toBeNull();
		expect(windSummaryNote(60, 60.2, 100, 100, en.navlog)).toBeNull();
		expect(windSummaryNote(60, 62, 100, null, en.navlog)).toBeNull();
	});
});

describe('legTasKt', () => {
	it('corrects the cruise TAS by the ISA deviation only when enabled', () => {
		expect(legTasKt(100, 20, 0, false)).toBe(100);
		expect(legTasKt(100, null, 0, true)).toBe(100);
		// ISA at sea level is 15 degC: +15 gives sqrt(303.15 / 288.15).
		expect(legTasKt(100, 30, 0, true)).toBeCloseTo(100 * Math.sqrt(303.15 / 288.15), 6);
		expect(legTasKt(100, 30, 0, true)).toBeGreaterThan(102);
	});
});

describe('lattice', () => {
	it('snaps the step to the power-of-2 ladder and the model grid', () => {
		expect(latticeStepDeg(0.01, 0.025)).toBe(1);
		expect(latticeStepDeg(0.0005, 0.025)).toBe(0.0625);
		expect(latticeStepDeg(0.0001, 0.25)).toBe(0.25);
	});

	it('covers the bounds row-major and respects the point budget', () => {
		const l = buildLattice({ west: 1.9, south: 47.9, east: 3.1, north: 49.1 }, 0.5);
		expect(l.lats[0]).toBeLessThanOrEqual(47.9);
		expect(l.lats[l.lats.length - 1]).toBeGreaterThanOrEqual(49);
		expect(l.points).toHaveLength(l.lats.length * l.lons.length);
		expect(l.points[1]).toEqual({ lat: l.lats[0], lon: l.lons[1] });
		const capped = buildLattice({ west: -10, south: 35, east: 20, north: 60 }, 0.5, 60);
		expect(capped.points.length).toBeLessThanOrEqual(60);
		expect(capped.stepDeg).toBeGreaterThan(0.5);
	});
});
