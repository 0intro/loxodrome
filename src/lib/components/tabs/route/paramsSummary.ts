/* The one line the Route tab's folded Flight parameters show: what the plan
 * flies with, the automatic values plain and every value the pilot set
 * named, so a fold never hides an override. Locale-free: the parts are data
 * and RouteTab words them (docs/i18n.md). */

import type { WindVec } from '$lib/route/legWind';

export type ParamPart =
	/** The cruise: the plan's own speed and fuel flow (`plan`), the selected
	 *  plane's (`plane`, named, with the setting the plan picked when not the
	 *  sheet's default), or the default without one. */
	| {
			kind: 'cruise';
			kt: number;
			lph: number | null;
			source: 'plan' | 'plane' | 'default';
			plane: string | null;
			setting: string | null;
	  }
	/** A setting the plan names that the plane's sheet does not hold. */
	| { kind: 'cruise-lost'; name: string }
	| { kind: 'wind-forecast' }
	| { kind: 'wind-manual'; wind: WindVec }
	/** A Manual source with no wind typed: the legs fly still air. */
	| { kind: 'wind-none' }
	/** Under a Forecast source, the legs it misses (numbered from 1). */
	| { kind: 'wind-missed'; legs: number[] }
	/** Legs flying a wind of their own (the W/V chip). */
	| { kind: 'leg-winds'; count: number }
	| { kind: 'ta'; ft: number; manual: boolean }
	| { kind: 'semicircular'; on: boolean }
	| { kind: 'temp-tas' };

export interface ParamsSummaryInput {
	cruiseKt: number;
	/** The fuel flow beside it (effectiveConsumptionLph), null unknown. */
	cruiseLph: number | null;
	/** The plan states its own speed or fuel flow. */
	cruiseManual: boolean;
	/** Whose the automatic speed is (automaticCruiseFrom), null = default. */
	cruisePlane: string | null;
	/** The plane's setting the plan picked, null for the sheet's default. */
	cruiseSetting: string | null;
	/** A setting the plan names and the sheet does not hold. */
	cruiseLost: string | null;
	/** The wind source in force: Forecast needs live weather. */
	windSource: 'forecast' | 'manual';
	/** The plan's manual wind, a pair or nothing. */
	wind: WindVec | null;
	missedLegs: readonly number[];
	legOverrides: number;
	taFt: number;
	taManual: boolean;
	semicircular: boolean;
	/** Temperature-corrected TAS in force (the option, with live weather). */
	tempTas: boolean;
}

/** The parts, in the line's order: speed, wind, its gaps and the legs'
 *  own, the transition altitude, the level rule, the TAS correction. */
export function paramsSummary(p: ParamsSummaryInput): ParamPart[] {
	const parts: ParamPart[] = [
		{
			kind: 'cruise',
			kt: p.cruiseKt,
			lph: p.cruiseLph,
			source: p.cruiseManual ? 'plan' : p.cruisePlane !== null ? 'plane' : 'default',
			plane: p.cruiseManual ? null : p.cruisePlane,
			setting: p.cruiseManual ? null : p.cruiseSetting,
		},
	];
	if (p.cruiseLost !== null) {
		parts.push({ kind: 'cruise-lost', name: p.cruiseLost });
	}
	if (p.windSource === 'forecast') {
		parts.push({ kind: 'wind-forecast' });
		if (p.missedLegs.length > 0) {
			parts.push({ kind: 'wind-missed', legs: [...p.missedLegs] });
		}
	} else {
		parts.push(p.wind ? { kind: 'wind-manual', wind: p.wind } : { kind: 'wind-none' });
	}
	if (p.legOverrides > 0) {
		parts.push({ kind: 'leg-winds', count: p.legOverrides });
	}
	parts.push({ kind: 'ta', ft: p.taFt, manual: p.taManual });
	parts.push({ kind: 'semicircular', on: p.semicircular });
	if (p.tempTas) {
		parts.push({ kind: 'temp-tas' });
	}
	return parts;
}

/** A part the pilot set, or one the plan should not fly unnoticed (legs
 *  without a forecast, no wind at all): the line inks it like a leg's manual
 *  wind. */
export function partStandsOut(part: ParamPart): boolean {
	switch (part.kind) {
		case 'cruise':
			return part.source === 'plan';
		case 'cruise-lost':
		case 'wind-manual':
		case 'wind-none':
		case 'wind-missed':
		case 'leg-winds':
			return true;
		case 'ta':
			return part.manual;
		case 'semicircular':
			return !part.on;
		default:
			return false;
	}
}
