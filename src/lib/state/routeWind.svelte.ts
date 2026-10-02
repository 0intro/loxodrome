/* Per-route forecast winds (the routeTerrain ensure-pattern, two-tier).
 *
 * The NETWORK tier caches the fetched Open-Meteo columns per route, fetched
 * under coordinates + model + a span of hours (the plan's own and a day from
 * its start, routeFetchSpan) and READ by the place alone (coordinates +
 * model). They are refetched when a run of the model's covering the route
 * lands (forecastCache.ts), or when the plan leaves the hours they hold,
 * never on a clock: altitude edits, auto re-levelling and profile drags
 * cost zero network because the per-leg resolution (level bracketing,
 * valid-time chaining, the wind-corrected re-timing pass) runs as pure math
 * on read (route/legWind.ts). The columns carry the full level ladder +
 * temperatures, so any leg altitude resolves from one snapshot.
 *
 * Offline (docs/wind-aloft.md, "Offline"): what is held for a place is
 * never thrown away because the network is. A refresh in flight reads it,
 * a failed one keeps it and says since when, a re-timed plan reads the
 * hours it covers, and a flight in progress with no ETD is timed to its own
 * first fix, so its key stops rolling with the clock.
 *
 * Reactivity contract (routeTerrain verbatim): `routeWind.byRoute` is
 * written ONLY here and, on the synchronous ensure path, only inside
 * untrack(), so a host $effect calling ensureRouteWindFor never subscribes
 * to the cache through the call; consumers read effectiveRouteWinds() /
 * routeLegForecasts() inside their own deriveds and re-run once per
 * completed fetch. Freshness / abort / in-flight bookkeeping lives in plain
 * module records.
 *
 * ensureRouteWindFor returns its in-flight promise so the print flows can
 * await the winds exactly like they await MSA / terrain before snapshotting
 * (paper must match the screen). Departure times chain the flight-prep ETD
 * through the trips on still-air arrivals (hour-level anchoring; no
 * cross-trip forecast dependency); with no ETD, a flight being recorded is
 * timed to itself (the takeoff of the route it is flying), else the next
 * whole hour from now (never the Weather panel's valid time; that drives
 * only the map weather display). Every fetch is gated on display.liveWeather
 * and the useForecastForLegs planning flag. */

import { untrack } from 'svelte';
import { settleGuard } from './asyncCache';
import { routes, routeSettings, type Route, type Waypoint } from './route.svelte';
import { t } from './i18n.svelte';
import { effectiveCruiseSpeedKt } from './aircraft.svelte';
import { terrainCoordsKey } from './routeTerrain.svelte';
import { flightPrep, dossierFlightDate, dossierStopEffectiveMin } from './flightPrep.svelte';
import { display } from './display.svelte';
import { flightInProgress } from './navRoute.svelte';
import {
	animationWindow,
	effectiveWindModel,
	ensureModelRun,
	floorHourMs,
	modelRunMs,
	nextHourMs,
	runStampFor,
	stampIsCurrent,
	windAloft,
	windRuns,
} from './windAloft.svelte';
import { LruStore, covers, type RunStamp } from '$lib/weather/forecastCache';
import {
	FORECAST_MAX_AHEAD_DAYS,
	OpenMeteoError,
	cloudCoverProfileAt,
	columnReachMs,
	fetchWindColumns,
	forecastRangeEndMs,
	type WindColumn,
	type WindModelId,
} from '$lib/weather/openMeteo';
import { computeNavLog } from '$lib/route/navlog';
import { fmtWind } from '$lib/route/format';
import { orderedTrips } from '$lib/aircraft/trips';
import {
	SHEAR_ADVISORY_KT_PER_1000FT,
	effectiveLegWind,
	forecastCoverage,
	legMidpoints,
	legSegments,
	legTasKt,
	meanForecastWind,
	resolveRouteForecast,
	waypointOverride,
	chainDepartures,
	type EffectiveLegWind,
	type LegForecast,
	type LegSegment,
} from '$lib/route/legWind';
import type { CloudCoverSegment } from '$lib/route/routeProfile';
import { windTriangle } from '$lib/route/wind';

export interface RouteWindEntry {
	/** coords | model | hour window: the request last made, the fetch's
	 *  identity (dedupe, freshness). */
	key: string;
	/** coords | model: the PLACE the columns describe, which is all a read
	 *  needs to match (currentRouteWindEntry). A column is the forecast at
	 *  one point over hours, and any hour it holds reads true whatever window
	 *  asked for it, so a re-timed plan keeps reading the columns it has
	 *  until new ones land, and the hours they lack resolve as missing. */
	placeKey: string;
	/** The last columns fetched for that place, kept through a refresh in
	 *  flight, a failed one and a refused window: a forecast the app holds is
	 *  not thrown away because the network is (the phone in flight), and says
	 *  its age. Only another place or model, or the route's removal, drops
	 *  it. */
	columns: WindColumn[];
	model: WindModelId;
	/** When those columns were fetched, and the model run they came from as
	 *  known then (null when the run was not known yet); null with none. */
	fetchedMs: number | null;
	runMs: number | null;
	/** windRuns.newRunSeq when those columns were asked for: a run detected
	 *  since makes the run known NOW possibly not theirs. */
	runSeq: number | null;
	/** The model runs those columns were asked under (forecastCache.ts):
	 *  they stay the forecast until a run covering the route lands. */
	stamp: RunStamp | null;
	/** The hours those columns were requested for (their first and last):
	 *  a leg outside them is NOT COVERED by what is held, which says nothing
	 *  of the model's reach, the columns ending where their request did. */
	windowStartMs: number | null;
	windowEndMs: number | null;
	/** When a refresh last failed since those columns landed (the header
	 *  then says since when they are held); null once one succeeds. */
	failedMs: number | null;
	/** The forecast held for the place this route had before, kept until
	 *  columns for another place land: an offline edit undone (a pin dragged
	 *  by a bump in flight, then put back) finds its forecast again. */
	prior: HeldForecast | null;
	/** out-of-range: the departure sits past the endpoint's own window, so
	 *  no request was made (or the endpoint refused the one that was). */
	status: 'loading' | 'ready' | 'error' | 'out-of-range';
	/** Refines an 'error' for the header note, which is the difference
	 *  between "wait" and "not today": 'quota' = the day's or month's
	 *  budget is spent, which the backoff cannot outwait; 'rate-limit' = a
	 *  minute or hour window, already being retried. null otherwise. */
	errorKind: 'quota' | 'rate-limit' | null;
}

/** Columns held for one place, with their stamps (RouteWindEntry). */
export type HeldForecast = Pick<RouteWindEntry, 'placeKey' | HeldField>;

/** What an entry holds of its forecast, beside its request and status. */
type HeldField =
	| 'columns'
	| 'fetchedMs'
	| 'runMs'
	| 'runSeq'
	| 'stamp'
	| 'windowStartMs'
	| 'windowEndMs'
	| 'failedMs';

const HELD_NONE: Pick<RouteWindEntry, HeldField> = {
	columns: [],
	fetchedMs: null,
	runMs: null,
	runSeq: null,
	stamp: null,
	windowStartMs: null,
	windowEndMs: null,
	failedMs: null,
};

/** The held part of an entry, or of a prior place's forecast. */
function heldOf(h: Pick<RouteWindEntry, HeldField>): Pick<RouteWindEntry, HeldField> {
	return {
		columns: h.columns,
		fetchedMs: h.fetchedMs,
		runMs: h.runMs,
		runSeq: h.runSeq,
		stamp: h.stamp,
		windowStartMs: h.windowStartMs,
		windowEndMs: h.windowEndMs,
		failedMs: h.failedMs,
	};
}

export const routeWind = $state<{
	/** The WIND tier's entries, one column per leg (see Tier). */
	byRoute: Record<string, RouteWindEntry>;
	/** The CLOUD tier's entries, one column per leg segment, kept apart so a
	 *  curtain landing never re-runs a wind reader. */
	cloudsByRoute: Record<string, RouteWindEntry>;
	/** Bumped by the rate-limit retry timer; the MapView warm effect tracks
	 *  it so a quota rejection re-ensures after the minute. */
	retrySeq: number;
}>({ byRoute: {}, cloudsByRoute: {}, retrySeq: 0 });

