/* Fuel tanks of their own (massAndBalance.fuelTanks): the DR400/160 and
 * /180 carry a main tank and wing tanks a metre apart. The sheet lists them
 * in the order the fuel goes in; what is aboard fills them in that order
 * and is burnt in reverse, so the wing fuel goes first and the CG moves aft
 * while it does. A sheet with one fuel arm reads as before
 * (tests/aircraftMassBalance.spec.ts). */

import { describe, it, expect } from 'vitest';
import { parseAircraftYaml, stringifyAircraftYaml } from '$lib/aircraft/schema';
import {
	cgTravel,
	computeMassBalance,
	fuelBySlot,
	fuelLimitFault,
	fuelMomentKgM,
	fuelSlots,
	zeroFuelPoint,
} from '$lib/aircraft/massBalance';
import { aircraftToDraft, draftDefaultLoad, draftGaps, draftToAircraft } from '$lib/aircraft/edit';
import { cgTripPlot } from '$lib/components/flightprep/cgChart';

const D = 0.72;
/** A DR400/180 after its 2007 manual (2.05, 6.03): the main tank 110 L
 *  (109 usable) at 1.12 m, the wing tanks 80 L at 0.10 m. */
const TANKS = `version: 1
aircraft: { type: DR400/180, name: Tank probe }
fuel: { capacityL: 190, usableL: 189, types: [100LL], consumptionLph: 38 }
massAndBalance:
  emptyMassKg: 620
  emptyArmM: 0.3226
  stations:
    - { label: Front seats, armM: 0.41, defaultMassKg: 80 }
    - { label: Rear seats, armM: 1.19, defaultMassKg: 0, maxMassKg: 154 }
    - { label: Baggage, armM: 1.9, defaultMassKg: 0, maxMassKg: 60 }
  fuelTanks:
    - { label: Main tank, armM: 1.12, capacityL: 110, usableL: 109 }
    - { label: Wing tanks, armM: 0.10, capacityL: 80 }
  envelope:
    - { armM: 0.205, massKg: 500 }
    - { armM: 0.205, massKg: 750 }
    - { armM: 0.428, massKg: 1100 }
    - { armM: 0.564, massKg: 1100 }
    - { armM: 0.564, massKg: 500 }
`;
const a = parseAircraftYaml(TANKS);
const mb = a.massBalance!;
const slots = fuelSlots(mb);

