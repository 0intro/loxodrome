/* Takeoff / landing performance (src/lib/aircraft/performance.ts), pinned to
 * the source workbook: the P1 worksheet's trilinear interpolation for the
 * DR400 table and the PA28-161 closed-form fits. The DR400 pins feed mass
 * 741.1 kg: the sheet's M&B uses its stored density 0.721, so P1 reads
 * 741.1, not 741.0; pinning that input keeps the 367 m figure reproducible. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAircraftYaml, type TablePerformance, type ClosedFormPerformance } from '$lib/aircraft/schema';
import {
	pressureAltitudeFt,
	isaTemperatureC,
	interpolateTable,
	headwindFactor,
	tableWindSurfaceFactor,
	computeTablePerformance,
	computeClosedFormPerformance,
	referenceConfig,
	procedureOrder,
	pickTakeoff,
	pickRank,
	statesTakeoffConfig,
	shortFieldFlapsDeg,
	declaredDistancesM,
	takeoffVerdict,
	landingVerdict,
	flaplessFeasible,
	type DeclaredDistancesM,
	type PerfConditions,
	type PerformanceFigure,
} from '$lib/aircraft/performance';
import type { Runway } from '$lib/data/airports';

function load(file: string) {
	return parseAircraftYaml(
		readFileSync(new URL(`../public/data/aircraft/${file}`, import.meta.url), 'utf-8'),
	);
}

// F-GORQ is the unconverted DR400/120 (900 kg POH table); its sister F-GJQK
// re-engined to the 912iSc, capping the same table at 865 kg.
const dr400 = load('f-gorq.yaml').performance as TablePerformance;
const pa28 = load('f-gieq.yaml').performance as ClosedFormPerformance;

const CALM: Pick<PerfConditions, 'headwindKt' | 'surface'> = {
	headwindKt: 0,
	surface: { grass: false, wet: false },
};

/** A figure the way the page computes it: corrected, then x1.3. */
const fig = (correctedM: number): PerformanceFigure => ({ rawM: correctedM, correctedM, requiredM: correctedM * 1.3 });
const dd = (toraM: number | null, todaM: number | null, ldaM: number | null = null): DeclaredDistancesM => ({
	toraM,
	todaM,
	asdaM: null,
	ldaM,
});

describe('pressure altitude / ISA', () => {
	it('matches the workbook (28 ft per hPa)', () => {
		expect(pressureAltitudeFt(359, 1019)).toBe(191); // LFPL at QNH 1019
		expect(pressureAltitudeFt(906, 1019)).toBe(738); // LFQH
		expect(pressureAltitudeFt(100, null)).toBe(100);
		expect(isaTemperatureC(191)).toBeCloseTo(14.618, 6);
		expect(isaTemperatureC(0)).toBe(15);
	});
});

