/* The meteo annex's TEMSI / WINTEM prefetch recipe, shared by the dossier
 * pack print (FlightPrepModal.printPack) and the Weather tab's standalone
 * briefing print (WxPrintHost): the flight window off the dossier timeline
 * (falling back to the printed winds' own departure anchor + 2 h, so charts
 * and forecast winds agree on when the flight happens), the zones off the
 * French-FIR presence of the printed routes, the WINTEM altitude range off
 * their planned legs, and the catalogs through the state cache's single
 * SOFIA pacing authority. Callers gate on display.liveWeather and await the
 * airspace ensure first (a missing dataset degrades the zone pick to
 * FRANCE). Reads reactive state; never rejects. The annex's first sheets,
 * the DWD front charts, ride the same flight window (fetchFrontsForPrint,
 * frontIssues; docs/front-charts.md). */

import { fuelComputation, mbComputation, dossierComputation } from './shared';
import { computeDossierTimeline, parseClock, timelineWindowMin } from '$lib/aircraft/dossier';
import { dossierFlightDate, flightPrep, isPastFlightDate } from '$lib/state/flightPrep.svelte';
import { firstDepartureMs } from '$lib/state/routeWind.svelte';
import { floorHourMs } from '$lib/state/windAloft.svelte';
import { frenchFirPresence } from '$lib/route/airspaces';
import { getAirspaces } from '$lib/state/data.svelte';
import { display } from '$lib/state/display.svelte';
import { routeSettings, type Route } from '$lib/state/route.svelte';
import { proxyBase } from '$lib/autorouter/state.svelte';
import {
	catalogOf,
	sofiaChartsFor,
	staleSofiaCharts,
	type SofiaChartsEntry,
} from '$lib/state/sofiaCharts.svelte';
import type { PrintIssue } from '$lib/state/printProgress.svelte';
import { SOFIA_CHART_PRODUCTS, type SofiaChart, type SofiaZone } from '$lib/sofia/charts';
import {
	altRange,
	chartToken,
	chartZones,
	fetchTripCharts,
	selectFromCatalogs,
	type FlightPast,
	type TripCatalogFailure,
	type TripChartNote,
	type TripChartsDoc,
	type TripChartsInput,
} from '$lib/weather/tripCharts';
import {
	fetchFrontCharts,
	fetchFrontIndex,
	frontChartToken,
	type FrontChartsDoc,
} from '$lib/weather/frontCharts';

/** Fallback window length when the dossier timeline can't resolve. */
const DEFAULT_WINDOW_MIN = 120;

/** The dossier timeline's span, the ETD to the last with-wind arrival,
 *  alternates included: what the Overview prints. Null when it cannot
 *  resolve (no ETD stated, no trip the fuel plan can time). */
function timelineWindowMs(): { startMs: number; endMs: number } | null {
	const departureMin = parseClock(flightPrep.dossier.departureTime ?? '');
	if (departureMin == null) {
		return null;
	}
	const fuel = fuelComputation();
	const dossier = dossierComputation(fuel, mbComputation(fuel));
	if (dossier.trips.length === 0) {
		return null;
	}
	const win = timelineWindowMin(
		computeDossierTimeline(dossier.trips, {
			departureMin,
			fuelOnBoardMin: dossier.fuelOnBoardMin,
			finalReserveMin: dossier.finalReserveMin,
		}),
	);
	if (!win) {
		return null;
	}
	const base = Date.parse(dossierFlightDate() + 'T00:00:00Z');
	return { startMs: base + win.startMin * 60_000, endMs: base + win.endMin * 60_000 };
}

/** The flight window for chart selection: the dossier timeline when it
 *  resolves, else the departure anchor + 2 h, never from before the current
 *  hour: a flight being recorded is anchored at its takeoff, and a dossier
 *  printed two hours into it asked for charts wholly in the past, which the
 *  catalog no longer lists. */
export function chartWindowMs(): { startMs: number; endMs: number } {
	const timeline = timelineWindowMs();
	if (timeline) {
		return timeline;
	}
	const start = Math.max(firstDepartureMs(), floorHourMs(Date.now()));
	return { startMs: start, endMs: start + DEFAULT_WINDOW_MIN * 60_000 };
}

