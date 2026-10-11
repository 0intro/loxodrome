/* Fuel at each takeoff (src/lib/aircraft/tripLoads.ts): the plan as the pilot
 * loads it, trip by trip. Pinned on the workbook's Brienne navigation (the
 * rows tests/aircraftFuel.spec.ts pins: LFPL -> LFQH -> LFGP -> LFPL, 25 L/h)
 * and the committed sheets, with the figures the 2026-10-02 analysis measured
 * through the app's own functions, and checked against computeRefuelPlan
 * over every subset of stops for 1 to 6 trips: the strategies table and the
 * per-trip verdicts must never disagree. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAircraftYaml, type AircraftMassBalance } from '$lib/aircraft/schema';
import {
	computeFuelPlan,
	computeRefuelPlan,
	blockMinimumMin,
	ceilLitres,
	type FuelPlanParams,
	type FuelTripInput,
	type FuelTripRow,
} from '$lib/aircraft/fuel';
import { maxFuelWithinLimits } from '$lib/aircraft/massBalance';
import {
	checkStrategies,
	computeTripLoads,
	dryBefore,
	fuelTargetOf,
	strategyTargets,
	takeoffWindow,
	tripLimitFault,
	type FuelTarget,
	type TripLoadsInput,
	type TripLoadsResult,
	type TripStopInput,
} from '$lib/aircraft/tripLoads';

function load(file: string) {
	return parseAircraftYaml(
		readFileSync(new URL(`../public/data/aircraft/${file}`, import.meta.url), 'utf-8'),
	);
}

const gorq = load('f-gorq.yaml');
const gieq = load('f-gieq.yaml');
const girv = load('f-girv.yaml');
const hpcp = load('f-hpcp.yaml');

const PARAMS: FuelPlanParams = { consumptionLph: 25, finalReserveMin: 30, pilotMarginMin: 0 };

function brienneTrips(): FuelTripInput[] {
	return [
		{
			label: 'LFPL to LFQH', toLabel: 'LFQH', taxiMin: 5, tripMin: 69, procedureMin: 10,
			windAllowanceMin: 0,
			alternate: { label: 'LFQB', timeMin: 24, procedureMin: 10, windAllowanceMin: 2 },
		},
		{
			label: 'LFQH to LFGP', toLabel: 'LFGP', taxiMin: 0, tripMin: 20, procedureMin: 10,
			windAllowanceMin: 3,
			alternate: { label: 'LFLA', timeMin: 8, procedureMin: 10, windAllowanceMin: 1 },
		},
		{
			label: 'LFGP to LFPL', toLabel: 'LFPL', taxiMin: 5, tripMin: 45, procedureMin: 10,
			windAllowanceMin: 4,
			alternate: { label: 'LFPK', timeMin: 10, procedureMin: 10, windAllowanceMin: 0 },
		},
	];
}

const rows = computeFuelPlan(brienneTrips(), PARAMS).trips;
const TWO_ABOARD = { 'Front seats': 160, 'Rear seats': 0, Baggage: 10 };
const full: FuelTarget = { kind: 'full' };
const tick = (refuel: FuelTarget | null, loads: Record<string, number> = {}): TripStopInput => ({
	refuel,
	loads,
});

/** F-GORQ on Brienne, two aboard, full tanks, nothing ticked. */
function gorqInput(over: Partial<TripLoadsInput> = {}): TripLoadsInput {
	return {
		rows,
		consumptionLph: 25,
		fuel: gorq.fuel!,
		mb: gorq.massBalance!,
		densityKgPerL: 0.72,
		departure: { target: full, loads: TWO_ABOARD },
		stops: [],
		...over,
	};
}

