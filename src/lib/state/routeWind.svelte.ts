/* Per-route forecast winds (the routeTerrain ensure-pattern, two-tier).
 *
 * The NETWORK tier caches the fetched Open-Meteo columns per route, keyed
 * coordinates + hour window + model ONLY: altitude edits, auto re-levelling
 * and profile drags cost zero network because the per-leg resolution (level
 * bracketing, valid-time chaining, the wind-corrected re-timing pass) runs
 * as pure math on read (route/legWind.ts). The columns carry the full level
 * ladder + temperatures, so any leg altitude resolves from one snapshot.
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
 * cross-trip forecast dependency), falling back to the next whole hour from
 * now (never the Weather panel's valid time; that drives only the map
 * weather display). Every fetch is gated on display.liveWeather and the
 * useForecastForLegs planning flag. */

import { untrack } from 'svelte';
import { isFresh, settleGuard } from './asyncCache';
import { routes, routeSettings, type Route, type Waypoint } from './route.svelte';
import { t } from './i18n.svelte';
import { effectiveCruiseSpeedKt } from './aircraft.svelte';
import { terrainCoordsKey } from './routeTerrain.svelte';
import { flightPrep, dossierFlightDate, dossierStopEffectiveMin } from './flightPrep.svelte';
import { display } from './display.svelte';
import {
	animationWindow,
	effectiveWindModel,
	floorHourMs,
	modelRunMs,
	nextHourMs,
	windAloft,
	windRuns,
} from './windAloft.svelte';
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
	legColumnsFromSegments,
	legSegments,
	legTasKt,
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
	/** coords | model | hour-window signature the columns belong to. */
	key: string;
	columns: WindColumn[];
	model: WindModelId;
	/** out-of-range: the departure sits past the endpoint's own window, so
	 *  no request was made (or the endpoint refused the one that was). */
	status: 'loading' | 'ready' | 'error' | 'out-of-range';
	/** Refines an 'error' for the header note, which is the difference
	 *  between "wait" and "not today": 'quota' = the day's or month's
	 *  budget is spent, which the backoff cannot outwait; 'rate-limit' = a
	 *  minute or hour window, already being retried. null otherwise. */
	errorKind: 'quota' | 'rate-limit' | null;
}

export const routeWind = $state<{
	byRoute: Record<string, RouteWindEntry>;
	/** Bumped by the rate-limit retry timer; the MapView warm effect tracks
	 *  it so a quota rejection re-ensures after the minute. */
	retrySeq: number;
}>({ byRoute: {}, retrySeq: 0 });

// Plain (non-reactive) bookkeeping; see the reactivity contract above.
const lastKey: Record<string, string> = {};
const aborts: Record<string, AbortController> = {};
const inflight: Record<string, Promise<void>> = {};
const fetchedAt: Record<string, number> = {};
/** windRuns.newRunSeq as of the fetch START: a run change detected while a
 *  fetch is in flight leaves the entry stamped one behind, so the next
 *  ensure refetches the new cycle. */
const runSeqAtFetch: Record<string, number> = {};
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** Columns survive half a typical model cycle before a re-ensure refetches. */
const ROUTE_TTL_MS = 30 * 60_000;
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

function windowFor(
	waypoints: Waypoint[],
	departureMs: number,
	cruiseKt: number | null,
	model: WindModelId,
): { startMs: number; endMs: number } {
	const durMin = computeNavLog(waypoints, cruiseKt).totalEteMin ?? 0;
	if (windAloft.animating) {
		// One fetch spans the whole animation slider (plus the flight time), so
		// scrubbing the map time never refetches the route columns; the key
		// derives from this window and stays stable across the sweep.
		const anim = animationWindow(model, Date.now());
		return {
			startMs: Math.min(floorHourMs(departureMs), anim.startMs),
			endMs: anim.endMs + nextHourMs(durMin * 60_000) + 3600_000,
		};
	}
	return {
		startMs: floorHourMs(departureMs),
		endMs: nextHourMs(departureMs + durMin * 60_000) + 3600_000,
	};
}

function routeWindKeyFor(waypoints: Waypoint[], departureMs: number, cruiseKt: number | null): { key: string; model: WindModelId; startMs: number; endMs: number } {
	const c = routeCentroid(waypoints);
	const model = effectiveWindModel(c.lat, c.lon);
	const { startMs, endMs } = windowFor(waypoints, departureMs, cruiseKt, model);
	return {
		key: `${terrainCoordsKey(waypoints)}|${model}|${isoHour(startMs)}|${isoHour(endMs)}`,
		model,
		startMs,
		endMs,
	};
}