// Plain (non-reactive) bookkeeping; see the reactivity contract above.
type Win = { startMs: number; endMs: number };

/** The two requests a route makes (docs/wind-aloft.md "Per-leg planning
 *  wind"). Its WINDS: one column per leg midpoint, the full level ladder
 *  with temperatures and the 10 m wind, which every wind and temperature
 *  reader reads (the legs, TAS, ISA, freezing level, level advisor, shear,
 *  mean wind, reach). Its CLOUDS: one column per leg segment, each level's
 *  height and cover and no wind, asked for only while something draws the
 *  curtain (the route profile with its Clouds layer, the dossier's printed
 *  profile). Each location costs a call per ten variables, so a 5-leg route
 *  asks for 21 calls of winds instead of the 78 its segments of everything
 *  cost, and the curtain's 30 only when shown. */
type Tier = 'wind' | 'cloud';

/** One tier's plain bookkeeping, per route. */
interface TierBook {
	lastKey: Record<string, string>;
	aborts: Record<string, AbortController>;
	inflight: Record<string, Promise<void>>;
	/** The request in flight: its place, the hours it asked for, and the runs
	 *  it was asked under. An ensure joins it while it covers the plan's
	 *  hours and no run has landed since. */
	inflightReq: Record<string, { placeKey: string; span: Win; stamp: RunStamp; atMs: number }>;
	/** The last request that failed, and when: asked again after
	 *  FAIL_RETRY_MS rather than at every minute tick. */
	failedReq: Record<string, { key: string; atMs: number }>;
	/** What the entry was last served from cells with (place and cells), so
	 *  the minute tick re-serving the same cells writes nothing: the entry is
	 *  a $state proxy no identity check against the cells would match. */
	servedSig: Record<string, string>;
}

function newBook(): TierBook {
	return { lastKey: {}, aborts: {}, inflight: {}, inflightReq: {}, failedReq: {}, servedSig: {} };
}

const books: Record<Tier, TierBook> = { wind: newBook(), cloud: newBook() };

/** A tier's entries ($state, written only here). */
function tierEntries(tier: Tier): Record<string, RouteWindEntry> {
	return tier === 'wind' ? routeWind.byRoute : routeWind.cloudsByRoute;
}

/** Where a tier asks: each leg's midpoint, or each leg segment's center. */
function tierPoints(tier: Tier, waypoints: Waypoint[]): { lat: number; lon: number }[] {
	return tier === 'wind' ? legMidpoints(waypoints) : legSegments(waypoints);
}

/** What a tier asks for there (openMeteo.ts hourlyVariables): the ladder's
 *  winds and temperatures, or its heights and clouds alone. */
function tierVariables(tier: Tier): { temps?: boolean; clouds?: boolean; winds?: boolean } {
	return tier === 'wind' ? { temps: true } : { winds: false, clouds: true };
}

/** One fetched column at one point (a leg midpoint, a segment center), with
 *  what its freshness and provenance read: the runs it was asked under, the
 *  hours it was asked for, when it landed, the run it is stamped with and
 *  the cycle count it was asked at. Kept per tier, model and point, so a
 *  route edited asks only for the points that moved, an edit undone asks for
 *  nothing, and two routes over the same legs (a trip and its return, an
 *  alternate) share them. */
interface RouteCell {
	col: WindColumn;
	stamp: RunStamp;
	runMs: number | null;
	runSeq: number;
	atMs: number;
	startMs: number;
	endMs: number;
}

/** Each tier's cells, bounded by the values they hold (a wind cell of a
 *  day's hours holds about 1 200, a cloud cell about 500). */
const CELL_STORE_MAX_VALUES = 300_000;

function columnValues(col: WindColumn): number {
	return col.timesMs.length * Math.max(1, Object.keys(col.hourly).length);
}

const cellStores: Record<Tier, LruStore<RouteCell>> = {
	wind: new LruStore<RouteCell>(CELL_STORE_MAX_VALUES, (c) => columnValues(c.col)),
	cloud: new LruStore<RouteCell>(CELL_STORE_MAX_VALUES, (c) => columnValues(c.col)),
};