describe('computeTripLoads: the Brienne chain (F-GORQ, 160 kg front, 10 kg baggage)', () => {
	it('Minimum at LFPL, full tanks at LFQH: the measured chain', () => {
		const r = computeTripLoads(
			gorqInput({ departure: { target: { kind: 'minimum' }, loads: TWO_ABOARD }, stops: [null, tick(full)] }),
		);
		const [a, b, c] = r.trips;
		// LFPL -> LFQH: the block is this trip alone, 150 min = 62.5 L, loaded 63.
		expect(a.blockMinimumL).toBeCloseTo(62.5, 9);
		expect(a.startL).toBe(63);
		expect(a.burnL).toBeCloseTo(35, 9);
		expect(a.landingL).toBeCloseTo(28, 9);
		expect(a.reserveL).toBeCloseTo(27.5, 9);
		expect(a.finalReserveL).toBeCloseTo(12.5, 9);
		expect(a.sufficient).toBe(true);
		expect(a.enduranceMin).toBeCloseTo(151.2, 9);
		// LFQH -> LFGP: refuelled to full, 72 L uplifted.
		expect(b.fuelSet).toBe(true);
		expect(b.carriedL).toBeCloseTo(28, 9);
		expect(b.startL).toBe(100);
		expect(b.upliftL).toBeCloseTo(72, 9);
		expect(b.landingL).toBeCloseTo(86.25, 9);
		expect(b.reserveL).toBeCloseTo(20.4167, 3);
		// LFGP -> LFPL: carried over.
		expect(c.fuelSet).toBe(false);
		expect(c.startL).toBeCloseTo(86.25, 9);
		expect(c.landingL).toBeCloseTo(59.5833, 3);
		expect(c.reserveL).toBeCloseTo(20.8333, 3);
		expect(r.fuelSufficient).toBe(true);
		// The masses the analysis measured: the stop's takeoff 812.0 kg, the
		// departure's 785.4 (what the performance page used for both).
		const mass = r.trips.map((t) => [t.mb!.result.takeoff.massKg, t.mb!.result.takeoff.armM]);
		expect(mass[0][0]).toBeCloseTo(785.36, 2);
		expect(mass[0][1]).toBeCloseTo(0.425, 3);
		expect(mass[1][0]).toBeCloseTo(812.0, 2);
		expect(mass[1][1]).toBeCloseTo(0.448, 3);
		expect(mass[2][0]).toBeCloseTo(802.1, 1);
		expect(r.trips[0].mb!.result.landing.massKg).toBeCloseTo(760.16, 2);
		expect(r.trips[1].mb!.result.landing.massKg).toBeCloseTo(802.1, 1);
		expect(r.trips[2].mb!.result.landing.massKg).toBeCloseTo(782.9, 1);
		expect(r.heaviestTakeoff?.chainIndex).toBe(1);
		expect(r.heaviestTakeoff?.kg).toBeCloseTo(812, 2);
		expect(r.withinLimits).toBe(true);
	});

	it('custom 45 L, nothing ticked (the reported mistake): trip 1 short, the fix verified', () => {
		const r = computeTripLoads(gorqInput({ departure: { target: { kind: 'custom', litres: 45 }, loads: TWO_ABOARD } }));
		expect(r.trips[0].startL).toBe(45);
		expect(r.trips[0].landingL).toBeCloseTo(10, 9);
		expect(r.trips[0].sufficient).toBe(false);
		expect(r.fuelSufficient).toBe(false);
		// One block from LFPL: the first short trip is the first, and no stop
		// lies before it, so the one cure is the departure's own fuel.
		expect(r.shortTrips).toEqual([
			{
				chainIndex: 0,
				blockStart: 0,
				fixes: [{ kind: 'raiseStart', chainIndex: 0, litres: 97, coversBlock: true }],
			},
		]);
	});

	it('63 L at LFPL, LFQH not ticked: trip 2 short, refuel at LFQH or 97 L at LFPL', () => {
		const r = computeTripLoads(gorqInput({ departure: { target: { kind: 'custom', litres: 63 }, loads: TWO_ABOARD } }));
		expect(r.trips[0].sufficient).toBe(true);
		expect(r.trips[1].startL).toBeCloseTo(28, 9);
		expect(r.trips[1].landingL).toBeCloseTo(14.25, 9);
		expect(r.trips[1].sufficient).toBe(false);
		expect(r.shortTrips).toEqual([
			{
				chainIndex: 1,
				blockStart: 0,
				fixes: [
					{ kind: 'refuelAt', chainIndex: 1, target: 'full', coversBlock: true },
					{ kind: 'raiseStart', chainIndex: 0, litres: 97, coversBlock: true },
				],
			},
		]);
	});

	it('a stop known to sell no fuel is never offered as a fix', () => {
		const r = computeTripLoads(
			gorqInput({
				departure: { target: { kind: 'custom', litres: 63 }, loads: TWO_ABOARD },
				refused: [false, true, false],
			}),
		);
		expect(r.shortTrips[0].fixes).toEqual([{ kind: 'raiseStart', chainIndex: 0, litres: 97, coversBlock: true }]);
	});

	it('a block beyond the tank: the fix that cures the short trip, flagged as not the whole block', () => {
		// A 70 L tank: the three trips need 96.25 L at LFPL, trip 1 alone 62.5.
		const r = computeTripLoads(
			gorqInput({ fuel: { usableL: 70, presets: [] }, departure: { target: { kind: 'custom', litres: 45 }, loads: TWO_ABOARD } }),
		);
		expect(r.shortTrips).toEqual([
			{
				chainIndex: 0,
				blockStart: 0,
				fixes: [{ kind: 'raiseStart', chainIndex: 0, litres: 63, coversBlock: false }],
			},
		]);
		// Taken: trip 2 is now the first short, and a refuel at LFQH cures
		// everything after it; 69 L at LFPL cures through LFGP only.
		const next = computeTripLoads(
			gorqInput({ fuel: { usableL: 70, presets: [] }, departure: { target: { kind: 'custom', litres: 63 }, loads: TWO_ABOARD } }),
		);
		expect(next.shortTrips).toEqual([
			{
				chainIndex: 1,
				blockStart: 0,
				fixes: [
					{ kind: 'refuelAt', chainIndex: 1, target: 'full', coversBlock: true },
					{ kind: 'raiseStart', chainIndex: 0, litres: 70, coversBlock: false },
				],
			},
		]);
	});

	it('four aboard: where Full tanks at the stop break the maximum, the Minimum cures', () => {
		const rows35 = computeFuelPlan(brienneTrips(), { ...PARAMS, consumptionLph: 35 }).trips;
		const loads = { 'Front seats': 170, 'Rear seats': 150, Baggage: 20 };
		const input: TripLoadsInput = {
			rows: rows35,
			consumptionLph: 35,
			fuel: girv.fuel!,
			mb: girv.massBalance!,
			densityKgPerL: 0.72,
			departure: { target: { kind: 'max' }, loads },
			stops: [],
		};
		const r = computeTripLoads(input);
		expect(r.shortTrips).toEqual([
			{ chainIndex: 1, blockStart: 0, fixes: [{ kind: 'refuelAt', chainIndex: 1, target: 'minimum', coversBlock: true }] },
		]);
		// Full tanks at LFQH would put the takeoff there over 1157 kg.
		const full = computeTripLoads({ ...input, stops: [null, tick({ kind: 'full' })] });
		expect(full.trips[1].mb!.withinLimits).toBe(false);
		const min = computeTripLoads({ ...input, stops: [null, tick({ kind: 'minimum' })] });
		expect(min.fuelSufficient).toBe(true);
		expect(min.withinLimits).toBe(true);
	});

	it('four aboard on short hops: where Full and the Minimum both break the maximum, the Maximum within limits cures the trip, a stop at a time', () => {
		// F-GIEQ, 160 / 150 / 23 kg: 94 L at most within limits. Four hops of
		// 60 min each at 35 L/h (35 L), a 55 min reserve (32.1 L): trip 2 lands
		// 24 L from 94 L. Full tanks (182 L) and the Minimum for the rest of the
		// plan (137 L) both put the takeoff over 1055 kg, so neither cures it;
		// the most fuel within limits does, and leaves trip 3 to the next stop.
		const hops: FuelTripInput[] = [1, 2, 3, 4].map((i) => ({
			label: `hop ${i}`, toLabel: `S${i}`, taxiMin: 5, tripMin: 45, procedureMin: 10, windAllowanceMin: 0,
			alternate: { label: `A${i}`, timeMin: 15, procedureMin: 10, windAllowanceMin: 0 },
		}));
		const hopRows = computeFuelPlan(hops, { ...PARAMS, consumptionLph: 35 }).trips;
		const loads = { 'Front seats': 160, 'Rear seats': 150, Baggage: 23 };
		const input: TripLoadsInput = {
			rows: hopRows,
			consumptionLph: 35,
			fuel: gieq.fuel!,
			mb: gieq.massBalance!,
			densityKgPerL: 0.72,
			departure: { target: { kind: 'max' }, loads },
			stops: [],
		};
		const r = computeTripLoads(input);
		expect(r.trips[0].startL).toBe(94);
		expect(r.shortTrips).toEqual([
			{ chainIndex: 1, blockStart: 0, fixes: [{ kind: 'refuelAt', chainIndex: 1, target: 'max', coversBlock: false }] },
		]);
		// Applied, trip 2 is cured within limits and trip 3 asks the same of
		// the next stop; applied there and again, the plan flies.
		const once = computeTripLoads({ ...input, stops: [null, tick({ kind: 'max' })] });
		expect(once.trips[1]).toMatchObject({ startL: 94, sufficient: true });
		expect(once.trips[1].mb!.withinLimits).toBe(true);
		expect(once.shortTrips).toEqual([
			{ chainIndex: 2, blockStart: 1, fixes: [{ kind: 'refuelAt', chainIndex: 2, target: 'max', coversBlock: false }] },
		]);
		const every = computeTripLoads({ ...input, stops: [null, tick({ kind: 'max' }), tick({ kind: 'max' }), tick({ kind: 'max' })] });
		expect(every.fuelSufficient).toBe(true);
		expect(every.withinLimits).toBe(true);
		// Full and the Minimum at the stop, as the search tried them: out of limits.
		for (const target of [full, { kind: 'minimum' } as const]) {
			expect(computeTripLoads({ ...input, stops: [null, tick(target)] }).trips[1].mb!.withinLimits).toBe(false);
		}
	});

	it('the fuel running out: exhausted on the first dry trip, the rest NO, reset by a refuel', () => {
		const r = computeTripLoads(gorqInput({ departure: { target: { kind: 'custom', litres: 20 }, loads: TWO_ABOARD } }));
		expect(r.trips.map((t) => t.exhaustedOn)).toEqual([0, 0, 0]);
		// Trip 1 runs dry in the air; trips 2 and 3 take off with none.
		expect(r.trips.map(dryBefore)).toEqual([null, 0, 0]);
		expect(r.trips[1].startL).toBe(0);
		expect(r.trips.every((t) => t.sufficient === false)).toBe(true);
		const s = computeTripLoads(
			gorqInput({ departure: { target: { kind: 'custom', litres: 20 }, loads: TWO_ABOARD }, stops: [null, tick(full)] }),
		);
		expect(s.trips.map((t) => t.exhaustedOn)).toEqual([0, null, null]);
		expect(s.trips.map(dryBefore)).toEqual([null, null, null]);
		expect(s.trips[1].carriedL).toBe(0);
		expect(s.trips[1].upliftL).toBe(100);
		expect(s.trips[1].sufficient).toBe(true);
	});
});