/** The first-departure instant: the flight-prep ETD on its flight date when
 *  set, else the next whole hour from now. Deliberately independent of the
 *  Weather panel's valid time (that scrubs only the map weather display, never
 *  the flight plan); the ETD read is tracked on purpose so editing it
 *  re-resolves the winds, and the now fallback matches validTimeMs's own
 *  initial value, refreshed by the ambient minute tick. */
export function firstDepartureMs(): number {
	const t = flightPrep.dossier.departureTime;
	if (t) {
		const ms = Date.parse(`${dossierFlightDate()}T${t}:00Z`);
		if (Number.isFinite(ms)) {
			return ms;
		}
	}
	return nextHourMs(Date.now());
}

/** The route's planned departure: the ETD chained through the preceding
 *  trips (still-air arrivals + ground stops); an alternate departs at its
 *  trip's arrival. Routes outside the trip chain use the base time. */
export function routeDepartureMs(routeId: string): number {
	const base = firstDepartureMs();
	const trips = orderedTrips(routes.list);
	const idx = trips.findIndex((t) => t.route.id === routeId || t.alternate?.id === routeId);
	if (idx < 0) {
		return base;
	}
	const stills = trips.map((t) => computeNavLog(t.route.waypoints, effectiveCruiseSpeedKt()).totalEteMin);
	const stops = trips.map((_, i) => dossierStopEffectiveMin(i));
	const chain = chainDepartures(stills, stops, base);
	return trips[idx].alternate?.id === routeId ? chain[idx].arrivalMs : chain[idx].departureMs;
}

/** Start (or keep) the forecast fetch for a route. Cheap when the key is
 *  unchanged and fresh; returns the in-flight promise so print preps can
 *  await it. Gated off (idle, aborting any run) while live weather or the
 *  forecast-legs option is disabled. */
