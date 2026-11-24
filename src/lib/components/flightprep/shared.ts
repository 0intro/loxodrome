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
	stopInputs,
} from '$lib/state/flightPrep.svelte';
import { aboardOf, computeOnBoard, onBoardStale, type OnBoard, type OnBoardInputs } from '$lib/aircraft/onBoard';
import {
	effectiveConsumptionLph,
	effectiveCruiseSpeedKt,
	selectedAircraft,
	tankedFuelDensityKgPerL,
} from '$lib/state/aircraft.svelte';
import { effectiveRouteWinds } from '$lib/state/routeWind.svelte';
import { windAloft } from '$lib/state/windAloft.svelte';
import { legTasKt } from '$lib/route/legWind';
import { orderedTrips, orphanAlternates, tripStopKeys, type Trip } from '$lib/aircraft/trips';
import { perfRoles, type PerfRole } from '$lib/aircraft/aerodromes';
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
	FUEL_EPS_L,
	type FuelTripInput,
	type FuelTripRow,
	type FuelPlan,
	type RefuelPlan,
	type RefuelStrategy,
} from '$lib/aircraft/fuel';
import { aircraftKey, type Aircraft, type FuelType } from '$lib/aircraft/schema';
import {
	checkStrategies,
	computeTripLoads,
	fuelTargetOf,
	type StrategyCheck,
	type TripLoadsInput,
	type TripLoadsResult,
} from '$lib/aircraft/tripLoads';
import type { PerfPhase } from '$lib/aircraft/performance';
import type { IndexedNotam } from '$lib/state/notam.svelte';
import { plannedFuelLookup } from './stopFuel';
import {
	fuelAccess,
	fuelRefusal,
	sellsGrade,
	type FuelAccess,
	type FuelOffering,
	type FuelRefusal,
} from '$lib/data/fuel';
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
			const tas = winds.map((w) => legTasKt(cruise, w?.forecast, windAloft.tempTas));
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
			// Same rule for the three the plan resolves rather than the trip
			// constructor: leave the override unset and computeFuelPlan applies
			// the params' margin, the derived day/night reserve and no
			// contingency.
			if (f.marginMin != null) {
				input.marginMin = f.marginMin;
			}
			if (f.finalReserveMin != null) {
				input.finalReserveMin = f.finalReserveMin;
			}
			if (f.contingencyMin != null) {
				input.contingencyMin = f.contingencyMin;
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
	// The plan's fuel flow: its own, else its cruise setting's, else the
	// sheet's (state/aircraft effectiveConsumptionLph), so a different speed
	// burns its own.
	const consumptionLph = effectiveConsumptionLph();
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

/** The fuel and the loading at each takeoff, as the pilot states them on the
 *  M&B page (aircraft/tripLoads.ts), over the fuel plan's own rows. */
export interface TripLoadsComputation {
	aircraft: Aircraft;
	loads: TripLoadsResult;
	/** [k] = the stop before chain trip k, by its key (tripStopKeys); null
	 *  for the departure. */
	stopKeys: (string | null)[];
	/** [k] = chain trip k's trip index (orderedTrips), what the performance
	 *  roles and the dossier trips are keyed by. */
	tripIndex: number[];
	/** [k] = whether the takeoff point of chain trip k can serve this
	 *  aeroplane (refuelPoints: the departure, then each stop). */
	points: RefuelPoint<IndexedNotam>[];
	densityKgPerL: number;
	/** What the departure's tanks hold before its refuel, as the pilot read
	 *  them (aircraft/onBoard.ts); its litres are `input.departure.aboardL`. */
	onBoard: OnBoard;
	/** The reading itself (null: none), its day and aircraft as stamped. */
	reading: OnBoardInputs | null;
	/** The flight's day, 'YYYY-MM-DD': the dossier's date, else today. */
	flightDate: string;
	/** The reading was taken on another day than the flight's: still used,
	 *  and said. */
	onBoardStale: boolean;
	/** What `loads` was computed from: the simulations of the refuelling
	 *  strategies (checkStrategies) and "Use this plan" (strategyTargets)
	 *  start from it. */
	input: TripLoadsInput;
}

/** The trip loads for the current plan; null without an aircraft's fuel
 *  data. A stop the AIP or a NOTAM says cannot serve this aeroplane is never
 *  offered as a fix, the answer the fuel page marks it with. */
export function tripLoadsComputation(fuel: FuelComputation): TripLoadsComputation | null {
	const aircraft = selectedAircraft();
	if (!aircraft?.fuel) {
		return null;
	}
	const keyByTrip = tripStopKeys(orderedTrips(routes.list));
	const tripIndex = fuel.inputColumns.map((c) => c.trip.index);
	const stopKeys = tripIndex.map((ti, k) => (k === 0 ? null : (keyByTrip.get(ti) ?? null)));
	const points = refuelPoints(fuel, aircraft.fuel.types, plannedFuelLookup());
	const densityKgPerL = tankedFuelDensityKgPerL(aircraftKey(aircraft), aircraft.fuel);
	const reading = flightPrep.mb.onBoard;
	const onBoard = computeOnBoard(reading, {
		aircraftKey: aircraftKey(aircraft),
		usableL: aircraft.fuel.usableL,
		tabsL: aircraft.fuel.presets.find((p) => p.name === 'tabs')?.litres ?? null,
		// The journey log's flights were flown before this plan: the sheet's
		// own consumption, never the plan's setting.
		sheetLph: aircraft.fuel.consumptionLph ?? null,
	});
	const input: TripLoadsInput = {
		rows: fuel.plan.trips,
		consumptionLph: fuel.consumptionLph,
		fuel: aircraft.fuel,
		mb: aircraft.massBalance ?? null,
		densityKgPerL,
		departure: {
			// No refuel: the departure takes off with what is aboard, unknown
			// until the pilot states it (never a guessed full tank).
			target: flightPrep.mb.refuel
				? fuelTargetOf(flightPrep.mb.fuelMode, flightPrep.mb.customLitres)
				: null,
			aboardL: aboardOf(onBoard),
			loads: flightPrep.mb.loads,
		},
		stops: stopKeys.map((key) => {
			if (key === null) {
				return null;
			}
			const st = stopInputs(key);
			return { refuel: st.refuel ? fuelTargetOf(st.mode, st.litres) : null, loads: st.loads };
		}),
		refused: points.map((pt, k) => k > 0 && pt.serves === false),
	};
	const loads = computeTripLoads(input);
	const flightDate = dossierFlightDate();
	return {
		aircraft,
		loads,
		stopKeys,
		tripIndex,
		points,
		densityKgPerL,
		onBoard,
		reading,
		flightDate,
		onBoardStale: reading != null && onBoardStale(reading.readOn, flightDate),
		input,
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
	/** Per dossier trip, the endurance of its fuel at takeoff (refuelled or
	 *  carried over), minutes; null where unknown, and null as a whole when no
	 *  trip loads were asked for (the print menu's window ignores the fuel). */
	fuelAtTakeoffMin: (number | null)[] | null;
	/** The last trip's final reserve, else the day/night default. */
	finalReserveMin: number;
}

/** An endpoint's aerodrome ident, the raw one perfIcaos keys the
 *  performance page by, so the Overview reads the same column (refuelPoints'
 *  own lookup upper-cases it for the fuel dataset). */
function perfColumnIdent(w: Waypoint): string | undefined {
	return w.kind === 'airport' && w.ident ? w.ident : undefined;
}

/** Per-trip dossier timing inputs from the fuel columns + plan rows:
 *  endpoint label + coordinates (waypoints, so sunrise/sunset need no
 *  airport dataset), with-wind burn-off, the stored ground stop and the
 *  trip's own final reserve (its limit's). */
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
			from: { label: waypointLabel(first), lat: first.lat, lon: first.lon, icao: perfColumnIdent(first) },
			to: { label: waypointLabel(last), lat: last.lat, lon: last.lon, icao: perfColumnIdent(last) },
			burnOffMin: row.burnOffMin,
			stopMin: dossierStopEffectiveMin(c.trip.index),
			alternate: row.alternate,
			finalReserveMin: row.finalReserveMin,
			tripIndex: c.trip.index,
		});
	}
	return trips;
}

