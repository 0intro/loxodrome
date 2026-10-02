/* The performance page's runway recipe, one source for the page, its print
 * (PrintDoc mounts the same page) and the Overview: which runway END an
 * aerodrome's take-off or landing is computed on, from which conditions, and
 * what the flight manual's figures give there. Plain .ts reading app state,
 * no runes and no catalogs: the page keeps everything it shows (the weather
 * fields, the provenance strip, the titles).
 *
 * The context comes in and is never recomputed here: the mass is the fuel
 * plan's M&B result, whose computation (nav logs, fuel plans, refuel
 * subsets) is far too costly to repeat for every runway end a choice weighs. */

import { airportByIdent } from '$lib/state/data.svelte';
import { flightPrep, perfFor, type PerfBlockInputs } from '$lib/state/flightPrep.svelte';
import {
	bestRunwayEnd,
	pickedRunwayEnd,
	runwayEnds,
	type DistanceOverrides,
	type RunwayEnd,
} from '$lib/aircraft/aerodromes';
import {
	onPublishedEnds,
	resolveAerodromeRunways,
	type RunwayResolution,
} from '$lib/state/runwayOverride.svelte';
import { resolveAerodromeState } from '$lib/state/aerodromeState.svelte';
import { plannedFlightAt } from '$lib/state/timeWindow.svelte';
import { notamState, type IndexedNotam } from '$lib/state/notam.svelte';
import type { Airport } from '$lib/data/airports';
import type { AircraftPerformance, ClosedFormConfig, TakeoffProcedure } from '$lib/aircraft/schema';
import {
	computeClosedFormPerformance,
	computeTablePerformance,
	flaplessFeasible,
	isaTemperatureC,
	landingVerdict,
	pickRank,
	pickTakeoff,
	pressureAltitudeFt,
	referenceConfig,
	takeoffVerdict,
	type DeclaredDistancesM,
	type DistanceVerdict,
	type PerfConditions,
	type PerfPhase,
	type PerfResult,
	type TakeoffPick,
} from '$lib/aircraft/performance';
import { display } from '$lib/state/display.svelte';
import { ensureNearestMetar, nearestWx, usableNearest } from '$lib/state/weather.svelte';
import { qnhFromMetar, windComponents, type NearestPick, type WindComponents } from '$lib/weather/metar';

/** What every function here reads besides app state. */
export interface PerfCtx {
	perf: AircraftPerformance | null;
	/** The mass the page evaluates at (shared.ts performanceMassKg). */
	massKg: number | null;
	/** The shared minute tick's instant (perfNowMs), for METAR freshness. */
	nowMs: number;
	/** WMM epoch of the true-to-magnetic wind conversion, once per mount. */
	wmmYear: number;
}

/** The shared empty answers, so a column with no NOTAM keeps its identity. */
const NO_CLOSURES: ReadonlyMap<string, IndexedNotam> = new Map<string, IndexedNotam>();
const NO_DISTANCES: DistanceOverrides = new Map();
const NO_DD: DeclaredDistancesM = { toraM: null, todaM: null, asdaM: null, ldaM: null };

/** Now, re-read on the shared 60 s tick: live ages and freshness gates
 *  re-evaluate with it. Call inside a $derived. */
export function perfNowMs(): number {
	void notamState.tick;
	return Date.now();
}

/** Fetch the nearest METAR of every aerodrome given (live weather on; the
 *  records cache for 5 minutes). The body of the page's effect, which also
 *  reads the minute tick so the fetch refreshes while the page is open. */
export function ensurePerfWeather(icaos: readonly string[]): void {
	if (!display.liveWeather) {
		return;
	}
	for (const icao of icaos) {
		const a = airportByIdent(icao);
		if (a) {
			ensureNearestMetar(icao, a.lat, a.lon);
		}
	}
}

