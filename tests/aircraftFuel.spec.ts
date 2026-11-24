/* Fuel plan + refuelling plan (src/lib/aircraft/fuel.ts), pinned to the
 * source workbook's Brienne navigation (Carburant tab: LFPL -> LFQH -> LFGP
 * -> LFPL with alternates LFQB / LFLA / LFPK). The minutes are the workbook's
 * cells verbatim; the litres run at the fleet's corrected 25 L/h (the
 * historic sheet planned the DR400/120 at 24). */

import { describe, it, expect } from 'vitest';
import {
	tripTimes,
	tripTimesLegs,
	fuelTripFromTimes,
	computeFuelPlan,
	computeRefuelPlan,
	autoFinalReserveMin,
	blockMinimumMin,
	ceilLitres,
	floorLitres,
	type FuelTripInput,
	type FuelPlanParams,
} from '$lib/aircraft/fuel';

const PARAMS: FuelPlanParams = { consumptionLph: 25, finalReserveMin: 30, pilotMarginMin: 0 };

/** The Brienne workbook inputs (minutes already rounded, as in the sheet). */
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

describe('computeFuelPlan', () => {
	it('reproduces the Brienne fuel budget', () => {
		const plan = computeFuelPlan(brienneTrips(), PARAMS);
		expect(plan.trips.map((t) => t.burnOffStillAirMin)).toEqual([84, 30, 60]);
		expect(plan.trips.map((t) => t.burnOffMin)).toEqual([84, 33, 64]);
		expect(plan.trips.map((t) => t.reserveMin)).toEqual([64, 48, 50]);
		expect(plan.trips.map((t) => t.reserveWithWindMin)).toEqual([66, 49, 50]);
		expect(plan.trips.map((t) => t.totalMin)).toEqual([150, 82, 114]);
		// Litres are unrounded (minutes x 25/60); displays 63 / 34 / 48 L.
		expect(plan.trips[0].totalL).toBeCloseTo(62.5, 6);
		expect(plan.trips[1].totalL).toBeCloseTo(34.1667, 3);
		expect(plan.trips[2].totalL).toBeCloseTo(47.5, 6);
		// Grand totals (single tankful), correction #13: the per-flight rule
		// at every landing, the no-refuel strategy's own 231 min. The
		// workbook's B26 / B27 (every burn-off plus the LARGEST reserve)
		// read 238 / 247 and printed "103 L, exceeds the usable fuel" beside
		// "No refuelling, 96 L" on a 100 L tank; recomputed here from the rows
		// with the sheet's own formula, so the history stays pinned.
		expect(plan.totalStillAirMin).toBe(224);
		expect(plan.totalMin).toBe(231);
		expect(plan.totalL).toBeCloseTo(96.25, 6); // displays 97 L (a load rounds up)
		const sheet = (burn: (r: (typeof plan.trips)[number]) => number, res: (r: (typeof plan.trips)[number]) => number) =>
			plan.trips.reduce((a, r) => a + burn(r), 0) + Math.max(...plan.trips.map(res));
		expect(sheet((r) => r.burnOffStillAirMin, (r) => r.reserveMin)).toBe(238);
		expect(sheet((r) => r.burnOffMin, (r) => r.reserveWithWindMin)).toBe(247);
	});

	it('the single tankful equals the no-refuel strategy (one rule, two pages)', () => {
		const trips = brienneTrips();
		const plan = computeFuelPlan(trips, PARAMS);
		const refuel = computeRefuelPlan(trips, { ...PARAMS, usableFuelL: 100 });
		const none = refuel.strategies.find((st) => st.stops.length === 0)!;
		expect(plan.totalMin).toBe(none.maxLoadMin);
		expect(plan.totalL).toBeCloseTo(none.maxLoadL, 9);
	});

	it('burns a contingency with its trip, and none unless the pilot types one', () => {
		const trips = brienneTrips();
		const plain = computeFuelPlan(trips, PARAMS);
		expect(plain.trips.map((t) => t.contingencyMin)).toEqual([0, 0, 0]);
		// The club form's "Perfo, évitements, MTO, ATC, attente": 10 min on the
		// second trip join its burn-off like its taxi and procedure.
		trips[1].contingencyMin = 10;
		const plan = computeFuelPlan(trips, PARAMS);
		expect(plan.trips[1].contingencyMin).toBe(10);
		expect(plan.trips.map((t) => t.burnOffStillAirMin)).toEqual([84, 40, 60]);
		expect(plan.trips.map((t) => t.burnOffMin)).toEqual([84, 43, 64]);
		expect(plan.trips.map((t) => t.reserveWithWindMin)).toEqual([66, 49, 50]);
		expect(plan.trips[1].totalMin).toBe(92);
		expect(plan.trips[1].totalL).toBeCloseTo((92 * 25) / 60, 9);
		// The single tankful and every load whose block flies the second trip
		// carry it, and only those: a block starting after it does not.
		expect(plan.totalMin).toBe(plain.totalMin + 10);
		const before = computeRefuelPlan(brienneTrips(), { ...PARAMS, usableFuelL: 100 });
		const after = computeRefuelPlan(trips, { ...PARAMS, usableFuelL: 100 });
		const deltas = after.strategies.map((s, i) =>
			s.loads.map((l, j) => l.minutes - before.strategies[i].loads[j].minutes),
		);
		// Stops [], [0], [1], [0, 1]: the block holding trip 2 is the whole
		// flight, LFQH on, LFPL to LFGP, LFQH alone.
		expect(deltas).toEqual([[10], [0, 10], [10, 0], [0, 10, 0]]);
	});

	it('always counts the final reserve and margin, even with no alternate', () => {
		const plan = computeFuelPlan(
			[{ label: 'A to B', taxiMin: 5, tripMin: 10, procedureMin: 10, windAllowanceMin: 0 }],
			{ consumptionLph: 25, finalReserveMin: 30, pilotMarginMin: 5 },
		);
		expect(plan.trips[0].reserveMin).toBe(35);
		expect(plan.trips[0].totalMin).toBe(60);
	});
});

