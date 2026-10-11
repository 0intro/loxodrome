/* Forecast surface conditions at the performance page's aerodromes
 * (docs/flight-preparation.md, "Weather the print computes from"): the
 * 10 m wind, the 2 m temperature and the surface pressure the forecast
 * gives at the field, for the columns whose phase instant the METAR does not
 * speak for (flightprep/runwayPerf.ts wxPick). One column per aerodrome over
 * the hours its columns need, from the model the winds use there (Auto: the
 * chain), held while it is still the forecast (the runs it used,
 * weather/forecastCache.ts) and through a failed refresh. Memory only, like
 * every forecast (docs/pwa.md). */

import { display } from './display.svelte';
import {
	columnStamp,
	effectiveWindModel,
	ensureModelRun,
	noteRuns,
	runStampFor,
	stampIsCurrent,
} from './windAloft.svelte';
import type { RunStamp } from '$lib/weather/forecastCache';
import {
	fetchWindColumns,
	forecastRangeEndMs,
	sampleScalarAt,
	sampleSurfaceAt,
	type Transport,
	type WindColumn,
	type WindModelId,
} from '$lib/weather/openMeteo';

const HOUR_MS = 3600_000;
/** A failed request is asked again this long after, unless a print asks. */
const RETRY_MS = 5 * 60_000;

interface Entry {
	lat: number;
	lon: number;
	model: WindModelId;
	/** The column held: the last good answer, kept through a failure. */
	col: WindColumn | null;
	stamp: RunStamp;
	/** When the held column landed. */
	fetchedMs: number;
	/** The hours the held column was asked for. */
	startMs: number;
	endMs: number;
	/** When the last request failed, 0 after a success. */
	failedMs: number;
}

export const aerodromeForecasts = $state<{ byIcao: Record<string, Entry | undefined> }>({ byIcao: {} });

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping of requests in flight, read by no template or effect
const inflight = new Map<string, Promise<void>>();

/** What the forecast gives at an aerodrome at one instant. */
export interface AerodromeForecast {
	atMs: number;
	windDirTrueDeg: number;
	windSpeedKt: number;
	/** At the model's ground. */
	tempC: number | null;
	/** At the model's ground, hPa. */
	surfacePressureHpa: number | null;
	/** The model's ground at the grid point, m: the ground under the hour,
	 *  the model's that served it (our service's hourly `elevation`), else
	 *  the one the answer states. A chain answers each hour from one model
	 *  while its column states the first one's ground, and the surface
	 *  pressure and the 2 m temperature stand on the model's own. */
	modelElevationM: number;
	model: WindModelId;
	/** Who answered, and the runs our service's column used. */
	source: Transport;
	runs: Readonly<Record<string, number>> | null;
}

/** The forecast at an aerodrome at an instant, from what is held; null when
 *  nothing held covers it (or reaches it: hours past a model's reach are
 *  null). Tracked. */
export function aerodromeForecastAt(icao: string, atMs: number): AerodromeForecast | null {
	const e = aerodromeForecasts.byIcao[icao];
	const col = e?.col;
	if (!e || !col) {
		return null;
	}
	const sfc = sampleSurfaceAt(col, atMs);
	if (!sfc) {
		return null;
	}
	return {
		atMs,
		windDirTrueDeg: sfc.dirTrueDeg,
		windSpeedKt: sfc.speedKt,
		tempC: sfc.tempC,
		surfacePressureHpa: sampleScalarAt(col, 'surface_pressure', atMs),
		modelElevationM: sampleScalarAt(col, 'elevation', atMs) ?? col.elevationM,
		model: e.model,
		source: col.source ?? 'open-meteo',
		runs: col.runs ?? null,
	};
}

/** Asks for the forecast at an aerodrome over [fromMs, toMs], the hours its
 *  columns are flown at, unless what is held covers them and is still the
 *  forecast; joins a request in flight. Settles when the request does (the
 *  print preps await it) and never rejects: a failure keeps the column held
 *  and is asked again after RETRY_MS, or at once when `retry`. */
export function ensureAerodromeForecast(
	icao: string,
	lat: number,
	lon: number,
	fromMs: number,
	toMs: number,
	opts: { retry?: boolean; nowMs?: number } = {},
): Promise<void> {
	if (!display.liveWeather) {
		return Promise.resolve();
	}
	const nowMs = opts.nowMs ?? Date.now();
	const model = effectiveWindModel(lat, lon);
	ensureModelRun(model, nowMs);
	const pending = inflight.get(icao);
	if (pending) {
		// Asked for other hours (a plan re-timed) or under another model
		// while one is out: looked at again once it lands, rather than taking
		// its answer for this one's.
		return pending.then(() => ensureAerodromeForecast(icao, lat, lon, fromMs, toMs, opts));
	}
	const e = aerodromeForecasts.byIcao[icao];
	const samePlace = e !== undefined && e.model === model && e.lat === lat && e.lon === lon;
	// The hours wanted end where the endpoint's range does: a phase on the
	// fifteenth day after 23:00Z is past it, and held against that hour the
	// column never covered it and was asked again every minute.
	const wantEndMs = Math.min(toMs, forecastRangeEndMs(nowMs));
	if (
		samePlace &&
		e.col &&
		e.startMs <= fromMs &&
		wantEndMs <= e.endMs &&
		stampIsCurrent(e.stamp, e.fetchedMs, model, [{ lat, lon }], nowMs)
	) {
		return Promise.resolve();
	}
	if (samePlace && e.failedMs > 0 && nowMs - e.failedMs < RETRY_MS && !opts.retry) {
		return Promise.resolve();
	}
	// The hour before and three after, and a day from the start, as a route
	// asks: re-timing the plan within the day needs nothing new.
	const startMs = Math.floor(fromMs / HOUR_MS) * HOUR_MS - HOUR_MS;
	const endMs = Math.min(
		Math.max(Math.ceil(toMs / HOUR_MS) * HOUR_MS + 3 * HOUR_MS, startMs + 24 * HOUR_MS),
		forecastRangeEndMs(nowMs),
	);
	if (endMs < startMs) {
		return Promise.resolve();
	}
	const stamp = runStampFor(model);
	const held = samePlace ? e : undefined;
	const p = fetchWindColumns([{ lat, lon }], {
		model,
		startMs,
		endMs,
		levelsHpa: [],
		surface: true,
		surfacePressure: true,
		groundByHour: true,
	})
		.then((cols) => {
			const col = cols[0];
			if (!col) {
				// i18n-ignore: internal marker caught below, never shown
				throw new Error('short answer');
			}
			noteRuns(cols);
			aerodromeForecasts.byIcao[icao] = {
				lat,
				lon,
				model,
				col,
				stamp: columnStamp(col, model, stamp),
				fetchedMs: Date.now(),
				startMs,
				endMs,
				failedMs: 0,
			};
		})
		.catch(() => {
			aerodromeForecasts.byIcao[icao] = held
				? { ...held, failedMs: Date.now() }
				: { lat, lon, model, col: null, stamp, fetchedMs: 0, startMs, endMs, failedMs: Date.now() };
		})
		.finally(() => {
			inflight.delete(icao);
		});
	inflight.set(icao, p);
	return p;
}

/** Forgets every column (tests). */
export function resetAerodromeForecastsForTest(): void {
	inflight.clear();
	aerodromeForecasts.byIcao = {};
}
