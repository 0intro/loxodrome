/* Flight-relevant TEMSI / WINTEM chart snapshot for the printed flight
 * dossier's meteo annex (the tripWx.ts pattern: plain async orchestration,
 * never rejects, per-chart degradation). The pure half - flight-level
 * parsing, the planned-altitude range, the zone pick and the selection of
 * catalog charts covering the flight window - is exported for the Vitest
 * pins; the fetch half downloads each selected PDF through the worker relay
 * (GET /sofia/chart: aviation.meteo.fr sends no CORS headers and its tokens
 * bind one exact chart, so the browser cannot read the bytes directly) and
 * rasterizes page 1 with a dynamically imported pdf.js, keeping the main
 * bundle clean. Catalogs are passed IN (state/sofiaCharts.svelte.ts owns the
 * cache and the SOFIA pacing); callers gate on display.liveWeather.
 *
 * The selection reads Météo-France's own schedule (chartSchedule.ts): when
 * each chart is valid, when it is published, and how long the latest one
 * serves while the next is not out. Every product left without a usable
 * chart for the flight says so in a note that HOLDS the print for the
 * pilot's decision; a chart for the end of the flight not out yet, or the
 * latest TEMSI printed to extrapolate, is said without holding. Contract
 * notes: docs/sofia-charts.md. */

import type { SofiaChart, SofiaChartProduct, SofiaZone } from '$lib/sofia/charts';
import {
	chartHttpFailure,
	fetchFailure,
	notPdfFailure,
	retryBudget,
	SofiaError,
	type SofiaFailure,
} from '$lib/sofia/failure';
import { uniqueBy } from '$lib/data/dedup';
import {
	chartSchedule,
	EXTRAPOLATION_MAX_MS,
	OVERDUE_GRACE_MS,
	scheduledValidities,
	type ChartSchedule,
} from './chartSchedule';

/** Nominal validity spacing when an unscheduled group has a single chart. */
const NOMINAL_STEP_MS = 3 * 3_600_000;

const DAY_MS = 24 * 3_600_000;

/** Politeness pause between two chart PDF downloads. */
const DOWNLOAD_PACE_MS = 250;

/** One chart download's budget. INVARIANT (the catalog's, sofia/charts.ts):
 *  it outlasts the worker's own for the relay (loxodrome-proxy/worker.js
 *  FETCH_TIMEOUT_MS `chart`, 20 s), so the worker always answers first.
 *  Pinned by tests/sofiaTimeouts.spec.ts. */
const CHART_TIMEOUT_MS = 25_000;

/** The pause before a failed download's one retry. */
const RETRY_PAUSE_MS = 2_000;

/** Long side of the rasterized chart, px (~190 dpi on A4). */
const RASTER_LONG_SIDE_PX = 2200;

export interface TripChartEntry {
	chart: SofiaChart;
	pngDataUrl: string;
	wPx: number;
	hPx: number;
	/** Printed as the TEMSI in force while the one covering the flight's start
	 *  is not out yet (Météo-France's rule: the latest chart serves until the
	 *  next arrives, the pilot extrapolating): that chart's validity and when
	 *  it is published. Absent on every other sheet. */
	extrapolated?: { nextValidAtMs: number; publishAtMs: number | null } | undefined;
}

/** What a note says about a product in a zone:
 *  'not-yet-published' = the chart the flight's start needs is not out yet;
 *  'missing' = a chart the schedule says should be out is not listed;
 *  'later' = the chart for the end of the flight is not out yet;
 *  'extrapolated' = the latest TEMSI is printed for a start the next one will
 *  cover (`url` is that chart);
 *  'undated' = the catalog's dates were unreadable;
 *  'none' = the catalog lists no chart at all.
 *  A flight already behind us is no product's note: the doc says it once
 *  (TripChartsDoc.past). */
export type TripChartNoteKind =
	| 'not-yet-published'
	| 'missing'
	| 'later'
	| 'extrapolated'
	| 'undated'
	| 'none';

