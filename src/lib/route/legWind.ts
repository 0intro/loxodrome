/* Per-leg forecast-wind planning: leg midpoints, the trip departure chain,
 * per-leg valid times (still-air ETE offsets refined by one wind-corrected
 * pass), sampling those against fetched Open-Meteo columns, and the
 * effective-wind precedence every consumer shares (nav-log sheet, exports,
 * fuel plan, RouteTab chip). Pure and Svelte-free; the reactive cache
 * wrapping this is $lib/state/routeWind.svelte.ts. */

import { computeNavLog } from '$lib/route/navlog';
import { windTriangle } from '$lib/route/wind';
import {
	columnReachMs,
	freezingLevelFt,
	isaDevC,
	isaTempC,
	sampleWindAt,
	uvToWind,
	windToUV,
	type WindColumn,
} from '$lib/weather/openMeteo';
import type { Waypoint } from '$lib/state/route.svelte';

/** One leg's forecast wind with its provenance inputs. */
export interface LegWindForecast {
	dirTrueDeg: number;
	speedKt: number;
	tempC: number | null;
	isaDevC: number | null;
	/** The leg altitude sits below the model ground (the 10 m wind applies). */
	belowGround: boolean;
	/** The leg altitude sits above the fetched pressure ladder (the topmost
	 *  level's wind is shown clamped; provenance tips note it). */
	aboveTop: boolean;
	/** The instant the sample was taken for (mid-leg). */
	validTimeMs: number;
	altitudeFt: number;
	/** Freezing-level altitude (ft MSL) over the leg at that instant; null
	 *  when the whole column stays above 0 degC (the profile curve gaps). */
	freezingLevelFt: number | null;
	/** Vertical wind shear around the leg level (kt per 1000 ft); null near
	 *  the ground, where a clamped span would misstate the gradient. */
	shearKtPer1000Ft: number | null;
}

/** Advisory threshold for the vertical-shear tooltip line and the W/V chip
 *  cue: the ~6 kt per 1000 ft en-route CAT forecaster rule (Ellrod-style
 *  vertical-shear guidance); see docs/wind-aloft.md. */
export const SHEAR_ADVISORY_KT_PER_1000FT = 6;

/** Vertical wind shear around an altitude: the vector wind difference
 *  between 1000 ft below and 1000 ft above, per 1000 ft of the nominal
 *  span. Null when the lower sample sits below the model ground
 *  (sampleWindAt clamps to the 10 m wind there, and a clamped span would
 *  misstate the gradient) or either sample is missing. */
export function verticalShearKtPer1000Ft(col: WindColumn, altFt: number, timeMs: number): number | null {
	const lo = sampleWindAt(col, altFt - 1000, timeMs);
	const hi = sampleWindAt(col, altFt + 1000, timeMs);
	if (!lo || !hi || lo.belowGround) {
		return null;
	}
	const a = windToUV(lo.dirTrueDeg, lo.speedKt);
	const b = windToUV(hi.dirTrueDeg, hi.speedKt);
	return Math.hypot(b.u - a.u, b.v - a.v) / 2;
}

/** Why a leg has no forecast: the model does not reach its instant
 *  ('beyond-horizon'); columns held from another request do not cover it
 *  ('not-covered', state/routeWind.svelte.ts: they end where their request
 *  did, which says nothing of the model); anything else ('no-data'). */
export type LegForecast =
	| { ok: true; wind: LegWindForecast }
	| {
			ok: false;
			reason: 'beyond-horizon' | 'not-covered' | 'no-data';
			validTimeMs: number;
			altitudeFt: number;
	  };

/** Leg midpoints (the historical per-leg fetch points; legSegments below
 *  supersedes them for the route fetch but keeps each midpoint a sample). */
/** Interpolate a longitude the short way round: the delta wraps into
 *  [-180, 180) so an antimeridian-crossing leg samples along itself, and
 *  the result normalises back into [-180, 180). legMidpoints and
 *  legSegments MUST share this convention: the segment centered on the leg
 *  midpoint has to land on the exact point legMidpoints fetched. */
