/* Mass & balance (src/lib/aircraft/massBalance.ts), pinned to the source
 * workbook's "Masse et centrage" tabs (F-GORQ DR400/120, F-GIEQ PA28-161) and
 * to each weighing report's own loading example ("Ex. de chargement"). */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAircraftYaml } from '$lib/aircraft/schema';
import {
	computeMassBalance,
	stationKeys,
	stationMasses,
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
const gkqc = load('f-gkqc.yaml');
const gldt = load('f-gldt.yaml');
const gsbq = load('f-gsbq.yaml');
const gkrd = load('f-gkrd.yaml');
const glds = load('f-glds.yaml');
const gnna = load('f-gnna.yaml');
const hato = load('f-hato.yaml');

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

	it('pins F-GIEQ: the workbook example (180 L), burn-off all', () => {
		// The workbook loaded 180 L; the manual's usable fuel is 182 L
		// (VB-1375 2.21), what Full tanks now loads.
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

// Each official weighing report closes on a loading example; the engine,
// fed the sheet, must land where the form does.
describe('the weighing reports own loading examples', () => {
	it('F-GIEQ (2023-03-22): 1029.1 kg @ 2.301 m, baggage at its 23 kg maximum', () => {
		const r = computeMassBalance({
			mb: gieq.massBalance!,
			stationMassesKg: [154, 77, 23],
			fuelL: 121.1 / 0.72,
			burnL: 0,
			densityKgPerL: 0.72,
		});
		expect(r.takeoff.massKg).toBeCloseTo(1029.1, 6);
		expect(r.takeoff.momentKgM).toBeCloseTo(2367.5593, 3);
		expect(r.takeoff.armM).toBeCloseTo(2.301, 3);
		expect(r.takeoffInside).toBe(true);
		expect(r.stationsWithinMax).toBe(true);
	});

	it('F-GIKP (2025-02-05): 865 kg @ 0.539 m, on the top edge', () => {
		const r = computeMassBalance({
			mb: gikp.massBalance!,
			stationMassesKg: [160, 80],
			fuelL: 78 / 0.72,
			burnL: 0,
			densityKgPerL: 0.72,
		});
		expect(r.takeoff.massKg).toBeCloseTo(865, 6);
		expect(r.takeoff.momentKgM).toBeCloseTo(466.413, 3);
		expect(r.takeoff.armM).toBeCloseTo(0.539, 3);
		expect(r.takeoffInside).toBe(true);
	});

	it('F-GORQ (2011-11-30): 890 kg @ 0.518 m, a full 110 L tank (79 kg)', () => {
		const r = computeMassBalance({
			mb: gorq.massBalance!,
			stationMassesKg: [154, 77, 10],
			fuelL: 79 / 0.72,
			burnL: 0,
			densityKgPerL: 0.72,
		});
		expect(r.takeoff.massKg).toBeCloseTo(890, 6);
		expect(r.takeoff.momentKgM).toBeCloseTo(460.61, 2);
		expect(r.takeoff.armM).toBeCloseTo(0.5175, 4);
		expect(r.takeoffInside).toBe(true);
	});

	// The Aiglons /120s: each form's printed arm (0.444 / 0.511 / 0.536)
	// against the engine fed the sheet; their empty moments differ from the
	// rounded arm by a few hundredths, hence 3 decimals.
	it.each([
		['F-GKQC (2015-09-10)', gkqc, [154, 60, 9], 78, 0.444],
		['F-GLDT (2014-02-04)', gldt, [154, 70, 12], 72, 0.511],
		['F-GSBQ (2021-04-15)', gsbq, [154, 77, 26], 79, 0.536],
	] as const)('%s: 900 kg, inside the certified envelope', (_name, plane, loads, fuelKg, arm) => {
		const r = computeMassBalance({
			mb: plane.massBalance!,
			stationMassesKg: [...loads],
			fuelL: fuelKg / 0.72,
			burnL: 0,
			densityKgPerL: 0.72,
		});
		expect(r.takeoff.massKg).toBeCloseTo(900, 6);
		expect(r.takeoff.armM).toBeCloseTo(arm, 3);
		expect(r.takeoffInside).toBe(true);
		expect(r.stationsWithinMax).toBe(true);
	});

	// The Sadi Lecointe tails (912iS STC): each form's own example.
	it.each([
		['F-GKRD (2025-05-23), front 160, rear + coffre 69', gkrd, [160, 69], 72, 865, 474.818, 0.549],
		['F-GLDS (2021-09-30), front 203, coffre at its 40 kg', glds, [203, 40], 72, 845, 420.93, 0.498],
		['F-GNNA (2025-10-16), front 175, rear 70', gnna, [175, 70], 78, 865, 470.05, 0.543],
		['F-HATO (2025-09-18), front 171.8, rear 70', hato, [171.8, 70], 78, 865, 480.986, 0.556],
	] as const)('%s', (_name, plane, loads, fuelKg, massKg, momentKgM, arm) => {
		const r = computeMassBalance({
			mb: plane.massBalance!,
			stationMassesKg: [...loads],
			fuelL: fuelKg / 0.72,
			burnL: 0,
			densityKgPerL: 0.72,
		});
		expect(r.takeoff.massKg).toBeCloseTo(massKg, 6);
		expect(r.takeoff.momentKgM).toBeCloseTo(momentKgM, 2);
		expect(r.takeoff.armM).toBeCloseTo(arm, 3);
		expect(r.takeoffInside).toBe(true);
		expect(r.stationsWithinMax).toBe(true);
	});

	it('F-GJQK (2026-06-10): 865 kg @ 0.527 m (the form prints 0.530)', () => {
		// The form enters 68 kg of passenger but carries 83.3 kg.m, the moment
		// of 70 kg at 1.19 m, so its total reads 458.43 / 0.530. The 68 kg its
		// mass column sums to 865 gives 456.04 / 0.527: inside either way.
		const r = computeMassBalance({
			mb: gjqk.massBalance!,
			stationMassesKg: [178.5, 68],
			fuelL: 78 / 0.72,
			burnL: 0,
			densityKgPerL: 0.72,
		});
		expect(r.takeoff.massKg).toBeCloseTo(865, 6);
		expect(r.takeoff.momentKgM).toBeCloseTo(456.0435, 3);
		expect(r.takeoff.armM).toBeCloseTo(0.5272, 4);
		expect(r.takeoffInside).toBe(true);
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

describe('station maximum', () => {
	const run = (baggageKg: number) =>
		computeMassBalance({
			mb: gieq.massBalance!,
			stationMassesKg: [160, 10, baggageKg],
			fuelL: 100,
			burnL: 50,
			densityKgPerL: 0.72,
		});

	it('allows the published maximum itself (VB-1375 2.11 d: 23 kg of baggage)', () => {
		const r = run(23);
		const baggage = r.rows.find((row) => row.kind === 'station' && row.label === 'Baggage')!;
		expect(baggage.maxMassKg).toBe(23);
		expect(baggage.overMax).toBe(false);
		expect(r.stationsWithinMax).toBe(true);
	});

	it('flags a load above it, whatever the envelope says', () => {
		const r = run(24);
		expect(r.rows.filter((row) => row.overMax).map((row) => row.label)).toEqual(['Baggage']);
		expect(r.stationsWithinMax).toBe(false);
		// One extra kilogram aft does not leave the envelope: the limit is its
		// own verdict, a structural one.
		expect(r.takeoffInside).toBe(true);
	});

	it('never flags a station without a published limit, nor the synthetic rows', () => {
		const r = run(0);
		for (const row of r.rows) {
			expect(row.overMax).toBe(false);
		}
		expect(r.rows.filter((row) => row.maxMassKg != null)).toHaveLength(1);
	});
});

describe('fuelLitresForMode', () => {
	it('resolves the four modes', () => {
		const fuel = gieq.fuel!;
		expect(fuelLitresForMode(fuel, { kind: 'full' }, null)).toBe(182);
		expect(fuelLitresForMode(fuel, { kind: 'preset', name: 'tabs' }, null)).toBe(128);
		expect(fuelLitresForMode(fuel, { kind: 'preset', name: 'nope' }, null)).toBeNull();
		expect(fuelLitresForMode(fuel, { kind: 'minimum' }, 92.4)).toBeCloseTo(92.4, 6);
		expect(fuelLitresForMode(fuel, { kind: 'minimum' }, null)).toBeNull();
		expect(fuelLitresForMode(fuel, { kind: 'custom', litres: 50 }, null)).toBe(50);
		expect(fuelLitresForMode(fuel, { kind: 'custom', litres: 500 }, null)).toBe(182);
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
		expect(pointInEnvelope(env, 0.205, 750)).toBe(true); // vertex
		expect(pointInEnvelope(env, 0.205, 700)).toBe(true); // forward limit line
		expect(pointInEnvelope(env, 0.5, 900)).toBe(true); // max-mass line
	});
	it('classifies inside / outside', () => {
		expect(pointInEnvelope(env, 0.4, 800)).toBe(true);
		expect(pointInEnvelope(env, 0.6, 700)).toBe(false); // aft of the limit
		expect(pointInEnvelope(env, 0.3, 480)).toBe(false); // below the floor
		expect(pointInEnvelope(env, 0.25, 880)).toBe(false); // forward of the slope
		// The certified forward limit is 0.205 m (MdV DR400/120 II e), not the
		// 0.200 m / 760 kg the sheet carried, and a light zero-fuel state is
		// not out of envelope (the 660 kg floor was a plot artefact).
		expect(pointInEnvelope(env, 0.2, 700)).toBe(false);
		expect(pointInEnvelope(env, 0.35, 640)).toBe(true);
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

// Two stations may carry one name (a user plane with two "Front seats" rows:
// the schema accepts it, and rejecting it now would drop a stored plane, since
// a sheet that no longer parses is discarded at boot). The loads were keyed by
// the name, so both stations read and wrote one load, a wrong CG, and the
// page's rows collided on their key. Each station's load is now keyed by the
// name with an occurrence suffix on a repeat, a unique name keying as before.
describe('stations sharing a name', () => {
	const mb = {
		...gorq.massBalance!,
		stations: [
			{ label: 'Front seats', armM: 0.41, defaultMassKg: 77 },
			{ label: 'Front seats', armM: 1.19, defaultMassKg: 0 },
			{ label: 'Baggage', armM: 1.9, defaultMassKg: 0 },
		],
	};

	it('keys each station apart, a unique name keying as itself', () => {
		expect(stationKeys(mb)).toEqual(['Front seats', 'Front seats#2', 'Baggage']);
		expect(stationKeys(gorq.massBalance!)).toEqual(gorq.massBalance!.stations.map((s) => s.label));
	});

	it('gives each station its own load, a missing one its default', () => {
		expect(stationMasses(mb, { 'Front seats': 80, 'Front seats#2': 70 })).toEqual([80, 70, 0]);
		expect(stationMasses(mb, { 'Front seats#2': 70 })).toEqual([77, 70, 0]);
	});

	it('weighs each load at its own arm', () => {
		const r = computeMassBalance({
			mb,
			stationMassesKg: stationMasses(mb, { 'Front seats': 80, 'Front seats#2': 70 }),
			fuelL: 0,
			burnL: 0,
			densityKgPerL: 0.72,
		});
		const seats = r.rows.filter((row) => row.kind === 'station' && row.label === 'Front seats');
		expect(seats.map((row) => [row.key, row.massKg, row.momentKgM])).toEqual([
			['Front seats', 80, 80 * 0.41],
			['Front seats#2', 70, 70 * 1.19],
		]);
		expect(r.rows.filter((row) => row.kind !== 'station').map((row) => row.key)).toEqual(['', '']);
	});
});