describe('interpolateTable (the P1 worksheet, exactly)', () => {
	it('returns the POH anchors exactly at a grid point', () => {
		const r = interpolateTable(dr400, 'takeoff', 900, 0, 15);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.distances.groundRollM).toBeCloseTo(235, 9);
			expect(r.distances.distance15mM).toBeCloseTo(535, 9);
			expect(r.flags).toEqual({
				massExtrapolated: false,
				altitudeExtrapolatedBelow: false,
				temperatureExtrapolated: false,
			});
		}
	});

	it('pins the LFPL takeoff cell (mass 741.1, PA 191, T 15)', () => {
		const r = interpolateTable(dr400, 'takeoff', 741.1, 191, 15);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.distances.groundRollM).toBeCloseTo(166.97, 2); // sheet 167
			expect(r.distances.distance15mM).toBeCloseTo(366.51, 2); // sheet 367
		}
	});

	it('pins the LFPL landing cell (T 11, below ISA: cold band)', () => {
		const r = interpolateTable(dr400, 'landing', 741.1, 191, 11);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.distances.groundRollM).toBeCloseTo(163.21, 2); // sheet 163
			expect(r.distances.distance15mM).toBeCloseTo(398.33, 2); // sheet 398
		}
	});

	it('extrapolates temperature past ISA+20 with the warm slope, flagged', () => {
		const r = interpolateTable(dr400, 'takeoff', 741.1, 191, 40);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.distances.distance15mM).toBeCloseTo(411.45, 2);
			expect(r.flags.temperatureExtrapolated).toBe(true);
		}
	});

	it('extrapolates below sea level (LFAT-style), flagged; errors above the table', () => {
		const below = interpolateTable(dr400, 'takeoff', 741.1, -147, 15);
		expect(below.ok).toBe(true);
		if (below.ok) {
			expect(below.flags.altitudeExtrapolatedBelow).toBe(true);
			expect(below.distances.distance15mM).toBeLessThan(366.51);
		}
		const above = interpolateTable(dr400, 'takeoff', 741.1, 9000, 15);
		expect(above.ok).toBe(false);
		if (!above.ok) {
			expect(above.reason).toBe('pressure-altitude-above-table');
			expect(above.maxAltFt).toBe(8000);
		}
	});

	it('flags mass outside the table columns', () => {
		const r = interpolateTable(dr400, 'takeoff', 950, 0, 15);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.flags.massExtrapolated).toBe(true);
		}
	});
});

describe('wind and surface factors', () => {
	it('interpolates the headwind factor and clamps past the last anchor', () => {
		const t = dr400.wind.takeoffHeadwind;
		expect(headwindFactor(t, 0)).toBe(1);
		expect(headwindFactor(t, 10)).toBeCloseTo(0.85, 9);
		expect(headwindFactor(t, 15)).toBeCloseTo(0.75, 9);
		expect(headwindFactor(t, 30)).toBeCloseTo(0.55, 9);
		expect(headwindFactor(t, 35)).toBeCloseTo(0.55, 9);
		expect(headwindFactor(dr400.wind.landingHeadwind, 10)).toBeCloseTo(0.78, 9);
	});

	it('applies tailwind (10 percent per 2 kt) and grass / wet', () => {
		expect(
			tableWindSurfaceFactor(dr400, 'takeoff', -5, { grass: false, wet: false }),
		).toBeCloseTo(1.25, 9);
		expect(
			tableWindSurfaceFactor(dr400, 'takeoff', 0, { grass: true, wet: true }),
		).toBeCloseTo(1.3225, 9);
	});
});

describe('computeTablePerformance', () => {
	it('pins the LFPL takeoff column (calm, paved, dry)', () => {
		const r = computeTablePerformance(dr400, 'takeoff', {
			massKg: 741.1, pressureAltFt: 191, temperatureC: 15, ...CALM,
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.groundRoll.correctedM).toBeCloseTo(166.97, 2); // sheet 167
			expect(r.value.groundRoll.requiredM).toBeCloseTo(217.07, 2); // 217
			expect(r.value.distance15m.correctedM).toBeCloseTo(366.51, 2); // 367
			expect(r.value.distance15m.requiredM).toBeCloseTo(476.46, 2); // 476
		}
	});

	it('pins the LFQH takeoff column (grass)', () => {
		const r = computeTablePerformance(dr400, 'takeoff', {
			massKg: 741.1, pressureAltFt: 738, temperatureC: 15,
			headwindKt: 0, surface: { grass: true, wet: false },
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.distance15m.rawM).toBeCloseTo(384.71, 2);
			expect(r.value.distance15m.correctedM).toBeCloseTo(442.41, 2); // sheet 442
			expect(r.value.distance15m.requiredM).toBeCloseTo(575.14, 2); // 575
		}
	});

	it('pins the LFPL landing column (T 11)', () => {
		const r = computeTablePerformance(dr400, 'landing', {
			massKg: 741.1, pressureAltFt: 191, temperatureC: 11, ...CALM,
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.groundRoll.correctedM).toBeCloseTo(163.21, 2); // sheet 163
			expect(r.value.distance15m.correctedM).toBeCloseTo(398.33, 2); // 398
			expect(r.value.distance15m.requiredM).toBeCloseTo(517.84, 2); // 518
		}
	});
});

