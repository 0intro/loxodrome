/* What the fuel plan and the mass & balance pages say under their tables, as
 * data: the fuel lines (a short trip and the changes that cure it, a target
 * the tank or the pump cannot meet, each fuel-set takeoff's window and its
 * uplift for the refueller, the departure's fuel on board as read) and each
 * trip's mass lines, said under that
 * trip's own chart (a state out of the envelope, a mass above a limit, a
 * station overloaded), with the fuel change that cures it where one does.
 * Pure and locale-free: the pages word each line, so the decision of WHAT to
 * say is pinned apart from how (tests/mbLines.spec.ts). */

import {
	takeoffWindow,
	type FuelTarget,
	type MaxWithinLimits,
	type TakeoffWindow,
	type TripFix,
	type TripLoadsResult,
} from '$lib/aircraft/tripLoads';
import type { AircraftMassBalance } from '$lib/aircraft/schema';
import type { OnBoard } from '$lib/aircraft/onBoard';
import type { FuelAccess } from '$lib/data/fuel';

/** What a takeoff point can uplift (shared.ts refuelPoints), as read here. */
export interface UpliftPoint {
	serves: boolean | null;
	access: FuelAccess | null;
}

export interface MbLinesInput {
	loads: TripLoadsResult;
	/** null: the fuel lines alone (a sheet without mass and balance). */
	mb: AircraftMassBalance | null;
	consumptionKnown: boolean;
	/** [k] = the takeoff point of chain trip k (the departure, then each stop). */
	points: readonly UpliftPoint[];
	/** The tanked grade is an AVGAS (NCO.OP.145 forbids refuelling it with
	 *  passengers embarking, on board or disembarking). */
	avgas: boolean;
	/** The usable fuel: a window's ceiling without a mass and balance
	 *  section. */
	usableL: number;
	/** The departure's fuel on board as read (aircraft/onBoard.ts): absent,
	 *  or a reading of nothing, says nothing. */
	onBoard?: OnBoardLineInput | undefined;
}

/** The departure's reading, what its line says. */
export interface OnBoardLineInput {
	reading: OnBoard;
	/** The UTC day it was read, and the flight's ('YYYY-MM-DD'). */
	readOn: string;
	flightDate: string;
	/** Read on another day than the flight's. */
	stale: boolean;
}

export type FuelLine =
	/** No consumption: the fuel cannot be judged. */
	| { kind: 'noConsumption' }
	/** The first short trip of a block (chain index), and its verified fixes. */
	| { kind: 'short'; trip: number; landingL: number; reserveL: number; dry: boolean; fixes: TripFix[] }
	/** A fuel-set takeoff whose target cannot resolve (the reason is the
	 *  target's kind: no tabs on the sheet, no consumption, nothing within
	 *  the limits). */
	| { kind: 'unavailable'; trip: number; target: FuelTarget['kind'] }
	/** A target above the tank: the usable fuel is loaded. */
	| { kind: 'aboveUsable'; trip: number; requestedL: number }
	/** A target below what is on board: nothing is drained. */
	| { kind: 'noDefuel'; trip: number; carriedL: number; requestedL: number }
	/** A takeoff refuelled where the AIP or a NOTAM says the fuel is not
	 *  there (the departure only where it uplifts over what is on board). */
	| { kind: 'refusedTick'; trip: number }
	/** The departure's fuel on board as read: what it gives and where from,
	 *  or why it gives nothing. */
	| ({ kind: 'onBoard'; trip: number } & OnBoardLineInput)
	/** No refuel at the departure, over fuel on board nobody stated: the fuel
	 *  at takeoff is unknown. */
	| { kind: 'aboardUnknown'; trip: number }
	/** More already on board at the departure than the limits allow there:
	 *  nothing is drained, so only a defuel or a lighter load cures it. Said
	 *  in place of its window line. */
	| { kind: 'aboveMaxAboard'; trip: number; aboardL: number; maxL: number }
	/** NCO.OP.145, once, when a stop is refuelled with AVGAS. */
	| { kind: 'avgasPassengers' }
	/** A fuel-set takeoff's window (the departure included): the fuel to take
	 *  off with and, at a stop, the uplift for the refueller, with what the
	 *  AIP wants arranged there. */
	| { kind: 'window'; trip: number; window: TakeoffWindow; access: FuelAccess | null }
	/** A fuel-set takeoff whose block needs more than the limits allow (or
	 *  than the tanks hold: `beyondTank`, the tanks' wording only where they
	 *  are the ceiling, `limitedBy` 'usable' or no limits): no quantity there
	 *  flies it, only a lighter payload or a refuel further on. */
	| {
			kind: 'emptyWindow';
			trip: number;
			neededL: number;
			maxL: number;
			limitedBy: MaxWithinLimits['limitedBy'];
			bindingTrip: number | null;
			beyondTank: boolean;
	  };

