/* Winds-aloft panel state + the map lattice cache.
 *
 * Panel preferences (model, level, show-on-map, isotherm) persist via the
 * store-only-non-default idiom; the planning flags (useForecastForLegs,
 * tempTas) are session state that round-trips through the route YAML like
 * vfr / semicircular.
 *
 * WHICH instant the map is drawn for is not this module's business but the
 * viewing period's, resolved in state/wxTime.svelte.ts (which also holds the
 * pilot's own pin over it). That module cannot be imported here (routeWind,
 * home of the flight's departure, and route.svelte both import this one), so
 * the instant arrives as a PARAMETER on every reader below.
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
	forecastRangeEndMs,
	forecastReachEndMs,
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
import {
	LruStore,
	covers,
	isCellCurrent,
	stampRuns,
	type Bbox,
	type DirRun,
	type RunStamp,
	type RunTable,
} from '$lib/weather/forecastCache';
import { gustLabel } from '$lib/weather/windBarbs';
import { isolines, type IsoGrid } from '$lib/weather/isotherm';

const MODEL_KEY = 'loxodrome:wind-model';
const LEVEL_KEY = 'loxodrome:wind-level';
const SHOW_KEY = 'loxodrome:wind-map';
const ISO_KEY = 'loxodrome:wind-isotherm';
const ISO_C_KEY = 'loxodrome:wind-isotherm-c';
const ISOBAR_KEY = 'loxodrome:wind-isobars';

export const DEFAULT_LEVEL_FT = 2500;
/** The highest custom level the Weather tab's box takes, in feet. */
export const MAX_LEVEL_FT = 60_000;
/** The isotherm temperatures the Weather tab offers, degC. */
export const ISOTHERM_CHOICES_C: readonly number[] = [-20, -15, -10, -5, 0, 5, 10];

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
	// Every level the Weather tab's box takes, whole feet from 0 (the surface
	// is its own 'sfc') to MAX_LEVEL_FT, spelled as setWindLevel writes it:
	// Number() would read an absent key, '' or ' ' as 0 ft, and '1e3' or
	// '0x10' as levels no setter wrote.
	const n = v !== null && /^\d{1,5}$/.test(v) ? Number(v) : NaN;
	return n <= MAX_LEVEL_FT ? n : DEFAULT_LEVEL_FT;
}

function initialIsothermC(): number {
	// One of the select's own values, or the select would show another.
	const raw = readItem(ISO_C_KEY);
	return ISOTHERM_CHOICES_C.find((c) => String(c) === raw) ?? 0;
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
	/** The instant the animation slider's span is built around while the
	 *  slider / play has engaged, null when it has not: the old `animating`
	 *  flag carrying its own anchor, so the two cannot disagree. The lattice
	 *  fetch widens to that whole span, so scrubbing replays from cache; the
	 *  anchor is FROZEN at engage because the fetch window's floored hours are
	 *  the cache namespace, and a span that followed the scrub would re-key
	 *  (and refetch the viewport) on every animation frame. */
	animAnchorMs: number | null;
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
	animAnchorMs: null,
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
	status: 'idle' | 'loading' | 'ok' | 'error' | 'out-of-range';
	error: ErrorText | null;
	/** Index-aligned with lattice.points; null = cell not fetched (yet). */
	columns: (WindColumn | null)[];
	lattice: Lattice | null;
	/** The model that served the columns (for the status line / tooltips). */
	model: WindModelId | null;
	surface: boolean;
	key: string;
	/** Bumped by the rate-limit retry timer and by a new model run; the
	 *  MapView lattice effect tracks it to re-ensure. */
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
	retrySeq: 0,
});

/** One lattice cell's column, with the model runs it was asked for under and
 *  the hours it was asked for (forecastCache.ts): a cell is refetched when a
 *  run of its model's that covers it lands, or when the shown hour leaves
 *  those hours, never on a clock. */
interface GridCell {
	col: WindColumn;
	stamp: RunStamp;
	atMs: number;
	startMs: number;
	endMs: number;
}