export function ensureRouteWindFor(route: Route): Promise<void> {
	const routeId = route.id;
	if (!display.liveWeather || !windAloft.useForecastForLegs || route.waypoints.length < 2) {
		aborts[routeId]?.abort();
		delete aborts[routeId];
		delete lastKey[routeId];
		delete inflight[routeId];
		return Promise.resolve();
	}
	const departureMs = routeDepartureMs(routeId);
	const cruiseKt = effectiveCruiseSpeedKt();
	const { key, model, startMs, endMs } = routeWindKeyFor(route.waypoints, departureMs, cruiseKt);
	// Tracked read on purpose: the warm effect re-ensures when a new model
	// cycle is detected, and an entry fetched under an older cycle is stale
	// even inside its TTL.
	const runSeq = windRuns.newRunSeq;
	const fresh = isFresh(fetchedAt[routeId], ROUTE_TTL_MS) && runSeqAtFetch[routeId] === runSeq;
	if (lastKey[routeId] === key && fresh) {
		return inflight[routeId] ?? Promise.resolve();
	}
	// A departure past the endpoint's own window (FORECAST_MAX_AHEAD_DAYS)
	// can only ever answer 400: refuse it here rather than discovering it
	// upstream, so a plan made weeks ahead costs no request at all. The
	// state write is guarded because the minute tick re-enters at the TTL
	// and a same-value $state assignment would still notify every consumer.
	const rangeEndMs = forecastRangeEndMs(Date.now());
	if (startMs > rangeEndMs) {
		aborts[routeId]?.abort();
		delete aborts[routeId];
		delete inflight[routeId];
		lastKey[routeId] = key;
		fetchedAt[routeId] = Date.now();
		runSeqAtFetch[routeId] = runSeq;
		untrack(() => {
			const prev = routeWind.byRoute[routeId];
			if (prev?.status !== 'out-of-range' || prev.key !== key) {
				routeWind.byRoute[routeId] = {
					key,
					columns: [],
					model,
					status: 'out-of-range',
					errorKind: null,
				};
			}
		});
		return Promise.resolve();
	}
	// While a rate-limit retry is scheduled, the backoff timer is the sole
	// re-entry path (it nulls itself before bumping retrySeq); the minute
	// tick must not hammer a spent quota.
	if (retryTimer) {
		return inflight[routeId] ?? Promise.resolve();
	}
	lastKey[routeId] = key;
	aborts[routeId]?.abort();
	const ctrl = new AbortController();
	aborts[routeId] = ctrl;
	const current = settleGuard(ctrl.signal, () => lastKey[routeId] === key);
	untrack(() => {
		const prev = routeWind.byRoute[routeId];
		routeWind.byRoute[routeId] = {
			key,
			columns: prev && prev.key === key ? prev.columns : [],
			model,
			status: 'loading',
			errorKind: null,
		};
	});
	// One column per LEG SEGMENT (legSegments: <= ~25 NM spacing, an odd
	// count per leg so the middle segment sits on the leg midpoint): the
	// winds keep their historical midpoint sample, the cloud curtain gets
	// sub-leg lateral resolution, and it all stays ONE batched request.
	const segs = legSegments(route.waypoints);
	const p = fetchWindColumns(segs, {
		model,
		startMs,
		// Clamped HERE and not in the window (which the cache key carries):
		// the endpoint range-checks end_hour too, so a departure near the
		// ceiling would 400 on the +1 h pad alone, while a key that moved
		// with the clock would go stale at every UTC midnight. The columns
		// then simply stop early and the legs past them read as
		// beyond-horizon, which is what they are.
		endMs: Math.min(endMs, rangeEndMs),
		temps: true,
		clouds: true,
		signal: ctrl.signal,
	})
		.then((columns) => {
			retryDelayMs = RATE_LIMIT_RETRY_MS;
			if (!current()) {
				return;
			}
			fetchedAt[routeId] = Date.now();
			runSeqAtFetch[routeId] = runSeq;
			routeWind.byRoute[routeId] = { key, columns, model, status: 'ready', errorKind: null };
		})
		.catch((err: unknown) => {
			if (!current()) {
				return;
			}
			// A refused window is not a failure to retry but a fact to state,
			// even when the pre-flight guard above let it through (the
			// endpoint's own ceiling is the authority on its dates).
			const outOfRange = err instanceof OpenMeteoError && err.outOfRange;
			const quota = err instanceof OpenMeteoError && err.quotaExhausted;
			const limited = err instanceof OpenMeteoError && err.rateLimited;
			routeWind.byRoute[routeId] = {
				key,
				columns: [],
				model,
				status: outOfRange ? 'out-of-range' : 'error',
				errorKind: quota ? 'quota' : limited ? 'rate-limit' : null,
			};
			// Stamp the failure so the minute-tick warm effect paces retries
			// at ROUTE_TTL_MS, not per minute (docs/wind-aloft.md
			// "Auto-refresh": every failure is stamped into its cache); a key
			// change (route edit, window hour, model swap) still retries
			// immediately. The rate-limit branch below clears the key
			// instead: its backoff timer is the faster re-entry path.
			fetchedAt[routeId] = Date.now();
			runSeqAtFetch[routeId] = runSeq;
			// A quota rejection heals itself: clear the key so the next ensure
			// retries, and nudge the warm effect after the backoff delay.
			if (err instanceof OpenMeteoError && err.rateLimited) {
				delete lastKey[routeId];
				if (retryTimer) {
					clearTimeout(retryTimer);
				}
				retryTimer = setTimeout(() => {
					retryTimer = null;
					routeWind.retrySeq++;
				}, retryDelayMs);
				retryDelayMs = Math.min(retryDelayMs * 2, RATE_LIMIT_RETRY_MAX_MS);
			}
		})
		.finally(() => {
			if (inflight[routeId] === p) {
				delete inflight[routeId];
			}
		});
	inflight[routeId] = p;
	return p;
}

/** The route's entry when ready AND keyed to the route's current
 *  coordinates / window / model, paired with the segment list those
 *  columns were fetched for (recomputed pure from the waypoints; a count
 *  mismatch, e.g. across a mid-session code change, reads as not ready).
 *  The shared guard under every consumer, so none can read columns that
 *  belong to stale inputs. Tracked. */
function currentRouteWindEntry(route: Route): { entry: RouteWindEntry; segments: LegSegment[] } | null {
	const entry = routeWind.byRoute[route.id];
	if (!entry || entry.status !== 'ready' || entry.columns.length === 0) {
		return null;
	}
	const departureMs = routeDepartureMs(route.id);
	const { key } = routeWindKeyFor(route.waypoints, departureMs, effectiveCruiseSpeedKt());
	if (entry.key !== key) {
		return null;
	}
	const segments = legSegments(route.waypoints);
	return entry.columns.length === segments.length ? { entry, segments } : null;
}

/** The per-leg forecasts when the columns are ready AND belong to the
 *  route's current coordinates / window / model; null otherwise (blank
 *  MH / ETE-W over wrong values, the terrain convention). Winds resolve
 *  off each leg's MIDDLE segment, whose center is the leg midpoint, so
 *  the values match the historical per-midpoint fetch exactly. Tracked. */
export function routeLegForecasts(route: Route): LegForecast[] | null {
	const cur = currentRouteWindEntry(route);
	if (!cur) {
		return null;
	}
	const departureMs = routeDepartureMs(route.id);
	const legCols = legColumnsFromSegments(cur.entry.columns, cur.segments, route.waypoints.length - 1);
	return resolveRouteForecast(legCols, route.waypoints, departureMs, effectiveCruiseSpeedKt());
}

