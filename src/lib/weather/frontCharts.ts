/* The Deutscher Wetterdienst's surface pressure charts with fronts (the
 * "carte des fronts"): the latest analysis and the forecasts, for the Weather
 * tab's section and the first sheets of the printed meteo annex. Contract:
 * docs/front-charts.md.
 *
 * Two sources, because DWD publishes the two halves in two places.
 *   - The ANALYSES (North Atlantic-Europe, 00/06/12/18 UTC, about two days
 *     kept) on DWD's open-data server, whose file names carry the validity
 *     and the production stamp. That server sends no CORS header, so the
 *     names and the bytes come through the relay (loxodrome-proxy
 *     /dwd/charts/analysis).
 *   - The FORECASTS on www.dwd.de, six files under fixed names rewritten at
 *     every run, served with an open CORS header and read straight from the
 *     browser (DWD's robots.txt keeps the relay, an automated agent, away).
 *     Their validity is printed only in the picture, so it is inferred from
 *     each file's Last-Modified and the step's own run and lead
 *     (forecastValidity), and a file that cannot be dated is left out,
 *     never labelled by guess.
 *
 * The pure half (the names, the dating, the selection) is pinned by
 * tests/frontCharts.spec.ts; the fetch half never rejects, the tripCharts.ts
 * shape. Locale-free: failures carry a code the UI translates and a detail
 * that stays the untranslated wire line (docs/i18n.md rule 7). */

import { formatZulu } from '$lib/format/datetime';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The relay's listing path; a chart is `<path>/<name>`. */
export const DWD_ANALYSIS_PATH = '/dwd/charts/analysis';

/** Where the analyses live (a pilot's link opens a chart there directly). */
export const DWD_ANALYSIS_BASE = 'https://opendata.dwd.de/weather/charts/analysis/';

/** Where the forecast charts live: `ico_tkboden_na_<step>.png`. */
export const DWD_FORECAST_BASE = 'https://www.dwd.de/DWD/wetter/wv_spez/hobbymet/wetterkarten/';

/** DWD's own page of these charts (the credit links it). */
export const DWD_CHARTS_PAGE =
	'https://www.dwd.de/EN/ourservices/hobbymet_wcharts_europe/hobbyeuropecharts.html';

/** Météo-France's own front chart, which its terms let the app link and no
 *  more (meteofrance.com "Droits de reproduction", article 3). */
export const METEO_FRANCE_FRONTS_PAGE = 'https://meteofrance.com/isofronts';

/** The six forecast files, each the 00 UTC ICON run plus its lead, and the
 *  window after that run in which DWD writes it. Read off the charts' own
 *  legends (OCR, 2026-10-02), which contradict DWD's page text and menu
 *  label: `v36` is the PREVIOUS day's run +36 h (today 12 UTC), written
 *  about 23:59 the day before; the others are the day's run, written 03:52
 *  to 05:47. A file written outside its window (DWD's page says the H+48
 *  may be redrawn off the 12 UTC run in the evening) is not dated at all. */
export const DWD_FORECAST_STEPS = [
	{ id: 'v36', leadH: 36, minAfterRunH: 18, maxAfterRunH: 27 },
	{ id: '036', leadH: 36, minAfterRunH: 3, maxAfterRunH: 15 },
	{ id: '048', leadH: 48, minAfterRunH: 3, maxAfterRunH: 15 },
	{ id: '060', leadH: 60, minAfterRunH: 3, maxAfterRunH: 15 },
	{ id: '084', leadH: 84, minAfterRunH: 3, maxAfterRunH: 15 },
	{ id: '108', leadH: 108, minAfterRunH: 3, maxAfterRunH: 15 },
] as const;

export type DwdForecastStep = (typeof DWD_FORECAST_STEPS)[number];
export type DwdForecastStepId = DwdForecastStep['id'];

/** A chart is printed for a flight when its validity lies within this of the
 *  flight period (inclusive): DWD draws them twelve hours apart. */
export const NEAR_FLIGHT_MS = 6 * HOUR_MS;

