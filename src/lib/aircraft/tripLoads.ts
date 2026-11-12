/* Fuel at each takeoff: the plan as the pilot loads it, trip by trip.
 *
 * A TRIP is one takeoff to one landing (one route; a "leg" is a waypoint
 * segment in this app). The pilot states the fuel at the departure and, at
 * each stop, whether they refuel and to what, and whether the payload
 * changes; everything else is carried over. Per trip this computes the fuel
 * at takeoff and at landing, the reserve that landing must keep, the verdict,
 * and the mass and CG at takeoff, landing and zero fuel.
 *
 * The verdict IS the per-flight rule: a flight commences only with the fuel
 * to its landing plus that trip's reserve (NCO.OP.125(c), ICAO Annex 6 Part
 * II 2.2.3.6.1, 14 CFR 91.151(a)), the final reserve being the floor at every
 * landing (Annex 6 Part II 2.2.4.8 Note 1). Every takeoff, landing and
 * zero-fuel state is weighed: the loading, the mass and the CG comply "during
 * any phase of operation" (NCO.POL.100), "at any time during the flight"
 * (NCO.GEN.105(a)(4)).
 *
 * The landing fuel of a block (the trips between two fuel-set takeoffs) is
 * computed as the strategies compute it, block start minus the cumulative
 * burn-off minutes, against the one tolerance (FUEL_EPS_L), so a block
 * loaded with computeRefuelPlan's own load can never read short here.
 * Pure: no Svelte, no I/O, no catalog; the wording is the caller's. */

import {
	FUEL_EPS_L,
	blockMinimumMin,
	ceilLitres,
	floorLitres,
	type FuelTripRow,
	type RefuelStrategy,
} from './fuel';
import {
	computeMassBalance,
	fuelLimitFault,
	pointInEnvelope,
	stationKeys,
	stationMasses,
	touchdownMassKg,
	zeroFuelPoint,
	type MassBalanceResult,
	type MaxFuel,
	type MbPoint,
} from './massBalance';
import type { AircraftFuel, AircraftMassBalance } from './schema';

/** What the pilot asks for at a takeoff where fuel is set. */
export type FuelTarget =
	| { kind: 'full' }
	| { kind: 'tabs' }
	/** The least fuel for every trip until the next refuel, rounded up. */
	| { kind: 'minimum' }
	/** The most fuel keeping the block within the mass and CG limits. */
	| { kind: 'max' }
	/** A typed figure; null = the empty box, which is the minimum. */
	| { kind: 'custom'; litres: number | null };

/** The stop before a trip: a refuel target (null = none, the fuel carries
 *  over) and the payload changes made there (missing station = carried). */
export interface TripStopInput {
	refuel: FuelTarget | null;
	loads: Readonly<Record<string, number>>;
}

export interface TripLoadsInput {
	/** The fuel plan's rows, one per computable trip (`computeFuelPlan`). An
	 *  empty list is the departure alone: no burn, no verdict. */
	rows: readonly FuelTripRow[];
	consumptionLph: number | null;
	fuel: Pick<AircraftFuel, 'usableL' | 'presets'>;
	/** null: the fuel chain alone, no mass and balance. */
	mb: AircraftMassBalance | null;
	densityKgPerL: number;
	/** The departure: its target (null = no refuel, the flight taking off with
	 *  what is aboard), what the tanks hold before any refuel there (the
	 *  journey log's estimate or a measured quantity, onBoard.ts; absent or
	 *  null = unknown, the target then loaded as stated), and the payload. */
	departure: {
		target: FuelTarget | null;
		aboardL?: number | null | undefined;
		loads: Readonly<Record<string, number>>;
	};
	/** [k] = the stop before trip k ([0] is ignored: the departure). */
	stops: readonly (TripStopInput | null | undefined)[];
	/** [k] = true where the stop before trip k is known to sell no fuel this
	 *  aircraft takes (the AIP or a NOTAM): never offered as a fix. */
	refused?: readonly boolean[] | undefined;
}

export type TargetNote =
	/** The target is above the usable fuel: the usable fuel is loaded. */
	| 'aboveUsable'
	/** A target below what is on board: nothing is drained, what is there stays. */
	| 'noDefuel'
	/** Minimum, and the minimum is already on board. */
	| 'noUpliftNeeded'
	/** The target cannot resolve (no tabs preset, no consumption for a minimum,
	 *  no quantity within limits): the fuel is unknown, never 0 L. */
	| 'unavailable'
	/** No refuel at the departure, and what is aboard is not known: the fuel
	 *  is unknown, never 0 L. */
	| 'aboardUnknown';

/** "Maximum within limits" at a fuel-set takeoff, over its whole block. */
export interface MaxWithinLimits {
	/** Whole litres, at most usable; null when no quantity passes. */
	litres: number | null;
	limitedBy: MaxFuel['limitedBy'];
	/** The trip (chain index) whose limit binds. */
	bindingTrip: number | null;
	zeroFuelOutside: boolean;
	zeroFuelOverMax: boolean;
}

