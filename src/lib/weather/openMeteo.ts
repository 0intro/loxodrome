/* The winds-aloft client: the model registry, the forecast URL builder over
 * the pressure-level variables, the response normaliser (a bare object for one
 * location, an array for several), and the pure interpolation from a decoded
 * column to a wind sample at an arbitrary altitude and time.
 *
 * Two transports answer the same request in the same shape. Our own service,
 * nwp.loxodrome.fr (docs/nwp-service.md), serves what it ingests: Météo-France
 * AROME and ARPEGE and ECMWF IFS, and "Auto" is their chain everywhere
 * (auto_chain: AROME, then ARPEGE, then IFS, per point and hour). Open-Meteo,
 * browser-direct and metered per address, serves the models we do not ingest,
 * the windows older than a week, the points our Météo-France pick cannot
 * reach, and every request while our service fails (fetchWindColumns: one
 * failure opens a ten-minute circuit straight to Open-Meteo). Direction
 * convention matches the nav log: degrees TRUE, blowing FROM, knots; heights
 * are geopotential metres above mean sea level. Interpolation always runs on
 * the u/v components, never on direction and speed, so a 350 to 010 pair
 * averages to north instead of south. Contract notes: docs/wind-aloft.md.
 * The session caches live in $lib/state/windAloft.svelte.ts and
 * $lib/state/routeWind.svelte.ts; this module stays Svelte-free. */

import type { Bbox, DirRun } from './forecastCache';
import { isaPressureAltFt } from './qnh';
import { NWP_SERVICE } from '$lib/net/endpoints';

export const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';
export const HISTORICAL_BASE = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
const META_BASE = 'https://api.open-meteo.com/data';

/** Hung requests must settle; the awc.ts convention. Ours answers within the
 *  Worker's own 6 s or not at all, and a miss fails over to Open-Meteo. */
const FETCH_TIMEOUT_MS = 15_000;
const NWP_TIMEOUT_MS = 8_000;

const FT_TO_M = 0.3048;

export type WindModelId =
	| 'auto_chain'
	| 'meteofrance_seamless'
	| 'arome_france'
	| 'arpege_europe'
	| 'ukmo_seamless'
	| 'icon_seamless'
	| 'gfs_seamless'
	| 'ecmwf_ifs025'
	| 'best_match';

/** Who answers a model: our service, or Open-Meteo browser-direct. */
export type Transport = 'nwp' | 'open-meteo';

export interface WindModelSpec {
	id: WindModelId;
	label: string;
	transport: Transport;
	/** Offered by the Weather tab's picker; the chain is "Auto" itself. */
	listed: boolean;
	/** Forecast horizon in hours (animation slider clamp). */
	horizonH: number;
	/** Native grid spacing in degrees (map lattice clamp). */
	gridDeg: number;
	/** Pressure levels the model serves on Open-Meteo (live-verified). */
	levelsHpa: readonly number[];
	/** A chain's members' own ladders, where they differ from levelsHpa:
	 *  a point IFS serves has its eight levels alone (bracketLevelsHpa). */
	memberLevelsHpa?: readonly (readonly number[])[];
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
/** Météo-France's own ladder as our service stores it, to 300 hPa (FL300)
 *  with the 750 / 650 / 550 levels between: no 975, which AROME and ARPEGE
 *  do not publish. Open-Meteo's meteofrance_seamless answers the same names,
 *  so a failover asks the same ladder. */
export const MF_LEVELS = [1000, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300] as const;
/** ECMWF's open data below 250 hPa. */
export const IFS_LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300] as const;
/** AROME-OM's ladder as our service stores it, to 300 hPa: its files carry
 *  no 750, 650, 550 or 450, which come back null in its hours. */
export const OM_LEVELS = [1000, 950, 925, 900, 850, 800, 700, 600, 500, 400, 350, 300] as const;

const HOUR_MS = 3600_000;

interface Box {
	south: number;
	west: number;
	north: number;
	east: number;
}

/** One of our service's members: its run directory, its producer's model
 *  name (a product name, invariant in both languages), its grid's box (none
 *  for the globe), its native step and how far ahead its newest run reaches
 *  at worst, which the map lattice's clamp trusts (gridDegAt). */
export interface NwpMember {
	dir: string;
	name: string;
	box: Box | null;
	stepDeg: number;
	leadMs: number;
}

/** AROME-OM's newest run reaches +48 h from a start up to 6 h before the
 *  next and published about 9 h after its own: 33 h ahead at worst. */
const OM_LEAD_MS = 33 * HOUR_MS;

/** Our service's members in Auto's chain order, as loxodrome-nwp states
 *  them (models.ts; their boxes held to its models.json by the suite). The
 *  five AROME-OM domains share one name: a column is in one of them. */
export const NWP_MEMBERS: readonly NwpMember[] = [
	// AROME's newest run, a few hours old, reaches about 45 h ahead.
	{ dir: 'arome0025', name: 'AROME', box: { south: 37.5, west: -12, north: 55.4, east: 16 }, stepDeg: 0.025, leadMs: 45 * HOUR_MS },
	{ dir: 'aromeomantil', name: 'AROME-OM', box: { south: 9.7, west: -75.3, north: 22.9, east: -51.7 }, stepDeg: 0.025, leadMs: OM_LEAD_MS },
	{ dir: 'aromeomguyane', name: 'AROME-OM', box: { south: 1.05, west: -56.75, north: 8.95, east: -46.3 }, stepDeg: 0.025, leadMs: OM_LEAD_MS },
	{ dir: 'aromeomindien', name: 'AROME-OM', box: { south: -25.9, west: 32.75, north: -3.45, east: 67.6 }, stepDeg: 0.025, leadMs: OM_LEAD_MS },
	{ dir: 'aromeomncaled', name: 'AROME-OM', box: { south: -26, west: 158.5, north: -13.75, east: 171.5 }, stepDeg: 0.025, leadMs: OM_LEAD_MS },
	{ dir: 'aromeompolyn', name: 'AROME-OM', box: { south: -25.25, west: -157.5, north: -12.6, east: -144.5 }, stepDeg: 0.025, leadMs: OM_LEAD_MS },
	// ARPEGE's about 95 h.
	{ dir: 'arpege01', name: 'ARPEGE', box: { south: 20, west: -32, north: 72, east: 42 }, stepDeg: 0.1, leadMs: 95 * HOUR_MS },
	{ dir: 'ifs025', name: 'IFS', box: null, stepDeg: 0.25, leadMs: Infinity },
];

