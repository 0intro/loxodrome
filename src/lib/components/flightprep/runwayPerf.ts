/* The performance page's runway recipe, one source for the page, its print
 * (PrintDoc mounts the same page) and the Overview: which runway END an
 * aerodrome's take-off or landing is computed on, from which conditions, and
 * what the flight manual's figures give there. Plain .ts reading app state,
 * no runes and no catalogs: the page keeps everything it shows (the weather
 * fields, the provenance strip's words, the titles), and which weather the
 * strip lists is decided here, beside the pick it reports (wxStrip).
 *
 * The context comes in and is never recomputed here: the mass is the trip
 * loads' (shared.ts perfMasses), whose computation (nav logs, fuel plans,
 * refuel subsets) is far too costly to repeat for every runway end a choice
 * weighs. */

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
import type { AircraftPerformance, ClosedFormConfig, OneEngineInoperative, TakeoffProcedure } from '$lib/aircraft/schema';
import { oeiLandingClimb, oeiTakeoffClimb, type ClimbVerdict } from '$lib/aircraft/oneEngine';
import {
	computeAccelerateStop,
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
	type PerformanceFigure,
	type TakeoffPick,
} from '$lib/aircraft/performance';
import { display } from '$lib/state/display.svelte';
import { ensureNearestMetar, nearestWx, usableNearest } from '$lib/state/weather.svelte';
import {
	aerodromeForecastAt,
	aerodromeForecasts,
	ensureAerodromeForecast,
	type AerodromeForecast,
} from '$lib/state/aerodromeForecast.svelte';
import type { AwcMetar } from '$lib/weather/awc';
import { qnhFromMetar, windComponents, type NearestPick, type WindComponents } from '$lib/weather/metar';
import { qnhFromStationPressure, reportedQnh, temperatureAtElevation } from '$lib/weather/qnh';

/** What every function here reads besides app state. */
export interface PerfCtx {
	perf: AircraftPerformance | null;
	/** A twin's one-engine data (the sheet's oneEngineInoperative), whose
	 *  climb the column judges against CAT.POL.A.340; absent for a single. */
	oei?: OneEngineInoperative | null | undefined;
	/** The mass this column is evaluated at (shared.ts perfMasses: its
	 *  trip's takeoff mass); the callers set it per column. */
	massKg: number | null;
	/** The shared minute tick's instant (perfNowMs), for METAR freshness. */
	nowMs: number;
	/** WMM epoch of the true-to-magnetic wind conversion, once per mount. */
	wmmYear: number;
	/** The instant the column's phase is flown at (shared.ts perfInstants:
	 *  its trip's ETD, or its ETA at a landing, off the Overview's
	 *  timeline; a phase no trip flies there, the aerodrome's other one);
	 *  absent or null when nothing times it (no ETD, an aerodrome added by
	 *  hand), and then the METAR alone speaks. */
	atMs?: number | null | undefined;
}

/** How long a METAR speaks for the hours after it: its TREND's two hours
 *  (ICAO Annex 3), a forecast for the two hours FROM the observation. A
 *  phase flown later reads the forecast at its own instant; one before the
 *  observation (an ETD left in the past) keeps the METAR, the conditions
 *  the take-off will actually meet. */
export const METAR_VALID_MS = 2 * 3600_000;

/** Where a column's automatic weather comes from. */
export type WxPick = { kind: 'metar'; pick: NearestPick } | { kind: 'forecast'; fc: AerodromeForecast };

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

/** The source a column's empty fields read, ONE for all four so a sheet
 *  never mixes an observation's wind with a forecast's QNH: the METAR when
 *  the phase instant is no more than its two hours after it (or nothing
 *  times the phase), else the forecast at that instant, else the METAR
 *  still (a forecast that does not reach), else none. Live weather off,
 *  none. */
export function wxPick(icao: string, ctx: PerfCtx): WxPick | null {
	const pick = liveMetar(icao, ctx);
	const at = ctx.atMs ?? null;
	if (pick && (at === null || at - pick.metar.obsTime * 1000 <= METAR_VALID_MS)) {
		return { kind: 'metar', pick };
	}
	const fc = at !== null && display.liveWeather ? aerodromeForecastAt(icao, at) : null;
	if (fc) {
		return { kind: 'forecast', fc };
	}
	return pick ? { kind: 'metar', pick } : null;
}

/** Ask for the forecast at every aerodrome whose columns are timed: the
 *  hours from the earliest to the latest of their instants. */