/** Is the flight the dossier plans already behind us? Its stated date is
 *  before `nowMs`'s day (UTC), or its timeline has landed, alternates
 *  included. Every print of it then answers for a flight already flown (the
 *  forecast winds, the sun, the night reserve, the charts), so both print
 *  hosts hold on it and ask SOFIA for nothing. A date alone with no ETD is
 *  past only once its day is: the flight is somewhere in that day. Reads the
 *  fleet through the timeline, so a host asks after its datasets; before
 *  them, the date alone answers. */
export function pastFlight(nowMs: number = Date.now()): FlightPast | null {
	const date = flightPrep.dossier.flightDate;
	if (date != null && isPastFlightDate(date, nowMs)) {
		const dayMs = Date.parse(`${date}T00:00:00Z`);
		if (!Number.isFinite(dayMs)) {
			return null;
		}
		const clock = parseClock(flightPrep.dossier.departureTime ?? '');
		return clock != null
			? { startMs: dayMs + clock * 60_000, dayOnly: false }
			: { startMs: dayMs, dayOnly: true };
	}
	const timeline = timelineWindowMs();
	return timeline && timeline.endMs <= nowMs ? { startMs: timeline.startMs, dayOnly: false } : null;
}

/** The annex of a print whose flight is behind us: no chart, the reason
 *  once on the notes sheet. */
export function pastChartsDoc(past: FlightPast): TripChartsDoc {
	return {
		fetchedAtMs: Date.now(),
		windowStartMs: past.startMs,
		windowEndMs: past.startMs,
		past,
		entries: [],
		notes: [],
		failed: [],
		catalogFailures: [],
	};
}

/** The chart zones the printed routes need (FRANCE when the airspace dataset
 *  is not there yet to say otherwise). */
export function chartZonesFor(printableRoutes: readonly Route[]): SofiaZone[] {
	const wpsList = printableRoutes.map((r) => r.waypoints);
	return chartZones(frenchFirPresence(wpsList, getAirspaces()), wpsList);
}

/** What the annex is chosen for: the zones, the flight window and the planned
 *  altitude range. One recipe for the print and the print menu's readiness
 *  line, so the two cannot disagree. */
export interface ChartPlan {
	zones: SofiaZone[];
	startMs: number;
	endMs: number;
	altRangeFt: { minFt: number; maxFt: number } | null;
}

export function chartPlan(printableRoutes: readonly Route[]): ChartPlan {
	const { startMs, endMs } = chartWindowMs();
	return {
		zones: chartZonesFor(printableRoutes),
		startMs,
		endMs,
		altRangeFt: altRange(
			printableRoutes.map((r) =>
				r.waypoints
					.slice(0, -1)
					.map((w) => (Number.isFinite(w.alt) ? w.alt : routeSettings.defaultAltitudeFt)),
			),
		),
	};
}

/** Ask for the catalogs as a print starts, beside its dataset reads rather
 *  than after them: the print's own fetchChartsForPrint, under the same
 *  `runStartMs`, then joins the request in flight (sofiaChartsFor). The zones
 *  are those known now (FRANCE until the airspaces say otherwise); a zone
 *  the airspaces add later is fetched then. Never aborted by the print's
 *  Cancel: the cache is shared and the work is bounded. */
export function startChartCatalogs(printableRoutes: readonly Route[], runStartMs: number): void {
	if (!display.liveWeather) {
		return;
	}
	void sofiaChartsFor(chartZonesFor(printableRoutes), { runStartMs });
}

/** The print-progress issues a chart annex raises: one per catalog that
 *  could not be listed, one per product the flight is left without a usable
 *  chart for (the notes that hold), and one per chart that could not be
 *  rendered. Shared by both print hosts, so the two cannot word a
 *  degradation differently. The notes that do not hold (the end of the
 *  flight's chart not out yet, an extrapolated chart) raise none: they print,
 *  and the print menu says them before the click. */