describe('computeClosedFormPerformance (PA28-161)', () => {
	const at = (flapsDeg: number, phase: 'takeoff' | 'landing', c: PerfConditions) => {
		const config = pa28.configs.find((x) => x.phase === phase && x.flapsDeg === flapsDeg)!;
		const r = computeClosedFormPerformance(pa28, config, c);
		if (!r.ok) {
			throw new Error('closed form cannot fail');
		}
		return r.value;
	};
	const LFPL: PerfConditions = { massKg: 954, pressureAltFt: 359, temperatureC: 11, ...CALM };
	const KG_PER_LB = 1 / 2.20462;

	// The 2026-06 re-fit from the manual's takeoff nomograms (see the data
	// sheet comment): distances grew 9-49% over the workbook's original
	// optimistic fits at this column. Landing kept the workbook fit.
	it('pins the LFPL column at 954 kg (QNH 1013)', () => {
		expect(at(0, 'takeoff', LFPL).distance15m.correctedM).toBeCloseTo(435.8, 1);
		expect(at(0, 'takeoff', LFPL).groundRoll.correctedM).toBeCloseTo(248.9, 1);
		expect(at(25, 'takeoff', LFPL).distance15m.correctedM).toBeCloseTo(376.1, 1);
		expect(at(25, 'takeoff', LFPL).groundRoll.correctedM).toBeCloseTo(245.7, 1);
		expect(at(40, 'landing', LFPL).distance15m.correctedM).toBeCloseTo(330.5, 1); // sheet 331
		expect(at(40, 'landing', LFPL).groundRoll.correctedM).toBeCloseTo(168.7, 1); // 169
		expect(at(40, 'landing', LFPL).distance15m.requiredM).toBeCloseTo(429.7, 1);
	});

	it('pins the LFQH column (PA 906, T 12)', () => {
		const c: PerfConditions = { massKg: 954, pressureAltFt: 906, temperatureC: 12, ...CALM };
		expect(at(0, 'takeoff', c).distance15m.correctedM).toBeCloseTo(488.5, 1);
	});

	// The manual's printed worked examples (Cadet VB-1375 figs 5-7/5-9/5-11/
	// 5-13; identical on the Warrior II VB-836 charts the fit was digitized
	// from). Full-path anchors: base x mass^2 x headwind.
	it('reproduces the manual takeoff worked examples within 5%', () => {
		const dry = { grass: false, wet: false };
		const cases: Array<[number, 'takeoff', PerfConditions, number]> = [
			[0, 'takeoff', { massKg: 2325 * KG_PER_LB, pressureAltFt: 1500, temperatureC: 27, headwindKt: 15, surface: dry }, 351],
			[0, 'takeoff', { massKg: 2325 * KG_PER_LB, pressureAltFt: 500, temperatureC: 38, headwindKt: 15, surface: dry }, 640],
			[25, 'takeoff', { massKg: 2175 * KG_PER_LB, pressureAltFt: 1500, temperatureC: 27, headwindKt: 15, surface: dry }, 297],
			[25, 'takeoff', { massKg: 2175 * KG_PER_LB, pressureAltFt: 1500, temperatureC: 27, headwindKt: 15, surface: dry }, 488],
		];
		// Examples 0 and 2 are ground-roll figures, 1 and 3 over-50 ft.
		for (const [i, [flaps, phase, cond, manualM]] of cases.entries()) {
			const r = at(flaps, phase, cond);
			const got = i % 2 === 1 ? r.distance15m.correctedM : r.groundRoll.correctedM;
			expect(Math.abs(got - manualM) / manualM).toBeLessThan(0.05);
		}
	});

	it('reproduces the manual landing worked example (fig 5-35)', () => {
		const cond: PerfConditions = { massKg: 2325 * KG_PER_LB, pressureAltFt: 2500, temperatureC: 24, headwindKt: 0, surface: { grass: false, wet: false } };
		const r = at(40, 'landing', cond);
		expect(Math.abs(r.distance15m.correctedM - 363) / 363).toBeLessThan(0.05);
		expect(Math.abs(r.groundRoll.correctedM - 201) / 201).toBeLessThan(0.06);
	});

	it('applies the continuous per-knot wind factors', () => {
		const calm = at(0, 'takeoff', LFPL).distance15m.correctedM;
		const head = at(0, 'takeoff', { ...LFPL, headwindKt: 10 });
		expect(head.distance15m.correctedM).toBeCloseTo(calm * (1 - 0.0121 * 10), 6);
		expect(head.groundRoll.correctedM).toBeCloseTo(at(0, 'takeoff', LFPL).groundRoll.correctedM * (1 - 0.0144 * 10), 6);
		const tail = at(40, 'landing', { ...LFPL, headwindKt: -5 });
		expect(tail.distance15m.correctedM).toBeCloseTo(at(40, 'landing', LFPL).distance15m.correctedM * 1.11, 6);
	});

	it('landing has no mass term', () => {
		const light = at(40, 'landing', { ...LFPL, massKg: 800 });
		const heavy = at(40, 'landing', { ...LFPL, massKg: 1055 });
		expect(light.distance15m.correctedM).toBeCloseTo(heavy.distance15m.correctedM, 9);
	});

	it('referenceConfig is the normal take-off and the default landing', () => {
		expect(referenceConfig(pa28, 'takeoff')!.flapsDeg).toBe(0);
		expect(referenceConfig(pa28, 'landing')!.flapsDeg).toBe(40);
	});
});

