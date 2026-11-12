/* Fuel plan + refuelling plan, the workbook's "Bilan carburant" in EASA
 * vocabulary: per trip Taxi + Trip + Procedure + Contingency = burn-off
 * (still air), plus a wind allowance; the reserve block is the alternate time
 * + its procedure +
 * the PIC's discretionary margin + the final reserve (30 min day VFR, AMC1
 * NCO.OP.125(b)). Minutes convert to litres through the aircraft's
 * consumption. Deliberate corrections vs the workbook: the final reserve and
 * margin are always counted even with no alternate (the sheet blanked the
 * whole reserve block, contrary to NCO.OP.125), refuelling strategies
 * enumerate every subset of stopovers instead of the hand-laid four rows, and
 * the single-tankful minimum is the per-flight rule at every landing
 * (blockMinimumMin) rather than every burn-off plus the largest reserve.
 * Pure (no Svelte, no I/O); times come in as legs + wind via tripTimes(). */

import { windTriangle } from '$lib/route/wind';

/** 5 min per ground movement, and a trip has two: takeoff + landing. */
export const DEFAULT_TAXI_MIN = 10;
export const DEFAULT_PROCEDURE_MIN = 10;
/** Final reserve defaults per AMC1 NCO.OP.125(b): 30 min day VFR, 45 min
 *  night VFR / IFR, at normal cruising consumption. */
export const DEFAULT_FINAL_RESERVE_MIN = 30;
export const DEFAULT_FINAL_RESERVE_NIGHT_MIN = 45;

/** The automatic final-reserve default per AMC1 NCO.OP.125(b): 30 min
 *  holding applies to VFR by day only; VFR by night AND IFR take 45 min. */
export function autoFinalReserveMin(vfr: boolean, night: boolean): number {
	return !vfr || night ? DEFAULT_FINAL_RESERVE_NIGHT_MIN : DEFAULT_FINAL_RESERVE_MIN;
}
export const DEFAULT_PILOT_MARGIN_MIN = 0;
/** The club form's "Perfo, évitements, MTO, ATC, attente": minutes for what
 *  the trip may meet on the way (performance, avoidance, weather, ATC,
 *  holding), the contingency fuel of ICAO Annex 6 Part I 4.3.6.3. Part-NCO
 *  states no figure (NCO.OP.125(a) asks only that the fuel take into account
 *  "any contingencies that may reasonably be expected"), so none unless the
 *  pilot types one. Used up with the trip, like the taxi and the procedure. */
export const DEFAULT_CONTINGENCY_MIN = 0;

/** The slice of a nav-log leg the fuel plan needs (computeNavLog's legs fit). */
export interface LegForFuel {
	trackTrueDeg: number;
	legNM: number;
}

export interface TripTimes {
	/** Minutes at the cruise speed, or null when it is unset. */
	stillAirMin: number | null;
	/** Wind-corrected minutes; null when a leg's wind triangle has no solution
	 *  (or the cruise speed is unset). Calm / no wind equals stillAirMin. */
	withWindMin: number | null;
}

/** Still-air and wind-corrected minutes over a route's legs. */
export function tripTimes(
	legs: ReadonlyArray<LegForFuel>,
	cruiseSpeedKt: number | null,
	windDirDeg: number | null,
	windSpeedKt: number | null,
): TripTimes {
	const kt = cruiseSpeedKt && cruiseSpeedKt > 0 ? cruiseSpeedKt : null;
	if (!kt) {
		return { stillAirMin: null, withWindMin: null };
	}
	let still = 0;
	for (const leg of legs) {
		still += (leg.legNM / kt) * 60;
	}
	if (windDirDeg == null || windSpeedKt == null || windSpeedKt <= 0) {
		return { stillAirMin: still, withWindMin: still };
	}
	let wind = 0;
	for (const leg of legs) {
		const sol = windTriangle(leg.trackTrueDeg, kt, windDirDeg, windSpeedKt);
		if (!sol) {
			return { stillAirMin: still, withWindMin: null };
		}
		wind += (leg.legNM / sol.gsKt) * 60;
	}
	return { stillAirMin: still, withWindMin: wind };
}

/** Per-leg variant of tripTimes for forecast winds: each leg flies its own
 *  wind (null = calm) and its own TAS (a scalar applies everywhere). With
 *  the same wind on every leg and a scalar TAS it reproduces tripTimes
 *  exactly; tripTimes' 4-argument signature stays untouched (its callers
 *  and pins are the workbook-parity contract). */