function cellKey(model: WindModelId, p: { lat: number; lon: number }): string {
	return `${model}|${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
}

/** The held part of an entry made of cells: the columns in point order, the
 *  oldest landing (what "not refreshed since" says), the run they all share
 *  (else none: a provenance names one run or none), the oldest request's
 *  cycle count, a group's run where every cell's stamp agrees (else
 *  unknown), and the hours every cell holds. */
function heldFromCells(cells: readonly RouteCell[]): Pick<RouteWindEntry, HeldField> {
	const first = cells[0];
	const stamp: Record<string, number | null> = {};
	for (const k of Object.keys(first.stamp)) {
		const v = first.stamp[k] ?? null;
		stamp[k] = cells.every((c) => (c.stamp[k] ?? null) === v) ? v : null;
	}
	return {
		columns: cells.map((c) => c.col),
		fetchedMs: Math.min(...cells.map((c) => c.atMs)),
		runMs: cells.every((c) => c.runMs === first.runMs) ? first.runMs : null,
		runSeq: Math.min(...cells.map((c) => c.runSeq)),
		stamp,
		windowStartMs: Math.max(...cells.map((c) => c.startMs)),
		windowEndMs: Math.min(...cells.map((c) => c.endMs)),
		failedMs: null,
	};
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** How long a failed request waits before the minute tick asks it again (a
 *  gesture, another request and the network coming back ask at once). */
const FAIL_RETRY_MS = 30 * 60_000;
/** What one route request asks for past the start of the plan's own hours:
 *  a day, which costs no more than five hours (Open-Meteo weighs hours only
 *  past two weeks), and serves the hour rolling over, an ETD moved within
 *  the day and a cruise speed typed digit by digit with no request. */
const ROUTE_FETCH_AHEAD_MS = 24 * 3600_000;
/** Rate-limit retries back off exponentially (see windAloft.svelte.ts: a
 *  spent quota must not be hammered every minute), reset on success. */
const RATE_LIMIT_RETRY_MS = 66_000;
const RATE_LIMIT_RETRY_MAX_MS = 15 * 60_000;
let retryDelayMs = RATE_LIMIT_RETRY_MS;

function isoHour(ms: number): string {
	return new Date(ms).toISOString().slice(0, 13);
}

function routeCentroid(waypoints: Waypoint[]): { lat: number; lon: number } {
	let lat = 0;
	let lon = 0;
	for (const w of waypoints) {
		lat += w.lat;
		lon += w.lon;
	}
	const n = Math.max(1, waypoints.length);
	return { lat: lat / n, lon: lon / n };
}

/** The margins the fetch window keeps around the flight's own hours, for the
 *  re-timings a held forecast must still cover while no refetch reaches the
 *  network: the hour before the departure hour (a takeoff before the
 *  next-hour fallback it replaces, firstDepartureMs) and three after the
 *  arrival hour (the headwind pass that lengthens the flight, then that
 *  fallback's hourly roll at an aerodrome without coverage). They cost no
 *  API weight: Open-Meteo weighs a request by its variables and by periods
 *  beyond two weeks, never by a few hours. */
const WINDOW_BEFORE_MS = 3600_000;
const WINDOW_AFTER_MS = 3 * 3600_000;

/** The hour window ONE route fetch asks for: the flight's own span with its
 *  margins, widened to the animation slider's while that is engaged so a
 *  sweep never refetches the columns. Exported for the specs. */
export function routeFetchWindow(
	waypoints: Waypoint[],
	departureMs: number,
	cruiseKt: number | null,
	model: WindModelId,
): { startMs: number; endMs: number } {
	const durMin = computeNavLog(waypoints, cruiseKt).totalEteMin ?? 0;
	// Neither end may fall past the endpoint's own window: start_hour and
	// end_hour are BOTH range-checked, so a legal start with an end a day too
	// far answers 400 for the whole route rather than answering short. The
	// guard below refuses a start past it; an end past it is CUT instead, and
	// the legs it no longer covers resolve beyond-horizon off columnReachMs,
	// which is what they are. Reachable two ways: a departure near the 15-day
	// edge, and an animation whose span, being anchored on the shown hour, can
	// itself end on the last hour a long-horizon model answers.
	const capMs = forecastRangeEndMs(Date.now());
	const cut = (w: { startMs: number; endMs: number }): { startMs: number; endMs: number } => ({
		startMs: w.startMs,
		endMs: Math.max(w.startMs, Math.min(w.endMs, capMs)),
	});
	const own = {
		startMs: floorHourMs(departureMs) - WINDOW_BEFORE_MS,
		endMs: nextHourMs(departureMs + durMin * 60_000) + WINDOW_AFTER_MS,
	};
	const anchor = windAloft.animAnchorMs;
	if (anchor !== null) {
		// One fetch spans the whole animation slider (plus the flight time), so
		// scrubbing the map time never refetches the route columns; the key
		// derives from this window and stays stable across the sweep. It still
		// holds the flight's own hours, a departure after the slider's last
		// hour included. The slider's anchor is read as plain data on purpose:
		// resolving it here would mean importing state/wxTime.svelte.ts, which
		// imports this module for the departure below.
		const anim = animationWindow(model, anchor, Date.now());
		return cut({
			startMs: Math.min(own.startMs, anim.startMs),
			endMs: Math.max(own.endMs, anim.endMs + nextHourMs(durMin * 60_000) + 3600_000),
		});
	}
	return cut(own);
}

/** The place a route's columns describe: its coordinates and the model that
 *  forecasts them, the read guard's whole key (RouteWindEntry.placeKey). */
function routePlaceKey(waypoints: Waypoint[]): { placeKey: string; model: WindModelId } {
	const c = routeCentroid(waypoints);
	const model = effectiveWindModel(c.lat, c.lon);
	return { placeKey: `${terrainCoordsKey(waypoints)}|${model}`, model };
}

/** The hours ONE route request asks for: the plan's own (routeFetchWindow,
 *  what the legs need) and a day from their start, cut at the endpoint's
 *  range. Exported for the specs. */
export function routeFetchSpan(need: Win, nowMs = Date.now()): Win {
	const capMs = forecastRangeEndMs(nowMs);
	return {
		startMs: need.startMs,
		endMs: Math.max(need.startMs, Math.min(Math.max(need.endMs, need.startMs + ROUTE_FETCH_AHEAD_MS), capMs)),
	};
}

/** The model that forecasts a route, as its next request would name it
 *  (the auto model at its centroid, else the one picked). Tracked. */
export function routeForecastModel(route: Route): WindModelId {
	return routePlaceKey(route.waypoints).model;
}

/** A route request's identity (place and span), and the hours its legs
 *  need, which a held span serves while it covers them. */
function routeWindKeyFor(
	waypoints: Waypoint[],
	departureMs: number,
	cruiseKt: number | null,
): { key: string; placeKey: string; model: WindModelId; need: Win; span: Win } {
	const { placeKey, model } = routePlaceKey(waypoints);
	const need = routeFetchWindow(waypoints, departureMs, cruiseKt, model);
	const span = routeFetchSpan(need);
	return { key: `${placeKey}|${isoHour(span.startMs)}|${isoHour(span.endMs)}`, placeKey, model, need, span };
}

/** The first-departure instant: the flight-prep ETD on its flight date when
 *  set, else the next whole hour from now but never before the flight's own
 *  day begins. It never reads the Weather panel back (that would be a loop:
 *  the panel's own default is this instant under a Flight period,
 *  state/wxTime.svelte.ts), and the ETD read is tracked on purpose, so editing
 *  it re-resolves the winds on both surfaces at once.
 *
 *  The day floor is what keeps the fallback on the flight the pilot stated:
 *  without it a flight dated next week anchored its winds, its trip chaining
 *  and its TEMSI / WINTEM prefetch on today, silently answering for the wrong
 *  day. Midnight is the same anchor chartsPrefetch already uses for a dated
 *  timeline, and with no ETD there is nothing finer to know. It is a FALLBACK,
 *  never a stated time: a surface that would show the pilot a clock reading
 *  gates on `dossier.departureTime` itself (navLive's ETO column, the dossier
 *  timeline, the Flight evaluation window).
 *
 *  A flight IN PROGRESS with no ETD stated is timed to itself
 *  (flightInProgress, over the recorded trace): the route it is flying
 *  departed at its takeoff, and the route it is about to fly (on the ground,
 *  before the takeoff or at the next field of the plan) at the next whole
 *  hour, the plan's chain placed around THAT route, so a return trip flown
 *  after a stop is not timed a stop and a trip late. Its forecast is then
 *  the flight's, and the fallback stops rolling under it in the air, which
 *  rolled the cache key and refetched every hour of the flight, offline
 *  included. A stated ETD still wins, the plan the pilot printed, and so
 *  does a dossier dated AFTER the flight's day, the flight in progress not
 *  being the flight it plans; a dossier dated before it (a plan flown
 *  again) does not. */
export function firstDepartureMs(): number {
	const t = flightPrep.dossier.departureTime;
	if (t) {
		const ms = Date.parse(`${dossierFlightDate()}T${t}:00Z`);
		if (Number.isFinite(ms)) {
			return ms;
		}
	}
	const dayMs = Date.parse(`${dossierFlightDate()}T00:00:00Z`);
	const fallbackMs = Number.isFinite(dayMs)
		? Math.max(dayMs, nextHourMs(Date.now()))
		: nextHourMs(Date.now());
	const flight = flightInProgress();
	const dated = flightPrep.dossier.flightDate;
	if (flight && (!dated || dated <= isoHour(flight.departureMs ?? Date.now()).slice(0, 10))) {
		return (flight.departureMs ?? fallbackMs) - tripOffsetMs(flight.routeId);
	}
	return fallbackMs;
}

/** How long after the plan's first departure `routeId` departs, along the
 *  trip chain (still-air trips + ground stops); an alternate departs at its
 *  trip's arrival. 0 for a route outside the chain, and for none. */
function tripOffsetMs(routeId: string | null): number {
	if (routeId == null) {
		return 0;
	}
	const trips = orderedTrips(routes.list);
	const idx = trips.findIndex((t) => t.route.id === routeId || t.alternate?.id === routeId);
	if (idx < 0) {
		return 0;
	}
	const stills = trips.map((t) => computeNavLog(t.route.waypoints, effectiveCruiseSpeedKt()).totalEteMin);
	const stops = trips.map((_, i) => dossierStopEffectiveMin(i));
	const chain = chainDepartures(stills, stops, 0);
	return trips[idx].alternate?.id === routeId ? chain[idx].arrivalMs : chain[idx].departureMs;
}

/** The route's planned departure: the ETD chained through the preceding
 *  trips (still-air arrivals + ground stops); an alternate departs at its
 *  trip's arrival. Routes outside the trip chain use the base time. */
export function routeDepartureMs(routeId: string): number {
	return firstDepartureMs() + tripOffsetMs(routeId);
}

/** The two switches every forecast read and fetch obeys. */
function forecastOn(): boolean {
	return display.liveWeather && windAloft.useForecastForLegs;
}

/** What a new write of a route's entry keeps of the one before it, for
 *  `placeKey`: the forecast held for that place, its own or the prior
 *  place's (an edit undone), with the other kept as the prior; for a place
 *  it holds nothing for, none, the forecast it had becoming the prior. */
function heldFor(
	tier: Tier,
	routeId: string,
	placeKey: string,
): Pick<RouteWindEntry, HeldField | 'prior'> {
	const prev = tierEntries(tier)[routeId];
	const own: HeldForecast | null =
		prev && prev.columns.length > 0 ? { placeKey: prev.placeKey, ...heldOf(prev) } : null;
	const prior = prev?.prior ?? null;
	if (own && own.placeKey === placeKey) {
		return { ...heldOf(own), prior };
	}
	if (prior && prior.placeKey === placeKey) {
		return { ...heldOf(prior), prior: own };
	}
	return { ...HELD_NONE, prior: own ?? prior };
}

/** The entry for a window the endpoint does not serve. What is held for the
 *  place stays, its hours reading as missing for a date they do not reach,
 *  so a date typed wrong offline and put back finds its forecast again. */
function outOfRangeEntry(
	tier: Tier,
	routeId: string,
	key: string,
	placeKey: string,
	model: WindModelId,
): RouteWindEntry {
	return { key, placeKey, model, status: 'out-of-range', errorKind: null, ...heldFor(tier, routeId, placeKey) };
}

/** Start (or keep) the forecast fetch for a route. Cheap when what is held
 *  for the place is still the model's run and covers the plan's hours.
 *  Resolves once the route's request has settled, following one that
 *  superseded it meanwhile, so a print prep awaiting it reads the forecast it
 *  will print. `retry` is a pilot's gesture, a print: a refresh that failed
 *  is asked again now, not at FAIL_RETRY_MS (a save keeps the pacing: it
 *  snapshots a wind, and must not wait on a portal's timeout). Gated off
 *  (idle, aborting any run) while live weather or the forecast-legs option
 *  is disabled. */
export function ensureRouteWindFor(route: Route, opts: { retry?: boolean } = {}): Promise<void> {
	return ensureTier(route, 'wind', opts);
}

/** The same for the route's CLOUD columns, which only the cloud curtain
 *  reads (routeCloudCover): called while the route profile draws it and by
 *  the dossier's print prep, never by the warm effect, so a plan whose
 *  profile is never opened never asks for them. */
export function ensureRouteCloudsFor(route: Route, opts: { retry?: boolean } = {}): Promise<void> {
	return ensureTier(route, 'cloud', opts);
}

function ensureTier(route: Route, tier: Tier, opts: { retry?: boolean }): Promise<void> {
	const routeId = route.id;
	const book = books[tier];
	const entries = tierEntries(tier);
	if (!display.liveWeather || !windAloft.useForecastForLegs || route.waypoints.length < 2) {
		book.aborts[routeId]?.abort();
		delete book.aborts[routeId];
		delete book.lastKey[routeId];
		delete book.inflight[routeId];
		delete book.inflightReq[routeId];
		return Promise.resolve();
	}
	const departureMs = routeDepartureMs(routeId);
	const cruiseKt = effectiveCruiseSpeedKt();
	const { key, placeKey, model, need, span } = routeWindKeyFor(route.waypoints, departureMs, cruiseKt);
	// Tracked reads on purpose, ahead of every exit below so a joining or a
	// served caller subscribes too: the warm effect re-ensures when a run
	// lands (stampIsCurrent reads the polled runs) and when a new cycle is
	// detected (newRunSeq, which the provenance reads).
	const runSeq = windRuns.newRunSeq;
	// The run the provenance names, and the runs the freshness reads, are
	// this model's, polled whatever model the map centre is on (paced and
	// deduped inside).
	ensureModelRun(model);
	const points = tierPoints(tier, route.waypoints);
	const nowMs = Date.now();
	// A request in flight for this place is JOINED, never restarted, while it
	// covers the plan's hours and no run has landed since it was asked: the
	// minute tick, a sheet's own effect and a print prep all ensure, and each
	// restart threw away a refresh still on its way (on a slow link, possibly
	// every one of them). One asked under an older cycle is not joined: it is
	// refetched, as the stale entry it would make would be.
	const running: Promise<void> | undefined = book.inflight[routeId];
	const req = book.inflightReq[routeId];
	if (
		running !== undefined &&
		req !== undefined &&
		req.placeKey === placeKey &&
		covers(req.span, need.startMs, need.endMs) &&
		stampIsCurrent(req.stamp, req.atMs, model, points, nowMs)
	) {
		return settled(book, routeId);
	}
	// What is held for this place (its own forecast, or the prior place's
	// for an edit undone) serves while it is still the model's run and its
	// hours cover the plan's: no clock refreshes it, only a run landing does
	// (docs/wind-aloft.md "Auto-refresh"). A refresh asked for hours no longer
	// needed (a plan re-timed, then put back) is dropped, and nothing is
	// said to be failing: what is held is the forecast.
	const held = untrack((): (Pick<RouteWindEntry, HeldField> & { key: string | null }) | null => {
		const e = entries[routeId];
		if (e && e.placeKey === placeKey && e.columns.length > 0) {
			return { key: e.key, ...heldOf(e) };
		}
		if (e?.prior && e.prior.placeKey === placeKey) {
			return { key: null, ...heldOf(e.prior) };
		}
		return null;
	});
	const heldWindow =
		held && held.windowStartMs != null && held.windowEndMs != null
			? { startMs: held.windowStartMs, endMs: held.windowEndMs }
			: null;
	if (
		held &&
		covers(heldWindow, need.startMs, need.endMs) &&
		held.stamp !== null &&
		held.fetchedMs !== null &&
		stampIsCurrent(held.stamp, held.fetchedMs, model, points, nowMs)
	) {
		book.aborts[routeId]?.abort();
		delete book.aborts[routeId];
		delete book.inflight[routeId];
		delete book.inflightReq[routeId];
		book.lastKey[routeId] = held.key ?? key;
		untrack(() => {
			const e = entries[routeId];
			if (
				e?.placeKey !== placeKey ||
				e.status !== 'ready' ||
				e.errorKind !== null ||
				e.failedMs !== null
			) {
				entries[routeId] = {
					key: held.key ?? key,
					placeKey,
					model,
					status: 'ready',
					errorKind: null,
					...heldFor(tier, routeId, placeKey),
					failedMs: null,
				};
			}
		});
		return Promise.resolve();
	}
	// Per point: a column held for this model at this very point, still the
	// model's run there and holding the plan's hours, serves whatever request
	// fetched it. Every point served, the route asks for nothing (an edit
	// undone, a return over the outbound legs); otherwise it asks only for
	// the points none serves (the legs an edit moved).
	const store = cellStores[tier];
	const reuse = points.map((pt) => {
		const c = store.get(cellKey(model, pt));
		return c && covers(c, need.startMs, need.endMs) && stampIsCurrent(c.stamp, c.atMs, model, [pt], nowMs)
			? c
			: null;
	});
	if (reuse.every((c) => c !== null)) {
		const cells = reuse;
		book.aborts[routeId]?.abort();
		delete book.aborts[routeId];
		delete book.inflight[routeId];
		delete book.inflightReq[routeId];
		book.lastKey[routeId] = key;
		const sig = `${placeKey}|${cells.map((c) => `${c.atMs}:${c.startMs}:${c.endMs}`).join(',')}`;
		untrack(() => {
			const e = entries[routeId];
			if (book.servedSig[routeId] === sig && e?.placeKey === placeKey && e.status === 'ready') {
				return;
			}
			book.servedSig[routeId] = sig;
			entries[routeId] = {
				key,
				placeKey,
				model,
				status: 'ready',
				errorKind: null,
				...heldFor(tier, routeId, placeKey),
				...heldFromCells(cells),
			};
		});
		return Promise.resolve();
	}
	// A departure past the endpoint's own window (FORECAST_MAX_AHEAD_DAYS)
	// can only ever answer 400: refuse it here rather than discovering it
	// upstream, so a plan made weeks ahead costs no request at all. The
	// state write is guarded because the minute tick re-enters and a
	// same-value $state assignment would still notify every consumer.
	// Judged on the departure hour, not on the window's margin before it,
	// which would otherwise let a departure in the first hour past the range
	// ask for the hour before it and read as beyond the horizon.
	const rangeEndMs = forecastRangeEndMs(nowMs);
	if (floorHourMs(departureMs) > rangeEndMs) {
		book.aborts[routeId]?.abort();
		delete book.aborts[routeId];
		delete book.inflight[routeId];
		delete book.inflightReq[routeId];
		book.lastKey[routeId] = key;
		untrack(() => {
			const prev = entries[routeId];
			if (prev?.status !== 'out-of-range' || prev.key !== key) {
				entries[routeId] = outOfRangeEntry(tier, routeId, key, placeKey, model);
			}
		});
		return Promise.resolve();
	}
	// A request that failed is asked again after FAIL_RETRY_MS, not at every
	// minute tick (docs/wind-aloft.md "Auto-refresh": every failure is
	// stamped into its cache); another request (a route edit, a model swap,
	// hours the last one did not ask for), a gesture and the network coming
	// back ask at once. A spent quota waits for its own day whoever asks.
	const failed = book.failedReq[routeId];
	if (failed && failed.key === key && nowMs - failed.atMs < FAIL_RETRY_MS) {
		const quota = untrack(() => entries[routeId]?.errorKind === 'quota');
		if (opts.retry !== true || quota) {
			return settled(book, routeId);
		}
	}
	// While a rate-limit retry is scheduled, the backoff timer is the sole
	// re-entry path (it nulls itself before bumping retrySeq); the minute
	// tick must not hammer a spent quota. A request it holds back (the plan
	// re-timed or edited meanwhile) is said to wait on the rate limit, with
	// what is held for its place: left as it was, the entry read the held
	// window against a plan it was never fetched for.
	if (retryTimer) {
		untrack(() => {
			if (entries[routeId]?.key !== key) {
				entries[routeId] = {
					key,
					placeKey,
					model,
					status: 'error',
					errorKind: 'rate-limit',
					...heldFor(tier, routeId, placeKey),
				};
			}
		});
		return settled(book, routeId);
	}
	book.lastKey[routeId] = key;
	book.aborts[routeId]?.abort();
	const ctrl = new AbortController();
	book.aborts[routeId] = ctrl;
	// The runs as known when asked: a run landing while the request is out
	// leaves the columns one behind, refetched at the next ensure.
	const stamp = untrack(() => runStampFor(model));
	book.inflightReq[routeId] = { placeKey, span, stamp, atMs: nowMs };
	const current = settleGuard(ctrl.signal, () => book.lastKey[routeId] === key);
	// The forecast held for this place stays readable while its refresh is
	// in flight (currentRouteWindEntry reads the place, not the status).
	untrack(() => {
		entries[routeId] = {
			key,
			placeKey,
			model,
			status: 'loading',
			errorKind: null,
			...heldFor(tier, routeId, placeKey),
		};
	});
	// A refresh that fails keeps that forecast, stamped with the failure so
	// the header says since when it is held: a forecast the app holds is not
	// thrown away because the network is, the phone in flight without data.
	const settleFailed = (errorKind: RouteWindEntry['errorKind']): void => {
		book.failedReq[routeId] = { key, atMs: Date.now() };
		entries[routeId] = {
			key,
			placeKey,
			model,
			status: 'error',
			errorKind,
			...heldFor(tier, routeId, placeKey),
			failedMs: Date.now(),
		};
	};
	// One column per leg midpoint (winds) or per leg segment (clouds), all
	// in ONE batched request (see Tier). The run the figures will be stamped
	// with, as known when asked: a run
	// detected while the fetch is out leaves unknown which one answered.
	const runAtStart = untrack(() => modelRunMs(model));
	// The span already ends at the range (routeFetchSpan cuts it, the
	// endpoint range-checking end_hour too); clamped again to this ensure's
	// own reading of the range, the belt for a span computed a moment before
	// UTC midnight. The columns then simply stop early and the legs past them
	// read as beyond-horizon, which is what they are.
	const fetchEndMs = Math.min(span.endMs, rangeEndMs);
	// The points no held column serves, and the cells serving the rest as
	// they stood when asked (an eviction meanwhile loses nothing).
	const asked = points.filter((_, i) => reuse[i] === null);
	const p = fetchWindColumns(asked, {
		model,
		startMs: span.startMs,
		endMs: fetchEndMs,
		...tierVariables(tier),
		signal: ctrl.signal,
	})
		.then((columns) => {
			retryDelayMs = RATE_LIMIT_RETRY_MS;
			if (!current()) {
				return;
			}
			// A 200 carrying no forecast, a captive portal's page or a body
			// cut short, decodes to fewer columns than points: a failed
			// refresh, never an answer that would replace the forecast held.
			if (columns.length !== asked.length) {
				settleFailed(null);
				return;
			}
			delete book.failedReq[routeId];
			const landedMs = Date.now();
			const runMs = modelRunMs(model) === runAtStart ? runAtStart : null;
			let j = 0;
			const cells = points.map((pt, i): RouteCell => {
				const held = reuse[i];
				if (held) {
					return held;
				}
				const cell: RouteCell = {
					col: columns[j++],
					stamp,
					runMs,
					runSeq,
					atMs: landedMs,
					startMs: span.startMs,
					endMs: fetchEndMs,
				};
				store.set(cellKey(model, pt), cell);
				return cell;
			});
			entries[routeId] = {
				key,
				placeKey,
				model,
				status: 'ready',
				errorKind: null,
				...heldFromCells(cells),
				// Columns for this place landed: the place before is dropped
				// (its cells stay held, should an edit be undone).
				prior: null,
			};
		})
		.catch((err: unknown) => {
			if (!current()) {
				return;
			}
			// A refused window is not a failure to retry but a fact to state,
			// even when the pre-flight guard above let it through (the
			// endpoint's own ceiling is the authority on its dates).
			if (err instanceof OpenMeteoError && err.outOfRange) {
				book.failedReq[routeId] = { key, atMs: Date.now() };
				entries[routeId] = outOfRangeEntry(tier, routeId, key, placeKey, model);
				return;
			}
			const quota = err instanceof OpenMeteoError && err.quotaExhausted;
			const limited = err instanceof OpenMeteoError && err.rateLimited;
			settleFailed(quota ? 'quota' : limited ? 'rate-limit' : null);
			// A quota rejection heals itself: forget the failure so the next
			// ensure retries, and nudge the warm effect after the backoff
			// delay, the faster re-entry path. ONE timer for the whole burst:
			// every route limited at once used to re-arm it, doubling the
			// delay per route (six routes waited 15 min for one minute's
			// limit).
			if (limited) {
				delete book.lastKey[routeId];
				delete book.failedReq[routeId];
				if (!retryTimer) {
					retryTimer = setTimeout(() => {
						retryTimer = null;
						routeWind.retrySeq++;
					}, retryDelayMs);
					retryDelayMs = Math.min(retryDelayMs * 2, RATE_LIMIT_RETRY_MAX_MS);
				}
			}
		})
		.finally(() => {
			if (book.inflight[routeId] === p) {
				delete book.inflight[routeId];
				delete book.inflightReq[routeId];
			}
		});
	book.inflight[routeId] = p;
	return settled(book, routeId);
}

/** Resolves once the route's request has settled, following every request
 *  that superseded it meanwhile (a plan re-timed, the hour rolling over):
 *  what a print awaits is the forecast it will read, never a fetch aborted
 *  under it. Each fetch settles within its own timeout. */
async function settled(book: TierBook, routeId: string): Promise<void> {
	for (let p = book.inflight[routeId]; p !== undefined; p = book.inflight[routeId]) {
		await p;
	}
}

/** The network back ('online'): a refresh that failed is asked again now
 *  rather than after FAIL_RETRY_MS (the phone in flight crossing a town's
 *  coverage), through the warm effect's retry nudge, once the page is looked
 *  at; a spent quota waits for its own day, and a rate limit for its
 *  backoff. */
export function retryFailedRouteWinds(): void {
	let failed = false;
	for (const tier of ['wind', 'cloud'] as const) {
		for (const [id, e] of Object.entries(tierEntries(tier))) {
			if (e.status === 'error' && e.errorKind !== 'quota') {
				delete books[tier].failedReq[id];
				failed = true;
			}
		}
	}
	const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
	if (failed && !retryTimer && !hidden) {
		routeWind.retrySeq++;
	}
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
	window.addEventListener('online', retryFailedRouteWinds);
}

/** The route's WIND entry when it holds columns for the route's current
 *  PLACE (coordinates and model), one per leg (a count mismatch, e.g. across
 *  a mid-session code change, reads as none). The shared guard under every
 *  wind consumer, so none can read columns fetched for other points or
 *  another model. It reads the place and never the status or the hour
 *  window: a refresh in flight and a failed one both leave the held
 *  forecast readable, and a re-timed plan reads the hours the columns hold
 *  (the rest resolve as missing, the sampler reading only the hours it
 *  has). It reads no clock either. Tracked. */
function currentRouteWindEntry(route: Route): { entry: RouteWindEntry } | null {
	const entry = routeWind.byRoute[route.id];
	if (!entry || entry.columns.length === 0) {
		return null;
	}
	if (entry.placeKey !== routePlaceKey(route.waypoints).placeKey) {
		return null;
	}
	return entry.columns.length === route.waypoints.length - 1 ? { entry } : null;
}

/** The route's CLOUD entry under the same guard, one column per leg segment,
 *  paired with the segments (recomputed pure from the waypoints). Tracked. */
function currentRouteCloudEntry(route: Route): { entry: RouteWindEntry; segments: LegSegment[] } | null {
	const entry = routeWind.cloudsByRoute[route.id];
	if (!entry || entry.columns.length === 0) {
		return null;
	}
	if (entry.placeKey !== routePlaceKey(route.waypoints).placeKey) {
		return null;
	}
	const segments = legSegments(route.waypoints);
	return entry.columns.length === segments.length ? { entry, segments } : null;
}

/** The per-leg forecasts when columns are held for the route's current
 *  place (coordinates and model); null otherwise (blank MH / ETE-W over
 *  wrong values, the terrain convention). Each leg resolves off its own
 *  midpoint's column, the one point its winds are fetched at. A leg the held columns do not
 *  reach is NOT COVERED when it lies outside the hours they were requested
 *  for and they ran to the end of their request: their end is then the
 *  request's, not the model's, and a leg past it says nothing of the
 *  model's reach. Tracked. */
export function routeLegForecasts(route: Route): LegForecast[] | null {
	const cur = currentRouteWindEntry(route);
	if (!cur) {
		return null;
	}
	const departureMs = routeDepartureMs(route.id);
	const legCols = cur.entry.columns;
	const legs = resolveRouteForecast(legCols, route.waypoints, departureMs, effectiveCruiseSpeedKt());
	const { windowStartMs: from, windowEndMs: to } = cur.entry;
	if (from == null || to == null) {
		return legs;
	}
	return legs.map((f, i) => {
		if (f.ok || f.reason === 'not-covered') {
			return f;
		}
		const col = legCols[i];
		const reach = col ? columnReachMs(col) : null;
		const before = f.validTimeMs < from;
		const past = f.validTimeMs > to && reach != null && reach >= to;
		return before || past ? { ...f, reason: 'not-covered' } : f;
	});
}

/** The per-leg columns behind the SAME guard (each leg's midpoint, the full
 *  ladder + temps), for the level advisor's candidate scan; null while
 *  loading or keyed to stale inputs. Tracked. */
export function routeWindColumns(route: Route): (WindColumn | undefined)[] | null {
	const cur = currentRouteWindEntry(route);
	if (!cur) {
		return null;
	}
	return cur.entry.columns;
}

/** THE effective per-leg winds every consumer shares (nav-log sheet, trips
 *  and fuel, exports, RouteTab chips): override, then forecast (while
 *  enabled and resolved), then the global manual wind. One entry per leg;
 *  null = blank (no wind planned). */
export function effectiveRouteWinds(route: Route): (EffectiveLegWind | null)[] {
	const wps = route.waypoints;
	const global =
		routeSettings.windDirDeg != null && routeSettings.windSpeedKt != null
			? { dirDeg: routeSettings.windDirDeg, speedKt: routeSettings.windSpeedKt }
			: null;
	const forecastEnabled = windAloft.useForecastForLegs && display.liveWeather;
	const forecasts = forecastEnabled ? routeLegForecasts(route) : null;
	const out: (EffectiveLegWind | null)[] = [];
	for (let i = 0; i + 1 < wps.length; i++) {
		out.push(effectiveLegWind(waypointOverride(wps[i]), forecasts?.[i], global, forecastEnabled));
	}
	return out;
}

/** Per-leg ground speeds under the effective winds: EXACTLY the nav-log
 *  sheet's recipe (temperature-corrected TAS + windTriangle), so the
 *  schedule's ETE column and the sheet's ETE/W column, printed side by
 *  side in the dossier, always agree. Null per leg when no wind resolves,
 *  the triangle has no solution, or the cruise speed is unset. */
export function routeLegGroundSpeeds(route: Route): (number | null)[] {
	const cruise = effectiveCruiseSpeedKt();
	const legCount = Math.max(0, route.waypoints.length - 1);
	if (cruise == null || cruise <= 0) {
		return new Array<number | null>(legCount).fill(null);
	}
	const legs = computeNavLog(route.waypoints, cruise).legs;
	const winds = effectiveRouteWinds(route);
	return legs.map((leg, i) => {
		const ew = winds[i] ?? null;
		if (!ew) {
			return null;
		}
		const tas = legTasKt(cruise, ew.forecast?.tempC ?? null, route.waypoints[i].alt, windAloft.tempTas);
		return windTriangle(leg.trackTrueDeg, tas, ew.dirDeg, ew.speedKt)?.gsKt ?? null;
	});
}

/** Wind-corrected total ETE (minutes): each leg at its ground speed, legs
 *  without one falling back to still air at the cruise speed (the
 *  resolveRouteForecast re-timing convention; deliberately NOT the sheet's
 *  blank-total rule, so a single unsolvable leg cannot blank the title).
 *  Null when the cruise speed is unset. Shared by the profile titles and
 *  the Route tab summary. */
export function routeWindEteMin(route: Route): number | null {
	const cruise = effectiveCruiseSpeedKt();
	if (cruise == null || cruise <= 0 || route.waypoints.length < 2) {
		return null;
	}
	const legs = computeNavLog(route.waypoints, cruise).legs;
	const gs = routeLegGroundSpeeds(route);
	let min = 0;
	for (let i = 0; i < legs.length; i++) {
		const speed = gs[i];
		min += (legs[i].legNM / (speed != null && speed > 0 ? speed : cruise)) * 60;
	}
	return min;
}

/** Per-leg freezing-level altitudes (ft MSL) from the route forecast, for
 *  the profile curve; null per leg while unresolved or when freezing sits
 *  above the fetched ladder (the curve gaps there). */
export function routeFreezingLevelsFt(route: Route): (number | null)[] {
	// Gated like every forecast read: a held entry outlives the switches.
	const legs = forecastOn() ? routeLegForecasts(route) : null;
	if (!legs) {
		return new Array<number | null>(Math.max(0, route.waypoints.length - 1)).fill(null);
	}
	return legs.map((f) => (f.ok ? f.wind.freezingLevelFt : null));
}

/** Per-SEGMENT cloud-cover profiles (every ladder level resolved to its
 *  altitude), each with the distance span its column represents, for the
 *  profile's cloud curtain; null while the CLOUD columns are unresolved,
 *  keyed to stale inputs or never asked for (ensureRouteCloudsFor). The
 *  instants are the wind legs', so the curtain needs both. Deliberately NOT
 *  part of LegWindForecast: the curtain is display-only and no wind
 *  consumer reads it. Each segment samples at
 *  its own instant: the leg's valid time shifted still-air to the segment
 *  center (hour-level anchoring, the chainDepartures convention); segments
 *  beyond the model horizon sample to [] (the curtain gaps, the
 *  freezing-line convention). Tracked. */
export function routeCloudCover(route: Route): CloudCoverSegment[] | null {
	// Gated like every forecast read: a held entry outlives the switches.
	if (!forecastOn()) {
		return null;
	}
	const cur = currentRouteCloudEntry(route);
	const legs = routeLegForecasts(route);
	if (!cur || !legs) {
		return null;
	}
	const cruise = effectiveCruiseSpeedKt();
	// Per-leg mid distance (halfway between the leg's segment extremes; the
	// middle segment's center by construction), for the time offsets.
	const legFromNM: number[] = [];
	const legToNM: number[] = [];
	for (const seg of cur.segments) {
		legFromNM[seg.legIndex] = Math.min(legFromNM[seg.legIndex] ?? Infinity, seg.fromNM);
		legToNM[seg.legIndex] = Math.max(legToNM[seg.legIndex] ?? -Infinity, seg.toNM);
	}
	return cur.segments.map((seg, si) => {
		const f = legs[seg.legIndex];
		if (!f) {
			return { fromNM: seg.fromNM, toNM: seg.toNM, levels: [] };
		}
		const base = f.ok ? f.wind.validTimeMs : f.validTimeMs;
		const legMidNM = ((legFromNM[seg.legIndex] ?? seg.midNM) + (legToNM[seg.legIndex] ?? seg.midNM)) / 2;
		const t =
			cruise != null && cruise > 0 ? base + ((seg.midNM - legMidNM) / cruise) * 3600_000 : base;
		return { fromNM: seg.fromNM, toNM: seg.toNM, levels: cloudCoverProfileAt(cur.entry.columns[si], t) };
	});
}

/** The model run a held forecast came from, for its provenance: the run
 *  stamped when its columns landed; while none was known then, the run known
 *  now, unless a refresh has failed since or a new cycle was detected since
 *  they were asked for, the run known now then being possibly NOT the one
 *  they came from (a provenance must never name a run its figures were not
 *  computed from). */
function heldRunMs(entry: RouteWindEntry): number | null {
	if (entry.runMs != null) {
		return entry.runMs;
	}
	return entry.failedMs == null && entry.runSeq === windRuns.newRunSeq ? modelRunMs(entry.model) : null;
}

/** "14:05Z 4 Jul" (UTC). Reads the catalog month table, so it may only be
 *  called from the render-time builders below (never stored in state). */
function fmtZ(ms: number): string {
	const d = new Date(ms);
	const p = (n: number): string => String(n).padStart(2, '0');
	return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z ${d.getUTCDate()} ${t.common.months[d.getUTCMonth()]}`;
}