export interface TripMassBalance {
	/** Station masses, index-aligned with mb.stations. */
	payloadKg: number[];
	/** Which of them were typed for this trip (trip 0: the departure loads;
	 *  later trips: a change made at the stop before it). */
	stated: boolean[];
	result: MassBalanceResult;
	/** False when the burn-off is unknown: the landing point is not drawn. */
	landingKnown: boolean;
	/** The mass at touchdown (landing + taxi), what a maximum landing mass
	 *  limits; null when the landing is unknown. */
	touchdownKg: number | null;
	/** Above the sheet's maximum landing mass (false without one). */
	overMaxLanding: boolean;
	/** Above the sheet's maximum zero-fuel mass (false without one). */
	overMaxZeroFuel: boolean;
	/** Every check passed: true; any known check failed: false; else null. */
	withinLimits: boolean | null;
}

export interface TripLoad {
	/** Position in the fuel plan (`rows`). */
	chainIndex: number;
	/** Fuel is set at this takeoff: the departure, or a ticked stop. */
	fuelSet: boolean;
	/** null: no refuel (a stop carrying over, or the departure taking off with
	 *  what is aboard). */
	target: FuelTarget | null;
	/** The fuel-set takeoff this trip's fuel comes from. */
	blockStart: number;
	/** The target resolved, before the clamps (fuel-set takeoffs only). */
	requestedL: number | null;
	/** What the tanks hold before any refuel here: at a stop what the
	 *  previous trip leaves, at the departure what the pilot stated aboard
	 *  (null while unknown). */
	carriedL: number | null;
	/** Fuel at engine start (block fuel); null = unknown. */
	startL: number | null;
	/** Fuel added at this takeoff (fuel set there, both ends known; 0 for the
	 *  departure's no refuel). */
	upliftL: number | null;
	notes: TargetNote[];
	/** At a fuel-set takeoff: the least fuel for every trip until the next
	 *  refuel (unrounded); null without a consumption. */
	blockMinimumL: number | null;
	maxWithinLimits: MaxWithinLimits | null;
	burnL: number | null;
	/** Fuel at engine shutdown (the burn-off includes the taxi in); negative
	 *  when the fuel runs out first. */
	landingL: number | null;
	/** Alternate + its procedure + margin + final reserve, with wind. */
	reserveL: number | null;
	/** The final reserve alone: the in-flight floor (AMC2 NCO.OP.125(b)). */
	finalReserveL: number | null;
	marginL: number | null;
	sufficient: boolean | null;
	/** The trip of this block on which the fuel ran out, when it did. */
	exhaustedOn: number | null;
	/** Fuel endurance at takeoff, minutes (ICAO flight plan item 19 E/). */
	enduranceMin: number | null;
	/** Station masses, index-aligned with mb.stations (empty without a mass
	 *  and balance section), known whatever the fuel: a trip whose fuel is
	 *  unknown still shows its loads and takes changes to them. */
	payloadKg: number[];
	/** Which of them were typed for this trip (as TripMassBalance.stated). */
	stated: boolean[];
	mb: TripMassBalance | null;
}

/** The trip the tanks ran dry on BEFORE this one took off (its chain index),
 *  so this one takes off with none; null when it has fuel at takeoff. One
 *  definition for the fuel cell and the chart that says so. */
export function dryBefore(tr: TripLoad): number | null {
	return tr.exhaustedOn !== null && tr.exhaustedOn < tr.chainIndex ? tr.exhaustedOn : null;
}

/** A single change that cures a short trip, verified by recomputing.
 *  `coversBlock`: every trip until the next refuel then has its fuel; false
 *  when the change cures the trips up to the short one only, a later one
 *  still wanting a refuel (no single change cures more: the block needs more
 *  than the tank, or the limits stop it). */
export type TripFix =
	/** Tick the stop before this trip: at Full tanks (a hand tick's own
	 *  default) where they keep the limits, else at the Minimum, the fuel
	 *  for the rest of the block, else at the Maximum within limits, which
	 *  cures this trip and leaves a later one to a refuel further on (four
	 *  aboard on a chain of hops: a stop at a time). */
	| { kind: 'refuelAt'; chainIndex: number; target: 'full' | 'minimum' | 'max'; coversBlock: boolean }
	/** Load at least `litres` at this fuel-set takeoff (rounded up). */
	| { kind: 'raiseStart'; chainIndex: number; litres: number; coversBlock: boolean };

/** The first short trip of a block, and the fixes that verify. */
export interface ShortTrip {
	chainIndex: number;
	blockStart: number;
	fixes: TripFix[];
}

/** Set this fuel-set takeoff to its Maximum within limits (`litres`, whole,
 *  the figure a button names): every trip of its block then keeps its fuel
 *  and the limits fuel decides, and no trip anywhere loses either, verified
 *  by recomputing the chain. */
export interface LimitFix {
	chainIndex: number;
	litres: number;
}

export interface TripLoadsResult {
	trips: TripLoad[];
	shortTrips: ShortTrip[];
	/** One per fuel-set takeoff whose block a limit the fuel decides breaks
	 *  and its Maximum within limits cures (empty without the fixes). */
	limitFixes: LimitFix[];
	/** Every trip sufficient: true; any short: false; else null. */
	fuelSufficient: boolean | null;
	/** Every trip within limits: true; any out: false; else null. */
	withinLimits: boolean | null;
	heaviestTakeoff: { chainIndex: number; kg: number } | null;
}

/** What computeTripLoads computes beyond the chain itself. */
export interface TripLoadsOptions {
	/** The verified fixes: the short trips' (`shortTrips[].fixes`) and the
	 *  blocks' limit fixes (`limitFixes`). Default true. */
	fixes?: boolean | undefined;
	/** The Maximum within limits at every fuel-set takeoff; false computes it
	 *  only where the target is that Maximum, which needs it. Default true. */
	limits?: boolean | undefined;
}