describe('computeClosedFormPerformance (PA28-181 F-GIRV)', () => {
	const girv = load('f-girv.yaml').performance as ClosedFormPerformance;
	const at = (flapsDeg: number, phase: 'takeoff' | 'landing', c: PerfConditions) => {
		const config = girv.configs.find((x) => x.phase === phase && x.flapsDeg === flapsDeg)!;
		const r = computeClosedFormPerformance(girv, config, c);
		if (!r.ok) {
			throw new Error('closed form cannot fail');
		}
		return r.value;
	};
	const KG_PER_LB = 1 / 2.20462;
	const dry = { grass: false, wet: false };

	// The manual's printed worked examples (Archer II VB-1086, one per
	// chart). Full-path anchors: base x (mass/2550)^k x headwind.
	it('reproduces the four takeoff worked examples within 5%', () => {
		const cases: Array<[number, 'd15' | 'roll', number, number]> = [
			[0, 'd15', 15, 579], // fig 5-7
			[25, 'd15', 8, 567], // fig 5-9
			[0, 'roll', 8, 335], // fig 5-11
			[25, 'roll', 10, 290], // fig 5-13
		];
		for (const [flaps, metric, windKt, manualM] of cases) {
			const cond: PerfConditions = {
				massKg: 2400 * KG_PER_LB, pressureAltFt: 2000, temperatureC: 21, headwindKt: windKt, surface: dry,
			};
			const r = at(flaps, 'takeoff', cond);
			const got = metric === 'd15' ? r.distance15m.correctedM : r.groundRoll.correctedM;
			expect(Math.abs(got - manualM) / manualM).toBeLessThan(0.05);
		}
	});

	it('reproduces the landing worked examples (figs 5-35 / 5-37) within 5%', () => {
		const cond: PerfConditions = {
			massKg: 2264 * KG_PER_LB, pressureAltFt: 2300, temperatureC: 21, headwindKt: 5, surface: dry,
		};
		const r = at(40, 'landing', cond);
		expect(Math.abs(r.distance15m.correctedM - 393) / 393).toBeLessThan(0.05);
		expect(Math.abs(r.groundRoll.correctedM - 251) / 251).toBeLessThan(0.05);
	});

	// Unlike the PA28-161 sheet, the VB-1086 landing charts carry a mass
	// grid; the sheet stores its fitted exponent-1 law.
	it('landing scales with the fitted mass exponent', () => {
		const landing = girv.configs.find((c) => c.phase === 'landing')!;
		expect(landing.massExponent).toBe(1);
		const base: PerfConditions = { massKg: 1157, pressureAltFt: 0, temperatureC: 15, ...CALM };
		const heavy = at(40, 'landing', base);
		const light = at(40, 'landing', { ...base, massKg: 950 });
		expect(light.distance15m.correctedM / heavy.distance15m.correctedM).toBeCloseTo(950 / 1157, 9);
	});

	it('referenceConfig is the normal take-off (flaps 0) and the landing (flaps 40)', () => {
		expect(referenceConfig(girv, 'takeoff')!.flapsDeg).toBe(0);
		expect(referenceConfig(girv, 'landing')!.flapsDeg).toBe(40);
	});
});