/** Multi-line hover text per leg for the nav-log MH / ETE-W cells and the
 *  RouteTab W/V chip: the wind value, its source (model, run, valid time,
 *  level, temperature) or the fallback reason. Null on legs with no wind.
 *  Text is built from t.navlog at call time (the callers read this inside
 *  $derived, so a locale switch re-renders); nothing translated is stored. */
export function routeLegWindTips(route: Route): (string | null)[] {
	const winds = effectiveRouteWinds(route);
	const forecastEnabled = windAloft.useForecastForLegs && display.liveWeather;
	const forecasts = forecastEnabled ? routeLegForecasts(route) : null;
	const held = currentRouteWindEntry(route)?.entry ?? null;
	const label = held ? t.weather.windModels[held.model] : t.navlog.forecastFallback;
	const run = held ? heldRunMs(held) : null;
	const cruise = effectiveCruiseSpeedKt();
	return winds.map((ew, i) => {
		if (!ew) {
			return null;
		}
		const lines: string[] = [t.navlog.windTip(fmtWind(ew.dirDeg, ew.speedKt))];
		if (ew.source === 'forecast' && ew.forecast) {
			const f = ew.forecast;
			if (f.belowGround) {
				lines[0] += t.navlog.windTipBelowGround;
			} else if (f.aboveTop) {
				// Mutually exclusive with belowGround (under the model ground
				// vs over its pressure ladder).
				lines[0] += t.navlog.windTipAboveTop;
			}
			lines.push(t.navlog.windTipForecast(label));
			lines.push(
				run != null
					? t.navlog.windTipRunValid({ run: fmtZ(run), valid: fmtZ(f.validTimeMs) })
					: t.navlog.windTipValid(fmtZ(f.validTimeMs)),
			);
			let level = t.navlog.windTipLevel(Math.round(f.altitudeFt));
			if (f.tempC != null) {
				const dev = Math.round(f.isaDevC ?? 0);
				level += t.navlog.windTipLevelTemp({
					tempC: Math.round(f.tempC),
					isaDev: `${dev >= 0 ? '+' : ''}${dev}`,
				});
			}
			lines.push(level);
			if (f.shearKtPer1000Ft != null && f.shearKtPer1000Ft >= SHEAR_ADVISORY_KT_PER_1000FT) {
				lines.push(t.navlog.windTipShear(Math.round(f.shearKtPer1000Ft)));
			}
			if (windAloft.tempTas && cruise != null && cruise > 0 && f.tempC != null) {
				const tas = legTasKt(cruise, f.tempC, f.altitudeFt, true);
				if (Math.round(tas) !== Math.round(cruise)) {
					lines.push(t.navlog.windTipTas(Math.round(tas)));
				}
			}
		} else if (ew.source === 'override') {
			lines.push(t.navlog.windTipOverride);
		} else {
			const f = forecasts?.[i];
			if (forecastEnabled && f && !f.ok) {
				// Past a held forecast's hours is not past the model's reach
				// (the held columns end where their request did): only the
				// model's own horizon is worded as one.
				lines.push(
					f.reason === 'beyond-horizon'
						? t.navlog.windTipManualBeyondHorizon
						: t.navlog.windTipManualUnavailable,
				);
			} else {
				lines.push(t.navlog.windTipManual);
			}
		}
		return lines.join('\n');
	});
}