describe('fuel tanks: where the fuel aboard sits', () => {
	it('fills the tanks in the order listed, each to its usable litres', () => {
		expect(slots.map((s) => [s.label, s.armM, s.usableL])).toEqual([
			['Main tank', 1.12, 109],
			['Wing tanks', 0.1, 80],
		]);
		expect(fuelBySlot(slots, 50)).toEqual([50, 0]);
		expect(fuelBySlot(slots, 109)).toEqual([109, 0]);
		expect(fuelBySlot(slots, 150)).toEqual([109, 41]);
		expect(fuelBySlot(slots, 189)).toEqual([109, 80]);
		expect(fuelMomentKgM(slots, 150, D)).toBeCloseTo(109 * D * 1.12 + 41 * D * 0.1, 9);
	});

	it('one fuel arm is one slot taking everything', () => {
		const one = fuelSlots({ fuelArmM: 1.12 });
		expect(one).toEqual([{ label: '', armM: 1.12, usableL: Infinity }]);
		expect(fuelMomentKgM(one, 100, D)).toBeCloseTo(100 * D * 1.12, 9);
	});

	it('weighs each tank at its arm, and burns the wing fuel first', () => {
		// The manual's example loads 150 kg in front, 90 behind, 17 of baggage.
		const r = computeMassBalance({ mb, stationMassesKg: [150, 90, 17], fuelL: 158, burnL: 60, densityKgPerL: D });
		const fuel = r.rows.filter((row) => row.kind === 'fuel');
		expect(fuel.map((row) => [row.key, row.label, row.litres, row.armM])).toEqual([
			['0', 'Main tank', 109, 1.12],
			['1', 'Wing tanks', 49, 0.1],
		]);
		const zf = zeroFuelPoint(mb, [150, 90, 17]);
		expect(r.takeoff.momentKgM).toBeCloseTo(zf.momentKgM + 109 * D * 1.12 + 49 * D * 0.1, 9);
		// 60 L burnt: the 49 L of the wings, then 11 L of the main tank.
		expect(r.burnMomentKgM).toBeCloseTo(49 * D * 0.1 + 11 * D * 1.12, 9);
		expect(r.landing.massKg).toBeCloseTo(r.takeoff.massKg - 60 * D, 9);
		expect(r.landing.momentKgM).toBeCloseTo(zf.momentKgM + 98 * D * 1.12, 9);
		expect(r.zeroFuel.momentKgM).toBeCloseTo(zf.momentKgM, 9);
		expect(r.fuelL).toBe(158);
	});

	it('draws the burn aft while the wing fuel goes, then forward, the turn exact', () => {
		const r = computeMassBalance({ mb, stationMassesKg: [150, 90, 17], fuelL: 189, burnL: 189, densityKgPerL: D });
		const path = cgTravel(r.takeoff, slots, 189, D);
		expect(path[0].massKg).toBeCloseTo(r.takeoff.massKg, 9);
		expect(path[0].armM).toBeCloseTo(r.takeoff.armM, 9);
		expect(path.at(-1)!.massKg).toBeCloseTo(r.zeroFuel.massKg, 9);
		expect(path.at(-1)!.armM).toBeCloseTo(r.zeroFuel.armM, 9);
		// The wings run dry with the main tank full: 109 L aboard.
		const turn = path.findIndex((p) => Math.abs(p.massKg - (r.zeroFuel.massKg + 109 * D)) < 1e-9);
		expect(turn).toBeGreaterThan(0);
		for (let i = 1; i <= turn; i++) {
			expect(path[i].armM, `burning the wings, point ${i}`).toBeGreaterThan(path[i - 1].armM);
		}
		for (let i = turn + 1; i < path.length; i++) {
			expect(path[i].armM, `burning the main tank, point ${i}`).toBeLessThan(path[i - 1].armM);
		}
		// The chart's burn line is that path.
		const plot = cgTripPlot(
			{
				takeoff: r.takeoff,
				takeoffOut: false,
				landing: null,
				landingOut: false,
				zeroFuel: r.zeroFuel,
				zeroFuelOut: false,
				fuelMassKg: r.fuelMassKg,
				fuelL: r.fuelL,
			},
			slots,
			{ takeoff: () => '', landing: () => '', zeroFuel: '' },
		);
		expect(plot.travel[0]).toHaveLength(path.length);
		plot.travel[0].forEach((p, i) => {
			expect(p.massKg).toBeCloseTo(path[i].massKg, 9);
			expect(p.armM).toBeCloseTo(path[i].armM, 9);
		});
	});

	it('catches a landing the wing fuel burnt first carries past the aft limit', () => {
		// 80 kg in front, 154 behind, 30 of baggage, tanks full: inside at
		// takeoff, the wing fuel holding the CG forward; with it burnt, aft.
		const zf = zeroFuelPoint(mb, [80, 154, 30]);
		expect(fuelLimitFault(mb, zf, D, 189, null, null)).toBeNull();
		expect(fuelLimitFault(mb, zf, D, 189, 10, null)).toBeNull();
		expect(fuelLimitFault(mb, zf, D, 189, 80, null)).toBe('cg');
		const r = computeMassBalance({ mb, stationMassesKg: [80, 154, 30], fuelL: 189, burnL: 80, densityKgPerL: D });
		expect([r.takeoffInside, r.landingInside]).toEqual([true, false]);
		expect(r.landing.armM).toBeGreaterThan(0.564);
	});
});