/** The aerodrome's nearest METAR when it may supply defaults: live weather
 *  on, an observation on hand, station close enough, observation fresh
 *  enough (usableNearest). The fetch STATUS is deliberately not a gate:
 *  a refresh in flight or one that failed keeps the observation it had,
 *  and gating on it is what used to revert the whole grid to ISA for the
 *  length of a refetch, print included. */
export function liveMetar(icao: string, ctx: PerfCtx): NearestPick | null {
	return display.liveWeather ? usableNearest(nearestWx(icao), ctx.nowMs) : null;
}

/** Whether the automatic values are an ESTIMATE (dossier QNH, ISA, calm
 *  wind): live weather on and no usable observation. With live weather off
 *  nothing live is expected and the same values are not flagged. */
export function weatherEstimated(icao: string, ctx: PerfCtx): boolean {
	return display.liveWeather && liveMetar(icao, ctx) == null;
}

/** Whether the pilot has typed over any of this aerodrome's weather inputs:
 *  its QNH, or the temperature or wind of the phase given (either phase when
 *  none is). Those values no longer follow the observation, which whatever
 *  quotes the observation has to say, or a printed sheet contradicts itself
 *  (a cell reading 1005 beside a line quoting Q1018). */
export function hasTypedWeather(icao: string, phase?: PerfPhase): boolean {
	const a = perfFor(icao);
	if (a.qnhHpa != null) {
		return true;
	}
	const phases: readonly PerfPhase[] = phase ? [phase] : ['takeoff', 'landing'];
	return phases.some((p) => a[p].tempC != null || a[p].headwindKt != null || a[p].tailwindKt != null);
}

export function metarQnh(icao: string, ctx: PerfCtx): number | null {
	const pick = liveMetar(icao, ctx);
	return pick ? qnhFromMetar(pick.metar) : null;
}

/** METAR wind projected on a runway end (null when variable / missing
 *  or no usable station). */
export function metarWind(icao: string, end: RunwayEnd | null, ctx: PerfCtx): WindComponents | null {
	const pick = liveMetar(icao, ctx);
	const airport = airportByIdent(icao);
	if (!pick || !airport || !end) {
		return null;
	}
	return windComponents(pick.metar, end.id, airport.lat, airport.lon, ctx.wmmYear);
}

/** QNH chain: the per-aerodrome value > the nearest fresh METAR > the
 *  dossier's Météo default > standard (null: pressure altitude =
 *  elevation). */
export function effectiveQnh(icao: string, inputs: { qnhHpa: number | null }, ctx: PerfCtx): number | null {
	return inputs.qnhHpa ?? metarQnh(icao, ctx) ?? flightPrep.dossier.qnhHpa;
}

/** The wind pair a phase computes with: the typed components when either
 *  one is set (explicit, METAR ignored for the whole phase), else the
 *  METAR projection on the effective runway end, else calm. */
export function effectiveWind(
	icao: string,
	block: PerfBlockInputs,
	end: RunwayEnd | null,
	ctx: PerfCtx,
): { headwindKt: number; tailwindKt: number } {
	if (block.headwindKt != null || block.tailwindKt != null) {
		return { headwindKt: block.headwindKt ?? 0, tailwindKt: block.tailwindKt ?? 0 };
	}
	return metarWind(icao, end, ctx) ?? { headwindKt: 0, tailwindKt: 0 };
}

/** The conditions of one aerodrome's phase block for a specific runway end,
 *  the single recipe the grid AND the nomogram path share; null until mass +
 *  elevation resolve. */
