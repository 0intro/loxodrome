/* Takeoff / landing performance. Two model kinds (see $lib/aircraft/schema):
 * the POH table interpolated EXACTLY like the workbook's P worksheets
 * (successive linear interpolation: mass between the max / min columns, then
 * altitude on the pressure altitude between the table bands, then
 * temperature anchored at ISA(PA) + the table offsets, extrapolating past
 * the ends with the nearest slope and flagging it), and the fitted
 * closed-form model (metres directly, continuous per-knot wind). Then the
 * factor pipeline (headwind factor interpolated through the POH anchors,
 * tailwind percent per 2 kt, grass, wet, and the x1.3 margin) and the
 * runway verdicts against the per-direction declared distances
 * (TORA / TODA / LDA, falling back to the physical length; the fallbacks
 * are flagged `assumed` so the UI can surface them). Pure. */

import type { Runway } from '$lib/data/airports';
import type {
	ClosedFormConfig,
	ClosedFormPerformance,
	HeadwindFactorTable,
	PerfTable,
	TablePerformance,
} from './schema';

export const FT_PER_HPA = 28;
export const FT_TO_M = 0.3048;
/** The workbook's constant; keep it exact so the pinned figures reproduce. */
export const KG_TO_LB = 2.20462;

/** Pressure altitude from the field elevation and the QNH (1 hPa = 28 ft). */
export function pressureAltitudeFt(elevationFt: number, qnhHpa: number | null): number {
	return qnhHpa == null ? elevationFt : elevationFt + (1013 - qnhHpa) * FT_PER_HPA;
}

/** ISA temperature at a pressure altitude: 15 - 2 deg per 1000 ft. */
export function isaTemperatureC(pressureAltFt: number): number {
	return 15 - (2 * pressureAltFt) / 1000;
}

export type PerfPhase = 'takeoff' | 'landing';

export interface RawDistances {
	groundRollM: number;
	distance15mM: number;
}

export interface InterpolationFlags {
	/** Mass outside [massMinKg, massMaxKg]. */
	massExtrapolated: boolean;
	/** Pressure altitude below the first table altitude. */
	altitudeExtrapolatedBelow: boolean;
	/** Temperature outside ISA(PA) + [first, last] offset (the sheet's orange). */
	temperatureExtrapolated: boolean;
}

const NO_FLAGS: InterpolationFlags = {
	massExtrapolated: false,
	altitudeExtrapolatedBelow: false,
	temperatureExtrapolated: false,
};

export type TableInterpolation =
	| { ok: true; distances: RawDistances; flags: InterpolationFlags }
	| { ok: false; reason: 'pressure-altitude-above-table'; maxAltFt: number };

/** Linear interpolation through (x0, y0) and (x1, y1), in the workbook's
 *  algebraic form so the figures reproduce bit-for-bit. */
function lerpAt(x0: number, y0: number, x1: number, y1: number, x: number): number {
	const s = (y0 - y1) / (x0 - x1);
	return s * x - (s * x1 - y1);
}

/** The band [i, i+1] containing x; below the first anchor the first band
 *  (extrapolating), above the last the last band. Anchors ascending. */
function bandIndex(anchors: number[], x: number): number {
	let i = 0;
	while (i + 2 < anchors.length && x >= anchors[i + 1]) {
		i++;
	}
	return i;
}

/** One metric through the three interpolation steps of the P worksheets. */
function interpolateMetric(
	table: PerfTable,
	cell: 0 | 1,
	massMaxKg: number,
	massMinKg: number,
	massKg: number,
	pressureAltFt: number,
	temperatureC: number,
): number {
	const { altitudesFt, isaOffsetsC, rows } = table;
	const value = (altFt: number, isaOffsetC: number): number => {
		const row = rows.find((r) => r.altFt === altFt && r.isaOffsetC === isaOffsetC)!;
		// Step 1: mass, between the mass-max and mass-min columns.
		return lerpAt(massMaxKg, row.massMax[cell], massMinKg, row.massMin[cell], massKg);
	};
	// Step 2: altitude, within the band holding the pressure altitude (the
	// first band extrapolates below the table; above is the caller's error).
	const ai = bandIndex(altitudesFt, pressureAltFt);
	const atAlt = (isaOffsetC: number): number =>
		lerpAt(
			altitudesFt[ai],
			value(altitudesFt[ai], isaOffsetC),
			altitudesFt[ai + 1],
			value(altitudesFt[ai + 1], isaOffsetC),
			pressureAltFt,
		);
	// Step 3: temperature, anchored at ISA(PA) + the table offsets; past the
	// ends the nearest band's slope extends (the workbook's deliberate
	// extrapolation, flagged by the caller).
	const isa = isaTemperatureC(pressureAltFt);
	const anchors = isaOffsetsC.map((o) => isa + o);
	const ti = bandIndex(anchors, temperatureC);
	return lerpAt(
		anchors[ti],
		atAlt(isaOffsetsC[ti]),
		anchors[ti + 1],
		atAlt(isaOffsetsC[ti + 1]),
		temperatureC,
	);
}