describe('computeTripLoads: targets', () => {
	it('an empty Custom box is the Minimum', () => {
		const a = computeTripLoads(gorqInput({ departure: { target: { kind: 'custom', litres: null }, loads: TWO_ABOARD } }));
		const b = computeTripLoads(gorqInput({ departure: { target: { kind: 'minimum' }, loads: TWO_ABOARD } }));
		expect(a.trips[0].startL).toBe(97);
		expect(b.trips[0].startL).toBe(97);
	});

	it('above the usable fuel: the usable fuel, flagged', () => {
		const r = computeTripLoads(gorqInput({ departure: { target: { kind: 'custom', litres: 120 }, loads: TWO_ABOARD } }));
		expect(r.trips[0].requestedL).toBe(120);
		expect(r.trips[0].startL).toBe(100);
		expect(r.trips[0].notes).toEqual(['aboveUsable']);
	});

	it('no defuelling: a target below what is on board keeps it', () => {
		const r = computeTripLoads(gorqInput({ stops: [null, tick({ kind: 'custom', litres: 40 })] }));
		expect(r.trips[1].carriedL).toBeCloseTo(65, 9);
		expect(r.trips[1].startL).toBeCloseTo(65, 9);
		expect(r.trips[1].upliftL).toBe(0);
		expect(r.trips[1].notes).toEqual(['noDefuel']);
		const m = computeTripLoads(gorqInput({ stops: [null, tick({ kind: 'minimum' })] }));
		expect(m.trips[1].requestedL).toBe(62); // 61.25 rounded up
		expect(m.trips[1].startL).toBeCloseTo(65, 9);
		expect(m.trips[1].notes).toEqual(['noUpliftNeeded']);
	});

	it('an unresolvable target is unknown, never 0 L', () => {
		// F-GORQ states no tabs preset.
		const r = computeTripLoads(gorqInput({ departure: { target: { kind: 'tabs' }, loads: TWO_ABOARD } }));
		expect(r.trips[0].startL).toBeNull();
		expect(r.trips[0].notes).toEqual(['unavailable']);
		expect(r.trips[0].mb).toBeNull();
		expect(r.trips[1].startL).toBeNull();
		expect(r.fuelSufficient).toBeNull();
	});

	it('fuelTargetOf maps the stored modes', () => {
		expect(fuelTargetOf('custom', 60)).toEqual({ kind: 'custom', litres: 60 });
		expect(fuelTargetOf('max', null)).toEqual({ kind: 'max' });
	});
});

describe('a contingency burns with its trip (the club form\'s "Perfo, évitements, MTO, ATC, attente")', () => {
	it('the trips after it carry less, its block needs it, the touchdown keeps it aboard', () => {
		const lpm = 25 / 60;
		const withC = computeFuelPlan(
			brienneTrips().map((t, i) => (i === 1 ? { ...t, contingencyMin: 12 } : t)),
			PARAMS,
		).trips;
		const base = computeTripLoads(gorqInput());
		const c = computeTripLoads(gorqInput({ rows: withC }));
		// LFQH -> LFGP burns 12 min more; LFGP -> LFPL takes off with 5 L less.
		expect(c.trips[1].burnL! - base.trips[1].burnL!).toBeCloseTo(12 * lpm, 9);
		expect(c.trips[2].startL! - base.trips[2].startL!).toBeCloseTo(-12 * lpm, 9);
		// The departure's block (nothing refuelled) needs it: its last landing
		// binds, the whole chain behind it.
		expect(c.trips[0].blockMinimumL! - base.trips[0].blockMinimumL!).toBeCloseTo(12 * lpm, 9);
		// The landing point assumes it burnt; the touchdown, what a maximum
		// landing mass limits, does not (it may never be used).
		const ldg = (r: TripLoadsResult) => r.trips[1].mb!.result.landing.massKg;
		expect(ldg(c)).toBeCloseTo(ldg(base) - 12 * lpm * 0.72, 9);
		expect(c.trips[1].mb!.touchdownKg).toBeCloseTo(base.trips[1].mb!.touchdownKg!, 9);
	});

	it('a refuel after it starts the next block afresh', () => {
		const withC = computeFuelPlan(
			brienneTrips().map((t, i) => (i === 1 ? { ...t, contingencyMin: 12 } : t)),
			PARAMS,
		).trips;
		const stops = [null, null, tick(full)];
		const base = computeTripLoads(gorqInput({ stops }));
		const c = computeTripLoads(gorqInput({ rows: withC, stops }));
		expect(c.trips[2].startL).toBe(base.trips[2].startL);
		expect(c.trips[2].upliftL! - base.trips[2].upliftL!).toBeCloseTo(12 * (25 / 60), 9);
	});
});

describe('maxFuelWithinLimits / Maximum within limits', () => {
	it('the committed sheets, four adults (whole litres, takeoff)', () => {
		const at = (sheet: typeof gorq, payload: number[]) =>
			maxFuelWithinLimits(sheet.massBalance!, sheet.fuel!.usableL, payload, 0.72, null, null);
		expect(at(gieq, [160, 150, 23])).toMatchObject({ litres: 94, limitedBy: 'massMax' });
		expect(at(girv, [160, 150, 20])).toMatchObject({ litres: 109, limitedBy: 'massMax' });
		expect(at(hpcp, [180, 160, 30])).toMatchObject({ litres: 140, limitedBy: 'massMax' });
		// A DR400/120 with four aboard is at its maximum without fuel.
		expect(at(gorq, [160, 150, 20])).toMatchObject({ litres: 0, limitedBy: 'massMax' });
		expect(at(gorq, [160, 0, 10])).toMatchObject({ litres: 100, limitedBy: 'usable' });
	});

	it('the CG binds: a light pilot, two adults behind, baggage (F-GORQ)', () => {
		// Fuel sits aft of the empty CG: 33 L reaches the 0.564 m aft limit.
		const m = maxFuelWithinLimits(gorq.massBalance!, 100, [70, 150, 20], 0.72, null, null);
		expect(m).toMatchObject({ litres: 33, limitedBy: 'cg', zeroFuelOutside: false });
		const r = computeTripLoads(
			gorqInput({ departure: { target: { kind: 'max' }, loads: { 'Front seats': 70, 'Rear seats': 150, Baggage: 20 } } }),
		);
		expect(r.trips[0].startL).toBe(33);
		expect(r.trips[0].mb!.result.takeoffInside).toBe(true);
		// Every trip short: 33 L carries the plan nowhere, and no single change
		// cures it within limits, so none is offered.
		expect(r.trips[0].sufficient).toBe(false);
		expect(r.shortTrips).toEqual([{ chainIndex: 0, blockStart: 0, fixes: [] }]);
	});

	it('nothing passes: unknown, never 0 L', () => {
		const loads = { 'Front seats': 70, 'Rear seats': 160, Baggage: 40 };
		const m = maxFuelWithinLimits(gorq.massBalance!, 100, [70, 160, 40], 0.72, null, null);
		expect(m).toMatchObject({ litres: null, limitedBy: null, zeroFuelOutside: true });
		const r = computeTripLoads(gorqInput({ departure: { target: { kind: 'max' }, loads } }));
		expect(r.trips[0].maxWithinLimits).toMatchObject({ litres: null, bindingTrip: 0, zeroFuelOutside: true });
		expect(r.trips[0].startL).toBeNull();
		expect(r.trips[0].notes).toEqual(['unavailable']);
	});

	it('F-GIRV four adults, tabs at the stop: over 1157 kg there, Maximum within limits clears it', () => {
		const loads = { 'Front seats': 160, 'Rear seats': 150, Baggage: 20 };
		const base: TripLoadsInput = {
			rows,
			consumptionLph: 40,
			fuel: girv.fuel!,
			mb: girv.massBalance!,
			densityKgPerL: 0.72,
			departure: { target: { kind: 'max' }, loads },
			stops: [null, tick({ kind: 'tabs' })],
		};
		const r = computeTripLoads(base);
		expect(r.trips[0].startL).toBe(109);
		expect(r.trips[1].startL).toBe(128);
		expect(r.trips[1].mb!.result.takeoff.massKg).toBeCloseTo(1170.66, 2);
		expect(r.trips[1].mb!.withinLimits).toBe(false);
		expect(r.withinLimits).toBe(false);
		expect(r.trips[1].maxWithinLimits).toMatchObject({ litres: 109, limitedBy: 'massMax', bindingTrip: 1 });
		const fixed = computeTripLoads({ ...base, stops: [null, tick({ kind: 'max' })] });
		expect(fixed.trips[1].startL).toBe(109);
		expect(fixed.withinLimits).toBe(true);
	});

	it('covers the whole block: two boarding at an unticked stop bind the departure', () => {
		// F-GIRV leaves two aboard; two more board at LFQH, no refuel there.
		const r = computeTripLoads({
			rows,
			consumptionLph: 40,
			fuel: girv.fuel!,
			mb: girv.massBalance!,
			densityKgPerL: 0.72,
			departure: { target: { kind: 'max' }, loads: { 'Front seats': 160, 'Rear seats': 0, Baggage: 20 } },
			stops: [null, tick(null, { 'Rear seats': 150 })],
		});
		// Trip 2's own 109 L plus the 56 L burnt on trip 1 (84 min at 40 L/h).
		expect(r.trips[0].maxWithinLimits).toMatchObject({ litres: 165, limitedBy: 'massMax', bindingTrip: 1 });
		expect(r.trips[0].startL).toBe(165);
		expect(r.trips[1].mb!.payloadKg).toEqual([160, 150, 20]);
		expect(r.trips[1].mb!.stated).toEqual([false, true, false]);
		expect(r.trips[1].mb!.result.takeoff.massKg).toBeLessThanOrEqual(1157 + 1e-9);
		expect(r.withinLimits).toBe(true);
	});

	it('scans the start, not each trip\'s whole-litre maximum floored again', () => {
		// F-GIRV, two aboard out of LFPL, a passenger of 150 kg boarding at LFQH:
		// trip 2's own maximum is 100.6 L (72.43 kg under 1157), and trip 1
		// burns 55.5 L. Composed, 100 + 55.5 floored read 155 L; the start can
		// take 156 (100.5 L left at LFQH).
		const loads = { 'Front seats': 160, 'Rear seats': 0, Baggage: 26.068 };
		const r = computeTripLoads({
			rows,
			consumptionLph: (55.5 / 84) * 60,
			fuel: girv.fuel!,
			mb: girv.massBalance!,
			densityKgPerL: 0.72,
			departure: { target: { kind: 'max' }, loads },
			stops: [null, tick(null, { 'Rear seats': 150 })],
		});
		expect(r.trips[0].maxWithinLimits).toMatchObject({ litres: 156, limitedBy: 'massMax', bindingTrip: 1 });
		expect(r.trips[1].mb!.result.takeoff.massKg).toBeLessThanOrEqual(1157 + 1e-9);
		// One litre more puts trip 2 over its maximum.
		const over = computeTripLoads({
			rows,
			consumptionLph: (55.5 / 84) * 60,
			fuel: girv.fuel!,
			mb: girv.massBalance!,
			densityKgPerL: 0.72,
			departure: { target: { kind: 'custom', litres: 157 }, loads },
			stops: [null, tick(null, { 'Rear seats': 150 })],
		});
		expect(over.trips[1].mb!.withinLimits).toBe(false);
	});

	it('the zero-fuel faults are flagged, never folded into the figure', () => {
		const mb: AircraftMassBalance = { ...hpcp.massBalance!, maxZeroFuelMassKg: 1400 };
		const m = maxFuelWithinLimits(mb, hpcp.fuel!.usableL, [180, 160, 30], 0.72, null, null);
		expect(m.zeroFuelOverMax).toBe(true);
		expect(m.litres).toBe(140);
	});

	it('a maximum landing mass binds at touchdown (taxi added back)', () => {
		const mb: AircraftMassBalance = { ...hpcp.massBalance!, maxLandingMassKg: 1470 };
		const r = computeTripLoads({
			rows: rows.slice(0, 1),
			consumptionLph: 60,
			fuel: hpcp.fuel!,
			mb,
			densityKgPerL: 0.72,
			departure: { target: { kind: 'custom', litres: 140 }, loads: { 'Front seats': 180, 'Rear seats': 160, Baggage: 30 } },
			stops: [],
		});
		// 84 min at 60 L/h = 84 L burnt, 5 min of it taxi: touchdown with 61 L.
		expect(r.trips[0].mb!.touchdownKg).toBeCloseTo(1441 + 61 * 0.72, 6);
		expect(r.trips[0].mb!.overMaxLanding).toBe(true);
		expect(r.trips[0].mb!.withinLimits).toBe(false);
		// 1470 kg at touchdown leaves 40.28 L there: 119 L at the start, the
		// landing mass binding (120 L touches down at 1470.5 kg).
		expect(r.trips[0].maxWithinLimits).toMatchObject({ litres: 119, limitedBy: 'landingMass', bindingTrip: 0 });
	});
});

