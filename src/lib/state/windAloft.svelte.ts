/* Winds-aloft panel state + the map lattice cache.
 *
 * Panel preferences (model, level, show-on-map, isotherm) persist via the
 * store-only-non-default idiom; the planning flags (useForecastForLegs,
 * tempTas) are session state that round-trips through the route YAML like
 * vfr / semicircular; validTimeMs is session-only on purpose (a stale date
 * must never persist).
 *
 * Reactivity contract (the routeTerrain one): windGrid is written ONLY here
 * and, on the synchronous ensure path, only inside untrack(), so the MapView
 * effect driving ensureWindGrid never subscribes to the cache through the
 * call; consumers read windGridBarbs() / windGridIsotherm() inside their own
 * deriveds. Freshness / abort / in-flight bookkeeping lives in plain module
 * variables. Every fetch is gated on display.liveWeather (the documented
 * network kill switch) AND showOnMap; nothing is requested while hidden. */

import { t } from './i18n.svelte';
import { errorTextOf, type ErrorText } from '$lib/i18n/errorText';
import { untrack } from 'svelte';
import { readItem, removeItem, writeItem } from './persist';
import { display } from './display.svelte';
import {
	OpenMeteoError,
	WIND_MODELS,
	bracketLevelsHpa,
	fetchModelRun,
	fetchWindColumns,
	isaDevC,
	isobarLevels,
	resolveAutoModel,
	sampleMslpAt,
	sampleSurfaceAt,
	sampleWindAt,
	windModel,
	type WindColumn,
	type WindModelId,
} from '$lib/weather/openMeteo';
import type { IsobarLine } from '$lib/map/windLayer';
import { buildLattice, latticeStepDeg, type Lattice } from '$lib/weather/lattice';
import { gustLabel } from '$lib/weather/windBarbs';
import { isolines, type IsoGrid } from '$lib/weather/isotherm';

const MODEL_KEY = 'loxodrome:wind-model';
const LEVEL_KEY = 'loxodrome:wind-level';
const SHOW_KEY = 'loxodrome:wind-map';
const ISO_KEY = 'loxodrome:wind-isotherm';
const ISO_C_KEY = 'loxodrome:wind-isotherm-c';
const ISOBAR_KEY = 'loxodrome:wind-isobars';

export const DEFAULT_LEVEL_FT = 2500;

/** A pressure-interpolated altitude in feet MSL, or the 10 m surface wind. */
export type WindLevel = number | 'sfc';

export function floorHourMs(ms: number): number {
	return Math.floor(ms / 3600_000) * 3600_000;
}

export function nextHourMs(ms: number): number {
	return Math.ceil(ms / 3600_000) * 3600_000;
}

function initialModel(): 'auto' | WindModelId {
	const v = readItem(MODEL_KEY);
	return v && WIND_MODELS.some((m) => m.id === v) ? (v as WindModelId) : 'auto';
}

function initialLevel(): WindLevel {
	const v = readItem(LEVEL_KEY);
	if (v === 'sfc') {
		return 'sfc';
	}
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_LEVEL_FT;
}

function initialIsothermC(): number {
	const n = Number(readItem(ISO_C_KEY));
	return Number.isFinite(n) && n >= -40 && n <= 20 ? n : 0;
}

export const windAloft = $state<{
	/** 'auto' resolves per location (resolveAutoModel); else the picked model. */
	model: 'auto' | WindModelId;
	levelFt: WindLevel;
	showOnMap: boolean;
	/** Draw the isotherm of the chosen level over the barbs. */
	isotherm0: boolean;
	/** The isotherm's temperature (degC); 0 is the classic freezing line. */
	isothermC: number;
	/** Draw MSLP isobars (4 hPa) under the barbs; adds pressure_msl to the
	 *  lattice fetch, so toggling on refetches the viewport once. */
	isobars: boolean;
	/** Nav log / fuel plan fly on the forecast per leg (route YAML: wind_forecast). */
	useForecastForLegs: boolean;
	/** Temperature-corrected TAS (route YAML: temperature_tas). */
	tempTas: boolean;
	/** The instant the map shows, ms UTC; session-only. */
	validTimeMs: number;
	/** The animation slider / play has engaged: the lattice fetch widens to
	 *  the full slider span so scrubbing replays from cache. */
	animating: boolean;
	playing: boolean;
}>({
	model: initialModel(),
	levelFt: initialLevel(),
	showOnMap: readItem(SHOW_KEY) === 'on',
	isotherm0: readItem(ISO_KEY) === 'on',
	isothermC: initialIsothermC(),
	isobars: readItem(ISOBAR_KEY) === 'on',
	useForecastForLegs: true,
	tempTas: false,
	validTimeMs: nextHourMs(Date.now()),
	animating: false,
	playing: false,
});