interface Extras {
	fixes: boolean;
	limits: boolean;
}

/** The fixes' own re-runs: the chain alone. */
const BARE: Extras = { fixes: false, limits: false };

/** The Maximum within limits by block (`start:end`): it reads the block's
 *  payloads, burn-offs and taxi times, the sheet, the density and the usable
 *  fuel, never a target, so the simulations of one input can share it. */
type MaxCache = Map<string, MaxWithinLimits | null>;

/** Why a trip breaks a limit the fuel at its block's start decides: its
 *  takeoff above the envelope's maximum mass or outside the envelope, its
 *  landing outside it, its touchdown above the maximum landing mass. Never
 *  the zero-fuel point or a station's maximum, which no fuel changes. */
export interface TripLimitFault {
	why: 'massMax' | 'cg' | 'landingMass';
	phase: 'takeoff' | 'landing';
	/** The state's mass (the touchdown mass for a landing-mass fault). */
	massKg: number;
	armM: number;
	/** The mass limit crossed: the envelope's top, or the maximum landing
	 *  mass; null for a CG out of the envelope. */
	limitKg: number | null;
}

/** Trip `tr`'s fuel-dependent fault, the checks massBalance.ts
 *  fuelLimitFault makes, in its order, read off the trip's own weighing. */
export function tripLimitFault(tr: TripLoad, mb: AircraftMassBalance): TripLimitFault | null {
	const m = tr.mb;
	if (!m) {
		return null;
	}
	const r = m.result;
	const topKg = Math.max(...mb.envelope.map((p) => p.massKg));
	if (r.takeoff.massKg > topKg + 1e-9) {
		return { why: 'massMax', phase: 'takeoff', massKg: r.takeoff.massKg, armM: r.takeoff.armM, limitKg: topKg };
	}
	if (!r.takeoffInside) {
		return { why: 'cg', phase: 'takeoff', massKg: r.takeoff.massKg, armM: r.takeoff.armM, limitKg: null };
	}
	if (m.landingKnown && !r.landingInside) {
		return { why: 'cg', phase: 'landing', massKg: r.landing.massKg, armM: r.landing.armM, limitKg: null };
	}
	if (m.overMaxLanding && m.touchdownKg !== null && mb.maxLandingMassKg != null) {
		return {
			why: 'landingMass',
			phase: 'landing',
			massKg: m.touchdownKg,
			armM: r.landing.armM,
			limitKg: mb.maxLandingMassKg,
		};
	}
	return null;
}

/** The fuel target a stored mode states (the state and the file share the
 *  departure's vocabulary). The departure's no refuel is its own flag
 *  (flightPrep mb.refuel), never a mode. */
export function fuelTargetOf(
	mode: 'full' | 'minimum' | 'tabs' | 'max' | 'custom',
	litres: number | null,
): FuelTarget {
	return mode === 'custom' ? { kind: 'custom', litres } : { kind: mode };
}

/** Fold three-valued verdicts: any false wins, then any unknown. */
function fold(values: readonly (boolean | null)[]): boolean | null {
	if (values.some((v) => v === false)) {
		return false;
	}
	return values.some((v) => v === null) ? null : true;
}

export function computeTripLoads(input: TripLoadsInput, options: TripLoadsOptions = {}): TripLoadsResult {
	return compute(input, { fixes: options.fixes ?? true, limits: options.limits ?? true }, null);
}

/** `input` with fuel-set takeoff `b` aimed at `target` (the departure's, or
 *  stop b's refuel, its payload changes kept). */
function withTarget(input: TripLoadsInput, b: number, target: FuelTarget): TripLoadsInput {
	return b === 0
		? { ...input, departure: { ...input.departure, target } }
		: {
				...input,
				stops: input.stops.map((st, k) => (k === b ? { refuel: target, loads: st?.loads ?? {} } : st)),
			};
}