/** At most this many charts for the flight itself, beside the situation. */
export const MAX_FLIGHT_SHEETS = 2;

/** The newest analysis older than this says so (DWD issues one every six
 *  hours, out one to four hours after its time). */
export const SITUATION_OLD_MS = 12 * HOUR_MS;

/** An analysis long side past this is drawn down for print: about 300 dpi
 *  on the A4 sheet, and a quarter of the full chart's 55 MB decoded, which
 *  an Android WebView holds for the whole print. */
export const PRINT_MAX_WIDTH_PX = 3000;

/** The listing's budget, under the relay's own 8 s plus the edge. */
const INDEX_TIMEOUT_MS = 15_000;
/** A forecast file's HEAD. */
const HEAD_TIMEOUT_MS = 15_000;
/** An analysis is 4.7 MB through the relay: a phone at an airfield. */
const ANALYSIS_TIMEOUT_MS = 60_000;
/** A forecast is 300 KB off www.dwd.de. */
const FORECAST_TIMEOUT_MS = 30_000;
/** Politeness pause between two chart downloads. */
const DOWNLOAD_PACE_MS = 250;

export type FrontChartKind = 'analysis' | 'forecast';

export interface FrontChart {
	kind: FrontChartKind;
	validAtMs: number;
	/** An analysis: when DWD produced it. A forecast: the model run. */
	issuedAtMs: number;
	/** A forecast's lead, hours; null for an analysis. */
	leadH: number | null;
	/** An analysis: its name as the listing spells it. A forecast: its step. */
	ref: string;
}

/** Why a part could not be had: a code the UI translates, and the wire line
 *  behind it, untranslated. */
export type FrontFailureCode =
	| 'timeout'
	| 'unreachable'
	| 'busy'
	| 'notDeployed'
	| 'upstream'
	| 'proxy'
	| 'dwd'
	| 'notImage'
	| 'malformed'
	| 'empty'
	| 'undated';

export interface FrontFailure {
	code: FrontFailureCode;
	detail: string;
}

export interface FrontChartsIndex {
	fetchedAtMs: number;
	/** Validity ascending, one per validity. */
	analyses: FrontChart[];
	/** The forecasts that could be dated, validity ascending. */
	forecasts: FrontChart[];
	/** The forecast steps whose file could not be dated. */
	undated: DwdForecastStepId[];
	/** The listing could not be had (null: it answered, maybe empty). */
	analysisFailure: FrontFailure | null;
	/** No forecast file answered at all. */
	forecastFailure: FrontFailure | null;
}

/** What a note says, and whether it holds the print for the pilot's
 *  decision (the TEMSI notes' rule): a flight left without a chart, or a
 *  half of the source unavailable, does; the rest is said and printed. */
export type FrontNoteKind =
	| 'none-near'
	| 'beyond'
	| 'analyses-unavailable'
	| 'forecasts-unavailable'
	| 'undated'
	| 'situation-old';

export interface FrontNote {
	kind: FrontNoteKind;
	/** 'none-near': the nearest validity there is; 'beyond': the last one;
	 *  'situation-old': the newest analysis's. Null otherwise. */
	validAtMs: number | null;
	/** 'undated': how many files. */
	count: number | null;
	failure: FrontFailure | null;
	holds: boolean;
}

export interface FrontSelection {
	/** Print order: the situation (the newest analysis) first, then the
	 *  charts for the flight by validity. */
	picks: FrontChart[];
	notes: FrontNote[];
}

export interface FrontChartEntry {
	chart: FrontChart;
	dataUrl: string;
	wPx: number;
	hPx: number;
}

export interface FrontChartsDoc {
	/** The sheets' "Retrieved" stamp. */
	fetchedAtMs: number;
	windowStartMs: number;
	windowEndMs: number;
	entries: FrontChartEntry[];
	notes: FrontNote[];
	/** Charts selected but not retrieved, each with why. */
	failed: { chart: FrontChart; failure: FrontFailure }[];
}

/* ------------------------------------------------------------------ pure */

