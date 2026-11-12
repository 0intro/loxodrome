/* The generic sheets (public/data/aircraft/generic/), each pinned to its
 * manufacturer's flight manual: the manual's sample loading problem comes out
 * of the app's mass and balance, a table sheet's printed intermediate masses
 * come out of its interpolation on the safe side, and the closed-form fit of
 * the Archer II stays within its stated bounds of the charts. The sheets'
 * own comments cite the pages. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	FUEL_TYPE_INFO,
	aircraftDocVersion,
	isMultiEngine,
	parseAircraftYaml,
	type Aircraft,
	type ClosedFormPerformance,
	type TablePerformance,
} from '$lib/aircraft/schema';
import { computeMassBalance, pointInEnvelope, withFuelL, fuelSlots, zeroFuelPoint } from '$lib/aircraft/massBalance';
import {
	computeAccelerateStop,
	computeClosedFormPerformance,
	computeTablePerformance,
	type PerfConditions,
} from '$lib/aircraft/performance';
import { oeiClimbAt, oeiLandingClimb, oeiNetCeiling, oeiTakeoffClimb } from '$lib/aircraft/oneEngine';

const LB = 0.45359237;
const IN = 0.0254;
const FT = 0.3048;
/** kg m per lb-in / 1000, the Cessna loading problems' moment unit. */
const KLBIN = 1000 * LB * IN;
/** The fuel density the app uses for 100LL; the manuals count 6 lb/US gal. */
const DENSITY = 0.72;
const CALM = { headwindKt: 0, surface: { grass: false, wet: false } };

function load(id: string): Aircraft {
	return parseAircraftYaml(
		readFileSync(new URL(`../public/data/aircraft/generic/${id}.yaml`, import.meta.url), 'utf-8'),
	);
}

/** A manual's sample loading problem: station masses in lb (index-aligned
 *  with the sheet's stations), the fuel in lb, the start, taxi and run-up
 *  allowance in lb. */
function sample(a: Aircraft, stationsLb: number[], fuelLb: number, taxiLb: number) {
	return computeMassBalance({
		mb: a.massBalance!,
		stationMassesKg: stationsLb.map((lb) => lb * LB),
		fuelL: (fuelLb * LB) / DENSITY,
		burnL: (taxiLb * LB) / DENSITY,
		densityKgPerL: DENSITY,
	});
}

/** A metric manual's loading example: station and fuel masses in kg, the
 *  fuel at the manual's own density. */
function sampleKg(a: Aircraft, stationsKg: number[], fuelKg: number, densityKgPerL: number) {
	return computeMassBalance({
		mb: a.massBalance!,
		stationMassesKg: stationsKg,
		fuelL: fuelKg / densityKgPerL,
		burnL: 0,
		densityKgPerL,
	});
}