function compute(input: TripLoadsInput, extras: Extras, cache: MaxCache | null): TripLoadsResult {
	const { rows, fuel, mb, densityKgPerL: density } = input;
	const usable = fuel.usableL;
	// What the departure's tanks hold before any refuel there, held to the
	// tanks: onBoard.ts refuses a typed figure above them, and a figure above
	// would let the usable clamp below set the start under what is aboard.
	const statedAboard = input.departure.aboardL;
	const departureAboardL =
		statedAboard != null && Number.isFinite(statedAboard) ? Math.min(usable, Math.max(0, statedAboard)) : null;
	const lpm = input.consumptionLph != null && input.consumptionLph > 0 ? input.consumptionLph / 60 : null;
	// The departure alone when no trip computes: its fuel and mass, no burn.
	const n = Math.max(1, rows.length);
	const keys = mb ? stationKeys(mb) : [];

	// Payloads, trip by trip: the departure's loads, then each stop's changes
	// over what was carried.
	const payloads: number[][] = [];
	const stated: boolean[][] = [];
	for (let k = 0; k < n; k++) {
		if (!mb) {
			payloads.push([]);
			stated.push([]);
			continue;
		}
		if (k === 0) {
			payloads.push(stationMasses(mb, input.departure.loads));
			stated.push(keys.map((key) => input.departure.loads[key] != null));
			continue;
		}
		const changes = input.stops[k]?.loads ?? {};
		payloads.push(keys.map((key, j) => changes[key] ?? payloads[k - 1][j]));
		stated.push(keys.map((key) => changes[key] != null));
	}

	const fuelSet = Array.from({ length: n }, (_, k) => k === 0 || input.stops[k]?.refuel != null);
	const targets: (FuelTarget | null)[] = Array.from({ length: n }, (_, k) =>
		k === 0 ? input.departure.target : (input.stops[k]?.refuel ?? null),
	);
	const blockEnd = (k: number): number => {
		let e = k;
		while (e + 1 < n && !fuelSet[e + 1]) {
			e++;
		}
		return e;
	};
	const burnL = (k: number): number | null => (lpm != null && rows[k] ? rows[k].burnOffMin * lpm : null);
	/** What trip k's landing point counts as burnt but its touchdown may
	 *  still carry: the taxi allowance (burnt after it) and the contingency
	 *  (perhaps never used), added back for the maximum landing mass
	 *  (massBalance.ts touchdownMassKg), which then does not depend on the
	 *  contingency while the landing point assumes it burnt. */
	const addBackL = (k: number): number | null =>
		lpm != null && rows[k] ? (rows[k].taxiMin + rows[k].contingencyMin) * lpm : null;

	/** "Maximum within limits" at fuel-set k: the largest start fuel, in whole
	 *  litres (the exact usable when that fits), with every trip of the block
	 *  within its limits, each judged with what the start leaves it (the start
	 *  less the burn-off before it, payload changes at unticked stops
	 *  included). Scanned on the START rather than composed from each trip's
	 *  own maximum: those are whole litres already, and a later trip's maximum
	 *  plus a fractional burn floored again read a litre short. A trip past an
	 *  unknown burn-off is not judged. */
	const maxWithin = (k: number): MaxWithinLimits | null => {
		if (!mb) {
			return null;
		}
		const end = blockEnd(k);
		const zfs: MbPoint[] = [];
		const before: number[] = [];
		let zeroFuelOutside = false;
		let zeroFuelOverMax = false;
		let acc: number | null = 0;
		for (let j = k; j <= end && acc !== null; j++) {
			const zf = zeroFuelPoint(mb, payloads[j]);
			zfs.push(zf);
			before.push(acc);
			zeroFuelOutside ||= !pointInEnvelope(mb.envelope, zf.armM, zf.massKg);
			zeroFuelOverMax ||= mb.maxZeroFuelMassKg != null && zf.massKg > mb.maxZeroFuelMassKg + 1e-9;
			const b = burnL(j);
			acc = b === null ? null : acc + b;
		}
		/** The first trip of the block a start of `startL` puts out of limits. */
		const fault = (startL: number): { why: MaxFuel['limitedBy']; trip: number } | null => {
			for (let i = 0; i < zfs.length; i++) {
				const why = fuelLimitFault(mb, zfs[i], density, Math.max(0, startL - before[i]), burnL(k + i), addBackL(k + i));
				if (why !== null) {
					return { why, trip: k + i };
				}
			}
			return null;
		};
		let blocked = fault(usable);
		if (blocked === null) {
			return { litres: usable, limitedBy: 'usable', bindingTrip: null, zeroFuelOutside, zeroFuelOverMax };
		}
		for (let l = Math.floor(usable - FUEL_EPS_L); l >= 0; l--) {
			const f = fault(l);
			if (f === null) {
				return { litres: l, limitedBy: blocked.why, bindingTrip: blocked.trip, zeroFuelOutside, zeroFuelOverMax };
			}
			blocked = f;
		}
		return { litres: null, limitedBy: null, bindingTrip: blocked.trip, zeroFuelOutside, zeroFuelOverMax };
	};
	/** maxWithin(k), through the simulations' shared cache when there is one. */
	const maxAt = (k: number): MaxWithinLimits | null => {
		if (!cache) {
			return maxWithin(k);
		}
		const key = `${k}:${blockEnd(k)}`;
		if (!cache.has(key)) {
			cache.set(key, maxWithin(k));
		}
		return cache.get(key) ?? null;
	};

	const trips: TripLoad[] = [];
	let blockStart = 0;
	let blockStartL: number | null = null;
	let cumBurnMin = 0; // within the block, trips before the current one
	let exhaustedOn: number | null = null;
	for (let k = 0; k < n; k++) {
		const row = rows[k] ?? null;
		const prev = k > 0 ? trips[k - 1] : null;
		const carriedL =
			prev == null ? departureAboardL : prev.landingL == null ? null : Math.max(0, prev.landingL);
		const notes: TargetNote[] = [];
		let requestedL: number | null = null;
		let startL: number | null;
		let upliftL: number | null = null;
		let blockMinimumL: number | null = null;
		let maxLimits: MaxWithinLimits | null = null;
		if (fuelSet[k]) {
			const end = blockEnd(k);
			blockMinimumL = lpm != null && rows.length > 0 ? blockMinimumMin(rows, k, end) * lpm : null;
			// Read by the pages on the main pass and by the strategies' checks,
			// and by a Maximum target; the fixes' re-runs ask it only for the
			// latter.
			maxLimits = extras.limits || targets[k]?.kind === 'max' ? maxAt(k) : null;
			const minimumL = blockMinimumL == null ? null : Math.min(ceilLitres(blockMinimumL), usable);
			// Fuel-set and no target: the departure's no refuel, taking off
			// with what is aboard.
			const target = targets[k];
			if (target === null) {
				requestedL = carriedL;
			} else {
				switch (target.kind) {
					case 'full':
						requestedL = usable;
						break;
					case 'tabs':
						requestedL = fuel.presets.find((p) => p.name === 'tabs')?.litres ?? null;
						break;
					case 'minimum':
						requestedL = minimumL;
						break;
					case 'max':
						requestedL = maxLimits?.litres ?? null;
						break;
					case 'custom':
						requestedL = target.litres ?? minimumL;
						break;
				}
			}
			if (requestedL === null) {
				notes.push(target === null ? 'aboardUnknown' : 'unavailable');
				startL = null;
			} else {
				let loaded = requestedL;
				if (loaded > usable + FUEL_EPS_L) {
					notes.push('aboveUsable');
					loaded = usable;
				}
				if (target !== null && carriedL !== null && loaded < carriedL - FUEL_EPS_L) {
					// Nothing is drained: what is on board stays.
					notes.push(target.kind === 'minimum' || (target.kind === 'custom' && target.litres === null) ? 'noUpliftNeeded' : 'noDefuel');
					loaded = carriedL;
				}
				startL = loaded;
				if (carriedL !== null) {
					upliftL = Math.max(0, loaded - carriedL);
				}
			}
			blockStart = k;
			blockStartL = startL;
			cumBurnMin = 0;
			exhaustedOn = null;
		} else {
			startL = carriedL;
		}

		// Landing as the strategies compute it: block start minus the block's
		// cumulative burn-off minutes, the one expression both read.
		let landingL: number | null = null;
		let burn: number | null = null;
		if (row && lpm != null && startL !== null) {
			burn = row.burnOffMin * lpm;
			landingL =
				exhaustedOn === null && blockStartL !== null
					? blockStartL - (cumBurnMin + row.burnOffMin) * lpm
					: startL - burn;
		} else if (row && lpm != null) {
			burn = row.burnOffMin * lpm;
		}
		if (row) {
			cumBurnMin += row.burnOffMin;
		}
		if (landingL !== null && landingL < -FUEL_EPS_L && exhaustedOn === null) {
			exhaustedOn = k;
		}
		const reserveL = row && lpm != null ? row.reserveWithWindMin * lpm : null;
		const finalReserveL = row && lpm != null ? row.finalReserveMin * lpm : null;
		const marginL = landingL !== null && reserveL !== null ? landingL - reserveL : null;
		const sufficient = marginL === null ? null : marginL >= -FUEL_EPS_L;

		let tripMb: TripMassBalance | null = null;
		if (mb && startL !== null) {
			const landingKnown = burn !== null;
			const fuelL = Math.max(0, startL);
			const result = computeMassBalance({
				mb,
				stationMassesKg: payloads[k],
				fuelL,
				burnL: landingKnown ? Math.min(fuelL, burn!) : 0,
				densityKgPerL: density,
			});
			const zfKg = zeroFuelPoint(mb, payloads[k]).massKg;
			const touchdownKg = landingKnown ? touchdownMassKg(zfKg, fuelL, burn!, addBackL(k), density) : null;
			const overMaxLanding =
				mb.maxLandingMassKg != null && touchdownKg !== null && touchdownKg > mb.maxLandingMassKg + 1e-9;
			const overMaxZeroFuel = mb.maxZeroFuelMassKg != null && zfKg > mb.maxZeroFuelMassKg + 1e-9;
			tripMb = {
				payloadKg: payloads[k],
				stated: stated[k],
				result,
				landingKnown,
				touchdownKg,
				overMaxLanding,
				overMaxZeroFuel,
				withinLimits: fold([
					result.takeoffInside,
					landingKnown ? result.landingInside : null,
					result.zeroFuelInside,
					result.stationsWithinMax,
					!overMaxLanding,
					!overMaxZeroFuel,
				]),
			};
		}

		trips.push({
			chainIndex: k,
			fuelSet: fuelSet[k],
			target: targets[k],
			blockStart,
			requestedL: fuelSet[k] ? requestedL : null,
			carriedL,
			startL,
			upliftL,
			notes,
			blockMinimumL,
			maxWithinLimits: maxLimits,
			burnL: burn,
			landingL,
			reserveL,
			finalReserveL,
			marginL,
			sufficient: rows.length === 0 ? null : sufficient,
			exhaustedOn,
			enduranceMin:
				startL !== null && input.consumptionLph != null && input.consumptionLph > 0
					? (Math.max(0, startL) / input.consumptionLph) * 60
					: null,
			payloadKg: payloads[k],
			stated: stated[k],
			mb: tripMb,
		});
	}

	// The first short trip of each block, and the single changes that cure
	// it without putting a trip out of limits that was not, verified by
	// recomputing the whole chain: one curing every trip until the next
	// refuel where one does, else one curing the trips up to the short one.
	const shortTrips: ShortTrip[] = [];
	const firstShort = new Map<number, number>();
	for (const tr of trips) {
		if (tr.sufficient === false && !firstShort.has(tr.blockStart)) {
			firstShort.set(tr.blockStart, tr.chainIndex);
		}
	}
	for (const [b, j] of firstShort) {
		const fixes: TripFix[] = [];
		if (extras.fixes && lpm !== null) {
			const end = blockEnd(b);
			/** Trips b..upto sufficient in `r`, and no trip out of limits that
			 *  was not. */
			const cures = (r: TripLoadsResult, upto: number): boolean => {
				for (let k = b; k <= upto; k++) {
					if (r.trips[k].sufficient !== true) {
						return false;
					}
				}
				return r.trips.every((tr, k) => trips[k].mb?.withinLimits !== true || tr.mb?.withinLimits !== false);
			};
			for (let s = b + 1; s <= j; s++) {
				if (input.refused?.[s]) {
					continue;
				}
				// Full tanks first; where they break a limit (four aboard), the
				// Minimum may still cure the trip within them, and where the
				// rest of the block needs more than the limits allow, the most
				// they allow may still cure this trip. Without that last one a
				// plan curable a stop at a time read "no single change cures
				// it: reduce the payload".
				for (const target of ['full', 'minimum', 'max'] as const) {
					const stops = [...input.stops];
					stops[s] = { refuel: { kind: target }, loads: input.stops[s]?.loads ?? {} };
					const r = compute({ ...input, stops }, BARE, null);
					if (cures(r, j)) {
						fixes.push({ kind: 'refuelAt', chainIndex: s, target, coversBlock: cures(r, end) });
						break;
					}
				}
			}
			const raised = (litres: number): TripLoadsResult =>
				compute(withTarget(input, b, { kind: 'custom', litres }), BARE, null);
			// The whole block's minimum first, then the trips up to the short one.
			const wholeL = ceilLitres(blockMinimumMin(rows, b, end) * lpm);
			const throughL = ceilLitres(blockMinimumMin(rows, b, j) * lpm);
			if (wholeL <= usable + FUEL_EPS_L && cures(raised(wholeL), end)) {
				fixes.push({ kind: 'raiseStart', chainIndex: b, litres: wholeL, coversBlock: true });
			} else if (throughL < wholeL && throughL <= usable + FUEL_EPS_L && cures(raised(throughL), j)) {
				fixes.push({ kind: 'raiseStart', chainIndex: b, litres: throughL, coversBlock: false });
			}
		}
		shortTrips.push({ chainIndex: j, blockStart: b, fixes });
	}

	// The blocks a limit the fuel decides breaks, and whose Maximum within
	// limits cures them, verified like the fixes above: offered only where
	// that Maximum still carries the block's fuel (an empty window wants the
	// payload reduced or a refuel further on, which the fuel lines say), every
	// trip of the block then keeping its fuel and those limits, and no trip
	// anywhere losing either. Lowering a start can short a later block (a
	// stop's custom figure below what it would then carry), which raising
	// one never could: hence the second rule.
	const limitFixes: LimitFix[] = [];
	if (extras.fixes && mb && lpm !== null) {
		for (let b = 0; b < n; b++) {
			if (!fuelSet[b] || targets[b]?.kind === 'max') {
				continue;
			}
			const end = blockEnd(b);
			let faulted = false;
			for (let k = b; k <= end && !faulted; k++) {
				faulted = tripLimitFault(trips[k], mb) !== null;
			}
			const mx = faulted ? (trips[b].maxWithinLimits ?? maxAt(b)) : null;
			const need = trips[b].blockMinimumL;
			if (!mx || mx.litres === null || need === null || ceilLitres(need) > mx.litres + FUEL_EPS_L) {
				continue;
			}
			const r = compute(withTarget(input, b, { kind: 'max' }), BARE, null);
			let ok = true;
			for (let k = b; k <= end && ok; k++) {
				ok = r.trips[k].sufficient === true && tripLimitFault(r.trips[k], mb) === null;
			}
			ok &&= r.trips.every(
				(tr, k) =>
					(trips[k].mb?.withinLimits !== true || tr.mb?.withinLimits !== false) &&
					(trips[k].sufficient !== true || tr.sufficient !== false),
			);
			if (ok) {
				limitFixes.push({ chainIndex: b, litres: floorLitres(mx.litres) });
			}
		}
	}

	let heaviestTakeoff: TripLoadsResult['heaviestTakeoff'] = null;
	for (const tr of trips) {
		const kg = tr.mb?.result.takeoff.massKg;
		if (kg != null && (heaviestTakeoff === null || kg > heaviestTakeoff.kg)) {
			heaviestTakeoff = { chainIndex: tr.chainIndex, kg };
		}
	}
	return {
		trips,
		shortTrips,
		limitFixes,
		fuelSufficient: rows.length === 0 ? null : fold(trips.map((tr) => tr.sufficient)),
		withinLimits: mb ? fold(trips.map((tr) => tr.mb?.withinLimits ?? null)) : null,
		heaviestTakeoff,
	};
}