/** "YYYYMMDDhhmm[ss]" as UTC epoch ms, or null unless it is a real instant
 *  written that way (no month 13, no 25 o'clock). */
function utcStamp(s: string): number | null {
	const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/.exec(s);
	if (!m) {
		return null;
	}
	const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '00'].map(Number);
	const ms = Date.UTC(y, mo - 1, d, h, mi, se);
	const back = new Date(ms);
	return back.getUTCFullYear() === y &&
		back.getUTCMonth() === mo - 1 &&
		back.getUTCDate() === d &&
		back.getUTCHours() === h &&
		back.getUTCMinutes() === mi &&
		back.getUTCSeconds() === se
		? ms
		: null;
}

const ANALYSIS_NAME_RE =
	/^Z__C_EDZW_(\d{14})_tka01%2Cana_bwkman_dwdna_O_000000_000000_(\d{12})_WV12\.png$/;

/** One analysis name as the listing spells it: its validity (a synoptic
 *  hour) and when DWD produced it (after that hour). Null for anything else:
 *  another product, the black-and-white rendering, a LATEST alias. */
export function parseAnalysisName(name: string): { validAtMs: number; producedAtMs: number } | null {
	const m = ANALYSIS_NAME_RE.exec(name);
	if (!m) {
		return null;
	}
	const producedAtMs = utcStamp(m[1]);
	const validAtMs = utcStamp(m[2]);
	if (producedAtMs == null || validAtMs == null) {
		return null;
	}
	if (validAtMs % (6 * HOUR_MS) !== 0 || producedAtMs < validAtMs) {
		return null;
	}
	return { validAtMs, producedAtMs };
}

/** The listing's names as analyses, one per validity (a chart produced twice
 *  keeps its newer production), validity ascending. */
export function analysesFromNames(names: readonly string[]): FrontChart[] {
	const byValid = new Map<number, FrontChart>();
	for (const name of names) {
		const p = parseAnalysisName(name);
		if (!p) {
			continue;
		}
		const cur = byValid.get(p.validAtMs);
		if (!cur || p.producedAtMs > cur.issuedAtMs) {
			byValid.set(p.validAtMs, {
				kind: 'analysis',
				validAtMs: p.validAtMs,
				issuedAtMs: p.producedAtMs,
				leadH: null,
				ref: name,
			});
		}
	}
	return [...byValid.values()].sort((a, b) => a.validAtMs - b.validAtMs);
}

/** A forecast file's run and validity from its Last-Modified: the 00 UTC run
 *  for which the write falls inside the step's window (one can at most, the
 *  windows being under a day wide), validity = run + lead. Null when none
 *  does: a file written off its schedule is not dated by guess. */
export function forecastValidity(
	step: DwdForecastStep,
	lastModifiedMs: number,
): { runMs: number; validAtMs: number } | null {
	if (!Number.isFinite(lastModifiedMs)) {
		return null;
	}
	const day = Math.floor(lastModifiedMs / DAY_MS) * DAY_MS;
	for (const runMs of [day, day - DAY_MS]) {
		const after = lastModifiedMs - runMs;
		if (after >= step.minAfterRunH * HOUR_MS && after < step.maxAfterRunH * HOUR_MS) {
			return { runMs, validAtMs: runMs + step.leadH * HOUR_MS };
		}
	}
	return null;
}

/** The step a forecast chart was read from. */
export function forecastStep(id: string): DwdForecastStep | null {
	return DWD_FORECAST_STEPS.find((s) => s.id === id) ?? null;
}

/** One forecast file's chart, dated off its Last-Modified; null undated. */
export function forecastChart(step: DwdForecastStep, lastModifiedMs: number): FrontChart | null {
	const v = forecastValidity(step, lastModifiedMs);
	return v
		? { kind: 'forecast', validAtMs: v.validAtMs, issuedAtMs: v.runMs, leadH: step.leadH, ref: step.id }
		: null;
}

/** The forecast file's URL. */
export function forecastUrl(id: string): string {
	return `${DWD_FORECAST_BASE}ico_tkboden_na_${id}.png`;
}