function lerpLon(a: number, b: number, f: number): number {
	const d = b - a;
	if (d <= 180 && d >= -180) {
		// In-range legs keep the exact arithmetic of the plain lerp (a
		// modulo would wobble the last ulp and churn the wind-cache keys).
		return a + d * f;
	}
	const dLon = ((d + 540) % 360) - 180;
	return ((a + dLon * f + 540) % 360) - 180;
}

/** The point a fraction `f` along a leg: the ONE arithmetic legMidpoints and
 *  legSegments share, so a leg's midpoint and its middle segment's center are
 *  the same point to the last bit (the wind and cloud requests' keys). */
function pointAt(
	a: { lat: number; lon: number },
	b: { lat: number; lon: number },
	f: number,
): { lat: number; lon: number } {
	return { lat: a.lat + (b.lat - a.lat) * f, lon: lerpLon(a.lon, b.lon, f) };
}

/** Each leg's midpoint: where the route's WINDS are fetched, one column per
 *  leg (state/routeWind.svelte.ts), exactly its middle segment's center. */
export function legMidpoints(waypoints: readonly { lat: number; lon: number }[]): { lat: number; lon: number }[] {
	const mids: { lat: number; lon: number }[] = [];
	for (let i = 0; i + 1 < waypoints.length; i++) {
		mids.push(pointAt(waypoints[i], waypoints[i + 1], 0.5));
	}
	return mids;
}

/** Forecast sample spacing along a route: legs subdivide so segment centers
 *  sit no further apart than this (the cloud curtain's lateral resolution;
 *  ~a few AROME grid cells). */
export const SAMPLE_SPACING_NM = 25;
/** Route-wide cap on fetched columns (request weight): the spacing widens
 *  instead once a route is long enough to hit it. */
const MAX_SEGMENTS = 40;

/** One fetch segment of a leg: the forecast column's location (the segment
 *  center) plus the distance span it represents on the profile. */
export interface LegSegment {
	lat: number;
	lon: number;
	legIndex: number;
	/** Cumulative-distance bounds along the route, NM. */
	fromNM: number;
	toNM: number;
	/** The segment center, cumulative NM. */
	midNM: number;
}

/** Subdivide each leg into the smallest ODD number of segments whose
 *  centers sit within the sample spacing: where the route's CLOUDS are
 *  fetched (state/routeWind.svelte.ts), the curtain's sub-leg lateral
 *  resolution. Odd counts put the middle segment's center EXACTLY on the leg
 *  midpoint legMidpoints gives (a short leg degenerates to that single
 *  midpoint segment); both interpolate through pointAt. */
export function legSegments(waypoints: Waypoint[]): LegSegment[] {
	const legs = computeNavLog(waypoints, null).legs;
	const totalNM = legs.reduce((s, l) => s + l.legNM, 0);
	const spacing = Math.max(SAMPLE_SPACING_NM, totalNM / MAX_SEGMENTS);
	const out: LegSegment[] = [];
	for (let i = 0; i < legs.length; i++) {
		const a = waypoints[i];
		const b = waypoints[i + 1];
		const legNM = legs[i].legNM;
		const startNM = legs[i].cumNM - legNM;
		let n = Math.max(1, Math.ceil(legNM / spacing));
		if (n % 2 === 0) {
			n += 1;
		}
		for (let k = 0; k < n; k++) {
			const f = (k + 0.5) / n;
			out.push({
				...pointAt(a, b, f),
				legIndex: i,
				fromNM: startNM + (legNM * k) / n,
				toNM: startNM + (legNM * (k + 1)) / n,
				midNM: startNM + legNM * f,
			});
		}
	}
	return out;
}

