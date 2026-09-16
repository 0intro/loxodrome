<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	/* The flight-preparation print document, produced by the modal's two pack
	 * buttons and mounted only while printing (the nav-log kneeboard pattern):
	 * hidden on screen, shown by the print rules under html.flight-prep-doc,
	 * which also hide the modal box. One A4 landscape job for every sheet;
	 * Chromium honours page orientation only from the default @page, so a
	 * single job cannot mix orientations: the portrait-designed Fuel page
	 * prints in a portrait-width column and M&B lays its loads column beside
	 * the CG envelope (the per-page print button keeps their true portrait
	 * sheets). 'prep' is the four pages;
	 * 'dossier' adds per trip the nav logs and schedules as two A5 cards per
	 * sheet (the trip beside its alternate, the kneeboard geometry via the
	 * cards' `kneeboard` prop; a log or schedule outgrowing one card
	 * continues on numbered measured part cards) and the trip's full-extent
	 * vertical profile (alternates get no
	 * profile), then closes with the meteo annex: the trip-chain METAR / TAF
	 * cards (two A5 panels per sheet like the nav logs) and the
	 * flight-relevant TEMSI and WINTEM charts, one full landscape sheet each
	 * (a portrait WINTEM is turned a quarter at raster time), all computed
	 * off data the trigger prefetched so the snapshot renders synchronously.
	 * 'wx' is that meteo annex alone, for the Weather tab's standalone
	 * briefing print (WxPrintHost). */

	import DossierPage from './DossierPage.svelte';
	import FuelPlanPage from './FuelPlanPage.svelte';
	import MassBalancePage from './MassBalancePage.svelte';
	import PerformancePage from './PerformancePage.svelte';
	import NavLogSheet from '../NavLogSheet.svelte';
	import NavLogSchedule from '../NavLogSchedule.svelte';
	import {
		cardKey,
		estimatorCardChunks,
		expandCards,
		pairCards,
		type RouteCard,
	} from '../navlogCards';
	import RouteProfile from '../RouteProfile.svelte';
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
	import { contactRadios } from '$lib/data/airports';
	import { orderedTrips, orphanAlternates } from '$lib/aircraft/trips';
	import { routeTitle } from '$lib/route/routeLabel';
	import {
		bandCrossings,
		buildRouteProfileDoc,
		terrainFtAt,
		type RouteProfileDocData,
	} from '$lib/route/routeProfile';
	import { profileObstacleMarks, type ObstacleMark } from '$lib/route/minAltitude';
	import {
		bandActivationInfo,
		computeNotamProfileBands,
		notamObstacleMarks,
		placeNotamBands,
		type NotamObstacleMark,
		type PlacedNotamBand,
	} from '$lib/route/notamProfile';
	import { activeEvalWindow, visibleNotams } from '$lib/state/notam.svelte';
	import { activatedAirspaceIds, activatedAirspaceLinks } from '$lib/state/notamLinks.svelte';
	import { isActivationQCode } from '$lib/notam/qcode';
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
	import { formatActivationSpan, formatZulu } from '$lib/format/datetime';

	interface Props {
		/** 'prep' = the four pages; 'dossier' adds the per-route sheets;
		 *  'wx' = the meteo annex alone (METAR / TAF + charts). */
		mode: 'prep' | 'dossier' | 'wx';
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
		/** Per-route MEASURED nav-log card splits, prefetched by the dossier
		 *  prep (FlightPrepModal, via navlogMeasure); a missing route falls
		 *  back to the line-cost estimator. Unused in prep / wx modes. */
		measuredChunks?: Record<string, { from: number; to: number }[]>;
		/** Measured minWaypoints per route: blank pad rows capped to fit. */
		measuredPad?: Record<string, number>;
		/** Measured per-part minWaypoints for split logs (one per card). */
		measuredPartPads?: Record<string, number[]>;
		/** Per-route MEASURED schedule card splits, same prep; a missing
		 *  route keeps its schedule on one card (no estimator exists). */
		schedMeasured?: Record<string, { from: number; to: number }[]>;
	}
	let {
		mode,
		printableRoutes,
		msaByRoute,
		terrainByRoute,
		groundFillByRoute,
		tripWx,
		tripCharts,
		measuredChunks = {},
		measuredPad = {},
		measuredPartPads = {},
		schedMeasured = {},
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
		trip: Route | null;
	}
	function routeCards(r: Route): RouteCard<Route>[] {
		// The prep's MEASURED split when it landed; else the shared line-cost
		// estimate (estimatorCardChunks, the nav-log modal's own fallback, so
		// the two flows price banners identically).
		return expandCards(
			r,
			measuredChunks[r.id] ??
				estimatorCardChunks(
					r.waypoints,
					dataState.airportsLoaded && routeSettings.airportFreqsInNavlog
						? (ident: string) => contactRadios(airportByIdent(ident))
						: null,
					{
						enrouteFreqs: routeSettings.enrouteFreqsInNavlog,
						vorRadials: routeSettings.vorRadialsInNavlog,
					},
				),
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
				trip: t.route,
			};
		});
		for (const o of orphanAlternates(printableRoutes)) {
			groups.push({
				key: o.id,
				cardPairs: pairCards(routeCards(o)),
				schedPairs: pairCards(schedCards(o)),
				trip: null,
			});
		}
		return groups;
	});

	// The weather entries packed into A5 card panels, two per landscape
	// sheet (the nav-log kneeboard geometry), in trip order.
	const wxPairs = $derived.by((): TripWxEntry[][][] => {
		if (mode === 'prep' || !tripWx) {
			return [];
		}
		const panels = packWxPanels(tripWx.entries);
		const pairs: TripWxEntry[][][] = [];
		for (let i = 0; i < panels.length; i += 2) {
			pairs.push(panels.slice(i, i + 2));
		}
		return pairs;
	});

	// The chart annex: one full landscape sheet per chart, in selection order
	// (TEMSI then WINTEM); portrait sources were already turned a quarter at
	// raster time, so every image is landscape and fills its sheet.
	const chartEntries = $derived(mode !== 'prep' && tripCharts ? tripCharts.entries : []);

	/** Sheet-head chart name from SOFIA's own invariant tokens. */
	function chartName(e: TripChartEntry): string {
		return chartToken(e.chart);
	}

	// Degradation lines: why a product printed no chart (not yet published /
	// unreadable dates), how many selected charts failed to render, whether
	// the whole catalog was unreachable. Empty when all is well, and the
	// notes sheet is skipped entirely.
	const chartNotes = $derived.by((): string[] => {
		if (mode === 'prep' || !tripCharts) {
			return [];
		}
		const lines: string[] = [];
		for (const n of tripCharts.notes) {
			const name = `${n.product} ${n.zone}`;
			lines.push(
				n.kind === 'not-yet-published'
					? t.flightprep.chartsNotYetPublished(name)
					: t.flightprep.chartsUndated(name),
			);
		}
		if (tripCharts.failedCount > 0) {
			lines.push(t.flightprep.chartsFailed(tripCharts.failedCount));
		}
		if (tripCharts.catalogError) {
			lines.push(t.flightprep.chartsUnavailable);
		}
		return lines;
	});

	// Full-extent profile data per trip, off the prefetched terrain (the
	// vertical-profile modal's own recipe, so the printed chart is the
	// on-screen chart).
	const profiles = $derived.by(() => {
		const out: Record<string, RouteProfileDocData> = {};
		const airspaces = dataState.airspacesLoaded ? getAirspaces() : null;
		for (const g of navGroups) {
			if (!g.trip) {
				continue;
			}
			out[g.trip.id] = buildRouteProfileDoc({
				waypoints: g.trip.waypoints,
				cruiseSpeedKt: effectiveCruiseSpeedKt(),
				airspaces,
				terrain: terrainByRoute[g.trip.id] ?? [],
				groundFill: groundFillByRoute[g.trip.id],
				airportElevFt: (ident) => airportByIdent(ident)?.elevFt ?? null,
				typeLabels: t.data.airspaceTypes,
				climbGradFtPerNM: effectiveClimbGradFtPerNM(),
				descentGradFtPerNM: effectiveDescentGradFtPerNM(),
			});
		}
		return out;
	});

	// Corridor obstacles per trip, unconditional like winds / clouds (the
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
	const obstaclesByTrip = $derived.by(() => {
		const out: Record<string, (ObstacleMark & { tip: string })[]> = {};
		void dataState.obstaclesLoaded;
		const obs = getObstacles();
		if (!obs) {
			return out;
		}
		for (const g of navGroups) {
			const p = g.trip ? profiles[g.trip.id] : undefined;
			if (!g.trip || !p) {
				continue;
			}
			out[g.trip.id] = profileObstacleMarks(
				g.trip.waypoints,
				p.wpPoints.map((w) => w.distNM),
				obs,
				routeSettings.minAltCorridorRadiusNM,
			).map((m) => ({ ...m, tip: obstacleTip(m) }));
		}
		return out;
	});

	// NOTAM bands + activation hatch per trip, unconditional like winds /
	// clouds: the dossier is a flight document, so the profile prints what
	// the modal shows under the current filters (incl. the viewing period).
	const notamBandsByTrip = $derived.by(() => {
		const out: Record<string, PlacedNotamBand[]> = {};
		for (const g of navGroups) {
			if (!g.trip) {
				continue;
			}
			const raw = computeNotamProfileBands(
				g.trip.waypoints,
				visibleNotams(),
				(n) => isActivationQCode(n.qCode) && activatedAirspaceIds(n).length > 0,
			);
			if (raw.length > 0) {
				out[g.trip.id] = placeNotamBands(raw, terrainByRoute[g.trip.id] ?? []);
			}
		}
		return out;
	});
	// Temporary obstacles from obstacle NOTAMs, per trip (the modal's recipe).
	const notamObstaclesByTrip = $derived.by(() => {
		const out: Record<string, (NotamObstacleMark & { tip: string })[]> = {};
		for (const g of navGroups) {
			const p = g.trip ? profiles[g.trip.id] : undefined;
			if (!g.trip || !p) {
				continue;
			}
			const terrain = terrainByRoute[g.trip.id] ?? [];
			const marks = notamObstacleMarks(
				g.trip.waypoints,
				p.wpPoints.map((w) => w.distNM),
				visibleNotams(),
				routeSettings.minAltCorridorRadiusNM,
				(d) => terrainFtAt(terrain, d, sampleCeilingFt),
			);
			if (marks.length === 0) {
				continue;
			}
			// i18n-ignore-start: NOTAM id + ICAO abbreviations and units, locale-invariant
			out[g.trip.id] = marks.map((m) => ({
				...m,
				tip: `NOTAM ${m.notamId}\n${Math.round(m.topFt)} ft AMSL${
					m.hgtFt != null ? ` (${Math.round(m.hgtFt)} ft AGL)` : ''
				}`,
			}));
			// i18n-ignore-end
		}
		return out;
	});

	const bandActivationsByTrip = $derived.by(() => {
		const out: Record<string, Map<string, string>> = {};
		const links = activatedAirspaceLinks();
		if (links.size === 0) {
			return out;
		}
		const { from, to } = activeEvalWindow();
		for (const g of navGroups) {
			const p = g.trip ? profiles[g.trip.id] : undefined;
			if (!g.trip || !p) {
				continue;
			}
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived output, rebuilt whole
			const m = new Map<string, string>();
			for (const b of p.corridorBands) {
				const l = links.get(b.id);
				if (!l) {
					continue;
				}
				const info = bandActivationInfo(b.id, l, from, to);
				if (info.notamIds.length === 0) {
					continue;
				}
				const w = info.windows.length > 0 ? ` (${info.windows.join(', ')})` : '';
				m.set(b.key, `${t.route.bandActivatedBy} ${info.notamIds.join(', ')}${w}`);
			}
			if (m.size > 0) {
				out[g.trip.id] = m;
			}
		}
		return out;
	});
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