/** A pilot's link to the chart itself, at DWD. */
export function chartUrl(c: FrontChart): string {
	return c.kind === 'analysis' ? DWD_ANALYSIS_BASE + c.ref : forecastUrl(c.ref);
}

/** The forecast's invariant model token, "ICON 2026-10-02 00Z +36 h";
 *  null for an analysis. */
export function runToken(c: FrontChart): string | null {
	if (c.kind !== 'forecast' || c.leadH == null) {
		return null;
	}
	return `ICON ${new Date(c.issuedAtMs).toISOString().slice(0, 10)} 00Z +${c.leadH} h`;
}

/** The invariant token beside the print-progress counter. */
export function frontChartToken(c: FrontChart): string {
	return `DWD ${formatZulu(new Date(c.validAtMs))}`;
}

/** Which of two charts of one validity to keep: an analysis over a forecast,
 *  then the newer issue. */
function better(a: FrontChart, b: FrontChart): FrontChart {
	if (a.kind !== b.kind) {
		return a.kind === 'analysis' ? a : b;
	}
	return b.issuedAtMs > a.issuedAtMs ? b : a;
}

/** Every chart there is, one per validity, validity ascending. */
export function frontChartsOf(index: FrontChartsIndex): FrontChart[] {
	const byValid = new Map<number, FrontChart>();
	for (const c of [...index.analyses, ...index.forecasts]) {
		const cur = byValid.get(c.validAtMs);
		byValid.set(c.validAtMs, cur ? better(cur, c) : c);
	}
	return [...byValid.values()].sort((a, b) => a.validAtMs - b.validAtMs);
}

/** What the Weather tab lists: the newest analysis and the forecasts, one
 *  per validity (the analysis where it shares one), validity ascending. */
export function frontChartsListed(index: FrontChartsIndex): FrontChart[] {
	const newest = index.analyses.at(-1);
	return frontChartsOf({ ...index, analyses: newest ? [newest] : [] });
}

/** How far a validity lies from the flight period: zero inside it. */
function distanceToWindow(validAtMs: number, startMs: number, endMs: number): number {
	return validAtMs < startMs ? startMs - validAtMs : validAtMs > endMs ? validAtMs - endMs : 0;
}

/** The charts the flight is printed with, and what is said beside them.
 *
 *  The situation is the newest analysis, always printed while there is one.
 *  Beside it, every chart valid within NEAR_FLIGHT_MS of the period, one per
 *  validity (an analysis before a forecast, a newer run before an older),
 *  the MAX_FLIGHT_SHEETS closest to the period's middle kept (the earlier on
 *  a tie). A flight with no chart near it is said in a note that holds the
 *  print: past the last forecast DWD has drawn (`beyond`), or between two
 *  charts too far either side (`none-near`, naming the nearest).
 *
 *  `forecasts: false` (a TEMSI serves the flight's start, and is the chart of
 *  the fronts at that hour) leaves the forecasts out: the analyses alone are
 *  candidates, and nothing is said about the forecasts, a failed or undated
 *  file or a flight they do not reach. */
