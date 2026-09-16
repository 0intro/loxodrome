/* The refuelling plan as the AERODROMES leave it
 * (flightprep/shared.ts: strategyIsServed, servedRecommendation).
 *
 * computeRefuelPlan recommends on fuel quantities alone, being pure and
 * workbook-pinned, so it will name a stopover that this same page marks as
 * having no fuel for this aeroplane. These pin the second answer: the same
 * rule asked again over the strategies that can actually be flown, with the
 * arithmetic one kept and explained rather than hidden.
 *
 * The trips are the Brienne workbook's (LFPL -> LFQH -> LFGP -> LFPL), which
 * tests/aircraftFuel.spec.ts pins the arithmetic of; the uplift points are
 * built by hand, since whether an aerodrome sells a grade is exactly what the
 * arithmetic knows nothing about. */

import { describe, it, expect } from 'vitest';
import {
	computeRefuelPlan,
	pickRefuelStrategy,
	type FuelPlanParams,
	type FuelTripInput,
	type RefuelPlan,
} from '$lib/aircraft/fuel';
import {
	servedRecommendation,
	strategyIsServed,
	type RefuelPoint,
} from '$lib/components/flightprep/shared';

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

/** The three uplift points, in the plan's own column order: the departure
 *  LFPL, then the landings the loads are embarked at, LFQH and LFGP. */
const IDENTS = ['LFPL', 'LFQH', 'LFGP'];
function points(serves: (boolean | null)[]): RefuelPoint<string>[] {
	return IDENTS.map((ident, i) => ({
		ident,
		serves: serves[i] ?? null,
		refusal: serves[i] === false ? ({ kind: 'aipNone' } as const) : null,
	}));
}

/** 70 L usable: the no-refuel strategy needs 96.25 L and does not fit, so
 *  both single-stop strategies are feasible and the workbook's tie rule picks
 *  the LATER one, stop 1 = refuel at LFGP (aircraftFuel.spec.ts pins this). */
const plan: RefuelPlan = computeRefuelPlan(brienneTrips(), { ...PARAMS, usableFuelL: 70 });

describe('pickRefuelStrategy', () => {
	it('is the rule computeRefuelPlan itself uses', () => {
		expect(plan.recommended!.stops).toEqual([1]);
		expect(pickRefuelStrategy(plan.strategies.filter((s) => s.feasible))).toBe(plan.recommended);
	});

	it('prefers the later stop on a tie, and answers nothing for nothing', () => {
		const single = plan.strategies.filter((s) => s.stops.length === 1);
		expect(single.map((s) => s.stops)).toEqual([[0], [1]]);
		expect(pickRefuelStrategy(single)!.stops).toEqual([1]);
		expect(pickRefuelStrategy([])).toBeNull();
	});
});

describe('strategyIsServed', () => {
	const byStops = (stops: number[]) =>
		plan.strategies.find((s) => s.stops.join() === stops.join())!;

	it('reads a strategy through the uplift points its loads land on', () => {
		// Refuelling at LFGP embarks at LFPL and at LFGP, and never at LFQH.
		const noQH = points([true, false, true]);
		expect(strategyIsServed(byStops([1]), noQH)).toBe(true);
		expect(strategyIsServed(byStops([0]), noQH)).toBe(false);
		expect(strategyIsServed(byStops([0, 1]), noQH)).toBe(false);
		// Every strategy embarks at the departure, so a dry departure blocks
		// all of them.
		const noDep = points([false, true, true]);
		expect(plan.strategies.every((s) => !strategyIsServed(s, noDep))).toBe(true);
	});

	it('lets the unknown pass', () => {
		// The AIP said nothing readable. That is not evidence against a plan,
		// and it is the rule every other fuel surface follows.
		expect(strategyIsServed(byStops([0, 1]), points([null, null, null]))).toBe(true);
		expect(strategyIsServed(byStops([0, 1]), points([true, null, true]))).toBe(true);
	});
});

describe('servedRecommendation', () => {
	it('says nothing extra when the arithmetic answer can be flown', () => {
		const r = servedRecommendation(plan, points([true, true, true]));
		expect(r.best).toBe(plan.recommended);
		expect(r.demoted).toBeNull();
		expect(r.demotedAt).toBeNull();
		expect(r.noneServed).toBe(false);
	});

	it('names the one that can be flown, and why the other lost its place', () => {
		// LFGP has no fuel, so "refuel at LFGP" is not a plan however few
		// refuels it needs; "refuel at LFQH" is.
		const r = servedRecommendation(plan, points([true, true, false]));
		expect(r.demoted!.stops).toEqual([1]);
		expect(r.demotedAt?.ident).toBe('LFGP');
		expect(r.best!.stops).toEqual([0]);
		expect(r.noneServed).toBe(false);
	});

	it('says so when the tank is fine and the aerodromes are not', () => {
		// Nowhere to uplift at all: a different answer from "no feasible
		// strategy", and a different decision.
		const r = servedRecommendation(plan, points([false, false, false]));
		expect(r.best).toBeNull();
		expect(r.noneServed).toBe(true);
		expect(r.demoted).toBe(plan.recommended);
		// The point that blocks a strategy is often NOT the stop its label
		// names: every strategy embarks at the departure, so "refuel at LFGP"
		// is blocked by a dry LFPL. The page's wording depends on this, which
		// is why its joiner reads "but" and not "where".
		expect(r.demoted!.stops).toEqual([1]);
		expect(r.demotedAt?.ident).toBe('LFPL');
	});

	it('is silent without a plan or without a feasible one', () => {
		const empty = { best: null, demoted: null, demotedAt: null, noneServed: false };
		expect(servedRecommendation(null, points([false, false, false]))).toEqual(empty);
		const tooSmall = computeRefuelPlan(brienneTrips(), { ...PARAMS, usableFuelL: 50 });
		expect(tooSmall.recommended).toBeNull();
		expect(servedRecommendation(tooSmall, points([false, false, false]))).toEqual(empty);
	});

	it('leaves the plan exactly as it was with no fuel data at all', () => {
		// Every point unknown, which is what an aeroplane stating no grades
		// and an aerodrome outside France both produce.
		const r = servedRecommendation(plan, points([null, null, null]));
		expect(r.best).toBe(plan.recommended);
		expect(r.demoted).toBeNull();
	});
});