export type TakeoffWindowState =
	/** Both ends known, the start can sit between them. */
	| 'open'
	/** What is aboard already covers the need: nothing to add (at a stop,
	 *  what arrives; at the departure, what the pilot stated aboard). */
	| 'noUpliftNeeded'
	/** No consumption: the need is unknown, the ceiling alone is. */
	| 'needUnknown'
	/** The block needs more than the limits (or the tanks) allow: a payload
	 *  to reduce or a refuel further on, no quantity here. */
	| 'empty'
	/** What is aboard is already above the limits, and nothing is drained
	 *  (at a stop, what arrives; at the departure, what was stated aboard,
	 *  which only a defuel or a lighter load cures). */
	| 'aboveMaxOnArrival'
	/** No quantity at all keeps the limits: the payload's problem. */
	| 'noneWithin';

/** A fuel-set takeoff's window: the fuel to take off with, from the least its
 *  block needs to the most the limits allow, and wherever what is aboard is
 *  known (a stop, or a departure whose tanks were stated) the uplift that
 *  implies over it. One definition for the fuel page's rows and refuelling
 *  list, each trip sheet's fuel line and the Overview. */
export interface TakeoffWindow {
	chainIndex: number;
	state: TakeoffWindowState;
	/** The block minimum rounded up (a load), not capped at the tanks; null
	 *  without a consumption. */
	neededL: number | null;
	/** The Maximum within limits rounded down; the usable fuel without a mass
	 *  and balance section (`limitsChecked` false); null when no quantity
	 *  keeps the limits. Both ends read unrounded where rounding them would
	 *  cross a window narrower than a litre. */
	maxL: number | null;
	limitedBy: MaxWithinLimits['limitedBy'];
	bindingTrip: number | null;
	limitsChecked: boolean;
	/** The block needs more than the tanks hold: only a refuel further on
	 *  helps. */
	beyondTank: boolean;
	/** What is aboard before any refuel here; null at a departure whose tanks
	 *  were not stated. */
	carriedL: number | null;
	/** The uplift the window implies over what is aboard: at least `lo`
	 *  (rounded up), at most `hi` (rounded down), in whole litres where they do
	 *  not cross; null while what is aboard is unknown. */
	uplift: { lo: number; hi: number } | null;
	/** The plan's own uplift in whole litres, rounded the safe way for its
	 *  target: a Minimum (or an empty Custom) up, a Maximum down, any other to
	 *  the nearest, kept inside the window when the start is; null while what
	 *  is aboard is unknown. */
	planUpliftL: number | null;
}