export function selectFrontCharts(
	index: FrontChartsIndex,
	opts: { windowStartMs: number; windowEndMs: number; nowMs: number; forecasts?: boolean | undefined },
): FrontSelection {
	const { windowStartMs: start, windowEndMs: end, nowMs } = opts;
	const withForecasts = opts.forecasts ?? true;
	const all = frontChartsOf(index).filter((c) => withForecasts || c.kind === 'analysis');
	const notes: FrontNote[] = [];
	if (index.analysisFailure) {
		notes.push({
			kind: 'analyses-unavailable',
			validAtMs: null,
			count: null,
			failure: index.analysisFailure,
			holds: true,
		});
	}
	if (withForecasts && index.forecastFailure) {
		notes.push({
			kind: 'forecasts-unavailable',
			validAtMs: null,
			count: null,
			failure: index.forecastFailure,
			holds: true,
		});
	}
	if (withForecasts && index.undated.length > 0) {
		notes.push({ kind: 'undated', validAtMs: null, count: index.undated.length, failure: null, holds: false });
	}
	const situation =
		index.analyses.length > 0 ? index.analyses[index.analyses.length - 1] : null;
	if (situation && nowMs - situation.validAtMs > SITUATION_OLD_MS) {
		notes.push({ kind: 'situation-old', validAtMs: situation.validAtMs, count: null, failure: null, holds: false });
	}
	const mid = (start + end) / 2;
	const near = all
		.filter((c) => distanceToWindow(c.validAtMs, start, end) <= NEAR_FLIGHT_MS)
		.sort((a, b) => Math.abs(a.validAtMs - mid) - Math.abs(b.validAtMs - mid) || a.validAtMs - b.validAtMs)
		.slice(0, MAX_FLIGHT_SHEETS);
	if (withForecasts && near.length === 0 && all.length > 0) {
		const last = all[all.length - 1];
		// Beyond what DWD has drawn only when the last chart IS a forecast:
		// with none dated, the newest analysis is merely the nearest chart.
		if (last.kind === 'forecast' && last.validAtMs < start - NEAR_FLIGHT_MS) {
			notes.push({ kind: 'beyond', validAtMs: last.validAtMs, count: null, failure: null, holds: true });
		} else {
			const nearest = all.reduce((best, c) =>
				distanceToWindow(c.validAtMs, start, end) < distanceToWindow(best.validAtMs, start, end) ? c : best,
			);
			notes.push({ kind: 'none-near', validAtMs: nearest.validAtMs, count: null, failure: null, holds: true });
		}
	}
	// The situation chart a flight chart already stands for is printed once,
	// as the flight's (the same chart, at the same validity).
	const flight = near.sort((a, b) => a.validAtMs - b.validAtMs);
	const picks =
		situation && !flight.some((c) => c.validAtMs === situation.validAtMs) ? [situation, ...flight] : flight;
	return { picks, notes };
}

/** A chart re-dated at download that no longer belongs: its validity left
 *  the flight's reach, or it now repeats another pick's. The situation
 *  stays whatever its validity, being the latest analysis by definition. */
export function keepAfterDownload(
	entries: readonly { chart: FrontChart; wasSituation: boolean }[],
	windowStartMs: number,
	windowEndMs: number,
): boolean[] {
	const seen = new Set<number>();
	return entries.map((e) => {
		const near = distanceToWindow(e.chart.validAtMs, windowStartMs, windowEndMs) <= NEAR_FLIGHT_MS;
		if ((!e.wasSituation && !near) || seen.has(e.chart.validAtMs)) {
			return false;
		}
		seen.add(e.chart.validAtMs);
		return true;
	});
}

/** A PNG's pixel size from its header (the IHDR chunk's first eight bytes),
 *  without decoding it; null unless the bytes open as a PNG. */
export function pngSize(bytes: Uint8Array): { w: number; h: number } | null {
	const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (bytes.length < 24 || !sig.every((b, i) => bytes[i] === b)) {
		return null;
	}
	// The IHDR type, bytes 12-15.
	if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
		return null;
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const w = dv.getUint32(16);
	const h = dv.getUint32(20);
	return w > 0 && h > 0 ? { w, h } : null;
}

/* ------------------------------------------------------------------ fetch */

function failureOfThrow(e: unknown, subject: string): FrontFailure {
	const reason = e instanceof Error ? e.message : String(e);
	if (e instanceof Error && e.name === 'TimeoutError') {
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		return { code: 'timeout', detail: `${subject} timed out: ${reason}` };
	}
	// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
	return { code: 'unreachable', detail: `${subject} unreachable: ${reason}` };
}

/** A relay answer the client cannot use: the proxy's own refusals and the
 *  upstream failures it frames. */
function relayFailure(status: number, subject: string): FrontFailure {
	// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
	const detail = `${subject} failed: HTTP ${status}`;
	if (status === 429) {
		return { code: 'busy', detail };
	}
	if (status === 404) {
		return { code: 'notDeployed', detail };
	}
	if (status === 502 || status === 504) {
		return { code: 'upstream', detail };
	}
	return { code: 'proxy', detail };
}