/** Models that exist on Open-Meteo but serve NO pressure-level winds (live
 *  checked: every *hPa variable returns null); they must never be offered.
 *  What Open-Meteo serves changes: the UK 2 km left the list on 2026-10-08,
 *  found serving every hour of 850 / 700 / 500 hPa through +48 h at
 *  Edinburgh (values ukmo_seamless returns first), while arome_france_hd
 *  still answered all nulls. Re-check a model live before trusting or
 *  editing the list. */
export const NO_PRESSURE_WIND_MODELS = ['arome_france_hd'] as const;

/* The `label` fields are the canonical English model labels; the UI reads
 * them through t.weather.windModels (FR mirror in $lib/i18n/fr/weather.ts,
 * the en/data.ts re-export pattern). */
// i18n-ignore-start: canonical English labels, FR mirror in $lib/i18n/fr/weather.ts
export const WIND_MODELS: readonly WindModelSpec[] = [
	{
		id: 'auto_chain',
		label: 'AROME / AROME-OM / ARPEGE (Météo-France), IFS (ECMWF)',
		transport: 'nwp',
		listed: false,
		horizonH: 360,
		// The lattice clamp follows the member covering the view (gridDegAt).
		gridDeg: 0.25,
		levelsHpa: MF_LEVELS,
		memberLevelsHpa: [MF_LEVELS, OM_LEVELS, IFS_LEVELS],
		metaDir: 'arome0025',
		// One group a directory: a group stands for the runs of one cycle.
		runDirs: NWP_MEMBERS.map((m) => [m.dir]),
	},
	{
		id: 'meteofrance_seamless',
		label: 'AROME / ARPEGE (Météo-France)',
		transport: 'nwp',
		listed: true,
		horizonH: 102,
		gridDeg: 0.025,
		levelsHpa: MF_LEVELS,
		metaDir: 'arpege01',
		runDirs: [['arome0025'], ['arpege01']],
	},
	{
		id: 'arome_france',
		label: 'AROME France (Météo-France)',
		transport: 'nwp',
		listed: true,
		horizonH: 51,
		gridDeg: 0.025,
		levelsHpa: MF_LEVELS,
		metaDir: 'arome0025',
		runDirs: [['arome0025']],
	},
	{
		id: 'arpege_europe',
		label: 'ARPEGE Europe (Météo-France)',
		transport: 'nwp',
		listed: true,
		horizonH: 102,
		gridDeg: 0.1,
		levelsHpa: MF_LEVELS,
		metaDir: 'arpege01',
		runDirs: [['arpege01']],
	},
	{
		id: 'ukmo_seamless',
		label: 'UKMO (Met Office)',
		transport: 'open-meteo',
		listed: true,
		horizonH: 168,
		gridDeg: 0.09,
		levelsHpa: FULL_LEVELS,
		metaDir: 'ukmo_global_deterministic_10km',
		runDirs: [['ukmo_uk_deterministic_2km'], ['ukmo_global_deterministic_10km']],
	},
	{
		id: 'icon_seamless',
		label: 'ICON (DWD)',
		transport: 'open-meteo',
		listed: true,
		horizonH: 180,
		gridDeg: 0.0625,
		levelsHpa: FULL_LEVELS,
		metaDir: 'dwd_icon',
		runDirs: [['dwd_icon_d2'], ['dwd_icon_eu'], ['dwd_icon']],
	},
	{
		id: 'gfs_seamless',
		label: 'GFS / HRRR (NOAA)',
		transport: 'open-meteo',
		listed: true,
		horizonH: 384,
		gridDeg: 0.11,
		levelsHpa: FULL_LEVELS,
		metaDir: 'ncep_gfs013',
		runDirs: [['ncep_hrrr_conus'], ['ncep_gfs013', 'ncep_gfs025']],
	},
	{
		id: 'ecmwf_ifs025',
		label: 'ECMWF IFS',
		transport: 'nwp',
		listed: true,
		horizonH: 360,
		gridDeg: 0.25,
		levelsHpa: IFS_LEVELS,
		metaDir: 'ifs025',
		runDirs: [['ifs025']],
	},
	{
		id: 'best_match',
		label: 'Best match (Open-Meteo)',
		transport: 'open-meteo',
		listed: true,
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

/** "Auto": our chain, everywhere. AROME serves France and its neighbours to
 *  +51 h, AROME-OM five overseas territories to +48 h, ARPEGE the rest of
 *  its Europe to +102 h, IFS everything else and every later hour
 *  (docs/wind-aloft.md "Model choice"). */
export function resolveAutoModel(_lat: number, _lon: number): WindModelId {
	return 'auto_chain';
}

/** How far ahead a window may start for the chain's European points to
 *  fail over to Open-Meteo's meteofrance_seamless: ARPEGE, its last member,
 *  ends 102 h after a run a few hours old, and Open-Meteo pads the hours
 *  past it with nulls (live-checked 2026-10-07 at +120 h), so a window
 *  starting later is asked of its IFS, which reaches the 15 days the chain
 *  promises. */
const MF_FAILOVER_LEAD_MS = 90 * 3600_000;

/** What the chain fails over to on Open-Meteo, per location and by how far
 *  ahead the window starts: its meteofrance_seamless over Europe (the same
 *  Météo-France models, the same level names) up to MF_FAILOVER_LEAD_MS,
 *  its IFS elsewhere and later. */
export function openMeteoFallbackModel(lat: number, lon: number, leadMs = 0): WindModelId {
	const europe = lat >= 29 && lat <= 72 && lon >= -35 && lon <= 45;
	return europe && leadMs <= MF_FAILOVER_LEAD_MS ? 'meteofrance_seamless' : 'ecmwf_ifs025';
}

/** The Open-Meteo model asked in place of one of ours at a location, for a
 *  window starting `leadMs` ahead. */
export function openMeteoTwin(model: WindModelId, lat: number, lon: number, leadMs = 0): WindModelId {
	return model === 'auto_chain' ? openMeteoFallbackModel(lat, lon, leadMs) : model;
}

function inBox(b: Box, lat: number, lon: number): boolean {
	const x = ((((lon + 180) % 360) + 360) % 360) - 180;
	return lat >= b.south && lat <= b.north && x >= b.west && x <= b.east;
}

/** The native grid step serving a location `leadMs` ahead, degrees: the
 *  chain's is that of the member serving the hour there (AROME and AROME-OM
 *  0.025, ARPEGE 0.1, IFS 0.25), so the map lattice never draws barbs finer
 *  than the model under them. */
export function gridDegAt(spec: WindModelSpec, lat: number, lon: number, leadMs = 0): number {
	if (spec.id !== 'auto_chain' && spec.id !== 'meteofrance_seamless') {
		return spec.gridDeg;
	}
	// The member serving the hour shown, by how far ahead it is: past a
	// member's reach a finer lattice repeated the coarser grid's barbs. The
	// Météo-France pick is AROME then ARPEGE, which ends it whatever the
	// lead, and outside ARPEGE's Europe it is Open-Meteo's ARPEGE World,
	// 0.25 too.
	for (const m of NWP_MEMBERS) {
		if (!m.box || !inBox(m.box, lat, lon)) {
			continue;
		}
		if (spec.id === 'meteofrance_seamless' && m.dir !== 'arome0025' && m.dir !== 'arpege01') {
			continue;
		}
		if (leadMs <= m.leadMs || (spec.id === 'meteofrance_seamless' && m.dir === 'arpege01')) {
			return m.stepDeg;
		}
	}
	return 0.25;
}

/** The height (m) of a model's top level, nominal: what an altitude above
 *  it reads clamped to. */
export function ladderTopM(spec: WindModelSpec): number {
	return Math.max(...spec.levelsHpa.map((l) => NOMINAL_LEVEL_M[l] ?? 0));
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
	750: 2466,
	700: 3012,
	650: 3591,
	600: 4206,
	550: 4865,
	500: 5574,
	450: 6344,
	400: 7185,
	350: 8117,
	300: 9164,
};

/** The subset of a model's ladder worth fetching for ONE altitude: the two
 *  levels below and two above the nominal height (clamped to the ladder), so
 *  real-atmosphere height wobble still brackets the target. The map lattice
 *  uses this to keep its many-location request ~2.3x lighter than the full
 *  ladder (requestWeight: each location costs a call per ten variables); the
 *  route fetch keeps the full ladder (few points, many leg altitudes). */
export function bracketLevelsHpa(spec: WindModelSpec, altFt: number): number[] {
	const targetM = altFt * FT_TO_M;
	const bracket = (levels: readonly number[]): number[] => {
		const ladder = [...levels].sort((a, b) => (NOMINAL_LEVEL_M[a] ?? 0) - (NOMINAL_LEVEL_M[b] ?? 0));
		let i = ladder.findIndex((l) => (NOMINAL_LEVEL_M[l] ?? 0) >= targetM);
		if (i < 0) {
			i = ladder.length;
		}
		return ladder.slice(Math.max(0, i - 2), Math.min(ladder.length, i + 2));
	};
	// A chain brackets on each member's ladder: on Météo-France's alone, a
	// point IFS serves got 850 hPa alone from 900 / 850 / 800 / 750 at
	// 5 000 ft and drew every barb faded, "above the forecast ladder".
	const ladders = spec.memberLevelsHpa ?? [spec.levelsHpa];
	const out = new Set<number>(ladders.flatMap(bracket));
	return [...out].sort((a, b) => (NOMINAL_LEVEL_M[a] ?? 0) - (NOMINAL_LEVEL_M[b] ?? 0));
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
	/** Who answered (absent: Open-Meteo). */
	source?: Transport | undefined;
	/** Our service's x_runs: per run directory, the run (ms UTC) that served
	 *  a LIVE hour of this column, what its provenance names. Empty when
	 *  every hour was past, which no later run will ever change; null or
	 *  absent for Open-Meteo's, and for an answer of ours stating none. */
	runs?: Readonly<Record<string, number>> | null | undefined;
	/** Our service's x_latest: per run directory the column depends on, the
	 *  newest run the service held when it answered, which freshness judges
	 *  the column by (an older run serves what the newest does not reach,
	 *  and hours past every reach depend on whichever model publishes
	 *  further). Absent from an older service, then x_runs stands in. */
	latest?: Readonly<Record<string, number>> | null | undefined;
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
	/** Also request surface_pressure (an aerodrome's forecast QNH). */
	surfacePressure?: boolean;
	/** Also request, of our service alone, the ground under each hour
	 *  (`elevation` as an hourly variable): the model that served the hour's
	 *  own, where a column states one elevation and a chain answers its
	 *  hours from several models. Open-Meteo knows no such variable; its
	 *  surface fields stand at the elevation it states. */
	groundByHour?: boolean;
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
		surfacePressure?: boolean;
		groundByHour?: boolean;
	},
	transport: Transport = spec.transport,
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
	if (opts.surfacePressure) {
		vars.push('surface_pressure');
	}
	if (opts.groundByHour && transport === 'nwp') {
		vars.push('elevation');
	}
	return vars;
}

export function buildForecastUrl(
	points: readonly { lat: number; lon: number }[],
	opts: WindFetchOpts,
	transport: Transport = windModel(opts.model).transport,
): string {
	const spec = windModel(opts.model);
	const params = new URLSearchParams({
		latitude: points.map((p) => p.lat.toFixed(4)).join(','),
		longitude: points.map((p) => p.lon.toFixed(4)).join(','),
		hourly: hourlyVariables(spec, opts, transport).join(','),
		models: opts.model,
		wind_speed_unit: 'kn',
		timeformat: 'unixtime',
		start_hour: isoHourUtc(opts.startMs),
		end_hour: isoHourUtc(opts.endMs),
	});
	return `${endpointFor(transport, opts.startMs, opts.nowMs ?? Date.now())}?${params.toString()}`;
}

/** The forecast endpoint a transport asks. */
export function endpointFor(transport: Transport, startMs: number, nowMs: number): string {
	return transport === 'nwp' ? `${NWP_SERVICE}/v1/forecast` : forecastBaseFor(startMs, nowMs);
}

interface RawLocation {
	latitude?: number;
	longitude?: number;
	elevation?: number;
	hourly?: Record<string, unknown>;
	x_runs?: unknown;
	x_latest?: unknown;
	x_unserved?: unknown;
}

/** A run map of our service's answer (seconds) in ms, null when absent. */
function runsOf(raw: unknown): Record<string, number> | null {
	if (!raw || typeof raw !== 'object') {
		return null;
	}
	const out: Record<string, number> = {};
	for (const [dir, s] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof s === 'number' && Number.isFinite(s)) {
			out[dir] = s * 1000;
		}
	}
	return out;
}