/** Trip `tr`'s window, null where its fuel is carried over. Expects `tr` from
 *  a computation with the limits on (the default): there, a null
 *  maxWithinLimits means no mass and balance section. Decided on the
 *  unrounded figures, worded on the rounded ones. */
export function takeoffWindow(tr: TripLoad, usableL: number): TakeoffWindow | null {
	if (!tr.fuelSet) {
		return null;
	}
	const mx = tr.maxWithinLimits;
	const limitsChecked = mx !== null;
	const rawNeed = tr.blockMinimumL;
	const rawMax = mx ? mx.litres : usableL;
	const carried = tr.carriedL;
	let state: TakeoffWindowState;
	if (rawMax === null) {
		state = 'noneWithin';
	} else if (rawNeed !== null && rawNeed > rawMax + FUEL_EPS_L) {
		state = 'empty';
	} else if (carried !== null && carried > rawMax + FUEL_EPS_L) {
		state = 'aboveMaxOnArrival';
	} else if (rawNeed === null) {
		state = 'needUnknown';
	} else if (carried !== null && carried >= rawNeed - FUEL_EPS_L) {
		state = 'noUpliftNeeded';
	} else {
		state = 'open';
	}
	let neededL = rawNeed === null ? null : ceilLitres(rawNeed);
	let maxL = rawMax === null ? null : floorLitres(rawMax);
	if (state !== 'empty' && rawNeed !== null && rawMax !== null && neededL! > maxL!) {
		// A window narrower than a litre: whole litres would cross it.
		neededL = rawNeed;
		maxL = rawMax;
	}
	let uplift: TakeoffWindow['uplift'] = null;
	if (
		carried !== null &&
		neededL !== null &&
		maxL !== null &&
		rawNeed !== null &&
		rawMax !== null &&
		(state === 'open' || state === 'noUpliftNeeded')
	) {
		let lo = Math.max(0, ceilLitres(neededL - carried));
		let hi = Math.max(0, floorLitres(maxL - carried));
		if (lo > hi) {
			lo = Math.max(0, rawNeed - carried);
			hi = Math.max(0, rawMax - carried);
		}
		uplift = { lo, hi };
	}
	let planUpliftL: number | null = null;
	if (tr.upliftL !== null) {
		const t = tr.target;
		const up = tr.upliftL;
		let v =
			t?.kind === 'minimum' || (t?.kind === 'custom' && t.litres === null)
				? ceilLitres(up)
				: t?.kind === 'max'
					? floorLitres(up)
					: Math.round(up);
		const inside =
			tr.startL !== null &&
			rawNeed !== null &&
			rawMax !== null &&
			tr.startL >= rawNeed - FUEL_EPS_L &&
			tr.startL <= rawMax + FUEL_EPS_L;
		if (uplift && inside) {
			v = Math.min(Math.max(v, uplift.lo), uplift.hi);
		}
		planUpliftL = v;
	}
	return {
		chainIndex: tr.chainIndex,
		state,
		neededL,
		maxL,
		limitedBy: mx?.limitedBy ?? null,
		bindingTrip: mx?.bindingTrip ?? null,
		limitsChecked,
		beyondTank: rawNeed !== null && rawNeed > usableL + FUEL_EPS_L,
		carriedL: carried,
		uplift,
		planUpliftL,
	};
}