describe('generic sheets: the manuals sample loading problems', () => {
	it('C152 (Figure 6-6): ramp 1675 lb at 56.8, take-off 1670 lb at 56.6', () => {
		// Seats 340 lb, baggage area 1 52 lb, 24.5 US gal (147 lb), 5 lb of taxi.
		const r = sample(load('c152'), [340, 52, 0], 147, 5);
		expect(r.takeoff.massKg).toBeCloseTo(1675 * LB, 0);
		expect(Math.abs(r.takeoff.momentKgM - 56.8 * KLBIN)).toBeLessThan(0.15 * KLBIN);
		expect(r.landing.massKg).toBeCloseTo(1670 * LB, 0);
		expect(Math.abs(r.landing.momentKgM - 56.6 * KLBIN)).toBeLessThan(0.15 * KLBIN);
		// The ramp sits 5 lb above the 1670 lb maximum until the allowance burns.
		expect(r.takeoffInside).toBe(false);
		expect(r.landingInside).toBe(true);
		expect(r.stationsWithinMax).toBe(true);
	});

	it('C172S (Figure 6-3): ramp 2558 lb, take-off 2550 lb, inside the envelope', () => {
		// Front 340 lb, rear 340 lb, baggage A 56 lb, 30 US gal (180 lb), 8 lb
		// of taxi. The manual's row puts the baggage at 82 in (moment 4.6), the
		// front of area A, where its loading arrangements give the area at
		// 95 in, the sheet's arm: the sheet's moment is 0.76 lb-in/1000 above
		// the printed 113.2.
		const r = sample(load('c172s'), [340, 340, 56, 0], 180, 8);
		expect(r.takeoff.massKg).toBeCloseTo(2558 * LB, 0);
		expect(Math.abs(r.takeoff.momentKgM - (113.2 + 56 * (95 - 82) / 1000) * KLBIN)).toBeLessThan(0.15 * KLBIN);
		expect(r.landing.massKg).toBeCloseTo(2550 * LB, 0);
		expect(r.landingInside).toBe(true);
	});

	it('C182T (Figure 6-3): ramp 3110 lb at 135.1, take-off 3100 lb at 134.6', () => {
		// Front 340 lb, rear 200 lb, baggage A 100 lb and B 24 lb, 87 US gal
		// (522 lb), 10 lb of taxi.
		const r = sample(load('c182t'), [340, 200, 100, 24, 0], 522, 10);
		expect(r.takeoff.massKg).toBeCloseTo(3110 * LB, 0);
		expect(Math.abs(r.takeoff.momentKgM - 135.1 * KLBIN)).toBeLessThan(0.3 * KLBIN);
		expect(r.landing.massKg).toBeCloseTo(3100 * LB, 0);
		expect(Math.abs(r.landing.momentKgM - 134.6 * KLBIN)).toBeLessThan(0.3 * KLBIN);
		expect(r.landingInside).toBe(true);
	});

	it('PA-28-161 Cadet (Figure 6-9): ramp 2332 lb at 89.72 in, take-off 2325 lb', () => {
		// Front 340 lb, rear 170 lb, baggage 50 lb (the compartment's maximum),
		// 267 lb of fuel, 7 lb of taxi. The ramp sits 3.2 kg above the 2325 lb
		// envelope top until the allowance burns.
		const r = sample(load('pa28-161-cadet'), [340, 170, 50], 267, 7);
		expect(r.takeoff.massKg).toBeCloseTo(2332 * LB, 0);
		expect(Math.abs(r.takeoff.momentKgM - 209231.5 * LB * IN)).toBeLessThan(1);
		expect(r.takeoff.armM).toBeCloseTo(89.72 * IN, 3);
		expect(r.takeoffInside).toBe(false);
		expect(r.landing.massKg).toBeCloseTo(2325 * LB, 0);
		expect(Math.abs(r.landing.momentKgM - 208566.5 * LB * IN)).toBeLessThan(1);
		expect(r.landingInside).toBe(true);
		expect(r.stationsWithinMax).toBe(true);
	});

	it('DA 40 NG (6.4.3 a): 1070 kg at 2598.8 kgm empty tanks, 1159 kg at 2832.9 full', () => {
		// Front seats 150 kg, standard baggage 20 kg, 89 kg of usable fuel at
		// the AFM's 0.84 kg/L (the app's Jet A-1); no taxi row in the example.
		const r = sampleKg(load('da40ng'), [150, 0, 20, 0], 89, 0.84);
		expect(r.takeoff.massKg).toBeCloseTo(1159, 6);
		expect(Math.abs(r.takeoff.momentKgM - 2832.9)).toBeLessThan(0.1);
		expect(r.takeoff.armM).toBeCloseTo(2.444, 3);
		expect(r.zeroFuel.massKg).toBeCloseTo(1070, 6);
		expect(Math.abs(r.zeroFuel.momentKgM - 2598.8)).toBeLessThan(0.1);
		expect(r.takeoffInside).toBe(true);
		expect(r.zeroFuelInside).toBe(true);
	});

	it('Elixir (6.4): 607 kg at 829 mm with fuel, 540 kg at 836 mm without', () => {
		// Pilot 95 kg at 1150 mm, copilot 65 kg at 1050, luggage 20 kg, 67 kg
		// of fuel (the AFM's moments in kg mm: 503238 and 451380).
		const r = sampleKg(load('elixir'), [95, 65, 20], 67, 0.72);
		expect(r.takeoff.massKg).toBeCloseTo(607, 6);
		expect(r.takeoff.momentKgM).toBeCloseTo(503.238, 6);
		expect(Math.round(r.takeoff.armM * 1000)).toBe(829);
		expect(r.zeroFuel.massKg).toBeCloseTo(540, 6);
		expect(r.zeroFuel.momentKgM).toBeCloseTo(451.38, 6);
		expect(Math.round(r.zeroFuel.armM * 1000)).toBe(836);
		expect(r.takeoffInside).toBe(true);
		expect(r.zeroFuelInside).toBe(true);
	});

	it('PA-28-181 Archer II (Figure 6-9): ramp 2558 lb at 91.5 in, take-off 2550 lb', () => {
		// Front 340 lb, rear 340 lb, 48 US gal (288 lb), 8 lb of taxi. The ramp
		// sits 3.6 kg above the 2550 lb envelope top until the allowance burns.
		const r = sample(load('pa28-181-archer2'), [340, 340, 0], 288, 8);
		expect(r.takeoff.massKg).toBeCloseTo(2558 * LB, 0);
		expect(Math.abs(r.takeoff.momentKgM - 234009 * LB * IN)).toBeLessThan(1);
		expect(r.takeoff.armM).toBeCloseTo(91.5 * IN, 3);
		expect(r.takeoffInside).toBe(false);
		expect(r.landing.massKg).toBeCloseTo(2550 * LB, 0);
		expect(Math.abs(r.landing.momentKgM - 233249 * LB * IN)).toBeLessThan(1);
		expect(r.landingInside).toBe(true);
	});

	it('DR400/120, 1975 manual (4.1 bis): 900 kg at 0.529 m', () => {
		// Front seats 154 kg at 0.410 m, rear 115 kg, 80 kg of fuel, baggage
		// 10 kg. The manual prints the moment 476.06 m.kg where its rows add
		// up to 475.76: the centre of gravity is 0.529 m either way.
		const r = sampleKg(load('dr400-120-pre2210'), [154, 115, 10], 80, DENSITY);
		expect(r.takeoff.massKg).toBeCloseTo(900, 6);
		expect(r.takeoff.momentKgM).toBeCloseTo(475.76, 2);
		expect(Math.round(r.takeoff.armM * 1000)).toBe(529);
		expect(r.takeoffInside).toBe(true);
		expect(r.stationsWithinMax).toBe(true);
	});

	it('DR400/120, 1992 and 2018 manuals (6.03, 6-4): 896 kg inside, from 218 and 205 m.kg', () => {
		// Front seats 150 kg, rear 90 kg, baggage 17 kg, 90 L (65 kg); no total
		// moment printed (the centrogram's dotted path), the empty-tank point
		// inside too.
		for (const [id, emptyMoment] of [
			['dr400-120-sn2210', 218],
			['dr400-120-sn2669', 205],
		] as const) {
			const a = load(id);
			expect(a.massBalance!.emptyMassKg, id).toBe(574);
			expect(a.massBalance!.emptyMassKg * a.massBalance!.emptyArmM, id).toBeCloseTo(emptyMoment, 1);
			const r = sampleKg(a, [150, 90, 17], 65, DENSITY);
			expect(r.takeoff.massKg, id).toBeCloseTo(896, 6);
			expect(r.takeoffInside, id).toBe(true);
			expect(r.zeroFuelInside, id).toBe(true);
			expect(r.stationsWithinMax, id).toBe(true);
		}
	});

	it('DA20-A1 (Figure 6.4): 750 kg at 220.88 kgm, 0.29 m', () => {
		// Empty 520 kg and 148.40 kgm; pilot and passenger 172 kg at 0.143 m,
		// baggage 5 kg, 53 kg of fuel at 0.824 m (the manual's fuel row says
		// 43.76 kgm for 53 kg x 0.824 = 43.67).
		const r = sampleKg(load('da20-a1'), [172, 5], 53, DENSITY);
		expect(r.takeoff.massKg).toBeCloseTo(750, 6);
		expect(Math.abs(r.takeoff.momentKgM - 220.88)).toBeLessThan(0.1);
		expect(r.takeoffInside).toBe(true);
		expect(r.zeroFuel.massKg).toBeCloseTo(697, 6);
		expect(r.zeroFuelInside).toBe(true);
	});

	it('DA20-C1 (Figure 6.7): 728 kg at 202.788 kgm', () => {
		// Empty 523 kg and 144.740 kgm; pilot and passenger 163 kg at 0.143 m,
		// 42 kg of fuel at 0.824 m (the manual's moments come from the exact
		// pounds: 23.286 and 34.762 kgm).
		const r = sampleKg(load('da20-c1'), [163, 0, 0], 42, DENSITY);
		expect(r.takeoff.massKg).toBeCloseTo(728, 6);
		expect(Math.abs(r.takeoff.momentKgM - 202.788)).toBeLessThan(0.2);
		expect(r.takeoffInside).toBe(true);
		expect(r.zeroFuel.massKg).toBeCloseTo(686, 6);
		expect(r.zeroFuelInside).toBe(true);
	});

	it('DR400/140B, 1975 manual (4.3): 927 kg and 474 m.kg, read off its moment diagram', () => {
		// Empty 560 kg and 140 m.kg; front seats 150 kg, rear 100 kg, baggage
		// 20 kg, the main tank's 110 L (79 kg); then 25 L (18 kg) in the optional
		// tank at 1.61 m (7.1), which the sheet does not count. The manual reads
		// each row's moment off its diagram to the whole m.kg (61 for the front
		// seats' 61.5, 37 for the baggage's 38): 474 printed for 475.96.
		const a = load('dr400-140b-pre2211');
		const r = sampleKg(a, [150, 100, 20], 79, DENSITY);
		expect(r.takeoff.massKg).toBeCloseTo(909, 6);
		const mass = r.takeoff.massKg + 18;
		const moment = r.takeoff.momentKgM + 18 * 1.61;
		expect(mass).toBeCloseTo(927, 6);
		expect(Math.abs(moment - 474)).toBeLessThan(2.5);
		expect(pointInEnvelope(a.massBalance!.envelope, moment / mass, mass)).toBe(true);
		expect(r.takeoffInside).toBe(true);
	});

	it('DR400/140B, 1992 manual (6.7): 922 kg at 487.72 m.kg, 0.529 m', () => {
		// Empty 600 kg x 0.357 m printed as 214.02 m.kg; front seats 150 kg at
		// 0.410 m, rear 90 kg, baggage 17 kg, 65 kg in the main tank.
		const r = sampleKg(load('dr400-140b-sn2211'), [150, 90, 17], 65, DENSITY);
		expect(r.takeoff.massKg).toBeCloseTo(922, 6);
		expect(r.takeoff.momentKgM).toBeCloseTo(487.72, 2);
		expect(Math.round(r.takeoff.armM * 1000)).toBe(529);
		expect(r.takeoffInside).toBe(true);
		expect(r.stationsWithinMax).toBe(true);
	});

	it('DR400/140B, 2018 manual (6-4): 922 kg inside, from 600 kg and 214 m.kg', () => {
		const a = load('dr400-140b-sn2669');
		expect(a.massBalance!.emptyMassKg * a.massBalance!.emptyArmM).toBeCloseTo(214, 0);
		const r = sampleKg(a, [150, 90, 17], 65, DENSITY);
		expect(r.takeoff.massKg).toBeCloseTo(922, 6);
		expect(r.takeoffInside).toBe(true);
		expect(r.zeroFuelInside).toBe(true);
	});

	it.each([['dr400-160-sn2220'], ['dr400-180-sn2216']])(
		'%s (6.03): 991 kg inside, the manual\'s 90 L main and 68 L wings, and the main tank filled first',
		(id) => {
			const a = load(id);
			const mb = a.massBalance!;
			expect(mb.emptyMassKg * mb.emptyArmM).toBeCloseTo(200, 1);
			// The manual's own split, by hand at the sheet's tank arms: 65 kg in
			// the main tank, 49 kg in the wings.
			const [main, wings] = mb.fuelTanks!;
			const zf = zeroFuelPoint(mb, [150, 90, 17]);
			const kg = zf.massKg + 65 + 49;
			expect(kg).toBeCloseTo(991, 6);
			expect(pointInEnvelope(mb.envelope, (zf.momentKgM + 65 * main.armM + 49 * wings.armM) / kg, kg)).toBe(true);
			// The app: the same 114 kg at 0.72 kg/L, the main tank filled first.
			const r = sampleKg(a, [150, 90, 17], 114, DENSITY);
			expect(r.takeoff.massKg).toBeCloseTo(991, 6);
			expect([r.takeoffInside, r.zeroFuelInside, r.stationsWithinMax]).toEqual([true, true, true]);
		},
	);

	it('DR400/160, 1972 manual (4.1 bis): 1046 kg at 0.511 m, every tank full', () => {
		// Front seats 154 kg at 0.410 m, rear 154 kg, baggage 30 kg, 80 kg of
		// fuel in the main tank and 58 kg in the wings: 535.03 m.kg. The app
		// weighs the same 190 L at 0.72 kg/L, 136.8 kg, 1.2 kg lighter.
		const a = load('dr400-160-pre2220');
		const mb = a.massBalance!;
		const [main, wings] = mb.fuelTanks!;
		const zf = zeroFuelPoint(mb, [154, 154, 30]);
		expect(zf.massKg + 80 + 58).toBeCloseTo(1046, 6);
		expect(zf.momentKgM + 80 * main.armM + 58 * wings.armM).toBeCloseTo(535.03, 6);
		const r = sampleKg(a, [154, 154, 30], 190 * DENSITY, DENSITY);
		expect(r.fuelL).toBeCloseTo(190, 6);
		expect(Math.round(r.takeoff.armM * 1000)).toBe(511);
		expect([r.takeoffInside, r.zeroFuelInside, r.stationsWithinMax]).toEqual([true, true, true]);
	});

	it('DR400/155CDI (DR401), 2018 manual (6-3): 922 kg at 487.72 m.kg, its fuel at 0.8 kg/L', () => {
		// The DR400/140B's example: 600 kg and 214 m.kg, front seats 150 kg,
		// rear 90 kg, baggage 17 kg, 65 kg of Jet A-1 (81 L at the manual's 0.8).
		const a = load('dr400-155cdi-sn2669');
		expect(a.massBalance!.emptyMassKg * a.massBalance!.emptyArmM).toBeCloseTo(214, 0);
		const r = sampleKg(a, [150, 90, 17], 65, 0.8);
		expect(r.takeoff.massKg).toBeCloseTo(922, 6);
		expect(r.takeoff.momentKgM).toBeCloseTo(487.72, 2);
		expect(r.takeoffInside).toBe(true);
		expect(r.zeroFuelInside).toBe(true);
		expect(r.stationsWithinMax).toBe(true);
		// The app loads those 81.25 L at its own Jet A-1 density: heavier, inside.
		const jet = FUEL_TYPE_INFO['JET A-1'].densityKgPerL;
		const app = computeMassBalance({ mb: a.massBalance!, stationMassesKg: [150, 90, 17], fuelL: 65 / 0.8, burnL: 0, densityKgPerL: jet });
		expect(app.takeoff.massKg).toBeCloseTo(857 + (65 / 0.8) * jet, 6);
		expect(app.takeoff.massKg).toBeGreaterThan(922);
		expect(app.takeoffInside).toBe(true);
	});

	it("PA-34-200 Seneca (VB-424 4-10): the plotter's sample problem, 3880 lb at 89.52 in", () => {
		// 2615 lb at 82.0 in; 180 and 200 lb in front, 115 and 135 in the
		// centre, 80 and 100 in the rear, 50 lb forward and 45 lb aft of
		// baggage, 60 US gal at 6 lb.
		const a = load('pa34-200');
		const r = sample(a, [380, 250, 180, 50, 45], 360, 0);
		expect(r.takeoff.massKg / LB).toBeCloseTo(3880, 0);
		expect(r.takeoff.armM / IN).toBeCloseTo(89.52, 1);
		expect(r.takeoffInside).toBe(true);
		expect(r.stationsWithinMax).toBe(true);
	});
});

describe('generic sheets: a table between its printed masses', () => {
	/** The sheet's take-off distances at a printed intermediate mass: never
	 *  shorter than the manual's own sheet for that mass (0.1 m rounding
	 *  aside), and at most `maxOver` longer. */
	function checkIntermediate(
		id: string,
		massLb: number,
		rows: Array<[number, number, number, number]>,
		maxOver: number,
	) {
		const perf = load(id).performance as TablePerformance;
		for (const [altFt, tempC, rollFt, totalFt] of rows) {
			const c: PerfConditions = { massKg: massLb * LB, pressureAltFt: altFt, temperatureC: tempC, ...CALM };
			const r = computeTablePerformance(perf, 'takeoff', c);
			if (!r.ok) {
				throw new Error(`${id} ${altFt} ft above the table`);
			}
			const roll = r.value.groundRoll.rawM;
			const total = r.value.distance15m.rawM;
			expect(roll, `${id} ${altFt} ft ${tempC} C roll`).toBeGreaterThanOrEqual(rollFt * FT - 0.15);
			expect(total, `${id} ${altFt} ft ${tempC} C total`).toBeGreaterThanOrEqual(totalFt * FT - 0.15);
			expect(roll / (rollFt * FT), `${id} ${altFt} ft ${tempC} C roll`).toBeLessThan(1 + maxOver);
			expect(total / (totalFt * FT), `${id} ${altFt} ft ${tempC} C total`).toBeLessThan(1 + maxOver);
		}
	}

	it('C172S at 2400 lb (Figure 5-5 sheet 2), between the 2550 and 2200 lb sheets', () => {
		checkIntermediate(
			'c172s',
			2400,
			[
				[0, 0, 745, 1275],
				[0, 40, 995, 1685],
				[4000, 20, 1240, 2130],
				[8000, 0, 1560, 2755],
				[8000, 40, 2095, 3790],
			],
			0.04,
		);
	});

	it('C182T at 2700 lb (Figure 5-5 sheet 2), between the 3100 and 2300 lb sheets', () => {
		checkIntermediate(
			'c182t',
			2700,
			[
				[0, 0, 520, 995],
				[2000, 20, 710, 1350],
				[4000, 40, 975, 1870],
				[6000, 0, 880, 1705],
				[6000, 40, 1175, 2300],
			],
			0.1,
		);
	});
});