/** One location answers a bare object, several an array; normalise both.
 *  Our service's answers carry the runs each column used (x_runs, seconds)
 *  and mark a point no member covers (x_unserved), which comes back with
 *  `unserved` set for fetchWindColumns to ask Open-Meteo instead. */
export function normalizeForecast(body: unknown, source: Transport = 'open-meteo'): (WindColumn & { unserved?: boolean })[] {
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
		const col: WindColumn & { unserved?: boolean } = {
			lat: typeof raw.latitude === 'number' ? raw.latitude : 0,
			lon: typeof raw.longitude === 'number' ? raw.longitude : 0,
			elevationM: typeof raw.elevation === 'number' ? raw.elevation : 0,
			timesMs,
			hourly: vars,
			source,
			runs: null,
		};
		if (source === 'nwp') {
			// An answer stating no x_runs at all is no final column (an empty
			// one is): it ages out like an Open-Meteo answer (columnStamp).
			col.runs = runsOf(raw.x_runs);
			col.latest = runsOf(raw.x_latest);
			if (raw.x_unserved === true) {
				col.unserved = true;
			}
		}
		out.push(col);
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
	/** Our service failed in a way Open-Meteo can stand in for: a 5xx (the
	 *  `disabled` lever among them), a timeout, a network error, a body that
	 *  is not JSON, or a request it refused (`refused`). Its 429 is a backoff
	 *  and never a failover. */
	readonly failover: boolean;
	/** Our service refused the request (a 4xx other than its 429): it is up,
	 *  so the failover leaves the circuit closed for every other request. */
	readonly refused: boolean;
	/** Our service found the request too heavy for one answer and named the
	 *  parts to ask its points in (x_split), 0 otherwise. */
	readonly split: number;
	/** The failure is our service's (its 429 among them), not Open-Meteo's. */
	readonly ours: boolean;
	/** When the failed request of ours left (ms): a failure of one that
	 *  left before an answer of ours landed proves nothing of the service
	 *  now, and opens no circuit. */
	readonly startedMs: number | null;

	constructor(
		message: string,
		flags: {
			rateLimited?: boolean;
			quotaExhausted?: boolean;
			outOfRange?: boolean;
			failover?: boolean;
			refused?: boolean;
			split?: number;
			ours?: boolean;
			startedMs?: number;
		} = {},
	) {
		super(message);
		this.rateLimited = flags.rateLimited === true;
		this.quotaExhausted = flags.quotaExhausted === true;
		this.outOfRange = flags.outOfRange === true;
		this.failover = flags.failover === true;
		this.refused = flags.refused === true;
		this.split = flags.split ?? 0;
		this.ours = flags.ours === true;
		this.startedMs = flags.startedMs ?? null;
	}
}