/** The values a column holds, what the cell store is bounded by. */
function columnValues(col: WindColumn): number {
	return col.timesMs.length * Math.max(1, Object.keys(col.hourly).length);
}

// Plain (non-reactive) bookkeeping; see the contract in the header.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- in-flight aborts, not state
const gridAborts = new Set<AbortController>();
/** The cells a request in flight will answer, with the hours it asked for:
 *  an ensure meanwhile asks only for what no request covers. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- in-flight bookkeeping, not state
const pendingCells = new Map<string, { startMs: number; endMs: number }>();
let gridRetryTimer: ReturnType<typeof setTimeout> | null = null;
/** Fetched columns per lattice cell, keyed model|levels|vars|cell. The hours
 *  are not in the key, a cell holding a day of them, so a pan requests ONLY
 *  the newly exposed strip and the hour rolling over requests nothing
 *  (Open-Meteo charges each location a call per ten variables). Bounded by
 *  the values held: a full lattice of a day's cells is about 62 000. */
const CELL_STORE_MAX_VALUES = 200_000;
const cellStore = new LruStore<GridCell>(CELL_STORE_MAX_VALUES, (c) => columnValues(c.col));
/** What the grid last published, as plain references: windGrid.columns is a
 *  deep $state proxy, which no identity check against the store's columns
 *  would ever match, and the minute tick must not republish an unchanged
 *  grid. */
let published: { key: string; status: WindGridState['status']; cols: (WindColumn | null)[] } | null = null;
/** The latest ensure's lattice key and arguments: a request settling under an
 *  older key (the map moved meanwhile) publishes nothing itself, and hands
 *  back to the latest ensure, whose cells it may have been answering. */
let gridLatest: { key: string; view: GridView; showMs: number } | null = null;

const GRID_MAX_POINTS = 126;
const ANIM_MAX_POINTS = 80;
/** Animation span cap, hours. */
const ANIM_SPAN_H = 48;
/** What a lattice fetch asks for around the shown hour: the hour before it
 *  and a day ahead, which costs no more than its three hours (Open-Meteo
 *  weighs hours only past two weeks), so the hour rolling over is served
 *  from what is held. */
const GRID_FETCH_BEFORE_MS = 3600_000;
const GRID_FETCH_AHEAD_MS = 24 * 3600_000;
/** How far a fetch widens to keep the hours its cells already held. */
const GRID_HOLD_MAX_MS = 48 * 3600_000;
/** Rate-limit retries back off exponentially: a rejected retry re-fires the
 *  whole lattice request, which itself costs quota, so hammering a spent
 *  hourly budget every minute would slow its own recovery. */
const RATE_LIMIT_RETRY_MS = 66_000;
const RATE_LIMIT_RETRY_MAX_MS = 15 * 60_000;
let gridRetryDelayMs = RATE_LIMIT_RETRY_MS;
/** Non-rate-limit failure stamp: the failed request (key and hours) + when it
 *  failed, so the minute-tick ensure asks again after GRID_FAILED_RETRY_MS
 *  instead of hammering a deterministic failure every 60 s (docs/wind-aloft.md
 *  "Auto-refresh": every failure is stamped into its cache). Any key change
 *  (pan, level, model, hours) and a new model run ask at once; the rate-limit
 *  backoff timer stays the path for 429s. */