describe('generic sheets: the DA 40 NG between its 1280 and 1100 kg tables', () => {
	// The AFM's 1200 kg tables (pp. 5-15, 5-32), 0 to 40 C, [roll, 15 m] in
	// metres, by pressure altitude.
	const at1200: Record<'takeoff' | 'landing', Array<[number, number[], number[]]>> = {
		takeoff: [
			[0, [325, 345, 365, 385, 410], [490, 520, 540, 570, 610]],
			[1000, [345, 365, 390, 415, 445], [520, 550, 570, 610, 650]],
			[2000, [365, 390, 415, 445, 480], [550, 580, 610, 650, 700]],
			[3000, [390, 415, 445, 485, 520], [580, 610, 650, 700, 750]],
			[4000, [420, 445, 480, 525, 565], [610, 640, 700, 750, 800]],
			[5000, [450, 480, 525, 575, 615], [650, 690, 750, 810, 870]],
			[6000, [480, 525, 575, 630, 670], [690, 740, 810, 880, 940]],
			[7000, [520, 570, 630, 690, 735], [740, 800, 880, 960, 1010]],
			[8000, [570, 630, 695, 760, 810], [800, 870, 960, 1040, 1110]],
			[9000, [625, 695, 765, 830, 895], [870, 950, 1050, 1120, 1200]],
		],
		landing: [
			[0, [280, 290, 300, 310, 325], [600, 620, 640, 660, 690]],
			[1000, [290, 300, 310, 320, 340], [610, 630, 650, 680, 720]],
			[2000, [300, 310, 320, 340, 360], [620, 640, 660, 700, 740]],
			[3000, [310, 320, 335, 355, 375], [630, 650, 680, 720, 760]],
			[4000, [320, 335, 350, 375, 395], [650, 670, 700, 740, 790]],
			[5000, [335, 345, 370, 395, 415], [660, 690, 730, 770, 810]],
			[6000, [345, 365, 390, 415, 435], [680, 710, 750, 800, 840]],
			[7000, [370, 400, 425, 450, 475], [710, 750, 790, 840, 890]],
			[8000, [425, 455, 485, 515, 545], [780, 820, 870, 920, 980]],
			[9000, [490, 525, 555, 590, 620], [860, 910, 960, 1020, 1070]],
		],
	};

	it('reads them within their 5 m and 10 m rounding, no trend', () => {
		const perf = load('da40ng').performance as TablePerformance;
		for (const phase of ['takeoff', 'landing'] as const) {
			const errors: number[] = [];
			for (const [altFt, rolls, d15s] of at1200[phase]) {
				for (let i = 0; i < 5; i++) {
					const r = computeTablePerformance(perf, phase, { massKg: 1200, pressureAltFt: altFt, temperatureC: i * 10, ...CALM });
					if (!r.ok) {
						throw new Error(`${phase} ${altFt} ft above the table`);
					}
					errors.push(r.value.groundRoll.rawM - rolls[i], r.value.distance15m.rawM - d15s[i]);
					expect(r.value.groundRoll.rawM / rolls[i], `${phase} ${altFt} ft ${i * 10} C roll`).toBeGreaterThan(0.985);
					expect(r.value.distance15m.rawM / d15s[i], `${phase} ${altFt} ft ${i * 10} C 15 m`).toBeGreaterThan(0.985);
				}
			}
			expect(Math.max(...errors.map(Math.abs))).toBeLessThan(10);
			expect(Math.abs(errors.reduce((a, b) => a + b, 0) / errors.length)).toBeLessThan(2);
		}
	});

	it('keeps the flapless landing check the abnormal-flap tables imply', () => {
		expect((load('da40ng').performance as TablePerformance).flaplessLandingFactor).toBe(1.43);
	});
});

describe('generic sheets: the Archer II closed form against the VB-1120 charts', () => {
	const a = load('pa28-181-archer2');
	const perf = a.performance as ClosedFormPerformance;
	const at = (phase: 'takeoff' | 'landing', flapsDeg: number, c: PerfConditions) => {
		const config = perf.configs.find((x) => x.phase === phase && x.flapsDeg === flapsDeg)!;
		const r = computeClosedFormPerformance(perf, config, c);
		if (!r.ok) {
			throw new Error('closed form cannot fail');
		}
		return r.value;
	};

	// Readings of the charts at 2550 lb and no wind, in feet, from the traced
	// pressure altitude lines: [chart, phase, flaps, metric, PA, OAT, feet].
	const readings: Array<[string, 'takeoff' | 'landing', number, 'd15' | 'roll', number, number, number]> = [
		['5-7', 'takeoff', 0, 'd15', 0, 20, 1962],
		['5-7', 'takeoff', 0, 'd15', 2000, 10, 2312],
		['5-7', 'takeoff', 0, 'd15', 4000, 0, 2667],
		['5-7', 'takeoff', 0, 'd15', 6000, -10, 3049],
		['5-11', 'takeoff', 0, 'roll', 0, 20, 1084],
		['5-11', 'takeoff', 0, 'roll', 2000, 10, 1285],
		['5-11', 'takeoff', 0, 'roll', 4000, 0, 1476],
		['5-11', 'takeoff', 0, 'roll', 6000, 0, 1897],
		['5-9', 'takeoff', 25, 'd15', 0, 10, 1529],
		['5-9', 'takeoff', 25, 'd15', 2000, 10, 2088],
		['5-9', 'takeoff', 25, 'd15', 4000, 0, 2447],
		['5-9', 'takeoff', 25, 'd15', 6000, -10, 2784],
		['5-13', 'takeoff', 25, 'roll', 0, 20, 926],
		['5-13', 'takeoff', 25, 'roll', 2000, 10, 1102],
		['5-13', 'takeoff', 25, 'roll', 4000, 0, 1270],
		['5-13', 'takeoff', 25, 'roll', 6000, 0, 1652],
		['5-35', 'landing', 40, 'd15', 0, 10, 1388],
		['5-35', 'landing', 40, 'd15', 2000, 20, 1476],
		['5-35', 'landing', 40, 'd15', 4000, 0, 1486],
		['5-35', 'landing', 40, 'd15', 6000, 20, 1649],
		['5-37', 'landing', 40, 'roll', 0, 10, 902],
		['5-37', 'landing', 40, 'roll', 2000, 20, 996],
		['5-37', 'landing', 40, 'roll', 4000, 0, 996],
		['5-37', 'landing', 40, 'roll', 6000, 10, 1118],
	];

	it('is never more than 1 % short of the charts, nor 12 % long', () => {
		for (const [fig, phase, flaps, metric, pa, oat, ft] of readings) {
			const r = at(phase, flaps, { massKg: 2550 * LB, pressureAltFt: pa, temperatureC: oat, ...CALM });
			const got = metric === 'd15' ? r.distance15m.correctedM : r.groundRoll.correctedM;
			const ratio = got / (ft * FT);
			expect(ratio, `${fig} ${pa} ft ${oat} C`).toBeGreaterThanOrEqual(0.99);
			expect(ratio, `${fig} ${pa} ft ${oat} C`).toBeLessThan(1.12);
		}
	});

	it('runs the printed worked examples long, never short', () => {
		// [chart, phase, flaps, metric, PA, OAT, lb, headwind kt, printed ft]
		const examples: Array<[string, 'takeoff' | 'landing', number, 'd15' | 'roll', number, number, number, number, number]> = [
			['5-7', 'takeoff', 0, 'd15', 2000, 21, 2400, 15, 1900],
			['5-9', 'takeoff', 25, 'd15', 2000, 21, 2400, 8, 1860],
			['5-11', 'takeoff', 0, 'roll', 2000, 21, 2400, 8, 1100],
			['5-13', 'takeoff', 25, 'roll', 2000, 21, 2400, 10, 950],
			['5-35', 'landing', 40, 'd15', 2300, 21, 2264, 5, 1290],
			['5-37', 'landing', 40, 'roll', 2300, 21, 2264, 5, 825],
		];
		for (const [fig, phase, flaps, metric, pa, oat, lb, kt, ft] of examples) {
			const r = at(phase, flaps, {
				massKg: lb * LB,
				pressureAltFt: pa,
				temperatureC: oat,
				headwindKt: kt,
				surface: { grass: false, wet: false },
			});
			const got = metric === 'd15' ? r.distance15m.correctedM : r.groundRoll.correctedM;
			const ratio = got / (ft * FT);
			expect(ratio, fig).toBeGreaterThanOrEqual(1);
			expect(ratio, fig).toBeLessThan(1.16);
		}
	});

	it('penalises a tailwind at least as much as the charts guides do', () => {
		// The steepest tailwind guide of each chart, %/kt: 5-7 4.5, 5-11 7.1,
		// 5-9 5.0, 5-13 6.5, 5-35 5.7, 5-37 6.0.
		const c: PerfConditions = { massKg: 2550 * LB, pressureAltFt: 0, temperatureC: 15, headwindKt: -5, surface: { grass: false, wet: false } };
		const calm = { ...c, headwindKt: 0 };
		const ratio = (phase: 'takeoff' | 'landing', flaps: number, metric: 'd15' | 'roll') => {
			const pick = (v: ReturnType<typeof at>) => (metric === 'd15' ? v.distance15m.correctedM : v.groundRoll.correctedM);
			return pick(at(phase, flaps, c)) / pick(at(phase, flaps, calm));
		};
		expect(ratio('takeoff', 0, 'd15')).toBeGreaterThanOrEqual(1 + 5 * 0.045);
		expect(ratio('takeoff', 0, 'roll')).toBeGreaterThanOrEqual(1 + 5 * 0.071);
		expect(ratio('takeoff', 25, 'd15')).toBeGreaterThanOrEqual(1 + 5 * 0.05);
		expect(ratio('takeoff', 25, 'roll')).toBeGreaterThanOrEqual(1 + 5 * 0.065);
		expect(ratio('landing', 40, 'd15')).toBeGreaterThanOrEqual(1 + 5 * 0.057);
		expect(ratio('landing', 40, 'roll')).toBeGreaterThanOrEqual(1 + 5 * 0.06);
	});

	it('states no flapless landing figure: the POH publishes none', () => {
		expect(perf.flaplessLandingFactor).toBeUndefined();
	});
});

