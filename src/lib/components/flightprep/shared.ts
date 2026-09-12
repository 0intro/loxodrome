/* Shared flight-preparation derivations for the modal pages (dossier, fuel
 * plan, mass & balance, performance): the trip columns (routes paired with
 * alternates + the stored per-trip inputs), the fuel plan / refuelling plan,
 * the mass & balance resolution the performance page's takeoff mass also
 * reads, and the dossier timeline inputs. These read reactive state (routes,
 * routeSettings, flightPrep, the selected aircraft) and are meant to be
 * called inside $derived contexts. */

import { computeNavLog, waypointLabel } from '$lib/route/navlog';
import { routeEndpointLabel } from '$lib/route/routeLabel';
import { t } from '$lib/state/i18n.svelte';
import { civilTwilightUtc, sunTimesUtc } from '$lib/route/sun';
import { routes, routeSettings, type Route, type Waypoint } from '$lib/state/route.svelte';
import {
	tripFuel,
	dossierStopEffectiveMin,
	dossierFlightDate,
	flightPrep,
} from '$lib/state/flightPrep.svelte';
import {
	effectiveCruiseSpeedKt,
	selectedAircraft,
	tankedFuelDensityKgPerL,
} from '$lib/state/aircraft.svelte';
import { effectiveRouteWinds } from '$lib/state/routeWind.svelte';
import { windAloft } from '$lib/state/windAloft.svelte';
import { legTasKt } from '$lib/route/legWind';
import { orderedTrips, orphanAlternates, type Trip } from '$lib/aircraft/trips';
import {
	dossierChain,
	computeDossierTimeline,
	timelineAtNight,
	parseClock,
	type DossierTripInput,
} from '$lib/aircraft/dossier';
import {
	tripTimes,
	tripTimesLegs,
	fuelTripFromTimes,
	computeFuelPlan,
	computeRefuelPlan,
	pickRefuelStrategy,
	DEFAULT_FINAL_RESERVE_MIN,
	DEFAULT_PILOT_MARGIN_MIN,
	autoFinalReserveMin,
	type FuelTripInput,
	type FuelTripRow,
	type FuelPlan,
	type RefuelPlan,
	type RefuelStrategy,
} from '$lib/aircraft/fuel';
import {
	computeMassBalance,
	fuelLitresForMode,
	burnLitresForMode,
	type FuelMode,
	type MassBalanceResult,
} from '$lib/aircraft/massBalance';
import { aircraftKey, type Aircraft, type FuelType } from '$lib/aircraft/schema';
import { fuelRefusal, sellsGrade, type FuelOffering, type FuelRefusal } from '$lib/data/fuel';
import { KG_TO_LB } from '$lib/aircraft/performance';

export interface TripColumn {
	trip: Trip<Route>;
	/** null when the trip has no flyable legs or no cruise speed is set. */
	input: FuelTripInput | null;
}

function routeTimes(r: Route) {
	const cruise = effectiveCruiseSpeedKt();
	const legs = computeNavLog(r.waypoints, cruise).legs;
	// Per-leg effective winds (override / forecast / global fallback) and the
	// optional temperature-corrected TAS, through the same resolver as the
	// nav-log sheet so the fuel plan and the printed log agree. The classic
	// global-wind path stays when nothing per-leg resolves (identical numbers
	// by construction, keeping the workbook-parity pins meaningful).
	if (cruise != null && cruise > 0) {
		const winds = effectiveRouteWinds(r);
		if (winds.some((w) => w != null && w.source !== 'manual') || windAloft.tempTas) {
			const tas = winds.map((w, i) =>
				legTasKt(cruise, w?.forecast?.tempC ?? null, r.waypoints[i]?.alt ?? 0, windAloft.tempTas),
			);
			return tripTimesLegs(
				legs,
				tas,
				winds.map((w) => (w ? { dirDeg: w.dirDeg, speedKt: w.speedKt } : null)),
			);
		}
	}
	return tripTimes(legs, cruise, routeSettings.windDirDeg, routeSettings.windSpeedKt);
}

