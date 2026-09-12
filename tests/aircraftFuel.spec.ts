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
		// Grand totals (single tankful): the workbook's B26 / B27 minutes.
		expect(plan.totalStillAirMin).toBe(238);
		expect(plan.totalMin).toBe(247);
		expect(plan.totalL).toBeCloseTo(102.9167, 3); // displays 103 L
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
		expect(plan.heaviestFeasibleLoadL).toBeCloseTo(96.25, 6);
	});

	it('prefers the later stop when single-stop strategies tie', () => {
		const plan = computeRefuelPlan(brienneTrips(), { ...PARAMS, usableFuelL: 70 });
		// No-refuel needs 96.25 L > 70; both single-stop strategies fit.
		expect(plan.strategies[0].feasible).toBe(false);
		expect(plan.recommended!.stops).toEqual([1]);
	});

	it('returns no recommendation when nothing is feasible', () => {
		const plan = computeRefuelPlan(brienneTrips(), { ...PARAMS, usableFuelL: 50 });
		expect(plan.recommended).toBeNull();
		expect(plan.heaviestFeasibleLoadL).toBeNull();
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
