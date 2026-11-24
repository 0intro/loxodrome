/* One engine inoperative: the climb a twin keeps on one engine, its
 * gradient, the en-route net ceiling and the take-off and landing climb
 * checks. Part-CAT's class B rules are the model (Reg. (EU) 965/2012
 * CAT.POL.A.315 en route, CAT.POL.A.340 take-off and landing climb), as the
 * take-off rule A already is: Part-NCO states no twin rule. Pure. */

import type { OneEngineInoperative } from './schema';
import { interpolateMetricTable, isaTemperatureC, type InterpolationFlags } from './performance';

/** The gradient CAT.POL.A.315(b)(2) takes off the one-engine gross climb en
 *  route: the net gradient is the gross less 0.5 %. */
export const OEI_NET_MARGIN_PCT = 0.5;

/** The one-engine gradient CAT.POL.A.340 asks at 1500 ft above the take-off
 *  and the landing surface. */
export const OEI_CLIMB_GRADIENT_PCT = 0.75;

/** ft/min in one knot (6076.12 ft per NM, 60 min). */
const FT_MIN_PER_KT = 6076.12 / 60;

/** The step of the net ceiling's upward scan, feet: finer than any table
 *  band, so a dip in the gradient is never stepped over. */
const CEILING_SCAN_FT = 250;

/** The density ratio at a pressure altitude and temperature (ICAO standard
 *  atmosphere, troposphere): the pressure ratio over the temperature ratio. */
export function densityRatio(pressureAltFt: number, temperatureC: number): number {
	const pressureRatio = (1 - 6.8755856e-6 * pressureAltFt) ** 5.255876;
	return pressureRatio * (288.15 / (temperatureC + 273.15));
}

/** True airspeed from calibrated through the density ratio (compressibility
 *  neglected, as it may be at a light twin's speeds). */
export function casToTasKt(casKt: number, pressureAltFt: number, temperatureC: number): number {
	return casKt / Math.sqrt(densityRatio(pressureAltFt, temperatureC));
}

/** A climb gradient in percent: the rate over the true airspeed. */
export function climbGradientPct(rateFtMin: number, tasKt: number): number {
	return (100 * rateFtMin) / (tasKt * FT_MIN_PER_KT);
}

/** Which table a climb reads: en route `climb` (maximum continuous power,
 *  gear and flaps up); at take-off `takeoffClimb` (take-off power, take-off
 *  flaps), `climb` standing in. */
export type OeiPhase = 'enroute' | 'takeoff';

export interface OeiClimb {
	rateFtMin: number;
	/** The gross gradient at Vyse, percent. */
	gradientPct: number;
	tasKt: number;
	flags: InterpolationFlags;
}

/** The one-engine climb at (mass, pressure altitude, temperature): the
 *  sheet's rate, and its gross gradient at Vyse (the speed the tables are
 *  flown at). Null without the table; 'above' over its top altitude. */
export function oeiClimbAt(
	oei: OneEngineInoperative,
	phase: OeiPhase,
	massKg: number,
	pressureAltFt: number,
	temperatureC: number,
): OeiClimb | 'above' | null {
	const table = phase === 'takeoff' ? (oei.takeoffClimb ?? oei.climb) : oei.climb;
	if (!table) {
		return null;
	}
	const r = interpolateMetricTable(table, massKg, pressureAltFt, temperatureC);
	if (!r.ok) {
		return 'above';
	}
	const tasKt = casToTasKt(oei.vyseKt, pressureAltFt, temperatureC);
	return { rateFtMin: r.value, gradientPct: climbGradientPct(r.value, tasKt), tasKt, flags: r.flags };
}

/** The air at an altitude (feet above the sea): its pressure altitude and
 *  its temperature, from a forecast column or the standard atmosphere. */
export interface AirAt {
	pressureAltFt: number;
	temperatureC: number;
}

/** The net gradient at an altitude, percent (the gross less the A.315
 *  margin): >= 0 where the twin holds that altitude on one engine. Null
 *  without the table or over its top. */
export function oeiNetGradientAt(oei: OneEngineInoperative, massKg: number, air: AirAt): number | null {
	const c = oeiClimbAt(oei, 'enroute', massKg, air.pressureAltFt, air.temperatureC);
	return c === null || c === 'above' ? null : c.gradientPct - OEI_NET_MARGIN_PCT;
}

/** Where the net gradient runs out. `ceiling`: the first altitude, climbing
 *  from the lowest one asked, where it reaches nil; `above`: it still holds
 *  at the highest altitude the table reaches (`altFt`, a floor of the
 *  ceiling); `below`: it fails already at the lowest altitude asked. */
export type NetCeiling = { kind: 'ceiling' | 'above' | 'below'; altFt: number };

/** The one-engine NET ceiling (CAT.POL.A.315(b)(2): the gross gradient less
 *  0.5 %, nil there), scanned upward from `fromFt` to the highest altitude
 *  the table reaches, `airAt` giving the air at each. The FIRST altitude it
 *  fails at is the ceiling, so an inversion warming the air aloft never
 *  lifts it. Null without the climb table, or where `fromFt` is already
 *  above it. */
