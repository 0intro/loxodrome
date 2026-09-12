/* Cruise-level advisor: for each leg, evaluate the wind triangle at every
 * usable cruising level from the leg's ALREADY-FETCHED forecast column and
 * suggest the fastest one when it beats the planned level by a meaningful
 * margin. Pure math over the route wind cache: scanning candidates costs
 * zero network (the columns carry the full ladder + temperatures).
 *
 * The comparison is CRUISE TIME ONLY (the aircraft schema has no climb
 * data to price the climb honestly); the gain threshold absorbs small
 * climb costs and the chip tooltip says so. Every candidate level is
 * evaluated with EXACTLY the nav-log recipe (same sampler, same TAS
 * helper, same wind triangle, and the leg's SAME resolved mid-time), so
 * an applied suggestion reproduces its promised ETE in the nav log; a
 * faster level shifts downstream leg times only second-order (documented
 * in docs/cruising-levels.md). */

import { computeNavLog } from './navlog';
import { legMagneticTrackDeg } from './magnetic';
import { applicabilityFloorFt, compliantLevels, EU_REGIME, type CruisingRegime } from './cruisingLevels';
import { legTasKt, waypointOverride, type LegForecast } from './legWind';
import { windTriangle } from './wind';
import { sampleWindAt, type WindColumn } from '$lib/weather/openMeteo';
import type { Waypoint } from '$lib/state/route.svelte';

/** Suggest only when the gain clears BOTH bounds (absorbs the unpriced
 *  climb and keeps the chips quiet on short legs). */
export const ADVISOR_MIN_GAIN_MIN = 2;
export const ADVISOR_MIN_GAIN_FRAC = 0.05;
/** Scan ceiling (ft): keeps the IFR ladder bounded and the scan inside
 *  light-GA territory; candidates above the model ladder self-skip via
 *  the sampler. VFR additionally caps at FL 195 in the enumerator. */
export const ADVISOR_CEILING_FT = 20000;

export interface LevelSuggestion {
	legIndex: number;
	/** The fastest usable level (ft AMSL). */
	bestFt: number;
	/** Cruise minutes saved vs the planned level. */
	gainMin: number;
	bestEteMin: number;
	currentEteMin: number;
	/** Ground speed at the suggested level, kt. */
	gsKt: number;
}

export interface AdvisorArgs {
	waypoints: Waypoint[];
	/** One column per leg midpoint (routeWindColumns); null = not ready. */
	columns: readonly (WindColumn | undefined)[] | null;
	/** routeLegForecasts(route): the leg's resolved mid-time rides both
	 *  branches; a not-ok leg is skipped (never compared as still air). */
	forecasts: readonly LegForecast[] | null;
	legMinElevFt: readonly (number | null)[];
	classAFloors: readonly (number | null)[];
	vfr: boolean;
	/** Semicircular option: on = hemicycle-legal candidates only. */
	semicircular: boolean;
	cruiseKt: number | null;
	tempTas: boolean;
	timeYears: number;
	/** National cruising-level regime; `EU_REGIME` when absent. */
	regime?: CruisingRegime;
}

/** ETE (minutes) over a leg at one level, by the nav-log recipe; null when
 *  the forecast does not resolve there or the wind defeats the aircraft. */
function eteAtLevel(
	col: WindColumn,
	altFt: number,
	timeMs: number,
	trackTrueDeg: number,
	legNM: number,
	cruiseKt: number,
	tempTas: boolean,
): { eteMin: number; gsKt: number } | null {
	// aboveTop: a candidate above the model ladder must not be ranked on
	// the top level's clamped wind (the self-skip the scan ceiling assumes).
	const s = sampleWindAt(col, altFt, timeMs);
	if (!s || s.belowGround || s.aboveTop) {
		return null;
	}
	const tas = legTasKt(cruiseKt, s.tempC, altFt, tempTas);
	const sol = windTriangle(trackTrueDeg, tas, s.dirTrueDeg, s.speedKt);
	if (!sol) {
		return null;
	}
	return { eteMin: (legNM / sol.gsKt) * 60, gsKt: sol.gsKt };
}

/** One suggestion (or null) per leg. Pure; all gating on the caller's
 *  side of the data (live weather, forecast-legs option) happens before
 *  the call. */
export function adviseLevels(args: AdvisorArgs): (LevelSuggestion | null)[] {
	const legs = Math.max(0, args.waypoints.length - 1);
	const out: (LevelSuggestion | null)[] = new Array<LevelSuggestion | null>(legs).fill(null);
	if (!args.columns || !args.forecasts || args.cruiseKt == null || args.cruiseKt <= 0) {
		return out;
	}
	const nav = computeNavLog(args.waypoints, null);
	for (let i = 0; i < legs; i++) {
		const wp = args.waypoints[i];
		const leg = nav.legs[i];
		const col = args.columns[i];
		const f = args.forecasts[i];
		// A per-leg W/V override pins that leg's wind at every altitude:
		// there is nothing level-dependent to optimise.
		if (!col || !f || !f.ok || leg.legNM < 1e-6 || waypointOverride(wp)) {
			continue;
		}
		// The leg's resolved mid-time, reused across every candidate level
		// (the altitude dependence of the time is hourly at most; the
		// second-order shift is documented in docs/cruising-levels.md).
		const timeMs = f.wind.validTimeMs;
		const baseline = eteAtLevel(
			col,
			wp.alt,
			timeMs,
			leg.trackTrueDeg,
			leg.legNM,
			args.cruiseKt,
			args.tempTas,
		);
		if (!baseline) {
			continue;
		}
		// Unknown terrain must never steer a leg DOWN: without a real floor
		// (the shared cache warms under the semicircular effect; rule-off
		// routes may never load tiles) the scan starts at the planned level
		// and only looks up.
		const minElev = args.legMinElevFt[i] ?? null;
		const floorFt =
			minElev != null
				? applicabilityFloorFt(minElev, args.vfr)
				: Math.max(applicabilityFloorFt(null, args.vfr), wp.alt - 1);
		const capFt = Math.min(args.classAFloors[i] ?? Infinity, ADVISOR_CEILING_FT);
		const track = legMagneticTrackDeg(
			leg.trackTrueDeg,
			args.waypoints[i],
			args.waypoints[i + 1],
			args.timeYears,
		);
		const candidates = compliantLevels(
			track,
			args.vfr,
			{
				floorFt,
				capFt,
				hemicycle: args.semicircular,
			},
			args.regime ?? EU_REGIME,
		);
		let bestFt = wp.alt;
		let best = baseline;
		for (const L of candidates) {
			if (L === wp.alt) {
				continue;
			}
			const r = eteAtLevel(
				col,
				L,
				timeMs,
				leg.trackTrueDeg,
				leg.legNM,
				args.cruiseKt,
				args.tempTas,
			);
			if (!r) {
				continue;
			}
			// Strictly better, ties to the LOWER level (less climb for the
			// same cruise time).
			if (r.eteMin < best.eteMin - 1e-9 || (Math.abs(r.eteMin - best.eteMin) <= 1e-9 && L < bestFt)) {
				best = r;
				bestFt = L;
			}
		}
		const gainMin = baseline.eteMin - best.eteMin;
		if (
			bestFt !== wp.alt &&
			gainMin >= Math.max(ADVISOR_MIN_GAIN_MIN, ADVISOR_MIN_GAIN_FRAC * baseline.eteMin)
		) {
			out[i] = {
				legIndex: i,
				bestFt,
				gainMin,
				bestEteMin: best.eteMin,
				currentEteMin: baseline.eteMin,
				gsKt: best.gsKt,
			};
		}
	}
	return out;
}
