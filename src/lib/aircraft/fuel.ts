/* Fuel plan + refuelling plan, the workbook's "Bilan carburant" in EASA
 * vocabulary: per trip Taxi + Trip + Procedure = burn-off (still air), plus a
 * wind allowance; the reserve block is the alternate time + its procedure +
 * the PIC's discretionary margin + the final reserve (30 min day VFR, AMC1
 * NCO.OP.125(b)). Minutes convert to litres through the aircraft's
 * consumption. Deliberate corrections vs the workbook: the final reserve and
 * margin are always counted even with no alternate (the sheet blanked the
 * whole reserve block, contrary to NCO.OP.125), and refuelling strategies
 * enumerate every subset of stopovers instead of the hand-laid four rows.
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
	/** Taxi + trip + procedure. */
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
	/** Single-tankful minimum, still air: sum of burn-offs + the largest reserve. */
	totalStillAirMin: number;
	/** Single-tankful minimum with wind. */
	totalMin: number;
	/** totalMin in litres, unrounded. */
	totalL: number;
}

export function computeFuelPlan(trips: FuelTripInput[], params: FuelPlanParams): FuelPlan {
	const lpm = params.consumptionLph / 60;
	const rows: FuelTripRow[] = trips.map((t) => {
		const burnOffStillAirMin = t.taxiMin + t.tripMin + t.procedureMin;
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
	const totalStillAirMin =
		rows.reduce((s, r) => s + r.burnOffStillAirMin, 0) +
		(rows.length ? Math.max(...rows.map((r) => r.reserveMin)) : 0);
	const totalMin =
		rows.reduce((s, r) => s + r.burnOffMin, 0) +
		(rows.length ? Math.max(...rows.map((r) => r.reserveWithWindMin)) : 0);
	return { trips: rows, totalStillAirMin, totalMin, totalL: totalMin * lpm };
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
	/** maxLoadL <= the usable fuel. */
	feasible: boolean;
}

export interface RefuelPlan {
	/** Every subset of stopovers; fewest stops first, then ascending stops. */
	strategies: RefuelStrategy[];
	/** Fewest refuels, tie broken by the latest stops; null when none feasible. */
	recommended: RefuelStrategy | null;
	/** Largest feasible single load; feeds the M&B "minimum fuel" mode. */
	heaviestFeasibleLoadL: number | null;
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
		return { strategies: [], recommended: null, heaviestFeasibleLoadL: null };
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
			let cum = 0;
			let minutes = 0;
			for (let k = start; k <= end; k++) {
				cum += rows[k].burnOffMin;
				minutes = Math.max(minutes, cum + rows[k].reserveWithWindMin);
			}
			loads.push({ tripIndex: start, minutes, litres: minutes * lpm });
		}
		const maxLoadMin = Math.max(...loads.map((l) => l.minutes));
		const maxLoadL = maxLoadMin * lpm;
		strategies.push({
			stops,
			loads,
			maxLoadMin,
			maxLoadL,
			feasible: maxLoadL <= params.usableFuelL,
		});
	}
	// Display order: fewest stops first, then ascending stop lists (the
	// workbook's row order: none, first stop, second stop, both).
	strategies.sort((a, b) => a.stops.length - b.stops.length || cmpStops(a.stops, b.stops));
	const feasible = strategies.filter((s) => s.feasible);
	// Recommendation: fewest refuels; ties prefer the LATER stops (the
	// workbook checks "refuel at the second stopover" before the first).
	const recommended = feasible.length
		? [...feasible].sort(
				(a, b) => a.stops.length - b.stops.length || cmpStops(b.stops, a.stops),
			)[0]
		: null;
	const heaviestFeasibleLoadL = feasible.length
		? Math.max(...feasible.map((s) => s.maxLoadL))
		: null;
	return { strategies, recommended, heaviestFeasibleLoadL };
}

function cmpStops(a: number[], b: number[]): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (a[i] !== b[i]) {
			return a[i] - b[i];
		}
	}
	return a.length - b.length;
}