/* F-GORQ with 280 kg aboard (zero fuel 850 kg, 900 kg at most): 69 L is
 * all any takeoff can take, the Brienne minimum from LFPL is 63 L, from LFQH
 * to the end 62 L, from LFQH to LFGP 35 L and from LFGP 48 L. */
const HEAVY = { 'Front seats': 160, 'Rear seats': 100, Baggage: 20 };
const minimum: FuelTarget = { kind: 'minimum' };
const maxTarget: FuelTarget = { kind: 'max' };

function heavy(departure: FuelTarget, stops: TripLoadsInput['stops'] = []): TripLoadsInput {
	return gorqInput({ departure: { target: departure, loads: HEAVY }, stops });
}

describe('computeTripLoads options', () => {
	const inputs: TripLoadsInput[] = [
		gorqInput({ departure: { target: { kind: 'custom', litres: 63 }, loads: TWO_ABOARD } }),
		heavy(full, [null, tick(minimum)]),
		heavy(minimum, [null, tick(full)]),
		gorqInput({ departure: { target: full, loads: HEAVY }, stops: [null, tick({ kind: 'custom', litres: 30 })] }),
	];

	it('the defaults, spelt out or not, are one result', () => {
		for (const input of inputs) {
			const r = computeTripLoads(input);
			expect(computeTripLoads(input, {})).toEqual(r);
			expect(computeTripLoads(input, { fixes: true, limits: true })).toEqual(r);
		}
	});

	it('without the fixes: the same chain, no fix offered', () => {
		for (const input of inputs) {
			const r = computeTripLoads(input);
			const bare = computeTripLoads(input, { fixes: false });
			expect(bare.trips).toEqual(r.trips);
			expect(bare.shortTrips).toEqual(r.shortTrips.map((st) => ({ ...st, fixes: [] })));
			expect(bare.limitFixes).toEqual([]);
		}
	});

	it('without the limits: the Maximum within limits only where a target asks for it', () => {
		for (const input of inputs) {
			const r = computeTripLoads(input);
			const lean = computeTripLoads(input, { limits: false });
			for (const [k, tr] of lean.trips.entries()) {
				expect(tr.maxWithinLimits).toEqual(tr.target?.kind === 'max' ? r.trips[k].maxWithinLimits : null);
				expect({ ...tr, maxWithinLimits: null }).toEqual({ ...r.trips[k], maxWithinLimits: null });
			}
		}
	});

	it('every trip carries its payload, whatever its fuel', () => {
		// No consumption: the Minimum cannot resolve, so trip 1 has no weighing.
		const r = computeTripLoads(gorqInput({ consumptionLph: null, departure: { target: minimum, loads: TWO_ABOARD } }));
		expect(r.trips[0].mb).toBeNull();
		expect(r.trips[0].payloadKg).toEqual([160, 0, 10]);
		expect(r.trips[0].stated).toEqual([true, true, true]);
		expect(computeTripLoads(gorqInput({ mb: null })).trips[0].payloadKg).toEqual([]);
	});
});

