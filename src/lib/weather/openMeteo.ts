/* Open-Meteo winds-aloft client: the model registry (auto pick by region,
 * pressure-level capability verified live), the forecast URL builder over the
 * pressure-level variables, the response normaliser (a bare object for one
 * location, an array for several), and the pure interpolation from a decoded
 * column to a wind sample at an arbitrary altitude and time. Direction
 * convention matches the nav log: degrees TRUE, blowing FROM, knots; heights
 * are geopotential metres above mean sea level. Interpolation always runs on
 * the u/v components, never on direction and speed, so a 350 to 010 pair
 * averages to north instead of south. Contract notes: docs/wind-aloft.md.
 * The session caches live in $lib/state/windAloft.svelte.ts and
 * $lib/state/routeWind.svelte.ts; this module stays Svelte-free. */

import type { Bbox, DirRun } from './forecastCache';

export const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';
export const HISTORICAL_BASE = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
const META_BASE = 'https://api.open-meteo.com/data';

/** Hung requests must settle; the awc.ts convention. */
const FETCH_TIMEOUT_MS = 15_000;

const FT_TO_M = 0.3048;

export type WindModelId =
	| 'meteofrance_seamless'
	| 'arome_france'
	| 'arpege_europe'
	| 'ukmo_seamless'
	| 'icon_seamless'
	| 'gfs_seamless'
	| 'ecmwf_ifs025'
	| 'best_match';

export interface WindModelSpec {
	id: WindModelId;
	label: string;
	/** Forecast horizon in hours (animation slider clamp). */
	horizonH: number;
	/** Native grid spacing in degrees (map lattice clamp). */
	gridDeg: number;
	/** Pressure levels the model serves on Open-Meteo (live-verified). */
	levelsHpa: readonly number[];
	/** Directory of the /data/{dir}/static/meta.json run endpoint whose run
	 *  the provenance names; the directory names differ from the models=
	 *  values and are not published, so null (or a 404) just hides the run
	 *  line. */
	metaDir: string | null;
	/** The run directories whose new run changes what this model serves,
	 *  grouped by cycle (forecastCache.ts): a column is refetched when one of
	 *  them publishes, never on a clock. The surface grids count, the 10 m
	 *  wind riding every column. Empty when unknown (best_match): its columns
	 *  then age out instead. */
	runDirs: readonly (readonly string[])[];
}

/** The standard near-surface ladder; 925 hPa sits near 2500 ft. */
const FULL_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500] as const;
/** ECMWF publishes a reduced set (no 975 / 950 / 900 / 800). */
const ECMWF_LEVELS = [1000, 925, 850, 700, 600, 500] as const;

/** Models that exist on Open-Meteo but serve NO pressure-level winds (live
 *  checked: every *hPa variable returns null); they must never be offered. */
export const NO_PRESSURE_WIND_MODELS = ['arome_france_hd', 'ukmo_uk_deterministic_2km'] as const;

/* The `label` fields are the canonical English model labels; the UI reads
 * them through t.weather.windModels (FR mirror in $lib/i18n/fr/weather.ts,
 * the en/data.ts re-export pattern). */
// i18n-ignore-start: canonical English labels, FR mirror in $lib/i18n/fr/weather.ts
export const WIND_MODELS: readonly WindModelSpec[] = [
	{
		id: 'meteofrance_seamless',
		label: 'AROME / ARPEGE (Météo-France)',
		horizonH: 96,
		gridDeg: 0.025,
		levelsHpa: FULL_LEVELS,
		metaDir: 'meteofrance_arpege_europe',
		runDirs: [
			['meteofrance_arome_france_hd', 'meteofrance_arome_france0025'],
			['meteofrance_arpege_europe', 'meteofrance_arpege_world025'],
		],
	},
	{
		id: 'arome_france',
		label: 'AROME France (Météo-France)',
		horizonH: 48,
		gridDeg: 0.025,
		levelsHpa: FULL_LEVELS,
		metaDir: 'meteofrance_arome_france0025',
		runDirs: [['meteofrance_arome_france0025']],
	},
	{
		id: 'arpege_europe',
		label: 'ARPEGE Europe (Météo-France)',
		horizonH: 96,
		gridDeg: 0.1,
		levelsHpa: FULL_LEVELS,
		metaDir: 'meteofrance_arpege_europe',
		runDirs: [['meteofrance_arpege_europe']],
	},
	{
		id: 'ukmo_seamless',
		label: 'UKMO (Met Office)',
		horizonH: 168,
		gridDeg: 0.09,
		levelsHpa: FULL_LEVELS,
		metaDir: 'ukmo_global_deterministic_10km',
		runDirs: [['ukmo_uk_deterministic_2km'], ['ukmo_global_deterministic_10km']],
	},
	{
		id: 'icon_seamless',
		label: 'ICON (DWD)',
		horizonH: 180,
		gridDeg: 0.0625,
		levelsHpa: FULL_LEVELS,
		metaDir: 'dwd_icon',
		runDirs: [['dwd_icon_d2'], ['dwd_icon_eu'], ['dwd_icon']],
	},
	{
		id: 'gfs_seamless',
		label: 'GFS / HRRR (NOAA)',
		horizonH: 384,
		gridDeg: 0.11,
		levelsHpa: FULL_LEVELS,
		metaDir: 'ncep_gfs013',
		runDirs: [['ncep_hrrr_conus'], ['ncep_gfs013', 'ncep_gfs025']],
	},
	{
		id: 'ecmwf_ifs025',
		label: 'ECMWF IFS',
		horizonH: 360,
		gridDeg: 0.25,
		levelsHpa: ECMWF_LEVELS,
		metaDir: 'ecmwf_ifs025',
		runDirs: [['ecmwf_ifs025']],
	},
	{
		id: 'best_match',
		label: 'Best match (Open-Meteo)',
		horizonH: 168,
		gridDeg: 0.1,
		levelsHpa: FULL_LEVELS,
		metaDir: null,
		runDirs: [],
	},
];
// i18n-ignore-end