<div class="fpd-doc print-palette">
	{#if mode !== 'wx'}
		<section class="fpd-sheet">
			{@render title(t.flightprep.pageOverview)}
			<DossierPage />
		</section>
		<section class="fpd-sheet">
			{@render title(t.flightprep.pageFuel)}
			<div class="fpd-narrow"><FuelPlanPage /></div>
		</section>
		<section class="fpd-sheet">
			{@render title(t.flightprep.pageMb)}
			<MassBalancePage />
		</section>
		<section class="fpd-sheet">
			{@render title(t.flightprep.pagePerf)}
			<PerformancePage />
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
			{#if g.trip}
				{@const p = profiles[g.trip.id]}
				{#if p.totalNM > 0}
					{@const pcx = bandCrossings(
						[...p.placedBands, ...(notamBandsByTrip[g.trip.id] ?? [])],
						p.altitudePath.vertices,
						{
							vfr: routeSettings.vfr,
							activeKeys: new Set(bandActivationsByTrip[g.trip.id]?.keys() ?? []),
						},
					)}
					<section class="fpd-sheet fpd-keep fpd-profile">
						{@render title(t.flightprep.vertProfile)}
						<PlotTitleLine
							route={g.trip}
							totalNM={p.totalNM}
							eteMin={p.totalEteMin !== null
								? (routeWindEteMin(g.trip) ?? p.totalEteMin)
								: null}
						/>
						<!-- crossings strip, the modal's safety summary, static on paper -->
						<CrossingsStrip crossings={pcx} />
						<div class="fpd-plot print-plot-ink">
							<RouteProfile
								bands={p.placedBands}
								terrain={terrainByRoute[g.trip.id] ?? []}
								groundFill={groundFillByRoute[g.trip.id]}
								waypoints={p.wpPoints}
								altitudePath={p.altitudePath}
								legAltsFt={p.legAltsFt}
								fromNM={0}
								toNM={p.totalNM}
								floorFt={0}
								ceilingFt={p.fitCeilingFt}
								widthPx={1030}
								heightPx={640}
								legWinds={effectiveRouteWinds(g.trip).map((w) =>
									w ? { dirDeg: w.dirDeg, speedKt: w.speedKt } : null,
								)}
								freezingFt={routeFreezingLevelsFt(g.trip)}
								msaFt={msaByRoute[g.trip.id] ?? null}
								cloudCover={routeCloudCover(g.trip)}
								obstacles={obstaclesByTrip[g.trip.id] ?? null}
								notamBands={notamBandsByTrip[g.trip.id] ?? null}
								notamObstacles={notamObstaclesByTrip[g.trip.id] ?? null}
								bandActivations={bandActivationsByTrip[g.trip.id] ?? null}
								terrainTint={true}
								vfr={routeSettings.vfr}
								transitionAltFt={routeSettings.semicircular ? effectiveTransitionAltFt() : null}
							/>
						</div>
					</section>
				{/if}
			{/if}
		{/each}
	{/if}
	{#if mode !== 'prep' && tripWx}
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
	{#if mode !== 'prep' && tripCharts}
		<!-- The chart annex, ordered METAR -> TEMSI -> WINTEM: one chart per
		     landscape sheet (a portrait WINTEM was turned at raster time; turn
		     the printed page clockwise to read it). Sheet heads carry SOFIA's
		     own product tokens plus validity, retrieved stamp and the
		     Meteo-France credit. -->
		{#each chartEntries as e (e.chart.url)}
			<section class="fpd-sheet fpd-keep">
				<div class="fpd-chart-head">
					<strong>{chartName(e)}</strong>
					{#if e.chart.validAtMs != null}
						<span>{t.flightprep.chartValid(formatZulu(new Date(e.chart.validAtMs)))}</span>
					{/if}
					<span>{t.flightprep.retrievedStamp(formatZulu(new Date(tripCharts.fetchedAtMs)))}</span>
					<span class="fpd-chart-credit">{t.flightprep.chartCredit}</span>
				</div>
				<img
					class="fpd-chart-img"
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

			/* Inks ride the shared .print-palette class on this doc
			   (app.css; the hidden modal box's pin cannot cascade here);
			   the workbook orange is the one value that deliberately
			   differs from the day theme (the true sheet orange), pinned
			   only by the flight-prep flows. */
			--workbook-orange: #e69100;

			background: var(--surface);
		}

		/* The 12mm padding is the real print margin: @page is zeroed (the
		   print dialog's Margins control overrides an @page margin but cannot
		   strip a content padding, the nav-log kneeboard trick). Cloned per
		   fragment so a sheet flowing onto a continuation page (long fuel
		   plan, performance grid) keeps its margins there too; Gecko honours
		   clone on block fragmentation, Chromium ignores it (no regression).
		   The refuel plan's own forced-break padding-top still covers
		   Chromium; under Gecko the cloned sheet padding stacks on it, a
		   deeper margin, never a flush edge. */
		.fpd-sheet {
			padding: 12mm;
			box-sizing: border-box;
			break-after: page;
			box-decoration-break: clone;
		}

		/* Nav logs and schedules: two A5 cards per landscape sheet, the trip
		   beside its alternate (the kneeboard geometry: 8mm card margin, the
		   16mm gap centred on the A4 mid-line, so cutting a sheet in half
		   yields two A5 cards with a uniform 8mm margin). */
		.fpd-cards {
			display: flex;
			gap: 16mm;
			padding: 8mm;
			box-sizing: border-box;
			break-after: page;
			break-inside: avoid;

			/* An overlong card overrides break-inside and fragments anyway;
			   keep the 8mm margin on the continuation fragment (Gecko). */
			box-decoration-break: clone;
		}

		.fpd-card {
			flex: 0 0 calc(50% - 8mm);
			min-width: 0;
		}

		/* No trailing blank page. */
		.fpd-sheet:last-child,
		.fpd-cards:last-child {
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

		/* The route title line and the crossings strip over each chart live
		   in PlotTitleLine / CrossingsStrip (shared with the profile
		   modal). */

		/* The chart palette rides the shared .print-plot-ink class on the
		   plot container (app.css, the profile modal's print set). */

		/* The profile sheet is EXACTLY one landscape page: at full sheet width
		   the 1030x640 SVG is 169.6mm tall, and with the titles (~13.6mm) any
		   crossings strip pushed the chart onto an unpadded continuation page.
		   Fix the sheet to page height (209mm, a hair under 210 so rounding
		   can never mint a blank page; border-box, so 12mm padding included)
		   and let the plot flex into whatever the titles + strip + forbidden
		   callout leave, the SVG scaling down to fit (ratio preserved via its
		   intrinsic width/height attributes). overflow hidden is the hard cap:
		   worst case the chart shrinks, it never spills. */
		.fpd-profile {
			display: flex;
			flex-direction: column;
			height: 209mm;
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
	}
</style>