/** Why a leg resolved no wind. The question is whether the MODEL reaches
 *  the instant, which is what the pilot can act on ("plan closer in"), so
 *  it is answered against the column's own reach and not against the hours
 *  we happened to ask for: the API pads a request past a model's horizon
 *  with null hours (columnReachMs), so the fetched window says nothing.
 *  Everything else, a leg with no column at all or an instant before the
 *  window, is our own gap and stays the vaguer no-data. */
function failReason(col: WindColumn | undefined, timeMs: number): 'beyond-horizon' | 'no-data' {
	if (!col || col.timesMs.length === 0) {
		return 'no-data';
	}
	const reach = columnReachMs(col);
	return reach == null || timeMs > reach ? 'beyond-horizon' : 'no-data';
}

/** Sample every leg of a route against its fetched columns (index-aligned
 *  with legMidpoints). Valid times chain still-air ETEs from the departure,
 *  then ONE wind-corrected pass re-times the later legs: with hourly
 *  forecasts a second iteration moves nothing. cruiseKt null anchors every
 *  leg at the departure instant. */
export function resolveRouteForecast(
	columns: readonly (WindColumn | undefined)[],
	waypoints: Waypoint[],
	departureMs: number,
	cruiseKt: number | null,
): LegForecast[] {
	const legs = computeNavLog(waypoints, cruiseKt).legs;
	const sampleAt = (times: number[]): (ReturnType<typeof sampleWindAt> | null)[] =>
		legs.map((_, i) => {
			const col = columns[i];
			return col ? sampleWindAt(col, waypoints[i].alt, times[i]) : null;
		});

	const midTimes = (eteMin: (number | null)[]): number[] => {
		const out: number[] = [];
		let cumMs = 0;
		for (const ete of eteMin) {
			const legMs = (ete ?? 0) * 60_000;
			out.push(departureMs + cumMs + legMs / 2);
			cumMs += legMs;
		}
		return out;
	};

	const stillTimes = midTimes(legs.map((l) => l.eteMin));
	const first = sampleAt(stillTimes);

	// Wind-corrected pass: replace each solvable leg's ETE with the
	// ground-speed one, keep the still-air ETE where the triangle fails.
	const corrected = legs.map((leg, i) => {
		const s = first[i];
		if (!s || leg.eteMin == null || cruiseKt == null) {
			return leg.eteMin;
		}
		const sol = windTriangle(leg.trackTrueDeg, cruiseKt, s.dirTrueDeg, s.speedKt);
		return sol ? (leg.legNM / sol.gsKt) * 60 : leg.eteMin;
	});
	const times = midTimes(corrected);
	const final = sampleAt(times);

	return legs.map((_, i) => {
		const col = columns[i];
		const s = final[i];
		if (!s) {
			return {
				ok: false,
				reason: failReason(col, times[i]),
				validTimeMs: times[i],
				altitudeFt: waypoints[i].alt,
			};
		}
		return {
			ok: true,
			wind: {
				dirTrueDeg: s.dirTrueDeg,
				speedKt: s.speedKt,
				tempC: s.tempC,
				isaDevC: s.tempC != null ? isaDevC(waypoints[i].alt, s.tempC) : null,
				belowGround: s.belowGround,
				aboveTop: s.aboveTop,
				validTimeMs: times[i],
				altitudeFt: waypoints[i].alt,
				freezingLevelFt: col ? freezingLevelFt(col, times[i]) : null,
				shearKtPer1000Ft: col ? verticalShearKtPer1000Ft(col, waypoints[i].alt, times[i]) : null,
			},
		};
	});
}

/** Departure and arrival per trip: each departure is the previous trip's
 *  still-air arrival plus its ground stop (hour-level anchoring; the hourly
 *  forecast granularity swamps the wind's minutes, and still-air chaining
 *  keeps the trips independent of each other's forecasts). Unknown durations
 *  chain as zero. */