/** One provenance line for the nav-log sheet header (print-visible: the
 *  paper must say where its winds came from). Null when no leg has wind.
 *  Built from t.navlog at call time (the routeLegWindTips convention). */
export function routeWindSummary(route: Route): string | null {
	const winds = effectiveRouteWinds(route);
	const present = winds.filter((w) => w != null);
	if (present.length === 0) {
		return null;
	}
	const overrides = present.filter((w) => w.source === 'override').length;
	const overridesNote = overrides > 0 ? t.navlog.windSummaryOverridden(overrides) : '';
	const forecastLegs = present.filter((w) => w.source === 'forecast');
	if (forecastLegs.length > 0) {
		const held = currentRouteWindEntry(route)?.entry ?? null;
		const label = held ? t.weather.windModels[held.model] : t.navlog.forecastFallback;
		const run = held ? heldRunMs(held) : null;
		const times = forecastLegs.map((w) => w.forecast?.validTimeMs ?? 0);
		const from = Math.min(...times);
		const to = Math.max(...times);
		const s = t.navlog.windSummaryForecast({
			model: label,
			run: run != null ? fmtZ(run) : null,
			from: fmtZ(from),
			to: to - from >= 60_000 ? fmtZ(to) : null,
		});
		return s + overridesNote;
	}
	const manual = present.find((w) => w.source === 'manual');
	if (manual) {
		return t.navlog.windSummaryManual(fmtWind(manual.dirDeg, manual.speedKt)) + overridesNote;
	}
	return t.navlog.windSummaryPerLeg;
}