/** The dossier page's timeline inputs. `loads` null skips the fuel at each
 *  takeoff (the print menu's chart window, which reads no fuel and must not
 *  pay for the trip loads). */
export function dossierComputation(
	fuel: FuelComputation,
	loads: TripLoadsComputation | null,
): DossierComputation {
	const trips = dossierTrips(fuel.columns, fuel.plan.trips);
	const lph = fuel.consumptionLph != null && fuel.consumptionLph > 0 ? fuel.consumptionLph : null;
	const endurance = (litres: number | null | undefined): number | null =>
		litres == null || lph === null ? null : (Math.max(0, litres) / lph) * 60;
	let fuelOnBoardMin: number | null = null;
	let fuelFromMb = false;
	const first = endurance(loads?.loads.trips[0]?.startL);
	if (first !== null) {
		fuelOnBoardMin = first;
		fuelFromMb = true;
	} else if (trips.length > 0) {
		fuelOnBoardMin = fuel.plan.totalMin;
	}
	const fuelAtTakeoffMin = loads
		? trips.map((tr) => {
				const k = loads.tripIndex.indexOf(tr.tripIndex);
				return k < 0 ? null : endurance(loads.loads.trips[k]?.startL);
			})
		: null;
	const finalReserveMin =
		fuel.plan.trips.at(-1)?.finalReserveMin ?? fuel.autoFinalReserveMin;
	return { trips, fuelOnBoardMin, fuelFromMb, fuelAtTakeoffMin, finalReserveMin };
}