export interface TripChartNote {
	product: SofiaChartProduct;
	zone: string;
	kind: TripChartNoteKind;
	/** The WINTEM sheet the note is about, when one sheet raised it. */
	level: string | null;
	/** The validity the note is about (the chart not out, or the one an
	 *  extrapolated chart stands in for); null for undated / none. */
	validAtMs: number | null;
	/** When Météo-France makes that chart available; null where unknown. */
	publishAtMs: number | null;
	/** 'extrapolated' only: the printed chart's link. */
	url: string | null;
	/** Whether the note holds the print for the pilot's decision: a product
	 *  left without a usable chart for the flight does; the end of the
	 *  flight's chart not out yet and an extrapolated chart do not. */
	holds: boolean;
}

/** The planned flight is already behind us: its start, the stated departure,
 *  or the flight date's 00 UTC when only the date is known (`dayOnly`, which
 *  the sentence then prints without a time). */
export interface FlightPast {
	startMs: number;
	dayOnly: boolean;
}

export interface TripChartsDoc {
	/** Snapshot time, ms: the sheets' "Retrieved" stamp. */
	fetchedAtMs: number;
	/** The flight window the charts were chosen for (the flight's start alone
	 *  when it was already behind and none was asked for). */
	windowStartMs: number;
	windowEndMs: number;
	/** The flight is already behind us: no chart applies, and the notes sheet
	 *  says so once, whatever the products and zones. */
	past: FlightPast | null;
	/** Rendered charts in print order: TEMSI then WINTEM. */
	entries: TripChartEntry[];
	notes: TripChartNote[];
	/** Charts selected but not rendered, each with why. */
	failed: TripChartFailure[];
	/** Each requested product + zone whose catalog could not be listed, with
	 *  why: a failed EUROC beside a good FRANCE is said, not silent. */
	catalogFailures: TripCatalogFailure[];
}

export interface TripChartFailure {
	chart: SofiaChart;
	failure: SofiaFailure;
}

export interface TripCatalogFailure {
	zone: string;
	product: SofiaChartProduct;
	failure: SofiaFailure;
}

/** The chart's invariant display token (SOFIA's own product / zone / level
 *  vocabulary): sheet heads and the print-progress step line. */
export function chartToken(c: SofiaChart): string {
	return `${c.product} ${c.zone}${c.level ? ` ${c.level}` : ''}`;
}

/** "FL020" / "FL115" -> feet; bands ("FL20-150") and anything else null. */
export function parseChartFl(level: string | null): number | null {
	if (!level) {
		return null;
	}
	const m = /^FL(\d{2,3})$/.exec(level.trim());
	return m ? Number(m[1]) * 100 : null;
}

/** The levels a chart label carries, in feet: "FL050" one level, "FL20-100"
 *  the band from FL020 to FL100; null for anything else. */
export function parseChartLevels(label: string | null): { loFt: number; hiFt: number } | null {
	if (!label) {
		return null;
	}
	const one = parseChartFl(label);
	if (one != null) {
		return { loFt: one, hiFt: one };
	}
	const band = /^FL(\d{2,3})-(\d{2,3})$/.exec(label.trim());
	return band ? { loFt: Number(band[1]) * 100, hiFt: Number(band[2]) * 100 } : null;
}

/** Min/max planned altitude over the printed routes' per-leg values; null
 *  when no route has a leg. */
export function altRange(
	legAltsFt: readonly (readonly number[])[],
): { minFt: number; maxFt: number } | null {
	let min = Infinity;
	let max = -Infinity;
	for (const legs of legAltsFt) {
		for (const ft of legs) {
			if (Number.isFinite(ft)) {
				min = Math.min(min, ft);
				max = Math.max(max, ft);
			}
		}
	}
	return max === -Infinity ? null : { minFt: min, maxFt: max };
}

/** Coarse TEMSI / WINTEM EUROC coverage (western + central Europe, per the
 *  Meteo-France Guide Aviation): a flight outside both the French FIRs and
 *  this box gets no chart sheets rather than an irrelevant EUROC set. */
export const EUROC_BBOX = { minLat: 25, minLon: -30, maxLat: 72, maxLon: 45 };

/** The chart zones relevant to the planned routes: FRANCE when any sampled
 *  point sits in the French metropolitan FIRs (or the FIR data is
 *  unavailable: `presence` null, the conservative domestic default), EUROC
 *  added when any point leaves them and the routes touch EUROC coverage. */