/** The nav-log header's MEAN FORECAST WIND, printed among the route
 *  figures, ahead of the provenance line, so the wind the plan was made
 *  with is on the sheet flown with: the route's forecast legs averaged by
 *  meanForecastWind over the WHOLE route, so every continuation card
 *  repeats one figure. Gated like routeWindWarning, and it has to be: an
 *  entry outlives the two toggles, and a forecast switched off must not
 *  keep printing. Null while the forecast is off, unresolved or short of any
 *  leg, and when it flies no leg at all: every leg overridden, the
 *  provenance line names no forecast, and a forecast figure printed beside
 *  it would be one the plan does not use, with nothing saying where it came
 *  from. Built from t.navlog at call time (the routeWindSummary
 *  convention). Tracked. */
export function routeWindMean(route: Route): string | null {
	if (!display.liveWeather || !windAloft.useForecastForLegs || route.waypoints.length < 2) {
		return null;
	}
	if (!effectiveRouteWinds(route).some((w) => w?.source === 'forecast')) {
		return null;
	}
	const legNM = computeNavLog(route.waypoints, null).legs.map((l) => l.legNM);
	const mean = meanForecastWind(routeLegForecasts(route), legNM);
	if (!mean) {
		return null;
	}
	if (mean.kind === 'mean') {
		return t.navlog.windMean(fmtWind(mean.dirDeg, mean.speedKt));
	}
	return mean.kind === 'varies' ? t.navlog.windMeanVaries : t.navlog.windMeanLight;
}