/** The flight manual's conservative mass: the table's maximum mass or the
 *  closed-form chart's reference mass; null without a performance section.
 *  What a performance column is computed at wherever its trip's mass is
 *  unknown (perfMasses). */
export function pohMassKg(aircraft: Aircraft | null): number | null {
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

/** The mass one performance column is computed at, and where it comes from. */
export interface PerfMass {
	massKg: number | null;
	/** 'trip': the takeoff mass of the trip that takes off from, lands at or
	 *  diverts to this aerodrome in this phase (the heaviest when several
	 *  do); 'heaviest': no trip does (an aerodrome added by hand, a phase
	 *  nothing flies there), the plan's heaviest takeoff; 'poh': a trip's
	 *  mass is unknown, the flight manual's conservative mass
	 *  (pohMassKg). */
	source: 'trip' | 'heaviest' | 'poh';
	/** The trip (chain index) the mass is the takeoff mass of; null for 'poh'. */
	trip: number | null;
	/** How that trip uses this aerodrome ('trip' only). */
	via: PerfRole['via'] | null;
	/** Every trip (chain index) with a role here in this phase. */
	trips: number[];
}

/**
 * The mass each performance column is computed at.
 *
 * A takeoff at the takeoff mass of the trip leaving there, the heaviest when
 * the aerodrome is left twice; a landing at the TAKEOFF mass of the trip
 * landing or diverting there, the sheet's conservative rule, now per trip.
 * The performance page's cells and nomogram and the Overview's take-off
 * procedure all read it, so the two pages cannot disagree. Never lighter
 * than the truth: wherever a mass it would read is unknown, the flight
 * manual's conservative mass stands in.
 */
export function perfMasses(
	loads: TripLoadsComputation | null,
	aircraft: Aircraft | null,
): (icao: string, phase: PerfPhase) => PerfMass {
	const poh: PerfMass = {
		massKg: pohMassKg(aircraft),
		source: 'poh',
		trip: null,
		via: null,
		trips: [],
	};
	if (!loads) {
		return () => poh;
	}
	const takeoffKg = loads.loads.trips.map((tr) => tr.mb?.result.takeoff.massKg ?? null);
	const chainOf = new Map(loads.tripIndex.map((ti, k) => [ti, k]));
	const roles = perfRoles(orderedTrips(routes.list)).flatMap((r) => {
		const k = chainOf.get(r.tripIndex);
		return k === undefined ? [] : [{ ...r, k }];
	});
	const heaviest = loads.loads.heaviestTakeoff;
	const anyUnknown = takeoffKg.some((kg) => kg === null);
	return (icao, phase) => {
		const mine = roles.filter((r) => r.icao === icao && r.phase === phase);
		if (mine.length === 0) {
			return heaviest === null || anyUnknown
				? poh
				: { massKg: heaviest.kg, source: 'heaviest', trip: heaviest.chainIndex, via: null, trips: [] };
		}
		const trips = [...new Set(mine.map((r) => r.k))];
		let best: { kg: number; role: (typeof mine)[number] } | null = null;
		for (const role of mine) {
			const kg = takeoffKg[role.k];
			if (kg === null) {
				return { ...poh, trips };
			}
			if (best === null || kg > best.kg) {
				best = { kg, role };
			}
		}
		return { massKg: best!.kg, source: 'trip', trip: best!.role.k, via: best!.role.via, trips };
	};
}

/**
 * The instant each performance column is flown at, off the Overview's own
 * timeline (so the two pages time a phase alike): a take-off at its trip's
 * ETD, a landing at its trip's ETA, a diversion's at the alternate arrival,
 * the LATEST where several trips use the column (perfMasses' roles, the same
 * walk). A phase no trip flies there reads the aerodrome's other phase,
 * when the plan is at that field: the landing back at a departure field its
 * ETD, a take-off from a destination or an alternate its arrival (user
 * decision 2026-10-08). Untimed, those columns read the METAR of the
 * moment, and a plan for tomorrow computed four of them with tonight's
 * observation. Null where nothing times it: no ETD stated, no trip the fuel
 * plan can time, an aerodrome added by hand. What picks a METAR or the
 * forecast for the column's weather (runwayPerf.ts wxPick).
 */
export function perfInstants(fuel: FuelComputation): (icao: string, phase: PerfPhase) => number | null {
	const departureMin = parseClock(flightPrep.dossier.departureTime ?? '');
	const dossier = dossierComputation(fuel, null);
	if (departureMin == null || dossier.trips.length === 0) {
		return () => null;
	}
	const tl = computeDossierTimeline(dossier.trips, {
		departureMin,
		fuelOnBoardMin: null,
		finalReserveMin: dossier.finalReserveMin,
	});
	const base = Date.parse(`${dossierFlightDate()}T00:00:00Z`);
	const ms = (min: number | null | undefined): number | null => (min == null ? null : base + min * 60_000);
	const byTrip = new Map(
		dossier.trips.map((tr, j) => [
			tr.tripIndex,
			{ departure: ms(tl.departuresMin[j]), arrival: ms(tl.arrivalsMin[j]), alternate: ms(tl.alternateArrivalsMin[j]) },
		]),
	);
	const roles = perfRoles(orderedTrips(routes.list));
	const latestOf = (icao: string, phase: PerfPhase): number | null => {
		let latest: number | null = null;
		for (const r of roles) {
			if (r.icao !== icao || r.phase !== phase) {
				continue;
			}
			const at = byTrip.get(r.tripIndex)?.[r.via] ?? null;
			if (at !== null && (latest === null || at > latest)) {
				latest = at;
			}
		}
		return latest;
	};
	return (icao, phase) =>
		roles.some((r) => r.icao === icao && r.phase === phase)
			? latestOf(icao, phase)
			: latestOf(icao, phase === 'takeoff' ? 'landing' : 'takeoff');
}

/** An alternate aerodrome, and why it could not serve the aeroplane. */
export interface AlternateFuel<S = unknown> {
	/** The ICAO code, which is what the note names it by: a reason to look
	 *  an aerodrome up is worth nothing under a caption. */
	ident: string;
	/** Why it could not refuel the aeroplane at all, where that is the case. */
	refusal: FuelRefusal<S> | null;
	/** What it would want arranged, where it could. Null once refused: one
	 *  aerodrome gets one line, and the harder fact is the one to print. */
	access: FuelAccess | null;
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
		const row = lookup(ident);
		const refusal = fuelRefusal(row, types);
		// A condition counts here as much as a refusal does, and for a reason
		// this block is the only place with: a diversion is not planned, so
		// there is nobody to have telephoned. A pump on prior notice is shut
		// to an aeroplane that arrives unannounced.
		const access = refusal ? null : fuelAccess(row?.cond);
		if (refusal || (access !== null && access !== 'h24')) {
			out.push({ ident, refusal, access });
		}
	}
	return out;
}