/** The per-leg columns behind the SAME guard (each leg's midpoint segment,
 *  the full ladder + temps), for the level advisor's candidate scan; null
 *  while loading or keyed to stale inputs. Tracked. */
export function routeWindColumns(route: Route): (WindColumn | undefined)[] | null {
	const cur = currentRouteWindEntry(route);
	if (!cur) {
		return null;
	}
	return legColumnsFromSegments(cur.entry.columns, cur.segments, route.waypoints.length - 1);
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
	const legs = routeLegForecasts(route);
	if (!legs) {
		return new Array<number | null>(Math.max(0, route.waypoints.length - 1)).fill(null);
	}
	return legs.map((f) => (f.ok ? f.wind.freezingLevelFt : null));
}

/** Per-SEGMENT cloud-cover profiles (every ladder level resolved to its
 *  altitude), each with the distance span its column represents, for the
 *  profile's cloud curtain; null while the columns are unresolved or keyed
 *  to stale inputs. Deliberately NOT part of LegWindForecast: the curtain
 *  is display-only and no wind consumer reads it. Each segment samples at
 *  its own instant: the leg's valid time shifted still-air to the segment
 *  center (hour-level anchoring, the chainDepartures convention); segments
 *  beyond the model horizon sample to [] (the curtain gaps, the
 *  freezing-line convention). Tracked. */
export function routeCloudCover(route: Route): CloudCoverSegment[] | null {
	const cur = currentRouteWindEntry(route);
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

/** The model whose forecast a route currently rides (status line / chips). */
export function routeWindModel(route: Route): WindModelId | null {
	const entry = routeWind.byRoute[route.id];
	return entry && entry.status === 'ready' ? entry.model : null;
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
	const model = routeWindModel(route);
	const label = model ? t.weather.windModels[model] : t.navlog.forecastFallback;
	const run = model ? modelRunMs(model) : null;
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
		const model = routeWindModel(route);
		const label = model ? t.weather.windModels[model] : t.navlog.forecastFallback;
		const run = model ? modelRunMs(model) : null;
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
	const status = routeWind.byRoute[route.id]?.status;
	if (status === 'out-of-range') {
		return t.navlog.windSummaryOutOfRange(FORECAST_MAX_AHEAD_DAYS);
	}
	if (status === 'error') {
		const kind = routeWind.byRoute[route.id]?.errorKind;
		if (kind === 'quota') {
			return t.navlog.windSummaryQuota;
		}
		return kind === 'rate-limit' ? t.navlog.windSummaryRateLimited : t.navlog.windSummaryUnavailable;
	}
	const cov = forecastCoverage(effectiveRouteWinds(route), routeLegForecasts(route));
	if (cov.beyondHorizon > 0) {
		const reach = routeForecastReachMs(route);
		return reach != null
			? t.navlog.windSummaryBeyond({ legs: cov.beyondHorizon, reach: fmtZ(reach) })
			: t.navlog.windSummaryBeyondNoReach(cov.beyondHorizon);
	}
	return cov.unavailable > 0 ? t.navlog.windSummaryUnavailable : null;
}

/** Is a typed global wind merely the per-leg fallback right now, or is it
 *  the wind actually flying every leg? The RouteTab's Wind field demotes
 *  its label on the first, so the answer must be no once the forecast is
 *  known not to serve (out of range, refused, or nothing but legs past the
 *  horizon); a fetch still in flight keeps the label rather than flickering
 *  it. Tracked. */
export function globalWindIsFallback(route: Route): boolean {
	if (routeSettings.windDirDeg == null && routeSettings.windSpeedKt == null) {
		return false;
	}
	if (!display.liveWeather || !windAloft.useForecastForLegs) {
		return false;
	}
	const status = routeWind.byRoute[route.id]?.status;
	if (status === 'out-of-range' || status === 'error') {
		return false;
	}
	const forecasts = routeLegForecasts(route);
	return forecasts == null || forecasts.some((f) => f.ok);
}

/** Drop cache entries (and abort fetches) for deleted routes; the caller
 *  passes the live id list (its tracked routes.list read stays outside). */
export function pruneRouteWind(liveIds: string[]): void {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient membership probe, not state
	const live = new Set(liveIds);
	for (const id of Object.keys(lastKey)) {
		if (!live.has(id)) {
			aborts[id]?.abort();
			delete aborts[id];
			delete lastKey[id];
			delete inflight[id];
			delete fetchedAt[id];
			delete runSeqAtFetch[id];
			untrack(() => {
				delete routeWind.byRoute[id];
			});
		}
	}
}