export function tripTimesLegs(
	legs: ReadonlyArray<LegForFuel>,
	tasKt: number | ReadonlyArray<number>,
	winds: ReadonlyArray<{ dirDeg: number; speedKt: number } | null>,
): TripTimes {
	const tasFor = (i: number): number | null => {
		const v = typeof tasKt === 'number' ? tasKt : (tasKt[i] ?? null);
		return v != null && v > 0 ? v : null;
	};
	let still = 0;
	for (let i = 0; i < legs.length; i++) {
		const kt = tasFor(i);
		if (!kt) {
			return { stillAirMin: null, withWindMin: null };
		}
		still += (legs[i].legNM / kt) * 60;
	}
	let wind = 0;
	for (let i = 0; i < legs.length; i++) {
		const kt = tasFor(i);
		if (!kt) {
			return { stillAirMin: null, withWindMin: null };
		}
		const w = winds[i];
		if (!w || w.speedKt <= 0) {
			wind += (legs[i].legNM / kt) * 60;
			continue;
		}
		const sol = windTriangle(legs[i].trackTrueDeg, kt, w.dirDeg, w.speedKt);
		if (!sol) {
			return { stillAirMin: still, withWindMin: null };
		}
		wind += (legs[i].legNM / sol.gsKt) * 60;
	}
	return { stillAirMin: still, withWindMin: wind };
}

export interface AlternateFuelInput {
	label: string;
	/** Rounded still-air minutes to fly the diversion. */
	timeMin: number;
	procedureMin: number;
	/** Extra minutes due to wind, never negative (the workbook's rule). */
	windAllowanceMin: number;
}

export interface FuelTripInput {
	label: string;
	/** Landing point, used for refuel-stop labels. */
	toLabel?: string | undefined;
	taxiMin: number;
	/** Rounded still-air minutes. */
	tripMin: number;
	procedureMin: number;
	windAllowanceMin: number;
	alternate?: AlternateFuelInput | undefined;
	/** Per-trip overrides of the plan params (the UI edits them per column). */
	marginMin?: number | undefined;
	finalReserveMin?: number | undefined;
	/** Minutes of contingency, burnt with the trip; absent = none. */
	contingencyMin?: number | undefined;
}

/** Integer-minute rounding boundary: TripTimes -> FuelTripInput. The wind
 *  allowance is the rounded with-wind excess, clamped to >= 0 (a tailwind
 *  benefit is deliberately not credited); an unsolvable wind contributes 0
 *  (the nav log surfaces that state). Null when the trip has no still-air
 *  time (no cruise speed or an empty route). */
export function fuelTripFromTimes(
	label: string,
	trip: TripTimes,
	alternate: { label: string; times: TripTimes } | null,
	opts?: {
		toLabel?: string | undefined;
		taxiMin?: number | undefined;
		procedureMin?: number | undefined;
		alternateProcedureMin?: number | undefined;
	},
): FuelTripInput | null {
	if (trip.stillAirMin == null) {
		return null;
	}
	const allowance = (t: TripTimes): number =>
		t.stillAirMin != null && t.withWindMin != null
			? Math.max(0, Math.round(t.withWindMin - t.stillAirMin))
			: 0;
	let alt: AlternateFuelInput | undefined;
	if (alternate && alternate.times.stillAirMin != null && alternate.times.stillAirMin > 0) {
		alt = {
			label: alternate.label,
			timeMin: Math.round(alternate.times.stillAirMin),
			procedureMin: opts?.alternateProcedureMin ?? DEFAULT_PROCEDURE_MIN,
			windAllowanceMin: allowance(alternate.times),
		};
	}
	return {
		label,
		toLabel: opts?.toLabel,
		taxiMin: opts?.taxiMin ?? DEFAULT_TAXI_MIN,
		tripMin: Math.round(trip.stillAirMin),
		procedureMin: opts?.procedureMin ?? DEFAULT_PROCEDURE_MIN,
		windAllowanceMin: allowance(trip),
		alternate: alt,
	};
}

export interface FuelPlanParams {
	consumptionLph: number;
	finalReserveMin: number;
	pilotMarginMin: number;
}