describe('generic sheets: the Cadet closed form against the VB-1360 charts', () => {
	const perf = load('pa28-161-cadet').performance as ClosedFormPerformance;
	const at = (phase: 'takeoff' | 'landing', flapsDeg: number, c: PerfConditions) => {
		const config = perf.configs.find((x) => x.phase === phase && x.flapsDeg === flapsDeg)!;
		const r = computeClosedFormPerformance(perf, config, c);
		if (!r.ok) {
			throw new Error('closed form cannot fail');
		}
		return r.value;
	};
	const dry = { grass: false, wet: false };

	// The charts at 2325 lb and no wind, in feet, the larger of the VB-1360
	// and VB-1375 readings: [chart, phase, flaps, metric, PA, OAT, feet].
	const readings: Array<[string, 'takeoff' | 'landing', number, 'd15' | 'roll', number, number, number]> = [
		['5-7', 'takeoff', 0, 'roll', 0, 20, 1073],
		['5-7', 'takeoff', 0, 'roll', 2000, 10, 1276],
		['5-7', 'takeoff', 0, 'roll', 4000, 0, 1500],
		['5-7', 'takeoff', 0, 'roll', 6000, -10, 1701],
		['5-9', 'takeoff', 0, 'd15', 0, 20, 1874],
		['5-9', 'takeoff', 0, 'd15', 2000, 10, 2183],
		['5-9', 'takeoff', 0, 'd15', 4000, 0, 2618],
		['5-9', 'takeoff', 0, 'd15', 6000, -10, 3020],
		['5-11', 'takeoff', 25, 'roll', 0, 20, 1062],
		['5-11', 'takeoff', 25, 'roll', 2000, 10, 1275],
		['5-11', 'takeoff', 25, 'roll', 4000, 0, 1520],
		['5-11', 'takeoff', 25, 'roll', 6000, 0, 1865],
		['5-13', 'takeoff', 25, 'd15', 0, 20, 1603],
		['5-13', 'takeoff', 25, 'd15', 2000, 10, 1893],
		['5-13', 'takeoff', 25, 'd15', 4000, 0, 2204],
		['5-13', 'takeoff', 25, 'd15', 6000, -10, 2498],
		['5-35', 'landing', 40, 'd15', 0, 30, 1142],
		['5-35', 'landing', 40, 'd15', 2000, 20, 1169],
		['5-35', 'landing', 40, 'd15', 4000, 0, 1172],
		['5-35', 'landing', 40, 'roll', 2000, 20, 639],
		['5-35', 'landing', 40, 'roll', 6000, 10, 713],
	];

	it('is never more than 1 % short of the charts, nor 10 % long', () => {
		for (const [fig, phase, flaps, metric, pa, oat, ft] of readings) {
			const r = at(phase, flaps, { massKg: 2325 * LB, pressureAltFt: pa, temperatureC: oat, headwindKt: 0, surface: dry });
			const got = metric === 'd15' ? r.distance15m.correctedM : r.groundRoll.correctedM;
			const ratio = got / (ft * FT);
			expect(ratio, `${fig} ${pa} ft ${oat} C`).toBeGreaterThanOrEqual(0.99);
			expect(ratio, `${fig} ${pa} ft ${oat} C`).toBeLessThan(1.1);
		}
	});

	it('runs the printed worked examples long or level, never short', () => {
		// [chart, phase, flaps, metric, PA, OAT, lb, headwind kt, printed ft]
		const examples: Array<[string, 'takeoff' | 'landing', number, 'd15' | 'roll', number, number, number, number, number]> = [
			['5-7', 'takeoff', 0, 'roll', 1500, 27, 2325, 15, 1150],
			['5-9', 'takeoff', 0, 'd15', 500, 38, 2325, 15, 2100],
			['5-11', 'takeoff', 25, 'roll', 1500, 27, 2175, 15, 975],
			['5-13', 'takeoff', 25, 'd15', 1500, 27, 2175, 15, 1600],
			['5-35', 'landing', 40, 'roll', 2500, 24, 2325, 0, 660],
			['5-35', 'landing', 40, 'd15', 2500, 24, 2325, 0, 1190],
		];
		for (const [fig, phase, flaps, metric, pa, oat, lb, kt, ft] of examples) {
			const r = at(phase, flaps, { massKg: lb * LB, pressureAltFt: pa, temperatureC: oat, headwindKt: kt, surface: dry });
			const got = metric === 'd15' ? r.distance15m.correctedM : r.groundRoll.correctedM;
			const ratio = got / (ft * FT);
			expect(ratio, fig).toBeGreaterThanOrEqual(0.997);
			expect(ratio, fig).toBeLessThan(1.07);
		}
	});
});

describe('generic sheets: the DR400/120 tables', () => {
	const perfOf = (id: string) => load(id).performance as TablePerformance;
	const isa = (altFt: number) => 15 - (2 * altFt) / 1000;
	const at = (id: string, phase: 'takeoff' | 'landing', c: PerfConditions) => {
		const r = computeTablePerformance(perfOf(id), phase, c);
		if (!r.ok) {
			throw new Error(`${id} ${c.pressureAltFt} ft above the table`);
		}
		return r.value;
	};

	it('read the printed cells, the 1975 sea-level roll 255 m where the later manuals print 235', () => {
		const c: PerfConditions = { massKg: 900, pressureAltFt: 0, temperatureC: 15, ...CALM };
		expect(at('dr400-120-pre2210', 'takeoff', c).groundRoll.rawM).toBeCloseTo(255, 6);
		for (const id of ['dr400-120-sn2210', 'dr400-120-sn2669']) {
			expect(at(id, 'takeoff', c).groundRoll.rawM, id).toBeCloseTo(235, 6);
		}
		for (const id of ['dr400-120-pre2210', 'dr400-120-sn2210', 'dr400-120-sn2669']) {
			const hot = { ...c, pressureAltFt: 8000, temperatureC: isa(8000) + 20 };
			expect(at(id, 'takeoff', hot).distance15m.rawM, id).toBeCloseTo(1125, 6);
			expect(at(id, 'landing', { ...c, massKg: 700, pressureAltFt: 4000, temperatureC: isa(4000) }).distance15m.rawM, id).toBeCloseTo(420, 6);
		}
	});

	it('take their own headwind credit at take-off: x0.78 in 1975, x0.85 after', () => {
		const c: PerfConditions = { massKg: 900, pressureAltFt: 0, temperatureC: 15, headwindKt: 10, surface: { grass: false, wet: false } };
		expect(at('dr400-120-pre2210', 'takeoff', c).distance15m.correctedM).toBeCloseTo(535 * 0.78, 6);
		expect(at('dr400-120-sn2210', 'takeoff', c).distance15m.correctedM).toBeCloseTo(535 * 0.85, 6);
	});

	it('1975: the one grass factor covers every printed grass distance over 15 m, and the margined roll', () => {
		// The take-off table's grass columns (5.2): [alt, ISA offset,
		// 900 kg [roll, 15 m], 700 kg [roll, 15 m]].
		const grass: Array<[number, number, [number, number], [number, number]]> = [
			[0, -20, [315, 570], [165, 320]],
			[0, 0, [360, 640], [185, 355]],
			[0, 20, [410, 715], [215, 395]],
			[4000, -20, [460, 800], [230, 430]],
			[4000, 0, [530, 905], [265, 485]],
			[4000, 20, [615, 1025], [300, 540]],
			[8000, -20, [700, 1165], [330, 595]],
			[8000, 0, [820, 1350], [380, 675]],
			[8000, 20, [960, 1550], [440, 760]],
		];
		const perf = perfOf('dr400-120-pre2210');
		for (const [altFt, off, heavy, light] of grass) {
			for (const [massKg, [roll, d15]] of [
				[900, heavy],
				[700, light],
			] as const) {
				const v = at('dr400-120-pre2210', 'takeoff', {
					massKg,
					pressureAltFt: altFt,
					temperatureC: isa(altFt) + off,
					headwindKt: 0,
					surface: { grass: true, wet: false },
				});
				const where = `${massKg} kg ${altFt} ft ISA ${off}`;
				// The 15 m distance, the binding check, is never shorter than the
				// manual's grass figure...
				expect(v.distance15m.correctedM, where).toBeGreaterThanOrEqual(d15 - 0.05);
				// ...and covers the margined grass roll, so the roll check the
				// shorter roll would loosen is implied by the 15 m one.
				expect(v.distance15m.correctedM, where).toBeGreaterThanOrEqual(perf.marginFactor * roll);
			}
		}
	});

	it('2018: holds its 700 kg and ISA - 20 columns below them (5-2, 5-4, 5-5, 5-10), where 1992 extrapolates', () => {
		const light = { massKg: 650, pressureAltFt: 0, temperatureC: 15, ...CALM };
		const held = at('dr400-120-sn2669', 'takeoff', light);
		expect([held.groundRoll.rawM, held.distance15m.rawM]).toEqual([145, 315]);
		expect(held.flags.massExtrapolated).toBe(false);
		const cold = at('dr400-120-sn2669', 'takeoff', { ...light, massKg: 900, temperatureC: -15 });
		expect([cold.groundRoll.rawM, cold.distance15m.rawM]).toEqual([225, 480]);
		expect(cold.flags.temperatureExtrapolated).toBe(false);
		// Edition 10 prints no such rule: below the table it extrapolates, flagged.
		const ed10 = at('dr400-120-sn2210', 'takeoff', light);
		expect(ed10.distance15m.rawM).toBeLessThan(315);
		expect(ed10.flags.massExtrapolated).toBe(true);
	});

	it('2018: the worked landing examples (4-19), 539 m normal and 690 m in a crosswind', () => {
		const perf = perfOf('dr400-120-sn2669');
		const land = (headwindKt: number) =>
			at('dr400-120-sn2669', 'landing', {
				massKg: 900,
				pressureAltFt: 0,
				temperatureC: 15,
				headwindKt,
				surface: { grass: false, wet: false },
			}).distance15m;
		// 10 kt of headwind: 460 x 0.78 = 359 m, a normal landing 1.5 x 359.
		expect(land(10).correctedM).toBeCloseTo(358.8, 6);
		expect(Math.abs(land(10).requiredM - 539)).toBeLessThan(1);
		// A full crosswind, no headwind credit: 1.5 x 460.
		expect(land(0).requiredM).toBeCloseTo(690, 6);
		expect(perf.flaplessLandingFactor).toBe(1.3);
		// The earlier manuals print neither the 1.5 nor a flapless figure.
		for (const id of ['dr400-120-pre2210', 'dr400-120-sn2210']) {
			expect(perfOf(id).marginFactor, id).toBe(1.3);
			expect(perfOf(id).flaplessLandingFactor, id).toBeUndefined();
		}
	});
});