export function setWindModel(v: 'auto' | WindModelId): void {
	windAloft.model = v;
	if (v === 'auto') {
		removeItem(MODEL_KEY);
	} else {
		writeItem(MODEL_KEY, v);
	}
}

export function setWindLevel(v: WindLevel): void {
	windAloft.levelFt = v;
	if (v === DEFAULT_LEVEL_FT) {
		removeItem(LEVEL_KEY);
	} else {
		writeItem(LEVEL_KEY, String(v));
	}
}

export function setShowWindOnMap(on: boolean): void {
	windAloft.showOnMap = on;
	if (on) {
		writeItem(SHOW_KEY, 'on');
	} else {
		removeItem(SHOW_KEY);
	}
}

export function setWindIsotherm(on: boolean): void {
	windAloft.isotherm0 = on;
	if (on) {
		writeItem(ISO_KEY, 'on');
	} else {
		removeItem(ISO_KEY);
	}
}

export function setWindIsothermC(c: number): void {
	windAloft.isothermC = c;
	if (c === 0) {
		removeItem(ISO_C_KEY);
	} else {
		writeItem(ISO_C_KEY, String(c));
	}
}

/** The isotherm's display label ("0 °C", "-10 °C", "+5 °C"). */
export function windIsothermLabel(): string {
	const c = windAloft.isothermC;
	return `${c > 0 ? '+' : ''}${c} °C`;
}

export function setWindIsobars(on: boolean): void {
	windAloft.isobars = on;
	if (on) {
		writeItem(ISOBAR_KEY, 'on');
	} else {
		removeItem(ISOBAR_KEY);
	}
}

/** The model serving a location under the current choice. */
export function effectiveWindModel(lat: number, lon: number): WindModelId {
	return windAloft.model === 'auto' ? resolveAutoModel(lat, lon) : windAloft.model;
}

/* -------------------------------------------------------- lattice cache -- */

export interface WindGridState {
	status: 'idle' | 'loading' | 'ok' | 'error';
	error: ErrorText | null;
	/** Index-aligned with lattice.points; null = cell not fetched (yet). */
	columns: (WindColumn | null)[];
	lattice: Lattice | null;
	/** The model that served the columns (for the status line / tooltips). */
	model: WindModelId | null;
	surface: boolean;
	key: string;
	fetchedAtMs: number;
	/** Bumped by the rate-limit retry timer; the MapView lattice effect
	 *  tracks it so a quota rejection re-ensures after the minute. */
	retrySeq: number;
}

export const windGrid = $state<WindGridState>({
	status: 'idle',
	error: null,
	columns: [],
	lattice: null,
	model: null,
	surface: false,
	key: '',
	fetchedAtMs: 0,
	retrySeq: 0,
});

// Plain (non-reactive) bookkeeping; see the contract in the header.
let gridAbort: AbortController | null = null;
let gridInflightKey: string | null = null;
let gridRetryTimer: ReturnType<typeof setTimeout> | null = null;
/** Fetched columns per lattice cell, keyed vars|window|model|cell so panning
 *  refetches ONLY the newly exposed strip (Open-Meteo meters calls by
 *  locations x variables; a full-viewport refetch per pan burns the
 *  per-minute quota). */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- module cache, published snapshots are the reactive face
const cellColumns = new Map<string, { col: WindColumn; atMs: number }>();
const CELL_CACHE_MAX = 900;