describe('tripLimitFault: the limits the fuel decides', () => {
	const mb = gorq.massBalance!;

	it('a takeoff above the maximum mass', () => {
		const r = computeTripLoads(heavy(full));
		expect(tripLimitFault(r.trips[0], mb)).toMatchObject({ why: 'massMax', phase: 'takeoff', limitKg: 900 });
		expect(tripLimitFault(r.trips[0], mb)!.massKg).toBeCloseTo(922, 6);
	});

	it('a takeoff out of the envelope', () => {
		const r = computeTripLoads(gorqInput({ departure: { target: full, loads: { 'Front seats': 70, 'Rear seats': 150, Baggage: 20 } } }));
		expect(tripLimitFault(r.trips[0], mb)).toMatchObject({ why: 'cg', phase: 'takeoff', limitKg: null });
	});

	it('a touchdown above the maximum landing mass', () => {
		const hmb: AircraftMassBalance = { ...hpcp.massBalance!, maxLandingMassKg: 1470 };
		const r = computeTripLoads({
			rows: rows.slice(0, 1),
			consumptionLph: 60,
			fuel: hpcp.fuel!,
			mb: hmb,
			densityKgPerL: 0.72,
			departure: { target: { kind: 'custom', litres: 140 }, loads: { 'Front seats': 180, 'Rear seats': 160, Baggage: 30 } },
			stops: [],
		});
		const f = tripLimitFault(r.trips[0], hmb)!;
		expect(f).toMatchObject({ why: 'landingMass', phase: 'landing', limitKg: 1470 });
		expect(f.massKg).toBeCloseTo(1484.92, 2);
	});

	it('never a station over its maximum, which no fuel changes', () => {
		const r = computeTripLoads(gorqInput({ departure: { target: full, loads: { 'Front seats': 160, 'Rear seats': 0, Baggage: 45 } } }));
		expect(r.trips[0].mb!.withinLimits).toBe(false);
		expect(tripLimitFault(r.trips[0], mb)).toBeNull();
	});
});

describe('limitFixes: the Maximum within limits, verified', () => {
	it('full tanks at LFPL with 280 kg aboard: 69 L there', () => {
		const r = computeTripLoads(heavy(full, [null, tick(minimum)]));
		expect(r.trips[0].mb!.result.takeoff.massKg).toBeCloseTo(922, 6);
		expect(r.limitFixes).toEqual([{ chainIndex: 0, litres: 69 }]);
		const fixed = computeTripLoads(heavy(maxTarget, [null, tick(minimum)]));
		expect(fixed.withinLimits).toBe(true);
		expect(fixed.fuelSufficient).toBe(true);
		expect(fixed.trips[1].startL).toBe(62);
	});

	it('full tanks at LFQH: 69 L there, which carries LFGP too', () => {
		const r = computeTripLoads(heavy(minimum, [null, tick(full)]));
		expect(r.trips[1].mb!.result.takeoff.massKg).toBeCloseTo(922, 6);
		expect(r.trips[2].mb!.result.takeoff.massKg).toBeCloseTo(912.1, 6);
		expect(r.limitFixes).toEqual([{ chainIndex: 1, litres: 69 }]);
	});

	it('F-GIRV four adults, tabs at the stop: 109 L there', () => {
		const r = computeTripLoads({
			rows,
			consumptionLph: 40,
			fuel: girv.fuel!,
			mb: girv.massBalance!,
			densityKgPerL: 0.72,
			departure: { target: maxTarget, loads: { 'Front seats': 160, 'Rear seats': 150, Baggage: 20 } },
			stops: [null, tick({ kind: 'tabs' })],
		});
		expect(r.limitFixes).toEqual([{ chainIndex: 1, litres: 109 }]);
	});

	it('none where the block needs more than the limits allow', () => {
		// Refuelling at LFGP only, LFPL must carry 70 L to it: 900.4 kg.
		const r = computeTripLoads(heavy(minimum, [null, null, tick(minimum)]));
		expect(r.trips[0].mb!.result.takeoff.massKg).toBeCloseTo(900.4, 6);
		expect(r.limitFixes).toEqual([]);
	});

	it('none where what arrives is already too much (nothing is drained)', () => {
		const r = computeTripLoads(gorqInput({ stops: [null, tick(minimum, { 'Rear seats': 115 })] }));
		expect(r.trips[1].startL).toBe(65);
		expect(r.trips[1].mb!.result.takeoff.massKg).toBeGreaterThan(900);
		expect(r.limitFixes).toEqual([]);
	});

	it('none that would short a trip which had its fuel', () => {
		// 69 L at LFPL leaves 34 L at LFQH, above its 30 L custom figure and
		// short of trip 2's reserve: the fix would trade one NO for another.
		const r = computeTripLoads(heavy(full, [null, tick({ kind: 'custom', litres: 30 })]));
		expect(r.trips[1].sufficient).toBe(true);
		expect(r.limitFixes).toEqual([]);
		const tried = computeTripLoads(heavy(maxTarget, [null, tick({ kind: 'custom', litres: 30 })]));
		expect(tried.trips[1].sufficient).toBe(false);
	});
});

describe('takeoffWindow', () => {
	const win = (r: TripLoadsResult, k: number, usable = 100) => takeoffWindow(r.trips[k], usable);

	it('every takeoff set at the Minimum, 280 kg aboard', () => {
		const r = computeTripLoads(heavy(minimum, [null, tick(minimum), tick(minimum)]));
		expect(win(r, 0)).toEqual({
			chainIndex: 0, state: 'open', neededL: 63, maxL: 69, limitedBy: 'massMax', bindingTrip: 0,
			limitsChecked: true, beyondTank: false, carriedL: null, uplift: null, planUpliftL: null,
		});
		expect(win(r, 1)).toMatchObject({ state: 'open', neededL: 35, maxL: 69, uplift: { lo: 7, hi: 41 }, planUpliftL: 7 });
		expect(win(r, 1)!.carriedL).toBeCloseTo(28, 9);
		expect(win(r, 2)).toMatchObject({ state: 'open', neededL: 48, maxL: 69, uplift: { lo: 27, hi: 47 }, planUpliftL: 27 });
		expect(win(r, 2)!.carriedL).toBeCloseTo(21.25, 9);
		// At the Maximum, the plan's uplift rounds down.
		const atMax = computeTripLoads(heavy(minimum, [null, tick(minimum), tick(maxTarget)]));
		expect(win(atMax, 2)!.planUpliftL).toBe(47);
	});

	it('the s6 shape: 69 L out of LFPL, the Minimum at LFQH', () => {
		const r = computeTripLoads(heavy(maxTarget, [null, tick(minimum)]));
		expect(win(r, 1)).toMatchObject({ state: 'open', neededL: 62, maxL: 69, uplift: { lo: 28, hi: 35 }, planUpliftL: 28 });
	});

	it('an empty window: the block needs more than the limits allow', () => {
		const r = computeTripLoads(heavy(minimum, [null, null, tick(minimum)]));
		expect(win(r, 0)).toMatchObject({ state: 'empty', neededL: 70, maxL: 69, beyondTank: false, uplift: null });
	});

	it('beyond the tank', () => {
		const r = computeTripLoads(gorqInput({ fuel: { usableL: 70, presets: [] }, departure: { target: minimum, loads: TWO_ABOARD } }));
		expect(win(r, 0, 70)).toMatchObject({ state: 'empty', neededL: 97, maxL: 70, beyondTank: true });
	});

	it('what arrives already above the limits', () => {
		const r = computeTripLoads(gorqInput({ stops: [null, tick(minimum, { 'Rear seats': 115 })] }));
		expect(win(r, 1)).toMatchObject({ state: 'aboveMaxOnArrival', neededL: 62, maxL: 62, uplift: null, planUpliftL: 0 });
		expect(win(r, 1)!.carriedL).toBeCloseTo(65, 9);
	});

	it('nothing to add', () => {
		const r = computeTripLoads(gorqInput({ stops: [null, tick(minimum)] }));
		expect(win(r, 1)).toMatchObject({ state: 'noUpliftNeeded', neededL: 62, maxL: 100, uplift: { lo: 0, hi: 35 } });
	});

	it('no mass and balance section: the tanks alone', () => {
		const r = computeTripLoads(gorqInput({ mb: null }));
		expect(win(r, 0)).toMatchObject({ limitsChecked: false, maxL: 100, neededL: 97, state: 'open' });
	});

	it('no consumption: the need unknown', () => {
		const r = computeTripLoads(gorqInput({ consumptionLph: null, departure: { target: full, loads: HEAVY } }));
		expect(win(r, 0)).toMatchObject({ state: 'needUnknown', neededL: null, maxL: 69 });
	});

	it('no quantity within the limits', () => {
		const r = computeTripLoads(gorqInput({ departure: { target: full, loads: { 'Front seats': 70, 'Rear seats': 160, Baggage: 40 } } }));
		expect(win(r, 0)).toMatchObject({ state: 'noneWithin', maxL: null });
	});

	it('none where the fuel is carried over', () => {
		const r = computeTripLoads(heavy(minimum));
		expect(win(r, 1)).toBeNull();
	});
});