export function chartIssues(doc: TripChartsDoc): PrintIssue[] {
	const issues: PrintIssue[] = doc.past ? [{ code: 'flight-past', ...doc.past }] : [];
	for (const f of doc.catalogFailures) {
		issues.push({ code: 'charts-catalog', product: f.product, zone: f.zone, failure: f.failure });
	}
	for (const n of doc.notes) {
		if (!n.holds) {
			continue;
		}
		if (n.kind === 'undated') {
			issues.push({ code: 'charts-undated', product: n.product, zone: n.zone });
		} else if (n.kind === 'not-yet-published' || n.kind === 'missing' || n.kind === 'none') {
			issues.push({
				code: 'charts-missing',
				product: n.product,
				zone: n.zone,
				level: n.level,
				kind: n.kind,
				validAtMs: n.validAtMs,
				publishAtMs: n.publishAtMs,
			});
		}
	}
	for (const f of doc.failed) {
		issues.push({
			code: 'charts-failed',
			chart: chartToken(f.chart),
			validAtMs: f.chart.validAtMs,
			failure: f.failure,
		});
	}
	return issues;
}

/** Each zone's two catalogs as a print may use them (catalogOf); a zone with
 *  no entry contributes nothing. */
function zoneCatalogs(
	zones: readonly SofiaZone[],
	entries: Readonly<Partial<Record<string, SofiaChartsEntry>>>,
): TripChartsInput['catalogs'] {
	return zones.flatMap((zone) => {
		const e = entries[zone];
		return e ? SOFIA_CHART_PRODUCTS.map((product) => ({ zone, product, ...catalogOf(e, product) })) : [];
	});
}

/** What the dossier's annex would be if printed now, for the print menu's
 *  readiness line: the flight already flown, the catalogs still being
 *  asked, or the print's own selection over them as they stand (the charts,
 *  the notes, the catalogs that could not be listed). */
export type ChartsReadiness =
	| { kind: 'past'; past: FlightPast }
	| { kind: 'checking' }
	| {
			kind: 'ready';
			picks: SofiaChart[];
			notes: TripChartNote[];
			catalogFailures: TripCatalogFailure[];
	  };

export function chartsReadiness(
	plan: ChartPlan,
	entries: Readonly<Partial<Record<string, SofiaChartsEntry>>>,
	nowMs: number,
	past: FlightPast | null,
): ChartsReadiness {
	if (past) {
		return { kind: 'past', past };
	}
	if (plan.zones.some((zone) => !entries[zone] || entries[zone].status === 'loading')) {
		return { kind: 'checking' };
	}
	const sel = selectFromCatalogs({
		catalogs: zoneCatalogs(plan.zones, entries),
		windowStartMs: plan.startMs,
		windowEndMs: plan.endMs,
		altRangeFt: plan.altRangeFt,
		nowMs,
	});
	if (sel.past) {
		return { kind: 'past', past: { startMs: plan.startMs, dayOnly: false } };
	}
	return { kind: 'ready', picks: sel.picks, notes: sel.notes, catalogFailures: sel.catalogFailures };
}

/** Fetch and rasterize the charts relevant to the printed routes' flight.
 *  `runStartMs` is the print run's start: catalogs older than the run are
 *  asked again (sofiaChartsFor). `signal` stops the per-chart download loop
 *  (the catalog fetch itself is never aborted: sofiaChartsFor is the single
 *  SOFIA pacing authority); `onProgress` relays the download counter +
 *  current chart token. */