/** One takeoff of a refuelling strategy as flown: its fuel at takeoff and,
 *  wherever what is aboard is known, the uplift over it. */
export interface StrategyTakeoff {
	chainIndex: number;
	startL: number | null;
	upliftL: number | null;
}

/** The first trip a strategy puts out of the limits the fuel decides. */
export interface StrategyFault extends TripLimitFault {
	trip: number;
	/** The fuel-set takeoff that trip's fuel comes from. */
	blockStart: number;
	/** That takeoff's fuel: the strategy's own load, or what is aboard when
	 *  that is more (nothing is drained). */
	startL: number;
	/** The most that takeoff can take within the limits, rounded down. */
	maxWithinL: number;
}

/** A refuelling strategy flown through the chain: computeRefuelPlan's loads
 *  are fuel alone, so this is where its takeoffs meet the mass and the CG. */
export interface StrategyCheck {
	loads: TripLoadsResult;
	/** Aligned with the strategy's `loads`: the departure, then each stop. */
	takeoffs: StrategyTakeoff[];
	/** true within every limit the fuel decides; false at the first out
	 *  (`fault`); null without a mass and balance section, with a trip's fuel
	 *  unknown, or when a limit no fuel cures fails (`payloadOut`). */
	withinLimits: boolean | null;
	fault: StrategyFault | null;
	/** A trip out of a limit no quantity at its block's start brings back:
	 *  the payload's problem, which no strategy decides between. */
	payloadOut: boolean;
}