describe('generic sheets: the DR400/140B tables against their charts', () => {
	// The charts of 1001588 5.03 / 5.07 (1002825 5-6 / 5-12, the same
	// drawing) read along their altitude and guide lines, distances over 15 m
	// in metres: [phase, kg, ft, C, chart].
	const readings: Array<['takeoff' | 'landing', number, number, number, number]> = [
		['takeoff', 1000, 0, 15, 584.4],
		['takeoff', 1000, 5000, 17, 954.6],
		['takeoff', 1000, 6000, 3, 946.4],
		['takeoff', 1000, 8000, -1, 1073.6],
		['takeoff', 900, 4000, 7, 607.0],
		['takeoff', 800, 7000, -9, 554.6],
		['takeoff', 850, 3000, 25, 560.9],
		['landing', 1000, 1000, 15, 531.9],
		['landing', 1000, 0, 15, 513.5],
		['landing', 1000, 8000, -1, 624.8],
		['landing', 950, 6000, 3, 571.3],
		['landing', 900, 4000, 20, 544.9],
		['landing', 800, 2000, 11, 450.4],
	];
	const at = (id: string, phase: 'takeoff' | 'landing', massKg: number, pressureAltFt: number, temperatureC: number) => {
		const r = computeTablePerformance(load(id).performance as TablePerformance, phase, { massKg, pressureAltFt, temperatureC, ...CALM });
		if (!r.ok) {
			throw new Error(`${id} ${pressureAltFt} ft above the table`);
		}
		return r.value;
	};

	for (const id of ['dr400-140b-sn2211', 'dr400-140b-sn2669']) {
		it(`${id}: never short of the charts, at most 6 % long`, () => {
			for (const [phase, kg, ft, c, chart] of readings) {
				const ratio = at(id, phase, kg, ft, c).distance15m.rawM / chart;
				expect(ratio, `${phase} ${kg} kg ${ft} ft ${c} C`).toBeGreaterThanOrEqual(0.999);
				expect(ratio, `${phase} ${kg} kg ${ft} ft ${c} C`).toBeLessThan(1.06);
			}
		});

		it(`${id}: the charts' worked examples, 950 kg at 2000 ft and 5 C, never read short`, () => {
			// Take-off: printed 550 m, though the chart's own drawn path ends at
			// 579 m; landing: printed 510 m.
			expect(at(id, 'takeoff', 950, 2000, 5).distance15m.rawM).toBeGreaterThanOrEqual(579);
			expect(at(id, 'landing', 950, 2000, 5).distance15m.rawM).toBeGreaterThanOrEqual(510);
		});
	}

	it('state each manual\'s own rules: 1992 normal, 2018 short field, x1.5, flapless + 30 % and its edges held', () => {
		const p92 = load('dr400-140b-sn2211').performance as TablePerformance;
		const p18 = load('dr400-140b-sn2669').performance as TablePerformance;
		expect([p92.takeoffProcedure, p92.marginFactor, p92.flaplessLandingFactor, p92.holdBelowTable]).toEqual(['normal', 1.3, undefined, undefined]);
		expect([p18.takeoffProcedure, p18.marginFactor, p18.flaplessLandingFactor, p18.holdBelowTable]).toEqual(['short-field', 1.5, 1.3, true]);
		// The same charts: the same cells.
		expect(p18.takeoff).toEqual(p92.takeoff);
		expect(p18.landing).toEqual(p92.landing);
		// Below the charts' 800 kg the 2018 sheet reads 800 kg (5-2, 5-4, 5-5,
		// 5-11), the 1992 one extrapolates, flagged.
		const light = { massKg: 750, pressureAltFt: 0, temperatureC: 15, ...CALM };
		const held = at('dr400-140b-sn2669', 'takeoff', 750, 0, 15);
		expect([held.groundRoll.rawM, held.distance15m.rawM, held.flags.massExtrapolated]).toEqual([185, 365, false]);
		const r92 = computeTablePerformance(p92, 'takeoff', light);
		expect(r92.ok && r92.value.distance15m.rawM).toBeLessThan(365);
		expect(r92.ok && r92.value.flags.massExtrapolated).toBe(true);
	});
});

describe('generic sheets: the 1975 DR400/140B against its own charts', () => {
	// Edition 1's charts (5.2, 5.5), a hand-drawn scan read along their
	// altitude and guide lines: [phase, kg, ft, C, chart metres].
	const readings: Array<['takeoff' | 'landing', number, number, number, number]> = [
		['takeoff', 1000, 0, 15, 581.2],
		['takeoff', 1000, 5000, 17, 955.8],
		['takeoff', 1000, 8000, -1, 1082.6],
		['takeoff', 900, 4000, 7, 609.8],
		['takeoff', 800, 7000, -9, 554.3],
		['landing', 1000, 0, 15, 513.5],
		['landing', 1000, 8000, -1, 626.6],
		['landing', 950, 6000, 3, 572.6],
		['landing', 900, 4000, 20, 545.9],
		['landing', 800, 2000, 11, 452.6],
	];
	const perf = load('dr400-140b-pre2211').performance as TablePerformance;
	const at = (p: TablePerformance, phase: 'takeoff' | 'landing', massKg: number, pressureAltFt: number, temperatureC: number) => {
		const r = computeTablePerformance(p, phase, { massKg, pressureAltFt, temperatureC, ...CALM });
		if (!r.ok) {
			throw new Error(`${pressureAltFt} ft above the table`);
		}
		return r.value.distance15m.rawM;
	};

	it('never short of its charts, at most 6.5 % long', () => {
		for (const [phase, kg, ft, c, chart] of readings) {
			const ratio = at(perf, phase, kg, ft, c) / chart;
			expect(ratio, `${phase} ${kg} kg ${ft} ft ${c} C`).toBeGreaterThanOrEqual(0.999);
			expect(ratio, `${phase} ${kg} kg ${ft} ft ${c} C`).toBeLessThan(1.065);
		}
	});

	it('reads as the 1992 manual, whose charts redraw these: within 2.5 % at every cell', () => {
		// The 1992 drawing adds a 2000 ft line, up to 2 % under the midpoint of
		// the sea level and 4000 ft lines this chart is read at.
		const p92 = load('dr400-140b-sn2211').performance as TablePerformance;
		for (const phase of ['takeoff', 'landing'] as const) {
			for (const row of perf[phase].rows) {
				for (const kg of [1000, 800]) {
					const t = 15 - (2 * row.altFt) / 1000 + row.tempC;
					const ratio = at(perf, phase, kg, row.altFt, t) / at(p92, phase, kg, row.altFt, t);
					expect(Math.abs(ratio - 1), `${phase} ${kg} kg ${row.altFt} ft ISA ${row.tempC}`).toBeLessThan(0.025);
				}
			}
		}
	});

	it('takes no headwind credit (none printed) and its grass + 20 %', () => {
		expect(perf.wind.takeoffHeadwind).toEqual([[0, 1]]);
		expect(perf.wind.landingHeadwind).toEqual([[0, 1]]);
		expect([perf.grassFactor, perf.takeoffProcedure, perf.takeoffFlapsDeg, perf.landingFlapsDeg]).toEqual([1.2, 'normal', 15, 60]);
	});
});

describe('generic sheets: the DA20-A1 take-off against its vector chart', () => {
	// Figure 5.5 read from the PDF's own paths, no wind, metres:
	// [kg, ft, C, roll, over 15 m].
	const readings: Array<[number, number, number, number, number]> = [
		[750, 0, 15, 356.4, 489.6],
		[750, 4000, 7, 494.1, 675.8],
		[750, 8000, -1, 692.8, 939.5],
		[750, 10000, 15, 930.0, 1249.4],
		[700, 2000, 25, 382.3, 524.5],
		[650, 6000, 10, 426.0, 584.0],
		[600, 0, -10, 176.5, 245.2],
		[725, 3000, 15, 435.0, 596.1],
		[680, 9000, 0, 605.1, 823.2],
	];
	const perf = load('da20-a1').performance as TablePerformance;
	const at = (phase: 'takeoff' | 'landing', c: PerfConditions) => {
		const r = computeTablePerformance(perf, phase, c);
		if (!r.ok) {
			throw new Error(`${c.pressureAltFt} ft above the table`);
		}
		return r.value;
	};

	it('never short of the chart, at most 5 % long', () => {
		for (const [kg, ft, c, roll, d15] of readings) {
			const v = at('takeoff', { massKg: kg, pressureAltFt: ft, temperatureC: c, ...CALM });
			const where = `${kg} kg ${ft} ft ${c} C`;
			expect(v.groundRoll.rawM / roll, where).toBeGreaterThanOrEqual(0.999);
			expect(v.distance15m.rawM / d15, where).toBeGreaterThanOrEqual(0.999);
			expect(v.groundRoll.rawM / roll, where).toBeLessThan(1.05);
			expect(v.distance15m.rawM / d15, where).toBeLessThan(1.05);
		}
	});

	it('the worked example (3000 ft, 15 C, 725 kg, 10 kt): at or above the printed 1025 and 1425 ft', () => {
		const v = at('takeoff', { massKg: 725, pressureAltFt: 3000, temperatureC: 15, headwindKt: 10, surface: { grass: false, wet: false } });
		expect(v.groundRoll.correctedM).toBeGreaterThanOrEqual(1025 * FT);
		expect(v.distance15m.correctedM).toBeGreaterThanOrEqual(1425 * FT);
	});

	it('credits no more headwind than the chart, nothing at landing', () => {
		// The chart's least credit over its domain: x0.763 at 10 kt, x0.558 at
		// 20 kt (the most it ever credits: x0.672 and x0.345).
		expect(perf.wind.takeoffHeadwind).toEqual([[0, 1], [10, 0.77], [20, 0.56]]);
		expect(perf.wind.landingHeadwind).toEqual([[0, 1]]);
	});

	it('lands on the printed table at ISA, and longer on a hot day', () => {
		const land = (ft: number, c: number) => at('landing', { massKg: 750, pressureAltFt: ft, temperatureC: c, ...CALM });
		// Figure 5.11: 1532 ft and 790 ft at sea level, 1714 and 862 at 3000 ft.
		expect(land(0, 15).distance15m.rawM).toBeGreaterThanOrEqual(1532 * FT);
		expect(land(0, 15).groundRoll.rawM).toBeGreaterThanOrEqual(790 * FT);
		expect(land(3000, 9).distance15m.rawM).toBeGreaterThanOrEqual(1714 * FT);
		expect(land(3000, 9).distance15m.rawM).toBeLessThan(1714 * FT + 1);
		// ISA + 20 reads the table at the density altitude, never the ISA value.
		expect(land(0, 35).distance15m.rawM / land(0, 15).distance15m.rawM).toBeGreaterThan(1.07);
		expect(land(0, -5).distance15m.rawM).toBeCloseTo(land(0, 15).distance15m.rawM, 6);
	});
});