/** Raw POH distances at (mass, pressure altitude, temperature); the exact
 *  P-worksheet successive linear interpolation, no closed-form shortcut. */
export function interpolateTable(
	perf: TablePerformance,
	phase: PerfPhase,
	massKg: number,
	pressureAltFt: number,
	temperatureC: number,
): TableInterpolation {
	const table = perf[phase];
	const maxAltFt = table.altitudesFt[table.altitudesFt.length - 1];
	if (pressureAltFt > maxAltFt) {
		return { ok: false, reason: 'pressure-altitude-above-table', maxAltFt };
	}
	const isa = isaTemperatureC(pressureAltFt);
	const flags: InterpolationFlags = {
		massExtrapolated: massKg < perf.massMinKg || massKg > perf.massMaxKg,
		altitudeExtrapolatedBelow: pressureAltFt < table.altitudesFt[0],
		temperatureExtrapolated:
			temperatureC < isa + table.isaOffsetsC[0] ||
			temperatureC > isa + table.isaOffsetsC[table.isaOffsetsC.length - 1],
	};
	const at = (cell: 0 | 1): number =>
		interpolateMetric(table, cell, perf.massMaxKg, perf.massMinKg, massKg, pressureAltFt, temperatureC);
	return { ok: true, distances: { groundRollM: at(0), distance15mM: at(1) }, flags };
}

export interface SurfaceInput {
	grass: boolean;
	wet: boolean;
}

/** Piecewise-linear headwind factor through the POH anchors, clamped past
 *  the last one (the workbook only accepted exactly 0 / 10 / 20 / 30 kt). */
export function headwindFactor(factors: HeadwindFactorTable, headwindKt: number): number {
	if (headwindKt <= 0) {
		return 1;
	}
	const last = factors[factors.length - 1];
	if (headwindKt >= last[0]) {
		return last[1];
	}
	for (let i = 0; i + 1 < factors.length; i++) {
		const [k0, f0] = factors[i];
		const [k1, f1] = factors[i + 1];
		if (headwindKt <= k1) {
			return lerpAt(k0, f0, k1, f1, headwindKt);
		}
	}
	return last[1];
}

/** Wind + surface factor for the table model. headwindKt is signed
 *  (negative = tailwind: + tailwindPctPer2Kt percent per 2 kt, continuous). */
export function tableWindSurfaceFactor(
	perf: TablePerformance,
	phase: PerfPhase,
	headwindKt: number,
	surface: SurfaceInput,
): number {
	const anchors = phase === 'takeoff' ? perf.wind.takeoffHeadwind : perf.wind.landingHeadwind;
	const wind =
		headwindKt >= 0
			? headwindFactor(anchors, headwindKt)
			: 1 + ((perf.wind.tailwindPctPer2Kt / 100) * -headwindKt) / 2;
	return wind * (surface.grass ? perf.grassFactor : 1) * (surface.wet ? perf.wetFactor : 1);
}

export interface PerformanceFigure {
	/** The interpolated / fitted distance before wind and surface. */
	rawM: number;
	/** After wind + surface (the workbook's DF 15m / Roulage rows). */
	factoredM: number;
	/** factoredM x marginFactor (the "Marge +30%" rows). */
	withMarginM: number;
}

export interface PerfConditions {
	massKg: number;
	pressureAltFt: number;
	temperatureC: number;
	/** Signed: positive headwind, negative tailwind. */
	headwindKt: number;
	surface: SurfaceInput;
}

export interface PerfComputation {
	groundRoll: PerformanceFigure;
	distance15m: PerformanceFigure;
	/** Closed-form models never extrapolate (all false). */
	flags: InterpolationFlags;
}

export type PerfResult =
	| { ok: true; value: PerfComputation }
	| { ok: false; reason: 'pressure-altitude-above-table'; maxAltFt: number };

export function computeTablePerformance(
	perf: TablePerformance,
	phase: PerfPhase,
	c: PerfConditions,
): PerfResult {
	const raw = interpolateTable(perf, phase, c.massKg, c.pressureAltFt, c.temperatureC);
	if (!raw.ok) {
		return raw;
	}
	const factor = tableWindSurfaceFactor(perf, phase, c.headwindKt, c.surface);
	const figure = (rawM: number): PerformanceFigure => {
		const factoredM = rawM * factor;
		return { rawM, factoredM, withMarginM: factoredM * perf.marginFactor };
	};
	return {
		ok: true,
		value: {
			groundRoll: figure(raw.distances.groundRollM),
			distance15m: figure(raw.distances.distance15mM),
			flags: raw.flags,
		},
	};
}

/** The closed-form evaluator: metres from the fitted coefficients, the mass
 *  law when the config carries one, the per-knot wind, then grass / wet. */