export interface FuelTripRow {
	label: string;
	taxiMin: number;
	tripMin: number;
	procedureMin: number;
	contingencyMin: number;
	/** Taxi + trip + procedure + contingency. */
	burnOffStillAirMin: number;
	windAllowanceMin: number;
	/** Burn-off with wind. */
	burnOffMin: number;
	alternate: AlternateFuelInput | null;
	pilotMarginMin: number;
	finalReserveMin: number;
	/** Alternate time + its procedure + margin + final reserve. */
	reserveMin: number;
	/** reserveMin + the alternate's wind allowance. */
	reserveWithWindMin: number;
	/** burnOffMin + reserveWithWindMin. */
	totalMin: number;
	/** totalMin at the consumption; unrounded (display rounds). */
	totalL: number;
}

export interface FuelPlan {
	trips: FuelTripRow[];
	/** Single-tankful minimum, still air: the whole flight on one fuel load,
	 *  enough at every landing to divert and keep that trip's reserve
	 *  (blockMinimumMin over every trip). The workbook summed every burn-off
	 *  and added the LARGEST reserve, which overstated whenever that reserve
	 *  was not the last landing's (correction #13). */
	totalStillAirMin: number;
	/** Single-tankful minimum with wind: the no-refuel strategy's own load. */
	totalMin: number;
	/** totalMin in litres, unrounded. */
	totalL: number;
}

export function computeFuelPlan(trips: FuelTripInput[], params: FuelPlanParams): FuelPlan {
	const lpm = params.consumptionLph / 60;
	const rows: FuelTripRow[] = trips.map((t) => {
		const contingencyMin = t.contingencyMin ?? DEFAULT_CONTINGENCY_MIN;
		const burnOffStillAirMin = t.taxiMin + t.tripMin + t.procedureMin + contingencyMin;
		const burnOffMin = burnOffStillAirMin + t.windAllowanceMin;
		const alternate = t.alternate ?? null;
		const pilotMarginMin = t.marginMin ?? params.pilotMarginMin;
		const finalReserveMin = t.finalReserveMin ?? params.finalReserveMin;
		const reserveMin =
			(alternate ? alternate.timeMin + alternate.procedureMin : 0) +
			pilotMarginMin +
			finalReserveMin;
		const reserveWithWindMin = reserveMin + (alternate?.windAllowanceMin ?? 0);
		const totalMin = burnOffMin + reserveWithWindMin;
		return {
			label: t.label,
			taxiMin: t.taxiMin,
			tripMin: t.tripMin,
			procedureMin: t.procedureMin,
			contingencyMin,
			burnOffStillAirMin,
			windAllowanceMin: t.windAllowanceMin,
			burnOffMin,
			alternate,
			pilotMarginMin,
			finalReserveMin,
			reserveMin,
			reserveWithWindMin,
			totalMin,
			totalL: totalMin * lpm,
		};
	});
	const totalStillAirMin = blockMinimumMin(rows, 0, rows.length - 1, 'stillAir');
	const totalMin = blockMinimumMin(rows, 0, rows.length - 1);
	return { trips: rows, totalStillAirMin, totalMin, totalL: totalMin * lpm };
}

/** The tolerance every fuel comparison shares, in litres: the per-trip check
 *  (tripLoads.ts), the strategies' feasibility and the rounding up of a load.
 *  Without one shared figure, a load exactly equal to its requirement could
 *  read sufficient on one surface and short on another, the two computing it
 *  through different floating-point paths. */
export const FUEL_EPS_L = 1e-6;

/** A quantity to LOAD, rounded up to the litre: a minimum displayed or loaded
 *  rounded down would leave the aircraft short of it. The tolerance keeps an
 *  exact integer from rounding up a whole litre on floating-point noise. */
export function ceilLitres(litres: number): number {
	// + 0 turns the -0 that Math.ceil gives a tolerance-shifted zero into 0.
	return Math.ceil(litres - FUEL_EPS_L) + 0;
}

/** A quantity NOT to exceed, rounded down to the litre (the Maximum within
 *  limits, the top of a takeoff's window): rounded up, it would take off
 *  above the limit it states. The mirror of ceilLitres, the same tolerance. */
export function floorLitres(litres: number): number {
	return Math.floor(litres + FUEL_EPS_L) + 0;
}

/** The strict minimum, in minutes, to embark at the takeoff of trip `start`
 *  for trips `start..end` (inclusive) flown without refuelling: enough at
 *  every landing of the block to divert and keep that trip's reserve, i.e.
 *  the max over k of (the burn-offs start..k + reserve k). The per-flight
 *  rule (NCO.OP.125(c)) applied to every landing until the next uplift; 0 for
 *  an empty range. `stillAir` reads the still-air columns, the default the
 *  with-wind ones. */