describe('generic sheets: the DA20-C1 take-off against its vector chart', () => {
	// Figure 5.4 (two sheets) read from the PDF's own paths, no wind, metres:
	// [kg, ft, C, roll, over 15 m].
	const readings: Array<[number, number, number, number, number]> = [
		[800, 0, 15, 393.9, 506.3],
		[800, 4000, 7, 515.5, 683.5],
		[800, 6000, 3, 591.0, 803.2],
		[750, 2000, 25, 442.5, 575.7],
		[700, 5000, 10, 424.0, 548.8],
		[650, 1000, -5, 213.6, 277.8],
		[600, 0, 30, 228.5, 296.3],
		[725, 3000, 15, 405.0, 521.3],
	];
	const perf = load('da20-c1').performance as TablePerformance;
	const at = (phase: 'takeoff' | 'landing', c: PerfConditions) => {
		const r = computeTablePerformance(perf, phase, c);
		if (!r.ok) {
			throw new Error(`${c.pressureAltFt} ft above the table`);
		}
		return r.value;
	};

	it('never short of the chart, at most 8 % long', () => {
		for (const [kg, ft, c, roll, d15] of readings) {
			const v = at('takeoff', { massKg: kg, pressureAltFt: ft, temperatureC: c, ...CALM });
			const where = `${kg} kg ${ft} ft ${c} C`;
			expect(v.groundRoll.rawM / roll, where).toBeGreaterThanOrEqual(0.999);
			expect(v.distance15m.rawM / d15, where).toBeGreaterThanOrEqual(0.999);
			expect(v.groundRoll.rawM / roll, where).toBeLessThan(1.08);
			expect(v.distance15m.rawM / d15, where).toBeLessThan(1.08);
		}
	});

	it('stops where the chart stops, 6000 ft', () => {
		const r = computeTablePerformance(perf, 'takeoff', { massKg: 800, pressureAltFt: 6500, temperatureC: 0, ...CALM });
		expect(r.ok).toBe(false);
	});

	it('the worked example (1000 ft, 22 C, 725 kg, 4 kt) clears the printed 341 m to 5 m, so 15 m is longer', () => {
		const v = at('takeoff', { massKg: 725, pressureAltFt: 1000, temperatureC: 22, headwindKt: 4, surface: { grass: false, wet: false } });
		expect(v.distance15m.correctedM).toBeGreaterThan(341);
	});

	it('takes its own wind: x0.78 / 0.62 headwind credit, 14 % per 2 kt of tailwind, nothing at landing', () => {
		expect(perf.wind.takeoffHeadwind).toEqual([[0, 1], [10, 0.78], [20, 0.62]]);
		expect(perf.wind.landingHeadwind).toEqual([[0, 1]]);
		expect(perf.wind.tailwindPctPer2Kt).toBe(14);
	});

	it('lands on the printed table plus its ground-idle allowance, longer on a hot day', () => {
		const land = (ft: number, c: number) => at('landing', { massKg: 800, pressureAltFt: ft, temperatureC: c, ...CALM });
		// Table 4: 1360 ft and 661 ft at sea level, + 5 % and + 7 %.
		expect(land(0, 15).distance15m.rawM).toBeGreaterThanOrEqual(1360 * FT * 1.05);
		expect(land(0, 15).groundRoll.rawM).toBeGreaterThanOrEqual(661 * FT * 1.07);
		expect(land(7000, 1).distance15m.rawM).toBeGreaterThanOrEqual(1580 * FT * 1.05);
		expect(land(0, 35).distance15m.rawM / land(0, 15).distance15m.rawM).toBeGreaterThan(1.04);
	});
});

describe('generic sheets: the DR400/155CDI (DR401) tables', () => {
	const a = load('dr400-155cdi-sn2669');
	const perf = a.performance as TablePerformance;
	const isa = (altFt: number) => 15 - (2 * altFt) / 1000;
	const at = (phase: 'takeoff' | 'landing', c: PerfConditions) => {
		const r = computeTablePerformance(perf, phase, c);
		if (!r.ok) {
			throw new Error(`${c.pressureAltFt} ft above the table`);
		}
		return r.value;
	};

	it('reads the printed take-off cells (tables 5-2 and 5-3)', () => {
		// [ft, ISA offset, 1100 kg [roll, 15 m], 1000 kg [roll, 15 m]].
		const printed: Array<[number, number, [number, number], [number, number]]> = [
			[0, 0, [214, 400], [167, 312]],
			[0, 30, [266, 501], [208, 391]],
			[3000, 10, [273, 511], [213, 399]],
			[5000, 20, [329, 618], [257, 482]],
			[7000, 0, [322, 603], [251, 471]],
			[8000, 0, [345, 648], [269, 506]],
			[8000, 30, [430, 811], [335, 633]],
		];
		for (const [ft, off, heavy, light] of printed) {
			for (const [massKg, [roll, d15]] of [
				[1100, heavy],
				[1000, light],
			] as const) {
				const v = at('takeoff', { massKg, pressureAltFt: ft, temperatureC: isa(ft) + off, ...CALM });
				const where = `${massKg} kg ${ft} ft ISA + ${off}`;
				expect(v.groundRoll.rawM, where).toBeCloseTo(roll, 6);
				expect(v.distance15m.rawM, where).toBeCloseTo(d15, 6);
			}
		}
	});

	it('holds its 1000 kg column and its coldest column below them, unflagged (5-2, 5-4, 5-5)', () => {
		// 850 kg at 2000 ft and -10 C (ISA - 21): the 1000 kg ISA cell.
		const v = at('takeoff', { massKg: 850, pressureAltFt: 2000, temperatureC: -10, ...CALM });
		expect(v.distance15m.rawM).toBeCloseTo(349, 6);
		expect(v.groundRoll.rawM).toBeCloseTo(187, 6);
		expect(v.flags).toEqual({ massExtrapolated: false, altitudeExtrapolatedBelow: false, temperatureExtrapolated: false });
	});

	it('the worked landing example (4-21): 415 x 0.85 = 353 m, a normal landing 1.5 x 353 = 530 m', () => {
		const v = at('landing', { massKg: 1100, pressureAltFt: 0, temperatureC: 15, headwindKt: 10, surface: { grass: false, wet: false } });
		expect(v.distance15m.rawM).toBeCloseTo(415, 6);
		expect(v.distance15m.correctedM).toBeCloseTo(352.75, 6);
		expect(Math.abs(v.distance15m.requiredM - 530)).toBeLessThan(1);
	});

	it('reads its landing table as printed, heights and temperatures, never short and at most 7 % long', () => {
		// Table 5-10, 1100 kg: [ft, C, roll, over 15 m].
		const printed: Array<[number, number, number, number]> = [
			[0, -5, 150, 355],
			[0, 15, 175, 415],
			[0, 35, 205, 480],
			[2500, -13, 160, 375],
			[2500, 7, 185, 440],
			[2500, 27, 215, 510],
			[5000, -21, 170, 390],
			[5000, -1, 200, 460],
			[5000, 19, 235, 535],
		];
		for (const [ft, c, roll, d15] of printed) {
			const v = at('landing', { massKg: 1100, pressureAltFt: ft, temperatureC: c, ...CALM });
			const where = `${ft} ft ${c} C`;
			expect(v.groundRoll.rawM, where).toBeGreaterThanOrEqual(roll);
			expect(v.distance15m.rawM, where).toBeGreaterThanOrEqual(d15);
			expect(v.distance15m.rawM / d15, where).toBeLessThan(1.07);
		}
	});

	it("never reads shorter than the misprint's other reading, the temperatures' heights 0 / 4000 / 8000 ft", () => {
		// The printed distances at ISA - 20 / ISA / ISA + 20 of 0, 4000 and
		// 8000 ft, interpolated as the app interpolates.
		const other = [
			[355, 415, 480],
			[375, 440, 510],
			[390, 460, 535],
		];
		const otherAt = (ft: number, off: number) => {
			const [i, f] = ft <= 4000 ? [0, ft / 4000] : [1, (ft - 4000) / 4000];
			const col = (j: number) => other[i][j] + (other[i + 1][j] - other[i][j]) * f;
			return off <= 0 ? col(0) + ((col(1) - col(0)) * (off + 20)) / 20 : col(1) + ((col(2) - col(1)) * off) / 20;
		};
		for (let ft = 0; ft <= 5000; ft += 250) {
			for (let off = -20; off <= 20; off += 2) {
				const v = at('landing', { massKg: 1100, pressureAltFt: ft, temperatureC: isa(ft) + off, ...CALM });
				expect(v.distance15m.rawM, `${ft} ft ISA ${off}`).toBeGreaterThanOrEqual(otherAt(ft, off) - 1e-9);
			}
		}
	});

	it('stops where its landing table stops, 5000 ft; its take-off goes to 8000', () => {
		expect(computeTablePerformance(perf, 'landing', { massKg: 1100, pressureAltFt: 5500, temperatureC: 0, ...CALM }).ok).toBe(false);
		expect(computeTablePerformance(perf, 'takeoff', { massKg: 1100, pressureAltFt: 8000, temperatureC: 0, ...CALM }).ok).toBe(true);
	});

	it("states the manual's rules: short field only, x1.5, flapless + 30 %, grass + 15 %, its own wind", () => {
		expect([perf.takeoffProcedure, perf.marginFactor, perf.flaplessLandingFactor, perf.grassFactor]).toEqual(['short-field', 1.5, 1.3, 1.15]);
		expect(perf.wind.takeoffHeadwind).toEqual([[0, 1], [10, 0.85], [20, 0.65], [30, 0.55]]);
		expect(perf.wind.landingHeadwind).toEqual(perf.wind.takeoffHeadwind);
		expect(perf.wind.tailwindPctPer2Kt).toBe(10);
		expect(perf.holdBelowTable).toBe(true);
	});

	it('takes Jet A-1, 109 of its 110 L, and cruises at its printed powers (5-16)', () => {
		expect(a.fuel!.types).toEqual(['JET A-1']);
		expect([a.fuel!.capacityL, a.fuel!.usableL, a.fuel!.consumptionLph]).toEqual([110, 109, 22.1]);
		// 3000 ft, the mean of the 2000 and 4000 ft rows: 70 % at 205 km/h.
		expect([a.cruise!.name, a.cruise!.speedKt]).toEqual(['70 %', Math.floor(205 / 1.852)]);
		expect(a.cruise!.settings).toEqual([
			{ name: '80 %', speedKt: Math.floor(218.5 / 1.852), consumptionLph: 25.8 },
			{ name: '60 %', speedKt: Math.floor(188 / 1.852), consumptionLph: 18.6 },
			{ name: '50 %', speedKt: Math.floor(169.5 / 1.852), consumptionLph: 15.3 },
		]);
		expect([a.climb!.speedKt, a.climb!.rateFtMin]).toEqual([78, 740]);
	});
});