export function chainDepartures(
	tripStillAirMin: readonly (number | null)[],
	stopsMin: readonly number[],
	firstDepartureMs: number,
): { departureMs: number; arrivalMs: number }[] {
	const out: { departureMs: number; arrivalMs: number }[] = [];
	let dep = firstDepartureMs;
	for (let i = 0; i < tripStillAirMin.length; i++) {
		const arr = dep + (tripStillAirMin[i] ?? 0) * 60_000;
		out.push({ departureMs: dep, arrivalMs: arr });
		dep = arr + (stopsMin[i] ?? 0) * 60_000;
	}
	return out;
}

export type WindVec = { dirDeg: number; speedKt: number };

export interface EffectiveLegWind {
	dirDeg: number;
	speedKt: number;
	source: 'override' | 'forecast' | 'manual';
	/** Provenance when the forecast supplied the value. */
	forecast: LegWindForecast | null;
}

/** The shared precedence: a per-leg override always wins, then the forecast
 *  (only while enabled and resolved), then the global manual wind, else
 *  null (blank MH / ETE-W, the existing convention). */
export function effectiveLegWind(
	override: WindVec | null,
	forecast: LegForecast | null | undefined,
	global: WindVec | null,
	forecastEnabled: boolean,
): EffectiveLegWind | null {
	if (override) {
		return { dirDeg: override.dirDeg, speedKt: override.speedKt, source: 'override', forecast: null };
	}
	if (forecastEnabled && forecast && forecast.ok) {
		return {
			dirDeg: forecast.wind.dirTrueDeg,
			speedKt: forecast.wind.speedKt,
			source: 'forecast',
			forecast: forecast.wind,
		};
	}
	if (global) {
		return { dirDeg: global.dirDeg, speedKt: global.speedKt, source: 'manual', forecast: null };
	}
	return null;
}

/** How much of a route the forecast actually served, for the nav-log
 *  header's provenance warning. */
export interface ForecastCoverage {
	/** Legs flying a forecast wind. */
	forecast: number;
	/** Legs the model does not reach. */
	beyondHorizon: number;
	/** Legs outside the hours the held columns were requested for. */
	notCovered: number;
	/** Legs the forecast failed for any other reason. */
	unavailable: number;
}

/** Count a route's legs by what the forecast did for them. Legs the pilot
 *  overrode are excluded from the gap counts: their own wind is what flies
 *  them, so the forecast not reaching them is not a hole to report. A null
 *  `forecasts` (loading, or keyed to stale inputs) counts nothing, so a
 *  fetch in flight never flashes a warning. */
export function forecastCoverage(
	winds: readonly (EffectiveLegWind | null)[],
	forecasts: readonly LegForecast[] | null | undefined,
): ForecastCoverage {
	const cov: ForecastCoverage = { forecast: 0, beyondHorizon: 0, notCovered: 0, unavailable: 0 };
	if (!forecasts) {
		return cov;
	}
	forecasts.forEach((f, i) => {
		if (winds[i]?.source === 'override') {
			return;
		}
		if (f.ok) {
			cov.forecast++;
		} else if (f.reason === 'beyond-horizon') {
			cov.beyondHorizon++;
		} else if (f.reason === 'not-covered') {
			cov.notCovered++;
		} else {
			cov.unavailable++;
		}
	});
	return cov;
}

/** The route's mean FORECAST wind, the one figure the nav-log header states:
 *  a mean, when the legs' directions agree well enough for one to stand for
 *  them; `varies` when they do not; `light` when no leg's wind is worth a
 *  direction. */
export type MeanForecastWind =
	| { kind: 'mean'; dirDeg: number; speedKt: number }
	| { kind: 'varies' }
	| { kind: 'light' };

/** The steadiness a mean must EXCEED: the mean vector's speed over the legs'
 *  mean speed. cos 30° is two equal halves of a route 60° apart, the
 *  variation from which ICAO Annex 3 (App. 3, 4.1.5.2) has a report give a
 *  wind's two extreme directions rather than one ("60° or more"), so a split
 *  of 60° varies; past it, 270/20 then 360/20 would average to about 315/14,
 *  a wind no leg meets. */
