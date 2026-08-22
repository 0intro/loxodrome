<script lang="ts">
	/* The flight-preparation modal: four printable pages (Overview, Fuel
	 * plan, Mass & balance, Performance) over the drawn routes and the
	 * selected aircraft. Follows the NavLogModal skeleton: portal + focus
	 * trap, Escape to close, html.flight-prep-print isolation while open, a
	 * static portrait @page with a landscape override injected for the
	 * overview and performance pages. The header's print menu (the shell's
	 * actions disclosure) lists every paper this workbook produces: the page
	 * on screen, the four-page preparation pack, the full flight dossier
	 * adding each route's nav log, schedule and vertical profile (both packs
	 * through the print-only PrintDoc under html.flight-prep-doc, the
	 * kneeboard pattern; all-landscape, since one job allows one
	 * orientation), and the standalone weather briefing, which the row hands
	 * to WxPrintHost. */

	import { tick } from 'svelte';
	import Icon from './Icon.svelte';
	import PageTabs from './PageTabs.svelte';
	import SurfaceShell from './SurfaceShell.svelte';
	import { markDocumentPrint, printSurface } from '$lib/ui/surfacePrint.svelte';
	import { planPrintStem } from '$lib/state/printName';
	import { printPage } from '$lib/ui/print';
	import { DOCUMENT_ORIENTATION, installDocumentPageCss } from '$lib/ui/printJob';
	import DossierPage from './flightprep/DossierPage.svelte';
	import FuelPlanPage from './flightprep/FuelPlanPage.svelte';
	import MassBalancePage from './flightprep/MassBalancePage.svelte';
	import PerformancePage from './flightprep/PerformancePage.svelte';
	import PrintDoc from './flightprep/PrintDoc.svelte';
	import PrintProgress from './flightprep/PrintProgress.svelte';
	import {
		flightPrepModal,
		closeFlightPrep,
		type FlightPrepPage,
	} from '$lib/state/flightPrepModal.svelte';
	import { aircraftState, selectedAircraft, ensureAircraftLibrary } from '$lib/state/aircraft.svelte';
	import {
		airportByIdent,
		ensureAirports,
		ensureAirspaces,
		ensureNavaids,
		ensureObstacles,
		dataState,
	} from '$lib/state/data.svelte';
	import { routes, routeSettings } from '$lib/state/route.svelte';
	import { display } from '$lib/state/display.svelte';
	import {
		abortedPromise,
		addPrintIssue,
		beginPrintProgress,
		closePrintProgress,
		printProgress,
		requestPrintCancel,
		settlePrintProgress,
		stepAdvance,
		stepEnd,
		stepSet,
		stepStart,
		type PrintStepKind,
	} from '$lib/state/printProgress.svelte';
	import { ensureRouteWindFor } from '$lib/state/routeWind.svelte';
	import { requestWxPrint, wxPrint } from '$lib/state/wxPrint.svelte';
	import {
		measureKneeboardCards,
		measureScheduleCards,
		measuredCardPads,
		measuredChunks,
		measuredMinWaypoints,
		measuredScheduleChunks,
	} from './navlogMeasure';
	import { computeMinAltitudes } from '$lib/route/minAltitude';
	import { sampleProfile, type TerrainSample } from '$lib/map/terrain';
	import { orderedTrips, orphanAlternates } from '$lib/aircraft/trips';
	import { perfIcaos, perfWxStops, tripWxStops } from '$lib/aircraft/aerodromes';
	import { flightPrep } from '$lib/state/flightPrep.svelte';
	import { adoptNearestMetar } from '$lib/state/weather.svelte';
	import { fetchTripWx, type TripWxDoc } from '$lib/weather/tripWx';
	import type { TripChartsDoc } from '$lib/weather/tripCharts';
	import { fetchChartsForPrint } from './flightprep/chartsPrefetch';
	import { selectTab } from '$lib/state/ui.svelte';
	import { t } from '$lib/state/i18n.svelte';

	// 'dossier' is the workbook tab the Overview page ports (the saved YAML
	// block keeps that name); the English label avoids it because the whole
	// modal, not just this page, is the flight dossier (French keeps the
	// club workbook's own tab name). Key-only registry; labels resolve
	// through t at render (docs/i18n.md rule 2).
	const PAGES: { id: FlightPrepPage; icon: string }[] = [
		{ id: 'dossier', icon: 'file-text' },
		{ id: 'fuel', icon: 'droplet' },
		{ id: 'mb', icon: 'scale' },
		{ id: 'perf', icon: 'gauge' },
	];

	function pageLabel(id: FlightPrepPage): string {
		switch (id) {
			case 'dossier':
				return t.flightprep.pageOverview;
			case 'fuel':
				return t.flightprep.pageFuel;
			case 'mb':
				return t.flightprep.pageMb;
			case 'perf':
				return t.flightprep.pagePerf;
		}
	}

	// Warm up the datasets the pages read: the aircraft library (fleet) and
	// the airports (elevations + runways for the performance grid).
	$effect(() => {
		if (flightPrepModal.open) {
			void ensureAircraftLibrary();
		}
		if (flightPrepModal.open && !dataState.airportsLoaded) {
			void ensureAirports().catch(() => {
				/* surfaced via dataState.airportsError */
			});
		}
	});

	// Print isolation: tag <html> while open (cleanup on close / unmount).
	$effect(() => {
		const el = document.documentElement;
		if (flightPrepModal.open) {
			el.classList.add('flight-prep-print');
		} else {
			el.classList.remove('flight-prep-print');
		}
		return () => el.classList.remove('flight-prep-print');
	});

	/* The performance grid and the overview (the workbook prints its Dossier
	 * sheet landscape) print landscape; the other two pages take the static
	 * portrait @page. Zero page margin, like the nav-log kneeboard: the margin
	 * is carried by the printed body's padding, which the print dialog cannot
	 * strip. Read at claim time, so it reports the page actually showing; the
	 * pack flow owns the @page itself while it runs. */
	// i18n-ignore: injected print CSS, not user-visible text
	const LANDSCAPE_PAGE = '@media print { @page { size: A4 landscape; margin: 0; } }';

	function pageCss(): string | null {
		const landscape = flightPrepModal.page === 'perf' || flightPrepModal.page === 'dossier';
		return landscape && printMode === null ? LANDSCAPE_PAGE : null;
	}

	const aircraft = $derived(selectedAircraft());
	const unknownKey = $derived(aircraftState.selectedKey !== null && aircraft === null);

	function goToAircraftTab(): void {
		closeFlightPrep();
		selectTab('aircraft');
	}

	// ---- pack printing (the nav-log kneeboard pattern) ----------------------

	// 'prep' (the four pages) or 'dossier' (plus the per-route sheets) while
	// that pack is being printed; null otherwise, when a plain window.print()
	// prints the active page on its own sheet, as before.
	let printMode = $state<'prep' | 'dossier' | null>(null);
	let preparingPrint = $state(false);
	// Per-route MSA + terrain, prefetched so the doc renders synchronously
	// (no async fetch between mounting it and the print snapshot).
	let docMsa = $state<Record<string, (number | null)[]>>({});
	let docTerrain = $state<Record<string, TerrainSample[]>>({});
	// Trip-chain weather snapshot for the dossier's closing METAR / TAF
	// sheet; null = live weather off or nothing fetched (sheet skipped).
	let docWx = $state<TripWxDoc | null>(null);
	// Flight-relevant TEMSI / WINTEM charts, rasterized; null = live weather
	// off. Cleared after printing: each chart is a multi-MB data URL.
	let docCharts = $state<TripChartsDoc | null>(null);
	// Per-route MEASURED nav-log card splits (navlogMeasure), rebuilt whole
	// by every dossier prep; PrintDoc falls back to the estimator for any
	// route whose measure failed.
	let docMeasured = $state<Record<string, { from: number; to: number }[]>>({});
	// Measured pad allowance per route (blank form rows only while they fit).
	let docPad = $state<Record<string, number>>({});
	let docPartPads = $state<Record<string, number[]>>({});
	// Per-route MEASURED schedule card splits, same prep; a route whose
	// measure failed keeps its schedule on one card (no estimator exists).
	let docSchedMeasured = $state<Record<string, { from: number; to: number }[]>>({});

	// Every route with a flyable leg, for the dossier's per-route sheets.
	const printableRoutes = $derived(routes.list.filter((r) => r.waypoints.length >= 2));

	// The print menu's rows all stand down while EITHER pipeline prepares:
	// the pack flows and the weather briefing share the printProgress
	// singleton, so starting one while the other prefetches would gen-bump
	// the first into silently standing down.
	const busy = $derived(preparingPrint || wxPrint.preparing);

	// While pack-printing, tag <html> (the print rules switch to the doc) and
	// inject the landscape @page (installDocumentPageCss). Zero page margin;
	// the sheets' 12mm padding is the real margin. The dossier also sets the
	// nav-log kneeboard class (the A5 compaction itself is prop-scoped in
	// NavLogSheet / NavLogSchedule; the class keeps any residual
	// kneeboard-scoped print rules in force; the nav log may well be open
	// beside this page now, but the doc flows hide every surface box anyway).
	// All torn down when the mode clears after printing.
	$effect(() => {
		if (printMode === null) {
			return;
		}
		return installDocumentPageCss(
			printMode === 'dossier'
				? ['flight-prep-doc', 'navlog-kneeboard']
				: ['flight-prep-doc'],
		);
	});

	function resetPrintMode(): void {
		printMode = null;
		docCharts = null;
		// After the print dialog closes: keep the overlay as a summary card
		// when anything degraded, else drop it.
		settlePrintProgress();
	}

	// Closing the modal mid-prep abandons this host's run: abort what can
	// be aborted and drop the overlay (the gen guards silence stragglers;
	// printPack re-checks before printing). Scoped to the modal's own modes,
	// a 'wx' run belongs to WxPrintHost and legitimately outlives this modal.
	$effect(() => {
		if (
			!flightPrepModal.open &&
			printProgress.active &&
			(printProgress.mode === 'prep' || printProgress.mode === 'dossier')
		) {
			requestPrintCancel();
			closePrintProgress();
		}
	});

	async function printPack(mode: 'prep' | 'dossier'): Promise<void> {
		if (preparingPrint) {
			return;
		}
		preparingPrint = true;
		const dossier = mode === 'dossier' && printableRoutes.length > 0;
		const live = display.liveWeather;
		const trips = printableRoutes.filter((r) => !r.alternate);
		// The dossier's closing METAR / TAF cards: the trip chain's own stops,
		// positions off the waypoints. Fetched directly, since the ensure*
		// cache is display-gated and fire-and-forget; a stop that fails prints
		// as an "unavailable" line instead of aborting the pack. The
		// performance grid's aerodromes join this list below, once the airport
		// dataset can place them.
		const annexStops =
			dossier && live
				? tripWxStops(orderedTrips(printableRoutes), orphanAlternates(printableRoutes))
				: [];
		// The grid's IDENTS need no dataset (only their positions do), so the
		// overlay can count the weather step before the datasets land; the exact
		// total follows once they are placed.
		const perfIdents = live ? perfIcaos(orderedTrips(routes.list), flightPrep.perf.manualIcaos) : [];
		const wxIdents =
			annexStops.length + perfIdents.filter((i) => !annexStops.some((a) => a.icao === i)).length;
		// The overlay's step plan, in display order; counted steps advance
		// per settled unit. Every failure records a non-blocking issue and
		// the pack still prints with the data that arrived.
		const plan: { kind: PrintStepKind; total?: number }[] = [
			{ kind: 'datasets', total: dossier ? 5 : 2 },
		];
		if (dossier) {
			plan.push({ kind: 'msa', total: printableRoutes.length });
		}
		// Both packs: the forecast winds carry the fuel reserve, the landing
		// mass and every performance distance (flightprep/shared.ts), and the
		// aerodrome weather carries the grid's QNH, temperature, wind and the
		// runway they select.
		if (printableRoutes.length > 0) {
			plan.push({ kind: 'wind', total: printableRoutes.length });
		}
		if (dossier && trips.length > 0) {
			plan.push({ kind: 'terrain', total: trips.length });
		}
		if (wxIdents > 0) {
			plan.push({ kind: 'wx', total: wxIdents });
		}
		if (dossier && live) {
			plan.push({ kind: 'charts' });
		}
		plan.push({ kind: 'pages' });
		const ctrl = new AbortController();
		const gen = beginPrintProgress(mode, plan, () => ctrl.abort());
		// One dataset ensure settled (the obstacle load keeps its own value).
		const dsSettled = (p: Promise<unknown>): Promise<void> =>
			p.then(
				() => stepAdvance(gen, 'datasets'),
				() => {
					addPrintIssue(gen, { code: 'datasets' });
					stepAdvance(gen, 'datasets', false);
				},
			);
		try {
			// Ensure the datasets the pages read are present (the fleet and the
			// airports the performance grid needs).
			stepStart(gen, 'datasets');
			await Promise.all([dsSettled(ensureAircraftLibrary()), dsSettled(ensureAirports())]);
			// The grid's aerodromes, placeable only now, read exactly as the page
			// reads them (routes.list, manual adds included) so no column can go
			// unfetched. Unioned with the annex stops, first seen wins: ONE pass
			// serves both, so the sheet and the annex quote the SAME observation
			// and the print document's own mount finds every record fresh instead
			// of starting a fetch that cannot land before the snapshot.
			const wxStops = [
				...annexStops,
				...perfWxStops(perfIdents, (icao) => airportByIdent(icao)).filter(
					(s) => !annexStops.some((a) => a.icao === s.icao),
				),
			];
			stepSet(gen, 'wx', { total: wxStops.length });
			// An object holder, not two lets: TS cannot see the closure writes
			// and would narrow plain lets to null (never past a != null guard).
			const out: { wx: TripWxDoc | null; charts: TripChartsDoc | null } = {
				wx: null,
				charts: null,
			};
			const msa: Record<string, (number | null)[]> = {};
			const terrain: Record<string, TerrainSample[]> = {};
			const pts = (r: (typeof printableRoutes)[number]) =>
				r.waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));
			let obstacles: Awaited<ReturnType<typeof ensureObstacles>> = [];
			if (dossier) {
				[obstacles] = await Promise.all([
					ensureObstacles()
						.then((o) => {
							stepAdvance(gen, 'datasets');
							return o;
						})
						.catch(() => {
							addPrintIssue(gen, { code: 'datasets' });
							stepAdvance(gen, 'datasets', false);
							return [];
						}),
					dsSettled(ensureAirspaces()),
					dsSettled(ensureNavaids()),
				]);
			}
			stepStart(gen, 'msa');
			stepStart(gen, 'wind');
			stepStart(gen, 'terrain');
			stepStart(gen, 'wx');
			stepStart(gen, 'charts');
			// Both packs fetch the winds and the weather; the dossier adds the
			// per-route MSA, the trips' terrain (alternates print no profile) and
			// the chart annex. A failure degrades one sheet (blank MSA cells, no
			// terrain silhouette, estimated weather) instead of aborting the pack;
			// the MSA fallback must be nulls, not undefined, or the sheet would
			// start its own async fetch mid-print.
			const tasks: Promise<unknown>[] = [
				// Forecast winds for every printed sheet, schedule and profile, so
				// paper matches screen; a failure falls back to manual wind.
				...printableRoutes.map((r) =>
					ensureRouteWindFor(r)
						.then(() => stepAdvance(gen, 'wind'))
						.catch(() => {
							addPrintIssue(gen, { code: 'wind' });
							stepAdvance(gen, 'wind', false);
						}),
				),
			];
			if (wxStops.length > 0) {
				tasks.push(
					(async () => {
						const doc = await fetchTripWx(wxStops, (done, total) =>
							stepSet(gen, 'wx', { done, total }),
						);
						for (const e of doc.entries) {
							if (e.status === 'error') {
								addPrintIssue(gen, { code: 'wx-station', param: e.icao });
							}
						}
						stepEnd(
							gen,
							'wx',
							doc.entries.every((e) => e.status === 'ok'),
						);
						out.wx = doc;
					})(),
				);
			} else if (wxIdents > 0) {
				stepEnd(gen, 'wx', true); // every ident unplaceable; nothing to fetch
			}
			if (dossier) {
				tasks.push(
					...printableRoutes.map(async (r) => {
						try {
							msa[r.id] = await computeMinAltitudes(pts(r), obstacles, {
								halfWidthNM: routeSettings.minAltCorridorRadiusNM,
								vfr: routeSettings.vfr,
								signal: ctrl.signal,
							});
							stepAdvance(gen, 'msa');
						} catch {
							msa[r.id] = new Array<number | null>(r.waypoints.length - 1).fill(null);
							addPrintIssue(gen, { code: 'msa' });
							stepAdvance(gen, 'msa', false);
						}
					}),
					...trips.map(async (r) => {
						try {
							terrain[r.id] = await sampleProfile(pts(r), { signal: ctrl.signal });
							stepAdvance(gen, 'terrain');
						} catch {
							terrain[r.id] = [];
							addPrintIssue(gen, { code: 'terrain' });
							stepAdvance(gen, 'terrain', false);
						}
					}),
				);
				if (live) {
					// The flight-relevant TEMSI / WINTEM charts (fetchChartsForPrint
					// never rejects; failures print as note lines). Needs the
					// airspaces awaited above for the FRANCE / EUROC zone pick.
					tasks.push(
						(async () => {
							const doc = await fetchChartsForPrint(printableRoutes, {
								signal: ctrl.signal,
								onProgress: (done, total, current) =>
									stepSet(gen, 'charts', { done, total, param: current }),
							});
							if (doc.catalogError) {
								addPrintIssue(gen, { code: 'charts-catalog' });
							}
							if (doc.failedCount > 0) {
								addPrintIssue(gen, { code: 'charts-failed', n: doc.failedCount });
							}
							stepEnd(gen, 'charts', !doc.catalogError && doc.failedCount === 0);
							out.charts = doc;
						})(),
					);
				}
			}
			// Cancel races the prefetch: the signal stops MSA / terrain / the
			// chart loop, the rest settles into the locals above, and the
			// post-race check skips the print and the doc* writes.
			await Promise.race([Promise.all(tasks), abortedPromise(ctrl.signal)]);
			if (printProgress.cancelled || gen !== printProgress.gen) {
				return; // cancelled during the prefetch, print nothing
			}
			// The observations the grid computes from, into the session cache the
			// page reads. A failed lookup is left alone, so whatever the session
			// already holds survives it.
			if (out.wx) {
				const doc = out.wx;
				for (const e of doc.entries) {
					const stop = wxStops.find((w) => w.icao === e.icao);
					if (stop && e.status === 'ok') {
						adoptNearestMetar(e.icao, stop.lat, stop.lon, e.pick, doc.fetchedAtMs);
					}
				}
			}
			if (dossier) {
				docMsa = msa;
				docTerrain = terrain;
				// The annex prints the trip chain's own stops; the grid's extra
				// aerodromes rode the same pass but have no card.
				docWx = out.wx
					? {
							fetchedAtMs: out.wx.fetchedAtMs,
							entries: out.wx.entries.filter((e) => annexStops.some((a) => a.icao === e.icao)),
						}
					: null;
				docCharts = out.charts;
				// MEASURED card splits off the just-prefetched MSAs: mount each
				// log (and each schedule) once at card geometry and pack the
				// real row heights (media-independent kneeboard prop, so the
				// print-mode html classes are not needed yet); a failed log
				// measure leaves that route on PrintDoc's estimator fallback,
				// a failed schedule measure on one card.
				const meas: Record<string, { from: number; to: number }[]> = {};
				const pads: Record<string, number> = {};
				const partPads: Record<string, number[]> = {};
				const schedMeas: Record<string, { from: number; to: number }[]> = {};
				for (const r of printableRoutes) {
					const m = await measureKneeboardCards(r, msa[r.id]);
					if (m) {
						meas[r.id] = measuredChunks(m);
						pads[r.id] = measuredMinWaypoints(m, r.waypoints.length);
						partPads[r.id] = measuredCardPads(m, meas[r.id]);
					}
					const sm = await measureScheduleCards(r);
					if (sm) {
						schedMeas[r.id] = measuredScheduleChunks(sm);
					}
				}
				docMeasured = meas;
				docPad = pads;
				docPartPads = partPads;
				docSchedMeasured = schedMeas;
			}
			if (!flightPrepModal.open || printProgress.cancelled || gen !== printProgress.gen) {
				return; // closed or cancelled during the prefetch
			}
			stepStart(gen, 'pages');
			printMode = mode;
			await tick();
			// One more frame so the doc's layout settles before the snapshot.
			await new Promise((res) => requestAnimationFrame(() => res(undefined)));
			// The chart sheets are multi-MB data-URL images; a print snapshot of
			// a not-yet-decoded img is blank (both engines), and one frame does
			// not guarantee the decode. Settled, never rejecting the print.
			await Promise.allSettled(
				// i18n-ignore: CSS selector, not user-visible text
				Array.from(document.querySelectorAll<HTMLImageElement>('.fpd-doc img'), (img) =>
					img.decode(),
				),
			);
			stepEnd(gen, 'pages', true);
			if (printProgress.cancelled || gen !== printProgress.gen) {
				resetPrintMode(); // cancelled during the layout settle
				return;
			}
			window.addEventListener('afterprint', resetPrintMode, { once: true });
			// This flow prints a document of its own, so the user-print claim
			// must stay out of its way (surfacePrint).
			markDocumentPrint(planPrintStem(mode === 'dossier' ? 'dossier' : 'flightprep'));
			printPage(DOCUMENT_ORIENTATION);
		} finally {
			preparingPrint = false;
		}
	}