const GRID_TTL_MS = 15 * 60_000;
const GRID_MAX_POINTS = 126;
const ANIM_MAX_POINTS = 80;
/** Animation span cap, hours (weight: locations x hours per request). */
const ANIM_SPAN_H = 48;
/** Rate-limit retries back off exponentially: a rejected retry re-fires the
 *  whole lattice request, which itself costs quota, so hammering a spent
 *  hourly budget every minute would slow its own recovery. */
const RATE_LIMIT_RETRY_MS = 66_000;
const RATE_LIMIT_RETRY_MAX_MS = 15 * 60_000;
let gridRetryDelayMs = RATE_LIMIT_RETRY_MS;
/** Non-rate-limit failure stamp: the failed request key + when it failed, so
 *  the minute-tick ensure retries at GRID_TTL_MS instead of hammering a
 *  deterministic failure every 60 s (docs/wind-aloft.md "Auto-refresh":
 *  every failure is stamped into its cache). Any key change (pan, level,
 *  model, window) retries immediately; the rate-limit backoff timer stays
 *  the faster path for 429s. */
let gridFailedKey: string | null = null;
let gridFailedAtMs = 0;

function rateLimitMsg(delayMs: number): ErrorText {
	const min = Math.max(1, Math.round(delayMs / 60_000));
	return () => t.errors.openMeteoRateLimit(min);
}

export interface GridView {
	west: number;
	south: number;
	east: number;
	north: number;
	/** Longitude degrees per screen pixel at the view centre. */
	degPerPx: number;
	centerLat: number;
	centerLon: number;
}

/** The hour window the animation slider spans (also the fetch window while
 *  animating): from the current hour to the model horizon, capped. */
export function animationWindow(model: WindModelId, nowMs: number): { startMs: number; endMs: number } {
	const start = floorHourMs(nowMs);
	const spanH = Math.min(windModel(model).horizonH, ANIM_SPAN_H);
	return { startMs: start, endMs: start + spanH * 3600_000 };
}

function isoHour(ms: number): string {
	return new Date(ms).toISOString().slice(0, 13);
}

/** Trim the per-cell cache when it outgrows its budget (oldest first). */
function pruneCellCache(): void {
	if (cellColumns.size <= CELL_CACHE_MAX) {
		return;
	}
	const entries = [...cellColumns.entries()].sort((a, b) => a[1].atMs - b[1].atMs);
	for (let i = 0; i < entries.length - CELL_CACHE_MAX; i++) {
		cellColumns.delete(entries[i][0]);
	}
}

/** Start (or keep) the lattice fetch for the current view + panel state.
 *  Cells already fetched under the same model / levels / hour window are
 *  reused, so a pan requests ONLY the newly exposed strip (and a fully
 *  cached viewport publishes with no network at all). A rate-limit
 *  rejection schedules one retry after the quota minute. The previous
 *  columns stay on screen while a refresh is in flight. */