function lastLabel(r: Route): string {
	const wps = r.waypoints;
	return wps.length > 0 ? waypointLabel(wps[wps.length - 1]) : '';
}

/** One column per trip, with the fuel input built from the route geometry,
 *  the route settings (cruise speed + wind) and the stored per-trip minutes. */
export function tripColumns(): TripColumn[] {
	return orderedTrips(routes.list).map((trip) => {
		const f = tripFuel(trip.index);
		const altRoute = trip.alternate && trip.alternate.waypoints.length >= 2 ? trip.alternate : null;
		// A trip route without a flyable leg (< 2 waypoints) has no time to
		// plan: keep it out of the fuel inputs (a lone waypoint would
		// otherwise compute as a zero-minute trip and pollute the plan and
		// the dossier chain).
		const input =
			trip.route.waypoints.length < 2
				? null
				: fuelTripFromTimes(
						routeEndpointLabel(trip.route, t.route.newRoute),
						routeTimes(trip.route),
						altRoute ? { label: lastLabel(altRoute), times: routeTimes(altRoute) } : null,
						{
							toLabel: lastLabel(trip.route) || undefined,
							// null = automatic: an absent option leaves fuel.ts to
							// apply its own default, which is where each one is
							// defined (and what the page's placeholder then shows).
							taxiMin: f.taxiMin ?? undefined,
							procedureMin: f.procedureMin ?? undefined,
							alternateProcedureMin: f.altProcedureMin ?? undefined,
						},
					);
		if (input) {
			// Same rule for the two the plan resolves rather than the trip
			// constructor: leave the override unset and computeFuelPlan applies
			// the params' margin and the derived day/night reserve.
			if (f.marginMin != null) {
				input.marginMin = f.marginMin;
			}
			if (f.finalReserveMin != null) {
				input.finalReserveMin = f.finalReserveMin;
			}
		}
		return { trip, input };
	});
}

export interface FuelComputation {
	columns: TripColumn[];
	/** The computable inputs, in trip order. */
	inputs: FuelTripInput[];
	/** The columns those inputs came from, so `inputColumns[i]` is the trip
	 *  `inputs[i]` was built from and the fuel plan's own column order. Held
	 *  here rather than re-filtered per caller: three sites derived it and
	 *  they must not drift about which column a load belongs to. */
	inputColumns: TripColumn[];
	plan: FuelPlan;
	/** null without an aircraft's fuel data (no litres / no feasibility). */
	refuel: RefuelPlan | null;
	consumptionLph: number | null;
	usableFuelL: number | null;
	/** Derived night flight (any timeline event in aeronautical night). */
	night: boolean;
	/** The auto final-reserve default in force: 45 min for night or IFR
	 *  (AMC1 NCO.OP.125(b)), 30 min for VFR by day. */
	autoFinalReserveMin: number;
}

/** Aeronautical night at any timeline event (sunrise/sunset -/+ the
 *  latitude-aware margin at each aerodrome, 30 min temperate / 15 min at
 *  |lat| <= 30 deg per the DGAC SERA night complement, the overview's
 *  rule); false when the timeline can't be built (no departure time, no
 *  computable trips). The probe rows only provide burn-offs, which don't
 *  depend on the reserve. */
function derivedNight(columns: TripColumn[], probeRows: FuelTripRow[]): boolean {
	const departureMin = parseClock(flightPrep.dossier.departureTime ?? '');
	const trips = dossierTrips(columns, probeRows);
	if (departureMin == null || trips.length === 0) {
		return false;
	}
	const timeline = computeDossierTimeline(trips, {
		departureMin,
		fuelOnBoardMin: null,
		finalReserveMin: 0,
	});
	const date = dossierFlightDate();
	const chain = dossierChain(trips);
	const sun = chain.map((e) => sunTimesUtc(e.lat, e.lon, date));
	return timelineAtNight(
		timeline,
		sun,
		chain.map((e) => e.lat),
		// Above 60 deg the sunset-margin model breaks down (twilight lasts
		// hours, or the sun never crosses the horizon at all): use the EASA
		// civil-twilight definition directly there.
		chain.map((e) => (Math.abs(e.lat) > 60 ? civilTwilightUtc(e.lat, e.lon, date) : null)),
	);
}