describe('checkStrategies: the strategies flown through the limits', () => {
	const tripInputs = brienneTrips();
	const plan100 = computeRefuelPlan(tripInputs, { ...PARAMS, usableFuelL: 100 });
	const byStops = (stops: number[]) => plan100.strategies.findIndex((s) => s.stops.join() === stops.join());

	it('280 kg aboard: no refuel and LFGP alone break the maximum at LFPL', () => {
		const checks = checkStrategies(heavy(full), plan100.strategies);
		const none = checks[byStops([])];
		expect(none.withinLimits).toBe(false);
		expect(none.fault).toMatchObject({ trip: 0, blockStart: 0, startL: 97, maxWithinL: 69, why: 'massMax' });
		expect(none.fault!.massKg).toBeCloseTo(919.84, 6);
		const qh = checks[byStops([0])];
		expect(qh.withinLimits).toBe(true);
		expect(qh.takeoffs.map((t) => [t.chainIndex, t.startL])).toEqual([[0, 63], [1, 62]]);
		expect(qh.takeoffs[1].upliftL).toBeCloseTo(34, 9);
		const gp = checks[byStops([1])];
		expect(gp.fault).toMatchObject({ trip: 0, startL: 70, maxWithinL: 69 });
		expect(gp.takeoffs[1].upliftL).toBeCloseTo(26.75, 9);
		const both = checks[byStops([0, 1])];
		expect(both.withinLimits).toBe(true);
		expect(both.takeoffs.map((t) => t.startL)).toEqual([63, 35, 48]);
	});

	it('two aboard: every strategy keeps the limits', () => {
		const checks = checkStrategies(gorqInput(), plan100.strategies);
		expect(checks.map((c) => c.withinLimits)).toEqual([true, true, true, true]);
	});

	it('a passenger boarding at LFQH: only a refuel after it keeps the takeoff there light enough', () => {
		const input = gorqInput({ stops: [null, tick(null, { 'Rear seats': 100, Baggage: 30 })] });
		const checks = checkStrategies(input, plan100.strategies);
		expect(checks[byStops([])].fault).toMatchObject({ trip: 1, blockStart: 0, startL: 97, maxWithinL: 90 });
		expect(checks[byStops([])].fault!.massKg).toBeCloseTo(904.64, 6);
		expect(checks[byStops([0])].fault).toMatchObject({ trip: 1, blockStart: 1, startL: 62, maxWithinL: 55 });
		expect(checks[byStops([1])].withinLimits).toBe(true);
		expect(checks[byStops([0, 1])].withinLimits).toBe(true);
	});

	it('a payload no fuel brings within the limits blocks no strategy', () => {
		const input = gorqInput({ departure: { target: full, loads: { 'Front seats': 70, 'Rear seats': 160, Baggage: 40 } } });
		for (const c of checkStrategies(input, plan100.strategies)) {
			expect(c.withinLimits).toBeNull();
			expect(c.payloadOut).toBe(true);
		}
	});

	it('without a mass and balance section: unknown', () => {
		expect(checkStrategies(gorqInput({ mb: null }), plan100.strategies).every((c) => c.withinLimits === null)).toBe(true);
	});

	it('each simulation is the chain computed afresh (the shared cache changes nothing)', () => {
		for (let n = 2; n <= 6; n++) {
			const rws = syntheticRows(n, 3 + n);
			const tripIns = rws.map((r) => ({
				label: r.label, taxiMin: r.taxiMin, tripMin: r.tripMin, procedureMin: r.procedureMin,
				windAllowanceMin: r.windAllowanceMin, contingencyMin: r.contingencyMin, alternate: r.alternate ?? undefined,
			}));
			const plan = computeRefuelPlan(tripIns, { ...PARAMS, usableFuelL: 100 });
			const input: TripLoadsInput = {
				rows: rws,
				consumptionLph: 25,
				fuel: gorq.fuel!,
				mb: gorq.massBalance!,
				densityKgPerL: 0.72,
				departure: { target: full, loads: HEAVY },
				stops: rws.map((_, k) => (k === 2 ? tick(null, { 'Rear seats': 0 }) : null)),
			};
			const checks = checkStrategies(input, plan.strategies);
			for (const [i, s] of plan.strategies.entries()) {
				const fresh = computeTripLoads(
					{
						...input,
						departure: { target: minimum, loads: HEAVY },
						stops: rws.map((_, k) =>
							k === 0 ? null : { refuel: s.stops.includes(k - 1) ? minimum : null, loads: input.stops[k]?.loads ?? {} },
						),
					},
					{ fixes: false },
				);
				expect(checks[i].loads).toEqual(fresh);
			}
		}
	});
});

describe('strategyTargets: "Use this plan" keeps what holds', () => {
	it('a departure at Full tanks over the maximum takes its Maximum within limits', () => {
		expect(strategyTargets(heavy(full), [0])).toEqual([maxTarget, minimum, null]);
	});

	it('a departure within the limits stays as the pilot set it', () => {
		expect(strategyTargets(heavy(maxTarget), [0])).toEqual([maxTarget, minimum, null]);
		expect(strategyTargets(gorqInput(), [0])).toEqual([full, minimum, null]);
	});

	it('decided in flight order: the lighter departure is what clears the stop', () => {
		// 5 kg more baggage at LFQH: 62 L at most there, its Minimum. Out of
		// LFPL at full tanks, 65 L would arrive (nothing is drained): over the
		// maximum; at LFPL's own Maximum, 34 L arrive and LFQH takes its 62.
		const input = heavy(full, [null, tick(null, { Baggage: 25 })]);
		expect(strategyTargets(input, [0])).toEqual([maxTarget, minimum, null]);
		const flown = computeTripLoads(heavy(maxTarget, [null, tick(minimum, { Baggage: 25 })]));
		expect(flown.withinLimits).toBe(true);
		expect(flown.fuelSufficient).toBe(true);
	});

	it('a stop already ticked keeps its target unless its block then breaks a limit', () => {
		expect(strategyTargets(heavy(minimum, [null, tick(full)]), [0])).toEqual([minimum, maxTarget, null]);
		expect(strategyTargets(gorqInput({ stops: [null, tick(full)] }), [0, 1])).toEqual([full, full, minimum]);
	});
});

describe('computeTripLoads: unknowns', () => {
	it('no consumption: takeoffs at fuel-set points resolve, the rest is unknown', () => {
		const r = computeTripLoads(gorqInput({ consumptionLph: null, stops: [null, null, tick(full)] }));
		expect(r.trips[0].startL).toBe(100);
		expect(r.trips[0].burnL).toBeNull();
		expect(r.trips[0].landingL).toBeNull();
		expect(r.trips[0].sufficient).toBeNull();
		expect(r.trips[0].mb!.landingKnown).toBe(false);
		expect(r.trips[0].mb!.withinLimits).toBeNull();
		expect(r.trips[1].startL).toBeNull();
		expect(r.trips[2].startL).toBe(100);
		expect(r.fuelSufficient).toBeNull();
	});

	it('no M&B section: the fuel chain alone', () => {
		const r = computeTripLoads(gorqInput({ mb: null }));
		expect(r.trips.every((t) => t.mb === null)).toBe(true);
		expect(r.fuelSufficient).toBe(true);
		expect(r.withinLimits).toBeNull();
	});

	it('no trips: the departure alone', () => {
		const r = computeTripLoads(gorqInput({ rows: [] }));
		expect(r.trips).toHaveLength(1);
		expect(r.trips[0].startL).toBe(100);
		expect(r.trips[0].sufficient).toBeNull();
		expect(r.fuelSufficient).toBeNull();
		expect(r.trips[0].mb!.result.takeoff.massKg).toBeCloseTo(812, 6);
	});
});