export function chartZones(
	presence: { inside: boolean; outside: boolean } | null,
	routesWaypoints: readonly (readonly { lat: number; lon: number }[])[],
): SofiaZone[] {
	if (!presence) {
		return ['FRANCE'];
	}
	const zones: SofiaZone[] = [];
	if (presence.inside || !presence.outside) {
		zones.push('FRANCE');
	}
	if (presence.outside) {
		let minLat = Infinity;
		let minLon = Infinity;
		let maxLat = -Infinity;
		let maxLon = -Infinity;
		for (const wps of routesWaypoints) {
			for (const w of wps) {
				minLat = Math.min(minLat, w.lat);
				maxLat = Math.max(maxLat, w.lat);
				minLon = Math.min(minLon, w.lon);
				maxLon = Math.max(maxLon, w.lon);
			}
		}
		const inEuroc =
			maxLat >= EUROC_BBOX.minLat &&
			minLat <= EUROC_BBOX.maxLat &&
			maxLon >= EUROC_BBOX.minLon &&
			minLon <= EUROC_BBOX.maxLon;
		if (maxLat !== -Infinity && inEuroc) {
			zones.push('EUROC');
		}
	}
	return zones;
}

export interface ChartSelection {
	picks: SofiaChart[];
	notes: TripChartNote[];
	/** The whole window is behind `nowMs`: nothing is picked, and no product
	 *  raises a note of its own. */
	past: boolean;
	/** A TEMSI serves the flight's start: the chart covering it is listed, or
	 *  the latest one stands in for it ('extrapolated'). The DWD front charts
	 *  leave their forecasts out then, the TEMSI being the chart of the fronts
	 *  at that hour (docs/front-charts.md). */
	temsiAtStart: boolean;
}

export interface ChartSelectionOptions {
	windowStartMs: number;
	windowEndMs: number;
	altRangeFt: { minFt: number; maxFt: number } | null;
	/** The selection's present: a stretch of the flight already behind needs
	 *  no chart, and a chart due before it and not listed is missing. Absent,
	 *  no instant is known (nothing is past, nothing overdue). */
	nowMs?: number | undefined;
	/** The products and zones whose catalog was listed: one listing nothing
	 *  at all is said ('none') rather than silent. */
	expected?: readonly { product: SofiaChartProduct; zone: string }[] | undefined;
}

interface ChartGroup {
	product: SofiaChartProduct;
	zone: string;
	/** The WINTEM sheet (its label, chartToken's level); '' for TEMSI. */
	sheet: string;
	/** The levels the WINTEM sheet carries; null for TEMSI and unreadable
	 *  labels (relevant whatever the altitude: fail-open). */
	levels: { loFt: number; hiFt: number } | null;
	/** Dated charts, validity ascending. */
	dated: SofiaChart[];
	undated: number;
}

/** Covers for an unscheduled group: each chart half-way to its listed
 *  neighbours (half-open), the median gap at the edges, so a 6-hourly set
 *  keeps 6-hourly edges (3 h nominal for a single chart). */
function medianCovers(validities: readonly number[]): [number, number][] {
	const gaps: number[] = [];
	for (let i = 1; i < validities.length; i++) {
		gaps.push(validities[i] - validities[i - 1]);
	}
	const sorted = [...gaps].sort((a, b) => a - b);
	const edge = sorted.length > 0 ? sorted[Math.floor((sorted.length - 1) / 2)] : NOMINAL_STEP_MS;
	return validities.map((t, i) => {
		const prev = i > 0 ? t - validities[i - 1] : edge;
		const next = i + 1 < validities.length ? validities[i + 1] - t : edge;
		return [t - prev / 2, t + next / 2];
	});
}

/** The WINTEM sheets of one zone worth printing for [minFt, maxFt]: every
 *  sheet whose levels meet the range, plus the nearest sheet below the
 *  range's bottom and above its top wherever no selected sheet holds that
 *  end (so a cruise between two one-level sheets prints both, and one inside
 *  a composite band prints that band alone). */