/** First row per ident, order preserved.
 *
 *  The uplift points are the DEPARTURE of each trip, so a plan that leaves
 *  the same field twice (out, back, out again: A-B, B-A, A-B) carries that
 *  ident in two columns. Every list built from them therefore has to fold
 *  it: one aerodrome says one thing, and a list keyed by ident with the
 *  ident twice is an error Svelte throws, in production as well as in dev. */
export function firstPerIdent<T extends { ident: string }>(rows: readonly T[]): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const r of rows) {
		if (!seen.has(r.ident)) {
			seen.add(r.ident);
			out.push(r);
		}
	}
	return out;
}

/** One takeoff point of the refuelling plan, and whether it can serve this
 *  aeroplane.
 *
 *  One per COLUMN, so the same `ident` can appear twice: see firstPerIdent. */
export interface RefuelPoint<S = unknown> {
	/** The aerodrome the load is uplifted at, or null where the plan takes
	 *  off from a free point. */
	ident: string | null;
	/** true = it publishes a grade this aeroplane takes; false = it is
	 *  positive it cannot serve it; null = nothing is known. */
	serves: boolean | null;
	/** Why not, where not. Carried beside the verdict rather than derived
	 *  again at the render, so the marker and its wording cannot disagree
	 *  about which of the five reasons applies. */
	refusal: FuelRefusal<S> | null;
	/** What the AIP wants arranged before an uplift here, where it says.
	 *  ADVISORY: the fuel is there and can be had, so this never reaches
	 *  `serves` and never demotes a strategy. */
	access: FuelAccess | null;
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
			return { ident, serves: null, refusal: null, access: null };
		}
		const row = lookup(ident);
		return {
			ident,
			serves: sellsGrade(row, types),
			refusal: fuelRefusal(row, types),
			access: fuelAccess(row?.cond),
		};
	});
}