export async function fetchChartsForPrint(
	printableRoutes: Route[],
	opts: {
		runStartMs: number;
		signal?: AbortSignal;
		onProgress?: (done: number, total: number, current: string | null) => void;
	},
): Promise<TripChartsDoc> {
	const plan = chartPlan(printableRoutes);
	const entries = await sofiaChartsFor(plan.zones, { runStartMs: opts.runStartMs });
	if (opts.signal?.aborted) {
		return {
			fetchedAtMs: Date.now(),
			windowStartMs: plan.startMs,
			windowEndMs: plan.endMs,
			past: null,
			entries: [],
			notes: [],
			failed: [],
			catalogFailures: [],
		};
	}
	const doc = await fetchTripCharts({
		proxyBase: proxyBase(),
		catalogs: zoneCatalogs(plan.zones, entries),
		windowStartMs: plan.startMs,
		windowEndMs: plan.endMs,
		altRangeFt: plan.altRangeFt,
		...(opts.signal ? { signal: opts.signal } : {}),
		...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
	});
	// A spent chart link: the next print asks its zone's catalog again, for
	// links that serve (the cache would otherwise hand the same ones back).
	for (const f of doc.failed) {
		if (f.failure.code === 'expired') {
			staleSofiaCharts(f.chart.zone);
		}
	}
	return doc;
}

/** The DWD front charts for the print (weather/frontCharts.ts,
 *  docs/front-charts.md): an index of the print's own, current to the click
 *  (the Weather tab's cache is the tab's and keeps a quarter of an hour),
 *  then the selection over the flight window the TEMSI / WINTEM annex is
 *  chosen for, so both halves of the annex answer for the same flight. The
 *  forecasts print only while no TEMSI serves the flight's start: the TEMSI
 *  catalogs are read beside the index, through the TEMSI half's own request
 *  (sofiaChartsFor joins it, under the same `runStartMs`), and the print's own
 *  selection says whether one does; a catalog that cannot be listed leaves
 *  the forecasts in. The analysis prints whatever the TEMSI. `signal` stops
 *  the downloads; never rejects. Callers gate on display.liveWeather, await
 *  the airspaces first (the zone pick) and ask nothing for a flight already
 *  flown. */
export async function fetchFrontsForPrint(
	printableRoutes: Route[],
	opts: {
		runStartMs: number;
		signal?: AbortSignal;
		onProgress?: (done: number, total: number, current: string | null) => void;
	},
): Promise<FrontChartsDoc> {
	const plan = chartPlan(printableRoutes);
	const base = proxyBase();
	const [index, entries] = await Promise.all([
		fetchFrontIndex(base, opts.signal),
		sofiaChartsFor(plan.zones, { runStartMs: opts.runStartMs }),
	]);
	if (opts.signal?.aborted) {
		return {
			fetchedAtMs: Date.now(),
			windowStartMs: plan.startMs,
			windowEndMs: plan.endMs,
			entries: [],
			notes: [],
			failed: [],
		};
	}
	const temsi = selectFromCatalogs({
		catalogs: zoneCatalogs(plan.zones, entries),
		windowStartMs: plan.startMs,
		windowEndMs: plan.endMs,
		altRangeFt: plan.altRangeFt,
		nowMs: Date.now(),
	});
	return fetchFrontCharts({
		proxyBase: base,
		index,
		windowStartMs: plan.startMs,
		windowEndMs: plan.endMs,
		forecasts: !temsi.temsiAtStart,
		...(opts.signal ? { signal: opts.signal } : {}),
		...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
	});
}

/** The print-progress issues the front charts raise, the chartIssues rule:
 *  one per half of the source that could not be had, one when the flight is
 *  left without a chart near it, one per chart not retrieved. The notes that
 *  do not hold (a forecast left out undated, an old situation) print and
 *  raise none. */
export function frontIssues(doc: FrontChartsDoc): PrintIssue[] {
	const issues: PrintIssue[] = [];
	for (const n of doc.notes) {
		if (!n.holds) {
			continue;
		}
		if ((n.kind === 'analyses-unavailable' || n.kind === 'forecasts-unavailable') && n.failure) {
			issues.push({
				code: 'fronts-unavailable',
				half: n.kind === 'analyses-unavailable' ? 'analyses' : 'forecasts',
				failure: n.failure,
			});
		} else if (n.kind === 'none-near' || n.kind === 'beyond') {
			issues.push({ code: 'fronts-missing', kind: n.kind, validAtMs: n.validAtMs });
		}
	}
	for (const f of doc.failed) {
		issues.push({
			code: 'fronts-failed',
			chart: frontChartToken(f.chart),
			validAtMs: f.chart.validAtMs,
			failure: f.failure,
		});
	}
	return issues;
}