function relevantSheets(
	groups: readonly ChartGroup[],
	range: { minFt: number; maxFt: number },
): Set<string> {
	const sheets = uniqueBy(groups, (g) => g.sheet);
	const keep = new Set<string>();
	const withLevels: { sheet: string; loFt: number; hiFt: number }[] = [];
	for (const g of sheets) {
		if (g.levels == null) {
			keep.add(g.sheet); // unreadable: printed rather than guessed away
		} else {
			withLevels.push({ sheet: g.sheet, ...g.levels });
		}
	}
	const meets = withLevels.filter((s) => s.loFt <= range.maxFt && s.hiFt >= range.minFt);
	for (const s of meets) {
		keep.add(s.sheet);
	}
	if (!meets.some((s) => s.loFt <= range.minFt && range.minFt <= s.hiFt)) {
		const below = withLevels.filter((s) => s.hiFt < range.minFt);
		if (below.length > 0) {
			keep.add(below.reduce((a, b) => (b.hiFt > a.hiFt ? b : a)).sheet);
		}
	}
	if (!meets.some((s) => s.loFt <= range.maxFt && range.maxFt <= s.hiFt)) {
		const above = withLevels.filter((s) => s.loFt > range.maxFt);
		if (above.length > 0) {
			keep.add(above.reduce((a, b) => (b.loFt < a.loFt ? b : a)).sheet);
		}
	}
	return keep;
}

/** Select the catalog charts relevant to the flight and say what is
 *  missing. TEMSI: every validity covering the window; WINTEM: per relevant
 *  sheet (the levels the planned altitudes need, per zone), the covering
 *  validity nearest mid-flight. `altRangeFt` null skips WINTEM entirely.
 *
 *  A chart covers half-way to its neighbours on Météo-France's schedule,
 *  listed or not (so the TEMSI FRANCE of 00 UTC covers to 03 UTC, the next
 *  being 06 UTC). Where the chart the flight's start needs is not out yet,
 *  the latest TEMSI listed serves when it is under 3 h old at that start
 *  (the guide's rule, printed with its caption); otherwise the product holds
 *  the print. Returns the picks in print order (TEMSI then WINTEM, FRANCE
 *  before EUROC, level then validity ascending) plus the notes, or nothing
 *  but `past` for a window wholly behind `nowMs`. */