/** The fuel change curing a mass line: fuel-set takeoff `at` set to its
 *  Maximum within limits, `litres` (tripLoads.ts limitFixes, verified). */
export interface MassFix {
	at: number;
	litres: number;
}

export type MassLine =
	/** A takeoff above the envelope's maximum mass, and the most fuel its
	 *  block can take at `at` (the fuel-set takeoff it starts from). */
	| {
			kind: 'aboveMax';
			trip: number;
			massKg: number;
			maxKg: number;
			at: number;
			maxWithinL: number | null;
			fix?: MassFix | undefined;
	  }
	/** A takeoff or landing inside the mass limit but outside the envelope. */
	| {
			kind: 'cgOut';
			trip: number;
			phase: 'takeoff' | 'landing';
			armM: number;
			massKg: number;
			fix?: MassFix | undefined;
	  }
	/** The zero-fuel point out of the envelope: no fuel changes it. */
	| { kind: 'zeroFuelOut'; trip: number; armM: number }
	/** Above the sheet's maximum landing mass, at touchdown. */
	| { kind: 'touchdownOver'; trip: number; touchdownKg: number; maxKg: number; fix?: MassFix | undefined }
	/** Above the sheet's maximum zero-fuel mass. */
	| { kind: 'zeroFuelOver'; trip: number; massKg: number; maxKg: number }
	/** A station above its published maximum. */
	| { kind: 'station'; trip: number; key: string; label: string; massKg: number; maxKg: number };

/** Trips whose fuel came from an uplift at a takeoff the AIP or a NOTAM says
 *  cannot serve the aeroplane: their "sufficient" is not to be shown green.
 *  The departure's uplift is known only over a reading of its tanks. */
export function dependsOnRefused(input: Pick<MbLinesInput, 'loads' | 'points'>): boolean[] {
	const { trips } = input.loads;
	return trips.map((tr) => {
		const b = tr.blockStart;
		return input.points[b]?.serves === false && (trips[b].upliftL ?? 0) > 0;
	});
}

export function fuelLines(input: MbLinesInput): FuelLine[] {
	const { trips, shortTrips } = input.loads;
	const out: FuelLine[] = [];
	if (!input.consumptionKnown) {
		out.push({ kind: 'noConsumption' });
	}
	const shortAt = new Map(shortTrips.map((s) => [s.chainIndex, s]));
	for (const tr of trips) {
		const k = tr.chainIndex;
		if (k === 0 && input.onBoard && input.onBoard.reading.kind !== 'unknown') {
			out.push({ kind: 'onBoard', trip: 0, ...input.onBoard });
		}
		if (tr.fuelSet) {
			const w = takeoffWindow(tr, input.usableL);
			// At the departure, what is on board already above the limits is
			// a warning to act on, not a window to fill (at a stop the window
			// line says it, nothing being drained there either).
			const aboveAboard =
				k === 0 && w?.state === 'aboveMaxOnArrival' && w.carriedL !== null && w.maxL !== null
					? { aboardL: w.carriedL, maxL: w.maxL }
					: null;
			if (aboveAboard) {
				out.push({ kind: 'aboveMaxAboard', trip: k, ...aboveAboard });
			} else if (w?.state === 'empty' && w.neededL !== null && w.maxL !== null) {
				out.push({
					kind: 'emptyWindow',
					trip: k,
					neededL: w.neededL,
					maxL: w.maxL,
					limitedBy: w.limitedBy,
					bindingTrip: w.bindingTrip,
					beyondTank: w.beyondTank,
				});
			} else if (w && w.state !== 'noneWithin' && (w.state !== 'needUnknown' || w.limitsChecked)) {
				// No quantity keeps the limits: the mass lines say so. The need
				// unknown and no limits either: nothing to say a window with.
				const access = input.points[k]?.access ?? null;
				out.push({ kind: 'window', trip: k, window: w, access: access === 'h24' ? null : access });
			}
			for (const note of tr.notes) {
				if (note === 'unavailable' && tr.target) {
					out.push({ kind: 'unavailable', trip: k, target: tr.target.kind });
				} else if (note === 'aboardUnknown') {
					out.push({ kind: 'aboardUnknown', trip: k });
				} else if (note === 'aboveUsable' && tr.requestedL !== null) {
					out.push({ kind: 'aboveUsable', trip: k, requestedL: tr.requestedL });
				} else if (note === 'noDefuel' && !aboveAboard && tr.carriedL !== null && tr.requestedL !== null) {
					out.push({ kind: 'noDefuel', trip: k, carriedL: tr.carriedL, requestedL: tr.requestedL });
				}
				// 'noUpliftNeeded' is the window's own state, said on its line.
			}
			if (input.points[k]?.serves === false && (k > 0 || (tr.upliftL ?? 0) > 0)) {
				out.push({ kind: 'refusedTick', trip: k });
			}
		}
		const short = shortAt.get(k);
		if (short && tr.landingL !== null && tr.reserveL !== null) {
			out.push({
				kind: 'short',
				trip: k,
				landingL: tr.landingL,
				reserveL: tr.reserveL,
				dry: tr.landingL < 0,
				fixes: short.fixes,
			});
		}
	}
	// The departure counts where its uplift is known (over a reading of its
	// tanks): a stop's always is.
	const refuelled = trips.filter((tr) => tr.fuelSet);
	if (input.avgas && refuelled.some((tr) => (tr.upliftL ?? 0) > 0)) {
		out.push({ kind: 'avgasPassengers' });
	}
	return out;
}