/** How far the route's fetched columns actually reach (the earliest reach
 *  among them, so the answer holds for every leg), null while unresolved or
 *  when nothing was fetched. Tracked. */
function routeForecastReachMs(route: Route): number | null {
	const cur = currentRouteWindEntry(route);
	if (!cur) {
		return null;
	}
	let reach: number | null = null;
	for (const col of cur.entry.columns) {
		const r = columnReachMs(col);
		if (r == null) {
			return null;
		}
		reach = reach == null ? r : Math.min(reach, r);
	}
	return reach;
}

/** The nav-log header's provenance WARNING, beside routeWindSummary's line:
 *  what keeps the forecast from serving this plan, which is otherwise
 *  invisible (the legs simply fall back to the global manual wind, or go
 *  blank). Null when the forecast serves every leg, when it is still
 *  resolving, or when the pilot turned it off, since the summary then
 *  already says what the winds are. Built from t.navlog at call time (the
 *  routeWindSummary convention; nothing translated is stored). */
export function routeWindWarning(route: Route): string | null {
	if (!display.liveWeather || !windAloft.useForecastForLegs || route.waypoints.length < 2) {
		return null;
	}
	const entry = routeWind.byRoute[route.id];
	const status = entry?.status;
	if (status === 'out-of-range') {
		return t.navlog.windSummaryOutOfRange(FORECAST_MAX_AHEAD_DAYS);
	}
	// A forecast held through a failed refresh still serves the plan, so the
	// note is its age, whatever the failure was, and it stays up through the
	// retries until one lands; its run is on the provenance line.
	const held = currentRouteWindEntry(route)?.entry;
	if (held && held.failedMs != null && held.fetchedMs != null) {
		// And the legs it does not cover, the plan re-timed out of its
		// hours, before them or past them (the held columns end where their
		// request did, a reach that says nothing of the model's).
		const since = fmtZ(held.fetchedMs);
		const cov = forecastCoverage(effectiveRouteWinds(route), routeLegForecasts(route));
		const short = cov.beyondHorizon + cov.notCovered + cov.unavailable;
		return short > 0 ? t.navlog.windSummaryStaleShort({ since, legs: short }) : t.navlog.windSummaryStale(since);
	}
	if (status === 'error') {
		const kind = entry?.errorKind;
		if (kind === 'quota') {
			return t.navlog.windSummaryQuota;
		}
		return kind === 'rate-limit' ? t.navlog.windSummaryRateLimited : t.navlog.windSummaryUnavailable;
	}
	// A refresh in flight never flashes a warning: the held forecast reads
	// meanwhile, and what the refresh answers is not known yet.
	if (status === 'loading') {
		return null;
	}
	const cov = forecastCoverage(effectiveRouteWinds(route), routeLegForecasts(route));
	if (cov.beyondHorizon > 0) {
		const reach = routeForecastReachMs(route);
		return reach != null
			? t.navlog.windSummaryBeyond({ legs: cov.beyondHorizon, reach: fmtZ(reach) })
			: t.navlog.windSummaryBeyondNoReach(cov.beyondHorizon);
	}
	// Legs outside the held hours with nothing failed are a plan re-timed a
	// moment ago, its refresh about to start: nothing to warn of yet.
	return cov.unavailable > 0 ? t.navlog.windSummaryUnavailable : null;
}