export function selectTripCharts(
	charts: readonly SofiaChart[],
	opts: ChartSelectionOptions,
): ChartSelection {
	const now = opts.nowMs ?? Number.NEGATIVE_INFINITY;
	const end = opts.windowEndMs;
	// The stretch of the flight still ahead: one already flown needs no chart.
	const start = Math.max(opts.windowStartMs, now);
	const notes: TripChartNote[] = [];
	let temsiAtStart = false;
	const note = (
		g: { product: SofiaChartProduct; zone: string },
		kind: TripChartNoteKind,
		holds: boolean,
		extra: Partial<Pick<TripChartNote, 'level' | 'validAtMs' | 'publishAtMs' | 'url'>> = {},
	): void => {
		notes.push({
			product: g.product,
			zone: g.zone,
			kind,
			level: extra.level ?? null,
			validAtMs: extra.validAtMs ?? null,
			publishAtMs: extra.publishAtMs ?? null,
			url: extra.url ?? null,
			holds,
		});
	};

	const groups = new Map<string, ChartGroup>();
	// A chart listed twice in one zone is one chart. Listed in two zones it
	// stays in each: a chart's cover is read off its zone's neighbours, and
	// dropped from the second zone it let that zone's neighbours meet over
	// its hour, both printed for a window only it covers. The picks are made
	// unique below, so it prints once.
	for (const c of uniqueBy(charts, (x) => `${x.zone}|${x.url}`)) {
		const sheet = c.product === 'WINTEM' ? (c.level ?? '') : '';
		const key = `${c.product}|${c.zone}|${sheet}`;
		let g = groups.get(key);
		if (!g) {
			g = {
				product: c.product,
				zone: c.zone,
				sheet,
				levels: c.product === 'WINTEM' ? parseChartLevels(c.level) : null,
				dated: [],
				undated: 0,
			};
			groups.set(key, g);
		}
		if (c.validAtMs == null) {
			g.undated++;
		} else {
			g.dated.push(c);
		}
	}
	for (const g of groups.values()) {
		g.dated.sort((a, b) => a.validAtMs! - b.validAtMs!);
	}

	// The whole flight is behind: no chart applies.
	if (end <= now) {
		return { picks: [], notes: [], past: true, temsiAtStart: false };
	}

	// Relevant WINTEM sheets, per zone.
	const relevantByZone = new Map<string, Set<string>>();
	if (opts.altRangeFt) {
		for (const zone of new Set([...groups.values()].map((g) => g.zone))) {
			const wintem = [...groups.values()].filter((g) => g.product === 'WINTEM' && g.zone === zone);
			relevantByZone.set(zone, relevantSheets(wintem, opts.altRangeFt));
		}
	}

	const picks: SofiaChart[] = [];
	const windowMid = (start + end) / 2;
	const nearestMid = (cs: readonly SofiaChart[]): SofiaChart =>
		cs.reduce((best, c) =>
			Math.abs(c.validAtMs! - windowMid) < Math.abs(best.validAtMs! - windowMid) ? c : best,
		);

	for (const g of groups.values()) {
		if (g.product === 'WINTEM') {
			if (!opts.altRangeFt || !relevantByZone.get(g.zone)?.has(g.sheet)) {
				continue;
			}
		}
		const level = g.product === 'WINTEM' ? g.sheet || null : null;
		if (g.dated.length === 0) {
			if (g.undated > 0) {
				note(g, 'undated', true, { level });
			}
			continue;
		}
		const schedule = chartSchedule(g.product, g.zone);
		if (!schedule) {
			// Unscheduled zone: the catalog's own spacing, as ever.
			const covers = medianCovers(g.dated.map((c) => c.validAtMs!));
			const covering = g.dated.filter((_, i) => covers[i][0] < end && start < covers[i][1]);
			if (g.product === 'TEMSI' && covers.some(([lo, hi]) => lo <= start && start < hi)) {
				temsiAtStart = true;
			}
			if (covering.length > 0) {
				picks.push(...(g.product === 'TEMSI' ? covering : [nearestMid(covering)]));
			} else if (start >= covers[covers.length - 1][1]) {
				note(g, 'not-yet-published', true, { level });
			}
			continue;
		}
		selectScheduled(g, schedule, level);
	}

	function selectScheduled(g: ChartGroup, s: ChartSchedule, level: string | null): void {
			const listed = new Map<number, SofiaChart>();
		for (const c of g.dated) {
			if (!listed.has(c.validAtMs!)) {
				listed.set(c.validAtMs!, c);
			}
		}
		const lv = [...listed.keys()];
		const lo = Math.min(start, lv[0]) - DAY_MS;
		const hi = Math.max(end, lv[lv.length - 1]) + DAY_MS;
		const grid = [...new Set([...lv, ...scheduledValidities(s, lo, hi)])].sort((a, b) => a - b);
		const covers = grid.map((v, i): [number, number] => [
			i > 0 ? (grid[i - 1] + v) / 2 : v - NOMINAL_STEP_MS / 2,
			i + 1 < grid.length ? (v + grid[i + 1]) / 2 : v + NOMINAL_STEP_MS / 2,
		]);
		const needed = grid.filter((_, i) => covers[i][0] < end && start < covers[i][1]);
		if (needed.length === 0) {
			return;
		}
		const publishAt = (v: number): number | null => (s.leadMs == null ? null : v - s.leadMs);
		const overdue = (v: number): boolean => {
			const p = publishAt(v);
			return p != null ? now >= p + OVERDUE_GRACE_MS : now >= v;
		};
		const listedNeeded = needed.filter((v) => listed.has(v)).map((v) => listed.get(v)!);
		if (listedNeeded.length > 0) {
			picks.push(...(g.product === 'TEMSI' ? listedNeeded : [nearestMid(listedNeeded)]));
		}
		// The chart the flight's start needs.
		const first = needed[0];
		if (listed.has(first) && g.product === 'TEMSI') {
			temsiAtStart = true;
		}
		if (!listed.has(first)) {
			const latest = lv.filter((v) => v <= start).at(-1);
			if (g.product === 'TEMSI' && latest != null && start - latest < EXTRAPOLATION_MAX_MS) {
				// The guide's rule: the latest chart serves until the next is
				// out, the pilot extrapolating the active systems.
				const printed = listed.get(latest)!;
				picks.push(printed);
				temsiAtStart = true;
				note(g, 'extrapolated', false, {
					validAtMs: first,
					publishAtMs: publishAt(first),
					url: printed.url,
				});
				if (overdue(first)) {
					note(g, 'missing', true, { level, validAtMs: first, publishAtMs: publishAt(first) });
				}
			} else if (g.product === 'TEMSI' || listedNeeded.length === 0) {
				// A TEMSI short of its start chart holds even with a later one
				// listed: that stretch of the flight has no chart. A WINTEM
				// sheet holds only when nothing of the flight is listed, its one
				// sheet being the nearest mid-flight.
				note(g, overdue(first) ? 'missing' : 'not-yet-published', true, {
					level,
					validAtMs: first,
					publishAtMs: publishAt(first),
				});
			}
		}
		// Later in the flight: a chart overdue holds, the next one not out yet
		// is said once.
		let laterSaid = false;
		for (const v of needed.slice(1)) {
			if (listed.has(v)) {
				continue;
			}
			if (overdue(v)) {
				note(g, 'missing', true, { level, validAtMs: v, publishAtMs: publishAt(v) });
			} else if (!laterSaid && g.product === 'TEMSI') {
				note(g, 'later', false, { validAtMs: v, publishAtMs: publishAt(v) });
				laterSaid = true;
			}
		}
	}

	// A catalog that listed nothing at all for a product and zone.
	for (const p of opts.expected ?? []) {
		if (![...groups.values()].some((g) => g.product === p.product && g.zone === p.zone)) {
			note(p, 'none', true);
		}
	}

	const zoneRank = (z: string): number => (z === 'FRANCE' ? 0 : z === 'EUROC' ? 1 : 2);
	picks.sort(
		(a, b) =>
			(a.product === b.product ? 0 : a.product === 'TEMSI' ? -1 : 1) ||
			zoneRank(a.zone) - zoneRank(b.zone) ||
			a.zone.localeCompare(b.zone) ||
			(parseChartLevels(a.level)?.loFt ?? 9e9) - (parseChartLevels(b.level)?.loFt ?? 9e9) ||
			(a.validAtMs ?? 0) - (b.validAtMs ?? 0),
	);
	// A chart two zones list was picked in each: printed once, under the zone
	// the print order puts first.
	return { picks: uniqueBy(picks, (c) => c.url), notes: mergeNotes(notes), past: false, temsiAtStart };
}

