<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	/* The flight-preparation print document, printed by the two packs and
	 * the route profiles' print (PackPrintHost), mounted only while printing
	 * (the nav-log kneeboard pattern): hidden on screen, shown by the print
	 * rules under html.flight-prep-doc, which also hide every surface box.
	 * One A4 landscape job for every sheet. Chromium honours page orientation
	 * only from the default @page, so a single job cannot mix orientations:
	 * the portrait-designed Fuel page prints in a portrait-width column and
	 * M&B lays its loads column beside the CG envelope (the browser's own
	 * print of the page keeps their true portrait sheets). 'prep' is the four
	 * pages.
	 * 'dossier' adds per trip the nav logs and schedules as two A5 cards per
	 * sheet (the trip beside its alternate, the kneeboard geometry via the
	 * cards' `kneeboard` prop, a log or schedule outgrowing one card
	 * continuing on numbered measured part cards) and each route's
	 * full-extent vertical profile, the alternate's too, then the NOTAM
	 * bulletin as the NOTAMs tab lists it (two A5 columns per sheet on the
	 * kneeboard's margins), then closes with the meteo annex: the trip-chain
	 * METAR / TAF cards (two A5 panels per sheet like the nav logs), the DWD
	 * front charts (the situation and the charts for the flight) and the
	 * flight-relevant TEMSI and WINTEM charts, one full landscape sheet each
	 * (a portrait WINTEM is turned a quarter at raster time), all computed
	 * off data the trigger prefetched so the snapshot renders synchronously.
	 * 'wx' is that meteo annex alone, for the Weather tab's standalone
	 * briefing print (WxPrintHost). 'profiles' is every route's profile sheet
	 * alone, the dossier's own, for the route profile's printer. */

	import { printedAirspaceBands } from '$lib/route/airspaceFilter';
	import { profileAirspaceGroups } from '$lib/state/profileAirspaceFilter.svelte';
	import { cachedAirspaceSchedule } from '$lib/state/navlogSchedule';
	import { routeTerrainSamples } from '$lib/state/routeTerrain.svelte';
	import { briefingActivityUnknown, briefingVerdictNow } from '$lib/state/briefing.svelte';
	import { briefingShortTag } from '../briefingText';
	import { routeEndpointsLabel } from '$lib/state/routeNotamFetch';
	import { buildContactSpans, contactStretches as foldContactStretches } from '$lib/route/airspaces';
	import { resolveScheduleRadios } from '$lib/state/scheduleRadios.svelte';
	import { contactLines, zoneLabel } from '$lib/format/radio';
	import { routeNavlogLineCounts } from '$lib/state/navlogEnroute';
	import DossierPage from './DossierPage.svelte';
	import FuelPlanPage from './FuelPlanPage.svelte';
	import MassBalancePage from './MassBalancePage.svelte';
	import PerformancePage from './PerformancePage.svelte';
	import NavLogSheet from '../NavLogSheet.svelte';
	import NavLogSchedule from '../NavLogSchedule.svelte';
	import NotamPrintDoc from '../NotamPrintDoc.svelte';
	import {
		cardKey,
		estimatorCardChunks,
		expandCards,
		pairCards,
		type RouteCard,
	} from '../navlogCards';
	import RouteProfile from '../RouteProfile.svelte';
	import { oeiRouteCeilingsFt } from './oeiRoute';
	import PlotTitleLine from '../PlotTitleLine.svelte';
	import CrossingsStrip from '../CrossingsStrip.svelte';
	import {
		effectiveClimbGradFtPerNM,
		effectiveCruiseSpeedKt,
		effectiveDescentGradFtPerNM,
		selectedAircraft,
	} from '$lib/state/aircraft.svelte';
	import {
		effectiveRouteWinds,
		routeCloudCover,
		routeFreezingLevelsFt,
		routeWindEteMin,
	} from '$lib/state/routeWind.svelte';
	import { routeSettings, type Route } from '$lib/state/route.svelte';
	import { effectiveTransitionAltFt } from '$lib/state/transitionAlt.svelte';
	import { getAirspaces, getObstacles, dataState, airportByIdent } from '$lib/state/data.svelte';
	import { orderedTrips, orphanAlternates } from '$lib/aircraft/trips';
	import { routeTitle } from '$lib/route/routeLabel';
	import {
		bandCrossings,
		buildRouteProfileDoc,
		terrainFtNear,
		type RouteProfileDocData,
		type BandCrossing,
		type ContactStretchView,
		type PlacedBand,
	} from '$lib/route/routeProfile';
	import { profileObstacleMarks, type ObstacleMark } from '$lib/route/minAltitude';
	import { notamObstacleMarks, type NotamObstacleMark, type PlacedNotamBand } from '$lib/route/notamProfile';
	import {
		activeEvalWindow,
		briefingLoaded,
		rawNotamsDuring,
		visibleNotams,
		type IndexedNotam,
	} from '$lib/state/notam.svelte';
	import { activatedAirspaceLinksRaw } from '$lib/state/notamLinks.svelte';
	import { bandHatch } from '$lib/components/profileBand';
	import { routeNotamBands, routeSupBands, routeZsmBands } from '$lib/state/routeCrossings.svelte';
	import { planScope } from '$lib/state/planScope.svelte';
	import { bandStates, crossingClock, crossingRanges } from '$lib/state/activity.svelte';
	import type { PlacedSupBand } from '$lib/route/supProfile';
	import type { PlacedZsmBand } from '$lib/route/zsmProfile';
	import { airspaceGroupShown } from '$lib/data/airspaces';
	import type { ActivityAnswer } from '$lib/data/activity';
	import { sampleCeilingFt, type TerrainSample } from '$lib/map/terrain';
	import {
		formatAge,
		formatDistanceNM,
		metarAgeMin,
		metarFreshness,
		tafBlockText,
	} from '$lib/weather/metar';
	import { packWxPanels, type TripWxDoc, type TripWxEntry } from '$lib/weather/tripWx';
	import { chartToken, type TripChartEntry, type TripChartsDoc } from '$lib/weather/tripCharts';
	import { runToken, type FrontChartEntry, type FrontChartsDoc } from '$lib/weather/frontCharts';
	import { chartCatalogText, chartFailedText, chartNoteText, flightPastText } from './chartsText';
	import { pastFlightNow } from './chartsPrefetch';
	import { frontChartLabel, frontNoteLines } from './frontsText';
	import { formatActivationSpan, formatZulu } from '$lib/format/datetime';

	interface Props {
		/** 'prep' = the four pages; 'dossier' adds the per-route sheets;
		 *  'wx' = the meteo annex alone (METAR / TAF + charts). */
		mode: 'prep' | 'dossier' | 'wx' | 'profiles';
		/** Routes with >= 2 waypoints, in routes.list order. */
		printableRoutes: Route[];
		/** Per-route MSA (route.id -> per-leg ft), prefetched; a failed
		 *  computation passes nulls so the sheet never self-fetches mid-print. */
		msaByRoute: Record<string, (number | null)[]>;
		/** Per-route terrain samples, prefetched; [] when the fetch failed. */
		terrainByRoute: Record<string, TerrainSample[]>;
		/** The min-alt corridor's ground envelope per route, the series the
		 *  profile fills (the screen's own). */
		groundFillByRoute: Record<string, TerrainSample[]>;
		/** Trip-chain weather snapshot for the dossier's closing sheet,
		 *  prefetched; null = live weather off (the sheet is skipped). */
		tripWx: TripWxDoc | null;
		/** Flight-relevant TEMSI / WINTEM charts, prefetched and rasterized;
		 *  null = live weather off. Nothing prints when it holds neither
		 *  entries nor notes (no chart covers the flight period). */
		tripCharts: TripChartsDoc | null;
		/** The DWD front charts that open the chart annex, prefetched
		 *  (weather/frontCharts.ts); null = live weather off or a flight
		 *  already flown. Nothing prints when it holds neither entries nor
		 *  notes. */
		frontCharts?: FrontChartsDoc | null;
		/** Per-route MEASURED nav-log card splits, prefetched by the dossier
		 *  prep (PackPrintHost, via navlogMeasure); a missing route falls
		 *  back to the line-cost estimator. Unused in prep / wx modes. */
		measuredChunks?: Record<string, { from: number; to: number }[]>;
		/** Measured minWaypoints per route: blank pad rows capped to fit. */
		measuredPad?: Record<string, number>;
		/** Measured per-part minWaypoints for split logs (one per card). */
		measuredPartPads?: Record<string, number[]>;
		/** Per-route MEASURED schedule card splits, same prep; a missing
		 *  route keeps its schedule on one card (no estimator exists). */
		schedMeasured?: Record<string, { from: number; to: number }[]>;
		/** The M&B sheets' MEASURED pairing (mbMeasure.ts), each entry the
		 *  trips one landscape sheet holds; null: every trip on its own. */
		mbBlocks?: number[][] | null | undefined;
		/** Five trips or more: the fuel page takes the whole sheet's width. */
		wideFuel?: boolean | undefined;
	}
	let {
		mode,
		printableRoutes,
		msaByRoute,
		terrainByRoute,
		groundFillByRoute,
		tripWx,
		tripCharts,
		frontCharts = null,
		measuredChunks = {},
		measuredPad = {},
		measuredPartPads = {},
		schedMeasured = {},
		mbBlocks = null,
		wideFuel = false,
	}: Props = $props();

	const aircraft = $derived(selectedAircraft());

	// One card group per trip: the trip's route beside its alternate (the
	// fuel plan's pairing, run over the printable subset). Orphan alternates
	// follow as lone cards so no printable route silently drops out; only
	// trips get a profile sheet. A nav log outgrowing one A5 card expands
	// into numbered continuation cards (the prep's MEASURED splits, the
	// line-cost estimator as fallback; a fitting trip stays one card beside
	// its alternate as before), the parts flowing in order through the
	// two-per-sheet card flex; schedules expand the same way off their own
	// measured splits (single-card only when no measure landed), so a trip's
	// lone schedule still prints beside its alternate's.
	interface NavGroup {
		key: string;
		/** Nav-log cards through the chunker, paired two per sheet. */
		cardPairs: RouteCard<Route>[][];
		/** Schedule cards through the measured split, paired the same way. */
		schedPairs: RouteCard<Route>[][];
		/** The group's routes, each printing its profile sheet after the
		 *  cards: the trip and its alternate, or an orphan alternate. */
		profiled: Route[];
	}
	function routeCards(r: Route): RouteCard<Route>[] {
		// The prep's MEASURED split when it landed; else the shared line-cost
		// estimate (estimatorCardChunks, the nav-log modal's own fallback, so
		// the two flows price banners identically).
		return expandCards(
			r,
			measuredChunks[r.id] ??
				estimatorCardChunks(r.waypoints, routeNavlogLineCounts(r), {
					enrouteFreqs: routeSettings.enrouteFreqsInNavlog,
					vorRadials: routeSettings.vorRadialsInNavlog,
				}),
			measuredPartPads[r.id],
		);
	}
	function schedCards(r: Route): RouteCard<Route>[] {
		// The prep's MEASURED schedule split; no measure = one card, the
		// previous behavior (no estimator exists for schedules).
		return expandCards(r, schedMeasured[r.id] ?? []);
	}
	const navGroups = $derived.by((): NavGroup[] => {
		if (mode !== 'dossier') {
			return [];
		}
		const groups: NavGroup[] = orderedTrips(printableRoutes).map((t) => {
			const rs = t.alternate ? [t.route, t.alternate] : [t.route];
			return {
				key: t.route.id,
				cardPairs: pairCards(rs.flatMap(routeCards)),
				schedPairs: pairCards(rs.flatMap(schedCards)),
				profiled: rs,
			};
		});
		for (const o of orphanAlternates(printableRoutes)) {
			groups.push({
				key: o.id,
				cardPairs: pairCards(routeCards(o)),
				schedPairs: pairCards(schedCards(o)),
				profiled: [o],
			});
		}
		return groups;
	});

	/** The routes that print a profile sheet, in the order flown: each trip,
	 *  its alternate, then an orphan alternate. */
	const profileRoutes = $derived.by((): Route[] => {
		if (mode === 'profiles') {
			return [
				...orderedTrips(printableRoutes).flatMap((t) => (t.alternate ? [t.route, t.alternate] : [t.route])),
				...orphanAlternates(printableRoutes),
			];
		}
		return navGroups.flatMap((g) => g.profiled);
	});

	/** The weather annex prints in the dossier and the briefing alone: the
	 *  host keeps its last snapshot between runs. */
	const annex = $derived(mode === 'dossier' || mode === 'wx');

	// The weather entries packed into A5 card panels, two per landscape
	// sheet (the nav-log kneeboard geometry), in trip order.
	const wxPairs = $derived.by((): TripWxEntry[][][] => {
		if (!annex || !tripWx) {
			return [];
		}
		const panels = packWxPanels(tripWx.entries);
		const pairs: TripWxEntry[][][] = [];
		for (let i = 0; i < panels.length; i += 2) {
			pairs.push(panels.slice(i, i + 2));
		}
		return pairs;
	});

	// The DWD front charts that open the chart annex: the situation (the
	// latest analysis) then the charts for the flight, one landscape sheet
	// each; what is said beside them (a half unavailable, the flight left
	// without a chart near it, a chart not retrieved) prints under the first
	// sheet's head, or on a sheet of its own when no chart prints.
	const frontEntries = $derived(annex && frontCharts ? frontCharts.entries : []);
	const frontNotes = $derived(annex && frontCharts ? frontNoteLines(frontCharts) : []);

	/** Sheet-head title: what kind of chart, in the pilot's words. */
	function frontTitle(e: FrontChartEntry): string {
		return e.chart.kind === 'analysis' ? t.weather.fronts.sheetAnalysis : t.weather.fronts.sheetForecast;
	}

	/** Its issue: when DWD produced an analysis, or a forecast's model run. */
	function frontIssue(e: FrontChartEntry): string {
		return e.chart.kind === 'analysis'
			? t.weather.fronts.produced(formatZulu(new Date(e.chart.issuedAtMs)))
			: (runToken(e.chart) ?? '');
	}

	// The chart annex: one full landscape sheet per chart, in selection order
	// (TEMSI then WINTEM); portrait sources were already turned a quarter at
	// raster time, so every image is landscape and fills its sheet.
	const chartEntries = $derived(annex && tripCharts ? tripCharts.entries : []);

	/** Sheet-head chart name from SOFIA's own invariant tokens. */
	function chartName(e: TripChartEntry): string {
		return chartToken(e.chart);
	}

	/** The caption over a TEMSI printed as the chart in force while the one
	 *  covering the flight's start is not out yet (Météo-France's rule). */
	function extrapolationCaption(e: TripChartEntry, fetchedAtMs: number): string | null {
		if (!e.extrapolated) {
			return null;
		}
		return chartNoteText(
			{
				product: e.chart.product,
				zone: e.chart.zone,
				level: null,
				kind: 'extrapolated',
				validAtMs: e.extrapolated.nextValidAtMs,
				publishAtMs: e.extrapolated.publishAtMs,
			},
			fetchedAtMs,
		);
	}

	// Degradation lines: why a product printed no chart or will want a later
	// one (not yet published, overdue, none listed, unreadable dates, the
	// flight already flown), each chart that could not be rendered, and each
	// catalog that could not be listed, with why. An extrapolated chart says
	// so on its own sheet. Empty when all is well, and the notes sheet is
	// skipped entirely.
	const chartNotes = $derived.by((): string[] => {
		if (!annex || !tripCharts) {
			return [];
		}
		const at = tripCharts.fetchedAtMs;
		const lines: string[] = [];
		if (tripCharts.past) {
			lines.push(flightPastText(tripCharts.past));
		}
		for (const n of tripCharts.notes) {
			if (n.kind !== 'extrapolated') {
				lines.push(chartNoteText(n, at));
			}
		}
		for (const f of tripCharts.failed) {
			lines.push(chartFailedText(chartToken(f.chart), f.chart.validAtMs, at));
		}
		for (const f of tripCharts.catalogFailures) {
			lines.push(chartCatalogText(f.product, f.zone, f.failure));
		}
		return lines;
	});

	// Full-extent profile data per route, off the prefetched terrain (the
	// vertical-profile modal's own recipe, so the printed chart is the
	// on-screen chart).
	const profiles = $derived.by(() => {
		const out: Record<string, RouteProfileDocData> = {};
		const airspaces = dataState.airspacesLoaded ? getAirspaces() : null;
		for (const r of profileRoutes) {
			out[r.id] = buildRouteProfileDoc({
				waypoints: r.waypoints,
				cruiseSpeedKt: effectiveCruiseSpeedKt(),
				airspaces,
				terrain: terrainByRoute[r.id] ?? [],
				groundFill: groundFillByRoute[r.id],
				airportElevFt: (ident) => airportByIdent(ident)?.elevFt ?? null,
				typeLabels: t.data.airspaceTypes,
				climbGradFtPerNM: effectiveClimbGradFtPerNM(),
				descentGradFtPerNM: effectiveDescentGradFtPerNM(),
			});
		}
		return out;
	});

	// The FIS sector in force per route, the route profile's own derivation
	// (RouteProfileModal's contactStretchMap). Paper must carry it or not
	// carry the sectors at all: they NEST, so a band per sector shows two
	// frequencies and answers neither, and the printed chart is the one the
	// pilot reads with no way to hover it (docs/route-profile.md "The sector
	// in force"). Terrain comes from `routeTerrainSamples` and not from the
	// prefetched `terrainByRoute`, so the tuple is the one the dossier's own
	// schedule cards already walked and this is a memo hit.
	const contactStretchesByRoute = $derived.by(() => {
		const out: Record<string, Map<string, ContactStretchView>> = {};
		const airspaces = dataState.airspacesLoaded ? getAirspaces() : null;
		if (!profileAirspaceGroups.siv || !airspaces) {
			return out;
		}
		for (const r of profileRoutes) {
			const doc = profiles[r.id];
			if (!doc) {
				continue;
			}
			const spans = buildContactSpans(
				resolveScheduleRadios(
					cachedAirspaceSchedule(
						r.waypoints,
						airspaces,
						effectiveCruiseSpeedKt(),
						routeSettings.defaultAltitudeFt,
						routeTerrainSamples(r.id, r.waypoints),
					),
					airspaces,
				),
				!routeSettings.vfr,
			);
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived output, rebuilt whole
			const m = new Map<string, ContactStretchView>();
			for (const st of foldContactStretches(spans, doc.totalNM)) {
				const span = spans.find((sp) => sp.ev.key === st.key);
				if (!span || span.ev.category !== 'siv') {
					continue;
				}
				const line = contactLines(span.ev.radio, 'airspace', zoneLabel(span.ev.type, span.ev.name))[0];
				const entry = m.get(st.key) ?? {
					spans: [],
					line: line ? `${line.label} ${line.freq}` : '',
				};
				entry.spans.push({ fromNM: st.fromNM, toNM: st.toNM });
				m.set(st.key, entry);
			}
			if (m.size > 0) {
				out[r.id] = m;
			}
		}
		return out;
	});

	// Corridor obstacles per route, unconditional like winds / clouds (the
	// dossier pack awaits ensureObstacles() for the MSA column, so the
	// dataset is loaded by print time; missing data degrades to no marks).
	// Same locale-aware tooltip as the vertical-profile modal.
	function obstacleTip(m: ObstacleMark): string {
		const typeLabel = t.data.obstacleTypes[m.type];
		const head = m.name && m.name !== typeLabel ? `${typeLabel} ${m.name}` : typeLabel;
		// i18n-ignore-start: ICAO abbreviations + units (ft AMSL / AGL, LGTD), locale-invariant
		const agl = m.hgt != null ? ` (${Math.round(m.hgt)} ft AGL)` : '';
		return `${head}\n${Math.round(m.topFt)} ft AMSL${agl}${m.lit ? '\nLGTD' : ''}`;
		// i18n-ignore-end
	}
	const obstaclesByRoute = $derived.by(() => {
		const out: Record<string, (ObstacleMark & { tip: string })[]> = {};
		void dataState.obstaclesLoaded;
		const obs = getObstacles();
		if (!obs) {
			return out;
		}
		for (const r of profileRoutes) {
			const p = profiles[r.id];
			if (!p) {
				continue;
			}
			out[r.id] = profileObstacleMarks(
				r.waypoints,
				p.wpPoints.map((w) => w.distNM),
				obs,
				routeSettings.minAltCorridorRadiusNM,
			).map((m) => ({ ...m, tip: obstacleTip(m) }));
		}
		return out;
	});

	// NOTAM bands + activation hatch per route, unconditional like winds /
	// clouds: the dossier is a flight document, so the chart prints what the
	// modal draws under the current filters (incl. the viewing period). The
	// crossings strip and its NO-GO are the modal's verdicts, read over the
	// RAW briefing and the planned flight's window.
	// Each route's NOTAM bands over `items` (state/routeCrossings.svelte.ts,
	// the profile's recipe), on the prefetched terrain.
	function placedNotamBands(items: IndexedNotam[]): Record<string, PlacedNotamBand[]> {
		const out: Record<string, PlacedNotamBand[]> = {};
		for (const r of profileRoutes) {
			const bands = routeNotamBands(r.waypoints, items, terrainByRoute[r.id] ?? []);
			if (bands) {
				out[r.id] = bands;
			}
		}
		return out;
	}
	/* A flight already flown reads its own dated span (chartsPrefetch.ts
	   pastFlightNow): the strip and its NO-GO rescue read it, as the NOTAM
	   annex does, and the sheets' briefing tags and the annex's verdict go. */
	const past = $derived(pastFlightNow() !== null);
	const verdictWindow = $derived(
		(past ? planScope.flight?.window() : planScope.flight?.briefingWindow()) ?? activeEvalWindow(),
	);
	const notamBandsByRoute = $derived(placedNotamBands(visibleNotams()));
	const crossingNotamBandsByRoute = $derived(placedNotamBands(rawNotamsDuring(verdictWindow)));
	// The supplements' zones each route crosses (route/supProfile.ts), from
	// those in force over a range: the chart's over the viewing period, the
	// strip's over the verdict window, as on screen.
	function placedSupBands(from: number, to: number): Record<string, PlacedSupBand[]> {
		const out: Record<string, PlacedSupBand[]> = {};
		for (const r of profileRoutes) {
			const bands = routeSupBands(r.waypoints, from, to, terrainByRoute[r.id] ?? []);
			if (bands) {
				out[r.id] = bands;
			}
		}
		return out;
	}
	const supBandsByRoute = $derived.by(() => {
		const { from, to } = activeEvalWindow();
		return placedSupBands(from, to);
	});
	const crossingSupBandsByRoute = $derived(placedSupBands(verdictWindow.from, verdictWindow.to));
	// The raptor zones each route crosses (route/zsmProfile.ts), the chart's
	// and the strip's as the supplements'. Paper draws every one, no row
	// naming them and the level band staying off paper.
	function placedZsmBands(from: number, to: number): Record<string, PlacedZsmBand[]> {
		const out: Record<string, PlacedZsmBand[]> = {};
		for (const r of profileRoutes) {
			const bands = routeZsmBands(r.waypoints, from, to, terrainByRoute[r.id] ?? []);
			if (bands) {
				out[r.id] = bands;
			}
		}
		return out;
	}
	const zsmBandsByRoute = $derived.by(() => {
		const { from, to } = activeEvalWindow();
		return placedZsmBands(from, to);
	});
	const crossingZsmBandsByRoute = $derived(placedZsmBands(verdictWindow.from, verdictWindow.to));
	/** A route's supplement bands on paper: the pilot's rows, every NO-GO
	 *  crossing kept, the level band staying off paper as for airspace. */
	function printedSupBands(r: Route, crossings: BandCrossing[]): PlacedSupBand[] {
		const forbidden = crossings.filter((c) => c.forbidden).map((c) => c.key);
		return (supBandsByRoute[r.id] ?? []).filter(
			(b) => forbidden.includes(b.key) || airspaceGroupShown(b, profileAirspaceGroups),
		);
	}
	// Temporary obstacles from obstacle NOTAMs, per route (the modal's recipe).
	const notamObstaclesByRoute = $derived.by(() => {
		const out: Record<string, (NotamObstacleMark & { tip: string })[]> = {};
		for (const r of profileRoutes) {
			const p = profiles[r.id];
			if (!p) {
				continue;
			}
			const terrain = terrainByRoute[r.id] ?? [];
			const marks = notamObstacleMarks(
				r.waypoints,
				p.wpPoints.map((w) => w.distNM),
				visibleNotams(),
				routeSettings.minAltCorridorRadiusNM,
				(d) => terrainFtNear(terrain, d, sampleCeilingFt),
			);
			if (marks.length === 0) {
				continue;
			}
			// i18n-ignore-start: NOTAM id + ICAO abbreviations and units, locale-invariant
			out[r.id] = marks.map((m) => ({
				...m,
				tip: `NOTAM ${m.notamId}\n${Math.round(m.topFt)} ft AMSL${
					m.hgtFt != null ? ` (${Math.round(m.hgtFt)} ft AGL)` : ''
				}`,
			}));
			// i18n-ignore-end
		}
		return out;
	});

	/* Which airspace bands the paper carries. The dossier prints every
	 * overlay LAYER unconditionally, and that rule stands. But the airspace
	 * filter ROWS are a different axis, and two of them ship OFF. Once the
	 * corridor walk stopped dropping aerial activity and the FIS sectors,
	 * printing "unconditionally" quietly meant printing seven bands the
	 * pilot never sees on screen and never asked for. Paper follows the
	 * rows, so the dossier shows the chart they planned with, and with them
	 * the rescue that answers them: a band the line penetrates whose crossing
	 * is forbidden prints whatever its row says, as it draws on screen.
	 *
	 * The toolbar level band is the interactive chart's zoom affordance and
	 * stays off paper, which prints the whole plan at its own fitted scale.
	 */
	function printedBands(p: RouteProfileDocData, activeKeys: ReadonlySet<string>): PlacedBand[] {
		return printedAirspaceBands(p.placedBands, p.altitudePath.vertices, {
			groups: profileAirspaceGroups,
			vfr: routeSettings.vfr,
			activeKeys,
		});
	}

	// The raw activation join over the verdict window, which the hatch's
	// lines name their NOTAMs from (profileBand.ts bandHatch).
	const activationLinks = $derived(activatedAirspaceLinksRaw({ from: verdictWindow.from, to: verdictWindow.to }));

	// Each zone's state as the alerts read it (state/activity.svelte.ts
	// bandStates), each crossing at its planned time where the plan states
	// its times, else over the verdict window: a flight already flown reads
	// its zones as briefed over its dated span, the record.
	function routeStates(r: Route, p: RouteProfileDocData): Map<string, ActivityAnswer> {
		const bands = crossingBandsOf(r, p);
		const clock = past ? null : crossingClock(r);
		return bandStates(
			bands,
			{ fromMs: verdictWindow.from, toMs: verdictWindow.to },
			past ? null : briefingActivityUnknown(routeEndpointsLabel(r)),
			clock ? crossingRanges(bands, clock) : null,
		);
	}

	/** Every band a route's strip judges: its airspace bands and the NOTAM,
	 *  supplement and raptor zone bands of the verdict window. */
	function crossingBandsOf(r: Route, p: RouteProfileDocData): PlacedBand[] {
		return [
			...p.placedBands,
			...(crossingNotamBandsByRoute[r.id] ?? []),
			...(crossingSupBandsByRoute[r.id] ?? []),
			...(crossingZsmBandsByRoute[r.id] ?? []),
		];
	}

	/** The keys of the zones active in `states`. */
	function activeKeysOf(states: ReadonlyMap<string, ActivityAnswer>): ReadonlySet<string> {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a print's local set, built once per sheet
		const out = new Set<string>();
		for (const [key, a] of states) {
			if (a.state === 'active') {
				out.add(key);
			}
		}
		return out;
	}