export function fuelComputation(): FuelComputation {
	const columns = tripColumns();
	const inputColumns = columns.filter((c) => c.input !== null);
	const inputs = inputColumns.map((c) => c.input).filter((i): i is FuelTripInput => i !== null);
	const aircraft = selectedAircraft();
	const consumptionLph = aircraft?.fuel?.consumptionLph ?? null;
	const usableFuelL = aircraft?.fuel?.usableL ?? null;
	// Probe with the day default to get the burn-offs, derive day/night from
	// the resulting timeline, then plan with the derived final-reserve
	// default (explicit per-trip overrides ride the inputs either way).
	const dayParams = {
		consumptionLph: consumptionLph ?? 0,
		finalReserveMin: DEFAULT_FINAL_RESERVE_MIN,
		pilotMarginMin: DEFAULT_PILOT_MARGIN_MIN,
	};
	const probe = computeFuelPlan(inputs, dayParams);
	const night = derivedNight(columns, probe.trips);
	const reserveMin = autoFinalReserveMin(routeSettings.vfr, night);
	const params =
		reserveMin === dayParams.finalReserveMin
			? dayParams
			: { ...dayParams, finalReserveMin: reserveMin };
	const plan = params === dayParams ? probe : computeFuelPlan(inputs, params);
	const refuel =
		consumptionLph != null && usableFuelL != null && inputs.length > 0
			? computeRefuelPlan(inputs, { ...params, usableFuelL })
			: null;
	return {
		columns,
		inputs,
		inputColumns,
		plan,
		refuel,
		consumptionLph,
		usableFuelL,
		night,
		autoFinalReserveMin: params.finalReserveMin,
	};
}

export interface MbComputation {
	aircraft: Aircraft;
	result: MassBalanceResult;
	fuelL: number;
	burnL: number;
	/** The refuelling plan's heaviest feasible load (the 'minimum' mode). */
	minimumL: number | null;
	/** Total burn-off with wind over every trip, minutes. */
	tripBurnMin: number | null;
	/** False when the selected fuel mode couldn't resolve (fell back to 0 L). */
	fuelResolved: boolean;
	/** False when the trip burn-off is unknown (fell back to all fuel). */
	burnResolved: boolean;
}

/** Resolve the mass & balance for the current loads + modes; null when the
 *  selected aircraft has no mass-and-balance or fuel section. */
export function mbComputation(fuel: FuelComputation): MbComputation | null {
	const aircraft = selectedAircraft();
	if (!aircraft?.massBalance || !aircraft.fuel) {
		return null;
	}
	const mb = aircraft.massBalance;
	const minimumL = fuel.refuel?.heaviestFeasibleLoadL ?? null;
	const mode: FuelMode =
		flightPrep.mb.fuelMode === 'custom'
			? { kind: 'custom', litres: flightPrep.mb.customLitres ?? 0 }
			: flightPrep.mb.fuelMode === 'tabs'
				? { kind: 'preset', name: 'tabs' }
				: { kind: flightPrep.mb.fuelMode };
	const resolvedFuelL = fuelLitresForMode(aircraft.fuel, mode, minimumL);
	const fuelL = resolvedFuelL ?? 0;
	const tripBurnMin =
		fuel.inputs.length > 0 ? fuel.plan.trips.reduce((s, t) => s + t.burnOffMin, 0) : null;
	// The landing point burns the trip; with no trip planned it falls back to
	// all fuel (= the zero-fuel row, which the table always shows anyway).
	const resolvedBurnL = burnLitresForMode('trip', fuelL, tripBurnMin, fuel.consumptionLph);
	const burnL = resolvedBurnL ?? fuelL;
	const result = computeMassBalance({
		mb,
		stationMassesKg: mb.stations.map((s) => flightPrep.mb.loads[s.label] ?? s.defaultMassKg),
		fuelL,
		burnL,
		densityKgPerL: tankedFuelDensityKgPerL(aircraftKey(aircraft), aircraft.fuel),
	});
	return {
		aircraft,
		result,
		fuelL,
		burnL,
		minimumL,
		tripBurnMin,
		fuelResolved: resolvedFuelL != null,
		burnResolved: resolvedBurnL != null,
	};
}