describe('computeRefuelPlan', () => {
	it('reproduces the Brienne refuelling plan and recommends no refuel', () => {
		const plan = computeRefuelPlan(brienneTrips(), { ...PARAMS, usableFuelL: 100 });
		// Workbook row order: none, first stop, second stop, both.
		expect(plan.strategies.map((s) => s.stops)).toEqual([[], [0], [1], [0, 1]]);
		expect(plan.strategies.map((s) => s.maxLoadMin)).toEqual([231, 150, 166, 150]);
		expect(plan.strategies.map((s) => Math.round(s.maxLoadL))).toEqual([96, 63, 69, 63]);
		// Per-takeoff loads of the single-stop strategies (the workbook's minutes).
		expect(plan.strategies[1].loads.map((l) => l.minutes)).toEqual([150, 147]);
		expect(plan.strategies[2].loads.map((l) => l.minutes)).toEqual([166, 114]);
		expect(plan.strategies.every((s) => s.feasible)).toBe(true);
		expect(plan.recommended!.stops).toEqual([]);
	});

	it('prefers the later stop when single-stop strategies tie', () => {
		const plan = computeRefuelPlan(brienneTrips(), { ...PARAMS, usableFuelL: 70 });
		// No-refuel needs 96.25 L > 70; both single-stop strategies fit.
		expect(plan.strategies[0].feasible).toBe(false);
		expect(plan.recommended!.stops).toEqual([1]);
	});

	it('a load exactly equal to the usable fuel is feasible (the shared tolerance)', () => {
		// 231 min at 25 L/h = 96.25 L: a 96.25 L tank takes the no-refuel
		// strategy whatever floating-point path computed either side.
		const plan = computeRefuelPlan(brienneTrips(), { ...PARAMS, usableFuelL: 96.25 });
		expect(plan.strategies[0].feasible).toBe(true);
		expect(plan.recommended!.stops).toEqual([]);
	});

	it('returns no recommendation when nothing is feasible', () => {
		const plan = computeRefuelPlan(brienneTrips(), { ...PARAMS, usableFuelL: 50 });
		expect(plan.recommended).toBeNull();
	});

	it('handles a single trip (no stopovers)', () => {
		const plan = computeRefuelPlan(brienneTrips().slice(0, 1), { ...PARAMS, usableFuelL: 100 });
		expect(plan.strategies).toHaveLength(1);
		expect(plan.strategies[0].stops).toEqual([]);
		expect(plan.strategies[0].maxLoadMin).toBe(150);
	});
});

describe('tripTimes / fuelTripFromTimes', () => {
	it('computes still-air and wind-corrected minutes', () => {
		const legs = [{ trackTrueDeg: 0, legNM: 60 }];
		const t = tripTimes(legs, 100, 0, 20); // 20 kt headwind: GS 80
		expect(t.stillAirMin).toBeCloseTo(36, 6);
		expect(t.withWindMin).toBeCloseTo(45, 6);
		expect(tripTimes(legs, null, 0, 20).stillAirMin).toBeNull();
		expect(tripTimes(legs, 100, null, null)).toEqual({ stillAirMin: 36, withWindMin: 36 });
	});

	it('rounds at the boundary and never credits a tailwind', () => {
		const head = fuelTripFromTimes(
			'A to B',
			{ stillAirMin: 36, withWindMin: 45 },
			null,
			{ taxiMin: 5 },
		)!;
		expect(head.tripMin).toBe(36);
		expect(head.windAllowanceMin).toBe(9);
		const tail = fuelTripFromTimes('A to B', { stillAirMin: 36, withWindMin: 30 }, null)!;
		expect(tail.windAllowanceMin).toBe(0);
	});

	it('an unsolvable wind contributes no allowance; no cruise speed -> null', () => {
		const legs = [{ trackTrueDeg: 0, legNM: 40 }];
		const t = tripTimes(legs, 40, 0, 50); // headwind above the airspeed
		expect(t.stillAirMin).toBeCloseTo(60, 6);
		expect(t.withWindMin).toBeNull();
		expect(fuelTripFromTimes('A', t, null)!.windAllowanceMin).toBe(0);
		expect(fuelTripFromTimes('A', { stillAirMin: null, withWindMin: null }, null)).toBeNull();
	});

	it('attaches the alternate with its own allowance', () => {
		const t = fuelTripFromTimes(
			'A to B',
			{ stillAirMin: 60, withWindMin: 63.4 },
			{ label: 'LFQB', times: { stillAirMin: 23.6, withWindMin: 25.8 } },
		)!;
		expect(t.windAllowanceMin).toBe(3);
		expect(t.alternate).toEqual({
			label: 'LFQB', timeMin: 24, procedureMin: 10, windAllowanceMin: 2,
		});
		// The default taxi covers both ground movements: 5 min takeoff + 5 landing.
		expect(t.taxiMin).toBe(10);
	});
});