export function ensureWindGrid(view: GridView, nowMs = Date.now()): void {
	if (!display.liveWeather || !windAloft.showOnMap) {
		gridAbort?.abort();
		gridAbort = null;
		gridInflightKey = null;
		untrack(() => {
			if (windGrid.status !== 'idle') {
				windGrid.status = 'idle';
				windGrid.error = null;
			}
		});
		return;
	}
	const model = effectiveWindModel(view.centerLat, view.centerLon);
	const spec = windModel(model);
	const surface = windAloft.levelFt === 'sfc';
	// Aloft temperatures ride ONLY while the isotherm overlay is on: it is
	// their lone standing consumer (windGridIsotherm), so gating here drops a
	// per-level variable off every lattice fetch in the common isotherm-off
	// case (Open-Meteo meters by locations x variables). The hover badge's ISA
	// line follows suit, appearing only with the isotherm on; the Surface mode
	// still gets temperature_2m through the surface flag. Pressure rides only
	// while the isobar overlay is on (opt-in weight; toggling on invalidates
	// the cell cache once through the key below).
	const temps = !surface && windAloft.isotherm0;
	const mslp = windAloft.isobars;
	const levelsHpa = surface ? [] : bracketLevelsHpa(spec, windAloft.levelFt as number);
	const window = windAloft.animating
		? animationWindow(model, nowMs)
		: { startMs: floorHourMs(windAloft.validTimeMs), endMs: floorHourMs(windAloft.validTimeMs) + 2 * 3600_000 };
	const step = latticeStepDeg(view.degPerPx, spec.gridDeg);
	const pad = step / 2;
	const lattice = buildLattice(
		{ west: view.west - pad, south: view.south - pad, east: view.east + pad, north: view.north + pad },
		step,
		windAloft.animating ? ANIM_MAX_POINTS : GRID_MAX_POINTS,
	);
	// One namespace per model / variable set / hour window; the per-cell key
	// appends the cell coordinates, the published key the lattice extent.
	const base = [
		model,
		surface ? 'sfc' : `lvl${levelsHpa.join('-')}`,
		temps ? 't' : '-',
		mslp ? 'p' : '-',
		isoHour(window.startMs),
		isoHour(window.endMs),
	].join('|');
	const key = [base, lattice.stepDeg, lattice.lats[0] ?? 'x', lattice.lons[0] ?? 'x', lattice.lats.length, lattice.lons.length].join('|');
	const fresh = untrack(
		() => windGrid.key === key && windGrid.status === 'ok' && nowMs - windGrid.fetchedAtMs < GRID_TTL_MS,
	);
	if (fresh || gridInflightKey === key) {
		return;
	}

	const cellKey = (p: { lat: number; lon: number }): string => `${base}|${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
	const cached = (p: { lat: number; lon: number }): WindColumn | null => {
		const e = cellColumns.get(cellKey(p));
		return e && nowMs - e.atMs < GRID_TTL_MS ? e.col : null;
	};
	const assemble = (): (WindColumn | null)[] => lattice.points.map(cached);
	const missing = lattice.points.filter((p) => cached(p) === null);

	if (missing.length === 0) {
		gridAbort?.abort();
		gridInflightKey = null;
		untrack(() => {
			windGrid.status = 'ok';
			windGrid.error = null;
			windGrid.columns = assemble();
			windGrid.lattice = lattice;
			windGrid.model = model;
			windGrid.surface = surface;
			windGrid.key = key;
			windGrid.fetchedAtMs = nowMs;
		});
		return;
	}

	// While a rate-limit retry is scheduled, the backoff timer is the sole
	// path back to the network: the minute tick re-runs this ensure, and
	// letting it fetch would hammer the spent quota every minute (the
	// backoff exists exactly to avoid that). Cached publishes above still
	// run; only the fetch stands down.
	if (gridRetryTimer) {
		return;
	}
	// Same stand-down for a non-429 failure of this exact request: retry at
	// the grid TTL, not per minute (see gridFailedKey). Cached publishes
	// above still run.
	if (gridFailedKey === key && nowMs - gridFailedAtMs < GRID_TTL_MS) {
		return;
	}

	gridAbort?.abort();
	const ctrl = new AbortController();
	gridAbort = ctrl;
	gridInflightKey = key;
	untrack(() => {
		windGrid.status = 'loading';
		windGrid.error = null;
	});
	void fetchWindColumns(missing, {
		model,
		startMs: window.startMs,
		endMs: window.endMs,
		levelsHpa,
		temps,
		surface,
		mslp,
		signal: ctrl.signal,
	})
		.then((columns) => {
			gridRetryDelayMs = RATE_LIMIT_RETRY_MS;
			gridFailedKey = null;
			// Responses arrive in request order; key them by the REQUESTED
			// point (the API snaps coordinates to its grid).
			for (let i = 0; i < missing.length; i++) {
				const col = columns[i];
				if (col) {
					cellColumns.set(cellKey(missing[i]), { col, atMs: nowMs });
				}
			}
			pruneCellCache();
			if (ctrl.signal.aborted || gridInflightKey !== key) {
				return;
			}
			windGrid.status = 'ok';
			windGrid.columns = assemble();
			windGrid.lattice = lattice;
			windGrid.model = model;
			windGrid.surface = surface;
			windGrid.key = key;
			windGrid.fetchedAtMs = nowMs;
		})
		.catch((err: unknown) => {
			if (ctrl.signal.aborted || gridInflightKey !== key) {
				return;
			}
			const limited = err instanceof OpenMeteoError && err.rateLimited;
			windGrid.status = 'error';
			windGrid.error = limited ? rateLimitMsg(gridRetryDelayMs) : errorTextOf(err);
			if (!limited) {
				// Stamp the failure so the tick retries at the TTL, not per
				// minute (the ensure's gridFailedKey stand-down).
				gridFailedKey = key;
				gridFailedAtMs = Date.now();
			}
			if (limited) {
				if (gridRetryTimer) {
					clearTimeout(gridRetryTimer);
				}
				gridRetryTimer = setTimeout(() => {
					gridRetryTimer = null;
					if (windGrid.status === 'error') {
						windGrid.retrySeq++;
					}
				}, gridRetryDelayMs);
				gridRetryDelayMs = Math.min(gridRetryDelayMs * 2, RATE_LIMIT_RETRY_MAX_MS);
			}
		})
		.finally(() => {
			if (gridInflightKey === key) {
				gridInflightKey = null;
			}
		});
}

export interface MapBarb {
	lat: number;
	lon: number;
	dirTrueDeg: number;
	speedKt: number;
	/** Interpolated temperature at the shown level (2 m at Surface). */
	tempC: number | null;
	/** ISA deviation of that temperature at the shown level. */
	isaDevC: number | null;
	/** The barb draws faded: the chosen level sits below this cell's ground
	 *  (10 m wind shown) or above its fetched pressure ladder (top-level
	 *  wind shown; `aboveTop` tells the two apart for the hover badge). */
	faded: boolean;
	/** The chosen level sits above the cell's fetched pressure ladder. */
	aboveTop: boolean;
	/** Surface-level significant gust ("G28"), else null. */
	gust: string | null;
}

/** The barbs of the fetched lattice at the panel's level and valid time.
 *  Tracked when read in a $derived / $effect; recomputes per animation
 *  frame without any network. */
export function windGridBarbs(): MapBarb[] {
	if (windGrid.status !== 'ok' && windGrid.status !== 'loading') {
		return [];
	}
	const t = windAloft.validTimeMs;
	const out: MapBarb[] = [];
	for (const col of windGrid.columns) {
		if (!col) {
			continue;
		}
		if (windGrid.surface) {
			const s = sampleSurfaceAt(col, t);
			if (s) {
				const elevFt = col.elevationM / 0.3048;
				out.push({
					lat: col.lat,
					lon: col.lon,
					dirTrueDeg: s.dirTrueDeg,
					speedKt: s.speedKt,
					tempC: s.tempC,
					isaDevC: s.tempC != null ? isaDevC(elevFt, s.tempC) : null,
					faded: false,
					aboveTop: false,
					gust: gustLabel(s.speedKt, s.gustKt),
				});
			}
			continue;
		}
		const levelFt = windAloft.levelFt as number;
		const s = sampleWindAt(col, levelFt, t);
		if (s) {
			out.push({
				lat: col.lat,
				lon: col.lon,
				dirTrueDeg: s.dirTrueDeg,
				speedKt: s.speedKt,
				tempC: s.tempC,
				// A below-ground cell shows the 10 m wind, whose 2 m
				// temperature is not fetched aloft; tempC is null there, so
				// no misleading level-referenced ISA line appears. An
				// above-ladder cell's temperature is the topmost level's, so
				// an ISA deviation referenced to the chosen level would
				// misstate it; the badge notes the clamp instead.
				isaDevC:
					s.tempC != null && !s.belowGround && !s.aboveTop
						? isaDevC(levelFt, s.tempC)
						: null,
				faded: s.belowGround || s.aboveTop,
				aboveTop: s.aboveTop,
				gust: null,
			});
		}
	}
	return out;
}

/** The isotherm polylines ([lon, lat] pairs) of the chosen level at the
 *  valid time, contoured at windAloft.isothermC; empty unless the toggle is
 *  on and temperatures came with the fetch. */
export function windGridIsotherm(): [number, number][][] {
	if (!windAloft.isotherm0 || !windGrid.lattice || (windGrid.status !== 'ok' && windGrid.status !== 'loading')) {
		return [];
	}
	const { lats, lons } = windGrid.lattice;
	const t = windAloft.validTimeMs;
	const values: (number | null)[][] = [];
	for (let j = 0; j < lats.length; j++) {
		const row: (number | null)[] = [];
		for (let i = 0; i < lons.length; i++) {
			const col = windGrid.columns[j * lons.length + i];
			if (!col) {
				row.push(null);
			} else if (windGrid.surface) {
				row.push(sampleSurfaceAt(col, t)?.tempC ?? null);
			} else {
				row.push(sampleWindAt(col, windAloft.levelFt as number, t)?.tempC ?? null);
			}
		}
		values.push(row);
	}
	const grid: IsoGrid = { xs: lons, ys: lats, values };
	return isolines(grid, windAloft.isothermC);
}

/** The MSLP isobars of the fetched lattice at the valid time: 4 hPa
 *  multiples spanning the field, each as its isolines chains. Empty while
 *  the toggle is off or pressure did not ride the fetch. Tracked. */
export function windGridIsobars(): IsobarLine[] {
	if (!windAloft.isobars || !windGrid.lattice || (windGrid.status !== 'ok' && windGrid.status !== 'loading')) {
		return [];
	}
	const { lats, lons } = windGrid.lattice;
	const t = windAloft.validTimeMs;
	const values: (number | null)[][] = [];
	let min = Infinity;
	let max = -Infinity;
	for (let j = 0; j < lats.length; j++) {
		const row: (number | null)[] = [];
		for (let i = 0; i < lons.length; i++) {
			const col = windGrid.columns[j * lons.length + i];
			const v = col ? sampleMslpAt(col, t) : null;
			if (v != null) {
				min = Math.min(min, v);
				max = Math.max(max, v);
			}
			row.push(v);
		}
		values.push(row);
	}
	if (!(max > min)) {
		return [];
	}
	const grid: IsoGrid = { xs: lons, ys: lats, values };
	return isobarLevels(min, max)
		.map((value) => ({ value, lines: isolines(grid, value) }))
		.filter((e) => e.lines.length > 0);
}

/* -------------------------------------------------------- model runs ---- */

export const windRuns = $state<{
	byModel: Record<string, number | null>;
	/** Bumped when a model's run ADVANCES (a new cycle landed); the route
	 *  wind cache keys its freshness on it. The first null -> value arrival
	 *  does not count, so run info landing after a fetch never invalidates
	 *  data that same cycle just served. */
	newRunSeq: number;
}>({ byModel: {}, newRunSeq: 0 });

const runFetchedAt: Record<string, number> = {};
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- in-flight dedup bookkeeping, not state
const runInflight = new Set<string>();
const RUN_TTL_MS = 30 * 60_000;

/** A detected model-cycle change: both runs known and different. The
 *  null transitions (first arrival, meta fetch failure) never count. */
export function isNewModelRun(prevMs: number | null | undefined, nextMs: number | null): boolean {
	return prevMs != null && nextMs != null && nextMs !== prevMs;
}

/** Best-effort model-run info for the status line / tooltips; null (or a
 *  fetch failure) just hides the run time. When a NEW cycle is detected,
 *  the lattice cells are dropped and the grid re-ensured (retrySeq is the
 *  MapView effect's nudge), and newRunSeq tells the route wind cache. */
export function ensureModelRun(model: WindModelId, nowMs = Date.now()): void {
	if (!display.liveWeather) {
		return;
	}
	const at = runFetchedAt[model];
	if (runInflight.has(model) || (at !== undefined && nowMs - at < RUN_TTL_MS)) {
		return;
	}
	runInflight.add(model);
	void fetchModelRun(model)
		.then((run) => {
			runFetchedAt[model] = nowMs;
			const next = run ? run.initMs : null;
			if (isNewModelRun(windRuns.byModel[model], next)) {
				windRuns.newRunSeq++;
				cellColumns.clear();
				windGrid.fetchedAtMs = 0;
				// A new cycle also lifts the failure stand-down: the fresh
				// run deserves an immediate retry.
				gridFailedKey = null;
				windGrid.retrySeq++;
			}
			windRuns.byModel[model] = next;
		})
		.finally(() => {
			runInflight.delete(model);
		});
}

/** The model's last run initialisation (ms UTC), when known. */
export function modelRunMs(model: WindModelId): number | null {
	return windRuns.byModel[model] ?? null;
}