/** One note per product, zone, kind and validity: several sheets of a zone
 *  short of the same chart are one line, which names the sheet only when one
 *  sheet raised it. */
function mergeNotes(notes: readonly TripChartNote[]): TripChartNote[] {
	const out: TripChartNote[] = [];
	for (const n of notes) {
		const same = out.find(
			(o) =>
				o.product === n.product &&
				o.zone === n.zone &&
				o.kind === n.kind &&
				o.validAtMs === n.validAtMs,
		);
		if (!same) {
			out.push({ ...n });
		} else if (same.level !== n.level) {
			same.level = null;
		}
	}
	return out;
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const done = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener('abort', done, { once: true });
	});
}

/** Fetch one chart's PDF bytes through the worker relay: the three query
 *  params of the catalog link, and nothing else, cross the proxy. Throws a
 *  SofiaError with the classified cause (failure.ts chartHttpFailure). */
export async function downloadChart(
	proxyBase: string,
	chartUrl: string,
	signal?: AbortSignal,
): Promise<ArrayBuffer> {
	const src = new URL(chartUrl);
	const params = new URLSearchParams();
	for (const k of ['login', 'layer', 'echeance']) {
		const v = src.searchParams.get(k);
		if (!v) {
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			throw new SofiaError({ code: 'malformed', detail: `chart link missing ${k}` });
		}
		params.set(k, v);
	}
	const timeout = AbortSignal.timeout(CHART_TIMEOUT_MS);
	let buf: ArrayBuffer;
	try {
		const res = await fetch(`${proxyBase}/sofia/chart?${params}`, {
			signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
		});
		if (!res.ok) {
			throw new SofiaError(chartHttpFailure(res, await res.text()));
		}
		buf = await res.arrayBuffer();
	} catch (e) {
		if (e instanceof SofiaError) {
			throw e;
		}
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new SofiaError(fetchFailure(e, proxyBase, 'chart download'));
	}
	const magic = new Uint8Array(buf.slice(0, 4));
	// %PDF: an expired token answers 200 with an HTML page.
	if (magic[0] !== 0x25 || magic[1] !== 0x50 || magic[2] !== 0x44 || magic[3] !== 0x46) {
		throw new SofiaError(notPdfFailure());
	}
	return buf;
}

