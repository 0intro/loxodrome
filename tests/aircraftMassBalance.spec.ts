/* Mass & balance (src/lib/aircraft/massBalance.ts), pinned to the source
 * workbook's "Masse et centrage" tabs (F-GORQ DR400/120, F-GIEQ PA28-161) plus
 * the F-GJQK 912iSc weighing. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAircraftYaml } from '$lib/aircraft/schema';
import {
	computeMassBalance,
	pointInEnvelope,
	fuelLitresForMode,
	burnLitresForMode,
	cgTravel,
} from '$lib/aircraft/massBalance';

function load(file: string) {
	return parseAircraftYaml(
		readFileSync(new URL(`../public/data/aircraft/${file}`, import.meta.url), 'utf-8'),
	);
}

const gjqk = load('f-gjqk.yaml');
const gorq = load('f-gorq.yaml');
const gieq = load('f-gieq.yaml');
const gikp = load('f-gikp.yaml');
const girv = load('f-girv.yaml');

describe('computeMassBalance', () => {
	it('pins F-GORQ: full tanks, trip burn-off (181 min at 25 L/h)', () => {
		const burnL = burnLitresForMode('trip', 100, 181, 25)!;
		expect(burnL).toBeCloseTo(75.4167, 3);
		const r = computeMassBalance({
			mb: gorq.massBalance!,
			stationMassesKg: [80, 10, 0],
			fuelL: 100,
			burnL,
			densityKgPerL: 0.72,
		});
		expect(r.fuelMassKg).toBeCloseTo(72, 6);
		expect(r.burnMassKg).toBeCloseTo(54.3, 6); // the historic 24 L/h sheet read 52
		// Empty 570 @ 0.348: takeoff 732 kg @ 0.442 (moment 323.7), landing 677.7 @ 0.388.
		expect(r.takeoff.massKg).toBeCloseTo(732, 6);
		expect(r.takeoff.momentKgM).toBeCloseTo(323.7, 2);
		expect(r.takeoff.armM).toBeCloseTo(0.4422, 4);
		expect(r.landing.massKg).toBeCloseTo(677.7, 2);
		expect(r.landing.momentKgM).toBeCloseTo(262.88, 2);
		expect(r.landing.armM).toBeCloseTo(0.3879, 4);
		expect(r.zeroFuel.massKg).toBeCloseTo(660, 6);
		expect(r.takeoffInside).toBe(true);
		expect(r.landingInside).toBe(true);
		expect(r.zeroFuelInside).toBe(true);
	});

	it('F-GJQK 912iSc: weighed empty point sits in the STC envelope', () => {
		const mb = gjqk.massBalance!;
		expect(mb.emptyMassKg).toBe(540.5);
		const env = mb.envelope;
		expect(pointInEnvelope(env, 0.397, 540.5)).toBe(true); // the 2026 weighed empty point
		expect(pointInEnvelope(env, 0.513, 865)).toBe(true); // forward-top vertex at max mass
		expect(pointInEnvelope(env, 0.3, 865)).toBe(false); // forward of the slope at max mass
		expect(pointInEnvelope(env, 0.6, 700)).toBe(false); // aft of 0.564
		expect(pointInEnvelope(env, 0.205, 600)).toBe(true); // forward limit line below 750 kg
	});

	it('F-GIKP stays in the envelope at zero fuel (open-ended floor)', () => {
		// Empty 547 + 80 + 10 = 637 kg at zero fuel: below the workbook chart's
		// 660 kg plot floor, but inside the STC supplement's envelope, whose
		// limit lines arrow downward with no minimum mass. Two stations only:
		// the Sport has no luggage compartment.
		const r = computeMassBalance({
			mb: gikp.massBalance!,
			stationMassesKg: [80, 10],
			fuelL: 100,
			burnL: 100,
			densityKgPerL: 0.72,
		});
		expect(r.zeroFuel.massKg).toBeCloseTo(637, 6);
		expect(r.zeroFuelInside).toBe(true);
		expect(r.takeoffInside).toBe(true);
		expect(r.landingInside).toBe(true);
	});

	it('pins F-GIEQ: full usable fuel, burn-off all', () => {
		const r = computeMassBalance({
			mb: gieq.massBalance!,
			stationMassesKg: [160, 10, 0],
			fuelL: 180,
			burnL: 180,
			densityKgPerL: 0.72,
		});
		// The sheet shows 954 @ 2.22 (it stores density 0.721; at 0.72 the
		// takeoff mass is 953.6, the same after display rounding).
		expect(r.takeoff.massKg).toBeCloseTo(953.6, 1);
		expect(r.takeoff.armM).toBeCloseTo(2.219, 3);
		expect(r.landing.massKg).toBeCloseTo(824, 1);
		expect(r.landing.armM).toBeCloseTo(2.188, 3);
		expect(r.takeoffInside).toBe(true);
		expect(r.landingInside).toBe(true);
	});
});

describe('computeMassBalance (F-GIRV)', () => {
	it('pins the manual fig 6-9 worked example (Revision 8)', () => {
		// The example flies a 721.2 kg @ 2.223 m base aircraft (not F-GIRV's
		// weighing): override the empty point, keep the sheet's arms and
		// envelope. Ramp 2558 lb / 1160.2 kg @ 91.5 in / 2.324 m.
		const r = computeMassBalance({
			mb: { ...girv.massBalance!, emptyMassKg: 721.2, emptyArmM: 2.223 },
			stationMassesKg: [154.2, 154.2, 0],
			fuelL: 130.6 / 0.72,
			burnL: 0,
			densityKgPerL: 0.72,
		});
		expect(r.takeoff.massKg).toBeCloseTo(1160.2, 6);
		expect(r.takeoff.momentKgM).toBeCloseTo(2696.3, 1); // manual sums its rounded rows to 2696.2
		expect(r.takeoff.armM).toBeCloseTo(2.324, 3);
		// The ramp mass sits 3.2 kg above the 1157 kg envelope top; the
		// manual's own example only becomes legal after the taxi allowance.
		expect(r.takeoffInside).toBe(false);
	});

	it('pins the rapport de pesee loading example (weighing of 2015-05-20)', () => {
		// The official form's "Ex. de chargement": 748.5 @ 2.236 + 154 + 154
		// + 20 kg + 80.5 kg fuel -> 1157 kg, moment 2717.36, arm 2.349:
		// exactly MTOW, on the boundary-inclusive envelope top.
		const r = computeMassBalance({
			mb: girv.massBalance!,
			stationMassesKg: [154, 154, 20],
			fuelL: 80.5 / 0.72,
			burnL: 0,
			densityKgPerL: 0.72,
		});
		expect(r.takeoff.massKg).toBeCloseTo(1157, 6);
		expect(r.takeoff.momentKgM).toBeCloseTo(2717.36, 2);
		expect(r.takeoff.armM).toBeCloseTo(2.3486, 4);
		expect(r.takeoffInside).toBe(true);
	});

	it('pins the club W&B sheet example: 150 L, burn-off all', () => {
		const r = computeMassBalance({
			mb: girv.massBalance!,
			stationMassesKg: [160, 120, 20],
			fuelL: 150,
			burnL: 150,
			densityKgPerL: 0.72,
		});
		expect(r.takeoff.massKg).toBeCloseTo(1156.5, 6);
		expect(r.takeoff.armM).toBeCloseTo(2.329434, 5);
		expect(r.zeroFuel.massKg).toBeCloseTo(1048.5, 6);
		expect(r.zeroFuel.armM).toBeCloseTo(2.320826, 5);
		expect(r.takeoffInside).toBe(true);
		expect(r.landingInside).toBe(true);
		expect(r.zeroFuelInside).toBe(true);
	});

	it('envelope: empty point inside, forward of the slope outside', () => {
		const env = girv.massBalance!.envelope;
		expect(pointInEnvelope(env, 2.236, 748.5)).toBe(true); // the weighed empty point
		expect(pointInEnvelope(env, 2.25, 1157)).toBe(true); // top-forward vertex
		expect(pointInEnvelope(env, 2.083, 930)).toBe(true); // the kink
		expect(pointInEnvelope(env, 2.083, 1000)).toBe(false); // forward of the slope
		expect(pointInEnvelope(env, 2.4, 800)).toBe(false); // aft of 93 in
	});
});

describe('fuelLitresForMode', () => {
	it('resolves the four modes', () => {
		const fuel = gieq.fuel!;
		expect(fuelLitresForMode(fuel, { kind: 'full' }, null)).toBe(180);
		expect(fuelLitresForMode(fuel, { kind: 'preset', name: 'tabs' }, null)).toBe(128);
		expect(fuelLitresForMode(fuel, { kind: 'preset', name: 'nope' }, null)).toBeNull();
		expect(fuelLitresForMode(fuel, { kind: 'minimum' }, 92.4)).toBeCloseTo(92.4, 6);
		expect(fuelLitresForMode(fuel, { kind: 'minimum' }, null)).toBeNull();
		expect(fuelLitresForMode(fuel, { kind: 'custom', litres: 50 }, null)).toBe(50);
		expect(fuelLitresForMode(fuel, { kind: 'custom', litres: 500 }, null)).toBe(180);
	});
});

describe('burnLitresForMode', () => {
	it('clamps the trip burn to the fuel on board; unknown trip -> null', () => {
		expect(burnLitresForMode('all', 128, null, null)).toBe(128);
		expect(burnLitresForMode('trip', 100, 300, 24)).toBe(100); // 120 L clamped
		expect(burnLitresForMode('trip', 100, null, 24)).toBeNull();
	});
});

describe('pointInEnvelope', () => {
	const env = gorq.massBalance!.envelope;
	it('vertices and edges count as inside', () => {
		expect(pointInEnvelope(env, 0.2, 660)).toBe(true); // vertex
		expect(pointInEnvelope(env, 0.2, 700)).toBe(true); // forward limit line
		expect(pointInEnvelope(env, 0.5, 900)).toBe(true); // max-mass line
	});
	it('classifies inside / outside', () => {
		expect(pointInEnvelope(env, 0.4, 800)).toBe(true);
		expect(pointInEnvelope(env, 0.6, 700)).toBe(false); // aft of the limit
		expect(pointInEnvelope(env, 0.3, 640)).toBe(false); // below the floor
		expect(pointInEnvelope(env, 0.25, 880)).toBe(false); // forward of the slope
	});
});

describe('cgTravel', () => {
	it('runs from the takeoff point to the zero-fuel point, arm monotonic', () => {
		const r = computeMassBalance({
			mb: gorq.massBalance!,
			stationMassesKg: [80, 10, 0],
			fuelL: 100,
			burnL: 100,
			densityKgPerL: 0.72,
		});
		const path = cgTravel(r.takeoff, gorq.massBalance!.fuelArmM, r.fuelMassKg);
		expect(path[0].armM).toBeCloseTo(r.takeoff.armM, 9);
		expect(path[0].massKg).toBeCloseTo(r.takeoff.massKg, 9);
		expect(path[path.length - 1].armM).toBeCloseTo(r.zeroFuel.armM, 9);
		expect(path[path.length - 1].massKg).toBeCloseTo(r.zeroFuel.massKg, 9);
		for (let i = 1; i < path.length; i++) {
			expect(path[i].armM).toBeLessThan(path[i - 1].armM);
		}
	});
});