export function ensurePerfForecasts(columns: readonly { icao: string; atMs: number | null }[], opts: { retry?: boolean } = {}): Promise<void> {
	if (!display.liveWeather) {
		return Promise.resolve();
	}
	const spans = new Map<string, { from: number; to: number }>();
	for (const c of columns) {
		if (c.atMs === null) {
			continue;
		}
		const s = spans.get(c.icao);
		spans.set(c.icao, s ? { from: Math.min(s.from, c.atMs), to: Math.max(s.to, c.atMs) } : { from: c.atMs, to: c.atMs });
	}
	const waits: Promise<void>[] = [];
	for (const [icao, span] of spans) {
		const a = airportByIdent(icao);
		if (a) {
			waits.push(ensureAerodromeForecast(icao, a.lat, a.lon, span.from, span.to, opts));
		}
	}
	return Promise.all(waits).then(() => undefined);
}

/** Whether the automatic values are an ESTIMATE (dossier QNH, ISA, calm
 *  wind): live weather on and neither an observation nor a forecast for the
 *  column. With live weather off nothing live is expected and the same
 *  values are not flagged. */
export function weatherEstimated(icao: string, ctx: PerfCtx): boolean {
	return display.liveWeather && wxPick(icao, ctx) == null;
}

/** Whether the pilot has typed over any of this aerodrome's weather inputs:
 *  its QNH, or the temperature or wind of the phase given (either phase when
 *  none is). Those values no longer follow the observation, which whatever
 *  quotes the observation has to say, or a printed sheet contradicts itself
 *  (a cell reading 1005 beside a line quoting Q1018). */
export function hasTypedWeather(icao: string, phase?: PerfPhase): boolean {
	const a = perfFor(icao);
	const phases: readonly PerfPhase[] = phase ? [phase] : ['takeoff', 'landing'];
	return phases.some(
		(p) => a[p].qnhHpa != null || a[p].tempC != null || a[p].headwindKt != null || a[p].tailwindKt != null,
	);
}

/** The QNH the column's source gives: the METAR's, or the forecast's surface
 *  pressure reduced through the standard atmosphere and rounded down as a
 *  report rounds it (weather/qnh.ts). */
function sourcedQnh(src: WxPick | null): number | null {
	if (src?.kind === 'metar') {
		return qnhFromMetar(src.pick.metar);
	}
	const fc = src?.fc;
	return fc?.surfacePressureHpa != null ? reportedQnh(qnhFromStationPressure(fc.surfacePressureHpa, fc.modelElevationM)) : null;
}

/** The forecast's wind as a METAR states its own (whole knots, whole
 *  degrees): what the runway projection reads and the strip quotes. */
export function forecastWind(fc: AerodromeForecast): Pick<AwcMetar, 'wdir' | 'wspd' | 'wgst'> {
	return { wdir: Math.round(fc.windDirTrueDeg) % 360, wspd: Math.round(fc.windSpeedKt), wgst: null };
}

/** The column's source wind projected on a runway end, the forecast's
 *  rounded first (forecastWind); null when variable / missing or no
 *  source. */
export function sourcedWind(icao: string, end: RunwayEnd | null, ctx: PerfCtx): WindComponents | null {
	const src = wxPick(icao, ctx);
	const airport = airportByIdent(icao);
	if (!src || !airport || !end) {
		return null;
	}
	const wind = src.kind === 'metar' ? src.pick.metar : forecastWind(src.fc);
	return windComponents(wind, end.id, airport.lat, airport.lon, ctx.wmmYear);
}

/* What an EMPTY weather field holds. A grey placeholder is the value in
 * force, so each one below is at once what the field shows and what the
 * computation uses, and typing the value a field shows changes nothing, in
 * that field or any other. Three rules broke that. The automatic temperature
 * was computed unrounded and shown rounded (ISA at Lognes' 359 ft is 14.3,
 * AWC hands a US station's tenths over from its remarks), and so was a
 * dossier QNH typed with a decimal, so typing the figure shown moved the
 * distances. And a typed wind component, a typed 0 included, made the PAIR
 * explicit: beside an observed 5 kt headwind, typing the tailwind's own 0
 * computed calm air. */