export const MEAN_WIND_STEADINESS_MIN = Math.cos(Math.PI / 6);

/** Absorbs the floating-point error of a split of exactly 60°, whose
 *  steadiness is cos 30° to the last bit either way. */
const STEADINESS_EPS = 1e-9;

/** An unsteady wind is light and variable when every leg's is under this,
 *  the FAA winds-aloft forecast's "9900" (FAA-H-8083-28, 27.2.1.1.1: "light
 *  and variable wind or wind speeds of less than 5 kt"), its direction not
 *  stated. Every leg's, never the mean's: 25 kt on a short leg is no light
 *  wind however calm the long one beside it. */
export const MEAN_WIND_LIGHT_KT = 5;

/** Average a route's per-leg forecasts (index-aligned with its legs) as u/v
 *  vectors, each leg weighted by its length, so a 3 NM leg does not count as
 *  much as a 40 NM one; zero-length legs carry no weight. Directions are
 *  never averaged as angles: 350° and 010° make 360°, not 180°. It averages
 *  the FORECAST, never the effective winds: an overridden leg still counts
 *  with the forecast it overrode. A mean that rounds to 0 kt states no
 *  direction. Null (nothing to state, blank over wrong) unless every leg has
 *  one: while unresolved (`forecasts` null), when any leg failed, on a
 *  length mismatch, and when the route has no length. */
export function meanForecastWind(
	forecasts: readonly LegForecast[] | null | undefined,
	legNM: readonly number[],
): MeanForecastWind | null {
	if (!forecasts || forecasts.length === 0 || forecasts.length !== legNM.length) {
		return null;
	}
	let weight = 0;
	let u = 0;
	let v = 0;
	let speed = 0;
	let maxSpeed = 0;
	for (let i = 0; i < forecasts.length; i++) {
		const f = forecasts[i];
		if (!f.ok) {
			return null;
		}
		const w = legNM[i];
		if (!(w > 0)) {
			continue;
		}
		const uv = windToUV(f.wind.dirTrueDeg, f.wind.speedKt);
		u += w * uv.u;
		v += w * uv.v;
		speed += w * f.wind.speedKt;
		weight += w;
		maxSpeed = Math.max(maxSpeed, f.wind.speedKt);
	}
	if (weight <= 0) {
		return null;
	}
	const mean = uvToWind(u / weight, v / weight);
	const meanSpeed = speed / weight;
	if (
		meanSpeed > 0 &&
		mean.speedKt > (MEAN_WIND_STEADINESS_MIN + STEADINESS_EPS) * meanSpeed &&
		Math.round(mean.speedKt) > 0
	) {
		return { kind: 'mean', dirDeg: mean.dirFromDeg, speedKt: mean.speedKt };
	}
	return maxSpeed < MEAN_WIND_LIGHT_KT ? { kind: 'light' } : { kind: 'varies' };
}

/** The waypoint's manual override as a vector, when both fields are set. */
export function waypointOverride(wp: { windDirDeg?: number | undefined; windSpeedKt?: number | undefined }): WindVec | null {
	return wp.windDirDeg != null && wp.windSpeedKt != null
		? { dirDeg: wp.windDirDeg, speedKt: wp.windSpeedKt }
		: null;
}

/** Per-leg cumulative time boundaries under the wind: minutes to the end of
 *  each leg at that leg's ground speed (null = still air at the cruise
 *  speed, the airspace schedule's fallback convention). Null when the
 *  cruise speed is unset or non-positive, mirroring computeAirspaceSchedule's
 *  own kt guard, so the schedule keeps its blank still-air ETEs. */
export interface LegTimeBounds {
	/** Cumulative distance at each leg end, NM. */
	cumNM: number[];
	/** Cumulative minutes at each leg end. */
	cumMin: number[];
}