describe('generic sheets: the DR400/160 and /180, wing tanks apart', () => {
	const TANKED = ['dr400-160-pre2220', 'dr400-160-sn2220', 'dr400-180-sn2216'];
	const isa = (altFt: number) => 15 - (2 * altFt) / 1000;
	const at = (id: string, phase: 'takeoff' | 'landing', c: PerfConditions) => {
		const r = computeTablePerformance(load(id).performance as TablePerformance, phase, c);
		if (!r.ok) {
			throw new Error(`${id} ${c.pressureAltFt} ft above the table`);
		}
		return r.value;
	};

	it('read the printed cells (DR400/160 5.2, 5.03 and 5.07, DR400/180 5.03)', () => {
		// [sheet, phase, kg, ft, ISA offset, roll, over 15 m].
		const printed: Array<[string, 'takeoff' | 'landing', number, number, number, number, number]> = [
			['dr400-160-pre2220', 'takeoff', 1050, 0, 0, 310, 620],
			['dr400-160-pre2220', 'takeoff', 850, 8000, 20, 400, 790],
			['dr400-160-pre2220', 'takeoff', 1050, 4000, -20, 375, 750],
			['dr400-160-sn2220', 'takeoff', 1050, 0, 0, 295, 590],
			['dr400-160-sn2220', 'takeoff', 850, 8000, 20, 380, 750],
			['dr400-160-sn2220', 'landing', 1050, 4000, -20, 260, 565],
			['dr400-160-sn2220', 'landing', 850, 8000, 0, 260, 555],
			['dr400-180-sn2216', 'takeoff', 1100, 2500, 0, 305, 635],
			['dr400-180-sn2216', 'takeoff', 900, 5000, 20, 250, 520],
			['dr400-180-sn2216', 'takeoff', 1100, 8000, 20, 590, 1225],
		];
		for (const [id, phase, massKg, ft, off, roll, d15] of printed) {
			const v = at(id, phase, { massKg, pressureAltFt: ft, temperatureC: isa(ft) + off, ...CALM });
			const where = `${id} ${phase} ${massKg} kg ${ft} ft ISA ${off}`;
			expect(v.groundRoll.rawM, where).toBeCloseTo(roll, 6);
			expect(v.distance15m.rawM, where).toBeCloseTo(d15, 6);
		}
	});

	it('DR400/180: the landing printed at 1045 and 845 kg reads back from its line at 1100 / 900 kg', () => {
		// 5.07: [ft, ISA offset, 1045 kg [roll, 15 m], 845 kg [roll, 15 m]].
		const printed: Array<[number, number, [number, number], [number, number]]> = [
			[0, -20, [230, 500], [190, 425]],
			[0, 0, [250, 530], [200, 450]],
			[0, 20, [270, 560], [215, 475]],
			[4000, -20, [260, 550], [210, 465]],
			[4000, 0, [280, 585], [230, 495]],
			[4000, 20, [300, 620], [240, 520]],
			[8000, -20, [295, 610], [240, 510]],
			[8000, 0, [320, 650], [260, 545]],
			[8000, 20, [340, 690], [275, 575]],
		];
		for (const [ft, off, heavy, light] of printed) {
			for (const [massKg, [roll, d15]] of [
				[1045, heavy],
				[845, light],
			] as const) {
				const v = at('dr400-180-sn2216', 'landing', { massKg, pressureAltFt: ft, temperatureC: isa(ft) + off, ...CALM });
				const where = `${massKg} kg ${ft} ft ISA ${off}`;
				// Never short, at most the metre the cells were rounded up by.
				expect(v.groundRoll.rawM, where).toBeGreaterThanOrEqual(roll - 1e-9);
				expect(v.groundRoll.rawM, where).toBeLessThan(roll + 1);
				expect(v.distance15m.rawM, where).toBeGreaterThanOrEqual(d15 - 1e-9);
				expect(v.distance15m.rawM, where).toBeLessThan(d15 + 1);
			}
		}
	});

	it('DR400/160, 1972: the landing printed at 1045 and 845 kg reads back from its line at 1050 / 850 kg', () => {
		// 5.5, moderate braking: [ft, ISA offset, 1045 kg [roll, 15 m],
		// 845 kg [roll, 15 m]]. Additif 4 (7.13) prints the same figures at
		// 1050 and 850 kg.
		const printed: Array<[number, number, [number, number], [number, number]]> = [
			[0, -20, [230, 510], [190, 435]],
			[0, 0, [250, 545], [205, 460]],
			[0, 20, [270, 575], [215, 485]],
			[4000, -20, [260, 565], [210, 475]],
			[4000, 0, [280, 600], [230, 505]],
			[4000, 20, [300, 635], [245, 535]],
			[8000, -20, [295, 620], [240, 520]],
			[8000, 0, [320, 660], [260, 555]],
			[8000, 20, [340, 700], [275, 585]],
		];
		for (const [ft, off, heavy, light] of printed) {
			for (const [massKg, [roll, d15]] of [
				[1045, heavy],
				[845, light],
			] as const) {
				const v = at('dr400-160-pre2220', 'landing', { massKg, pressureAltFt: ft, temperatureC: isa(ft) + off, ...CALM });
				const where = `${massKg} kg ${ft} ft ISA ${off}`;
				expect(v.groundRoll.rawM, where).toBeGreaterThanOrEqual(roll - 1e-9);
				expect(v.groundRoll.rawM, where).toBeLessThan(roll + 1);
				expect(v.distance15m.rawM, where).toBeGreaterThanOrEqual(d15 - 1e-9);
				expect(v.distance15m.rawM, where).toBeLessThan(d15 + 1);
			}
		}
	});

	it('DR400/160, 1972: the one grass factor covers every printed grass distance over 15 m, and the margined roll', () => {
		// The take-off table's grass columns (5.2): [ft, ISA offset,
		// 1050 kg [roll, 15 m], 850 kg [roll, 15 m]].
		const grass: Array<[number, number, [number, number], [number, number]]> = [
			[0, -20, [380, 660], [220, 405]],
			[0, 0, [435, 745], [250, 450]],
			[0, 20, [490, 830], [280, 500]],
			[4000, -20, [550, 925], [310, 550]],
			[4000, 0, [635, 1055], [350, 615]],
			[4000, 20, [730, 1195], [400, 690]],
			[8000, -20, [835, 1355], [445, 765]],
			[8000, 0, [980, 1565], [515, 870]],
			[8000, 20, [1145, 1805], [590, 980]],
		];
		const perf = load('dr400-160-pre2220').performance as TablePerformance;
		for (const [ft, off, heavy, light] of grass) {
			for (const [massKg, [roll, d15]] of [
				[1050, heavy],
				[850, light],
			] as const) {
				const v = at('dr400-160-pre2220', 'takeoff', {
					massKg,
					pressureAltFt: ft,
					temperatureC: isa(ft) + off,
					headwindKt: 0,
					surface: { grass: true, wet: false },
				});
				const where = `${massKg} kg ${ft} ft ISA ${off}`;
				expect(v.distance15m.correctedM, where).toBeGreaterThanOrEqual(d15 - 0.05);
				expect(v.distance15m.correctedM, where).toBeGreaterThanOrEqual(perf.marginFactor * roll);
			}
		}
	});

	it("state each manual's rules", () => {
		const p72 = load('dr400-160-pre2220');
		const perf72 = p72.performance as TablePerformance;
		// 1972: no margin rule, grass columns of its own, its own headwind
		// credit and no tailwind figure; one take-off, flaps 15, landing 60.
		expect([perf72.marginFactor, perf72.grassFactor, perf72.flaplessLandingFactor, perf72.holdBelowTable]).toEqual([1.3, 1.38, undefined, undefined]);
		expect(perf72.wind.takeoffHeadwind).toEqual([[0, 1], [10, 0.8], [20, 0.66], [30, 0.55]]);
		expect(perf72.wind.landingHeadwind).toEqual(perf72.wind.takeoffHeadwind);
		expect(perf72.wind.tailwindPctPer2Kt).toBe(10);
		expect([perf72.takeoffProcedure, perf72.takeoffFlapsDeg, perf72.landingFlapsDeg]).toEqual(['normal', 15, 60]);
		expect([p72.fuel!.capacityL, p72.fuel!.usableL, p72.fuel!.consumptionLph]).toEqual([190, 190, 35]);
		expect(p72.massBalance!.fuelTanks!.map((t) => [t.label, t.armM, t.usableL])).toEqual([
			['Main tank', 1.12, 110],
			['Wing tanks', 0.1, 80],
		]);
		expect(p72.massBalance!.maxLandingMassKg).toBe(1045);
		expect(p72.massBalance!.stations.map((st) => [st.label, st.armM, st.maxMassKg])).toEqual([
			['Front seats', 0.41, undefined],
			['Rear seats', 1.19, undefined],
			['Baggage', 1.9, 40],
		]);
		expect([p72.cruise!.speedKt, p72.cruise!.settings, p72.climb!.speedKt, p72.climb!.rateFtMin]).toEqual([
			131,
			[{ name: '60 %', speedKt: 119, consumptionLph: 28 }],
			89,
			745,
		]);
		const p160 = load('dr400-160-sn2220');
		const p180 = load('dr400-180-sn2216');
		for (const a of [p160, p180]) {
			const perf = a.performance as TablePerformance;
			expect([perf.marginFactor, perf.grassFactor, perf.flaplessLandingFactor, perf.holdBelowTable]).toEqual([1.3, 1.15, undefined, undefined]);
			expect(perf.wind.takeoffHeadwind).toEqual([[0, 1], [10, 0.85], [20, 0.65], [30, 0.55]]);
			expect(perf.wind.landingHeadwind).toEqual(perf.wind.takeoffHeadwind);
			expect([a.fuel!.capacityL, a.fuel!.usableL]).toEqual([190, 189]);
			expect(a.massBalance!.fuelTanks!.map((t) => [t.label, t.armM, t.usableL])).toEqual([
				['Main tank', 1.12, 109],
				['Wing tanks', 0.1, 80],
			]);
			expect(a.massBalance!.maxLandingMassKg).toBe(1045);
		}
		// The /160's table is its normal take-off's (4.09: the short one climbs
		// at 120 km/h); the /180's speeds are both take-offs', read as the
		// short one.
		expect((p160.performance as TablePerformance).takeoffProcedure).toBe('normal');
		expect((p180.performance as TablePerformance).takeoffProcedure).toBe('short-field');
		expect(p160.massBalance!.stations.find((st) => st.label === 'Baggage')!.maxMassKg).toBe(40);
		expect(p180.massBalance!.stations.find((st) => st.label === 'Baggage')!.maxMassKg).toBe(60);
		expect([p160.cruise!.speedKt, p160.climb!.rateFtMin, p180.cruise!.speedKt, p180.climb!.rateFtMin]).toEqual([129, 835, 131, 885]);
	});

	it.each(TANKED.map((id) => [id]))(
		'%s: the main tank filled first is the aft-most split; no other split takes a loading past the forward limit',
		(id) => {
			const mb = load(id).massBalance!;
			const slots = fuelSlots(mb);
			const wingsFirst = [...slots].reverse();
			const top = Math.max(...mb.envelope.map((p) => p.massKg));
			const bagMax = mb.stations.find((st) => st.label === 'Baggage')!.maxMassKg!;
			let loadings = 0;
			for (let front = 60; front <= 200; front += 20) {
				for (let rear = 0; rear <= 154; rear += 22) {
					for (let bag = 0; bag <= bagMax; bag += 10) {
						const zf = zeroFuelPoint(mb, [front, rear, bag]);
						for (let litres = 20; litres <= 189; litres += 10) {
							const asSheet = withFuelL(zf, slots, litres, DENSITY);
							if (asSheet.massKg > top || !pointInEnvelope(mb.envelope, asSheet.armM, asSheet.massKg)) {
								continue;
							}
							loadings++;
							// The same litres, wings filled first: forward of the sheet's.
							const fwd = withFuelL(zf, wingsFirst, litres, DENSITY);
							expect(fwd.armM).toBeLessThanOrEqual(asSheet.armM + 1e-12);
							expect(pointInEnvelope(mb.envelope, fwd.armM, fwd.massKg), `${front} / ${rear} / ${bag} kg, ${litres} L`).toBe(true);
						}
					}
				}
			}
			expect(loadings).toBeGreaterThan(1000);
		},
	);
});