export function conditionsForEnd(
	icao: string,
	phase: PerfPhase,
	end: RunwayEnd | null,
	ctx: PerfCtx,
): PerfConditions | null {
	const airport = airportByIdent(icao);
	const inputs = perfFor(icao);
	const block = inputs[phase];
	const elevFt = airport?.elevFt ?? null;
	const paFt = elevFt == null ? null : pressureAltitudeFt(elevFt, effectiveQnh(icao, inputs, ctx));
	const isaC = paFt == null ? null : isaTemperatureC(paFt);
	if (paFt == null || ctx.massKg == null) {
		return null;
	}
	const wind = effectiveWind(icao, block, end, ctx);
	return {
		massKg: ctx.massKg,
		pressureAltFt: paFt,
		temperatureC: block.tempC ?? liveMetar(icao, ctx)?.metar.temp ?? isaC ?? 15,
		headwindKt: wind.headwindKt - wind.tailwindKt,
		surface: { grass: end?.grass ?? false, wet: block.wet },
	};
}

export interface PerfRow {
	/** null for the table model (a single set), the flap config otherwise. */
	config: ClosedFormConfig | null;
	/** The take-off procedure the row's chart belongs to (a table's stated
	 *  one), null when the sheet names none or for a landing. */
	procedure: TakeoffProcedure | null;
	/** The flap setting the chart holds for, null when the sheet does not
	 *  say (a table charted at an unstated setting). */
	flapsDeg: number | null;
	result: PerfResult;
	/** Do the declared distances suffice with these figures? null when the
	 *  figures are not computable (pressure altitude above the table). */
	verdict: DistanceVerdict | null;
}

function rowVerdict(phase: PerfPhase, result: PerfResult, dd: DeclaredDistancesM): DistanceVerdict | null {
	if (!result.ok) {
		return null;
	}
	return phase === 'takeoff' ? takeoffVerdict(result.value, dd) : landingVerdict(result.value.distance15m, dd);
}

/** Every configuration of a phase, in the sheet's order, its figures and
 *  its own verdict: each flap block is judged on its own. */
function phaseRows(
	phase: PerfPhase,
	c: PerfConditions,
	dd: DeclaredDistancesM,
	perf: AircraftPerformance,
): PerfRow[] {
	if (perf.kind === 'table') {
		const result = computeTablePerformance(perf, phase, c);
		return [
			{
				config: null,
				procedure: phase === 'takeoff' ? (perf.takeoffProcedure ?? null) : null,
				flapsDeg: (phase === 'takeoff' ? perf.takeoffFlapsDeg : perf.landingFlapsDeg) ?? null,
				result,
				verdict: rowVerdict(phase, result, dd),
			},
		];
	}
	return perf.configs
		.filter((cfg) => cfg.phase === phase)
		.map((config) => {
			const result = computeClosedFormPerformance(perf, config, c);
			return {
				config,
				procedure: phase === 'takeoff' ? (config.procedure ?? null) : null,
				flapsDeg: config.flapsDeg,
				result,
				verdict: rowVerdict(phase, result, dd),
			};
		});
}

/** The landing row the landing verdict and the flapless check read: the
 *  config marked default (referenceConfig), or the table's one row. */
function landingRow(rows: readonly PerfRow[], perf: AircraftPerformance): PerfRow | null {
	if (perf.kind === 'table') {
		return rows[0] ?? null;
	}
	const ref = referenceConfig(perf, 'landing');
	return rows.find((r) => r.config === ref) ?? null;
}

/** What a runway end gives the automatic choice: 0 when its distances
 *  suffice with the normal take-off (or for the landing), 1 only with a
 *  short-field take-off, 2 when they do not, or cannot be computed. */
function endRank(icao: string, phase: PerfPhase, end: RunwayEnd, ctx: PerfCtx): 0 | 1 | 2 {
	const perf = ctx.perf;
	const c = conditionsForEnd(icao, phase, end, ctx);
	if (!perf || !c) {
		return 2;
	}
	const rows = phaseRows(phase, c, end.distances, perf);
	if (phase === 'takeoff') {
		return pickRank(pickTakeoff(rows));
	}
	return landingRow(rows, perf)?.verdict?.sufficient === true ? 0 : 2;
}