const MODEL_BY_ID = new Map(WIND_MODELS.map((m) => [m.id, m]));

export function windModel(id: WindModelId): WindModelSpec {
	return MODEL_BY_ID.get(id) ?? WIND_MODELS[0];
}

/** The "most suitable model for the region" default: a named national model
 *  per location so tooltips can always say which model served the wind.
 *  Boxes are checked in order; the UK wins over the wider Europe box. */
export function resolveAutoModel(lat: number, lon: number): WindModelId {
	if (lat >= 49 && lat <= 61.5 && lon >= -9 && lon <= 2.5) {
		return 'ukmo_seamless';
	}
	if (lat >= 29 && lat <= 72 && lon >= -35 && lon <= 45) {
		return 'meteofrance_seamless';
	}
	if (lat >= 14 && lat <= 75 && lon >= -170 && lon <= -50) {
		return 'gfs_seamless';
	}
	return 'ecmwf_ifs025';
}

/** Nominal ISA geopotential heights (m MSL) of the ladder levels, for
 *  choosing which levels a fetch needs around a target altitude. */
const NOMINAL_LEVEL_M: Record<number, number> = {
	1000: 111,
	975: 323,
	950: 540,
	925: 762,
	900: 988,
	850: 1457,
	800: 1949,
	700: 3012,
	600: 4206,
	500: 5574,
};

/** The subset of a model's ladder worth fetching for ONE altitude: the two
 *  levels below and two above the nominal height (clamped to the ladder), so
 *  real-atmosphere height wobble still brackets the target. The map lattice
 *  uses this to keep its many-location request ~2.3x lighter than the full
 *  ladder (requestWeight: each location costs a call per ten variables); the
 *  route fetch keeps the full ladder (few points, many leg altitudes). */
export function bracketLevelsHpa(spec: WindModelSpec, altFt: number): number[] {
	const targetM = altFt * FT_TO_M;
	const ladder = [...spec.levelsHpa].sort((a, b) => (NOMINAL_LEVEL_M[a] ?? 0) - (NOMINAL_LEVEL_M[b] ?? 0));
	let i = ladder.findIndex((l) => (NOMINAL_LEVEL_M[l] ?? 0) >= targetM);
	if (i < 0) {
		i = ladder.length;
	}
	return ladder.slice(Math.max(0, i - 2), Math.min(ladder.length, i + 2));
}

/* ---------------------------------------------------------------- fetch -- */

/** One decoded location: the model grid-cell elevation plus the raw hourly
 *  arrays keyed by variable name (null entries where a model lacks data). */
export interface WindColumn {
	lat: number;
	lon: number;
	/** Grid-cell ground elevation, metres MSL. */
	elevationM: number;
	/** UTC hour steps, epoch milliseconds. */
	timesMs: number[];
	hourly: Record<string, (number | null)[] | undefined>;
}

export interface WindFetchOpts {
	model: WindModelId;
	/** Requested hour window, epoch ms UTC (inclusive, snapped to hours). */
	startMs: number;
	endMs: number;
	/** Pressure levels to request; defaults to the model's full ladder. The
	 *  lattice passes bracketLevelsHpa() to keep the request weight low. */
	levelsHpa?: readonly number[];
	/** Request the winds (each level's speed and direction, and the 10 m
	 *  pair); default true. Off, a level keeps its height, which is what the
	 *  route's cloud columns need of it. */
	winds?: boolean;
	/** Also request temperature_{L}hPa (leg tooltips, TAS, isotherm). */
	temps?: boolean;
	/** Also request cloud_cover_{L}hPa (the profile's cloud curtain). */
	clouds?: boolean;
	/** Also request wind_gusts_10m + temperature_2m (Surface map level). */
	surface?: boolean;
	/** Also request pressure_msl (the isobar overlay). */
	mslp?: boolean;
	signal?: AbortSignal;
	/** Injected for tests; defaults to the wall clock. */
	nowMs?: number;
}

function isoHourUtc(ms: number): string {
	return new Date(ms).toISOString().slice(0, 13) + ':00';
}

/** The forecast endpoint keeps roughly 92 past days; older windows come from
 *  the historical-forecast endpoint (same variables, live-verified). */
export function forecastBaseFor(startMs: number, nowMs: number): string {
	const PAST_LIMIT_MS = 88 * 24 * 3600_000;
	return startMs < nowMs - PAST_LIMIT_MS ? HISTORICAL_BASE : FORECAST_BASE;
}

/** How far ahead the forecast endpoint accepts an hour window at all, in
 *  whole UTC days. BOTH start_hour and end_hour are range-checked, and a
 *  request outside answers HTTP 400 "Parameter 'start_hour' is out of
 *  allowed range from <date> to <date>" rather than a clamped window
 *  (live-verified 2026-08-21 from 2026-08-21: 2026-09-05T23:00 answers,
 *  2026-09-06T00:00 does not). The PAST side needs no constant here:
 *  forecastBaseFor hands windows older than 88 days to the historical
 *  endpoint, inside the ~92 days this one keeps. */
