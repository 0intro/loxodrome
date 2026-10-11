/* What the mass & balance page says under its tables
 * (src/lib/components/flightprep/mbLines.ts), decided apart from its words:
 * on the Brienne rows (LFPL -> LFQH -> LFGP -> LFPL, 25 L/h) and the
 * committed sheets. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAircraftYaml } from '$lib/aircraft/schema';
import { computeFuelPlan } from '$lib/aircraft/fuel';
import { computeTripLoads, type TripLoadsInput } from '$lib/aircraft/tripLoads';
import {
	dependsOnRefused,
	fuelLines,
	tripMassLines,
	type FuelLine,
	type MassLine,
	type MbLinesInput,
} from '../src/lib/components/flightprep/mbLines';

const load = (f: string) =>
	parseAircraftYaml(readFileSync(new URL(`../public/data/aircraft/${f}`, import.meta.url), 'utf-8'));
const gorq = load('f-gorq.yaml');
const girv = load('f-girv.yaml');

const rows = computeFuelPlan(
	[
		{ label: 'LFPL to LFQH', taxiMin: 5, tripMin: 69, procedureMin: 10, windAllowanceMin: 0, alternate: { label: 'LFQB', timeMin: 24, procedureMin: 10, windAllowanceMin: 2 } },
		{ label: 'LFQH to LFGP', taxiMin: 0, tripMin: 20, procedureMin: 10, windAllowanceMin: 3, alternate: { label: 'LFLA', timeMin: 8, procedureMin: 10, windAllowanceMin: 1 } },
		{ label: 'LFGP to LFPL', taxiMin: 5, tripMin: 45, procedureMin: 10, windAllowanceMin: 4, alternate: { label: 'LFPK', timeMin: 10, procedureMin: 10, windAllowanceMin: 0 } },
	],
	{ consumptionLph: 25, finalReserveMin: 30, pilotMarginMin: 0 },
).trips;

const served = { serves: true, access: 'h24' as const };

function lines(over: Partial<TripLoadsInput>, extra: Partial<MbLinesInput> = {}): MbLinesInput {
	const input: TripLoadsInput = {
		rows,
		consumptionLph: 25,
		fuel: gorq.fuel!,
		mb: gorq.massBalance!,
		densityKgPerL: 0.72,
		departure: { target: { kind: 'full' }, loads: { 'Front seats': 160, 'Rear seats': 0, Baggage: 10 } },
		stops: [],
		...over,
	};
	return {
		loads: computeTripLoads(input),
		mb: input.mb,
		consumptionKnown: input.consumptionLph != null,
		points: [served, served, served],
		avgas: true,
		usableL: input.fuel.usableL,
		...extra,
	};
}

const kinds = (out: FuelLine[]) => out.map((l) => l.kind);
const windowOf = (out: FuelLine[], trip: number) =>
	out.find((l): l is Extract<FuelLine, { kind: 'window' }> => l.kind === 'window' && l.trip === trip)!.window;

describe('fuelLines', () => {
	it('a sufficient plan with no stop refuelled: the departure\'s window alone', () => {
		const out = fuelLines(lines({}));
		expect(kinds(out)).toEqual(['window']);
		expect(windowOf(out, 0)).toMatchObject({ state: 'open', neededL: 97, maxL: 100, limitsChecked: true, carriedL: null });
	});

	it('the short trip, its landing and reserve, and its verified fixes', () => {
		const out = fuelLines(lines({ departure: { target: { kind: 'custom', litres: 63 }, loads: {} } }));
		expect(kinds(out)).toEqual(['window', 'short']);
		const short = out[1] as Extract<FuelLine, { kind: 'short' }>;
		expect(short).toMatchObject({ kind: 'short', trip: 1, dry: false });
		expect(short.landingL).toBeCloseTo(14.25, 9);
		expect(short.reserveL).toBeCloseTo(20.4167, 3);
		expect(short.fixes).toEqual([
			{ kind: 'refuelAt', chainIndex: 1, target: 'full', coversBlock: true },
			{ kind: 'raiseStart', chainIndex: 0, litres: 97, coversBlock: true },
		]);
	});

	it('a dry trip says so', () => {
		const out = fuelLines(lines({ departure: { target: { kind: 'custom', litres: 20 }, loads: {} } }));
		expect(out.find((l) => l.kind === 'short')).toMatchObject({ kind: 'short', trip: 0, dry: true });
	});

	it('a refuel at a stop: each takeoff\'s window, the uplift for the refueller, NCO.OP.145 once', () => {
		const input = lines(
			{ departure: { target: { kind: 'minimum' }, loads: {} }, stops: [null, { refuel: { kind: 'full' }, loads: {} }] },
			{ points: [served, { serves: true, access: 'onRequest' }, served] },
		);
		const out = fuelLines(input);
		expect(kinds(out)).toEqual(['window', 'window', 'avgasPassengers']);
		const w1 = windowOf(out, 1);
		expect(w1).toMatchObject({ state: 'open', neededL: 62, maxL: 100, uplift: { lo: 34, hi: 72 }, planUpliftL: 72 });
		expect(w1.carriedL).toBeCloseTo(28, 9);
		expect(out[1]).toMatchObject({ access: 'onRequest' });
		// The departure's access reads h24: no caution to append.
		expect(out[0]).toMatchObject({ access: null });
		// A grade NCO.OP.145 does not name (a Jet A-1 diesel) has no such line.
		expect(kinds(fuelLines({ ...input, avgas: false }))).toEqual(['window', 'window']);
	});

	it('a refuelled stop the AIP refuses: said, and the trips it fuels never read green', () => {
		const input = lines(
			{ departure: { target: { kind: 'minimum' }, loads: {} }, stops: [null, { refuel: { kind: 'full' }, loads: {} }] },
			{ points: [served, { serves: false, access: null }, served] },
		);
		expect(kinds(fuelLines(input))).toEqual(['window', 'window', 'refusedTick', 'avgasPassengers']);
		expect(dependsOnRefused(input)).toEqual([false, true, true]);
	});

	it('the target notes, at their takeoff; nothing to add is the window\'s own state', () => {
		const input = lines({
			departure: { target: { kind: 'custom', litres: 120 }, loads: {} },
			stops: [null, { refuel: { kind: 'custom', litres: 40 }, loads: {} }, { refuel: { kind: 'minimum' }, loads: {} }],
		});
		const out = fuelLines(input);
		expect(out.map((l) => [l.kind, 'trip' in l ? l.trip : null])).toEqual([
			['window', 0],
			['aboveUsable', 0],
			['window', 1],
			['noDefuel', 1],
			['window', 2],
		]);
		expect(windowOf(out, 2).state).toBe('noUpliftNeeded');
		// F-GORQ states no tabs: unknown, never 0 L.
		const tabs = lines({ departure: { target: { kind: 'tabs' }, loads: {} } });
		expect(kinds(fuelLines(tabs))).toEqual(['window', 'unavailable']);
	});

	it('a block the limits leave no fuel for: said, no window', () => {
		// 280 kg aboard, refuelling at LFGP only: LFPL must carry 70 L, 69 L
		// is the most it can take.
		const heavy = { 'Front seats': 160, 'Rear seats': 100, Baggage: 20 };
		const out = fuelLines(
			lines({
				departure: { target: { kind: 'minimum' }, loads: heavy },
				stops: [null, null, { refuel: { kind: 'minimum' }, loads: {} }],
			}),
		);
		expect(out[0]).toEqual({
			kind: 'emptyWindow',
			trip: 0,
			neededL: 70,
			maxL: 69,
			limitedBy: 'massMax',
			bindingTrip: 0,
			beyondTank: false,
		});
		expect(windowOf(out, 2)).toMatchObject({ uplift: { lo: 27, hi: 47 }, planUpliftL: 27 });
	});

	it('no consumption: said first', () => {
		expect(fuelLines(lines({ consumptionLph: null }))[0]).toEqual({ kind: 'noConsumption' });
	});
});

/* The departure's fuel on board as read (aircraft/onBoard.ts): said first
 * where something was read, the fuel at takeoff unknown under a no refuel
 * nobody stated, more aboard than the limits allow a warning in place of the
 * window, and the departure's pump judged only where it uplifts. */