/** Signed headwind along a runway end from the live METAR, kt (negative =
 *  tailwind); 0 when no usable METAR. Ranks the into-wind choice off the
 *  real wind direction (per end), so a typed wind override (one component on
 *  the chosen runway, no direction) only changes that runway's numbers,
 *  never which runway is auto-selected. */
export function endHeadwind(icao: string, end: RunwayEnd, ctx: PerfCtx): number {
	const mw = metarWind(icao, end, ctx);
	return mw ? mw.headwindKt - mw.tailwindKt : 0;
}

/** The NOTAM state of an aerodrome's runways, judged over the PLANNED
 *  FLIGHT (plannedFlightAt): the page computes that flight's take-off and
 *  landing, so a runway shut from 13:00 marks a 15:00 departure however
 *  the map's period is set, and next month's shorter declared distance
 *  does not reach today's. Null for an ident the dataset does not hold.
 *  The maps come back keyed NORMALISED ('04'); everything here keys by
 *  `RunwayEnd.id`, the dataset's own spelling, hence onPublishedEnds
 *  below wherever a map leaves this function. */
export function runwaysOf(icao: string): { airport: Airport; res: RunwayResolution } | null {
	const airport = airportByIdent(icao);
	return airport ? { airport, res: resolveAerodromeRunways(airport, plannedFlightAt()) } : null;
}

/** The ends a NOTAM has closed over the flight (state/runwayOverride.svelte.ts).
 *  The AIP list is unchanged: a closed end stays in the picker, struck,
 *  because the pilot may still be asking what it would give. */
export function closedEnds(icao: string): ReadonlyMap<string, IndexedNotam> {
	const r = runwaysOf(icao);
	return r ? onPublishedEnds(r.airport, r.res.closed) : NO_CLOSURES;
}

/** The declared distances a NOTAM has RESTATED, which is the one override
 *  in this family that changes a number rather than striking a row: the
 *  verdicts are computed from TORA / TODA / ASDA / LDA, so reading the
 *  NOTAM is what keeps a take-off run measured against the runway that is
 *  there today (mechanism 18). */
export function distanceOverrides(icao: string): DistanceOverrides {
	const own = runwaysOf(icao);
	const r = own ? onPublishedEnds(own.airport, own.res.distances) : null;
	if (!r || r.size === 0) {
		return NO_DISTANCES;
	}
	const out = new Map<string, Partial<Record<'tora' | 'toda' | 'asda' | 'lda', number>>>();
	for (const [end, o] of r) {
		out.set(end, o.values);
	}
	return out;
}

/** Ends whose published figures a declared-distance NOTAM contradicts in
 *  a form the grammar would not act on. Silence would leave the AIP's own
 *  (usually longer) figure under the calculation, so the column says so. */
export function contestedEnds(icao: string): ReadonlyMap<string, IndexedNotam> {
	const r = runwaysOf(icao);
	return r ? onPublishedEnds(r.airport, r.res.contested) : NO_CLOSURES;
}

/** Has a NOTAM shut the FIELD over the flight (state/aerodromeState.svelte.ts)?
 *  Said over the column rather than acted on: the numbers stay exactly what
 *  the aerodrome would give, because a pilot asking what the runway yields
 *  is asking a question a closure does not answer, and a blanked column
 *  would say less than a computed one under the word CLOSED. */
export function fieldClosed(icao: string): string | null {
	const airport = airportByIdent(icao);
	return airport ? (resolveAerodromeState(airport, plannedFlightAt()).closed?.notam.id ?? null) : null;
}

/** The runway end a column uses: the pilot's explicit pick, else the default
 *  choice (the end needing the least, the normal take-off before the
 *  short-field one, then paved, then most into wind; see bestRunwayEnd).
 *  Shared by the grid and the nomogram so both always agree.
 *
 *  The automatic choice never lands on a runway a NOTAM has closed; an
 *  explicit pick is obeyed and marked instead, since refusing to compute
 *  what the pilot asked for would say less than computing it beside the
 *  word CLOSED. */