describe('declared distances and runway verdicts', () => {
	const runway: Runway = {
		le: '08', he: '26', lengthFt: 2297, widthFt: 66, surface: 'GRASS', lit: false,
		leLdaFt: 3150, leToraFt: 3609, leTodaFt: 3018, leAsdaFt: 3609,
		heLdaFt: null, heToraFt: null, heTodaFt: null, heAsdaFt: null,
		leLighting: null, heLighting: null,
		lePos: null, hePos: null,
	};

	it('converts per-direction declared distances, falling back to the length', () => {
		const le = declaredDistancesM(runway, 'le');
		expect(le.todaM).toBeCloseTo(3018 * 0.3048, 6); // 919.9 m
		expect(le.toraM).toBeCloseTo(3609 * 0.3048, 6);
		expect(le.ldaM).toBeCloseTo(3150 * 0.3048, 6);
		const he = declaredDistancesM(runway, 'he');
		expect(he.todaM).toBeCloseTo(2297 * 0.3048, 6); // physical length fallback
		expect(he.ldaM).toBeCloseTo(2297 * 0.3048, 6);
		const bare = declaredDistancesM({ ...runway, lengthFt: null }, 'he');
		expect(bare.todaM).toBeNull();
	});

	it('flags fallback-derived distances as assumed (published ones never)', () => {
		// The le end publishes all four: nothing assumed.
		expect(declaredDistancesM(runway, 'le').assumed).toEqual({
			tora: false,
			toda: false,
			asda: false,
			lda: false,
		});
		// The he end publishes none: every distance is the physical length,
		// flagged assumed (anti-conservative for LDA / TORA).
		expect(declaredDistancesM(runway, 'he').assumed).toEqual({
			tora: true,
			toda: true,
			asda: true,
			lda: true,
		});
		// A partial gap flags only the missing distance.
		expect(declaredDistancesM({ ...runway, leLdaFt: null }, 'le').assumed).toEqual({
			tora: false,
			toda: false,
			asda: false,
			lda: true,
		});
		// No physical length either: the distance stays null, NOT assumed
		// (nothing was substituted).
		expect(declaredDistancesM({ ...runway, lengthFt: null }, 'he').assumed).toEqual({
			tora: false,
			toda: false,
			asda: false,
			lda: false,
		});
	});

	const failing = (v: { checks: { id: string; ok: boolean }[] }): string[] =>
		v.checks.filter((c) => !c.ok).map((c) => c.id);

	it('take-off: rule A, every check with the margin but the manual distance in the TORA', () => {
		// 400 m to 15 m, 520 m required; 200 m roll, 260 m required.
		const v = takeoffVerdict({ distance15m: fig(400), groundRoll: fig(200) }, dd(700, 700));
		expect(v.sufficient).toBe(true);
		expect(v.checks.map((c) => c.id)).toEqual(['d15-tora', 'd15-toda', 'roll-tora']);
		// Each check failing alone.
		expect(failing(takeoffVerdict({ distance15m: fig(400), groundRoll: fig(200) }, dd(390, 900)))).toEqual(['d15-tora']);
		expect(failing(takeoffVerdict({ distance15m: fig(400), groundRoll: fig(200) }, dd(900, 510)))).toEqual(['d15-toda']);
		expect(failing(takeoffVerdict({ distance15m: fig(300), groundRoll: fig(250) }, dd(320, 900)))).toEqual(['roll-tora']);
	});

	it('take-off: equal is not enough', () => {
		const v = takeoffVerdict({ distance15m: fig(400), groundRoll: fig(100) }, dd(900, 520));
		expect(v.sufficient).toBe(false);
		expect(failing(v)).toEqual(['d15-toda']);
	});

	it('take-off: the clearway holds the margin, never the manual distance (LFBJ 07, LFEA 06)', () => {
		// F-GORQ at 900 kg, 25 C, calm at LFBJ 07: TORA 585 = the runway,
		// TODA 785. The 15 m point lies past the runway end, and with the
		// margin past the clearway too: the workbook's test said Oui, the
		// app's TODA-only test said Non, the commercial rule says no.
		const lfbj = takeoffVerdict({ distance15m: fig(613), groundRoll: fig(289) }, dd(585, 785));
		expect(lfbj.sufficient).toBe(false);
		expect(failing(lfbj)).toEqual(['d15-tora', 'd15-toda']);
		// Belle-Île 06 (TORA 660, TODA 750) on a standard day: 543 m to 15 m,
		// 706 m required, within the TODA; the 15 m point on the runway.
		expect(takeoffVerdict({ distance15m: fig(543), groundRoll: fig(240) }, dd(660, 750)).sufficient).toBe(true);
	});

	it('take-off: the margin decides at a runway with no clearway (LFPL 26, 700 m)', () => {
		// F-GORQ at 900 kg, 25 C, calm: 582 m to 15 m fits, 757 m required
		// does not.
		const v = takeoffVerdict({ distance15m: fig(582), groundRoll: fig(271) }, dd(700, 700));
		expect(v.sufficient).toBe(false);
		expect(failing(v)).toEqual(['d15-toda']);
	});

	it('take-off: an unknown distance skips its checks; none known is unknown', () => {
		expect(takeoffVerdict({ distance15m: fig(400), groundRoll: fig(200) }, dd(null, 700)).checks.map((c) => c.id)).toEqual([
			'd15-toda',
		]);
		expect(takeoffVerdict({ distance15m: fig(1), groundRoll: fig(1) }, dd(null, null)).sufficient).toBeNull();
	});

	it('landing: the distance from 15 m with the margin within the LDA', () => {
		// LFPL: 398.3 m, 517.8 m required < 700.
		expect(landingVerdict(fig(398.34), dd(null, null, 700)).sufficient).toBe(true);
		expect(landingVerdict(fig(600), dd(null, null, 700)).sufficient).toBe(false); // 780 required
		expect(landingVerdict(fig(700 / 1.3), dd(null, null, 700)).sufficient).toBe(false); // equal
		expect(landingVerdict(fig(400), dd(null, null, null)).sufficient).toBeNull();
	});

	it('flapless: the manual distance x the factor, no margin (user decision)', () => {
		// LFPL: 398.3 x 1.5 = 597.5 < 700, the sheet's "Sans volets: Oui"; with
		// the margin it would be 776.8 and read NON.
		expect(flaplessFeasible(398.34, dd(null, null, 700), 1.5)).toBe(true);
		expect(flaplessFeasible(500, dd(null, null, 700), 1.5)).toBe(false);
		expect(flaplessFeasible(398.34, dd(null, null, null), 1.5)).toBeNull();
		expect(flaplessFeasible(398.34, dd(null, null, 700), null)).toBeNull();
	});
});