</script>

{#snippet title(label: string)}
	<h3 class="fpd-title">
		{label}
		{#if aircraft}
			- {aircraft.identity.registration ?? aircraft.identity.type}
			{#if aircraft.identity.name}({aircraft.identity.name}){/if}
		{/if}
	</h3>
{/snippet}

{#snippet profileSheet(r: Route)}
	{@const p = profiles[r.id]}
	{#if p && p.totalNM > 0}
		{@const states = routeStates(r, p)}
		{@const activeKeys = activeKeysOf(states)}
		{@const pcx = bandCrossings(crossingBandsOf(r, p), p.altitudePath.vertices, { vfr: routeSettings.vfr, states })}
		<section class="fpd-sheet fpd-keep fpd-profile">
			{@render title(t.flightprep.vertProfile)}
			<PlotTitleLine
				route={r}
				totalNM={p.totalNM}
				eteMin={p.totalEteMin !== null
					? (routeWindEteMin(r) ?? p.totalEteMin)
					: null}
				warn={past ? null : briefingShortTag(briefingVerdictNow(), Date.now())}
			/>
			<!-- crossings strip, the modal's safety summary, static on paper -->
			<CrossingsStrip crossings={pcx} />
			<div class="fpd-plot print-plot-ink">
				<RouteProfile
					bands={[...printedBands(p, activeKeys), ...printedSupBands(r, pcx), ...(zsmBandsByRoute[r.id] ?? [])]}
					terrain={terrainByRoute[r.id] ?? []}
					groundFill={groundFillByRoute[r.id]}
					waypoints={p.wpPoints}
					altitudePath={p.altitudePath}
					legAltsFt={p.legAltsFt}
					fromNM={0}
					toNM={p.totalNM}
					floorFt={0}
					ceilingFt={p.fitCeilingFt}
					widthPx={1030}
					heightPx={640}
					legWinds={effectiveRouteWinds(r).map((w) =>
						w ? { dirDeg: w.dirDeg, speedKt: w.speedKt } : null,
					)}
					freezingFt={routeFreezingLevelsFt(r)}
					msaFt={msaByRoute[r.id] ?? null}
					oeiCeilingFt={oeiRouteCeilingsFt(r)}
					cloudCover={routeCloudCover(r)}
					obstacles={obstaclesByRoute[r.id] ?? null}
					notamBands={notamBandsByRoute[r.id] ?? null}
					notamObstacles={notamObstaclesByRoute[r.id] ?? null}
					bandActivations={bandHatch(
						states,
						new Map(p.corridorBands.map((b) => [b.key, b.id])),
						activationLinks,
						'flight',
						{ fromMs: verdictWindow.from, toMs: verdictWindow.to },
					)}
					activeBandKeys={activeKeys}
					contactStretches={contactStretchesByRoute[r.id] ?? null}
					terrainTint={true}
					vfr={routeSettings.vfr}
					transitionAltFt={routeSettings.semicircular ? effectiveTransitionAltFt() : null}
				/>
			</div>
		</section>
	{/if}
{/snippet}

<div class="fpd-doc print-palette">
	{#if mode === 'prep' || mode === 'dossier'}
		<section class="fpd-sheet">
			{@render title(t.flightprep.pageOverview)}
			<DossierPage />
		</section>
		<section class="fpd-sheet">
			{@render title(t.flightprep.pageFuel)}
			<div class="fpd-narrow" class:fpd-wide={wideFuel}><FuelPlanPage /></div>
		</section>
		<section class="fpd-sheet">
			{@render title(t.flightprep.pageMb)}
			<MassBalancePage pack blocks={mbBlocks} />
		</section>
		<section class="fpd-sheet">
			{@render title(t.flightprep.pagePerf)}
			<PerformancePage pohOpen />
		</section>
	{/if}
	{#if mode === 'dossier'}
		{#each navGroups as g (g.key)}
			{#each g.cardPairs as pair (cardKey(pair[0]))}
				<section class="fpd-cards">
					{#each pair as c (cardKey(c))}
						<div class="fpd-card">
							<NavLogSheet
								route={c.route}
								legMinFt={msaByRoute[c.route.id]}
								minWaypoints={c.pad ?? (c.part ? 0 : (measuredPad[c.route.id] ?? 8))}
								legRange={c.range}
								part={c.part}
								kneeboard
								briefing={!past}
							/>
						</div>
					{/each}
				</section>
			{/each}
			{#each g.schedPairs as pair (cardKey(pair[0]))}
				<section class="fpd-cards">
					{#each pair as c (cardKey(c))}
						<div class="fpd-card">
							<NavLogSchedule
								route={c.route}
								heading={routeTitle(c.route)}
								rowRange={c.range}
								part={c.part}
								kneeboard
							/>
						</div>
					{/each}
				</section>
			{/each}
			{#each g.profiled as r (r.id)}
				{@render profileSheet(r)}
			{/each}
		{/each}
		<!-- The NOTAM bulletin between the trips and the weather: the NOTAMs
		     tab's content filters over the planned flight's span. With no
		     briefing loaded (the review held the print), the sheet says so,
		     in the line's words. -->
		<section class="fpd-notams">
			{#if briefingLoaded()}
				<NotamPrintDoc annex {past} />
			{:else}
				<h3 class="fpd-wx-title">{t.notam.pib.title}</h3>
				<p class="fpd-wx-none">{t.briefing.none}</p>
			{/if}
		</section>
	{/if}
	{#if mode === 'profiles'}
		{#each profileRoutes as r (r.id)}
			{@render profileSheet(r)}
		{/each}
	{/if}
	{#if annex && tripWx}
		{#each wxPairs as pair, i (i)}
			<section class="fpd-cards">
				{#each pair as panel, j (j)}
					<div class="fpd-card">
						<h3 class="fpd-wx-title">{t.flightprep.metarTaf}</h3>
						<p class="fpd-wx-stamp">
							{t.flightprep.retrievedStamp(formatZulu(new Date(tripWx.fetchedAtMs)))}
						</p>
						{#each panel as e (e.icao)}
							{@const airport = airportByIdent(e.icao)}
							<div class="fpd-wx-card">
								<div class="fpd-wx-head">
									<strong>{e.icao}</strong>
									{#if airport}<span class="fpd-wx-name">{airport.name}</span>{/if}
									{#if e.pick && e.pick.metar.icaoId !== e.icao}
										<span class="fpd-wx-src">
											{t.weather.nearestMetar({
												id: e.pick.metar.icaoId,
												dist: formatDistanceNM(e.pick.distanceM),
											})}
										</span>
									{/if}
								</div>
								{#if e.status === 'error'}
									<p class="fpd-wx-none">{t.flightprep.metarUnavailable}</p>
								{:else if !e.pick}
									<p class="fpd-wx-none">{t.weather.noStation50}</p>
								{:else}
									{@const age = metarAgeMin(e.pick.metar, tripWx.fetchedAtMs)}
									<pre class="fpd-wx-raw">{e.pick.metar.rawOb}</pre>
									<div class="fpd-wx-age {metarFreshness(age)}">
										{e.pick.metar.metarType === 'SPECI' ? 'SPECI, ' : ''}{formatZulu(
											new Date(e.pick.metar.obsTime * 1000),
										)}, {formatAge(age, t.weather.metar)}
									</div>
									{#if e.taf}
										<div class="fpd-wx-src fpd-wx-tafhead">
											{t.weather.tafValid(
												formatActivationSpan(
													new Date(e.taf.validTimeFrom * 1000),
													new Date(e.taf.validTimeTo * 1000),
												),
											)}
										</div>
										<pre class="fpd-wx-raw">{tafBlockText(e.taf.rawTAF)}</pre>
									{/if}
								{/if}
							</div>
						{/each}
					</div>
				{/each}
			</section>
		{/each}
	{/if}
	{#if annex && frontCharts}
		<!-- The DWD front charts open the chart annex (the dossier checklist's
		     order and Météo-France's own briefing order: the general situation
		     first, then the TEMSI and the WINTEM). One chart per landscape
		     sheet; the head says what it is and when and closes on the CC BY
		     4.0 credit, muted like the TEMSI's Météo-France one, and the first
		     sheet carries what is said beside the charts, in full ink, so the
		     annex adds no sheet of its own for a line. -->
		{#each frontEntries as e, i (`${e.chart.kind}|${e.chart.validAtMs}|${e.chart.ref}`)}
			<section class="fpd-sheet fpd-keep">
				<div class="fpd-chart-head fpd-front-head">
					<strong>{frontTitle(e)}</strong>
					<span>{t.flightprep.chartValid(formatZulu(new Date(e.chart.validAtMs)))}</span>
					<span>{frontIssue(e)}</span>
					<span>{t.flightprep.retrievedStamp(formatZulu(new Date(frontCharts.fetchedAtMs)))}</span>
					<span class="fpd-chart-credit">{t.weather.fronts.sheetCredit}</span>
				</div>
				{#if i === 0}
					{#each frontNotes as line, j (j)}
						<p class="fpd-chart-extrap">{line}</p>
					{/each}
				{/if}
				<img
					class="fpd-chart-img front"
					class:notes={i === 0 && frontNotes.length > 0}
					src={e.dataUrl}
					width={e.wPx}
					height={e.hPx}
					alt={frontChartLabel(e.chart)}
				/>
			</section>
		{/each}
		{#if frontEntries.length === 0 && frontNotes.length > 0}
			<section class="fpd-sheet fpd-keep">
				<h3 class="fpd-wx-title">{t.weather.fronts.notesTitle}</h3>
				{#each frontNotes as line, i (i)}
					<p class="fpd-wx-none">{line}</p>
				{/each}
			</section>
		{/if}
	{/if}
	{#if annex && tripCharts}
		<!-- The chart annex, ordered METAR -> TEMSI -> WINTEM: one chart per
		     landscape sheet (a portrait WINTEM was turned at raster time; turn
		     the printed page clockwise to read it). Sheet heads carry SOFIA's
		     own product tokens plus validity, retrieved stamp and the
		     Meteo-France credit. -->
		{#each chartEntries as e (e.chart.url)}
			{@const caption = extrapolationCaption(e, tripCharts.fetchedAtMs)}
			<section class="fpd-sheet fpd-keep">
				<div class="fpd-chart-head">
					<strong>{chartName(e)}</strong>
					{#if e.chart.validAtMs != null}
						<span>{t.flightprep.chartValid(formatZulu(new Date(e.chart.validAtMs)))}</span>
					{/if}
					<span>{t.flightprep.retrievedStamp(formatZulu(new Date(tripCharts.fetchedAtMs)))}</span>
					<span class="fpd-chart-credit">{t.flightprep.chartCredit}</span>
				</div>
				{#if caption}
					<!-- Its own line, and the image a little shorter to match, so
					     the sheet stays one page. -->
					<p class="fpd-chart-extrap">{caption}</p>
				{/if}
				<img
					class="fpd-chart-img"
					class:extrap={caption != null}
					src={e.pngDataUrl}
					width={e.wPx}
					height={e.hPx}
					alt={t.weather.chartLabel({ chart: chartName(e), deadline: e.chart.deadline })}
				/>
			</section>
		{/each}
		{#if chartNotes.length > 0}
			<section class="fpd-sheet fpd-keep">
				<h3 class="fpd-wx-title">TEMSI / WINTEM</h3>
				{#each chartNotes as line, i (i)}
					<p class="fpd-wx-none">{line}</p>
				{/each}
			</section>
		{/if}
	{/if}
</div>

<style>
	/* Print-only on paper, but kept LAID OUT on screen (NOT display:none) for
	   the brief moment the modal mounts it for a print job. Firefox carries a
	   form control's value into its static print clone only for controls that
	   were actually rendered; a display:none-until-print input prints blank
	   even with its value attribute reflected ($lib/ui/printValue), which is
	   why the per-page print (live, rendered inputs) shows values but the packs
	   (this doc) did not. Parking it fully rendered but off the viewport
	   (position:fixed + a large translate paints it without adding a scrollbar
	   and stays invisible) reproduces the working recipe; the print rule below
	   pulls it back into the page flow. */
	.fpd-doc {
		position: fixed;
		top: 0;
		left: 0;
		width: 1100px;
		transform: translateX(-200vw);
		pointer-events: none;
	}

	@media print {
		:global(html.flight-prep-doc) .fpd-doc {
			position: static;
			width: auto;
			transform: none;
			pointer-events: auto;

			/* Inks ride the shared paper palette on this doc (app.css; the
			   hidden modal box's cannot cascade here), the workbook orange
			   included: paper prints the day ink, so the dossier's nav-log
			   cards and the standalone nav log print the same one. */
			background: var(--surface);
		}

		/* The 12mm padding is the real print margin: @page is zeroed (the
		   print dialog's Margins control overrides an @page margin but cannot
		   strip a content padding, the nav-log kneeboard trick). Cloned per
		   fragment so a sheet flowing onto a continuation page (long fuel
		   plan, performance grid) keeps its margins there too: Gecko honours
		   clone on block fragmentation, and Chromium does too now (measured
		   on 151; older Chromium ignored it). The forced breaks' own
		   padding-top (the refuel plan, the M&B sheets) covers an engine that
		   does not; where the clone applies it stacks on them, a deeper
		   margin, never a flush edge. */
		.fpd-sheet {
			padding: 12mm;
			box-sizing: border-box;
			break-after: page;
			box-decoration-break: clone;
		}

		/* Nav logs and schedules: two A5 cards per landscape sheet, the trip
		   beside its alternate, on the kneeboard geometry (NavLogModal's
		   .kb-sheet: 12mm at the sides, 8mm at the top and bottom, the 16mm
		   gap centred on the A4 mid-line, so a sheet cut in half yields two A5
		   cards). */
		.fpd-cards {
			display: flex;
			gap: 16mm;
			padding-block: 8mm;
			padding-inline: 12mm;
			box-sizing: border-box;
			break-after: page;
			break-inside: avoid;

			/* An overlong card overrides break-inside and fragments anyway:
			   keep the sheet's margins on the continuation fragment (Gecko). */
			box-decoration-break: clone;
		}

		.fpd-card {
			flex: 0 0 calc(50% - 8mm);
			min-width: 0;
		}

		/* The NOTAM bulletin flows in two A5 columns on the kneeboard's
		   margins, carried by this wrapper's padding and cloned on every
		   page the flow spans: the multicolumn box inside keeps no padding
		   of its own across pages in Gecko. */
		.fpd-notams {
			padding-block: 8mm;
			padding-inline: 12mm;
			box-sizing: border-box;
			break-before: page;
			break-after: page;
			box-decoration-break: clone;
		}

		/* No trailing blank page. */
		.fpd-sheet:last-child,
		.fpd-cards:last-child,
		.fpd-notams:last-child {
			break-after: auto;
		}

		/* Profile sheets hold one fixed-size chart; keep them whole. The other
		   sheets must stay free to flow onto continuation pages (long fuel
		   plans, performance grids, nav logs), their row-level break-inside
		   rules keeping rows whole. */
		.fpd-keep {
			break-inside: avoid;
		}

		/* Mirrors the modal's .print-title. */
		.fpd-title {
			margin: 0 0 10px;
			font-size: 15px;
		}

		/* The fuel page is portrait-designed: hold it at the portrait print's
		   content width (210mm - 2 x 12mm) instead of stretching tables across
		   the landscape sheet. (M&B spreads itself: loads beside envelope.) */
		.fpd-narrow {
			max-width: 186mm;
		}

		/* From five trips its tables cannot fit that column: the whole
		   sheet's width, the heads and labels wrapping before the figures. */
		.fpd-narrow.fpd-wide {
			max-width: none;
		}

		/* The route title line and the crossings strip over each chart live
		   in PlotTitleLine / CrossingsStrip (shared with the profile
		   modal). */

		/* The chart palette rides the shared .print-plot-ink class on the
		   plot container (app.css, the profile modal's print set). */

		/* The profile sheet is EXACTLY one landscape page: at full sheet width
		   the 1030x640 SVG is 169.6mm tall, and with the titles (~13.6mm) any
		   crossings strip pushed the chart onto an unpadded continuation page.
		   Fix the sheet's height (border-box, so 12mm padding included) and
		   let the plot flex into whatever the titles + strip + forbidden
		   callout leave, the SVG scaling down to fit (ratio preserved via its
		   intrinsic width/height attributes). overflow hidden is the hard cap:
		   worst case the chart shrinks, it never spills. The height is 200mm,
		   one page under every margins preset of the print dialog: "Minimum"
		   takes the printer's unprintable edge off the 210mm page (4.2mm a
		   side on a laser, 201.5mm left), and a sheet taller than the page
		   leaves its empty end on a blank one. 100vh would track the page in
		   Chromium, where Gecko reads it off the window. */
		.fpd-profile {
			display: flex;
			flex-direction: column;
			height: 200mm;
			overflow: hidden;
		}

		.fpd-profile .fpd-plot {
			display: flex;
			flex: 1 1 auto;
			align-items: flex-start;
			justify-content: center;
			min-height: 0;
		}

		.fpd-plot :global(svg.plot) {
			display: block;
			width: auto;
			height: auto;
			max-width: 100%;
			max-height: 100%;
			margin: 0 auto;
		}

		/* Trip METAR / TAF kneeboard cards: two A5 panels per landscape
		   sheet (the fpd-cards geometry, so a cut yields two A5 pages),
		   entries packed in trip order by packWxPanels. Each panel repeats
		   the title + retrieved stamp so a cut card stays self-contained. */
		.fpd-wx-title {
			margin: 0 0 2px;
			font-size: 13px;
		}

		.fpd-wx-stamp {
			margin: 0 0 8px;
			font-size: 10.5px;
			color: var(--text-muted);
		}

		.fpd-wx-card {
			padding: 6px 8px;
			border: 1px solid var(--border);
			border-radius: var(--radius);
			break-inside: avoid;
		}

		.fpd-wx-card + .fpd-wx-card {
			margin-top: 6px;
		}

		.fpd-wx-head {
			display: flex;
			align-items: baseline;
			gap: 10px;
			font-size: 12px;
		}

		.fpd-wx-name {
			color: var(--text-muted);
		}

		.fpd-wx-src {
			font-size: 11px;
			font-weight: 600;
			color: var(--text-muted);
		}

		.fpd-wx-tafhead {
			margin-top: 6px;
		}

		.fpd-wx-raw {
			margin: 4px 0 0;
			font-size: 11.5px;
			line-height: 1.4;
			white-space: pre-wrap;
			overflow-wrap: anywhere;
		}

		.fpd-wx-none {
			margin: 4px 0 0;
			font-size: 12px;
			color: var(--text-muted);
		}

		.fpd-wx-age {
			margin-top: 2px;
			font-size: 11px;
			color: var(--text-muted);
		}

		/* The printed pages' caution tint (the perf sheets' extrapolation
		   orange), deliberately not WeatherSection's on-screen pink. */
		.fpd-wx-age.aging {
			color: var(--workbook-orange);
		}

		.fpd-wx-age.expired {
			color: var(--danger);
		}

		/* TEMSI / WINTEM chart sheets: the head line (product tokens, validity,
		   retrieved stamp, credit), then the rasterized chart scaled to fit the
		   sheet, ratio preserved. Every raster is landscape (a portrait WINTEM
		   was turned a quarter at raster time) and fills its own sheet. The
		   height leaves the 12mm sheet padding plus the head line clear, so a
		   chart can never push its sheet past one page. */
		.fpd-chart-head {
			display: flex;
			align-items: baseline;
			gap: 12px;
			margin: 0 0 4px;
			font-size: 11.5px;
			color: var(--text-muted);
		}

		.fpd-chart-head strong {
			font-size: 13px;
			color: var(--text);
		}

		.fpd-chart-credit {
			margin-left: auto;
			font-size: 10.5px;
		}

		.fpd-chart-img {
			display: block;
			width: auto;
			height: auto;
			max-width: 100%;
			max-height: 164mm;
			margin: 0 auto;
			border: 1px solid var(--border);
		}

		/* The extrapolation caption: up to two lines over the image, which
		   gives up that height so the sheet stays one page. */
		.fpd-chart-extrap {
			margin: 0 0 4px;
			font-size: 10.5px;
			line-height: 1.25;
			color: var(--text);
		}

		.fpd-chart-img.extrap {
			max-height: 155mm;
		}

		/* The DWD front sheets: a head that wraps (title, validity, issue,
		   retrieved stamp, then the credit, kept to the right of its line as
		   on the TEMSI sheets), and on the first sheet the notes, so the image
		   gives up that height and the sheet stays one page. */
		.fpd-front-head {
			flex-wrap: wrap;
			row-gap: 2px;
		}

		.fpd-chart-img.front {
			max-height: 150mm;
		}

		.fpd-chart-img.front.notes {
			max-height: 138mm;
		}
	}
</style>