/**
 * Trip k's mass lines, said under its own chart (a plan of several trips
 * draws one chart per trip): its takeoff above the envelope's maximum mass,
 * with the most fuel its block can take, or out of the envelope; its landing
 * out of the envelope, its touchdown above the sheet's maximum landing mass;
 * its zero-fuel point out of the envelope or above the maximum zero-fuel
 * mass; each station above its published maximum. Nothing is shared with
 * another trip: a landing the next takeoff repeats is said under both, each
 * chart drawing it, as each flight's weight and balance stands alone.
 */
export function tripMassLines(input: MbLinesInput, k: number): MassLine[] {
	const { mb } = input;
	const { trips } = input.loads;
	const tr = trips[k];
	const m = tr?.mb;
	if (!mb || !tr || !m) {
		return [];
	}
	const topKg = Math.max(...mb.envelope.map((p) => p.massKg));
	const r = m.result;
	// The fuel change curing the limits the fuel decides, where one verified
	// (its block's start at its Maximum within limits).
	const lf = input.loads.limitFixes.find((f) => f.chainIndex === tr.blockStart);
	const fix = lf ? { fix: { at: lf.chainIndex, litres: lf.litres } } : {};
	const out: MassLine[] = [];
	if (r.takeoff.massKg > topKg + 1e-9) {
		out.push({
			kind: 'aboveMax',
			trip: k,
			massKg: r.takeoff.massKg,
			maxKg: topKg,
			at: tr.blockStart,
			maxWithinL: trips[tr.blockStart].maxWithinLimits?.litres ?? null,
			...fix,
		});
	} else if (!r.takeoffInside) {
		out.push({ kind: 'cgOut', trip: k, phase: 'takeoff', armM: r.takeoff.armM, massKg: r.takeoff.massKg, ...fix });
	}
	if (m.landingKnown && !r.landingInside) {
		out.push({ kind: 'cgOut', trip: k, phase: 'landing', armM: r.landing.armM, massKg: r.landing.massKg, ...fix });
	}
	if (m.overMaxLanding && m.touchdownKg !== null && mb.maxLandingMassKg != null) {
		out.push({ kind: 'touchdownOver', trip: k, touchdownKg: m.touchdownKg, maxKg: mb.maxLandingMassKg, ...fix });
	}
	if (!r.zeroFuelInside) {
		out.push({ kind: 'zeroFuelOut', trip: k, armM: r.zeroFuel.armM });
	}
	if (m.overMaxZeroFuel && mb.maxZeroFuelMassKg != null) {
		out.push({ kind: 'zeroFuelOver', trip: k, massKg: r.zeroFuel.massKg, maxKg: mb.maxZeroFuelMassKg });
	}
	for (const row of r.rows) {
		if (row.kind === 'station' && row.overMax && row.maxMassKg != null) {
			out.push({ kind: 'station', trip: k, key: row.key, label: row.label, massKg: row.massKg, maxKg: row.maxMassKg });
		}
	}
	return out;
}