export function resolveEnd(icao: string, phase: PerfPhase, ctx: PerfCtx): RunwayEnd | null {
	const airport = airportByIdent(icao);
	const ends = airport ? runwayEnds(airport, distanceOverrides(icao)) : [];
	const block = perfFor(icao)[phase];
	const chosen = pickedRunwayEnd(ends, block.runwayEnd);
	if (chosen) {
		return chosen;
	}
	const closed = closedEnds(icao);
	const open = ends.filter((e) => !closed.has(e.id));
	return bestRunwayEnd(
		(open.length > 0 ? open : ends).map((end) => ({
			end,
			grass: end.grass,
			headwindKt: endHeadwind(icao, end, ctx),
			rank: endRank(icao, phase, end, ctx),
		})),
	);
}

/** Conditions for the column's resolved runway end (the nomogram path). */
export function columnConditions(icao: string, phase: PerfPhase, ctx: PerfCtx): PerfConditions | null {
	return conditionsForEnd(icao, phase, resolveEnd(icao, phase, ctx), ctx);
}

/** One aerodrome's phase as the page computes it, before any presentation. */
export interface PerfColumn {
	icao: string;
	airport: Airport | null;
	ends: RunwayEnd[];
	/** Ends a NOTAM has closed, by id. */
	closed: ReadonlyMap<string, IndexedNotam>;
	/** Ends whose published distances a NOTAM contradicts unreadably. */
	contested: ReadonlyMap<string, IndexedNotam>;
	/** The NOTAM that has closed the whole FIELD today, else null. */
	fieldClosed: string | null;
	end: RunwayEnd | null;
	elevFt: number | null;
	paFt: number | null;
	/** ISA at the pressure altitude, the temperature's automatic fallback. */
	isaC: number | null;
	grass: boolean;
	rows: PerfRow[];
	dd: DeclaredDistancesM;
	/** Take-off: the procedure the runway calls for; null for a landing. */
	pick: TakeoffPick<PerfRow> | null;
	/** Landing: would a flapless landing fit (no margin, by decision)? null
	 *  for a take-off, or when unknown. */
	flapless: boolean | null;
}

/** Compute one aerodrome's phase: its runway end, conditions, every flap
 *  config's figures and verdict, and the take-off procedure it calls for. */
export function perfColumn(icao: string, phase: PerfPhase, ctx: PerfCtx): PerfColumn {
	const perf = ctx.perf;
	const airport = airportByIdent(icao);
	const inputs = perfFor(icao);
	const ends = airport ? runwayEnds(airport, distanceOverrides(icao)) : [];
	const end = resolveEnd(icao, phase, ctx);
	const elevFt = airport?.elevFt ?? null;
	const paFt = elevFt == null ? null : pressureAltitudeFt(elevFt, effectiveQnh(icao, inputs, ctx));
	const isaC = paFt == null ? null : isaTemperatureC(paFt);
	const grass = end?.grass ?? false;
	const dd = end?.distances ?? NO_DD;
	const conditions = perf ? conditionsForEnd(icao, phase, end, ctx) : null;
	const rows = perf && conditions ? phaseRows(phase, conditions, dd, perf) : [];
	const landing = perf && phase === 'landing' ? landingRow(rows, perf) : null;
	return {
		icao,
		airport,
		ends,
		closed: closedEnds(icao),
		contested: contestedEnds(icao),
		fieldClosed: fieldClosed(icao),
		end,
		elevFt,
		paFt,
		isaC,
		grass,
		rows,
		dd,
		pick: phase === 'takeoff' ? pickTakeoff(rows) : null,
		flapless:
			landing?.result.ok === true
				? flaplessFeasible(landing.result.value.distance15m.correctedM, dd, perf?.flaplessLandingFactor)
				: null,
	};
}