export const FORECAST_MAX_AHEAD_DAYS = 15;

/** The last hour the forecast endpoint will accept: 23:00 UTC on the
 *  FORECAST_MAX_AHEAD_DAYS-th day after today (the range is stated in whole
 *  dates and includes its last one). */
export function forecastRangeEndMs(nowMs: number): number {
	const d = new Date(nowMs);
	return Date.UTC(
		d.getUTCFullYear(),
		d.getUTCMonth(),
		d.getUTCDate() + FORECAST_MAX_AHEAD_DAYS,
		23,
	);
}

/** The last hour a forecast can answer for: the model's own horizon from the
 *  current hour, and never past the endpoint's own range (GFS sees 384 h,
 *  Open-Meteo's forecast API accepts +15 days, so the min is load-bearing).
 *  Pure. */
export function forecastReachEndMs(nowMs: number, horizonH: number): number {
	const nowHourMs = Math.floor(nowMs / 3600_000) * 3600_000;
	return Math.min(nowHourMs + horizonH * 3600_000, forecastRangeEndMs(nowMs));
}

/** What Open-Meteo charges for one request, in calls (its server's own rule,
 *  docs/wind-aloft.md "The request budget"): each location costs one call per
 *  ten variables, never less than one, and a period past two weeks
 *  multiplies it. The free tier allows 10 000 a day per IPv4 address. */
export function requestWeight(locations: number, variables: number, days: number): number {
	return locations * Math.max(1, (variables / 10) * Math.max(1, days / 14));
}

export function hourlyVariables(
	spec: WindModelSpec,
	opts: {
		levelsHpa?: readonly number[] | undefined;
		winds?: boolean | undefined;
		temps?: boolean;
		clouds?: boolean;
		surface?: boolean;
		mslp?: boolean;
	},
): string[] {
	const winds = opts.winds !== false;
	const vars: string[] = [];
	for (const l of opts.levelsHpa ?? spec.levelsHpa) {
		if (winds) {
			vars.push(`wind_speed_${l}hPa`, `wind_direction_${l}hPa`);
		}
		vars.push(`geopotential_height_${l}hPa`);
		if (opts.temps) {
			vars.push(`temperature_${l}hPa`);
		}
		if (opts.clouds) {
			vars.push(`cloud_cover_${l}hPa`);
		}
	}
	if (winds) {
		vars.push('wind_speed_10m', 'wind_direction_10m');
	}
	if (opts.surface) {
		vars.push('wind_gusts_10m', 'temperature_2m');
	}
	if (opts.mslp) {
		vars.push('pressure_msl');
	}
	return vars;
}

export function buildForecastUrl(points: readonly { lat: number; lon: number }[], opts: WindFetchOpts): string {
	const spec = windModel(opts.model);
	const params = new URLSearchParams({
		latitude: points.map((p) => p.lat.toFixed(4)).join(','),
		longitude: points.map((p) => p.lon.toFixed(4)).join(','),
		hourly: hourlyVariables(spec, opts).join(','),
		models: opts.model,
		wind_speed_unit: 'kn',
		timeformat: 'unixtime',
		start_hour: isoHourUtc(opts.startMs),
		end_hour: isoHourUtc(opts.endMs),
	});
	return `${forecastBaseFor(opts.startMs, opts.nowMs ?? Date.now())}?${params.toString()}`;
}

interface RawLocation {
	latitude?: number;
	longitude?: number;
	elevation?: number;
	hourly?: Record<string, unknown>;
}

/** One location answers a bare object, several an array; normalise both. */
export function normalizeForecast(body: unknown): WindColumn[] {
	const list: RawLocation[] = Array.isArray(body) ? (body as RawLocation[]) : [body as RawLocation];
	const out: WindColumn[] = [];
	for (const raw of list) {
		// A 200 response with an unreadable body decodes to null upstream
		// (fetchWindColumns); degrade to an empty result, not a TypeError.
		if (!raw || typeof raw !== 'object') {
			continue;
		}
		const hourly = raw.hourly;
		if (!hourly || !Array.isArray(hourly.time)) {
			continue;
		}
		const timesMs = (hourly.time as number[]).map((s) => s * 1000);
		const vars: Record<string, (number | null)[]> = {};
		for (const [key, value] of Object.entries(hourly)) {
			if (key !== 'time' && Array.isArray(value)) {
				vars[key] = value as (number | null)[];
			}
		}
		out.push({
			lat: typeof raw.latitude === 'number' ? raw.latitude : 0,
			lon: typeof raw.longitude === 'number' ? raw.longitude : 0,
			elevationM: typeof raw.elevation === 'number' ? raw.elevation : 0,
			timesMs,
			hourly: vars,
		});
	}
	return out;
}

/** A failed Open-Meteo call. Three flags mark the failures that mean
 *  something to the caller: rateLimited, any spent budget, so the state
 *  layers back off instead of surfacing a dead error; quotaExhausted, the
 *  DAY's or MONTH's budget specifically, which no backoff can outwait (the
 *  minute and hour windows can); and outOfRange, the window the endpoint
 *  refuses outright (see FORECAST_MAX_AHEAD_DAYS), which no retry heals
 *  either. Anything else is an ordinary failure. */