function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
	const t = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([t, signal]) : t;
}

/** The analyses through the relay; never rejects. */
async function fetchAnalyses(
	proxyBase: string,
	signal?: AbortSignal,
): Promise<{ analyses: FrontChart[]; failure: FrontFailure | null }> {
	// i18n-ignore: wire diagnostic subject, stays EN (docs/i18n.md rule 7)
	const subject = 'DWD analysis listing';
	let res: Response;
	try {
		res = await fetch(`${proxyBase}${DWD_ANALYSIS_PATH}`, {
			cache: 'no-store',
			signal: timeoutSignal(INDEX_TIMEOUT_MS, signal),
		});
	} catch (e) {
		return { analyses: [], failure: failureOfThrow(e, subject) };
	}
	if (!res.ok) {
		await res.body?.cancel().catch(() => {});
		return { analyses: [], failure: relayFailure(res.status, subject) };
	}
	try {
		const body = (await res.json()) as unknown;
		const names =
			body && typeof body === 'object' && Array.isArray((body as { names?: unknown }).names)
				? (body as { names: unknown[] }).names.filter((n) => typeof n === 'string')
				: null;
		if (!names) {
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			return { analyses: [], failure: { code: 'malformed', detail: `${subject}: no names` } };
		}
		const analyses = analysesFromNames(names);
		// A listing that names no analysis this reader takes (DWD renaming its
		// files, or a directory emptied) is the half unavailable, said and
		// holding, never a print quietly short of its situation chart.
		if (analyses.length === 0) {
			return {
				analyses,
				// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
				failure: { code: 'empty', detail: `${subject}: ${names.length} names, no analysis read` },
			};
		}
		return { analyses, failure: null };
	} catch (e) {
		return {
			analyses: [],
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			failure: { code: 'malformed', detail: `${subject}: ${e instanceof Error ? e.message : String(e)}` },
		};
	}
}

/** One forecast file's HEAD: its chart when it answered (null undated), or
 *  why it did not. */
interface HeadResult {
	step: DwdForecastStep;
	chart?: FrontChart | null;
	failure: FrontFailure | null;
}

/** The six forecast files' dates, read with HEAD straight from www.dwd.de;
 *  never rejects. A file missing or failing is skipped; all failing is the
 *  half unavailable. */
async function fetchForecasts(signal?: AbortSignal): Promise<{
	forecasts: FrontChart[];
	undated: DwdForecastStepId[];
	failure: FrontFailure | null;
}> {
	const results = await Promise.all(
		DWD_FORECAST_STEPS.map(async (step): Promise<HeadResult> => {
			const subject = `DWD forecast ${step.id}`;
			try {
				const res = await fetch(forecastUrl(step.id), {
					method: 'HEAD',
					cache: 'no-store',
					signal: timeoutSignal(HEAD_TIMEOUT_MS, signal),
				});
				if (!res.ok) {
					// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
					return { step, failure: { code: 'dwd', detail: `${subject}: HTTP ${res.status}` } };
				}
				const lm = Date.parse(res.headers.get('last-modified') ?? '');
				return { step, chart: forecastChart(step, lm), failure: null };
			} catch (e) {
				return { step, failure: failureOfThrow(e, subject) };
			}
		}),
	);
	const forecasts: FrontChart[] = [];
	const undated: DwdForecastStepId[] = [];
	let firstFailure: FrontFailure | null = null;
	let answered = 0;
	for (const r of results) {
		if (r.failure) {
			firstFailure ??= r.failure;
			continue;
		}
		answered++;
		if ('chart' in r && r.chart) {
			forecasts.push(r.chart);
		} else {
			undated.push(r.step.id);
		}
	}
	forecasts.sort((a, b) => a.validAtMs - b.validAtMs);
	return { forecasts, undated, failure: answered === 0 ? firstFailure : null };
}