/** A dossier trip carrying its stable trip index (orderedTrips), the key
 *  stopsMin / tripFuel are aligned with: a non-computable trip drops out of
 *  the dossier list, so a list position is NOT a trip index. */
export interface DossierTripEntry extends DossierTripInput {
	tripIndex: number;
}

export interface DossierComputation {
	/** One entry per computable trip, in trip order (fuel.inputs alignment;
	 *  a trip without computable time drops out, like everywhere else). */
	trips: DossierTripEntry[];
	/** Endurance of the embarked fuel in minutes: the M&B page's load when it
	 *  resolves, else the plan's single-tankful minimum (the sheet's B27),
	 *  else null (no trips). */
	fuelOnBoardMin: number | null;
	/** Whether fuelOnBoardMin came from the M&B fuel load. */
	fuelFromMb: boolean;
	/** The last trip's final reserve, else the day/night default. */
	finalReserveMin: number;
}

/** Per-trip dossier timing inputs from the fuel columns + plan rows:
 *  endpoint label + coordinates (waypoints, so sunrise/sunset need no
 *  airport dataset), with-wind burn-off and the stored ground stop. */
function dossierTrips(columns: TripColumn[], rows: FuelTripRow[]): DossierTripEntry[] {
	const trips: DossierTripEntry[] = [];
	let k = 0;
	for (const c of columns) {
		if (!c.input) {
			continue;
		}
		const row = rows[k++];
		const wps = c.trip.route.waypoints;
		const first = wps[0];
		const last = wps[wps.length - 1];
		if (!first || !last) {
			// A route with no waypoints yet has no endpoints to time (a fresh
			// session's default empty route); the row is consumed to keep the
			// fuel-plan alignment.
			continue;
		}
		trips.push({
			from: { label: waypointLabel(first), lat: first.lat, lon: first.lon },
			to: { label: waypointLabel(last), lat: last.lat, lon: last.lon },
			burnOffMin: row.burnOffMin,
			stopMin: dossierStopEffectiveMin(c.trip.index),
			alternate: row.alternate,
			tripIndex: c.trip.index,
		});
	}
	return trips;
}

/** The dossier page's timeline inputs. */
export function dossierComputation(
	fuel: FuelComputation,
	mb: MbComputation | null,
): DossierComputation {
	const trips = dossierTrips(fuel.columns, fuel.plan.trips);
	let fuelOnBoardMin: number | null = null;
	let fuelFromMb = false;
	if (mb?.fuelResolved && fuel.consumptionLph != null) {
		fuelOnBoardMin = (mb.fuelL / fuel.consumptionLph) * 60;
		fuelFromMb = true;
	} else if (trips.length > 0) {
		fuelOnBoardMin = fuel.plan.totalMin;
	}
	const finalReserveMin =
		fuel.plan.trips.at(-1)?.finalReserveMin ?? fuel.autoFinalReserveMin;
	return { trips, fuelOnBoardMin, fuelFromMb, finalReserveMin };
}

/** The mass the performance page evaluates at: the M&B takeoff mass when
 *  resolvable, else the table's max mass or the closed-form reference mass
 *  (conservative), else null. */
