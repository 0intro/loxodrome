/* The en-route one-engine check of a route, CAT.POL.A.315 (Reg. (EU)
 * 965/2012, class B multi-engined aeroplanes) taken as the model: each
 * leg's minimum safe altitude against the twin's one-engine NET ceiling (the
 * gross gradient less 0.5 %, aircraft/oneEngine.ts) in the air the forecast
 * expects over the leg, the standard atmosphere without one. A leg whose MSA
 * stands above that ceiling cannot be held at its MSA on one engine. The
 * conservative reading: no drift-down is credited, and the trip's take-off
 * mass is assumed all the way. Pure. */

import { oeiNetCeiling, type AirAt, type NetCeiling } from '$lib/aircraft/oneEngine';
import { isaTemperatureC } from '$lib/aircraft/performance';
import type { OneEngineInoperative } from '$lib/aircraft/schema';

/** The air a leg's forecast states at the leg's level: the altitude the
 *  sample was read at (ft above the sea), its temperature, and that
 *  temperature's deviation from the standard atmosphere at the air's own
 *  pressure altitude (weather/openMeteo's ISA, `isaTempC`). */
export interface LegAir {
	altitudeFt: number;
	tempC: number;
	isaDevC: number;
}

/** weather/openMeteo's ISA lapse (`isaTempC`), degrees per foot. */
const FORECAST_ISA_LAPSE_C_PER_FT = 1.9812 / 1000;

/** The air at every altitude over a leg. With a forecast: the pressure
 *  altitude its own ISA temperature (the temperature less its deviation)
 *  gives the sample, that offset from the altitude it was read at (the
 *  QNH's) kept through the column, and the temperature lapsing from the
 *  sample's at the app's ISA rate, as the take-off climb checks lapse the
 *  field's. Without one, the standard atmosphere. */
export function legAirAt(air: LegAir | null): (altFt: number) => AirAt {
	if (!air) {
		return (altFt) => ({ pressureAltFt: altFt, temperatureC: isaTemperatureC(altFt) });
	}
	const samplePaFt = (15 - (air.tempC - air.isaDevC)) / FORECAST_ISA_LAPSE_C_PER_FT;
	const offsetFt = samplePaFt - air.altitudeFt;
	return (altFt) => {
		const pressureAltFt = altFt + offsetFt;
		return {
			pressureAltFt,
			temperatureC: air.tempC + isaTemperatureC(pressureAltFt) - isaTemperatureC(samplePaFt),
		};
	};
}

/** One leg's check. */
export interface OeiLegCheck {
	/** The one-engine net ceiling over the leg, unrounded. */
	ceiling: NetCeiling;
	msaFt: number;
	/** The ceiling stands under the MSA, or cannot be shown above it (the
	 *  climb table ends under it). */
	below: boolean;
	/** The forecast's deviation the ceiling was judged at; null: the
	 *  standard atmosphere. */
	isaDevC: number | null;
}

/** A leg's check at a mass; null without its MSA or a climb table to read. */
export function oeiLegCheck(
	oei: OneEngineInoperative,
	massKg: number,
	msaFt: number | null,
	air: LegAir | null,
): OeiLegCheck | null {
	if (msaFt === null) {
		return null;
	}
	const ceiling = oeiNetCeiling(oei, massKg, legAirAt(air));
	if (!ceiling) {
		return null;
	}
	return {
		ceiling,
		msaFt,
		below: ceiling.kind === 'below' || ceiling.altFt < msaFt,
		isaDevC: air?.isaDevC ?? null,
	};
}

/** Every leg's check, one per leg (null where it cannot be judged). */
export function oeiLegChecks(
	oei: OneEngineInoperative,
	massKg: number,
	msaFt: readonly (number | null)[],
	airs: readonly (LegAir | null)[],
): (OeiLegCheck | null)[] {
	return msaFt.map((msa, i) => oeiLegCheck(oei, massKg, msa, airs[i] ?? null));
}

/** Every leg's net ceiling alone, its MSA aside: what the profile's line
 *  draws (null where there is no climb table to read). */
export function oeiLegCeilings(
	oei: OneEngineInoperative,
	massKg: number,
	airs: readonly (LegAir | null)[],
): (NetCeiling | null)[] {
	return airs.map((air) => oeiNetCeiling(oei, massKg, legAirAt(air)));
}

/** A ceiling as shown: rounded DOWN to 100 ft, so the figure never reads
 *  above the ceiling it states. */
export function shownCeilingFt(altFt: number): number {
	return Math.floor(altFt / 100) * 100;
}