describe('fuel tanks: the sheet format', () => {
	it('round-trips, the usable litres written only where they differ', () => {
		const text = stringifyAircraftYaml(a);
		expect(text).toContain('fuelTanks:');
		expect(text).not.toContain('fuelArmM');
		expect(text).toMatch(/label: Wing tanks\n\s+armM: 0\.1\n\s+capacityL: 80\n/);
		expect(parseAircraftYaml(text)).toEqual(a);
	});

	it.each([
		[TANKS.replace(/ {4}- \{ label: Wing tanks.*\n/, ''), /at least two tanks/],
		[TANKS.replace('  fuelTanks:\n', '  fuelArmM: 1.12\n  fuelTanks:\n'), /fuelArmM or fuelTanks, not both/],
		[TANKS.replace('label: Wing tanks', 'label: Main tank'), /names each tank once/],
		[TANKS.replace('capacityL: 80 }', 'capacityL: 80, usableL: 81 }'), /usableL must be <=/],
		[TANKS.replace('capacityL: 80 }', 'capacityL: 70 }'), /hold 180 L \(capacityL\) where fuel\.capacityL is 190/],
		[TANKS.replace('usableL: 109 }', 'usableL: 108 }'), /hold 188 L \(usableL\) where fuel\.usableL is 189/],
		[TANKS.replace('{ label: Main tank, armM: 1.12, ', '{ armM: 1.12, '), /fuelTanks\[0\]\.label/],
		[TANKS.replace('label: Wing tanks, armM: 0.10, ', 'label: Wing tanks, '), /fuelTanks\[1\]\.armM/],
	])('refuses a malformed tank list (%#)', (text, re) => {
		expect(() => parseAircraftYaml(text)).toThrow(re);
	});

	it('a sheet with tanks and no fuel section still parses (a partial sheet)', () => {
		expect(parseAircraftYaml(TANKS.replace(/^fuel:.*\n/m, '')).massBalance?.fuelTanks).toHaveLength(2);
	});
});

describe('fuel tanks: the editor draft', () => {
	it('holds the tanks as typed and builds the same sheet back', () => {
		const d = aircraftToDraft(a);
		expect(d.massBalance?.fuelArmM).toBe('');
		expect(d.massBalance?.fuelTanks).toEqual([
			{ label: 'Main tank', armM: '1.12', capacityL: '110', usableL: '109' },
			{ label: 'Wing tanks', armM: '0.1', capacityL: '80', usableL: '' },
		]);
		const back = draftToAircraft(d);
		expect(back.ok && back.aircraft.massBalance).toEqual(mb);
		// A sheet with one arm keeps the box and no tank.
		const one = aircraftToDraft(parseAircraftYaml(TANKS.replace(/ {2}fuelTanks:\n(?: {4}- .*\n)+/, '  fuelArmM: 1.12\n').replace(/^fuel:.*\n/m, '')));
		expect([one.massBalance?.fuelArmM, one.massBalance?.fuelTanks]).toEqual(['1.12', []]);
	});

	it('names every empty tank box, the usable litres optional, the fuel arm not asked', () => {
		const d = aircraftToDraft(a);
		d.massBalance!.fuelTanks[1] = { label: ' ', armM: '', capacityL: '', usableL: '' };
		expect(draftGaps(d).map((g) => g.path)).toEqual([
			'massAndBalance.fuelTanks[1].capacityL',
			'massAndBalance.fuelTanks[1].label',
			'massAndBalance.fuelTanks[1].armM',
		]);
		d.massBalance!.fuelTanks = [];
		expect(draftGaps(d).map((g) => g.path)).toEqual(['massAndBalance.fuelArmM']);
	});

	it('draws the default load with the full fuel in its tanks', () => {
		const load = draftDefaultLoad(aircraftToDraft(a))!;
		const zfMoment = 620 * 0.3226 + 80 * 0.41;
		expect(load.zeroFuel.momentKgM).toBeCloseTo(zfMoment, 9);
		expect(load.fuelL).toBe(189);
		expect(load.takeoff!.momentKgM).toBeCloseTo(zfMoment + 109 * D * 1.12 + 80 * D * 0.1, 9);
		expect(load.slots.map((s) => s.label)).toEqual(['Main tank', 'Wing tanks']);
	});
});