/** Where an empty field's value comes from. */
export type AutoSource =
	/** The nearest usable METAR. */
	| 'metar'
	/** The forecast at the phase's own instant (wxPick). */
	| 'forecast'
	/** The Overview's Météo QNH. */
	| 'dossier'
	/** 1013 hPa: the pressure altitude is the elevation. */
	| 'standard'
	/** ISA at the pressure altitude. */
	| 'isa'
	/** No observation of the wind along the runway: calm air. */
	| 'calm'
	/** 0 because the other wind field holds a typed wind (autoWind). */
	| 'cancelled';

export interface AutoValue {
	value: number;
	source: AutoSource;
}

/** What each empty weather field of one phase holds, on its runway end. */
export interface PhaseAutos {
	qnhHpa: AutoValue;
	tempC: AutoValue;
	headwindKt: AutoValue;
	tailwindKt: AutoValue;
}

/** The standard pressure, where the pressure altitude is the elevation. */
export const STANDARD_QNH_HPA = 1013;

/** The QNH an empty field holds: the column's source's (wxPick), else the
 *  dossier's Météo default, else the standard. */
export function autoQnh(icao: string, ctx: PerfCtx): AutoValue {
	const src = wxPick(icao, ctx);
	const sourced = sourcedQnh(src);
	if (sourced != null && src) {
		return { value: sourced, source: src.kind };
	}
	const dossier = flightPrep.dossier.qnhHpa;
	return dossier != null ? { value: dossier, source: 'dossier' } : { value: STANDARD_QNH_HPA, source: 'standard' };
}

/** QNH chain: the phase's typed value, else autoQnh. */
export function effectiveQnh(icao: string, block: { qnhHpa: number | null }, ctx: PerfCtx): number {
	return block.qnhHpa ?? autoQnh(icao, ctx).value;
}

/** The temperature an empty field holds, to the whole degree the field
 *  shows: the column's source's (a forecast's 2 m temperature carried from
 *  the model's ground to the field's elevation), else ISA at the pressure
 *  altitude (15 °C while the elevation is unknown, which computes
 *  nothing). */
export function autoTempC(icao: string, paFt: number | null, ctx: PerfCtx): AutoValue {
	const src = wxPick(icao, ctx);
	if (src?.kind === 'metar' && src.pick.metar.temp != null) {
		return { value: Math.round(src.pick.metar.temp), source: 'metar' };
	}
	if (src?.kind === 'forecast' && src.fc.tempC != null) {
		const elevFt = airportByIdent(icao)?.elevFt;
		const t = elevFt == null ? src.fc.tempC : temperatureAtElevation(src.fc.tempC, src.fc.modelElevationM, elevFt * 0.3048);
		return { value: Math.round(t), source: 'forecast' };
	}
	return { value: Math.round(paFt == null ? 15 : isaTemperatureC(paFt)), source: 'isa' };
}

/** A typed component other than 0 states the wind along the runway. */
function statesWind(kt: number | null): boolean {
	return kt != null && kt !== 0;
}

/** The wind the column's source gives along a runway end (the METAR or the
 *  forecast at the phase instant, sourcedWind), calm without one. What the
 *  automatic runway choice weighs every end with (endRank, endHeadwind),
 *  never the typed components. */
function observedWind(icao: string, end: RunwayEnd | null, ctx: PerfCtx): { headwindKt: number; tailwindKt: number } {
	return sourcedWind(icao, end, ctx) ?? { headwindKt: 0, tailwindKt: 0 };
}

/** The wind an empty field holds along a runway end: the observation's
 *  component, except that a component the OTHER field contradicts reads 0.
 *  Along one runway the wind is a headwind or a tailwind, never both, so a
 *  typed tailwind cancels the observed headwind and a typed headwind the
 *  observed tailwind. A typed 0 contradicts nothing: "no tailwind" is what
 *  an observed headwind already says. */
export function autoWind(
	icao: string,
	block: PerfBlockInputs,
	end: RunwayEnd | null,
	ctx: PerfCtx,
): { headwindKt: AutoValue; tailwindKt: AutoValue } {
	const observed = sourcedWind(icao, end, ctx);
	const source: AutoSource = observed ? (wxPick(icao, ctx)?.kind ?? 'calm') : 'calm';
	return {
		headwindKt: statesWind(block.tailwindKt)
			? { value: 0, source: 'cancelled' }
			: { value: observed?.headwindKt ?? 0, source },
		tailwindKt: statesWind(block.headwindKt)
			? { value: 0, source: 'cancelled' }
			: { value: observed?.tailwindKt ?? 0, source },
	};
}