/** Fetch + decode ONE multi-location request (the coalescer below is its only
 *  caller). Throws OpenMeteoError on HTTP or Open-Meteo
 *  {"error":true,"reason":…} failures. */
async function requestColumns(
	points: readonly { lat: number; lon: number }[],
	opts: WindFetchOpts,
	signal: AbortSignal,
	transport: Transport,
): Promise<(WindColumn & { unserved?: boolean })[]> {
	if (transport === 'nwp') {
		return requestNwp(points, opts, signal);
	}
	const res = await fetch(buildForecastUrl(points, opts, transport), {
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

/** One request to our service, its failures classed for the failover. */
async function requestNwp(
	points: readonly { lat: number; lon: number }[],
	opts: WindFetchOpts,
	signal: AbortSignal,
): Promise<(WindColumn & { unserved?: boolean })[]> {
	const startedMs = Date.now();
	let res: Response;
	try {
		res = await fetch(buildForecastUrl(points, opts, 'nwp'), {
			signal: AbortSignal.any([AbortSignal.timeout(NWP_TIMEOUT_MS), signal]),
		});
	} catch (err) {
		if (signal.aborted) {
			throw err;
		}
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new OpenMeteoError(`nwp fetch failed: ${err instanceof Error ? err.message : String(err)}`, {
			failover: true,
			ours: true,
			startedMs,
		});
	}
	const body: unknown = await res.json().catch(() => undefined);
	if (res.status === 429) {
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new OpenMeteoError('nwp fetch failed: rate limited', { rateLimited: true, ours: true, startedMs });
	}
	if (body === undefined || res.status >= 500) {
		const reason = body && typeof body === 'object' && 'reason' in body ? String(body.reason) : `HTTP ${res.status}`;
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new OpenMeteoError(`nwp fetch failed: ${reason}`, { failover: true, ours: true, startedMs });
	}
	if (!res.ok) {
		// A refusal: a request the service cannot answer as asked (a client
		// newer than the service, say), which Open-Meteo answers in its
		// stead; or one too heavy for one answer, whose points the
		// coalescer asks again in the parts the service names.
		const reason = body && typeof body === 'object' && 'reason' in body ? String(body.reason) : `HTTP ${res.status}`;
		const parts = body && typeof body === 'object' && 'x_split' in body ? Number(body.x_split) : 0;
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new OpenMeteoError(`nwp fetch failed: ${reason}`, {
			failover: true,
			refused: true,
			split: Number.isInteger(parts) && parts >= 2 ? parts : 0,
			ours: true,
			startedMs,
		});
	}
	closeNwpCircuit();
	return normalizeForecast(body, 'nwp');
}

/* ----------------------------------------------------------- failover -- */

/** While our service failed in the last NWP_CIRCUIT_MS, requests go straight
 *  to Open-Meteo rather than each waiting out a failure first; any answer of
 *  ours (a run poll included) closes it. The privacy text states it. */
export const NWP_CIRCUIT_MS = 10 * 60_000;
let nwpDownUntilMs = 0;
/** When an answer of ours last landed (a run poll included). */
let nwpAnsweredMs = 0;

function openNwpCircuit(nowMs: number): void {
	nwpDownUntilMs = nowMs + NWP_CIRCUIT_MS;
}

function closeNwpCircuit(): void {
	nwpDownUntilMs = 0;
	nwpAnsweredMs = Date.now();
}

/** Whether a request goes to our service now (the circuit closed). */
export function nwpAvailable(nowMs = Date.now()): boolean {
	return nowMs >= nwpDownUntilMs;
}

/** Our service serves the hours of the last week (each run's first hours
 *  kept seven days); a window starting earlier is Open-Meteo's. The privacy
 *  text states it. */
export const NWP_PAST_MS = 7 * 24 * 3600_000;

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
/** Requests out at once, app-wide, per transport: Open-Meteo refuses a
 *  sixth in flight from one address; ours serves from the edge. */
const MAX_IN_FLIGHT: Record<Transport, number> = { 'open-meteo': 2, nwp: 4 };
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
	resolve: (columns: (WindColumn & { unserved?: boolean })[]) => void;
	reject: (err: unknown) => void;
	done: boolean;
}

interface Batch {
	key: string;
	transport: Transport;
	opts: WindFetchOpts;
	callers: Caller[];
	timer: ReturnType<typeof setTimeout> | null;
	ctrl: AbortController;
	sent: boolean;
}

const batches = new Map<string, Batch>();
const inFlight: Record<Transport, number> = { 'open-meteo': 0, nwp: 0 };
const waiting: Record<Transport, (() => void)[]> = { 'open-meteo': [], nwp: [] };

/** The rejection of a call its own signal withdrew, the shape fetch itself
 *  rejects with; callers recognise it by name and never show it. */
function abortError(): DOMException {
	// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
	return new DOMException('The operation was aborted.', 'AbortError');
}

/** A request slot, handed straight to the next waiter when one frees. */
function acquire(transport: Transport): Promise<void> {
	if (inFlight[transport] < MAX_IN_FLIGHT[transport]) {
		inFlight[transport]++;
		return Promise.resolve();
	}
	return new Promise((resolve) => waiting[transport].push(resolve));
}

function release(transport: Transport): void {
	const next = waiting[transport].shift();
	if (next) {
		next();
	} else {
		inFlight[transport]--;
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
	// A chunk's columns in one request, or, when our service finds that too
	// heavy for one answer, in the contiguous parts it names, side by side,
	// each taking a request slot of its own once this one is released. A
	// part short of columns makes its whole chunk short.
	const run = async (chunk: { lat: number; lon: number }[]): Promise<(WindColumn & { unserved?: boolean })[]> => {
		let parts = 0;
		await acquire(batch.transport);
		try {
			if (batch.ctrl.signal.aborted) {
				throw abortError();
			}
			return await requestColumns(chunk, opts, batch.ctrl.signal, batch.transport);
		} catch (err) {
			if (!(err instanceof OpenMeteoError) || err.split < 2 || chunk.length < 2) {
				throw err;
			}
			parts = Math.min(err.split, chunk.length);
		} finally {
			release(batch.transport);
		}
		const groups = Array.from({ length: parts }, (_, g) =>
			chunk.slice(Math.floor((g * chunk.length) / parts), Math.floor(((g + 1) * chunk.length) / parts)),
		);
		const answers = await Promise.all(groups.map(run));
		return answers.every((a, g) => a.length === groups[g].length) ? answers.flat() : [];
	};
	void Promise.all(chunks.map(run)).then(
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
 *  point in order. A model of ours is asked of our service unless its
 *  window starts more than a week back or the failover circuit is open;
 *  a failure Open-Meteo can stand in for (OpenMeteoError.failover) asks
 *  Open-Meteo the same thing at once, the chain as openMeteoFallbackModel
 *  per location and lead, and opens the circuit unless the service merely refused
 *  this request; the points our service does not cover (x_unserved) are
 *  asked of Open-Meteo too. Our 429 is a backoff, never a failover, and a
 *  request too heavy for one answer is asked again in parts by the
 *  coalescer. Rejects with OpenMeteoError on HTTP or {"error":true,
 *  "reason":…} failures, with an AbortError when `opts.signal` aborts first;
 *  resolves short (fewer columns than points) on an answer that carried no
 *  forecast. */
export async function fetchWindColumns(
	points: readonly { lat: number; lon: number }[],
	opts: WindFetchOpts,
): Promise<WindColumn[]> {
	const spec = windModel(opts.model);
	if (spec.transport !== 'nwp') {
		return coalesce(points, opts, 'open-meteo');
	}
	const nowMs = opts.nowMs ?? Date.now();
	// The ladder is the model's own whoever answers: a failover asks the
	// same names, which its levels lack come back null.
	const same: WindFetchOpts = { ...opts, levelsHpa: opts.levelsHpa ?? spec.levelsHpa };
	if (opts.startMs < nowMs - NWP_PAST_MS || !nwpAvailable(nowMs)) {
		return viaOpenMeteo(points, same);
	}
	let cols: (WindColumn & { unserved?: boolean })[];
	try {
		cols = await coalesce(points, same, 'nwp');
	} catch (err) {
		if (!(err instanceof OpenMeteoError && err.failover) || opts.signal?.aborted) {
			throw err;
		}
		// A refusal is this request's alone, and a request that left before
		// an answer of ours landed (a slow one failing after a quick one
		// succeeded) says nothing of the service now: neither shuts it out
		// for ten minutes.
		if (!err.refused && !(err.startedMs !== null && err.startedMs <= nwpAnsweredMs)) {
			openNwpCircuit(Date.now());
		}
		return viaOpenMeteo(points, same);
	}
	const unserved = cols.flatMap((c, i) => (c.unserved ? [i] : []));
	if (unserved.length === 0 || cols.length !== points.length) {
		return cols;
	}
	const filled = await viaOpenMeteo(
		unserved.map((i) => points[i]),
		same,
	);
	if (filled.length !== unserved.length) {
		// Short, like any answer missing a point: an unserved column kept
		// here would be stamped final (it used no run) and never asked again.
		return [];
	}
	unserved.forEach((i, k) => {
		cols[i] = filled[k];
	});
	return cols;
}

/** Asks Open-Meteo for a model of ours: each location of the chain from its
 *  own fallback model, the others under the same name. */
async function viaOpenMeteo(points: readonly { lat: number; lon: number }[], opts: WindFetchOpts): Promise<WindColumn[]> {
	const groups = new Map<WindModelId, number[]>();
	const leadMs = opts.startMs - (opts.nowMs ?? Date.now());
	points.forEach((p, i) => {
		const twin = openMeteoTwin(opts.model, p.lat, p.lon, leadMs);
		groups.set(twin, [...(groups.get(twin) ?? []), i]);
	});
	const out: WindColumn[] = new Array<WindColumn>(points.length);
	let short = false;
	await Promise.all(
		[...groups].map(async ([twin, idx]) => {
			const cols = await coalesce(
				idx.map((i) => points[i]),
				{ ...opts, model: twin },
				'open-meteo',
			);
			if (cols.length !== idx.length) {
				short = true;
				return;
			}
			idx.forEach((i, k) => {
				out[i] = cols[k];
			});
		}),
	);
	return short ? [] : out;
}

/** Through the coalescer below: the request it joins may ask for more hours
 *  than this caller did. */
function coalesce(
	points: readonly { lat: number; lon: number }[],
	opts: WindFetchOpts,
	transport: Transport,
): Promise<(WindColumn & { unserved?: boolean })[]> {
	const signal = opts.signal;
	if (signal?.aborted) {
		return Promise.reject(abortError());
	}
	const nowMs = opts.nowMs ?? Date.now();
	const key = [
		endpointFor(transport, opts.startMs, nowMs),
		opts.model,
		Math.floor(opts.startMs / MERGE_SPAN_MS),
		hourlyVariables(windModel(opts.model), opts, transport).join(','),
	].join('|');
	return new Promise<(WindColumn & { unserved?: boolean })[]>((resolve, reject) => {
		let batch = batches.get(key);
		if (!batch) {
			// The batch's own request is aborted by its callers, never by
			// the first caller's signal alone.
			const shared: WindFetchOpts = { ...opts };
			delete shared.signal;
			const created: Batch = {
				key,
				transport,
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
	/** The deviation from the ISA at the sample's PRESSURE altitude
	 *  (degC), interpolated in height between the ladder's levels as the
	 *  temperature is, each level's being exact; null without a
	 *  temperature, below the model ground or above the ladder, where a
	 *  clamped temperature would misstate it. */
	isaDevC: number | null;
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
	/** The level's own ISA deviation (null on the 10 m entry, which states
	 *  no pressure, and without a temperature). */
	isaDevC: number | null;
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
		entries.push({ hM: surfaceHM, ...windToUV(dir10, spd10), tempC: at(col, 'temperature_2m', idx), isaDevC: null });
	}
	for (const level of columnLevels(col)) {
		const hM = at(col, `geopotential_height_${level}hPa`, idx);
		const spd = at(col, `wind_speed_${level}hPa`, idx);
		const dir = at(col, `wind_direction_${level}hPa`, idx);
		if (hM == null || spd == null || dir == null || hM <= surfaceHM) {
			continue;
		}
		const tempC = at(col, `temperature_${level}hPa`, idx);
		entries.push({
			hM,
			...windToUV(dir, spd),
			tempC,
			isaDevC: tempC != null ? tempC - levelIsaTempC(level) : null,
		});
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
			// The deviation is interpolated in height like the temperature:
			// with each level's exact, that is the pressure altitude taken
			// linear in height between them, the ingest's own convention
			// (docs/wind-aloft.md "ISA").
			return {
				hM: targetHM,
				u: lerp(lo.u, hi.u, f),
				v: lerp(lo.v, hi.v, f),
				tempC: lerpTemp(lo.tempC, hi.tempC, f),
				isaDevC: lerpTemp(lo.isaDevC, hi.isaDevC, f),
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
	const belowGround = targetHM < col.elevationM;
	const aboveTop = targetHM > topHM;
	return {
		dirTrueDeg: dirFromDeg,
		speedKt,
		tempC: lerpTemp(a.tempC, b.tempC, f),
		isaDevC: belowGround || aboveTop ? null : lerpTemp(a.isaDevC, b.isaDevC, f),
		belowGround,
		aboveTop,
	};
}

export interface SurfaceSample {
	dirTrueDeg: number;
	speedKt: number;
	gustKt: number | null;
	tempC: number | null;
	/** The 2 m temperature's deviation from the ISA at the surface
	 *  pressure's pressure altitude, both on the ground of the model that
	 *  served the hour; null unless both were fetched. */
	isaDevC: number | null;
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
	const tempC = pick('temperature_2m');
	const pressureHpa = pick('surface_pressure');
	return {
		dirTrueDeg: dirFromDeg,
		speedKt,
		gustKt: pick('wind_gusts_10m'),
		tempC,
		isaDevC: tempC != null && pressureHpa != null ? tempC - isaTempC(isaPressureAltFt(pressureHpa)) : null,
	};
}

/** Mean-sea-level pressure (hPa) at an instant, hour-interpolated like the
 *  surface sample; null when pressure_msl did not ride the fetch or the
 *  instant is outside the window. */
export function sampleMslpAt(col: WindColumn, timeMs: number): number | null {
	return sampleScalarAt(col, 'pressure_msl', timeMs);
}

/** One hourly variable at an instant, linear between the hours around it
 *  (the nearer hour where one side is null); null when it did not ride the
 *  fetch or the instant is outside the window. */
export function sampleScalarAt(col: WindColumn, name: string, timeMs: number): number | null {
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
	const a = at(col, name, i);
	const b = at(col, name, j);
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

/** A column's freezing level: its altitude (ft MSL), and `atOrBelow` when
 *  the lowest level carrying a temperature is already at or below 0 degC,
 *  the level then being that level's height or lower (route fetches carry
 *  no 2 m temperature, so nothing is known between it and the ground). */
export interface FreezingLevel {
	ft: number;
	atOrBelow: boolean;
}

/** The freezing level of a column at an instant: the LOWEST height where
 *  the temperature crosses 0 degC, linearly interpolated between the
 *  temperature-carrying level entries (the 10 m surface entry carries no
 *  temperature on route fetches and is skipped). Already sub-zero at the
 *  lowest measured level clamps to that level's height, `atOrBelow`; a
 *  column above zero throughout returns null (freezing sits above the
 *  fetched ladder). Hour-interpolated like sampleWindAt, at or below when
 *  either hour is. */
export function freezingLevelAt(col: WindColumn, timeMs: number): FreezingLevel | null {
	const times = col.timesMs;
	if (times.length === 0 || timeMs < times[0] || timeMs > times[times.length - 1]) {
		return null;
	}
	let i = 0;
	while (i < times.length - 2 && times[i + 1] < timeMs) {
		i++;
	}
	const surfaceHM = col.elevationM + 10;
	const at = (idx: number): { hM: number; atOrBelow: boolean } | null => {
		const entries = columnAt(col, idx, surfaceHM).flatMap((e) =>
			e.tempC == null ? [] : [{ hM: e.hM, t: e.tempC }],
		);
		if (entries.length === 0) {
			return null;
		}
		if (entries[0].t <= 0) {
			return { hM: entries[0].hM, atOrBelow: true };
		}
		for (let k = 0; k + 1 < entries.length; k++) {
			const lo = entries[k];
			const hi = entries[k + 1];
			if (lo.t > 0 && hi.t <= 0) {
				return { hM: lo.hM + (lo.t / (lo.t - hi.t)) * (hi.hM - lo.hM), atOrBelow: false };
			}
		}
		return null;
	};
	const a = at(i);
	const b = times.length > 1 ? at(i + 1) : a;
	const span = times.length > 1 ? times[i + 1] - times[i] : 1;
	const f = Math.min(1, Math.max(0, (timeMs - times[i]) / span));
	if (a == null || b == null) {
		const near = f < 0.5 ? a : b;
		return near == null ? null : { ft: near.hM / FT_TO_M, atOrBelow: near.atOrBelow };
	}
	return { ft: (a.hM + (b.hM - a.hM) * f) / FT_TO_M, atOrBelow: a.atOrBelow || b.atOrBelow };
}

/** The freezing-level altitude (ft MSL) alone (freezingLevelAt): the
 *  profile's dashed line. */
export function freezingLevelFt(col: WindColumn, timeMs: number): number | null {
	return freezingLevelAt(col, timeMs)?.ft ?? null;
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
 *  outside the fetched hour window. Upstream the per-level cover is the
 *  model's own cloud fraction for AROME and ARPEGE as our service serves
 *  them, and a relative-humidity diagnostic (Sundqvist 1989) for IFS and
 *  for every model Open-Meteo serves, a failover included:
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

/** The ISA temperature at a PRESSURE altitude (the troposphere's lapse,
 *  1.9812 degC per 1000 ft). The deviation is taken against it at the
 *  pressure altitude of the air sampled (ICAO Doc 7488), never at its height
 *  above the sea, which a high or a low moves a degree or so: see
 *  levelIsaTempC and sampleSurfaceAt. */
export function isaTempC(pressureAltFt: number): number {
	return 15 - 1.9812 * (pressureAltFt / 1000);
}

// A ladder level's ISA temperature, its pressure altitude being its own:
// a few distinct levels, so a small cache spares the power per entry.
const levelIsaTemp = new Map<number, number>();

/** An ISA deviation as every surface writes it after "ISA": whole degrees,
 *  signed, "+6", "-3", "+0". Locale-invariant, like the abbreviation. */
export function fmtIsaDev(devC: number): string {
	const dev = Math.round(devC);
	return `${dev >= 0 ? '+' : ''}${dev}`;
}

/** The ISA temperature of a pressure level (hPa). */
function levelIsaTempC(levelHpa: number): number {
	let t = levelIsaTemp.get(levelHpa);
	if (t === undefined) {
		t = isaTempC(isaPressureAltFt(levelHpa));
		levelIsaTemp.set(levelHpa, t);
	}
	return t;
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

/** Our service's run directories and their producers' model names (product
 *  names, invariant in both languages), in the chain's order; every other
 *  directory is Open-Meteo's, whose run polls go there (fetchModelRun). */
export const NWP_DIR_NAMES: Readonly<Record<string, string>> = Object.fromEntries(NWP_MEMBERS.map((m) => [m.dir, m.name]));
export const NWP_DIRS: ReadonlySet<string> = new Set(Object.keys(NWP_DIR_NAMES));

/** The runs our service's columns used, distinct, in the chain's order then
 *  by time: what a provenance names (never a run the figures did not come
 *  from), and whether any column came from Open-Meteo instead. */
export function columnsProvenance(cols: readonly (WindColumn | null)[]): {
	runs: { dir: string; name: string; runMs: number }[];
	viaOpenMeteo: boolean;
} {
	const seen = new Set<string>();
	const runs: { dir: string; name: string; runMs: number }[] = [];
	let viaOpenMeteo = false;
	for (const c of cols) {
		if (!c) {
			continue;
		}
		if (c.source !== 'nwp') {
			viaOpenMeteo = true;
			continue;
		}
		for (const [dir, runMs] of Object.entries(c.runs ?? {})) {
			// By name: two AROME-OM domains a route spans are one model.
			const name = NWP_DIR_NAMES[dir] ?? dir;
			if (!seen.has(`${name}|${runMs}`)) {
				seen.add(`${name}|${runMs}`);
				runs.push({ dir, name, runMs });
			}
		}
	}
	const order = Object.keys(NWP_DIR_NAMES);
	runs.sort((a, b) => order.indexOf(a.dir) - order.indexOf(b.dir) || a.runMs - b.runMs);
	return { runs, viaOpenMeteo };
}

/** The runs last polled for a chain's directories whose grid holds a point,
 *  one per model name and run, in the chain's order: what the Weather tab
 *  names while the map shows none of our columns, never a run serving
 *  nothing under the view. A directory not ours holds every point. */
export function polledRunsAt(
	dirs: readonly string[],
	byDir: Readonly<Record<string, number | undefined>>,
	lat: number,
	lon: number,
): { name: string; ms: number }[] {
	const out: { name: string; ms: number }[] = [];
	const seen = new Set<string>();
	for (const dir of dirs) {
		const ms = byDir[dir];
		const member = NWP_MEMBERS.find((m) => m.dir === dir);
		if (ms == null || (member?.box && !inBox(member.box, lat, lon))) {
			continue;
		}
		const name = member?.name ?? dir;
		if (!seen.has(`${name}|${ms}`)) {
			seen.add(`${name}|${ms}`);
			out.push({ name, ms });
		}
	}
	return out;
}

/** One run directory's last run (an unmetered endpoint, unlike the forecast);
 *  any failure, an unknown directory included, resolves null. An answer of
 *  our service's closes the failover circuit. */
export async function fetchModelRun(dir: string): Promise<DirRun | null> {
	const ours = NWP_DIRS.has(dir);
	try {
		const res = await fetch(ours ? `${NWP_SERVICE}/v1/data/${dir}/static/meta.json` : `${META_BASE}/${dir}/static/meta.json`, {
			signal: AbortSignal.timeout(ours ? NWP_TIMEOUT_MS : FETCH_TIMEOUT_MS),
		});
		if (!res.ok) {
			return null;
		}
		const run = parseRunMeta(await res.json());
		if (ours && run) {
			closeNwpCircuit();
		}
		return run;
	} catch {
		return null;
	}
}

/** Resets the failover circuit (tests). */
export function resetNwpCircuitForTest(): void {
	nwpDownUntilMs = 0;
	nwpAnsweredMs = 0;
}