/** Both halves of what DWD has now; never rejects. */
export async function fetchFrontIndex(proxyBase: string, signal?: AbortSignal): Promise<FrontChartsIndex> {
	const [a, f] = await Promise.all([fetchAnalyses(proxyBase, signal), fetchForecasts(signal)]);
	return {
		fetchedAtMs: Date.now(),
		analyses: a.analyses,
		forecasts: f.forecasts,
		undated: f.undated,
		analysisFailure: a.failure,
		forecastFailure: f.failure,
	};
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

function base64Of(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let s = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(s);
}

/** An analysis drawn down to PRINT_MAX_WIDTH_PX for the paper (the relay's
 *  answer carries CORS, so the canvas stays readable); the original bytes
 *  when it is no wider, or when the drawing fails. */
async function printImage(
	bytes: Uint8Array<ArrayBuffer>,
	size: { w: number; h: number },
): Promise<{ dataUrl: string; wPx: number; hPx: number }> {
	const original = { dataUrl: `data:image/png;base64,${base64Of(bytes)}`, wPx: size.w, hPx: size.h };
	if (size.w <= PRINT_MAX_WIDTH_PX || typeof createImageBitmap !== 'function') {
		return original;
	}
	try {
		const w = PRINT_MAX_WIDTH_PX;
		const h = Math.round((size.h * w) / size.w);
		const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
			resizeWidth: w,
			resizeHeight: h,
			resizeQuality: 'high',
		});
		try {
			const canvas = document.createElement('canvas');
			canvas.width = w;
			canvas.height = h;
			const g = canvas.getContext('2d');
			if (!g) {
				return original;
			}
			g.drawImage(bitmap, 0, 0);
			return { dataUrl: canvas.toDataURL('image/png'), wPx: w, hPx: h };
		} finally {
			bitmap.close();
		}
	} catch {
		return original;
	}
}

/** One chart's bytes, checked to be a PNG; a forecast's Last-Modified with
 *  them (the bytes' own, which dates what is printed). */
async function downloadChart(
	proxyBase: string,
	chart: FrontChart,
	signal?: AbortSignal,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; size: { w: number; h: number }; lastModifiedMs: number }> {
	const analysis = chart.kind === 'analysis';
	const subject = analysis ? 'DWD analysis' : `DWD forecast ${chart.ref}`;
	let res: Response;
	try {
		res = analysis
			? await fetch(`${proxyBase}${DWD_ANALYSIS_PATH}/${chart.ref}`, {
					signal: timeoutSignal(ANALYSIS_TIMEOUT_MS, signal),
				})
			: await fetch(forecastUrl(chart.ref), {
					cache: 'no-store',
					signal: timeoutSignal(FORECAST_TIMEOUT_MS, signal),
				});
	} catch (e) {
		throw new FrontError(failureOfThrow(e, subject));
	}
	if (!res.ok) {
		await res.body?.cancel().catch(() => {});
		throw new FrontError(
			analysis
				? relayFailure(res.status, subject)
				: // i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
					{ code: 'dwd', detail: `${subject}: HTTP ${res.status}` },
		);
	}
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		bytes = new Uint8Array(await res.arrayBuffer());
	} catch (e) {
		throw new FrontError(failureOfThrow(e, subject));
	}
	const size = pngSize(bytes);
	if (!size) {
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new FrontError({ code: 'notImage', detail: `${subject}: not a PNG` });
	}
	return { bytes, size, lastModifiedMs: Date.parse(res.headers.get('last-modified') ?? '') };
}

class FrontError extends Error {
	readonly failure: FrontFailure;
	constructor(failure: FrontFailure) {
		super(failure.detail);
		this.failure = failure;
	}
}

export interface FrontChartsInput {
	proxyBase: string;
	index: FrontChartsIndex;
	windowStartMs: number;
	windowEndMs: number;
	nowMs?: number;
	/** False when a TEMSI serves the flight's start: the forecasts are left
	 *  out (selectFrontCharts). Absent, they are candidates. */
	forecasts?: boolean | undefined;
	/** Stops the download loop between charts and aborts the one in flight. */
	signal?: AbortSignal;
	/** Absolute progress; `current` the chart's invariant token while one is
	 *  being fetched, null between. */
	onProgress?: (done: number, total: number, current: string | null) => void;
}