let gridFailedKey: string | null = null;
let gridFailedAtMs = 0;
const GRID_FAILED_RETRY_MS = 15 * 60_000;

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
 *  animating): the hour BEFORE the anchor, which is the ramp hour a flight's
 *  own window opens on (timeWindow's PAD_BEFORE_MS) and, for an anchor on the
 *  current hour, the hour the slider has always started at; then the animation
 *  span, capped by how far the model sees FROM NOW, nothing forecasting past
 *  now + horizonH however far ahead the anchor sits. A past anchor keeps its
 *  own hour, so a period covering yesterday scrubs forward from it. */
export function animationWindow(
	model: WindModelId,
	anchorMs: number,
	nowMs: number,
): { startMs: number; endMs: number } {
	const anchorHour = floorHourMs(anchorMs);
	const nowHour = floorHourMs(nowMs);
	const spanMs = Math.min(windModel(model).horizonH, ANIM_SPAN_H) * 3600_000;
	// GFS sees 384 h and the endpoint accepts +15 days, so the reach is the
	// lesser of the two: an hour past it can only ever answer 400.
	const reachMs = forecastReachEndMs(nowMs, windModel(model).horizonH);
	// One ramp hour before the anchor, then backed off far enough that the
	// span still ENDS at the reach: an anchor sitting on the last hour the
	// forecast answers (which is where a period further out than the model
	// goes is clamped to) would otherwise leave a one-hour stub of a slider
	// instead of the forecast's last two days.
	const startMs = Math.min(
		Math.min(anchorHour, Math.max(nowHour, anchorHour - 3600_000)),
		Math.max(nowHour, reachMs - spanMs),
	);
	const endMs = Math.min(startMs + spanMs, reachMs);
	// A pinned hour past the reach still leaves the range well-formed; the
	// thumb rests at the end and the panel's own note says why.
	return { startMs, endMs: Math.max(endMs, startMs + 3600_000) };
}

/** The hours the map NEEDS a cell to hold: the animation's whole frozen span
 *  while it is engaged, so a sweep replays from what is held, else the shown
 *  hour and the one after it, which is what brackets a mid-hour instant for
 *  the interpolation (what a fetch asks for is wider: gridFetchWindow).
 *
 *  Never past the endpoint's own range. BOTH start_hour and end_hour are
 *  range-checked (openMeteo's FORECAST_MAX_AHEAD_DAYS), so a window whose
 *  START is legal is refused all the same for its end, and that is exactly
 *  what an instant clamped to the forecast's last hour asks for: the clamp
 *  lands ON 23:00 of the last accepted day and the two hours after it fall
 *  into the next. The degenerate single-hour window that leaves is fine,
 *  sampleWindAt reading a lone entry as its own bracket. */
export function gridWindow(
	model: WindModelId,
	showMs: number,
	anchorMs: number | null,
	nowMs: number,
): { startMs: number; endMs: number } {
	const w =
		anchorMs !== null
			? animationWindow(model, anchorMs, nowMs)
			: { startMs: floorHourMs(showMs), endMs: floorHourMs(showMs) + 2 * 3600_000 };
	return { startMs: w.startMs, endMs: Math.max(w.startMs, Math.min(w.endMs, forecastRangeEndMs(nowMs))) };
}

/** The hours ONE lattice fetch asks for: the hour before the shown hour and a
 *  day past it, up to the model's reach and the endpoint's range, so the hour
 *  rolling over is served from what is held at no extra cost (Open-Meteo
 *  weighs hours only past two weeks); while the animation is engaged,
 *  exactly its span. `held`, the hours the cells being refetched already
 *  held, is kept too when the whole stays within two days, so a period
 *  toggled between two instants a day apart does not refetch on each toggle.
 *  Always contains gridWindow's need. Pure. */
export function gridFetchWindow(
	model: WindModelId,
	showMs: number,
	anchorMs: number | null,
	nowMs: number,
	held: { startMs: number; endMs: number } | null = null,
): { startMs: number; endMs: number } {
	const need = gridWindow(model, showMs, anchorMs, nowMs);
	if (anchorMs !== null) {
		return need;
	}
	const hour = floorHourMs(showMs);
	const rangeEnd = forecastRangeEndMs(nowMs);
	const reach = forecastReachEndMs(nowMs, windModel(model).horizonH);
	const startMs = Math.min(need.startMs, hour - GRID_FETCH_BEFORE_MS);
	const endMs = Math.min(Math.max(need.endMs, Math.min(hour + GRID_FETCH_AHEAD_MS, reach)), rangeEnd);
	if (held) {
		const s = Math.min(startMs, held.startMs);
		const e = Math.min(Math.max(endMs, held.endMs), rangeEnd);
		if (e - s <= GRID_HOLD_MAX_MS) {
			return { startMs: s, endMs: e };
		}
	}
	return { startMs, endMs };
}

function isoHour(ms: number): string {
	return new Date(ms).toISOString().slice(0, 13);
}

/** Publish the grid, unless it is what was last published (the minute tick
 *  re-runs the ensure, and a same-value write still notifies every reader). */
function publishGrid(g: {
	status: WindGridState['status'];
	error: ErrorText | null;
	key: string;
	lattice: Lattice;
	model: WindModelId;
	surface: boolean;
	cols: (WindColumn | null)[];
}): void {
	const prev = published;
	const same =
		prev !== null &&
		g.error === null &&
		prev.key === g.key &&
		prev.status === g.status &&
		prev.cols.length === g.cols.length &&
		prev.cols.every((c, i) => c === g.cols[i]);
	if (same) {
		return;
	}
	published = { key: g.key, status: g.status, cols: g.cols };
	untrack(() => {
		windGrid.status = g.status;
		windGrid.error = g.error;
		windGrid.columns = g.cols;
		windGrid.lattice = g.lattice;
		windGrid.model = g.model;
		windGrid.surface = g.surface;
		windGrid.key = g.key;
	});
}

/** Start (or keep) the lattice fetch for the current view + panel state.
 *  Cells held for the same model and variables, current (no run of theirs
 *  published since) and holding the shown hours, are reused: a pan requests
 *  ONLY the newly exposed strip, the hour rolling over requests nothing, and
 *  a fully held viewport publishes with no network at all. A request in
 *  flight is never aborted for a newer one, its cells landing in the store
 *  (only hiding the layer aborts). A rate-limit rejection schedules one retry
 *  after the quota minute. Held columns stay on screen while a refresh is in
 *  flight and after it fails. */
export function ensureWindGrid(view: GridView, showMs: number, nowMs = Date.now()): void {
	if (!display.liveWeather || !windAloft.showOnMap) {
		for (const ctrl of gridAborts) {
			ctrl.abort();
		}
		gridAborts.clear();
		untrack(() => {
			if (windGrid.status !== 'idle') {
				windGrid.status = 'idle';
				windGrid.error = null;
				published = null;
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
	// case (Open-Meteo charges per ten variables). The hover badge's ISA
	// line follows suit, appearing only with the isotherm on; the Surface mode
	// still gets temperature_2m through the surface flag. Pressure rides only
	// while the isobar overlay is on (opt-in weight; toggling on asks for a
	// variable set of its own once, through the key below).
	const temps = !surface && windAloft.isotherm0;
	const mslp = windAloft.isobars;
	const levelsHpa = surface ? [] : bracketLevelsHpa(spec, windAloft.levelFt as number);
	const anchor = windAloft.animAnchorMs;
	const need = gridWindow(model, showMs, anchor, nowMs);
	const step = latticeStepDeg(view.degPerPx, spec.gridDeg);
	const pad = step / 2;
	const lattice = buildLattice(
		{ west: view.west - pad, south: view.south - pad, east: view.east + pad, north: view.north + pad },
		step,
		anchor !== null ? ANIM_MAX_POINTS : GRID_MAX_POINTS,
	);
	// One namespace per model and variable set; the hours are not in it, a
	// cell holding a day of them. The per-cell key appends the cell's
	// coordinates, the published key the lattice extent.
	const base = [
		model,
		surface ? 'sfc' : `lvl${levelsHpa.join('-')}`,
		temps ? 't' : '-',
		mslp ? 'p' : '-',
	].join('|');
	const key = [base, lattice.stepDeg, lattice.lats[0] ?? 'x', lattice.lons[0] ?? 'x', lattice.lats.length, lattice.lons.length].join('|');
	gridLatest = { key, view, showMs };
	// An hour past the endpoint's own window (FORECAST_MAX_AHEAD_DAYS) can
	// only ever answer 400, so refuse it here rather than discovering it
	// upstream: a date typed weeks out costs no request at all. Only a PINNED
	// instant reaches this, the period's own default being clamped to the
	// same reach (state/wxTime.svelte.ts), and the panel's note already says
	// how far the forecast goes. The write is guarded because the minute tick
	// re-enters and a same-value $state assignment still notifies.
	if (need.startMs > forecastRangeEndMs(nowMs)) {
		untrack(() => {
			if (windGrid.status !== 'out-of-range' || windGrid.key !== key) {
				windGrid.key = key;
				windGrid.columns = [];
				windGrid.lattice = null;
				windGrid.model = model;
				windGrid.status = 'out-of-range';
				windGrid.error = null;
				published = null;
			}
		});
		return;
	}

	const cellKey = (p: { lat: number; lon: number }): string => `${base}|${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
	// The runs are read untracked: the MapView effect re-runs on retrySeq,
	// which a new run bumps.
	const runs = untrack(() => runTable());
	const held = (p: { lat: number; lon: number }): GridCell | null => {
		const c = cellStore.peek(cellKey(p));
		return c && covers(c, need.startMs, need.endMs) ? c : null;
	};
	const current = (p: { lat: number; lon: number }): boolean => {
		const c = held(p);
		return c !== null && isCellCurrent(c.stamp, c.atMs, spec.runDirs, runs, p, nowMs);
	};
	// What is shown: every held cell holding the needed hours, current or
	// not, so a refresh (or a failed one) never blanks a cell.
	const assemble = (): (WindColumn | null)[] => lattice.points.map((p) => held(p)?.col ?? null);
	const show = (status: WindGridState['status'], error: ErrorText | null): void =>
		publishGrid({ status, error, key, lattice, model, surface, cols: assemble() });

	const missing = lattice.points.filter((p) => !current(p));
	if (missing.length === 0) {
		show('ok', null);
		return;
	}
	// Cells a request in flight will answer for the needed hours are waited
	// for, not asked twice.
	const fetchable = missing.filter((p) => !covers(pendingCells.get(cellKey(p)), need.startMs, need.endMs));
	if (fetchable.length === 0) {
		return;
	}
	// While a rate-limit retry is scheduled, the backoff timer is the sole
	// path back to the network: the minute tick re-runs this ensure, and
	// letting it fetch would hammer the spent quota every minute (the
	// backoff exists exactly to avoid that). Held cells are still shown.
	if (gridRetryTimer) {
		return;
	}
	// The hours the stale cells held, kept by the fetch when the whole stays
	// within two days.
	let heldWin: { startMs: number; endMs: number } | null = null;
	for (const p of fetchable) {
		const c = cellStore.peek(cellKey(p));
		if (c) {
			heldWin = heldWin
				? { startMs: Math.min(heldWin.startMs, c.startMs), endMs: Math.max(heldWin.endMs, c.endMs) }
				: { startMs: c.startMs, endMs: c.endMs };
		}
	}
	const window = gridFetchWindow(model, showMs, anchor, nowMs, heldWin);
	const failKey = `${key}|${isoHour(window.startMs)}|${isoHour(window.endMs)}`;
	// Same stand-down for a non-429 failure of this exact request: asked
	// again after GRID_FAILED_RETRY_MS, not per minute (see gridFailedKey).
	if (gridFailedKey === failKey && nowMs - gridFailedAtMs < GRID_FAILED_RETRY_MS) {
		return;
	}

	const ctrl = new AbortController();
	gridAborts.add(ctrl);
	const keys = fetchable.map(cellKey);
	for (const k of keys) {
		pendingCells.set(k, window);
	}
	// The runs as known when asked: a run landing while the request is out
	// leaves the cells one behind, refetched at the next ensure.
	const stamp = untrack(() => runStampFor(model));
	untrack(() => {
		if (windGrid.status !== 'loading') {
			windGrid.status = 'loading';
			windGrid.error = null;
		}
	});
	// The status was written past the mirror: the next publish must land.
	published = null;
	const latest = (): boolean => gridLatest?.key === key;
	void fetchWindColumns(fetchable, {
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
			// A 200 carrying no forecast (a captive portal's page, a body cut
			// short) decodes to fewer columns than points: a failed refresh,
			// never an answer that would replace what is held.
			if (columns.length !== fetchable.length) {
				// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
				throw new OpenMeteoError('open-meteo fetch failed: short answer');
			}
			// Every cell is kept, the request superseded or not: they were
			// paid for, and the next ensure reads them.
			for (let i = 0; i < fetchable.length; i++) {
				cellStore.set(keys[i], {
					col: columns[i],
					stamp,
					atMs: nowMs,
					startMs: window.startMs,
					endMs: window.endMs,
				});
			}
			if (gridFailedKey === failKey) {
				gridFailedKey = null;
			}
			if (!ctrl.signal.aborted && latest()) {
				show('ok', null);
			}
		})
		.catch((err: unknown) => {
			if (ctrl.signal.aborted) {
				return;
			}
			const limited = err instanceof OpenMeteoError && err.rateLimited;
			const delayMs = gridRetryDelayMs;
			if (!limited) {
				// Stamp the failure so the tick asks again at
				// GRID_FAILED_RETRY_MS, not per minute: on the ensure's own
				// clock, the one its stand-down is judged on.
				gridFailedKey = failKey;
				gridFailedAtMs = nowMs;
			} else if (!gridRetryTimer) {
				// ONE timer for a burst: requests in flight when the limit hit
				// fail too, and must not each double the wait.
				gridRetryTimer = setTimeout(() => {
					gridRetryTimer = null;
					if (windGrid.status === 'error') {
						windGrid.retrySeq++;
					}
				}, delayMs);
				gridRetryDelayMs = Math.min(delayMs * 2, RATE_LIMIT_RETRY_MAX_MS);
			}
			if (latest()) {
				show('error', limited ? rateLimitMsg(delayMs) : errorTextOf(err));
			}
		})
		.finally(() => {
			gridAborts.delete(ctrl);
			for (const k of keys) {
				if (pendingCells.get(k) === window) {
					pendingCells.delete(k);
				}
			}
			// Settled under an older key: the latest ensure may have been
			// waiting on these cells, and publishes (or asks for) them now.
			const last = gridLatest;
			if (!ctrl.signal.aborted && last && last.key !== key) {
				ensureWindGrid(last.view, last.showMs);
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

/** The barbs of the fetched lattice at the panel's level and the instant
 *  `atMs` (state/wxTime.svelte.ts's answer, passed in by the caller so the
 *  fetch window and the sampled hour cannot disagree within a pass). Tracked
 *  when read in a $derived / $effect; recomputes per animation frame without
 *  any network. */
/** Whether the grid holds columns to draw: published, refreshing, or held
 *  through a failed refresh (the phone in flight keeps its barbs; the status
 *  line says why they are not fresh). */
function gridDrawable(): boolean {
	return windGrid.status === 'ok' || windGrid.status === 'loading' || windGrid.status === 'error';
}

export function windGridBarbs(atMs: number): MapBarb[] {
	if (!gridDrawable()) {
		return [];
	}
	const t = atMs;
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

/** The isotherm polylines ([lon, lat] pairs) of the chosen level at `atMs`,
 *  contoured at windAloft.isothermC; empty unless the toggle is on and
 *  temperatures came with the fetch. */
export function windGridIsotherm(atMs: number): [number, number][][] {
	if (!windAloft.isotherm0 || !windGrid.lattice || !gridDrawable()) {
		return [];
	}
	const { lats, lons } = windGrid.lattice;
	const t = atMs;
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

/** The MSLP isobars of the fetched lattice at `atMs`: 4 hPa multiples
 *  spanning the field, each as its isolines chains. Empty while the toggle is
 *  off or pressure did not ride the fetch. Tracked. */
export function windGridIsobars(atMs: number): IsobarLine[] {
	if (!windAloft.isobars || !windGrid.lattice || !gridDrawable()) {
		return [];
	}
	const { lats, lons } = windGrid.lattice;
	const t = atMs;
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
	/** Each polled run directory's last run initialisation (ms UTC). */
	byDir: Record<string, number>;
	/** Bumped once per poll round in which a directory's run ADVANCED (a new
	 *  cycle landed); the route wind cache and its effects re-ensure on it.
	 *  A first arrival does not count, so run info landing after a fetch
	 *  never invalidates data that same cycle just served. */
	newRunSeq: number;
}>({ byDir: {}, newRunSeq: 0 });

/** Each directory's grid and cadence, as its meta.json last stated them:
 *  read together with windRuns.byDir, which changes with them. */
const dirMeta: Record<string, { bbox: Bbox | null; intervalMs: number | null }> = {};
/** When each directory was last polled (a failed poll is stamped early, so
 *  that it is asked again within RUN_RETRY_MS). */
const dirPolledAt: Record<string, number> = {};
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- in-flight dedup bookkeeping, not state
const dirInflight = new Set<string>();
/** How often a directory in use is polled: the endpoint is free, and a run
 *  is what makes every forecast column fresh or stale (forecastCache.ts). */
const RUN_POLL_MS = 15 * 60_000;
/** A poll that answered nothing is asked again this much later rather than
 *  at the poll interval: the run it keeps naming may have moved on meanwhile,
 *  and the columns refetched when the network comes back would be stamped
 *  with it until the next poll landed. */
const RUN_RETRY_MS = 5 * 60_000;

/** A detected model-cycle change: both runs known and different. The
 *  null transitions (first arrival, meta fetch failure) never count. */
export function isNewModelRun(prevMs: number | null | undefined, nextMs: number | null): boolean {
	return prevMs != null && nextMs != null && nextMs !== prevMs;
}

/** The run directories a model's freshness and provenance read. */
function modelDirs(model: WindModelId): string[] {
	const spec = windModel(model);
	return [...new Set([...spec.runDirs.flat(), ...(spec.metaDir ? [spec.metaDir] : [])])];
}

/** The polled runs, as forecastCache.ts reads them. Tracked. */
export function runTable(): RunTable {
	const out: Record<string, DirRun> = {};
	for (const [dir, initMs] of Object.entries(windRuns.byDir)) {
		const meta = dirMeta[dir];
		out[dir] = { initMs, bbox: meta?.bbox ?? null, intervalMs: meta?.intervalMs ?? null };
	}
	return out;
}

/** The stamp of a column asked for now from `model`. Tracked. */
export function runStampFor(model: WindModelId): RunStamp {
	return stampRuns(windModel(model).runDirs, runTable());
}

/** Whether columns asked for at `atMs` under `stamp` are still the forecast
 *  at every one of `points` (forecastCache.ts isCellCurrent). Tracked. */
export function stampIsCurrent(
	stamp: RunStamp,
	atMs: number,
	model: WindModelId,
	points: readonly { lat: number; lon: number }[],
	nowMs: number,
): boolean {
	const runs = runTable();
	const groups = windModel(model).runDirs;
	return points.every((p) => isCellCurrent(stamp, atMs, groups, runs, p, nowMs));
}

/** Poll the run directories of a model in use (unmetered), every
 *  RUN_POLL_MS, as ONE round: a cycle whose twin directories publish
 *  minutes apart, or several components advancing at once, count once. A
 *  poll that answers nothing (offline, a failed or refused meta read) keeps
 *  the run already known, and with none known the run time is simply hidden.
 *  When a run ADVANCES, newRunSeq tells the route wind cache and retrySeq
 *  nudges the lattice, whose cells then read themselves stale where that run
 *  covers them; nothing is dropped. */
export function ensureModelRun(model: WindModelId, nowMs = Date.now()): void {
	if (!display.liveWeather) {
		return;
	}
	const due = modelDirs(model).filter((dir) => {
		const at = dirPolledAt[dir];
		return !dirInflight.has(dir) && (at === undefined || nowMs - at >= RUN_POLL_MS);
	});
	if (due.length === 0) {
		return;
	}
	for (const dir of due) {
		dirInflight.add(dir);
	}
	void Promise.all(
		due.map((dir) =>
			fetchModelRun(dir).then(
				(run) => ({ dir, run }),
				() => ({ dir, run: null }),
			),
		),
	)
		.then((answers) => {
			const advanced: string[] = [];
			for (const { dir, run } of answers) {
				// Nothing answered says nothing about the run: the one known
				// stays, so a provenance line keeps its run offline, and the
				// next run read is compared with it. That next read comes soon.
				if (!run) {
					dirPolledAt[dir] = nowMs - RUN_POLL_MS + RUN_RETRY_MS;
					continue;
				}
				dirPolledAt[dir] = nowMs;
				dirMeta[dir] = { bbox: run.bbox, intervalMs: run.intervalMs };
				const prev = windRuns.byDir[dir];
				if (isNewModelRun(prev, run.initMs)) {
					advanced.push(dir);
				}
				if (prev !== run.initMs) {
					windRuns.byDir[dir] = run.initMs;
				}
			}
			if (advanced.length > 0) {
				windRuns.newRunSeq++;
				// A new cycle lifts the failure stand-down of the lattice it
				// serves: the fresh run deserves an immediate retry.
				const gridModel = windGrid.model;
				if (gridModel && windModel(gridModel).runDirs.flat().some((d) => advanced.includes(d))) {
					gridFailedKey = null;
				}
				windGrid.retrySeq++;
			}
		})
		.finally(() => {
			for (const dir of due) {
				dirInflight.delete(dir);
			}
		});
}

/** The model's last run initialisation (ms UTC), when known: its display
 *  directory's (WindModelSpec.metaDir), which the provenance names. */
export function modelRunMs(model: WindModelId): number | null {
	const dir = windModel(model).metaDir;
	return dir ? (windRuns.byDir[dir] ?? null) : null;
}

/** Reset for tests (the resetRadarForTest precedent): the runs and their
 *  polls, the lattice cells and every request in flight, so a case inherits
 *  nothing from the one before (the records are module-level, keyed by
 *  directory, and two models share directories). */
export function resetWindAloftForTest(): void {
	for (const ctrl of gridAborts) {
		ctrl.abort();
	}
	gridAborts.clear();
	pendingCells.clear();
	cellStore.clear();
	if (gridRetryTimer) {
		clearTimeout(gridRetryTimer);
		gridRetryTimer = null;
	}
	gridRetryDelayMs = RATE_LIMIT_RETRY_MS;
	gridFailedKey = null;
	gridFailedAtMs = 0;
	published = null;
	gridLatest = null;
	for (const dir of Object.keys(dirMeta)) {
		delete dirMeta[dir];
	}
	for (const dir of Object.keys(dirPolledAt)) {
		delete dirPolledAt[dir];
	}
	dirInflight.clear();
	windRuns.byDir = {};
	windGrid.status = 'idle';
	windGrid.error = null;
	windGrid.columns = [];
	windGrid.lattice = null;
	windGrid.model = null;
	windGrid.key = '';
}

/** Put the winds-aloft preferences back to their defaults, in place,
 *  storage included (Restore default settings): the map layers off, then the
 *  isotherm, the level and the model. The two route-planning switches
 *  (useForecastForLegs, tempTas) belong to the route workspace and stay. */
export function restoreWindDefaults(): void {
	setShowWindOnMap(false);
	setWindIsotherm(false);
	setWindIsobars(false);
	setWindIsothermC(0);
	setWindLevel(DEFAULT_LEVEL_FT);
	setWindModel('auto');
}