export function performanceMassKg(mb: MbComputation | null, aircraft: Aircraft | null): number | null {
	if (mb) {
		return mb.result.takeoff.massKg;
	}
	const perf = aircraft?.performance;
	if (perf?.kind === 'table') {
		return perf.massMaxKg;
	}
	if (perf?.kind === 'closed-form') {
		// No M&B resolves (a sheet without the manual's Section 6 on file):
		// evaluate at the chart reference mass, the conservative maximum.
		return perf.massReferenceLb / KG_TO_LB;
	}
	return null;
}

/** An alternate aerodrome, and why it could not serve the aeroplane. */
export interface AlternateFuel<S = unknown> {
	/** The ICAO code, which is what the note names it by: a reason to look
	 *  an aerodrome up is worth nothing under a caption. */
	ident: string;
	refusal: FuelRefusal<S>;
}

/**
 * The alternates this plan could not refuel at.
 *
 * NOT because the plan needs them to: the load embarked at a refuelling
 * point covers, at every landing in its block, the burn-off to get there
 * PLUS a full diversion to that trip's alternate PLUS the final reserve
 * (computeRefuelPlan's `cum + reserveWithWindMin`). The diversion is flown
 * on fuel carried from the last stop, and nothing is planned beyond it.
 *
 * It matters for what happens AFTER the diversion. An aeroplane that
 * actually diverts lands with the final reserve and no more, so an alternate
 * with no fuel is one it cannot leave the same day. That is worth a line on
 * the sheet the decision is made from, and it is a different fact from the
 * plan being short.
 */
export function alternateFuel<S>(
	types: readonly FuelType[],
	lookup: (ident: string) => FuelOffering<S> | null,
): AlternateFuel<S>[] {
	const alternates = [
		...orderedTrips(routes.list)
			.map((trip) => trip.alternate)
			.filter((r): r is Route => r != null),
		// The ones attached to no trip are still aerodromes a pilot typed in.
		...orphanAlternates(routes.list),
	];
	const out: AlternateFuel<S>[] = [];
	const seen = new Set<string>();
	for (const r of alternates) {
		const wp = r.waypoints[r.waypoints.length - 1];
		const ident = wp && wp.kind === 'airport' && wp.ident ? wp.ident.toUpperCase() : '';
		if (ident === '' || seen.has(ident)) {
			continue;
		}
		seen.add(ident);
		const refusal = fuelRefusal(lookup(ident), types);
		if (refusal) {
			out.push({ ident, refusal });
		}
	}
	return out;
}

/** One takeoff point of the refuelling plan, and whether it can serve this
 *  aeroplane. */
export interface RefuelPoint<S = unknown> {
	/** The aerodrome the load is uplifted at, or null where the plan takes
	 *  off from a free point. */
	ident: string | null;
	/** true = it publishes a grade this aeroplane takes; false = it is
	 *  positive it cannot serve it; null = nothing is known. */
	serves: boolean | null;
	/** Why not, where not. Carried beside the verdict rather than derived
	 *  again at the render, so the marker and its wording cannot disagree
	 *  about which of the four reasons applies. */
	refusal: FuelRefusal<S> | null;
}

/** The refuelling plan's takeoff points, in its own column order.
 *
 * computeRefuelPlan enumerates stopover subsets on arithmetic alone and
 * stays that way: it is pinned against the workbook and pure, and knows
 * nothing of aerodromes. This is the question the arithmetic cannot ask,
 * answered beside it.
 *
 * The uplift point of column 0 is the departure; of column i, the landing
 * point of the trip the previous column took off for, which is where that
 * load is embarked. `null` is the answer wherever the AIP is silent, so a
 * warning is only ever raised on something the AIP actually said. */
export function refuelPoints<S>(
	fuel: FuelComputation,
	types: readonly FuelType[],
	lookup: (ident: string) => FuelOffering<S> | null,
): RefuelPoint<S>[] {
	const cols = fuel.inputColumns;
	const airportIdent = (w: Waypoint | undefined): string | null =>
		w && w.kind === 'airport' && w.ident ? w.ident.toUpperCase() : null;
	return cols.map((c, i) => {
		const wps = i === 0 ? c.trip.route.waypoints : (cols[i - 1]?.trip.route.waypoints ?? []);
		const ident = airportIdent(i === 0 ? wps[0] : wps[wps.length - 1]);
		if (!ident) {
			return { ident, serves: null, refusal: null };
		}
		const row = lookup(ident);
		return { ident, serves: sellsGrade(row, types), refusal: fuelRefusal(row, types) };
	});
}