export function blockMinimumMin(
	rows: readonly Pick<
		FuelTripRow,
		'burnOffMin' | 'burnOffStillAirMin' | 'reserveWithWindMin' | 'reserveMin'
	>[],
	start: number,
	end: number,
	basis: 'withWind' | 'stillAir' = 'withWind',
): number {
	let cum = 0;
	let minutes = 0;
	for (let k = start; k <= end && k < rows.length; k++) {
		const r = rows[k];
		cum += basis === 'stillAir' ? r.burnOffStillAirMin : r.burnOffMin;
		minutes = Math.max(minutes, cum + (basis === 'stillAir' ? r.reserveMin : r.reserveWithWindMin));
	}
	return minutes;
}

export interface RefuelLoad {
	/** The trip whose takeoff embarks this load. */
	tripIndex: number;
	minutes: number;
	litres: number;
}

export interface RefuelStrategy {
	/** Refuel stopover indices (stop i = the landing of trip i), ascending. */
	stops: number[];
	/** One load per takeoff point: trip 0, then each stop + 1. */
	loads: RefuelLoad[];
	maxLoadMin: number;
	maxLoadL: number;
	/** maxLoadL <= the usable fuel (within FUEL_EPS_L). */
	feasible: boolean;
}

export interface RefuelPlan {
	/** Every subset of stopovers; fewest stops first, then ascending stops. */
	strategies: RefuelStrategy[];
	/** Fewest refuels, tie broken by the latest stops; null when none feasible. */
	recommended: RefuelStrategy | null;
}

/** Strict per-takeoff minimum: enough at every upcoming landing until the
 *  next refuel to divert and keep the reserve, i.e. max over those landings
 *  of (cumulative burn-off with wind + that trip's reserve with wind). */
export function computeRefuelPlan(
	trips: FuelTripInput[],
	params: FuelPlanParams & { usableFuelL: number },
): RefuelPlan {
	const plan = computeFuelPlan(trips, params);
	const rows = plan.trips;
	const lpm = params.consumptionLph / 60;
	const n = rows.length;
	if (n === 0) {
		return { strategies: [], recommended: null };
	}
	const stopCount = n - 1;
	const strategies: RefuelStrategy[] = [];
	for (let mask = 0; mask < 1 << stopCount; mask++) {
		const stops: number[] = [];
		for (let i = 0; i < stopCount; i++) {
			if (mask & (1 << i)) {
				stops.push(i);
			}
		}
		const loads: RefuelLoad[] = [];
		const starts = [0, ...stops.map((s) => s + 1)];
		for (const [si, start] of starts.entries()) {
			const end = si + 1 < starts.length ? starts[si + 1] - 1 : n - 1;
			const minutes = blockMinimumMin(rows, start, end);
			loads.push({ tripIndex: start, minutes, litres: minutes * lpm });
		}
		const maxLoadMin = Math.max(...loads.map((l) => l.minutes));
		const maxLoadL = maxLoadMin * lpm;
		strategies.push({
			stops,
			loads,
			maxLoadMin,
			maxLoadL,
			feasible: maxLoadL <= params.usableFuelL + FUEL_EPS_L,
		});
	}
	// Display order: fewest stops first, then ascending stop lists (the
	// workbook's row order: none, first stop, second stop, both).
	strategies.sort((a, b) => a.stops.length - b.stops.length || cmpStops(a.stops, b.stops));
	const feasible = strategies.filter((s) => s.feasible);
	const recommended = pickRefuelStrategy(feasible);
	return { strategies, recommended };
}

/**
 * The workbook's own choice among a set of strategies: fewest refuels, ties
 * preferring the LATER stops (the workbook checks "refuel at the second
 * stopover" before the first).
 *
 * Exported because the fuel page asks the same question a second time, over
 * the strategies whose stops can actually SERVE the aeroplane, which is a
 * fact about aerodromes that this module knows nothing of
 * (flightprep/shared.ts). Two answers chosen by two copies of one rule would
 * drift, and the page prints them side by side.
 *
 * Takes the set to choose from rather than filtering: computeRefuelPlan
 * passes the feasible ones, the page passes the feasible AND served ones.
 */
export function pickRefuelStrategy(
	strategies: readonly RefuelStrategy[],
): RefuelStrategy | null {
	return strategies.length
		? [...strategies].sort(
				(a, b) => a.stops.length - b.stops.length || cmpStops(b.stops, a.stops),
			)[0]
		: null;
}

function cmpStops(a: number[], b: number[]): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (a[i] !== b[i]) {
			return a[i] - b[i];
		}
	}
	return a.length - b.length;
}