describe('tripTimesLegs (per-leg forecast winds)', () => {
	const legs = [
		{ trackTrueDeg: 0, legNM: 60 },
		{ trackTrueDeg: 0, legNM: 60 },
	];

	it('reproduces tripTimes when every leg shares the global wind', () => {
		const classic = tripTimes(legs, 100, 0, 20);
		const perLeg = tripTimesLegs(legs, 100, [
			{ dirDeg: 0, speedKt: 20 },
			{ dirDeg: 0, speedKt: 20 },
		]);
		expect(perLeg).toEqual(classic);
	});

	it('flies each leg on its own wind, null meaning calm', () => {
		const t = tripTimesLegs(legs, 100, [{ dirDeg: 0, speedKt: 20 }, null]);
		expect(t.stillAirMin).toBeCloseTo(72, 6);
		// 60 NM at GS 80 plus 60 NM at GS 100.
		expect(t.withWindMin).toBeCloseTo(45 + 36, 6);
	});

	it('accepts a per-leg TAS ladder', () => {
		const t = tripTimesLegs(legs, [100, 120], [null, null]);
		expect(t.stillAirMin).toBeCloseTo(36 + 30, 6);
		expect(t.withWindMin).toBeCloseTo(36 + 30, 6);
	});

	it('propagates the unsolvable-wind and no-TAS conventions', () => {
		expect(tripTimesLegs(legs, 40, [{ dirDeg: 0, speedKt: 50 }, null]).withWindMin).toBeNull();
		expect(tripTimesLegs(legs, [100], [null, null])).toEqual({ stillAirMin: null, withWindMin: null });
	});
});

describe('autoFinalReserveMin (AMC1 NCO.OP.125(b))', () => {
	it('gives VFR by day 30 min and everything else 45', () => {
		expect(autoFinalReserveMin(true, false)).toBe(30);
		expect(autoFinalReserveMin(true, true)).toBe(45);
		expect(autoFinalReserveMin(false, false)).toBe(45);
		expect(autoFinalReserveMin(false, true)).toBe(45);
	});
});

describe('blockMinimumMin', () => {
	const rows = computeFuelPlan(brienneTrips(), PARAMS).trips;

	it('is the strategies’ own per-takeoff load', () => {
		// No refuel, then each block of the single-stop strategies (the
		// workbook's minutes, pinned in computeRefuelPlan above).
		expect(blockMinimumMin(rows, 0, 2)).toBe(231);
		expect(blockMinimumMin(rows, 0, 0)).toBe(150);
		expect(blockMinimumMin(rows, 1, 2)).toBe(147);
		expect(blockMinimumMin(rows, 0, 1)).toBe(166);
		expect(blockMinimumMin(rows, 2, 2)).toBe(114);
	});

	it('reads the still-air columns on request', () => {
		// 84 + 64, 84 + 30 + 48, 84 + 30 + 60 + 50.
		expect(blockMinimumMin(rows, 0, 2, 'stillAir')).toBe(224);
	});

	it('an empty range needs nothing', () => {
		expect(blockMinimumMin(rows, 3, 2)).toBe(0);
		expect(blockMinimumMin([], 0, 0)).toBe(0);
	});
});

describe('ceilLitres', () => {
	it('rounds a load up, never down', () => {
		expect(ceilLitres(62.5)).toBe(63);
		expect(ceilLitres(61.25)).toBe(62);
		expect(ceilLitres(96.25)).toBe(97);
	});

	it('keeps an exact litre on floating-point noise', () => {
		expect(ceilLitres(96)).toBe(96);
		expect(ceilLitres(96 + 1e-9)).toBe(96);
		expect(ceilLitres(0)).toBe(0);
	});
});

describe('floorLitres', () => {
	it('rounds a ceiling down, never up', () => {
		expect(floorLitres(69.44)).toBe(69);
		expect(floorLitres(47.75)).toBe(47);
		expect(floorLitres(96.25)).toBe(96);
	});

	it('keeps an exact litre on floating-point noise, and never reads -0', () => {
		expect(floorLitres(69 - 1e-9)).toBe(69);
		expect(floorLitres(69)).toBe(69);
		expect(Object.is(floorLitres(0), 0)).toBe(true);
		expect(Object.is(floorLitres(-1e-9), 0)).toBe(true);
	});
});
