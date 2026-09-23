/* Cruise-level advisor (src/lib/route/levelAdvisor.ts) and the level
 * enumerator it scans (compliantLevels): candidate legality, the nav-log
 * evaluation recipe over synthetic forecast columns, the cruise-only gain
 * threshold, and the safety gates (docs/cruising-levels.md "Level
 * advisor"). */

import { describe, expect, it } from 'vitest';
import { compliantLevels, snapToLevel, VFR_CEILING_FT } from '$lib/route/cruisingLevels';
import {
	ADVISOR_MIN_GAIN_MIN,
	adviseLevels,
	type AdvisorArgs,
} from '$lib/route/levelAdvisor';
import type { LegForecast } from '$lib/route/legWind';
import type { WindColumn } from '$lib/weather/openMeteo';
import type { Waypoint } from '$lib/state/route.svelte';

describe('compliantLevels', () => {
	it('enumerates the hemicycle ladder inside the band', () => {
		// Eastbound (odd + 500 VFR): 3500, 5500, 7500 within (3000, 8000].
		expect(compliantLevels(90, true, { floorFt: 3000, capFt: 8000 })).toEqual([3500, 5500, 7500]);
		// Westbound (even + 500 VFR).
		expect(compliantLevels(270, true, { floorFt: 3000, capFt: 8000 })).toEqual([4500, 6500]);
		// IFR whole thousands.
		expect(compliantLevels(90, false, { floorFt: 3000, capFt: 8000 })).toEqual([5000, 7000]);
		expect(compliantLevels(270, false, { floorFt: 3000, capFt: 8000 })).toEqual([4000, 6000, 8000]);
	});

	it('clamps: floor strict, cap inclusive, VFR FL 195', () => {
		expect(compliantLevels(90, true, { floorFt: 3500, capFt: 5500 })).toEqual([5500]);
		expect(compliantLevels(90, true, { floorFt: 18000, capFt: 30000 })).toEqual([19500]);
		expect(compliantLevels(90, true, { floorFt: VFR_CEILING_FT, capFt: 30000 })).toEqual([]);
	});

	it('switches the IFR ladder to the UTA parity above FL 195', () => {
		// Track 090: odd below (FL 190 last) AND odd in the UTA (ENR 1.7.5:
		// 090-269 carries FL 210, 230, ...).
		expect(compliantLevels(90, false, { floorFt: 17000, capFt: 22000 })).toEqual([
			19000, 21000,
		]);
		// Track 270: even below (FL 180 last), even in the UTA (FL 200, 220).
		expect(compliantLevels(270, false, { floorFt: 17000, capFt: 22000 })).toEqual([
			18000, 20000, 22000,
		]);
	});

	it('drops the parity and halves the spacing with the rule off', () => {
		expect(compliantLevels(90, true, { floorFt: 3000, capFt: 6000, hemicycle: false })).toEqual([
			3500, 4500, 5500,
		]);
		expect(compliantLevels(90, false, { floorFt: 3000, capFt: 6000, hemicycle: false })).toEqual([
			4000, 5000, 6000,
		]);
	});

	it('guards the uncapped IFR ladder instead of looping', () => {
		expect(compliantLevels(90, false, { floorFt: 3000 })).toEqual([]);
	});

	it('always contains snapToLevel\'s result, and it is the nearest member', () => {
		for (const track of [10, 100, 200, 350]) {
			for (const vfr of [true, false]) {
				const opts = { floorFt: 3200, capFt: 11000 };
				const levels = compliantLevels(track, vfr, opts);
				for (const alt of [3400, 4200, 5600, 9800]) {
					const snapped = snapToLevel(alt, track, vfr, opts);
					if (snapped == null) {
						continue;
					}
					expect(levels).toContain(snapped);
					const nearest = Math.min(...levels.map((l) => Math.abs(l - alt)));
					expect(Math.abs(snapped - alt)).toBe(nearest);
				}
			}
		}
	});
});

/* ------------------------------------------------------------------ */

let nextId = 0;
function wp(lat: number, lon: number, alt: number, extra: Partial<Waypoint> = {}): Waypoint {
	return { id: `w${nextId++}`, lat, lon, kind: 'free', alt, altAuto: true, ...extra };
}

/** A column with distinct winds per pressure level, constant over time.
 *  Heights in metres MSL; 925 hPa low, 850 hPa mid, optional 700 hPa top.
 *  The sampler flags targets above the ladder top aboveTop and the
 *  advisor self-skips them (see the dedicated test below). */
function column(
	low: { hM: number; dir: number; spd: number },
	mid: { hM: number; dir: number; spd: number },
	top?: { hM: number; dir: number; spd: number },
	elevationM = 0,
): WindColumn {
	const n = 4;
	const fill = (v: number): number[] => new Array<number>(n).fill(v);
	const hourly: WindColumn['hourly'] = {
		geopotential_height_925hPa: fill(low.hM),
		wind_speed_925hPa: fill(low.spd),
		wind_direction_925hPa: fill(low.dir),
		temperature_925hPa: fill(10),
		geopotential_height_850hPa: fill(mid.hM),
		wind_speed_850hPa: fill(mid.spd),
		wind_direction_850hPa: fill(mid.dir),
		temperature_850hPa: fill(5),
	};
	if (top) {
		hourly.geopotential_height_700hPa = fill(top.hM);
		hourly.wind_speed_700hPa = fill(top.spd);
		hourly.wind_direction_700hPa = fill(top.dir);
		hourly.temperature_700hPa = fill(0);
	}
	return {
		lat: 45,
		lon: 0.7,
		elevationM,
		timesMs: Array.from({ length: n }, (_, i) => i * 3600_000),
		hourly,
	};
}