export class OpenMeteoError extends Error {
	readonly rateLimited: boolean;
	readonly quotaExhausted: boolean;
	readonly outOfRange: boolean;

	constructor(
		message: string,
		flags: { rateLimited?: boolean; quotaExhausted?: boolean; outOfRange?: boolean } = {},
	) {
		super(message);
		this.rateLimited = flags.rateLimited === true;
		this.quotaExhausted = flags.quotaExhausted === true;
		this.outOfRange = flags.outOfRange === true;
	}
}

/** Fetch + decode ONE multi-location request (the coalescer below is its only
 *  caller). Throws OpenMeteoError on HTTP or Open-Meteo
 *  {"error":true,"reason":…} failures. */
async function requestColumns(
	points: readonly { lat: number; lon: number }[],
	opts: WindFetchOpts,
	signal: AbortSignal,
): Promise<WindColumn[]> {
	const res = await fetch(buildForecastUrl(points, opts), {
		signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), signal]),
	});
	const body: unknown = await res.json().catch(() => null);
	if (!res.ok) {
		const reason =
			body && typeof body === 'object' && 'reason' in body ? String(body.reason) : `HTTP ${res.status}`;
		const limited = res.status === 429 || /request limit/i.test(reason);
		// The free tier meters four windows and names the one it refused
		// ("Daily API request limit exceeded. Please try again tomorrow.",
		// live-seen 2026-08-21). The day and month ones outlast any backoff,
		// so they are a state to report rather than a wait to sit through.
		const quotaExhausted = limited && /\b(daily|monthly)\b/i.test(reason);
		// The endpoint names the refused parameter and its own allowed dates;
		// reading the reason keeps the classification right even if the
		// FORECAST_MAX_AHEAD_DAYS ceiling ever moves under us.
		const outOfRange = /out of allowed range/i.test(reason);
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new OpenMeteoError(`open-meteo fetch failed: ${reason}`, {
			rateLimited: limited,
			quotaExhausted,
			outOfRange,
		});
	}
	return normalizeForecast(body);
}

/* -------------------------------------------------- request coalescing -- */

/* Forecast requests leave together and few at a time (docs/wind-aloft.md,
 * "The request budget"). Every call made within COALESCE_MS that asks the
 * same endpoint for the same model and variables joins ONE request: each
 * distinct point asked once, over the union of the hours asked (hours cost
 * nothing under two weeks), and each caller handed its own points' columns,
 * in its own order. At most MAX_IN_FLIGHT requests are out at once, app-wide:
 * Open-Meteo runs one request per address at a time, refuses the sixth in
 * flight, and a cancelled browser request still holds its slot. A call
 * aborted before its request leaves takes itself out of it, and a request
 * every caller abandoned never leaves at all, so a burst of edits costs the
 * last one's request. A short answer (a portal's page, a body cut short)
 * answers every caller short: none can tell which of its points it lacks. */

/** How long a request waits for others to join it. */
const COALESCE_MS = 250;
/** Requests out at once, app-wide. */
const MAX_IN_FLIGHT = 2;
/** Points one request carries at most: a whole map lattice (126) in one,
 *  well inside the endpoint's own limits (1 000 locations, and a request
 *  weighing over 5 000 calls refused: two hundred locations of a full ladder
 *  of winds and clouds weigh 1 040). */
const MAX_POINTS_PER_REQUEST = 200;
/** Requests merge only when they start within the same week, so that their
 *  union stays well short of the two weeks past which Open-Meteo charges
 *  more. */
const MERGE_SPAN_MS = 7 * 24 * 3600_000;

interface Caller {
	points: readonly { lat: number; lon: number }[];
	startMs: number;
	endMs: number;
	resolve: (columns: WindColumn[]) => void;
	reject: (err: unknown) => void;
	done: boolean;
}

interface Batch {
	key: string;
	opts: WindFetchOpts;
	callers: Caller[];
	timer: ReturnType<typeof setTimeout> | null;
	ctrl: AbortController;
	sent: boolean;
}

const batches = new Map<string, Batch>();
let inFlight = 0;
const waiting: (() => void)[] = [];

/** The rejection of a call its own signal withdrew, the shape fetch itself
 *  rejects with; callers recognise it by name and never show it. */
function abortError(): DOMException {
	// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
	return new DOMException('The operation was aborted.', 'AbortError');
}

/** A request slot, handed straight to the next waiter when one frees. */
function acquire(): Promise<void> {
	if (inFlight < MAX_IN_FLIGHT) {
		inFlight++;
		return Promise.resolve();
	}
	return new Promise((resolve) => waiting.push(resolve));
}

function release(): void {
	const next = waiting.shift();
	if (next) {
		next();
	} else {
		inFlight--;
	}
}

