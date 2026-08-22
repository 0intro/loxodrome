/* Geometry for the closed-form performance nomogram: the manual-style
 * chained chart (temperature x pressure-altitude lines -> mass guides ->
 * wind guides, sharing the distance axis) plus the reading path
 * of the current conditions. Pure (no Svelte); the SVG component consumes
 * the value-space output and only maps values to pixels. The exit value is
 * the dry-paved figure, exactly `factoredM` divided by the surface factors
 * (spec-pinned), the manual's own chart conditions. */

import type { ClosedFormConfig, ClosedFormMetric, ClosedFormPerformance } from './schema';
import { KG_TO_LB, type PerfConditions } from './performance';

export type NomogramMetric = 'groundRoll' | 'distance15m';

/** Chart inputs a reading path can clamp: canonical tokens (spec-pinned),
 *  translated at render (t.flightprep.clampTokens). */
export type NomogramClampToken = 'temperature' | 'pressure altitude' | 'mass' | 'wind';

export interface NomogramPoint {
	/** Panel-local x in value space (deg C, lb, or kt). */
	x: number;
	/** Distance, metres. */
	m: number;
}

export interface NomogramPath {
	/** Temperature rise, PA interpolation point. */
	tempC: number;
	baseM: number;
	/** After the mass guide (equals baseM for configs without a mass term). */
	afterMassM: number;
	/** The dry-paved result after the wind guide. */
	exitM: number;
	/** Mass guide samples (lb -> m); empty without a mass panel. */
	massSeg: NomogramPoint[];
	/** Wind guide samples (kt -> m); single point when calm. */
	windSeg: NomogramPoint[];
	/** Signed wind: positive headwind (solid grid), negative tailwind. */
	windKt: number;
	massLb: number;
	/** Inputs drawn clamped to the chart domain (values stay exact). */
	clamped: NomogramClampToken[];
}

export interface NomogramModel {
	tempDomainC: readonly [number, number];
	paLinesFt: readonly number[];
	/** One [start, end] pair per PA line, x = deg C. */
	paLines: { paFt: number; points: [NomogramPoint, NomogramPoint] }[];
	/** lb domain [reference .. low]; null when the config has no mass term. */
	massDomainLb: readonly [number, number] | null;
	massGuides: NomogramPoint[][];
	/** Signed kt domain [tail max (negative) .. head max]. */
	windDomainKt: readonly [number, number];
	headGuides: NomogramPoint[][];
	tailGuides: NomogramPoint[][];
	path: NomogramPath | null;
	/** Distance domain covering every drawn point, padded. */
	yDomain: readonly [number, number];
}

const TEMP_DOMAIN: readonly [number, number] = [-25, 40];
const PA_LINES = [0, 2000, 4000, 6000] as const;
const MASS_LOW_LB = 1600;
const HEAD_MAX_KT = 15;
const TAIL_MAX_KT = 10;
const GUIDES = 6;

function base(metric: ClosedFormMetric, paFt: number, tempC: number): number {
	const [a, b, c, d] = metric.coefficients;
	return (a * paFt + b) * tempC + (c * paFt + d);
}

function massFactor(perf: ClosedFormPerformance, exponent: number, lb: number): number {
	return (lb / perf.massReferenceLb) ** exponent;
}