function okForecast(validTimeMs = 3600_000): LegForecast {
	return {
		ok: true,
		wind: {
			dirTrueDeg: 0,
			speedKt: 0,
			tempC: null,
			isaDevC: null,
			belowGround: false,
			aboveTop: false,
			validTimeMs,
			altitudeFt: 3500,
			freezingLevelFt: null,
			shearKtPer1000Ft: null,
		},
	};
}

/** A ~60 NM due-east leg at 45N (magnetic near-090: odd hemicycle, VFR
 *  levels 3500 / 5500 / ...). */
function eastLeg(altFt: number, extra: Partial<Waypoint> = {}): Waypoint[] {
	return [wp(45, 0, altFt, extra), wp(45, 1.4151, altFt)];
}

function baseArgs(waypoints: Waypoint[], col: WindColumn): AdvisorArgs {
	return {
		waypoints,
		columns: [col],
		forecasts: [okForecast()],
		legMinElevFt: [0],
		classAFloors: [null],
		vfr: true,
		semicircular: true,
		cruiseKt: 100,
		tempTas: false,
		timeYears: 2026.5,
	};
}

// Headwind (from 090) at ~2950 ft, strong tailwind (from 270) at ~5740 ft,
// headwind again at ~8530 ft: 5500 is the sweet spot for an eastbound leg
// (7500 interpolates back toward the headwind).
const TAILWIND_ALOFT = column(
	{ hM: 900, dir: 90, spd: 20 },
	{ hM: 1750, dir: 270, spd: 40 },
	{ hM: 2600, dir: 90, spd: 20 },
);

describe('adviseLevels', () => {
	it('suggests the tailwind level with the promised gain', () => {
		const out = adviseLevels(baseArgs(eastLeg(3500), TAILWIND_ALOFT));
		expect(out).toHaveLength(1);
		const s = out[0];
		expect(s).not.toBeNull();
		expect(s?.bestFt).toBe(5500);
		expect(s?.gainMin ?? 0).toBeGreaterThanOrEqual(ADVISOR_MIN_GAIN_MIN);
		expect(s?.bestEteMin ?? Infinity).toBeLessThan(s?.currentEteMin ?? 0);
		expect(s?.gsKt ?? 0).toBeGreaterThan(100);
	});

	it('stays quiet in uniform wind (no gain)', () => {
		const uniform = column({ hM: 900, dir: 270, spd: 15 }, { hM: 1750, dir: 270, spd: 15 });
		expect(adviseLevels(baseArgs(eastLeg(3500), uniform))[0]).toBeNull();
	});

	it('stays quiet when the gain misses the threshold', () => {
		// A whisper of extra tailwind aloft: measurable, not worth a chip.
		const slight = column({ hM: 900, dir: 270, spd: 15 }, { hM: 1750, dir: 270, spd: 17 });
		expect(adviseLevels(baseArgs(eastLeg(3500), slight))[0]).toBeNull();
	});

	it('skips a leg with a manual W/V override', () => {
		const wps = eastLeg(3500, { windDirDeg: 90, windSpeedKt: 20 });
		expect(adviseLevels(baseArgs(wps, TAILWIND_ALOFT))[0]).toBeNull();
	});

	it('skips a leg whose forecast did not resolve', () => {
		const args = baseArgs(eastLeg(3500), TAILWIND_ALOFT);
		args.forecasts = [
			{ ok: false, reason: 'beyond-horizon', validTimeMs: 3600_000, altitudeFt: 3500 },
		];
		expect(adviseLevels(args)[0]).toBeNull();
	});

	it('respects the Class A cap', () => {
		const args = baseArgs(eastLeg(3500), TAILWIND_ALOFT);
		args.classAFloors = [5000];
		expect(adviseLevels(args)[0]).toBeNull();
	});

	it('self-skips candidates above the model ladder (never ranks clamped wind)', () => {
		// Ladder tops at 1200 m (~3900 ft) with a strong tailwind AT the
		// top: 5500 and every higher candidate sit above the ladder, and
		// ranking them on the clamped top wind would fabricate a gain.
		const shortLadder = column(
			{ hM: 900, dir: 90, spd: 20 },
			{ hM: 1200, dir: 270, spd: 40 },
		);
		expect(adviseLevels(baseArgs(eastLeg(3500), shortLadder))[0]).toBeNull();
	});

	it('never steers a leg down over unknown terrain', () => {
		// Better wind BELOW the planned level; terrain unknown -> only look up.
		const tailwindBelow = column(
			{ hM: 900, dir: 270, spd: 40 },
			{ hM: 1750, dir: 90, spd: 20 },
		);
		const args = baseArgs(eastLeg(5500), tailwindBelow);
		args.legMinElevFt = [null];
		expect(adviseLevels(args)[0]).toBeNull();
		// Known low terrain frees the descent.
		args.legMinElevFt = [0];
		expect(adviseLevels(args)[0]?.bestFt).toBe(3500);
	});

	it('returns nulls without a cruise speed or columns', () => {
		const args = baseArgs(eastLeg(3500), TAILWIND_ALOFT);
		args.cruiseKt = null;
		expect(adviseLevels(args)).toEqual([null]);
		const args2 = baseArgs(eastLeg(3500), TAILWIND_ALOFT);
		args2.columns = null;
		expect(adviseLevels(args2)).toEqual([null]);
	});

	it('keeps a coincident leg quiet', () => {
		const a = wp(45, 0, 3500);
		const b = wp(45, 0, 3500);
		const args = baseArgs([a, b], TAILWIND_ALOFT);
		expect(adviseLevels(args)[0]).toBeNull();
	});
});