</script>

<SurfaceShell
	id="flightPrep"
	onClose={closeFlightPrep}
	label={t.flightprep.title}
	boxClass="flight-prep-box print-palette"
	pageCss={pageCss}
	printName={() => planPrintStem('flightprep')}
	actionsIcon="printer"
	actionsLabel={t.route.print}
>
	{#snippet header()}
		<h2>{t.flightprep.title}</h2>
		<PageTabs
			pages={PAGES}
			current={flightPrepModal.page}
			onSelect={(id: FlightPrepPage) => (flightPrepModal.page = id)}
			ariaLabel={t.flightprep.pagesAria}
			labelFor={pageLabel}
		/>
		{#if aircraft}
			<button
				class="chip"
				title={t.flightprep.aircraftChipTip(aircraft.identity.name ?? aircraft.identity.type)}
				onclick={goToAircraftTab}
			>
				<Icon name="plane" size={13} />
				{aircraft.identity.registration ?? aircraft.identity.type}
			</button>
		{:else}
			<button
				class="chip danger"
				title={unknownKey
					? t.flightprep.unknownChipTip(aircraftState.selectedKey ?? '')
					: t.flightprep.selectAircraftTip}
				onclick={goToAircraftTab}
			>
				<Icon name="plane" size={13} />
				{unknownKey ? `${aircraftState.selectedKey}?` : t.flightprep.noAircraft}
			</button>
		{/if}
	{/snippet}

	<!-- The print menu: every paper this workbook produces, one worded row
	 each, smallest scope first. Rows the workbook cannot serve are absent,
	 never disabled (the shell's actions contract); the weather briefing is
	 the one row printing through another host (WxPrintHost), so it follows
	 the Weather tab's own availability conditions. -->
	{#snippet actions({ close }: { close: () => void })}
		<button class="item" disabled={busy} onclick={() => { close(); void printSurface('flightPrep'); }}>
			<Icon name="printer" size={14} />
			{t.flightprep.printPage}
		</button>
		<button
			class="item"
			disabled={busy}
			title={t.flightprep.printPrepTip}
			onclick={() => { close(); void printPack('prep'); }}
		>
			<Icon name="layers" size={14} />
			{t.flightprep.printPrep}
		</button>
		{#if printableRoutes.length > 0}
			<button
				class="item"
				disabled={busy}
				title={t.flightprep.printDossierTip}
				onclick={() => { close(); void printPack('dossier'); }}
			>
				<Icon name="book" size={14} />
				{t.flightprep.printDossier}
			</button>
		{/if}
		{#if display.liveWeather && printableRoutes.length > 0}
			<button
				class="item"
				disabled={busy}
				title={t.weather.printBriefTip}
				onclick={() => { close(); requestWxPrint(); }}
			>
				<Icon name="wind" size={14} />
				{t.weather.printBrief}
			</button>
		{/if}
	{/snippet}

	<div class="body">
		<h3 class="print-title">
			{pageLabel(flightPrepModal.page)}
			{#if aircraft}
				- {aircraft.identity.registration ?? aircraft.identity.type}
				{#if aircraft.identity.name}({aircraft.identity.name}){/if}
			{/if}
		</h3>
		{#if flightPrepModal.page === 'dossier'}
			<DossierPage />
		{:else if flightPrepModal.page === 'fuel'}
			<FuelPlanPage />
		{:else if flightPrepModal.page === 'mb'}
			<MassBalancePage />
		{:else}
			<PerformancePage />
		{/if}
	</div>

	<!-- Pack-print progress overlay, inside the box (the focus trap covers
	     its buttons; both print paths hide it: the pack print hides the
	     whole box, the per-page print its .no-print root). -->
	<PrintProgress modes={['prep', 'dossier']} />

	{#snippet extra()}
		<!-- Print-only pack document (all four pages; the dossier adds each
		     route's nav log, schedule and profile). Mounted only while
		     pack-printing; display:none on screen. -->
		{#if printMode !== null}
			<PrintDoc
				mode={printMode}
				{printableRoutes}
				msaByRoute={docMsa}
				terrainByRoute={docTerrain}
				tripWx={docWx}
				tripCharts={docCharts}
				measuredChunks={docMeasured}
				measuredPad={docPad}
				measuredPartPads={docPartPads}
				schedMeasured={docSchedMeasured}
			/>
		{/if}
	{/snippet}
</SurfaceShell>

<style>
	:global(.flight-prep-box) {
		--modal-width: min(1080px, 96vw);

		/* A constant size across the three pages (the body scrolls); the
		   shared .modal-box only caps max-height, so the box would otherwise
		   resize with each page's content. */
		height: min(840px, 86vh);
	}

	h2 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--text);
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font: inherit;
		font-size: 12.5px;
		font-weight: 600;
		padding: 3px 10px;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--text);
		cursor: pointer;
		margin-right: 8px;
	}

	.chip.danger {
		border-color: var(--danger);
		color: var(--danger);
	}

	/* Below the surface's declared minimum width the pages have nowhere left
	   to reflow and would clip their table cells, so the body scrolls instead.
	   --surface-min-w is minWidthPx from the registry, published by the shell;
	   the pages sit directly under .body, so the min-width lands on each. */
	.body {
		flex: 1;
		padding: 16px;
		overflow: auto;
	}

	.body > :global(*) {
		min-width: var(--surface-min-w, 0);
	}

	/* At `full` the box IS the screen, so the floor has nowhere to scroll to
	   except sideways and the pilot pans a workbook instead of a table.
	   Measured on this phone: 99px of pan. The floor still holds wherever
	   there is room; where the box is narrower than it, the content fits the
	   box and the pages reflow against the container they already have. */
	:global(.modal-box.at-full) .body > :global(*) {
		min-width: min(var(--surface-min-w, 0), 100%);
	}

	/* The pages' two-column grids collapse against THIS box, not the window:
	   as a surface, flight preparation is as wide as the stage leaves it (or
	   as narrow as a side dock), which a viewport query cannot see. Screen
	   only, so the containment never reaches the paper flow; PrintDoc renders
	   the same pages outside any container, where the queries correctly never
	   match and the columns stay side by side. */
	@media screen {
		.body {
			container-type: inline-size;
		}
	}

	/* Shown only on paper, as the page heading. */
	.print-title {
		display: none;
	}

	/* ---- print ---- */
	@media print {
		:global(html.flight-prep-print #app) {
			display: none !important;
		}

		:global(html.flight-prep-print .modal-backdrop) {
			display: none !important;
		}

		/* Pack printing: the print-only doc (PrintDoc.svelte) replaces the
		   modal; the flight-prep-print rules above keep hiding the app. */
		:global(html.flight-prep-doc .flight-prep-box) {
			display: none !important;
		}

		/* Global: the pages' own on-screen controls (add-aerodrome, remove
		   buttons) carry .no-print too, beyond this component's scope. */
		:global(html.flight-prep-print .no-print) {
			display: none !important;
		}

		/* The app background (grey) must not bleed past the printed content. */
		:global(html.flight-prep-print),
		:global(html.flight-prep-print body) {
			background: #fff;
		}

		:global(html.flight-prep-print .flight-prep-box) {
			position: static !important;
			inset: auto !important;
			transform: none !important;
			width: auto;
			height: auto;
			max-width: none;
			max-height: none;
			overflow: visible;
			border: none;
			border-radius: 0;
			box-shadow: none;

			/* Inks ride the shared .print-palette class on this box
			   (app.css); the workbook orange is the one value that
			   deliberately differs from the day theme (the true sheet
			   orange), pinned only by the flight-prep flows. */
			--workbook-orange: #e69100;

			background: var(--surface);
		}

		:global(html.flight-prep-print .flight-prep-box .modal-header) {
			display: none;
		}

		/* The page margin: @page is zeroed (the print dialog's Margins control
		   overrides an @page margin but cannot strip a content padding, the
		   nav-log kneeboard trick), so the body padding is the real margin.
		   box-decoration-break: clone repeats it on every fragment when a
		   page overflows: Gecko discards margins at forced breaks and would
		   otherwise print continuation pages flush (Chromium ignores the
		   property; the padding-top workarounds keep covering it there). */
		:global(html.flight-prep-print) .body {
			overflow: visible;
			padding: 12mm;
			box-decoration-break: clone;
		}

		:global(html.flight-prep-print) .print-title {
			display: block;
			margin: 0 0 10px;
			font-size: 15px;
		}
	}

	@page {
		size: a4 portrait;
		margin: 0;
	}
</style>