export function legCumulativeMinutes(
	legs: readonly { legNM: number }[],
	cruiseKt: number | null,
	legGsKt: readonly (number | null)[],
): LegTimeBounds | null {
	if (!cruiseKt || cruiseKt <= 0) {
		return null;
	}
	const cumNM: number[] = [];
	const cumMin: number[] = [];
	let nm = 0;
	let min = 0;
	for (let i = 0; i < legs.length; i++) {
		const gs = legGsKt[i];
		const speed = gs != null && gs > 0 ? gs : cruiseKt;
		nm += legs[i].legNM;
		min += (legs[i].legNM / speed) * 60;
		cumNM.push(nm);
		cumMin.push(min);
	}
	return { cumNM, cumMin };
}

/** Minutes from departure at a cumulative distance: the full legs before it
 *  plus the partial leg at that leg's own speed. Clamped at both ends;
 *  zero-length legs contribute no time and are never divided by. */
export function timeAtNM(atNM: number, bounds: LegTimeBounds): number {
	const { cumNM, cumMin } = bounds;
	if (cumNM.length === 0 || atNM <= 0) {
		return 0;
	}
	const last = cumNM.length - 1;
	if (atNM >= cumNM[last]) {
		return cumMin[last];
	}
	let i = 0;
	while (cumNM[i] < atNM) {
		i++;
	}
	const loNM = i === 0 ? 0 : cumNM[i - 1];
	const loMin = i === 0 ? 0 : cumMin[i - 1];
	const span = cumNM[i] - loNM;
	if (span <= 1e-9) {
		return cumMin[i];
	}
	return loMin + ((atNM - loNM) / span) * (cumMin[i] - loMin);
}

/** The words the wind note weaves (t.navlog); a parameter keeps this module
 *  locale-free (docs/i18n.md rule 6). */
export interface WindNoteWords {
	windAvgHead: (kt: number) => string;
	windAvgTail: (kt: number) => string;
	windDelta: (signedMin: string) => string;
}

/** The Route tab's summary wind note: "wind +4 min (avg 6 kt headwind)".
 *  The average is the effective component cruise - totalNM / windHours (the
 *  one figure that stays consistent under the temperature-corrected TAS);
 *  it is omitted when it rounds to zero (pure crab loss), and the whole
 *  note is null when nothing is computable or the effect rounds away. */
export function windSummaryNote(
	stillMin: number | null,
	windMin: number | null,
	totalNM: number,
	cruiseKt: number | null,
	words: WindNoteWords,
): string | null {
	if (stillMin == null || windMin == null || windMin <= 0 || !cruiseKt || cruiseKt <= 0 || totalNM <= 0) {
		return null;
	}
	const deltaMin = Math.round(windMin - stillMin);
	const avgKt = Math.round(cruiseKt - totalNM / (windMin / 60));
	if (deltaMin === 0 && avgKt === 0) {
		return null;
	}
	let s = words.windDelta(`${deltaMin >= 0 ? '+' : ''}${deltaMin}`);
	if (avgKt > 0) {
		s += ` (${words.windAvgHead(avgKt)})`;
	} else if (avgKt < 0) {
		s += ` (${words.windAvgTail(-avgKt)})`;
	}
	return s;
}

/** Temperature-corrected TAS: the planned cruise figure is a TAS, so the
 *  only defensible correction is the ISA deviation at the leg's own level
 *  (constant IAS and pressure altitude give TAS proportional to the square
 *  root of the absolute temperature); about 2 percent per 10 degC. Off (or
 *  without a forecast temperature) the cruise passes through unchanged. */
export function legTasKt(cruiseKt: number, tempC: number | null, altFt: number, tempTas: boolean): number {
	if (!tempTas || tempC == null) {
		return cruiseKt;
	}
	return cruiseKt * Math.sqrt((273.15 + tempC) / (273.15 + isaTempC(altFt)));
}