/** The forecast a print asked for and did not get: forecast winds on, and
 *  once its ensure settled nothing held serves the route (a failed first
 *  fetch, a window the endpoint refused). 'manual' when the typed global
 *  wind then flies its legs, 'blank' when none is typed and their
 *  wind-corrected cells stay blank, null when the forecast serves some leg.
 *  A forecast held through a failed refresh does serve, its sheet header
 *  saying its age. Read it after awaiting ensureRouteWindFor, which never
 *  rejects: its failures are states, not errors. */
export function routeForecastMissing(route: Route): 'manual' | 'blank' | null {
	if (!forecastOn() || route.waypoints.length < 2) {
		return null;
	}
	// The legs the forecast should serve: an overridden leg flies its own
	// wind whatever the forecast does. Missing when none of them has one; a
	// plan served in part is the sheet's own amber note, not this notice.
	const forecasts = routeLegForecasts(route);
	let asked = false;
	for (const [i, w] of route.waypoints.slice(0, -1).entries()) {
		if (waypointOverride(w) != null) {
			continue;
		}
		if (forecasts?.[i]?.ok) {
			return null;
		}
		asked = true;
	}
	if (!asked) {
		return null;
	}
	return routeSettings.windDirDeg != null && routeSettings.windSpeedKt != null ? 'manual' : 'blank';
}

/** Is a typed global wind merely the per-leg fallback right now, or is it
 *  the wind actually flying every leg? The RouteTab's Wind field demotes
 *  its label on the first, so the answer must be no once the forecast is
 *  known not to serve (out of range, refused, failed, or nothing but legs
 *  past the model's horizon); a refresh still to answer keeps the label
 *  rather than flickering it. Tracked. */
export function globalWindIsFallback(route: Route): boolean {
	if (routeSettings.windDirDeg == null && routeSettings.windSpeedKt == null) {
		return false;
	}
	if (!display.liveWeather || !windAloft.useForecastForLegs) {
		return false;
	}
	const status = routeWind.byRoute[route.id]?.status;
	const settled = status === 'out-of-range' || status === 'error';
	// A held forecast, refreshing or kept through a failed refresh included,
	// makes the typed wind the fallback where it serves some leg; serving
	// none, the label stays while a refresh is in flight or about to start
	// (a plan re-timed out of the held hours), which is what it answers.
	const forecasts = routeLegForecasts(route);
	if (forecasts) {
		if (forecasts.some((f) => f.ok)) {
			return true;
		}
		return !settled && (status === 'loading' || forecasts.some((f) => !f.ok && f.reason === 'not-covered'));
	}
	// None held: known not to serve once refused or failed, while a first
	// fetch in flight keeps the label rather than flickering it.
	return !settled;
}

/** Drop cache entries (and abort fetches) for deleted routes; the caller
 *  passes the live id list (its tracked routes.list read stays outside). */
export function pruneRouteWind(liveIds: string[]): void {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient membership probe, not state
	const live = new Set(liveIds);
	// No route left: nothing can reuse a cell (the cells of a route deleted
	// among others stay, aged out by the store's own bound).
	if (liveIds.length === 0) {
		cellStores.wind.clear();
		cellStores.cloud.clear();
	}
	for (const tier of ['wind', 'cloud'] as const) {
		const book = books[tier];
		const entries = tierEntries(tier);
		// Every id any record names: an entry outlives its lastKey (the gate
		// and the rate-limit branch drop the key and keep the forecast held),
		// and the entries are read untracked, a caller's effect subscribing
		// to none.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient union, not state
		const ids = new Set([
			...Object.keys(book.lastKey),
			...Object.keys(book.failedReq),
			...untrack(() => Object.keys(entries)),
		]);
		for (const id of ids) {
			if (!live.has(id)) {
				book.aborts[id]?.abort();
				delete book.aborts[id];
				delete book.lastKey[id];
				delete book.inflight[id];
				delete book.inflightReq[id];
				delete book.failedReq[id];
				delete book.servedSig[id];
				untrack(() => {
					delete entries[id];
				});
			}
		}
	}
}