/** The wind pair a phase computes with on a runway end: each component typed,
 *  else automatic (autoWind). */
export function effectiveWind(
	icao: string,
	block: PerfBlockInputs,
	end: RunwayEnd | null,
	ctx: PerfCtx,
): { headwindKt: number; tailwindKt: number } {
	const auto = autoWind(icao, block, end, ctx);
	return {
		headwindKt: block.headwindKt ?? auto.headwindKt.value,
		tailwindKt: block.tailwindKt ?? auto.tailwindKt.value,
	};
}

/** The conditions of one aerodrome's phase block for a specific runway end,
 *  the single recipe the grid AND the nomogram path share; null until mass +
 *  elevation resolve. The wind is the phase's own along that end
 *  (effectiveWind) unless one is given: the automatic runway choice weighs
 *  each end with the wind observed along it (endRank). */
export function conditionsForEnd(
	icao: string,
	phase: PerfPhase,
	end: RunwayEnd | null,
	ctx: PerfCtx,
	wind: { headwindKt: number; tailwindKt: number } = effectiveWind(icao, perfFor(icao)[phase], end, ctx),
): PerfConditions | null {
	const airport = airportByIdent(icao);
	const block = perfFor(icao)[phase];
	const elevFt = airport?.elevFt ?? null;
	const paFt = elevFt == null ? null : pressureAltitudeFt(elevFt, effectiveQnh(icao, block, ctx));
	if (paFt == null || ctx.massKg == null) {
		return null;
	}
	return {
		massKg: ctx.massKg,
		pressureAltFt: paFt,
		temperatureC: block.tempC ?? autoTempC(icao, paFt, ctx).value,
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

function rowVerdict(
	phase: PerfPhase,
	result: PerfResult,
	dd: DeclaredDistancesM,
	asd: PerformanceFigure | null,
): DistanceVerdict | null {
	if (!result.ok) {
		return null;
	}
	return phase === 'takeoff' ? takeoffVerdict(result.value, dd, asd) : landingVerdict(result.value.distance15m, dd);
}

/** A twin's accelerate-stop distance at the conditions: the figure every
 *  take-off block's verdict reads; null for a landing or a sheet without
 *  one, and where its table gives no figure. */
function asdFigure(phase: PerfPhase, c: PerfConditions, perf: AircraftPerformance): PerformanceFigure | null {
	if (phase !== 'takeoff') {
		return null;
	}
	const r = computeAccelerateStop(perf, c);
	return r?.ok ? r.figure : null;
}

/** Every configuration of a phase, in the sheet's order, its figures and
 *  its own verdict: each flap block is judged on its own, a twin's
 *  accelerate-stop distance in every take-off block's. */
function phaseRows(
	phase: PerfPhase,
	c: PerfConditions,
	dd: DeclaredDistancesM,
	perf: AircraftPerformance,
): PerfRow[] {
	const asd = asdFigure(phase, c, perf);
	if (perf.kind === 'table') {
		const result = computeTablePerformance(perf, phase, c);
		return [
			{
				config: null,
				procedure: phase === 'takeoff' ? (perf.takeoffProcedure ?? null) : null,
				flapsDeg: (phase === 'takeoff' ? perf.takeoffFlapsDeg : perf.landingFlapsDeg) ?? null,
				result,
				verdict: rowVerdict(phase, result, dd, asd),
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
				verdict: rowVerdict(phase, result, dd, asd),
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
 *  short-field take-off, 2 when they do not, or cannot be computed.
 *
 *  Judged with the wind OBSERVED along that end, never the typed components.
 *  A typed wind has no direction, it is a figure along the runway it was
 *  typed beside, and credited to every end it made each reciprocal's
 *  tailwind a headwind: typing the 5 kt of headwind a placeholder showed on
 *  08 at Lognes moved a heavy Archer onto 26L, into a 5 kt tailwind computed
 *  as a headwind. The typed temperature, QNH and wet flag are the
 *  aerodrome's, and do count. */
function endRank(icao: string, phase: PerfPhase, end: RunwayEnd, ctx: PerfCtx): 0 | 1 | 2 {
	const perf = ctx.perf;
	const c = conditionsForEnd(icao, phase, end, ctx, observedWind(icao, end, ctx));
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
 *  never which runway is auto-selected (endRank's rule too). */
export function endHeadwind(icao: string, end: RunwayEnd, ctx: PerfCtx): number {
	const w = observedWind(icao, end, ctx);
	return w.headwindKt - w.tailwindKt;
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
	/** What each empty weather field holds on `end`, shown as its placeholder
	 *  and computed with. */
	autos: PhaseAutos;
	grass: boolean;
	rows: PerfRow[];
	dd: DeclaredDistancesM;
	/** Take-off: the procedure the runway calls for; null for a landing. */
	pick: TakeoffPick<PerfRow> | null;
	/** Landing: would a flapless landing fit (no margin, by decision)? null
	 *  for a take-off, or when unknown. */
	flapless: boolean | null;
	/** Take-off: a twin's accelerate-stop distance (computeAccelerateStop:
	 *  its figure and flags, or the table's top); null for a landing, a
	 *  sheet without one or a column without conditions. */
	asd: ReturnType<typeof computeAccelerateStop>;
	/** A twin's one-engine climb against CAT.POL.A.340 at this aerodrome
	 *  (the take-off legs, or the landing's); null for a single, a sheet
	 *  without a climb table or a column without conditions. */
	oei: ClimbVerdict | null;
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
	const qnh = autoQnh(icao, ctx);
	const paFt = elevFt == null ? null : pressureAltitudeFt(elevFt, inputs[phase].qnhHpa ?? qnh.value);
	const autos: PhaseAutos = {
		qnhHpa: qnh,
		tempC: autoTempC(icao, paFt, ctx),
		...autoWind(icao, inputs[phase], end, ctx),
	};
	const grass = end?.grass ?? false;
	const dd = end?.distances ?? NO_DD;
	const conditions = perf ? conditionsForEnd(icao, phase, end, ctx) : null;
	const rows = perf && conditions ? phaseRows(phase, conditions, dd, perf) : [];
	const landing = perf && phase === 'landing' ? landingRow(rows, perf) : null;
	const oei =
		ctx.oei && conditions
			? (phase === 'takeoff' ? oeiTakeoffClimb : oeiLandingClimb)(
					ctx.oei,
					conditions.massKg,
					conditions.pressureAltFt,
					conditions.temperatureC,
				)
			: null;
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
		autos,
		grass,
		rows,
		dd,
		pick: phase === 'takeoff' ? pickTakeoff(rows) : null,
		flapless:
			landing?.result.ok === true
				? flaplessFeasible(landing.result.value.distance15m.correctedM, dd, perf?.flaplessLandingFactor)
				: null,
		asd: perf && conditions && phase === 'takeoff' ? computeAccelerateStop(perf, conditions) : null,
		oei: oei && oei.sufficient !== null ? oei : null,
	};
}

/** Why no observation speaks for a column, from its aerodrome's
 *  nearest-METAR record (wxStrip). */
export type MetarGap =
	/** The first lookup is still out. */
	| { kind: 'fetching' }
	/** The lookup failed with nothing held. */
	| { kind: 'unavailable' }
	/** Nothing reports within 50 NM. */
	| { kind: 'no-station' }
	/** The observation held is too old to speak (usableNearest). */
	| { kind: 'stale'; pick: NearestPick };

/** One line of the weather strip: the columns of one aerodrome reading one
 *  source. */
interface WxLine {
	icao: string;
	/** The one column reading the line; null when both of the aerodrome's
	 *  do, and the line names no phase. */
	phase: PerfPhase | null;
	/** A weather field of a column it feeds is typed over, which the line
	 *  says, or the sheet contradicts itself (hasTypedWeather). */
	typed: boolean;
}

export interface WxMetarLine extends WxLine {
	pick: NearestPick;
	/** The QNH and the temperature its columns hold from it (autoQnh,
	 *  autoTempC): the one definition the fields show. */
	qnhHpa: number | null;
	tempC: number | null;
	/** The last refresh failed: the observation is the one held. */
	refreshFailed: boolean;
	/** The instants it stands in for the forecast at: a column flown past
	 *  its two hours whose forecast came back without that hour, or failed.
	 *  One still asked for says nothing yet. */
	noForecastAt: number[];
}

export interface WxForecastLine extends WxLine {
	fc: AerodromeForecast;
	/** The QNH and the temperature its columns hold from the forecast, null
	 *  where it gave none: the cell's estimate is then no forecast value. */
	qnhHpa: number | null;
	tempC: number | null;
}

export interface WxEstimateLine extends WxLine {
	metar: MetarGap;
	/** A timed column's forecast: still asked for, or none for its hour;
	 *  null when no column of the line is timed. */
	forecast: 'pending' | 'none' | null;
}

/** The weather strip, by kind: an observation and a forecast never share a
 *  list. */
export interface WxStrip {
	/** One line per aerodrome whose columns read its METAR, grid order. */
	metar: WxMetarLine[];
	/** One line per aerodrome and instant read from the forecast, in the
	 *  order they are flown (ties in grid order). */
	forecast: WxForecastLine[];
	/** One line per aerodrome whose columns read neither, grid order. */
	estimate: WxEstimateLine[];
}

const PHASES: readonly PerfPhase[] = ['takeoff', 'landing'];

/** The METAR record's state where it speaks for no column. */
function metarGap(icao: string): MetarGap {
	const rec = nearestWx(icao);
	if (!rec || (rec.status === 'loading' && !rec.metar)) {
		return { kind: 'fetching' };
	}
	if (!rec.metar || rec.distanceM == null) {
		return { kind: rec.status === 'error' ? 'unavailable' : 'no-station' };
	}
	return { kind: 'stale', pick: { metar: rec.metar, distanceM: rec.distanceM } };
}

/** What the performance page's strip lists: every column's source (wxPick),
 *  grouped by kind. A METAR no column reads is not listed: beside a plan
 *  for tomorrow read on the forecast, tonight's observation read as its
 *  equal. A stale one only says why an estimate is one. Empty with live
 *  weather off, where nothing live is expected. */
export function wxStrip(icaos: readonly string[], ctxOf: (icao: string, phase: PerfPhase) => PerfCtx): WxStrip {
	const strip: WxStrip = { metar: [], forecast: [], estimate: [] };
	if (!display.liveWeather) {
		return strip;
	}
	for (const icao of icaos) {
		const cols = PHASES.map((phase) => {
			const ctx = ctxOf(icao, phase);
			return { phase, ctx, atMs: ctx.atMs ?? null, src: wxPick(icao, ctx) };
		});
		const lineOf = (group: readonly { phase: PerfPhase }[]): WxLine => ({
			icao,
			phase: group.length === PHASES.length ? null : group[0].phase,
			typed: group.some((c) => hasTypedWeather(icao, c.phase)),
		});
		// No answer held yet: the request the page made is still out.
		const pending = aerodromeForecasts.byIcao[icao] === undefined;
		const observed = cols.filter((c) => c.src?.kind === 'metar');
		const src = observed[0]?.src;
		if (src?.kind === 'metar') {
			const obsMs = src.pick.metar.obsTime * 1000;
			const qnh = autoQnh(icao, observed[0].ctx);
			const temp = autoTempC(icao, null, observed[0].ctx);
			strip.metar.push({
				...lineOf(observed),
				pick: src.pick,
				qnhHpa: qnh.source === 'metar' ? qnh.value : null,
				tempC: temp.source === 'metar' ? temp.value : null,
				refreshFailed: nearestWx(icao)?.status === 'error',
				noForecastAt: pending
					? []
					: [...new Set(observed.flatMap((c) => (c.atMs !== null && c.atMs - obsMs > METAR_VALID_MS ? [c.atMs] : [])))].sort(
							(a, b) => a - b,
						),
			});
		}
		// Both columns read at one instant (a phase no trip flies there takes
		// the other's) make one line.
		const read = cols.filter((c) => c.src?.kind === 'forecast');
		for (const at of new Set(read.map((c) => c.atMs))) {
			const group = read.filter((c) => c.atMs === at);
			const first = group[0];
			if (first.src?.kind !== 'forecast') {
				continue;
			}
			const qnh = autoQnh(icao, first.ctx);
			const temp = autoTempC(icao, null, first.ctx);
			strip.forecast.push({
				...lineOf(group),
				fc: first.src.fc,
				qnhHpa: qnh.source === 'forecast' ? qnh.value : null,
				tempC: temp.source === 'forecast' ? temp.value : null,
			});
		}
		const unread = cols.filter((c) => c.src === null);
		if (unread.length > 0) {
			strip.estimate.push({
				...lineOf(unread),
				metar: metarGap(icao),
				forecast: unread.some((c) => c.atMs !== null) ? (pending ? 'pending' : 'none') : null,
			});
		}
	}
	// A stable sort: the lines of one instant keep the grid's order.
	strip.forecast.sort((a, b) => a.fc.atMs - b.fc.atMs);
	return strip;
}