describe('the fuel on board at the departure (the journey log, onBoard.ts)', () => {
	const aboard = (
		target: FuelTarget | null,
		aboardL: number | null | undefined,
		over: Partial<TripLoadsInput> = {},
		loads: Record<string, number> = TWO_ABOARD,
	): TripLoadsInput => gorqInput({ departure: { target, aboardL, loads }, ...over });

	it('absent, undefined, null or not a number: the results of a departure with no reading', () => {
		const bases: TripLoadsInput[] = [
			gorqInput(),
			gorqInput({ departure: { target: minimum, loads: TWO_ABOARD }, stops: [null, tick(full)] }),
			heavy(full, [null, tick(minimum)]),
			heavy(minimum, [null, null, tick(minimum)]),
			gorqInput({ departure: { target: { kind: 'custom', litres: 45 }, loads: TWO_ABOARD } }),
		];
		for (let n = 2; n <= 5; n++) {
			const rws = syntheticRows(n, 61 + n);
			bases.push({
				...gorqInput({ rows: rws, departure: { target: minimum, loads: HEAVY } }),
				stops: rws.map((_, k) => (k === 2 ? tick(full, { 'Rear seats': 0 }) : null)),
			});
		}
		for (const input of bases) {
			const base = computeTripLoads(input);
			for (const aboardL of [undefined, null, Number.NaN]) {
				expect(computeTripLoads({ ...input, departure: { ...input.departure, aboardL } })).toEqual(base);
			}
			const w = takeoffWindow(base.trips[0], 100)!;
			expect([w.carriedL, w.uplift, w.planUpliftL]).toEqual([null, null, null]);
			expect(base.trips[0].upliftL).toBeNull();
		}
	});

	it('the Minimum over 40 L aboard: the uplift and its window, as at a stop', () => {
		const r = computeTripLoads(aboard(minimum, 40, { stops: [null, tick(full)] }));
		const a = r.trips[0];
		expect(a.carriedL).toBe(40);
		expect(a.startL).toBe(63);
		expect(a.upliftL).toBe(23);
		expect(a.notes).toEqual([]);
		expect(takeoffWindow(a, 100)).toMatchObject({
			state: 'open', neededL: 63, maxL: 100, carriedL: 40, uplift: { lo: 23, hi: 60 }, planUpliftL: 23,
		});
	});

	it('the Minimum over 80 L aboard: nothing to add, nothing drained', () => {
		const r = computeTripLoads(aboard(minimum, 80, { stops: [null, tick(full)] }));
		const a = r.trips[0];
		expect(a.startL).toBe(80);
		expect(a.upliftL).toBe(0);
		expect(a.notes).toEqual(['noUpliftNeeded']);
		expect(a.landingL).toBeCloseTo(45, 9);
		expect(r.trips[1].upliftL).toBeCloseTo(55, 9);
		expect(takeoffWindow(a, 100)).toMatchObject({ state: 'noUpliftNeeded', uplift: { lo: 0, hi: 20 }, planUpliftL: 0 });
	});

	it('Full tanks over what is aboard: the uplift to the brim', () => {
		const a = computeTripLoads(aboard(full, 64.6)).trips[0];
		expect(a.startL).toBe(100);
		expect(a.upliftL).toBeCloseTo(35.4, 9);
	});

	it('no refuel: off with what is aboard', () => {
		const r = computeTripLoads(aboard(null, 70, { stops: [null, tick(full)] }));
		const a = r.trips[0];
		expect(a.fuelSet).toBe(true);
		expect(a.target).toBeNull();
		expect(a.requestedL).toBe(70);
		expect(a.startL).toBe(70);
		expect(a.upliftL).toBe(0);
		expect(a.notes).toEqual([]);
		expect(a.sufficient).toBe(true);
		expect(takeoffWindow(a, 100)).toMatchObject({ state: 'noUpliftNeeded', uplift: { lo: 0, hi: 30 }, planUpliftL: 0 });
	});

	it('no refuel, short: the departure raised is the fix', () => {
		const r = computeTripLoads(aboard(null, 30, { stops: [null, tick(full)] }));
		expect(r.trips[0].startL).toBe(30);
		expect(r.trips[0].sufficient).toBe(false);
		expect(r.shortTrips).toEqual([
			{ chainIndex: 0, blockStart: 0, fixes: [{ kind: 'raiseStart', chainIndex: 0, litres: 63, coversBlock: true }] },
		]);
		expect(takeoffWindow(r.trips[0], 100)).toMatchObject({ state: 'open', uplift: { lo: 33, hi: 70 }, planUpliftL: 0 });
	});

	it('no refuel and nothing known aboard: unknown, never 0 L', () => {
		for (const aboardL of [undefined, null]) {
			const r = computeTripLoads(aboard(null, aboardL, { stops: [null, null, tick(full)] }));
			expect(r.trips[0].notes).toEqual(['aboardUnknown']);
			expect(r.trips[0].startL).toBeNull();
			expect(r.trips[0].landingL).toBeNull();
			expect(r.trips[0].sufficient).toBeNull();
			expect(r.trips[0].upliftL).toBeNull();
			expect(r.trips[1].startL).toBeNull();
			expect(r.trips[2].startL).toBe(100);
			expect(r.fuelSufficient).toBeNull();
			expect(r.shortTrips).toEqual([]);
			expect(takeoffWindow(r.trips[0], 100)).toMatchObject({ carriedL: null, uplift: null, planUpliftL: null });
		}
	});

	it('a figure above the tanks is held to them (onBoard.ts refuses to type one)', () => {
		const a = computeTripLoads(aboard(null, 140)).trips[0];
		expect(a.carriedL).toBe(100);
		expect(a.startL).toBe(100);
	});

	describe('more aboard than the limits allow (280 kg aboard, 69 L at most)', () => {
		it('the Minimum keeps what is aboard: above the maximum on arrival, no limit fix', () => {
			const r = computeTripLoads(aboard(minimum, 80, { stops: [null, tick(minimum)] }, HEAVY));
			const a = r.trips[0];
			expect(a.startL).toBe(80);
			expect(a.notes).toEqual(['noUpliftNeeded']);
			expect(tripLimitFault(a, gorq.massBalance!)).toMatchObject({ why: 'massMax' });
			expect(takeoffWindow(a, 100)).toMatchObject({
				state: 'aboveMaxOnArrival', maxL: 69, carriedL: 80, uplift: null, planUpliftL: 0,
			});
			expect(r.limitFixes).toEqual([]);
		});

		it('the Maximum within limits drains nothing', () => {
			const a = computeTripLoads(aboard(maxTarget, 80, { stops: [null, tick(minimum)] }, HEAVY)).trips[0];
			expect(a.startL).toBe(80);
			expect(a.notes).toEqual(['noDefuel']);
		});

		it('every strategy flown starts from what is aboard', () => {
			const plan100 = computeRefuelPlan(brienneTrips(), { ...PARAMS, usableFuelL: 100 });
			const checks = checkStrategies(aboard(full, 80, {}, HEAVY), plan100.strategies);
			// Its own load where that is more (no refuel: 97 L), else the 80.
			expect(checks.map((c) => c.takeoffs[0].startL)).toEqual([97, 80, 80, 80]);
			for (const c of checks) {
				const start = c.takeoffs[0].startL!;
				expect(c.withinLimits).toBe(false);
				expect(c.fault).toMatchObject({ trip: 0, blockStart: 0, startL: start, maxWithinL: 69 });
				expect(c.takeoffs[0].upliftL).toBe(start - 80);
			}
			// 60 L aboard, within them: the departure's own Minimum, 3 L added.
			const within = checkStrategies(aboard(full, 60, {}, HEAVY), plan100.strategies);
			const qh = within[plan100.strategies.findIndex((s) => s.stops.join() === '0')];
			expect(qh.withinLimits).toBe(true);
			expect(qh.takeoffs[0]).toMatchObject({ startL: 63, upliftL: 3 });
		});

		it('below them, a limit the fuel decides is cured at the departure', () => {
			// No refuel over 75 L aboard, the limits allowing 69: the Maximum
			// within limits keeps 75 aboard (nothing drained), so no fix.
			expect(computeTripLoads(aboard(null, 75, { stops: [null, tick(minimum)] }, HEAVY)).limitFixes).toEqual([]);
		});
	});

	describe('strategyTargets: a no refuel at the departure takes the Minimum', () => {
		it('which what is aboard may already cover', () => {
			expect(strategyTargets(aboard(null, 70), [0])).toEqual([minimum, minimum, null]);
			const flown = computeTripLoads(aboard(minimum, 70, { stops: [null, tick(minimum)] }));
			expect(flown.trips[0]).toMatchObject({ startL: 70, upliftL: 0 });
		});

		it('or its Maximum within limits when the Minimum breaks one', () => {
			expect(strategyTargets(aboard(null, null, {}, HEAVY), [])).toEqual([maxTarget, null, null]);
			expect(strategyTargets(aboard(null, 60, {}, HEAVY), [0])).toEqual([minimum, minimum, null]);
		});
	});
});