describe('fuelLines: the departure\'s fuel on board', () => {
	const TWO = { 'Front seats': 160, 'Rear seats': 0, Baggage: 10 };
	const HEAVY = { 'Front seats': 160, 'Rear seats': 100, Baggage: 20 };
	const estimate = (litres: number) => ({
		reading: { kind: 'estimate' as const, litres, anchorL: 100, flownMin: 85, flights: 2, addedL: 0, burntL: 35.4, lph: 25, overflowL: 0 },
		readOn: '2026-10-06',
		flightDate: '2026-10-06',
		stale: false,
	});

	it('a reading is said first, nothing without one', () => {
		const over = {
			departure: { target: { kind: 'minimum' as const }, aboardL: 64.6, loads: TWO },
			stops: [null, { refuel: { kind: 'full' as const }, loads: {} }],
		};
		const out = fuelLines(lines(over, { onBoard: estimate(64.6) }));
		expect(kinds(out)).toEqual(['onBoard', 'window', 'window', 'avgasPassengers']);
		expect(out[0]).toMatchObject({ kind: 'onBoard', trip: 0, readOn: '2026-10-06', stale: false });
		expect(windowOf(out, 0)).toMatchObject({ state: 'noUpliftNeeded', carriedL: 64.6, planUpliftL: 0 });
		expect(kinds(fuelLines(lines(over)))).toEqual(['window', 'window', 'avgasPassengers']);
		const nothing = { reading: { kind: 'unknown' as const }, readOn: '2026-10-06', flightDate: '2026-10-06', stale: false };
		expect(kinds(fuelLines(lines(over, { onBoard: nothing })))).not.toContain('onBoard');
	});

	it('no refuel over nothing read: the fuel at takeoff unknown, said', () => {
		const out = fuelLines(lines({ departure: { target: null, loads: TWO } }));
		expect(kinds(out)).toEqual(['window', 'aboardUnknown']);
		expect(out[1]).toEqual({ kind: 'aboardUnknown', trip: 0 });
		expect(windowOf(out, 0)).toMatchObject({ carriedL: null, planUpliftL: null });
	});

	it('more aboard than the limits allow: a warning in place of the window, nothing drained said once', () => {
		const out = fuelLines(
			lines({
				departure: { target: { kind: 'max' }, aboardL: 80, loads: HEAVY },
				stops: [null, { refuel: { kind: 'minimum' }, loads: {} }],
			}),
		);
		expect(kinds(out)).toEqual(['aboveMaxAboard', 'window', 'avgasPassengers']);
		expect(out[0]).toEqual({ kind: 'aboveMaxAboard', trip: 0, aboardL: 80, maxL: 69 });
		expect(windowOf(out, 1)).toMatchObject({ chainIndex: 1, state: 'open' });
	});

	it('the departure\'s pump judged only where it uplifts over a reading', () => {
		const dry = { points: [{ serves: false, access: null }, served, served] };
		// Nothing read: the uplift is unknown, as before the journey log.
		const unread = lines({ departure: { target: { kind: 'full' }, loads: TWO } }, dry);
		expect(kinds(fuelLines(unread))).toEqual(['window']);
		expect(dependsOnRefused(unread)).toEqual([false, false, false]);
		// 40 L aboard, full tanks: 60 L uplifted where the AIP says none is.
		const fills = lines({ departure: { target: { kind: 'full' }, aboardL: 40, loads: TWO } }, dry);
		expect(kinds(fuelLines(fills))).toEqual(['window', 'refusedTick', 'avgasPassengers']);
		expect(dependsOnRefused(fills)).toEqual([true, true, true]);
		// No refuel over full tanks: nothing uplifted, nothing to say.
		const leaves = lines({ departure: { target: null, aboardL: 100, loads: TWO } }, dry);
		expect(kinds(fuelLines(leaves))).toEqual(['window']);
		expect(dependsOnRefused(leaves)).toEqual([false, false, false]);
	});
});