/** downloadChart, retried once after a pause when the failure is worth it
 *  (a transport failure; never a spent link, a busy proxy or a cancel). */
export async function downloadChartRetrying(
	proxyBase: string,
	chartUrl: string,
	signal?: AbortSignal,
): Promise<ArrayBuffer> {
	for (let attempt = 0; ; attempt++) {
		if (attempt > 0) {
			await pause(RETRY_PAUSE_MS, signal);
		}
		try {
			return await downloadChart(proxyBase, chartUrl, signal);
		} catch (e) {
			if (!(e instanceof SofiaError) || signal?.aborted || attempt >= retryBudget(e.failure.code)) {
				throw e;
			}
		}
	}
}

export interface ChartRasterizer {
	render(data: ArrayBuffer): Promise<{ pngDataUrl: string; wPx: number; hPx: number }>;
	destroy(): void;
}

/** pdf.js, loaded on demand (the export/pdf.ts dynamic-import pattern) with
 *  ONE shared PDFWorker for the whole pack; each document is destroyed after
 *  its page renders. Every chart rasterizes LANDSCAPE, filling its A4
 *  landscape sheet: the default rotation honours the TEMSI /Rotate 90, and a
 *  portrait source (WINTEM) is turned a further quarter anticlockwise, so
 *  the reader turns the printed page clockwise to read it. */
async function loadRasterizer(): Promise<ChartRasterizer> {
	const [pdfjs, workerUrl] = await Promise.all([
		import('pdfjs-dist'),
		import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
	]);
	pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;
	const worker = new pdfjs.PDFWorker();
	return {
		async render(data) {
			const task = pdfjs.getDocument({ data: new Uint8Array(data), worker });
			try {
				const doc = await task.promise;
				const page = await doc.getPage(1);
				// The page's own rotation applies by default; base tells the
				// natural orientation after it.
				const base = page.getViewport({ scale: 1 });
				const rotation =
					base.width >= base.height ? page.rotate : (page.rotate + 270) % 360;
				const turned = page.getViewport({ scale: 1, rotation });
				const scale = RASTER_LONG_SIDE_PX / Math.max(turned.width, turned.height);
				const viewport = page.getViewport({ scale, rotation });
				const canvas = document.createElement('canvas');
				canvas.width = Math.round(viewport.width);
				canvas.height = Math.round(viewport.height);
				await page.render({ canvas, viewport }).promise;
				return {
					pngDataUrl: canvas.toDataURL('image/png'),
					wPx: canvas.width,
					hPx: canvas.height,
				};
			} finally {
				// Frees the document; the externally owned shared worker survives.
				await task.destroy();
			}
		},
		destroy() {
			worker.destroy();
		},
	};
}