function windFactor(metric: ClosedFormMetric, signedKt: number): number {
	return signedKt >= 0
		? Math.max(0, 1 - metric.headwindPerKt * signedKt)
		: 1 + metric.tailwindPerKt * -signedKt;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function sampled(x0: number, x1: number, n: number, f: (x: number) => number): NomogramPoint[] {
	const out: NomogramPoint[] = [];
	for (let i = 0; i <= n; i++) {
		const x = x0 + ((x1 - x0) * i) / n;
		out.push({ x, m: f(x) });
	}
	return out;
}

export function nomogramModel(
	perf: ClosedFormPerformance,
	config: ClosedFormConfig,
	metricKey: NomogramMetric,
	conditions: PerfConditions | null,
): NomogramModel {
	const metric = config[metricKey];
	const ref = perf.massReferenceLb;
	const hasMass = config.massExponent > 0;

	const paLines = PA_LINES.map((paFt) => ({
		paFt,
		points: [
			{ x: TEMP_DOMAIN[0], m: base(metric, paFt, TEMP_DOMAIN[0]) },
			{ x: TEMP_DOMAIN[1], m: base(metric, paFt, TEMP_DOMAIN[1]) },
		] as [NomogramPoint, NomogramPoint],
	}));

	// Guide fans: entries spread over the panel-1 output range.
	const corners = paLines.flatMap((l) => l.points.map((p) => p.m));
	const lo = Math.min(...corners);
	const hi = Math.max(...corners);
	const entries = Array.from({ length: GUIDES }, (_, i) => lo + ((hi - lo) * i) / (GUIDES - 1));

	const massGuides = hasMass
		? entries.map((e) => sampled(ref, MASS_LOW_LB, 12, (lb) => e * massFactor(perf, config.massExponent, lb)))
		: [];
	// Wind guides start from the post-mass value range: same entry spread is
	// representative (the fan covers the panel either way).
	const headGuides = entries.map((e) => sampled(0, HEAD_MAX_KT, 6, (w) => e * windFactor(metric, w)));
	const tailGuides = entries.map((e) =>
		sampled(0, TAIL_MAX_KT, 6, (w) => e * windFactor(metric, -w)),
	);

	let path: NomogramPath | null = null;
	if (conditions) {
		const clamped: NomogramClampToken[] = [];
		const tempC = clamp(conditions.temperatureC, TEMP_DOMAIN[0], TEMP_DOMAIN[1]);
		if (tempC !== conditions.temperatureC) clamped.push('temperature');
		const paFt = clamp(conditions.pressureAltFt, 0, PA_LINES[PA_LINES.length - 1]);
		// i18n-ignore: canonical clamp token (NomogramClampToken), translated at render
		if (paFt !== conditions.pressureAltFt) clamped.push('pressure altitude');
		const massLbTrue = conditions.massKg * KG_TO_LB;
		const massLb = hasMass ? clamp(massLbTrue, MASS_LOW_LB, ref) : massLbTrue;
		if (hasMass && massLb !== massLbTrue) clamped.push('mass');
		const windTrue = conditions.headwindKt;
		const windKt = clamp(windTrue, -TAIL_MAX_KT, HEAD_MAX_KT);
		if (windKt !== windTrue) clamped.push('wind');

		// Values are EXACT (unclamped inputs); only the drawn x positions clamp.
		const baseM = base(metric, conditions.pressureAltFt, conditions.temperatureC);
		const mf = hasMass ? massFactor(perf, config.massExponent, massLbTrue) : 1;
		const afterMassM = baseM * mf;
		const exitM = afterMassM * windFactor(metric, windTrue);
		const massSeg = hasMass
			? sampled(ref, massLb, 10, (lb) => baseM * massFactor(perf, config.massExponent, lb))
			: [];
		if (hasMass && massSeg.length > 0) {
			massSeg[massSeg.length - 1].m = afterMassM;
		}
		const windSeg =
			windKt >= 0
				? sampled(0, windKt, Math.max(1, Math.ceil(windKt)), (w) => afterMassM * windFactor(metric, w))
				: sampled(0, windKt, Math.max(1, Math.ceil(-windKt)), (w) => afterMassM * windFactor(metric, w));
		if (windSeg.length > 0) {
			windSeg[windSeg.length - 1].m = exitM;
		}
		path = { tempC, baseM, afterMassM, exitM, massSeg, windSeg, windKt, massLb, clamped };
	}

	const drawn = [
		...corners,
		...massGuides.flat().map((p) => p.m),
		...headGuides.flat().map((p) => p.m),
		...tailGuides.flat().map((p) => p.m),
		...(path ? [path.baseM, path.afterMassM, path.exitM] : []),
	];
	const dLo = Math.min(...drawn);
	const dHi = Math.max(...drawn);
	const pad = (dHi - dLo || 100) * 0.06;
	const yDomain: readonly [number, number] = [Math.max(0, dLo - pad), dHi + pad];

	return {
		tempDomainC: TEMP_DOMAIN,
		paLinesFt: PA_LINES,
		paLines,
		massDomainLb: hasMass ? [ref, MASS_LOW_LB] : null,
		massGuides,
		windDomainKt: [-TAIL_MAX_KT, HEAD_MAX_KT],
		headGuides,
		tailGuides,
		path,
		yDomain,
	};
}

/** A nice 1/2/5 step covering the span with about n ticks. */
export function niceStep(span: number, n: number): number {
	const raw = span / Math.max(1, n);
	const mag = 10 ** Math.floor(Math.log10(raw));
	for (const mult of [1, 2, 5, 10]) {
		if (raw <= mult * mag) {
			return mult * mag;
		}
	}
	return 10 * mag;
}