describe('generic sheets: the PA-34-200 Seneca against its charts', () => {
	// Read from the charts' lines, still air, ft: take-off [lb, ft, C, roll
	// (8-2), over 50 ft (8-5), accelerate-stop (8-6)], landing [lb, ft, C,
	// roll (8-13), over 50 ft (8-14)], the 4200 lb landing carried along the
	// guides past their 4000 lb start.
	const takeoff: Array<[number, number, number, number, number, number]> = [
		[4200, 0, 15, 1014, 1440, 1990],
		[3600, 4000, 4.4, 1179, 1627, 2115],
		[3000, 6000, 26.7, 1355, 2030, 2252],
		[4200, 2000, 37.8, 1638, 2328, 2786],
		[3400, 8000, -6.7, 1498, 2157, 2491],
		[2800, 0, -17.8, 429, 598, 989],
		[3800, 5000, 20, 1652, 2387, 2742],
		[4000, 7000, 30, 2409, 3688, 3703],
	];
	const landing: Array<[number, number, number, number, number]> = [
		[4000, 0, 15, 702, 1334],
		[3600, 4000, 4.4, 704, 1333],
		[3200, 6000, 26.7, 733, 1363],
		[3400, 8000, -6.7, 746, 1366],
		[4000, 2000, 37.8, 821, 1453],
		[4200, 1000, 20, 782, 1414],
		[2800, 3000, 10, 541, 1174],
	];
	const a = load('pa34-200');
	const perf = a.performance as TablePerformance;
	const oei = a.oneEngineInoperative!;
	const MPH = 0.868976;
	const cond = (lb: number, ft: number, c: number, headwindKt = 0): PerfConditions => ({
		massKg: lb * LB,
		pressureAltFt: ft,
		temperatureC: c,
		headwindKt,
		surface: { grass: false, wet: false },
	});
	const at = (phase: 'takeoff' | 'landing', c: PerfConditions) => {
		const r = computeTablePerformance(perf, phase, c);
		if (!r.ok) {
			throw new Error(`${c.pressureAltFt} ft above the table`);
		}
		return r.value;
	};
	const asd = (c: PerfConditions) => {
		const r = computeAccelerateStop(perf, c);
		if (!r?.ok) {
			throw new Error('no accelerate-stop figure');
		}
		return r.figure;
	};
	const f = (degF: number) => ((degF - 32) * 5) / 9;

	it('is a twin, written version 2, with its accelerate-stop and one-engine data', () => {
		expect(isMultiEngine(a)).toBe(true);
		expect(aircraftDocVersion(a)).toBe(2);
		expect(perf.accelerateStop?.rows).toHaveLength(30);
		expect([oei.vmcKt, oei.vyseKt]).toEqual([69.6, 91.5]);
		expect(oei.takeoffClimb).toBeUndefined();
	});

	it('never short of the charts, at most 4 % long', () => {
		for (const [lb, ft, c, roll, d50, stop] of takeoff) {
			const v = at('takeoff', cond(lb, ft, c));
			const where = `${lb} lb ${ft} ft ${c} C`;
			for (const [got, chart] of [[v.groundRoll.rawM, roll], [v.distance15m.rawM, d50], [asd(cond(lb, ft, c)).rawM, stop]]) {
				expect(got / (chart * FT), where).toBeGreaterThanOrEqual(0.999);
				expect(got / (chart * FT), where).toBeLessThan(1.04);
			}
		}
		for (const [lb, ft, c, roll, d50] of landing) {
			const v = at('landing', cond(lb, ft, c));
			const where = `${lb} lb ${ft} ft ${c} C`;
			for (const [got, chart] of [[v.groundRoll.rawM, roll], [v.distance15m.rawM, d50]]) {
				expect(got / (chart * FT), where).toBeGreaterThanOrEqual(0.999);
				expect(got / (chart * FT), where).toBeLessThan(1.04);
			}
		}
	});

	it('runs the printed worked examples long, never short, the headwind credited the sheet\'s way', () => {
		// 70 F, 3600 lb: 2000 ft and 10 mph, roll 900 ft (8-2) and accelerate-
		// stop 1650 ft (8-6); 4000 ft and 10 mph, 1600 ft over 50 ft (8-5);
		// 2000 ft and 5 mph, landing roll 615 ft (8-13); 4000 ft and 5 mph,
		// 1240 ft over 50 ft (8-14).
		expect(at('takeoff', cond(3600, 2000, f(70), 10 * MPH)).groundRoll.correctedM).toBeGreaterThanOrEqual(900 * FT);
		expect(asd(cond(3600, 2000, f(70), 10 * MPH)).correctedM).toBeGreaterThanOrEqual(1650 * FT);
		expect(at('takeoff', cond(3600, 4000, f(70), 10 * MPH)).distance15m.correctedM).toBeGreaterThanOrEqual(1600 * FT);
		expect(at('landing', cond(3600, 2000, f(70), 5 * MPH)).groundRoll.correctedM).toBeGreaterThanOrEqual(615 * FT);
		expect(at('landing', cond(3600, 4000, f(70), 5 * MPH)).distance15m.correctedM).toBeGreaterThanOrEqual(1240 * FT);
		// 1-1: landing at 4000 lb, sea level, standard, 705 ft roll and 1335
		// over 50 ft.
		expect(at('landing', cond(4000, 0, 15)).groundRoll.rawM).toBeGreaterThanOrEqual(705 * FT);
		expect(at('landing', cond(4000, 0, 15)).distance15m.rawM).toBeGreaterThanOrEqual(1335 * FT);
	});

	it('credits no more headwind than the guides, every 5 mph in knots rounded up', () => {
		expect(perf.wind.takeoffHeadwind).toEqual([[0, 1], [4.4, 0.92], [8.7, 0.84], [13.1, 0.77], [17.4, 0.7], [21.8, 0.62], [26.1, 0.55]]);
		expect(perf.wind.landingHeadwind).toEqual([[0, 1], [4.4, 0.92], [8.7, 0.84], [13.1, 0.76], [17.4, 0.68], [21.8, 0.61], [26.1, 0.54]]);
		expect(perf.accelerateStop?.headwind).toEqual([[0, 1], [4.4, 0.92], [8.7, 0.83], [13.1, 0.74], [17.4, 0.66], [21.8, 0.58], [26.1, 0.51]]);
		expect(perf.wind.tailwindPctPer2Kt).toBe(10);
	});

	it('keeps the single engine climb at or under its chart lines, the 4200 lb one within 6 ft/min', () => {
		// 8-8 read straight: ft/min at density altitude 0, and per 1000 ft.
		const lines: Array<[number, number, number]> = [
			[3400, 428.2, -37.66],
			[3700, 331.6, -36.41],
			[4000, 230.6, -34.78],
			[4200, 193.0, -38.8],
		];
		// ICAO standard atmosphere: the altitude of the air's density.
		const densityAltFt = (paFt: number, tC: number) => {
			const p = (1 - (0.0065 * paFt * FT) / 288.15) ** 5.25588;
			const rho = (p * 288.15) / (tC + 273.15);
			return ((288.15 / 0.0065) * (1 - rho ** (1 / 4.25588))) / FT;
		};
		for (const [lb, sl, per1000] of lines) {
			for (let ft = 0; ft <= 14000; ft += 1000) {
				for (const off of [-20, 0, 20]) {
					const t = 15 - (2 * ft) / 1000 + off;
					const chart = sl + (per1000 * densityAltFt(ft, t)) / 1000;
					const c = oeiClimbAt(oei, 'enroute', lb * LB, ft, t);
					if (c === null || c === 'above') {
						throw new Error('no climb figure');
					}
					expect(c.rateFtMin, `${lb} lb ${ft} ft ISA ${off}`).toBeLessThanOrEqual(chart + 1);
					if (lb === 4200) {
						expect(c.rateFtMin, `${lb} lb ${ft} ft ISA ${off}`).toBeGreaterThan(chart - 6);
					}
				}
			}
		}
	});

	it("puts the net ceiling at 4200 lb, ISA, at the manual's 3650 ft, and never above its 5200 ft at 4000 lb", () => {
		const isa = (alt: number) => ({ pressureAltFt: alt, temperatureC: 15 - (2 * alt) / 1000 });
		const ceiling = (lb: number) => {
			const c = oeiNetCeiling(oei, lb * LB, isa);
			expect(c?.kind).toBe('ceiling');
			return c!.altFt;
		};
		// 1-1: single engine service ceiling (50 ft/min) 3650 ft at 4200 lb,
		// 5200 ft at 4000 lb; the net gradient's nil (0.5 % at Vyse) comes
		// within 50 ft of the first.
		expect(Math.abs(ceiling(4200) - 3650)).toBeLessThan(50);
		expect(ceiling(4000)).toBeLessThanOrEqual(5200);
		// The light end keeps the chart high up: 50 ft/min near 10000 ft at
		// 3400 lb.
		expect(ceiling(3400)).toBeGreaterThan(9500);
		expect(ceiling(3400)).toBeLessThan(10100);
	});

	it('meets CAT.POL.A.340 at maximum weight on a standard day at sea level, not at 35 C', () => {
		expect(oeiTakeoffClimb(oei, 4200 * LB, 0, 15).sufficient).toBe(true);
		expect(oeiLandingClimb(oei, 4200 * LB, 0, 15).sufficient).toBe(true);
		expect(oeiTakeoffClimb(oei, 4200 * LB, 0, 35).sufficient).toBe(false);
		expect(oeiLandingClimb(oei, 4200 * LB, 0, 35).sufficient).toBe(false);
	});
});