/** Deterministic rows for n trips: burn-offs 25-110 min (half of them with a
 *  contingency), reserves 40-75. */
function syntheticRows(n: number, seed: number): FuelTripRow[] {
	let x = seed;
	const rnd = () => {
		x = (x * 1103515245 + 12345) % 2147483648;
		return x / 2147483648;
	};
	const trips: FuelTripInput[] = Array.from({ length: n }, (_, i) => ({
		label: `T${i}`,
		taxiMin: 10,
		tripMin: Math.round(15 + rnd() * 70),
		procedureMin: 10,
		windAllowanceMin: Math.round(rnd() * 6),
		contingencyMin: rnd() < 0.5 ? Math.round(rnd() * 15) : undefined,
		alternate:
			rnd() < 0.7
				? { label: `A${i}`, timeMin: Math.round(5 + rnd() * 25), procedureMin: 10, windAllowanceMin: Math.round(rnd() * 3) }
				: undefined,
	}));
	return computeFuelPlan(trips, PARAMS).trips;
}

describe('the per-trip verdicts and the strategies never disagree (1 to 6 trips)', () => {
	for (let n = 1; n <= 6; n++) {
		it(`${n} trip${n > 1 ? 's' : ''}, every subset of stops`, () => {
			const rws = syntheticRows(n, 7 + n);
			const tripInputs = rws.map((r) => ({
				label: r.label, taxiMin: r.taxiMin, tripMin: r.tripMin, procedureMin: r.procedureMin,
				windAllowanceMin: r.windAllowanceMin, contingencyMin: r.contingencyMin, alternate: r.alternate ?? undefined,
			}));
			for (const usable of [60, 90, 140, 400]) {
				const plan = computeRefuelPlan(tripInputs, { ...PARAMS, usableFuelL: usable });
				// What is aboard before the departure's refuel, unknown or read.
				for (const aboardL of [null, 0, 15]) {
				for (const s of plan.strategies) {
					const fuelInput = (dep: FuelTarget, stop: FuelTarget): TripLoadsInput => ({
						rows: rws,
						consumptionLph: 25,
						fuel: { usableL: usable, presets: [] },
						mb: null,
						densityKgPerL: 0.72,
						departure: { target: dep, aboardL, loads: {} },
						stops: rws.map((_, k) => (k > 0 && s.stops.includes(k - 1) ? tick(stop) : null)),
					});
					// Full at every block start: all sufficient exactly when feasible.
					const f = computeTripLoads(fuelInput(full, full));
					expect(f.fuelSufficient).toBe(s.feasible);
					if (!s.feasible) {
						continue;
					}
					// Minimum at every block start: the strategy's own loads,
					// rounded up, and every trip sufficient.
					const m = computeTripLoads(fuelInput({ kind: 'minimum' }, { kind: 'minimum' }));
					expect(m.fuelSufficient).toBe(true);
					for (const l of s.loads) {
						expect(m.trips[l.tripIndex].blockMinimumL).toBeCloseTo(l.litres, 9);
						const want = Math.min(ceilLitres(l.litres), usable);
						expect(Math.max(want, m.trips[l.tripIndex].carriedL ?? 0)).toBeCloseTo(m.trips[l.tripIndex].startL!, 9);
					}
					// One litre less at the departure, when it binds (and what is
					// aboard does not hold it up), shorts a trip.
					const need = s.loads[0].litres;
					if (ceilLitres(need) - 1 >= (aboardL ?? 0)) {
						const short = computeTripLoads(fuelInput({ kind: 'custom', litres: ceilLitres(need) - 1 }, { kind: 'minimum' }));
						expect(short.fuelSufficient).toBe(false);
					}
					// Equal to the requirement is enough (the shared tolerance).
					const exact = computeTripLoads(fuelInput({ kind: 'custom', litres: need }, { kind: 'minimum' }));
					expect(exact.trips[0].sufficient).toBe(true);
				}
				}
			}
		});
	}
});

describe('every offered fix cures its block when applied by hand', () => {
	it('synthetic chains, short departures and short stops', () => {
		let offered = 0;
		for (let n = 2; n <= 6; n++) {
			const rws = syntheticRows(n, 31 + n);
			for (const usable of [90, 140]) {
				// A Custom figure, or no refuel over what the journey log leaves.
				for (const [target, aboardL] of [
					[{ kind: 'custom', litres: 20 }, null],
					[{ kind: 'custom', litres: 45 }, null],
					[{ kind: 'custom', litres: 70 }, null],
					[{ kind: 'custom', litres: 20 }, 10],
					[null, 20],
					[null, 45],
				] as [FuelTarget | null, number | null][]) {
					for (let tickAt = 0; tickAt < n; tickAt++) {
						const input: TripLoadsInput = {
							rows: rws,
							consumptionLph: 25,
							fuel: { usableL: usable, presets: [] },
							mb: null,
							densityKgPerL: 0.72,
							departure: { target, aboardL, loads: {} },
							// One stop ticked at a short custom figure (none when tickAt is 0).
							stops: rws.map((_, k) => (k > 0 && k === tickAt ? tick({ kind: 'custom', litres: 30 }) : null)),
						};
						const r = computeTripLoads(input);
						for (const st of r.shortTrips) {
							let end = st.blockStart;
							while (end + 1 < n && !r.trips[end + 1].fuelSet) {
								end++;
							}
							for (const fix of st.fixes) {
								offered++;
								const through = fix.coversBlock ? end : st.chainIndex;
								const stops = [...input.stops];
								let dep = input.departure;
								if (fix.kind === 'refuelAt') {
									stops[fix.chainIndex] = tick({ kind: fix.target });
								} else if (fix.chainIndex === 0) {
									dep = { ...dep, target: { kind: 'custom', litres: fix.litres } };
								} else {
									stops[fix.chainIndex] = tick({ kind: 'custom', litres: fix.litres });
								}
								const after = computeTripLoads({ ...input, departure: dep, stops });
								for (let k = st.blockStart; k <= through; k++) {
									expect(
										after.trips[k].sufficient,
										`n=${n} ${JSON.stringify(input.departure)} fix ${JSON.stringify(fix)} trip ${k}`,
									).toBe(true);
								}
								if (fix.kind === 'raiseStart' && !fix.coversBlock) {
									// A raise curing the short trip alone only where no raise
									// cures the block (a refuel may: refuelling later is the
									// other way the pilot can go).
									expect(st.fixes.some((f) => f.kind === 'raiseStart' && f.coversBlock)).toBe(false);
								}
							}
							// A raise covering the block is offered whenever the block fits
							// the tank; one curing the short trip whenever that trip does.
							const need = r.trips[st.blockStart].blockMinimumL!;
							expect(st.fixes.some((f) => f.kind === 'raiseStart' && f.coversBlock)).toBe(ceilLitres(need) <= usable);
							expect(st.fixes.some((f) => f.kind === 'raiseStart')).toBe(
								ceilLitres(need) <= usable ||
									ceilLitres(blockMinimumMin(rws, st.blockStart, st.chainIndex) * (25 / 60)) <= usable,
							);
						}
					}
				}
			}
		}
		expect(offered).toBeGreaterThan(100);
	});
});
