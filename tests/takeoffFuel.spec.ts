/* The fuel at each takeoff, read and written (components/flightprep/
 * takeoffFuel.ts): the departure's no refuel is its own flag beside its
 * target, as a stop's tick is, and "Use this plan" turns it into the
 * strategy's Minimum (which adds nothing when what is aboard covers it), or
 * the Maximum within limits where the Minimum breaks one. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeFuelPlan, computeRefuelPlan, type FuelPlanParams, type FuelTripInput } from '$lib/aircraft/fuel';
import { parseAircraftYaml } from '$lib/aircraft/schema';
import { fuelTargetOf, type FuelTarget, type TripLoadsInput } from '$lib/aircraft/tripLoads';
import { applyLoadedFlightPrep, flightPrep, setMb, stopInputs } from '$lib/state/flightPrep.svelte';
import type { TripLoadsComputation } from '$lib/components/flightprep/shared';
import {
	applyStrategy,
	setTakeoffLitres,
	setTakeoffTarget,
	takeoffLitres,
	takeoffMode,
} from '$lib/components/flightprep/takeoffFuel';

const gorq = parseAircraftYaml(
	readFileSync(new URL('../public/data/aircraft/f-gorq.yaml', import.meta.url), 'utf-8'),
);
const PARAMS: FuelPlanParams = { consumptionLph: 25, finalReserveMin: 30, pilotMarginMin: 0 };

/** The workbook's Brienne navigation, LFPL -> LFQH -> LFGP -> LFPL. */
const TRIPS: FuelTripInput[] = [
	{
		label: 'LFPL to LFQH', toLabel: 'LFQH', taxiMin: 5, tripMin: 69, procedureMin: 10, windAllowanceMin: 0,
		alternate: { label: 'LFQB', timeMin: 24, procedureMin: 10, windAllowanceMin: 2 },
	},
	{
		label: 'LFQH to LFGP', toLabel: 'LFGP', taxiMin: 0, tripMin: 20, procedureMin: 10, windAllowanceMin: 3,
		alternate: { label: 'LFLA', timeMin: 8, procedureMin: 10, windAllowanceMin: 1 },
	},
	{
		label: 'LFGP to LFPL', toLabel: 'LFPL', taxiMin: 5, tripMin: 45, procedureMin: 10, windAllowanceMin: 4,
		alternate: { label: 'LFPK', timeMin: 10, procedureMin: 10, windAllowanceMin: 0 },
	},
];
const TWO_ABOARD = { 'Front seats': 160, 'Rear seats': 0, Baggage: 10 };
const HEAVY = { 'Front seats': 160, 'Rear seats': 100, Baggage: 20 };
const plan100 = computeRefuelPlan(TRIPS, { ...PARAMS, usableFuelL: 100 });
const byStops = (stops: number[]) => plan100.strategies.find((s) => s.stops.join() === stops.join())!;

/** What the pages hand these functions, as far as they read it: the stops'
 *  keys and the trip loads' input, the departure as the state now says. */
function comp(loads: Record<string, number>, aboardL: number | null): TripLoadsComputation {
	const target: FuelTarget | null = flightPrep.mb.refuel
		? fuelTargetOf(flightPrep.mb.fuelMode, flightPrep.mb.customLitres)
		: null;
	const input: TripLoadsInput = {
		rows: computeFuelPlan(TRIPS, PARAMS).trips,
		consumptionLph: 25,
		fuel: gorq.fuel!,
		mb: gorq.massBalance!,
		densityKgPerL: 0.72,
		departure: { target, aboardL, loads },
		stops: [null, null, null],
	};
	return { stopKeys: [null, 'LFQH', 'LFGP'], input } as unknown as TripLoadsComputation;
}

let writes: string[];

beforeEach(() => {
	applyLoadedFlightPrep(undefined, []);
	writes = [];
	vi.stubGlobal('localStorage', {
		getItem: () => null,
		setItem: (key: string) => writes.push(key),
		removeItem: () => {},
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the departure: a target, or no refuel', () => {
	it('no refuel keeps the target for its return, each a single write', () => {
		const c = comp(TWO_ABOARD, 64);
		expect(takeoffMode(c, 0)).toBe('full');
		setTakeoffTarget(c, 0, 'custom');
		setTakeoffLitres(c, 0, 60);
		writes = [];
		setTakeoffTarget(c, 0, 'none');
		expect(writes).toEqual(['loxodrome:flight-prep']);
		expect(takeoffMode(c, 0)).toBe('none');
		expect(flightPrep.mb).toMatchObject({ refuel: false, fuelMode: 'custom', customLitres: 60 });
		expect(takeoffLitres(c, 0)).toBe(60);
		writes = [];
		setTakeoffTarget(c, 0, 'minimum');
		expect(writes).toEqual(['loxodrome:flight-prep']);
		expect(flightPrep.mb).toMatchObject({ refuel: true, fuelMode: 'minimum' });
		expect(takeoffMode(c, 0)).toBe('minimum');
	});

	it('a stop keeps its own tick', () => {
		const c = comp(TWO_ABOARD, null);
		setTakeoffTarget(c, 1, 'max');
		expect(stopInputs('LFQH')).toMatchObject({ refuel: true, mode: 'max' });
		expect(takeoffMode(c, 1)).toBe('max');
		setTakeoffTarget(c, 1, 'none');
		expect(takeoffMode(c, 1)).toBe('none');
		expect(flightPrep.mb.refuel).toBe(true);
	});
});

describe('"Use this plan" over a no refuel at the departure', () => {
	it('takes the Minimum, which what is aboard may already cover', () => {
		setMb({ refuel: false });
		applyStrategy(comp(TWO_ABOARD, 70), byStops([0]));
		expect(flightPrep.mb).toMatchObject({ refuel: true, fuelMode: 'minimum' });
		expect(stopInputs('LFQH')).toMatchObject({ refuel: true, mode: 'minimum' });
		expect(stopInputs('LFGP').refuel).toBe(false);
	});

	it('or the Maximum within limits where the Minimum breaks one', () => {
		// No refuel anywhere: 97 L out of LFPL with 280 kg aboard, over 900 kg.
		setMb({ refuel: false });
		applyStrategy(comp(HEAVY, null), byStops([]));
		expect(flightPrep.mb).toMatchObject({ refuel: true, fuelMode: 'max' });
	});

	it('leaves a departure with a target as the pilot set it', () => {
		setMb({ fuelMode: 'full' });
		applyStrategy(comp(TWO_ABOARD, 70), byStops([0]));
		expect(flightPrep.mb).toMatchObject({ refuel: true, fuelMode: 'full' });
	});
});