describe('take-off procedures', () => {
	const row = (procedure: 'normal' | 'short-field' | null, sufficient: boolean | null, id = '') => ({
		id,
		procedure,
		verdict: sufficient == null ? null : { sufficient, checks: [] },
	});

	it('tries the normal procedure first, then the short-field one, then the untagged', () => {
		const rows = [row(null, null, 'a'), row('short-field', null, 'b'), row('normal', null, 'c'), row(null, null, 'd')];
		expect(procedureOrder(rows).map((r) => r.id)).toEqual(['c', 'b', 'a', 'd']);
	});

	it('picks the first fitting procedure and ranks it', () => {
		const normal = pickTakeoff([row('normal', true), row('short-field', true)]);
		expect(normal.status === 'fits' && normal.row.procedure).toBe('normal');
		expect(pickRank(normal)).toBe(0);
		const short = pickTakeoff([row('normal', false), row('short-field', true)]);
		expect(short.status === 'fits' && short.row.procedure).toBe('short-field');
		expect(pickRank(short)).toBe(1);
		expect(pickTakeoff([row('normal', false), row('short-field', false)])).toEqual({ status: 'none' });
		expect(pickRank(pickTakeoff([row('normal', false)]))).toBe(2);
		expect(pickTakeoff([row('normal', null), row('short-field', null)])).toEqual({ status: 'unknown' });
		expect(pickTakeoff([])).toEqual({ status: 'unknown' });
		// A sheet naming no procedure ranks 0 on any fit.
		expect(pickRank(pickTakeoff([row(null, false), row(null, true)]))).toBe(0);
	});

	it('picks the PA28-161 procedure the runway calls for (F-GIEQ, reference mass, sea level, ISA)', () => {
		const c: PerfConditions = { massKg: 2325 / 2.20462, pressureAltFt: 0, temperatureC: 15, ...CALM };
		const at = (m: number) => {
			const rows = pa28.configs
				.filter((x) => x.phase === 'takeoff')
				.map((config) => {
					const r = computeClosedFormPerformance(pa28, config, c);
					return {
						procedure: config.procedure ?? null,
						flaps: config.flapsDeg,
						verdict: r.ok ? takeoffVerdict(r.value, dd(m, m)) : null,
					};
				});
			return pickTakeoff(rows);
		};
		const flaps = (p: ReturnType<typeof at>) => (p.status === 'fits' ? p.row.flaps : p.status);
		// Required over 15 m: flaps 0 about 692 m, flaps 25 about 595 m.
		expect(flaps(at(700))).toBe(0);
		expect(flaps(at(650))).toBe(25);
		expect(pickRank(at(650))).toBe(1);
		expect(flaps(at(550))).toBe('none');
	});

	it('knows which sheets state a take-off, and their short-field flaps', () => {
		const gorq = load('f-gorq.yaml').performance!;
		const brue = load('f-brue.yaml').performance!;
		expect([statesTakeoffConfig(pa28), statesTakeoffConfig(gorq), statesTakeoffConfig(brue)]).toEqual([true, false, true]);
		expect([shortFieldFlapsDeg(pa28), shortFieldFlapsDeg(gorq), shortFieldFlapsDeg(brue)]).toEqual([25, null, null]);
		expect(statesTakeoffConfig(null)).toBe(false);
	});

	it('reads a sheet naming no procedure in sheet order, and the normal one first wherever listed', () => {
		const untagged: ClosedFormPerformance = { ...pa28, configs: pa28.configs.map((x) => ({ ...x, procedure: undefined })) };
		expect(referenceConfig(untagged, 'takeoff')!.flapsDeg).toBe(0);
		const reversed: ClosedFormPerformance = { ...pa28, configs: [...pa28.configs].reverse() };
		expect(referenceConfig(reversed, 'takeoff')!.procedure).toBe('normal');
		const noDefault: ClosedFormPerformance = {
			...pa28,
			configs: [...pa28.configs, { ...pa28.configs[2], flapsDeg: 30, default: undefined }].map((x) => ({
				...x,
				default: undefined,
			})),
		};
		expect(referenceConfig(noDefault, 'landing')!.flapsDeg).toBe(30);
		expect(referenceConfig({ ...pa28, configs: [] }, 'takeoff')).toBeNull();
	});
});