/** The uplift point a load would refuse at, else null. A departure whose
 *  tanks already hold the load (`aboardL`, the fuel on board as read)
 *  uplifts nothing there, so its pump decides nothing: a second day leaving,
 *  on what it carried in, the dry field it landed at. */
function refusingPoint<S>(
	l: RefuelStrategy['loads'][number],
	points: readonly RefuelPoint<S>[],
	aboardL: number | null,
): RefuelPoint<S> | null {
	const pt = points[l.tripIndex];
	if (pt?.serves !== false) {
		return null;
	}
	return l.tripIndex === 0 && aboardL != null && aboardL >= l.litres - FUEL_EPS_L ? null : pt;
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
 *  readable about is not evidence against a plan. `aboardL` is the fuel on
 *  board at the departure (refusingPoint). */
export function strategyIsServed<S>(
	s: RefuelStrategy,
	points: readonly RefuelPoint<S>[],
	aboardL: number | null = null,
): boolean {
	return s.loads.every((l) => refusingPoint(l, points, aboardL) === null);
}

/** Each refuelling strategy flown through the chain at its own loads
 *  (tripLoads.ts checkStrategies), index-aligned with `plan.strategies`: where
 *  the strategies' arithmetic, fuel alone, meets the mass and the CG. Null
 *  without the trip loads or a plan. */
export function strategyChecks(
	comp: TripLoadsComputation | null,
	plan: RefuelPlan | null,
): StrategyCheck[] | null {
	return comp && plan ? checkStrategies(comp.input, plan.strategies) : null;
}

/** A strategy the pilot can actually fly: within the usable fuel, refuelling
 *  only where the AIP or a NOTAM does not refuse it, and within the limits
 *  the fuel decides at its own loads (unknown passes, as for the aerodromes).
 *  The one rule "Use this plan" and the recommendation share. */
export function strategyIsFlyable<S>(
	s: RefuelStrategy,
	points: readonly RefuelPoint<S>[],
	check: StrategyCheck | null | undefined,
	aboardL: number | null = null,
): boolean {
	return s.feasible && strategyIsServed(s, points, aboardL) && check?.withinLimits !== false;
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
	/** The arithmetic recommendation's check, carried only when it served
	 *  but broke a limit the fuel decides (so lost its place for that). */
	demotedLimits: StrategyCheck | null;
	/** Servable strategies exist, but none keeps the limits at its loads:
	 *  the payload is the problem. */
	noneWithinLimits: boolean;
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
	checks?: readonly (StrategyCheck | null)[] | null,
	aboardL: number | null = null,
): ServedRecommendation<S> {
	const none: ServedRecommendation<S> = {
		best: null,
		demoted: null,
		demotedAt: null,
		noneServed: false,
		demotedLimits: null,
		noneWithinLimits: false,
	};
	if (!plan || !plan.recommended) {
		return none;
	}
	const checkOf = (s: RefuelStrategy): StrategyCheck | null => checks?.[plan.strategies.indexOf(s)] ?? null;
	const rec = plan.recommended;
	const recServed = strategyIsServed(rec, points, aboardL);
	if (recServed && checkOf(rec)?.withinLimits !== false) {
		return { ...none, best: rec };
	}
	const served = plan.strategies.filter((s) => s.feasible && strategyIsServed(s, points, aboardL));
	const flyable = served.filter((s) => checkOf(s)?.withinLimits !== false);
	const blocked = rec.loads
		.map((l) => refusingPoint(l, points, aboardL))
		.find((pt): pt is RefuelPoint<S> => pt !== null);
	return {
		...none,
		best: pickRefuelStrategy(flyable),
		demoted: rec,
		demotedAt: recServed ? null : (blocked ?? null),
		noneServed: served.length === 0,
		demotedLimits: recServed ? checkOf(rec) : null,
		noneWithinLimits: served.length > 0 && flyable.length === 0,
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