export function oeiNetCeiling(
	oei: OneEngineInoperative,
	massKg: number,
	airAt: (altFt: number) => AirAt,
	fromFt = 0,
): NetCeiling | null {
	if (!oei.climb) {
		return null;
	}
	const topPa = oei.climb.altitudesFt[oei.climb.altitudesFt.length - 1];
	const net = (altFt: number): number | null => oeiNetGradientAt(oei, massKg, airAt(altFt));
	const atFrom = net(fromFt);
	if (atFrom === null) {
		return null;
	}
	if (atFrom < 0) {
		return { kind: 'below', altFt: fromFt };
	}
	// Halve [lo, hi] 40 times, keeping `keep(lo)` true and `keep(hi)` false.
	const bisect = (lo: number, hi: number, keep: (altFt: number) => boolean): number => {
		for (let i = 0; i < 40; i++) {
			const mid = (lo + hi) / 2;
			if (keep(mid)) {
				lo = mid;
			} else {
				hi = mid;
			}
		}
		return lo;
	};
	const holds = (altFt: number): boolean => (net(altFt) ?? -1) >= 0;
	let lo = fromFt;
	for (let hi = fromFt + CEILING_SCAN_FT; hi < fromFt + 60000; hi += CEILING_SCAN_FT) {
		if (airAt(hi).pressureAltFt > topPa) {
			// The table ends inside this step: judge at its top.
			const topFt = bisect(lo, hi, (a) => airAt(a).pressureAltFt <= topPa);
			return holds(topFt) ? { kind: 'above', altFt: topFt } : { kind: 'ceiling', altFt: bisect(lo, topFt, holds) };
		}
		if (!holds(hi)) {
			return { kind: 'ceiling', altFt: bisect(lo, hi, holds) };
		}
		lo = hi;
	}
	return { kind: 'above', altFt: lo };
}

/** The air `heightFt` above an aerodrome: its pressure altitude that much
 *  higher (the altimeter's height), its temperature lapsing from the one at
 *  the field at the app's ISA rate. */
function airAbove(fieldPressureAltFt: number, fieldTempC: number, heightFt: number): AirAt {
	const pressureAltFt = fieldPressureAltFt + heightFt;
	return {
		pressureAltFt,
		temperatureC: fieldTempC + isaTemperatureC(pressureAltFt) - isaTemperatureC(fieldPressureAltFt),
	};
}

/** One leg of the A.340 climb checks. */
export interface ClimbCheck {
	heightFt: 400 | 1500;
	climb: OeiClimb;
	ok: boolean;
}

/** The A.340 checks at an aerodrome: each leg judged, and the whole. */
export interface ClimbVerdict {
	checks: ClimbCheck[];
	/** Every check judged holds; null when none could be (no table, or
	 *  above it). */
	sufficient: boolean | null;
}

function verdict(checks: (ClimbCheck | null)[]): ClimbVerdict {
	const known = checks.filter((c): c is ClimbCheck => c !== null);
	return { checks: known, sufficient: known.length > 0 ? known.every((c) => c.ok) : null };
}

/** The one-engine climb at a height above an aerodrome, null without a
 *  figure there. */
function climbAbove(
	oei: OneEngineInoperative,
	phase: OeiPhase,
	massKg: number,
	fieldPressureAltFt: number,
	fieldTempC: number,
	heightFt: number,
): OeiClimb | null {
	const air = airAbove(fieldPressureAltFt, fieldTempC, heightFt);
	const c = oeiClimbAt(oei, phase, massKg, air.pressureAltFt, air.temperatureC);
	return c === 'above' ? null : c;
}

/** The one-engine take-off climb (CAT.POL.A.340(a)(2)): measurably positive
 *  at 400 ft above the take-off surface on the take-off table (the sheet's
 *  rate at Vyse stands for the 50 ft speed the rule names), and at least
 *  0.75 % at 1500 ft on the maximum continuous power table. Gross
 *  gradients, the en-route margin being A.315's alone. */
export function oeiTakeoffClimb(
	oei: OneEngineInoperative,
	massKg: number,
	fieldPressureAltFt: number,
	fieldTempC: number,
): ClimbVerdict {
	const c400 = climbAbove(oei, 'takeoff', massKg, fieldPressureAltFt, fieldTempC, 400);
	const c1500 = climbAbove(oei, 'enroute', massKg, fieldPressureAltFt, fieldTempC, 1500);
	return verdict([
		c400 ? { heightFt: 400, climb: c400, ok: c400.rateFtMin > 0 } : null,
		c1500 ? { heightFt: 1500, climb: c1500, ok: c1500.gradientPct >= OEI_CLIMB_GRADIENT_PCT } : null,
	]);
}

/** The one-engine landing climb (CAT.POL.A.340(b)(2)): at least 0.75 % at
 *  1500 ft above the landing surface, maximum continuous power, gear and
 *  flaps up. */
export function oeiLandingClimb(
	oei: OneEngineInoperative,
	massKg: number,
	fieldPressureAltFt: number,
	fieldTempC: number,
): ClimbVerdict {
	const c = climbAbove(oei, 'enroute', massKg, fieldPressureAltFt, fieldTempC, 1500);
	return verdict([c ? { heightFt: 1500, climb: c, ok: c.gradientPct >= OEI_CLIMB_GRADIENT_PCT } : null]);
}