export function computeClosedFormPerformance(
	perf: ClosedFormPerformance,
	config: ClosedFormConfig,
	c: PerfConditions,
): PerfResult {
	const massFactor =
		config.massExponent > 0
			? ((c.massKg * KG_TO_LB) / perf.massReferenceLb) ** config.massExponent
			: 1;
	const surfaceFactor =
		(c.surface.grass ? perf.grassFactor : 1) * (c.surface.wet ? perf.wetFactor : 1);
	const figure = (m: typeof config.distance15m): PerformanceFigure => {
		const [a, b, cc, d] = m.coefficients;
		const base = (a * c.pressureAltFt + b) * c.temperatureC + (cc * c.pressureAltFt + d);
		const wind =
			c.headwindKt >= 0
				? Math.max(0, 1 - m.headwindPerKt * c.headwindKt)
				: 1 + m.tailwindPerKt * -c.headwindKt;
		const factoredM = base * massFactor * wind * surfaceFactor;
		return { rawM: base * massFactor, factoredM, withMarginM: factoredM * perf.marginFactor };
	};
	return {
		ok: true,
		value: {
			groundRoll: figure(config.groundRoll),
			distance15m: figure(config.distance15m),
			flags: NO_FLAGS,
		},
	};
}

/** The config driving the runway verdict: the one marked default for the
 *  phase, else the phase's last config. */
export function verdictConfig(
	perf: ClosedFormPerformance,
	phase: PerfPhase,
): ClosedFormConfig | null {
	const ofPhase = perf.configs.filter((c) => c.phase === phase);
	if (ofPhase.length === 0) {
		return null;
	}
	return ofPhase.find((c) => c.default) ?? ofPhase[ofPhase.length - 1];
}

/** Which declared distances were assumed from the physical runway length
 *  (true = unpublished, fallback substituted). */
export interface AssumedDistances {
	tora: boolean;
	toda: boolean;
	asda: boolean;
	lda: boolean;
}

export interface DeclaredDistancesM {
	toraM: number | null;
	todaM: number | null;
	asdaM: number | null;
	ldaM: number | null;
	/** Which distances fell back to the physical length because the dataset
	 *  publishes none; absent = nothing assumed (a hand-built record). For
	 *  LDA / TORA the assumption can be anti-conservative (a displaced
	 *  threshold or stopway shortens the real figure below the physical
	 *  length), so consumers flag it. */
	assumed?: AssumedDistances;
}

/** Per-direction declared distances in metres; each falls back to the
 *  physical runway length when the publisher doesn't list it, `assumed`
 *  recording which ones did (only when a value was actually substituted:
 *  no length = the distance stays null, not assumed). */
export function declaredDistancesM(runway: Runway, end: 'le' | 'he'): DeclaredDistancesM {
	const m = (ft: number | null): number | null => (ft == null ? null : ft * FT_TO_M);
	const fallback = m(runway.lengthFt);
	const pick = (ft: number | null): number | null => m(ft) ?? fallback;
	const isAssumed = (ft: number | null): boolean => ft == null && fallback != null;
	return end === 'le'
		? {
				toraM: pick(runway.leToraFt),
				todaM: pick(runway.leTodaFt),
				asdaM: pick(runway.leAsdaFt),
				ldaM: pick(runway.leLdaFt),
				assumed: {
					tora: isAssumed(runway.leToraFt),
					toda: isAssumed(runway.leTodaFt),
					asda: isAssumed(runway.leAsdaFt),
					lda: isAssumed(runway.leLdaFt),
				},
			}
		: {
				toraM: pick(runway.heToraFt),
				todaM: pick(runway.heTodaFt),
				asdaM: pick(runway.heAsdaFt),
				ldaM: pick(runway.heLdaFt),
				assumed: {
					tora: isAssumed(runway.heToraFt),
					toda: isAssumed(runway.heTodaFt),
					asda: isAssumed(runway.heAsdaFt),
					lda: isAssumed(runway.heLdaFt),
				},
			};
}

export interface TakeoffVerdict {
	/** Factored distance over 15 m >= TODA (the workbook's "Limitative ?"). */
	todaLimiting: boolean | null;
	/** Factored ground roll >= TORA. */
	toraLimiting: boolean | null;
	/** Any known check limiting; null when none is known. */
	limiting: boolean | null;
}

export function takeoffVerdict(factored: RawDistances, dd: DeclaredDistancesM): TakeoffVerdict {
	const todaLimiting = dd.todaM == null ? null : factored.distance15mM >= dd.todaM;
	const toraLimiting = dd.toraM == null ? null : factored.groundRollM >= dd.toraM;
	const known = [todaLimiting, toraLimiting].filter((v): v is boolean => v !== null);
	return {
		todaLimiting,
		toraLimiting,
		limiting: known.length ? known.some(Boolean) : null,
	};
}

export interface LandingVerdict {
	/** Factored distance from 15 m >= LDA. */
	ldaLimiting: boolean | null;
	/** Landing without flaps still fits: distance x factor < LDA. */
	flaplessFeasible: boolean | null;
}

export function landingVerdict(
	factoredDistance15mM: number,
	dd: DeclaredDistancesM,
	flaplessLandingFactor: number | null,
): LandingVerdict {
	const ldaLimiting = dd.ldaM == null ? null : factoredDistance15mM >= dd.ldaM;
	const flaplessFeasible =
		dd.ldaM == null || flaplessLandingFactor == null
			? null
			: factoredDistance15mM * flaplessLandingFactor < dd.ldaM;
	return { ldaLimiting, flaplessFeasible };
}