describe('tripMassLines: each trip\'s own, under its own chart', () => {
	const all = (input: MbLinesInput) => input.loads.trips.map((tr) => tripMassLines(input, tr.chainIndex));

	it('F-GIRV, four adults, tabs at LFQH: above the maximum there, with the block\'s maximum', () => {
		const input = lines({
			consumptionLph: 40,
			fuel: girv.fuel!,
			mb: girv.massBalance!,
			departure: { target: { kind: 'max' }, loads: { 'Front seats': 160, 'Rear seats': 150, Baggage: 20 } },
			stops: [null, { refuel: { kind: 'tabs' }, loads: {} }],
		});
		const [one, two, three] = all(input);
		expect(one).toEqual([]);
		expect(three).toEqual([]);
		expect(two).toHaveLength(1);
		expect(two[0]).toMatchObject({ kind: 'aboveMax', trip: 1, maxKg: 1157, at: 1, maxWithinL: 109, fix: { at: 1, litres: 109 } });
		expect((two[0] as Extract<MassLine, { kind: 'aboveMax' }>).massKg).toBeCloseTo(1170.66, 2);
	});

	it('a CG out at takeoff and at landing: said under each trip, the repeated state on both charts', () => {
		// F-GORQ, a light pilot and two adults behind: 33 L reaches the aft limit.
		const input = lines({ departure: { target: { kind: 'full' }, loads: { 'Front seats': 70, 'Rear seats': 150, Baggage: 20 } } });
		const out = all(input);
		const kinds = out.map((l) => l.map((x) => [x.kind, x.trip, 'phase' in x ? x.phase : null]));
		// Each trip's own lines only, its own number on each.
		for (const [k, l] of out.entries()) {
			expect(l.every((x) => x.trip === k)).toBe(true);
		}
		expect(kinds[0][0]).toEqual(['cgOut', 0, 'takeoff']);
		expect(kinds[1][0]).toEqual(['cgOut', 1, 'takeoff']);
		expect(kinds[2][0]).toEqual(['cgOut', 2, 'takeoff']);
		// Trip 1's landing is trip 2's takeoff (nothing changes at LFQH): said
		// under trip 1's chart, which draws it, as well as under trip 2's.
		expect(kinds[0]).toContainEqual(['cgOut', 0, 'landing']);
		const landing1 = out[0].find((x) => x.kind === 'cgOut' && x.phase === 'landing') as Extract<MassLine, { kind: 'cgOut' }>;
		const takeoff2 = out[1].find((x) => x.kind === 'cgOut' && x.phase === 'takeoff') as Extract<MassLine, { kind: 'cgOut' }>;
		expect(landing1.massKg).toBeCloseTo(takeoff2.massKg, 9);
		expect(landing1.armM).toBeCloseTo(takeoff2.armM, 9);
	});

	it('the zero fuel and an overloaded station: under every trip carrying them', () => {
		const input = lines({ departure: { target: { kind: 'full' }, loads: { 'Front seats': 70, 'Rear seats': 160, Baggage: 45 } } });
		for (const [k, l] of all(input).entries()) {
			const zf = l.filter((x) => x.kind === 'zeroFuelOut');
			expect(zf).toHaveLength(1);
			expect(zf[0]).toMatchObject({ kind: 'zeroFuelOut', trip: k });
			expect(l.filter((x) => x.kind === 'station')).toEqual([
				{ kind: 'station', trip: k, key: 'Baggage', label: 'Baggage', massKg: 45, maxKg: 40 },
			]);
		}
	});

	it('the sheet\'s landing and zero-fuel limits', () => {
		const hpcp = load('f-hpcp.yaml');
		const input = lines({
			rows: rows.slice(0, 1),
			consumptionLph: 60,
			fuel: hpcp.fuel!,
			mb: { ...hpcp.massBalance!, maxLandingMassKg: 1470, maxZeroFuelMassKg: 1400 },
			departure: { target: { kind: 'custom', litres: 140 }, loads: { 'Front seats': 180, 'Rear seats': 160, Baggage: 30 } },
		});
		const out = tripMassLines(input, 0);
		expect(out.map((l) => l.kind)).toEqual(['touchdownOver', 'zeroFuelOver']);
		const td = out[0] as Extract<MassLine, { kind: 'touchdownOver' }>;
		const zf = out[1] as Extract<MassLine, { kind: 'zeroFuelOver' }>;
		expect(td).toMatchObject({ trip: 0, maxKg: 1470 });
		expect(td.touchdownKg).toBeCloseTo(1484.92, 2);
		expect(zf).toMatchObject({ trip: 0, maxKg: 1400 });
		expect(zf.massKg).toBeCloseTo(1441, 6);
	});

	it('nothing without a mass and balance section, nor for a trip that is not there', () => {
		expect(tripMassLines(lines({ mb: null }), 0)).toEqual([]);
		expect(tripMassLines(lines({}), 7)).toEqual([]);
	});

	it('the fuel change that cures, on every line of the block it cures', () => {
		// F-GORQ, 280 kg aboard, Minimum out of LFPL, full tanks at LFQH: 922
		// kg there, a landing at LFGP out of the envelope (912.1 kg) and the
		// same 912.1 kg out of LFGP, all cured by 69 L at LFQH.
		const input = lines({
			departure: { target: { kind: 'minimum' }, loads: { 'Front seats': 160, 'Rear seats': 100, Baggage: 20 } },
			stops: [null, { refuel: { kind: 'full' }, loads: {} }],
		});
		const [one, two, three] = all(input);
		const fix = { at: 1, litres: 69 };
		expect(one).toEqual([]);
		expect(two).toEqual([
			expect.objectContaining({ kind: 'aboveMax', trip: 1, fix }),
			expect.objectContaining({ kind: 'cgOut', trip: 1, phase: 'landing', fix }),
		]);
		expect(three).toEqual([expect.objectContaining({ kind: 'aboveMax', trip: 2, at: 1, fix })]);
	});

	it('no fix where no fuel cures (a CG the payload puts out), and the key absent', () => {
		const input = lines({ departure: { target: { kind: 'full' }, loads: { 'Front seats': 70, 'Rear seats': 150, Baggage: 20 } } });
		for (const l of all(input).flat()) {
			expect('fix' in l).toBe(l.kind !== 'zeroFuelOut' && l.kind !== 'station' && input.loads.limitFixes.length > 0);
		}
	});
});