function pointKey(p: { lat: number; lon: number }): string {
	return `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
}

function abandon(batch: Batch, caller: Caller): void {
	if (caller.done) {
		return;
	}
	caller.done = true;
	caller.reject(abortError());
	if (batch.callers.every((c) => c.done)) {
		if (!batch.sent) {
			if (batch.timer) {
				clearTimeout(batch.timer);
			}
			batches.delete(batch.key);
		} else {
			batch.ctrl.abort();
		}
	}
}

function flush(batch: Batch): void {
	batches.delete(batch.key);
	batch.sent = true;
	const live = batch.callers.filter((c) => !c.done);
	if (live.length === 0) {
		return;
	}
	const index = new Map<string, number>();
	const points: { lat: number; lon: number }[] = [];
	for (const c of live) {
		for (const p of c.points) {
			const k = pointKey(p);
			if (!index.has(k)) {
				index.set(k, points.length);
				points.push(p);
			}
		}
	}
	const opts: WindFetchOpts = {
		...batch.opts,
		startMs: Math.min(...live.map((c) => c.startMs)),
		endMs: Math.max(...live.map((c) => c.endMs)),
	};
	const chunks: { lat: number; lon: number }[][] = [];
	for (let i = 0; i < points.length; i += MAX_POINTS_PER_REQUEST) {
		chunks.push(points.slice(i, i + MAX_POINTS_PER_REQUEST));
	}
	const settle = (fn: (c: Caller) => void): void => {
		for (const c of live) {
			if (!c.done) {
				c.done = true;
				fn(c);
			}
		}
	};
	void Promise.all(
		chunks.map(async (chunk) => {
			await acquire();
			try {
				if (batch.ctrl.signal.aborted) {
					throw abortError();
				}
				return await requestColumns(chunk, opts, batch.ctrl.signal);
			} finally {
				release();
			}
		}),
	).then(
		(parts) => {
			const whole = parts.every((part, i) => part.length === chunks[i].length);
			const columns = parts.flat();
			settle((c) =>
				c.resolve(whole ? c.points.map((p) => columns[index.get(pointKey(p)) ?? -1]) : []),
			);
		},
		(err: unknown) => settle((c) => c.reject(err)),
	);
}

/** The forecast columns at `points` over the hours `opts` asks for, one per
 *  point in order, through the coalescer above (the request it joins may ask
 *  for more hours than this caller did). Rejects with OpenMeteoError on HTTP
 *  or Open-Meteo {"error":true,"reason":…} failures, with an AbortError when
 *  `opts.signal` aborts first; resolves short (fewer columns than points) on
 *  an answer that carried no forecast. */
export function fetchWindColumns(
	points: readonly { lat: number; lon: number }[],
	opts: WindFetchOpts,
): Promise<WindColumn[]> {
	const signal = opts.signal;
	if (signal?.aborted) {
		return Promise.reject(abortError());
	}
	const nowMs = opts.nowMs ?? Date.now();
	const key = [
		forecastBaseFor(opts.startMs, nowMs),
		opts.model,
		Math.floor(opts.startMs / MERGE_SPAN_MS),
		hourlyVariables(windModel(opts.model), opts).join(','),
	].join('|');
	return new Promise<WindColumn[]>((resolve, reject) => {
		let batch = batches.get(key);
		if (!batch) {
			// The batch's own request is aborted by its callers, never by
			// the first caller's signal alone.
			const shared: WindFetchOpts = { ...opts };
			delete shared.signal;
			const created: Batch = {
				key,
				opts: shared,
				callers: [],
				timer: null,
				ctrl: new AbortController(),
				sent: false,
			};
			created.timer = setTimeout(() => flush(created), COALESCE_MS);
			batches.set(key, created);
			batch = created;
		}
		const joined = batch;
		const caller: Caller = { points, startMs: opts.startMs, endMs: opts.endMs, resolve, reject, done: false };
		joined.callers.push(caller);
		signal?.addEventListener('abort', () => abandon(joined, caller), { once: true });
	});
}

/* ------------------------------------------------------------- sampling -- */

export interface WindAloftSample {
	/** Direction the wind blows FROM, degrees true. */
	dirTrueDeg: number;
	speedKt: number;
	/** Interpolated air temperature, when the fetch asked for temps. */
	tempC: number | null;
	/** The target altitude sits below the model ground: the 10 m wind is
	 *  returned instead of an underground extrapolation. */
	belowGround: boolean;
	/** The target altitude sits above the fetched pressure ladder: the top
	 *  level's wind is returned clamped, flagged like the belowGround twin
	 *  so consumers (the level advisor's self-skip) can refuse it. */
	aboveTop: boolean;
}

/** Wind FROM dir/speed to the u/v vector components (toward east / north). */
export function windToUV(dirFromDeg: number, speedKt: number): { u: number; v: number } {
	const rad = (dirFromDeg * Math.PI) / 180;
	return { u: -speedKt * Math.sin(rad), v: -speedKt * Math.cos(rad) };
}

export function uvToWind(u: number, v: number): { dirFromDeg: number; speedKt: number } {
	const speedKt = Math.hypot(u, v);
	if (speedKt < 1e-9) {
		return { dirFromDeg: 0, speedKt: 0 };
	}
	const dir = (Math.atan2(-u, -v) * 180) / Math.PI;
	return { dirFromDeg: (dir + 360) % 360, speedKt };
}

interface ColumnEntry {
	hM: number;
	u: number;
	v: number;
	tempC: number | null;
}

const LEVEL_RE = /^geopotential_height_(\d+)hPa$/;

function columnLevels(col: WindColumn): number[] {
	const levels: number[] = [];
	for (const key of Object.keys(col.hourly)) {
		const m = LEVEL_RE.exec(key);
		if (m) {
			levels.push(Number(m[1]));
		}
	}
	return levels;
}

function at(col: WindColumn, name: string, idx: number): number | null {
	const arr = col.hourly[name];
	const v = arr ? arr[idx] : null;
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The sorted usable entries of one forecast hour: the 10 m surface wind
 *  first, then every pressure level that resolves above the surface (levels
 *  extrapolated below the grid-cell ground are dropped). */
function columnAt(col: WindColumn, idx: number, surfaceHM: number): ColumnEntry[] {
	const entries: ColumnEntry[] = [];
	const spd10 = at(col, 'wind_speed_10m', idx);
	const dir10 = at(col, 'wind_direction_10m', idx);
	if (spd10 != null && dir10 != null) {
		entries.push({ hM: surfaceHM, ...windToUV(dir10, spd10), tempC: at(col, 'temperature_2m', idx) });
	}
	for (const level of columnLevels(col)) {
		const hM = at(col, `geopotential_height_${level}hPa`, idx);
		const spd = at(col, `wind_speed_${level}hPa`, idx);
		const dir = at(col, `wind_direction_${level}hPa`, idx);
		if (hM == null || spd == null || dir == null || hM <= surfaceHM) {
			continue;
		}
		entries.push({ hM, ...windToUV(dir, spd), tempC: at(col, `temperature_${level}hPa`, idx) });
	}
	entries.sort((a, b) => a.hM - b.hM);
	return entries;
}

function lerp(a: number, b: number, f: number): number {
	return a + (b - a) * f;
}

function lerpTemp(a: number | null, b: number | null, f: number): number | null {
	if (a == null || b == null) {
		return f < 0.5 ? a : b;
	}
	return lerp(a, b, f);
}

function sampleColumn(entries: ColumnEntry[], targetHM: number): ColumnEntry | null {
	if (entries.length === 0) {
		return null;
	}
	if (targetHM <= entries[0].hM) {
		return entries[0];
	}
	const last = entries[entries.length - 1];
	if (targetHM >= last.hM) {
		return last;
	}
	for (let i = 0; i < entries.length - 1; i++) {
		const lo = entries[i];
		const hi = entries[i + 1];
		if (targetHM <= hi.hM) {
			const f = (targetHM - lo.hM) / (hi.hM - lo.hM);
			return {
				hM: targetHM,
				u: lerp(lo.u, hi.u, f),
				v: lerp(lo.v, hi.v, f),
				tempC: lerpTemp(lo.tempC, hi.tempC, f),
			};
		}
	}
	return last;
}

/** The last instant the column actually carries wind data, or null when it
 *  carries none at all.
 *
 *  Past a model's OWN horizon the API answers a request with the hours
 *  present and every value null rather than a shortened time array
 *  (live-verified 2026-08-21: meteofrance_seamless at +136 h returns
 *  `wind_speed_925hPa: [null]`), so `timesMs` alone never says how far the
 *  forecast reaches and a null-padded tail reads exactly like a fetched
 *  hour. Callers compare an instant against this to tell "the model does
 *  not go that far" from "we have nothing for this leg". An hour counts as
 *  reached when any wind speed resolves there (the 10 m surface or any
 *  pressure level); the heights and directions sampleWindAt also needs are
 *  deliberately not tested, so a column that carries winds but cannot be
 *  sampled reads as reached and its legs report the vaguer no-data. */
export function columnReachMs(col: WindColumn): number | null {
	const keys = ['wind_speed_10m', ...columnLevels(col).map((l) => `wind_speed_${l}hPa`)];
	// Backwards: an un-padded column answers on its first iteration.
	for (let i = col.timesMs.length - 1; i >= 0; i--) {
		if (keys.some((k) => at(col, k, i) != null)) {
			return col.timesMs[i];
		}
	}
	return null;
}

/** Sample one column at an altitude (feet MSL) and instant. Returns null
 *  outside the fetched hour window (before it, or past the column's reach:
 *  see columnReachMs); a target below the model ground returns the 10 m
 *  wind flagged belowGround, a target above the pressure ladder the top
 *  level's wind flagged aboveTop. Interpolates u/v in height, then linearly
 *  across the two bracketing forecast hours. */
export function sampleWindAt(col: WindColumn, altFt: number, timeMs: number): WindAloftSample | null {
	const times = col.timesMs;
	if (times.length === 0 || timeMs < times[0] || timeMs > times[times.length - 1]) {
		return null;
	}
	let i = 0;
	while (i < times.length - 2 && times[i + 1] < timeMs) {
		i++;
	}
	const surfaceHM = col.elevationM + 10;
	const targetHM = altFt * FT_TO_M;
	const colA = columnAt(col, i, surfaceHM);
	const colB = times.length > 1 ? columnAt(col, i + 1, surfaceHM) : colA;
	const a = sampleColumn(colA, targetHM);
	const b = times.length > 1 ? sampleColumn(colB, targetHM) : a;
	if (!a || !b) {
		return null;
	}
	// Clamped whenever the target tops out EITHER bracketing hour's ladder
	// (both non-empty here: an empty column nulls its sample above).
	const topHM = Math.min(colA[colA.length - 1].hM, colB[colB.length - 1].hM);
	const span = times.length > 1 ? times[i + 1] - times[i] : 1;
	const f = Math.min(1, Math.max(0, (timeMs - times[i]) / span));
	const u = lerp(a.u, b.u, f);
	const v = lerp(a.v, b.v, f);
	const { dirFromDeg, speedKt } = uvToWind(u, v);
	return {
		dirTrueDeg: dirFromDeg,
		speedKt,
		tempC: lerpTemp(a.tempC, b.tempC, f),
		belowGround: targetHM < col.elevationM,
		aboveTop: targetHM > topHM,
	};
}

export interface SurfaceSample {
	dirTrueDeg: number;
	speedKt: number;
	gustKt: number | null;
	tempC: number | null;
}

/** The 10 m surface wind (plus gusts and 2 m temperature when fetched),
 *  nearest-hour interpolated like sampleWindAt. */
export function sampleSurfaceAt(col: WindColumn, timeMs: number): SurfaceSample | null {
	const times = col.timesMs;
	if (times.length === 0 || timeMs < times[0] || timeMs > times[times.length - 1]) {
		return null;
	}
	let i = 0;
	while (i < times.length - 2 && times[i + 1] < timeMs) {
		i++;
	}
	const j = times.length > 1 ? i + 1 : i;
	const span = times.length > 1 ? times[j] - times[i] : 1;
	const f = Math.min(1, Math.max(0, (timeMs - times[i]) / span));
	const pick = (name: string): number | null => {
		const a = at(col, name, i);
		const b = at(col, name, j);
		if (a == null || b == null) {
			return f < 0.5 ? a : b;
		}
		return lerp(a, b, f);
	};
	const spdA = at(col, 'wind_speed_10m', i);
	const dirA = at(col, 'wind_direction_10m', i);
	const spdB = at(col, 'wind_speed_10m', j);
	const dirB = at(col, 'wind_direction_10m', j);
	if (spdA == null || dirA == null || spdB == null || dirB == null) {
		return null;
	}
	const a = windToUV(dirA, spdA);
	const b = windToUV(dirB, spdB);
	const { dirFromDeg, speedKt } = uvToWind(lerp(a.u, b.u, f), lerp(a.v, b.v, f));
	return { dirTrueDeg: dirFromDeg, speedKt, gustKt: pick('wind_gusts_10m'), tempC: pick('temperature_2m') };
}

/** Mean-sea-level pressure (hPa) at an instant, hour-interpolated like the
 *  surface sample; null when pressure_msl did not ride the fetch or the
 *  instant is outside the window. */
export function sampleMslpAt(col: WindColumn, timeMs: number): number | null {
	const times = col.timesMs;
	if (times.length === 0 || timeMs < times[0] || timeMs > times[times.length - 1]) {
		return null;
	}
	let i = 0;
	while (i < times.length - 2 && times[i + 1] < timeMs) {
		i++;
	}
	const j = times.length > 1 ? i + 1 : i;
	const span = times.length > 1 ? times[j] - times[i] : 1;
	const f = Math.min(1, Math.max(0, (timeMs - times[i]) / span));
	const a = at(col, 'pressure_msl', i);
	const b = at(col, 'pressure_msl', j);
	if (a == null || b == null) {
		return f < 0.5 ? a : b;
	}
	return lerp(a, b, f);
}

/** The isobar values to contour (multiples of stepHpa inside [min, max]),
 *  capped so a degenerate field cannot enumerate hundreds of lines. */
export function isobarLevels(minHpa: number, maxHpa: number, stepHpa = 4, cap = 20): number[] {
	if (!Number.isFinite(minHpa) || !Number.isFinite(maxHpa) || maxHpa <= minHpa) {
		return [];
	}
	const out: number[] = [];
	for (let v = Math.ceil(minHpa / stepHpa) * stepHpa; v <= maxHpa && out.length < cap; v += stepHpa) {
		out.push(v);
	}
	return out;
}

/** The freezing-level altitude (ft MSL) of a column at an instant: the
 *  LOWEST height where the temperature crosses 0 degC, linearly
 *  interpolated between the temperature-carrying level entries (the 10 m
 *  surface entry carries no temperature on route fetches and is skipped).
 *  Already sub-zero at the lowest measured level clamps to that level's
 *  height; a column above zero throughout returns null (freezing sits
 *  above the fetched ladder). Hour-interpolated like sampleWindAt. */
export function freezingLevelFt(col: WindColumn, timeMs: number): number | null {
	const times = col.timesMs;
	if (times.length === 0 || timeMs < times[0] || timeMs > times[times.length - 1]) {
		return null;
	}
	let i = 0;
	while (i < times.length - 2 && times[i + 1] < timeMs) {
		i++;
	}
	const surfaceHM = col.elevationM + 10;
	const at = (idx: number): number | null => {
		const entries = columnAt(col, idx, surfaceHM).flatMap((e) =>
			e.tempC == null ? [] : [{ hM: e.hM, t: e.tempC }],
		);
		if (entries.length === 0) {
			return null;
		}
		if (entries[0].t <= 0) {
			return entries[0].hM;
		}
		for (let k = 0; k + 1 < entries.length; k++) {
			const lo = entries[k];
			const hi = entries[k + 1];
			if (lo.t > 0 && hi.t <= 0) {
				return lo.hM + (lo.t / (lo.t - hi.t)) * (hi.hM - lo.hM);
			}
		}
		return null;
	};
	const a = at(i);
	const b = times.length > 1 ? at(i + 1) : a;
	const span = times.length > 1 ? times[i + 1] - times[i] : 1;
	const f = Math.min(1, Math.max(0, (timeMs - times[i]) / span));
	const hM = a == null || b == null ? (f < 0.5 ? a : b) : a + (b - a) * f;
	return hM == null ? null : hM / FT_TO_M;
}

/* --------------------------------------------------------------- clouds -- */

/** One ladder level's cloud cover, resolved to its geopotential altitude. */
export interface CloudCoverLevel {
	altFt: number;
	/** Cloud fraction at the level, percent 0..100. */
	coverPct: number;
}

/** The cloud-cover profile of a column at an instant: one entry per ladder
 *  level serving BOTH cloud_cover_{L}hPa and its geopotential height, the
 *  two hour-interpolated like sampleWindAt (cover is a scalar; no u/v
 *  subtlety) and sorted by altitude. Levels are skipped one by one: the
 *  cover can be null where the wind is served (meteofrance_seamless serves
 *  975 hPa wind but all-null 975 hPa cloud), and heights resolving at or
 *  below the model surface are dropped (the columnAt convention). Empty
 *  outside the fetched hour window. Upstream the per-level cover is an
 *  RH-derived approximation (Sundqvist 1989), not a native cloud field:
 *  docs/wind-aloft.md. */
export function cloudCoverProfileAt(col: WindColumn, timeMs: number): CloudCoverLevel[] {
	const times = col.timesMs;
	if (times.length === 0 || timeMs < times[0] || timeMs > times[times.length - 1]) {
		return [];
	}
	let i = 0;
	while (i < times.length - 2 && times[i + 1] < timeMs) {
		i++;
	}
	const j = times.length > 1 ? i + 1 : i;
	const span = times.length > 1 ? times[j] - times[i] : 1;
	const f = Math.min(1, Math.max(0, (timeMs - times[i]) / span));
	const surfaceHM = col.elevationM + 10;
	const out: CloudCoverLevel[] = [];
	for (const level of columnLevels(col)) {
		const hA = at(col, `geopotential_height_${level}hPa`, i);
		const hB = at(col, `geopotential_height_${level}hPa`, j);
		const cA = at(col, `cloud_cover_${level}hPa`, i);
		const cB = at(col, `cloud_cover_${level}hPa`, j);
		if (hA == null || hB == null || cA == null || cB == null) {
			continue;
		}
		const hM = lerp(hA, hB, f);
		if (hM <= surfaceHM) {
			continue;
		}
		out.push({ altFt: hM / FT_TO_M, coverPct: Math.min(100, Math.max(0, lerp(cA, cB, f))) });
	}
	out.sort((a, b) => a.altFt - b.altFt);
	return out;
}

/** Cover percent -> oktas (0..8, nearest). */
export function cloudOktas(coverPct: number): number {
	return Math.max(0, Math.min(8, Math.round(coverPct / 12.5)));
}

/** The METAR cloud-amount word for an okta count; null below FEW. */
export function cloudAmountLabel(oktas: number): 'FEW' | 'SCT' | 'BKN' | 'OVC' | null {
	if (oktas >= 8) {
		return 'OVC';
	}
	if (oktas >= 5) {
		return 'BKN';
	}
	if (oktas >= 3) {
		return 'SCT';
	}
	if (oktas >= 1) {
		return 'FEW';
	}
	return null;
}

/* ------------------------------------------------------------------ ISA -- */

/** ISA temperature at an altitude (troposphere lapse 1.9812 degC / 1000 ft). */
export function isaTempC(altFt: number): number {
	return 15 - 1.9812 * (altFt / 1000);
}

export function isaDevC(altFt: number, tempC: number): number {
	return tempC - isaTempC(altFt);
}

/* ------------------------------------------------------------- run meta -- */

const BBOX_RE = /BBOX\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/;

/** One run directory's meta.json: its last run, its cadence, and the extent
 *  of its grid read off the crs_wkt's BBOX, which is a real outline only for
 *  a latitude/longitude grid (GEOGCRS): a projected grid's (PROJCRS, HRRR,
 *  the UK 2 km) is its corners and misses most of it, so it reads as
 *  unknown, as does a global one. Null without a run. Pure. */
export function parseRunMeta(body: unknown): DirRun | null {
	if (!body || typeof body !== 'object') {
		return null;
	}
	const b = body as {
		last_run_initialisation_time?: unknown;
		update_interval_seconds?: unknown;
		crs_wkt?: unknown;
	};
	const init = b.last_run_initialisation_time;
	if (typeof init !== 'number' || !Number.isFinite(init)) {
		return null;
	}
	const every = b.update_interval_seconds;
	let bbox: Bbox | null = null;
	const crs = typeof b.crs_wkt === 'string' ? b.crs_wkt : '';
	const m = /^\s*GEOGCRS\b/.test(crs) ? BBOX_RE.exec(crs) : null;
	if (m) {
		const [s, w, n, e] = m.slice(1, 5).map(Number);
		if ([s, w, n, e].every(Number.isFinite) && n > s && e - w < 359) {
			bbox = [s, w, n, e];
		}
	}
	return {
		initMs: init * 1000,
		bbox,
		intervalMs: typeof every === 'number' && every > 0 ? every * 1000 : null,
	};
}

/** One run directory's last run (an unmetered endpoint, unlike the forecast);
 *  any failure, an unknown directory included, resolves null. */
export async function fetchModelRun(dir: string): Promise<DirRun | null> {
	try {
		const res = await fetch(`${META_BASE}/${dir}/static/meta.json`, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) {
			return null;
		}
		return parseRunMeta(await res.json());
	} catch {
		return null;
	}
}