/** Select, download and prepare the flight's charts for the paper. Never
 *  rejects: a chart that fails is in `failed`, with why. A forecast is dated
 *  again off the bytes it arrived with, and one that a new run has moved
 *  out of the flight's reach, or onto another pick's validity, is dropped. */
export async function fetchFrontCharts(input: FrontChartsInput): Promise<FrontChartsDoc> {
	const nowMs = input.nowMs ?? Date.now();
	const sel = selectFrontCharts(input.index, {
		windowStartMs: input.windowStartMs,
		windowEndMs: input.windowEndMs,
		nowMs,
		forecasts: input.forecasts,
	});
	const situation = input.index.analyses.at(-1) ?? null;
	const got: { entry: FrontChartEntry; wasSituation: boolean }[] = [];
	const failed: FrontChartsDoc['failed'] = [];
	input.onProgress?.(0, sel.picks.length, null);
	for (const [i, chart] of sel.picks.entries()) {
		if (input.signal?.aborted) {
			break;
		}
		if (i > 0) {
			await pause(DOWNLOAD_PACE_MS, input.signal);
		}
		input.onProgress?.(i, sel.picks.length, frontChartToken(chart));
		try {
			const d = await downloadChart(input.proxyBase, chart, input.signal);
			let dated = chart;
			if (chart.kind === 'forecast') {
				const step = forecastStep(chart.ref);
				const again = step ? forecastChart(step, d.lastModifiedMs) : null;
				if (!again) {
					failed.push({
						chart,
						// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
						failure: { code: 'undated', detail: `DWD forecast ${chart.ref}: written off its schedule` },
					});
					continue;
				}
				dated = again;
			}
			const img = chart.kind === 'analysis' ? await printImage(d.bytes, d.size) : null;
			got.push({
				entry: {
					chart: dated,
					dataUrl: img ? img.dataUrl : `data:image/png;base64,${base64Of(d.bytes)}`,
					wPx: img ? img.wPx : d.size.w,
					hPx: img ? img.hPx : d.size.h,
				},
				wasSituation: situation != null && chart === situation,
			});
		} catch (e) {
			if (input.signal?.aborted) {
				break; // a Cancel, not a failure
			}
			failed.push({
				chart,
				failure:
					e instanceof FrontError
						? e.failure
						: // i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
							{ code: 'malformed', detail: e instanceof Error ? e.message : String(e) },
			});
		}
	}
	input.onProgress?.(got.length + failed.length, sel.picks.length, null);
	const keep = keepAfterDownload(
		got.map((g) => ({ chart: g.entry.chart, wasSituation: g.wasSituation })),
		input.windowStartMs,
		input.windowEndMs,
	);
	const entries = got.filter((_, i) => keep[i]).map((g) => g.entry);
	const notes = [...sel.notes];
	// The re-dating took the flight's only charts away: say so as a missing one.
	const flightCharts = entries.filter((e) => !(e.chart.kind === 'analysis' && e.chart === situation));
	if (
		sel.picks.some((p) => p !== situation) &&
		flightCharts.length === 0 &&
		failed.length === 0 &&
		!notes.some((n) => n.kind === 'none-near' || n.kind === 'beyond')
	) {
		notes.push({ kind: 'none-near', validAtMs: null, count: null, failure: null, holds: true });
	}
	return {
		fetchedAtMs: Date.now(),
		windowStartMs: input.windowStartMs,
		windowEndMs: input.windowEndMs,
		entries: entries.sort((a, b) => order(a.chart, situation) - order(b.chart, situation)),
		notes,
		failed,
	};
}

/** Print order: the situation first, then by validity. */
function order(c: FrontChart, situation: FrontChart | null): number {
	return situation && c === situation ? -Infinity : c.validAtMs;
}