/** The PDF's identity, so one sheet served under two links prints once. */
async function digestOf(buf: ArrayBuffer): Promise<string> {
	const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
	return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface TripChartsInput {
	proxyBase: string;
	/** Per requested zone and product: its catalog, or null with the failure
	 *  that kept it from being listed (each one a catalogFailures line). */
	catalogs: readonly {
		zone: SofiaZone;
		product: SofiaChartProduct;
		charts: SofiaChart[] | null;
		failure: SofiaFailure | null;
	}[];
	windowStartMs: number;
	windowEndMs: number;
	altRangeFt: { minFt: number; maxFt: number } | null;
	/** The selection's present (tests); the clock otherwise. */
	nowMs?: number | undefined;
	/** The rasterizer factory (tests); pdf.js otherwise. */
	rasterizer?: (() => Promise<ChartRasterizer>) | undefined;
	/** Stops the download loop between picks and aborts the in-flight
	 *  download; the partial doc is returned (callers discard on cancel). */
	signal?: AbortSignal | undefined;
	/** Absolute download progress; `current` is the invariant chart token
	 *  (chartToken) while one is being fetched, null between charts. */
	onProgress?: ((done: number, total: number, current: string | null) => void) | undefined;
}

/** The selection over the catalogs as they stand, and the ones that could
 *  not be listed: the print's (fetchTripCharts) and the print menu's
 *  readiness line, one recipe, so the menu cannot promise what the paper
 *  will not carry. */
export function selectFromCatalogs(
	input: Pick<TripChartsInput, 'catalogs' | 'windowStartMs' | 'windowEndMs' | 'altRangeFt'> & {
		nowMs: number;
	},
): ChartSelection & { catalogFailures: TripCatalogFailure[] } {
	const ok = input.catalogs.filter((c) => c.charts != null);
	return {
		...selectTripCharts(
			ok.flatMap((c) => c.charts!),
			{
				windowStartMs: input.windowStartMs,
				windowEndMs: input.windowEndMs,
				altRangeFt: input.altRangeFt,
				nowMs: input.nowMs,
				expected: ok.map((c) => ({ product: c.product, zone: c.zone })),
			},
		),
		catalogFailures: input.catalogs.flatMap((c) =>
			c.failure ? [{ zone: c.zone, product: c.product, failure: c.failure }] : [],
		),
	};
}

/** Select, download and rasterize the flight-relevant charts. Never rejects:
 *  a failed chart lands in `failed` with why, a failed catalog in
 *  `catalogFailures`, and the sheets degrade to note lines. */
export async function fetchTripCharts(input: TripChartsInput): Promise<TripChartsDoc> {
	const { picks, notes, past, catalogFailures } = selectFromCatalogs({
		...input,
		nowMs: input.nowMs ?? Date.now(),
	});
	input.onProgress?.(0, picks.length, null);
	const entries: TripChartEntry[] = [];
	const failed: TripChartFailure[] = [];
	const seen = new Set<string>();
	let done = 0;
	let raster: ChartRasterizer | null = null;
	try {
		for (const [i, chart] of picks.entries()) {
			if (input.signal?.aborted) {
				break;
			}
			if (i > 0) {
				await pause(DOWNLOAD_PACE_MS);
			}
			input.onProgress?.(i, picks.length, chartToken(chart));
			try {
				const bytes = await downloadChartRetrying(input.proxyBase, chart.url, input.signal);
				// Hashed before pdf.js takes the buffer over.
				const digest = await digestOf(bytes);
				if (!seen.has(digest)) {
					seen.add(digest);
					raster ??= await (input.rasterizer ?? loadRasterizer)();
					const extrap = notes.find((n) => n.kind === 'extrapolated' && n.url === chart.url);
					entries.push({
						chart,
						...(await raster.render(bytes)),
						...(extrap && extrap.validAtMs != null
							? {
									extrapolated: {
										nextValidAtMs: extrap.validAtMs,
										publishAtMs: extrap.publishAtMs,
									},
								}
							: {}),
					});
				}
			} catch (e) {
				if (input.signal?.aborted) {
					break; // an aborted download is a cancel, not a failure
				}
				failed.push({
					chart,
					failure:
						e instanceof SofiaError
							? e.failure
							: {
									code: 'malformed',
									// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
									detail: `chart could not be drawn: ${e instanceof Error ? e.message : String(e)}`,
								},
				});
			}
			done++;
		}
	} finally {
		raster?.destroy();
	}
	input.onProgress?.(done, picks.length, null);
	return {
		fetchedAtMs: Date.now(),
		windowStartMs: input.windowStartMs,
		windowEndMs: input.windowEndMs,
		past: past ? { startMs: input.windowStartMs, dayOnly: false } : null,
		entries,
		notes,
		failed,
		catalogFailures,
	};
}