/** Each strategy flown at its own loads (computeRefuelPlan: the departure
 *  and every stop it names at the Minimum, the others carrying over), the
 *  pilot's payload changes kept at every stop, ticked or not. The blocks'
 *  Maximum within limits is shared between the simulations (MaxCache). */
export function checkStrategies(
	input: TripLoadsInput,
	strategies: readonly Pick<RefuelStrategy, 'stops'>[],
): StrategyCheck[] {
	const cache: MaxCache = new Map();
	const n = Math.max(1, input.rows.length);
	const minimum: FuelTarget = { kind: 'minimum' };
	return strategies.map((s) => {
		const stops = Array.from({ length: n }, (_, k) =>
			k === 0 ? null : { refuel: s.stops.includes(k - 1) ? minimum : null, loads: input.stops[k]?.loads ?? {} },
		);
		const r = compute(
			{ ...input, departure: { ...input.departure, target: minimum }, stops },
			{ fixes: false, limits: true },
			cache,
		);
		const takeoffs = r.trips
			.filter((tr) => tr.fuelSet)
			.map((tr) => ({ chainIndex: tr.chainIndex, startL: tr.startL, upliftL: tr.upliftL }));
		const mb = input.mb;
		if (!mb) {
			return { loads: r, takeoffs, withinLimits: null, fault: null, payloadOut: false };
		}
		let fault: StrategyFault | null = null;
		let payloadOut = false;
		let unknown = false;
		for (const tr of r.trips) {
			if (!tr.mb) {
				unknown = true;
				continue;
			}
			const f = tripLimitFault(tr, mb);
			if (!f) {
				continue;
			}
			const start = r.trips[tr.blockStart];
			const mx = start.maxWithinLimits?.litres ?? null;
			if (mx === null) {
				payloadOut = true;
				continue;
			}
			fault ??= {
				...f,
				trip: tr.chainIndex,
				blockStart: tr.blockStart,
				startL: start.startL ?? 0,
				maxWithinL: floorLitres(mx),
			};
		}
		return {
			loads: r,
			takeoffs,
			withinLimits: fault ? false : unknown || payloadOut ? null : true,
			fault,
			payloadOut,
		};
	});
}

/** "Use this plan" for strategy `stops`: the target each takeoff then flies,
 *  by chain index (null = no refuel). Each stop the strategy names keeps the
 *  target it already has, or the Minimum when it was not refuelled (the
 *  strategy's own row); the departure keeps the pilot's, a no refuel there
 *  taking the Minimum (the strategy's own load, which adds nothing when what
 *  is aboard covers it). Any of those whose
 *  block then breaks a limit the fuel decides takes its Maximum within limits
 *  instead, which a strategy within those limits at its Minimum always leaves
 *  room for. Decided in flight order, the chain recomputed after each change:
 *  a block's start holds what arrives when its target asks for less (nothing
 *  is drained), so a lighter departure can be what clears a later stop. */
export function strategyTargets(input: TripLoadsInput, stops: readonly number[]): (FuelTarget | null)[] {
	const n = Math.max(1, input.rows.length);
	const targets: (FuelTarget | null)[] = Array.from({ length: n }, (_, k) =>
		k === 0
			? (input.departure.target ?? { kind: 'minimum' })
			: stops.includes(k - 1)
				? (input.stops[k]?.refuel ?? { kind: 'minimum' })
				: null,
	);
	const mb = input.mb;
	if (!mb) {
		return targets;
	}
	const flown = (): TripLoadsResult =>
		compute(
			{
				...input,
				departure: { ...input.departure, target: targets[0]! },
				stops: Array.from({ length: n }, (_, k) =>
					k === 0 ? null : { refuel: targets[k], loads: input.stops[k]?.loads ?? {} },
				),
			},
			BARE,
			null,
		);
	let r = flown();
	for (let b = 0; b < n; b++) {
		const tb = targets[b];
		if (tb === null || tb.kind === 'max') {
			continue;
		}
		let end = b;
		while (end + 1 < n && targets[end + 1] === null) {
			end++;
		}
		for (let k = b; k <= end; k++) {
			if (r.trips[k] && tripLimitFault(r.trips[k], mb) !== null) {
				targets[b] = { kind: 'max' };
				r = flown();
				break;
			}
		}
	}
	return targets;
}