/** Whether every uplift point of this strategy can serve the aeroplane.
 *
 *  The join is exact and needs no plumbing: a `RefuelLoad` carries the
 *  `tripIndex` whose takeoff embarks it, and `refuelPoints` maps over the very
 *  list `computeRefuelPlan` was called on (`inputColumns` / `inputs`, filtered
 *  the same way), so the two are index-aligned.
 *
 *  UNKNOWN PASSES. Only a positive no demotes a strategy, which is the rule
 *  every other fuel surface follows: an aerodrome the AIP says nothing
 *  readable about is not evidence against a plan. */
export function strategyIsServed<S>(
	s: RefuelStrategy,
	points: readonly RefuelPoint<S>[],
): boolean {
	return s.loads.every((l) => points[l.tripIndex]?.serves !== false);
}

/** The refuelling plan as the aerodromes leave it. */
export interface ServedRecommendation<S> {
	/** The best strategy that can actually be flown: feasible AND served,
	 *  chosen by the workbook's own rule. Null when none is both. */
	best: RefuelStrategy | null;
	/** The arithmetic recommendation, carried only when it is NOT served and
	 *  so lost its place. Null in the ordinary case, where `best` IS it. */
	demoted: RefuelStrategy | null;
	/** The uplift point that cost it that place, for the wording. */
	demotedAt: RefuelPoint<S> | null;
	/** True where the plan has a feasible answer but no servable one, which
	 *  is not the same as no answer at all: the tank is big enough, the
	 *  aerodromes are the problem. */
	noneServed: boolean;
}

/**
 * The recommendation the aerodromes allow, beside the one the arithmetic
 * gives.
 *
 * computeRefuelPlan recommends on fuel quantities alone, being pure and
 * workbook-pinned, so it will happily name a stop this same page marks as
 * having no fuel for this aeroplane. That contradiction is what this resolves:
 * the same rule (`pickRefuelStrategy`) applied to the strategies that are both
 * feasible and servable, with the arithmetic answer kept and explained rather
 * than hidden, since the fuel dataset is read from prose and the reader is
 * owed both facts.
 */
export function servedRecommendation<S>(
	plan: RefuelPlan | null,
	points: readonly RefuelPoint<S>[],
): ServedRecommendation<S> {
	const none: ServedRecommendation<S> = {
		best: null,
		demoted: null,
		demotedAt: null,
		noneServed: false,
	};
	if (!plan || !plan.recommended) {
		return none;
	}
	if (strategyIsServed(plan.recommended, points)) {
		return { ...none, best: plan.recommended };
	}
	const served = plan.strategies.filter((s) => s.feasible && strategyIsServed(s, points));
	const blocked = plan.recommended.loads
		.map((l) => points[l.tripIndex])
		.find((pt): pt is RefuelPoint<S> => pt?.serves === false);
	return {
		best: pickRefuelStrategy(served),
		demoted: plan.recommended,
		demotedAt: blocked ?? null,
		noneServed: served.length === 0,
	};
}

export function fmtL(litres: number): string {
	return `${Math.round(litres)} L`;
}

export function fmtMin(min: number): string {
	return `${Math.round(min)} min`;
}

export function fmtKg(kg: number): string {
	return `${Math.round(kg)} kg`;
}

export function fmtM(m: number): string {
	return `${Math.round(m)} m`;
}

export function fmtArm(armM: number): string {
	return armM.toFixed(3);
}

/** Endurance-style HH:MM from minutes (the pure formatter in dossier.ts). */
export { fmtDuration as fmtHHMM } from '$lib/aircraft/dossier';
