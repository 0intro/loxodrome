/* The closed-form nomogram geometry: the reading path must agree exactly
 * with computeClosedFormPerformance (the chart shows the dry-paved figure;
 * surface factors stay table rows), clamp flags must fire outside the drawn
 * domain, and the guide fans must stay monotone inside the y domain. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAircraftYaml, type ClosedFormPerformance } from '$lib/aircraft/schema';
import { computeClosedFormPerformance, type PerfConditions } from '$lib/aircraft/performance';
import { nomogramModel, niceStep, type NomogramMetric } from '$lib/aircraft/performanceChart';

const yaml = readFileSync(new URL('../public/data/aircraft/f-gieq.yaml', import.meta.url), 'utf-8');
const perf = parseAircraftYaml(yaml).performance as ClosedFormPerformance;
const KG_PER_LB = 1 / 2.20462;

const dry = { grass: false, wet: false };
const CASES: PerfConditions[] = [
	{ massKg: 954, pressureAltFt: 359, temperatureC: 11, headwindKt: 0, surface: dry },
	{ massKg: 2325 * KG_PER_LB, pressureAltFt: 1500, temperatureC: 27, headwindKt: 15, surface: dry },
	{ massKg: 2175 * KG_PER_LB, pressureAltFt: 500, temperatureC: 38, headwindKt: -7, surface: dry },
	{ massKg: 900, pressureAltFt: 2200, temperatureC: -5, headwindKt: 4, surface: { grass: true, wet: true } },
];

describe('nomogramModel', () => {
	it('path exit equals the evaluator (modulo surface factors)', () => {
		for (const config of perf.configs) {
			for (const metric of ['groundRoll', 'distance15m'] as NomogramMetric[]) {
				for (const c of CASES) {
					const model = nomogramModel(perf, config, metric, c);
					const r = computeClosedFormPerformance(perf, config, c);
					if (!r.ok) {
						throw new Error('closed form cannot fail');
					}
					const surface =
						(c.surface.grass ? perf.grassFactor : 1) * (c.surface.wet ? perf.wetFactor : 1);
					expect(model.path).not.toBeNull();
					expect(model.path!.exitM).toBeCloseTo(r.value[metric].factoredM / surface, 9);
				}
			}
		}
	});

	it('kink values: base is the PA/temp evaluation, mass applies the square law', () => {
		const config = perf.configs.find((c) => c.phase === 'takeoff' && c.flapsDeg === 25)!;
		const c = CASES[1];
		const m = nomogramModel(perf, config, 'distance15m', c);
		const [a, b, cc, d] = config.distance15m.coefficients;
		const base = (a * c.pressureAltFt + b) * c.temperatureC + (cc * c.pressureAltFt + d);
		expect(m.path!.baseM).toBeCloseTo(base, 9);
		expect(m.path!.afterMassM).toBeCloseTo(base * ((c.massKg / KG_PER_LB / 2325) ** 2), 9);
		// The drawn segments land exactly on the kink values.
		expect(m.path!.massSeg[m.path!.massSeg.length - 1].m).toBeCloseTo(m.path!.afterMassM, 9);
		expect(m.path!.windSeg[m.path!.windSeg.length - 1].m).toBeCloseTo(m.path!.exitM, 9);
	});

	it('landing config has no mass panel and no mass kink', () => {
		const landing = perf.configs.find((c) => c.phase === 'landing')!;
		const m = nomogramModel(perf, landing, 'distance15m', CASES[0]);
		expect(m.massDomainLb).toBeNull();
		expect(m.massGuides).toHaveLength(0);
		expect(m.path!.massSeg).toHaveLength(0);
		expect(m.path!.afterMassM).toBeCloseTo(m.path!.baseM, 9);
	});

	it('flags inputs beyond the drawn domain, values stay exact', () => {
		const config = perf.configs.find((c) => c.phase === 'takeoff' && c.flapsDeg === 25)!;
		const c: PerfConditions = {
			massKg: 1500 * KG_PER_LB,
			pressureAltFt: 8000,
			temperatureC: 45,
			headwindKt: 20,
			surface: dry,
		};
		const m = nomogramModel(perf, config, 'distance15m', c);
		expect(m.path!.clamped).toEqual(['temperature', 'pressure altitude', 'mass', 'wind']);
		const r = computeClosedFormPerformance(perf, config, c);
		expect(m.path!.exitM).toBeCloseTo(r.ok ? r.value.distance15m.factoredM : NaN, 9);
	});

	it('guides are monotone and the y domain covers every drawn point', () => {
		const config = perf.configs.find((c) => c.phase === 'takeoff' && c.flapsDeg === 0)!;
		const m = nomogramModel(perf, config, 'groundRoll', null);
		expect(m.path).toBeNull();
		for (const g of m.massGuides) {
			for (let i = 1; i < g.length; i++) {
				expect(g[i].m).toBeLessThanOrEqual(g[i - 1].m); // lighter = shorter
			}
		}
		for (const g of m.headGuides) {
			for (let i = 1; i < g.length; i++) {
				expect(g[i].m).toBeLessThanOrEqual(g[i - 1].m); // more headwind = shorter
			}
		}
		for (const g of m.tailGuides) {
			for (let i = 1; i < g.length; i++) {
				expect(g[i].m).toBeGreaterThanOrEqual(g[i - 1].m); // more tailwind = longer
			}
		}
		const all = [
			...m.paLines.flatMap((l) => l.points.map((p) => p.m)),
			...m.massGuides.flat().map((p) => p.m),
			...m.headGuides.flat().map((p) => p.m),
			...m.tailGuides.flat().map((p) => p.m),
		];
		for (const v of all) {
			expect(v).toBeGreaterThanOrEqual(m.yDomain[0]);
			expect(v).toBeLessThanOrEqual(m.yDomain[1]);
		}
	});

	it('a landing config with a mass term draws the mass panel (F-GIRV)', () => {
		const girvYaml = readFileSync(new URL('../public/data/aircraft/f-girv.yaml', import.meta.url), 'utf-8');
		const girv = parseAircraftYaml(girvYaml).performance as ClosedFormPerformance;
		const landing = girv.configs.find((c) => c.phase === 'landing')!;
		const c: PerfConditions = { massKg: 2264 * KG_PER_LB, pressureAltFt: 2300, temperatureC: 21, headwindKt: 5, surface: dry };
		const m = nomogramModel(girv, landing, 'groundRoll', c);
		expect(m.massDomainLb).not.toBeNull();
		expect(m.massGuides.length).toBeGreaterThan(0);
		expect(m.path!.afterMassM).toBeCloseTo(
			m.path!.baseM * ((c.massKg / KG_PER_LB / 2550) ** landing.massExponent), 9,
		);
	});
});

describe('niceStep', () => {
	it('picks 1/2/5 steps', () => {
		expect(niceStep(1000, 5)).toBe(200);
		expect(niceStep(700, 6)).toBe(200);
		expect(niceStep(90, 6)).toBe(20);
		expect(niceStep(45, 10)).toBe(5);
	});
});
