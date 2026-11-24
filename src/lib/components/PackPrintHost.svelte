<script lang="ts">
	/* The flight-prep packs' print host: the preparation pack (the four
	 * pages), the flight dossier, which adds each route's nav log, schedule
	 * and vertical profile, then the NOTAM bulletin and the weather annex,
	 * and the route profiles' print, every route's profile sheet alone. They
	 * print from wherever they are asked for (state/packPrint.svelte.ts), the
	 * workbook open or not. Mounted once in App, beside WxPrintHost: a run
	 * prefetches what the sheets read, the NOTAM briefing included, holds in
	 * review on a real loss, mounts
	 * PrintDoc through the shared portal (outside #app, which html.pack-print
	 * hides on paper), prints, and clears. Every sheet prints landscape, one
	 * job allowing one orientation. */

	import { tick } from 'svelte';
	import { markDocumentPrint } from '$lib/ui/surfacePrint.svelte';
	import { planPrintStem } from '$lib/state/printName';
	import { printPage } from '$lib/ui/print';
	import { DOCUMENT_ORIENTATION, installDocumentPageCss } from '$lib/ui/printJob';
	import { portal } from '$lib/ui/portal';
	import PrintDoc from './flightprep/PrintDoc.svelte';
	import PrintProgress from './flightprep/PrintProgress.svelte';
	import { measureMbBlocks } from './flightprep/mbMeasure';
	import { packPrint, registerPackPrint, type PackMode } from '$lib/state/packPrint.svelte';
	import { requireAircraftLibrary } from '$lib/state/aircraft.svelte';
	import {
		airportByIdent,
		ensureAerodromeFuel,
		ensureAirports,
		ensureAirspaces,
		ensureNavaids,
		ensureObstacles,
		ensureSupaip,
		extendCoverage,
	} from '$lib/state/data.svelte';
	import { routes, routeSettings } from '$lib/state/route.svelte';
	import { display } from '$lib/state/display.svelte';
	import {
		abortedPromise,
		addPrintIssue,
		awaitPrintDecision,
		beginPrintProgress,
		printBusy,
		printProgress,
		settlePrintProgress,
		stepAdvance,
		stepEnd,
		stepSet,
		stepStart,
		type PrintStepKind,
	} from '$lib/state/printProgress.svelte';
	import { ensureRouteCloudsFor, ensureRouteWindFor, routeForecastMissing } from '$lib/state/routeWind.svelte';
	import { retryDataNow, retryingGroup, type RetryGroup } from '$lib/state/dataRetry.svelte';
	import { KNEEBOARD_CARD } from './navlogCards';
	import {
		measureNavlogCards,
		measureScheduleCards,
		measuredCardPads,
		measuredChunks,
		measuredMinWaypoints,
		measuredScheduleChunks,
	} from './navlogMeasure';
	import { routeTitle } from '$lib/route/routeLabel';
	import { computeCorridorGround, minAltitudesFrom } from '$lib/route/minAltitude';
	import { sampleProfile, type TerrainSample } from '$lib/map/terrain';
	import { orderedTrips, orphanAlternates } from '$lib/aircraft/trips';
	import { perfIcaos, perfWxStops, tripWxStops } from '$lib/aircraft/aerodromes';
	import { flightPrep } from '$lib/state/flightPrep.svelte';
	import { adoptNearestMetar, nearestWx, usableNearest } from '$lib/state/weather.svelte';
	import { briefingGeneration } from '$lib/state/notam.svelte';
	import { notamFetchBusy } from '$lib/state/notamSource.svelte';
	import { briefingCitesFrSups, briefingVerdictNow } from '$lib/state/briefing.svelte';
	import { ensureBriefing } from '$lib/state/briefingFetch';
	import { planSigmetsNow } from '$lib/state/planSigmets.svelte';
	import { sigmetsSettled } from '$lib/state/sigmets.svelte';
	import { aerodromeForecastAt } from '$lib/state/aerodromeForecast.svelte';
	import { fetchTripWx, type TripWxDoc } from '$lib/weather/tripWx';
	import type { TripChartsDoc } from '$lib/weather/tripCharts';
	import type { FrontChartsDoc } from '$lib/weather/frontCharts';
	import {
		chartIssues,
		fetchChartsForPrint,
		fetchFrontsForPrint,
		frontIssues,
		pastChartsDoc,
		pastFlight,
		startChartCatalogs,
	} from './flightprep/chartsPrefetch';
	import { printPlanKey } from './flightprep/printPlan';
	import { fuelComputation, perfInstants } from './flightprep/shared';
	import { ensurePerfForecasts, METAR_VALID_MS } from './flightprep/runwayPerf';

	// How often a run waiting on a NOTAM fetch looks again.
	const NOTAM_FETCH_POLL_MS = 250;
	/** Each paper's job name (state/printName.ts). */
	const PRINT_KIND: Record<PackMode, string> = { prep: 'flightprep', dossier: 'dossier', profiles: 'profile' };

	// The pack being printed, its document mounted; null otherwise.
	let printMode = $state<PackMode | null>(null);
	// Per-route MSA + terrain, prefetched so the doc renders synchronously
	// (no async fetch between mounting it and the print snapshot).
	let docMsa = $state<Record<string, (number | null)[]>>({});
	let docTerrain = $state<Record<string, TerrainSample[]>>({});
	let docGroundFill = $state<Record<string, TerrainSample[]>>({});
	// Trip-chain weather snapshot for the dossier's closing METAR / TAF
	// sheet; null = live weather off or nothing fetched (sheet skipped).
	let docWx = $state<TripWxDoc | null>(null);
	// Flight-relevant TEMSI / WINTEM charts, rasterized; null = live weather
	// off. Cleared after printing: each chart is a multi-MB data URL.
	let docCharts = $state<TripChartsDoc | null>(null);
	// The DWD front charts that open the annex (weather/frontCharts.ts); null
	// = live weather off or a flight already flown. Cleared after printing:
	// an analysis is a multi-MB data URL too.
	let docFronts = $state<FrontChartsDoc | null>(null);
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
	// The M&B sheets' MEASURED pairing (mbMeasure.ts): which trips share a
	// landscape sheet; null = every trip on its own (no measure, or failed).
	let docMbBlocks = $state<number[][] | null>(null);

	// Every route with a flyable leg, for the dossier's per-route sheets.
	const printableRoutes = $derived(routes.list.filter((r) => r.waypoints.length >= 2));
	/** From five trips the fuel page's tables cannot fit a portrait sheet:
	 *  the packs widen its column. */
	const wideFuel = $derived(fuelComputation().inputs.length >= 5);

	$effect(() => registerPackPrint((mode) => void printPack(mode)));

	// While pack-printing, tag <html> (the pack-print isolation in app.css,
	// the flight-prep-doc rules PrintDoc keys on) and inject the landscape
	// @page (installDocumentPageCss). Zero page margin; the sheets' 12mm
	// padding is the real margin. The dossier also sets the nav-log
	// kneeboard class (the A5 compaction itself is prop-scoped in
	// NavLogSheet / NavLogSchedule; the class keeps any residual
	// kneeboard-scoped print rules in force). All torn down when the mode
	// clears after printing.
	$effect(() => {
		if (printMode === null) {
			return;
		}
		return installDocumentPageCss(
			printMode === 'dossier'
				? ['pack-print', 'flight-prep-doc', 'navlog-kneeboard']
				: ['pack-print', 'flight-prep-doc'],
		);
	});

	function resetPrintMode(gen: number): void {
		printMode = null;
		docCharts = null;
		docFronts = null;
		settlePrintProgress(gen);
	}

	async function printPack(mode: PackMode): Promise<void> {
		if (printBusy()) {
			return;
		}
		// The route profiles print nothing without a route to draw.
		if (mode === 'profiles' && printableRoutes.length === 0) {
			return;
		}
		packPrint.preparing = true;
		// Held until the job's own afterprint once printing started: in the
		// Android shell printPage returns at once and the synthetic
		// afterprint closes the job later (ui/print.ts), and a second prep
		// under a live job would mount its document beneath it.
		let started = false;
		// A review's Retry: the run returns and runs again from the finally,
		// once this one has released the busy flag.
		let again = false;
		// The four pages print in both packs, the profile sheets in the
		// dossier and in the route profiles' print, off one prefetch.
		const pages = mode !== 'profiles';
		const dossier = mode === 'dossier' && printableRoutes.length > 0;
		const sheets = dossier || mode === 'profiles';
		const live = display.liveWeather;
		// The plan this run prefetches for (flightprep/printPlan.ts). A plan
		// can change under the run, in the review above all (a sync landing, a
		// file opened, the sidebar beside a run the card no longer covers).
		// Its MSA, terrain and annex stops
		// would then answer for another geometry, which the sheets read by leg
		// index, so the run starts again on the plan as it stands, the Retry's
		// way.
		const planKey = printPlanKey(printableRoutes, routeSettings);
		const planMoved = (): boolean => printPlanKey(printableRoutes, routeSettings) !== planKey;
		// The briefing the review judged, which the nav logs' NOTAM lines
		// were measured with: one landing after it starts the run again.
		let briefGen = -1;
		const briefingMoved = (): boolean => briefingGeneration() !== briefGen;
		// What the review judged of the verdict and the SIGMETs, which box B
		// and box C print as they stand: a review can wait for minutes, the
		// SIGMETs refetching and the verdict moving with no briefing landing
		// (its age, the SUP AIP list, the airspaces), and paper must state
		// nothing the review did not show.
		const judged = (): string => {
			const reasons = briefingVerdictNow()
				.reasons.map((r) => r.code)
				.join(',');
			const ps = sigmetsRead ? planSigmetsNow() : null;
			const sigs = ps?.status === 'ok' ? ps.list.map((s) => s.id).join(',') : (ps?.status ?? '');
			// A flight landing in the past while the review waits: its paper
			// then states the past in the verdict's place (pastFlightNow).
			return `${reasons}|${sigs}|${pastFlight() ? 'past' : ''}`;
		};
		let judgedKey: string | null = null;
		const judgedMoved = (): boolean => judgedKey !== null && judged() !== judgedKey;
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
		const perfIdents = pages && live ? perfIcaos(orderedTrips(routes.list), flightPrep.perf.manualIcaos) : [];
		const wxIdents =
			annexStops.length + perfIdents.filter((i) => !annexStops.some((a) => a.icao === i)).length;
		// The overlay's step plan, in display order; counted steps advance
		// per settled unit. Every failure records an issue, which holds the
		// print in review before the dialog; printed anyway, the pack
		// carries the data that arrived.
		// The datasets the paper reads, one ensure each: the retries this
		// print asks for, and the ones it says are incomplete once it has read
		// them. The fleet and the airports for every sheet, the aerodrome fuel
		// for the refuelling plan on the four pages, the obstacles for the
		// profile sheets, the airspaces for every run with a route (the
		// profile sheets, and the briefing's verdict, which reads the RTBA
		// zones the plan crosses, with the FIR rings of a FIR-wide SIGMET),
		// the navaids for the dossier's nav logs.
		const read: RetryGroup[] = ['aircraft', 'airports'];
		if (pages) {
			read.push('fuel');
		}
		if (sheets) {
			read.push('obstacles');
		}
		if (printableRoutes.length > 0) {
			read.push('airspaces');
		}
		if (dossier) {
			read.push('navaids');
		}
		const plan: { kind: PrintStepKind; total?: number }[] = [{ kind: 'datasets', total: read.length }];
		if (sheets) {
			plan.push({ kind: 'msa', total: printableRoutes.length });
		}
		// Every run takes the forecast winds, which carry the fuel reserve,
		// the landing mass, every performance distance (flightprep/shared.ts)
		// and the profiles' times. Both packs take the aerodrome weather,
		// which carries the grid's QNH, temperature, wind and the runway they
		// select.
		if (printableRoutes.length > 0) {
			plan.push({ kind: 'wind', total: printableRoutes.length }, { kind: 'notams' });
		}
		if (sheets) {
			plan.push({ kind: 'terrain', total: printableRoutes.length });
		}
		if (wxIdents > 0) {
			plan.push({ kind: 'wx', total: wxIdents });
		}
		// The SIGMETs the flight meets, which the Overview's box B states.
		const sigmetsRead = pages && live && printableRoutes.length > 0;
		if (sigmetsRead) {
			plan.push({ kind: 'sigmets' });
		}
		if (dossier && live) {
			// The annex's order: the DWD front charts, then TEMSI / WINTEM.
			plan.push({ kind: 'fronts' }, { kind: 'charts' });
		}
		plan.push({ kind: 'pages' });
		const ctrl = new AbortController();
		const gen = beginPrintProgress(mode, plan, () => ctrl.abort());
		// A NOTAM fetch in flight replaces the briefing when it lands, so the
		// run waits for it, as the sheets wait for their datasets.
		const notamFetchLanded = async (): Promise<void> => {
			while (notamFetchBusy() && !printProgress.cancelled && gen === printProgress.gen) {
				await new Promise((res) => setTimeout(res, NOTAM_FETCH_POLL_MS));
			}
		};
		// The SUP AIP list a French trigger NOTAM is judged against (the
		// verdict's supaip reason, which waits for the list), read like a
		// dataset: its layer is off by default, and the app asks for it only
		// once a briefing holding one has landed.
		const supaipRead = async (): Promise<void> => {
			if (!briefingCitesFrSups()) {
				return;
			}
			try {
				await ensureSupaip();
			} catch {
				addPrintIssue(gen, { code: 'datasets' });
			}
		};
		// The run's start: the chart catalogs it reads are its own or this
		// fresh (sofiaChartsFor), and they are asked for now, beside the
		// dataset reads, so the chart step joins a request already under way.
		// None for a flight already behind us (the date says so before the
		// fleet is read; the timeline, after).
		const runStartMs = Date.now();
		if (dossier && live && !pastFlight(runStartMs)) {
			startChartCatalogs(printableRoutes, runStartMs);
		}
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
			// Ensure the datasets the paper reads (`read`) are present.
			// Awaited here rather than left to the page's own mount effect,
			// which cannot land before the snapshot: the marker would then be
			// on screen and off the paper. Printing is a gesture: every read
			// waiting for its retry is asked now, and awaited with the ensures
			// (a published dataset's ensure answers at once, whatever of it is
			// still being read): the datasets the paper reads, and only their
			// parts known to matter (RetryAsk).
			const retried = retryDataNow({ groups: read, wantedOnly: true });
			stepStart(gen, 'datasets');
			// Each wait here can take a stalled read's 30 s: raced against
			// Cancel, which the progress card offers from the first moment.
			await Promise.race([
				Promise.all([
					dsSettled(requireAircraftLibrary()),
					dsSettled(ensureAirports()),
					pages ? dsSettled(ensureAerodromeFuel('fr')) : null,
					retried,
				]),
				abortedPromise(ctrl.signal),
			]);
			if (printProgress.cancelled || gen !== printProgress.gen) {
				return; // cancelled while the datasets were read
			}
			// The plan's areas can have grown since the airports' first load (an
			// aerodrome added to the grid just before printing), and the map's
			// widening runs on its own time: wait for it here, so the sheet
			// prints that aerodrome's own AIP and not the worldwide baseline.
			await Promise.race([extendCoverage(), abortedPromise(ctrl.signal)]);
			if (printProgress.cancelled || gen !== printProgress.gen) {
				return; // cancelled while the coverage widened
			}
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
			const out: {
				wx: TripWxDoc | null;
				charts: TripChartsDoc | null;
				fronts: FrontChartsDoc | null;
			} = {
				wx: null,
				charts: null,
				fronts: null,
			};
			const msa: Record<string, (number | null)[]> = {};
			const terrain: Record<string, TerrainSample[]> = {};
			const groundFill: Record<string, TerrainSample[]> = {};
			const pts = (r: (typeof printableRoutes)[number]) =>
				r.waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));
			let obstacles: Awaited<ReturnType<typeof ensureObstacles>> = [];
			if (!sheets && printableRoutes.length > 0) {
				await Promise.race([dsSettled(ensureAirspaces()), abortedPromise(ctrl.signal)]);
			}
			if (sheets) {
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
					dossier ? dsSettled(ensureNavaids()) : null,
				]);
			}
			// A dataset that loaded with a country still missing (being read
			// again) settled as a success above: the sheet prints without that
			// country's rows, and says so.
			if (read.some(retryingGroup)) {
				addPrintIssue(gen, { code: 'datasets' });
			}
			// The flight these pages plan is already behind us (a stale date, or
			// an ETD whose timeline has landed): every sheet would answer for a
			// flight already flown. Judged once the fleet is read, which the
			// timeline needs.
			const past = pastFlight();
			if (past) {
				addPrintIssue(gen, { code: 'flight-past', ...past });
			}
			stepStart(gen, 'msa');
			stepStart(gen, 'wind');
			stepStart(gen, 'notams');
			stepStart(gen, 'terrain');
			stepStart(gen, 'wx');
			stepStart(gen, 'sigmets');
			stepStart(gen, 'fronts');
			stepStart(gen, 'charts');
			// Every run fetches the winds, and both packs the weather. The
			// profile sheets add each route's MSA and terrain, and the dossier
			// the chart annex. A failure degrades one sheet (blank MSA cells,
			// no terrain silhouette, estimated weather) instead of aborting the
			// pack. The MSA fallback must be nulls, not undefined, or the sheet
			// would start its own async fetch mid-print.
			const tasks: Promise<unknown>[] = [
				// Forecast winds for every printed sheet, schedule and profile, so
				// paper matches screen. The ensure settles its failures as states
				// and never rejects, so the notice that the manual wind applies
				// reads the state it settled; the catch is a belt for a throw.
				...printableRoutes.map((r) =>
					ensureRouteWindFor(r, { retry: true })
						.then(() => {
							const missing = routeForecastMissing(r);
							if (missing) {
								addPrintIssue(gen, { code: missing === 'manual' ? 'wind' : 'wind-blank' });
							}
							stepAdvance(gen, 'wind', !missing);
						})
						.catch(() => {
							addPrintIssue(gen, { code: 'wind' });
							stepAdvance(gen, 'wind', false);
						}),
				),
			];
			if (printableRoutes.length > 0) {
				// Every sheet reads the NOTAM briefing: the four pages' runways,
				// fuel and box C, the profiles' crossings, the dossier's
				// bulletin. A fetch in flight lands first, then the run fetches
				// for the flight when a fetch would cure the verdict
				// (state/briefingFetch.ts). The step reads the verdict it left.
				// A flight already flown asks for none: a fetch would brief from
				// the present and replace the briefing kept for it.
				tasks.push(
					notamFetchLanded()
						.then(() =>
							printProgress.cancelled || gen !== printProgress.gen || past ? 'skipped' : ensureBriefing(),
						)
						.then(supaipRead)
						.then(
							() => stepEnd(gen, 'notams', briefingVerdictNow().reasons.length === 0),
							() => stepEnd(gen, 'notams', false),
						),
				);
			}
			if (sigmetsRead) {
				// A set older than its 5 min is asked again, and so is one an
				// attempt failed. The step reads whether the plan could be
				// judged (planSigmetsNow).
				tasks.push(
					sigmetsSettled().then(
						() => stepEnd(gen, 'sigmets', planSigmetsNow().status !== 'unknown'),
						() => stepEnd(gen, 'sigmets', false),
					),
				);
			}
			if (perfIdents.length > 0) {
				// The forecast at the performance columns' instants, for those
				// the METAR does not speak for (runwayPerf.ts wxPick), into the
				// session cache the page reads: the sheet must not start a fetch
				// that cannot land before the snapshot. Never rejects.
				const instantAt = perfInstants(fuelComputation());
				tasks.push(
					ensurePerfForecasts(
						perfIdents.flatMap((icao) =>
							(['takeoff', 'landing'] as const).map((phase) => ({ icao, atMs: instantAt(icao, phase) })),
						),
						{ retry: true },
					),
				);
			}
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
			if (sheets) {
				tasks.push(
					...printableRoutes.map(async (r) => {
						// Read once: the fold must take the points its ground
						// was computed for.
						const p = pts(r);
						try {
							// One corridor pass per route: the MSA column and the
							// profile's drawn ground both fold it, so paper shows
							// the same ground the screen does.
							const opts = {
								halfWidthNM: routeSettings.minAltCorridorRadiusNM,
								vfr: routeSettings.vfr,
								signal: ctrl.signal,
							};
							const ground = await computeCorridorGround(p, opts);
							msa[r.id] = minAltitudesFrom(p, obstacles, ground, opts);
							groundFill[r.id] = ground.stations.map((st) => ({
								distNM: st.distNM,
								elevFt: st.maxFt,
								minFt: st.minFt,
								maxFt: st.maxFt,
							}));
							stepAdvance(gen, 'msa');
						} catch {
							msa[r.id] = new Array<number | null>(p.length - 1).fill(null);
							addPrintIssue(gen, { code: 'msa' });
							stepAdvance(gen, 'msa', false);
						}
					}),
					...printableRoutes.map(async (r) => {
						try {
							terrain[r.id] = await sampleProfile(pts(r), { signal: ctrl.signal });
							stepAdvance(gen, 'terrain');
						} catch {
							terrain[r.id] = [];
							addPrintIssue(gen, { code: 'terrain' });
							stepAdvance(gen, 'terrain', false);
						}
					}),
					// Every printed profile draws the cloud curtain, whose columns
					// only it and the screen's profile ask for. One that fails
					// leaves the curtain off the sheet, as on the screen.
					...printableRoutes.map((r) => ensureRouteCloudsFor(r, { retry: true })),
				);
			}
			if (dossier && live) {
				// The flight-relevant TEMSI / WINTEM charts (fetchChartsForPrint
				// never rejects; failures print as note lines). Needs the
				// airspaces awaited above for the FRANCE / EUROC zone pick.
				tasks.push(
					(async () => {
						if (past) {
							// No chart is asked for a flight already flown:
							// the notes sheet says why there is none.
							stepEnd(gen, 'charts', false);
							out.charts = pastChartsDoc(past);
							return;
						}
						const doc = await fetchChartsForPrint(printableRoutes, {
							runStartMs,
							signal: ctrl.signal,
							onProgress: (done, total, current) =>
								stepSet(gen, 'charts', { done, total, param: current }),
						});
						const issues = chartIssues(doc);
						for (const issue of issues) {
							addPrintIssue(gen, issue);
						}
						stepEnd(gen, 'charts', issues.length === 0);
						out.charts = doc;
					})(),
					// The DWD front charts that open the annex, over the same
					// flight window and the same TEMSI catalogs, its forecasts
					// only while no TEMSI serves the flight's start
					// (fetchFrontsForPrint never rejects; its degradations print
					// beside the charts). Nothing is asked for a flight already
					// flown, whose one issue is said above.
					(async () => {
						if (past) {
							stepEnd(gen, 'fronts', false);
							return;
						}
						const fronts = await fetchFrontsForPrint(printableRoutes, {
							runStartMs,
							signal: ctrl.signal,
							onProgress: (done, total, current) =>
								stepSet(gen, 'fronts', { done, total, param: current }),
						});
						const frontProblems = frontIssues(fronts);
						for (const issue of frontProblems) {
							addPrintIssue(gen, issue);
						}
						stepEnd(gen, 'fronts', frontProblems.length === 0);
						out.fronts = fronts;
					})(),
				);
			}
			// Cancel races the prefetch: the signal stops MSA / terrain / the
			// chart loop, the rest settles into the locals above, and the
			// post-race check skips the print and the doc* writes.
			await Promise.race([Promise.all(tasks), abortedPromise(ctrl.signal)]);
			if (printProgress.cancelled || gen !== printProgress.gen) {
				return; // cancelled during the prefetch, print nothing
			}
			if (planMoved()) {
				again = true;
				return; // no review of what another plan raised
			}
			// A briefing short of the flight holds the print, in every mode:
			// judged once a fetch the pilot started meanwhile has landed, with
			// the SUP AIP list it cites.
			await notamFetchLanded();
			await Promise.race([supaipRead(), abortedPromise(ctrl.signal)]);
			if (printProgress.cancelled || gen !== printProgress.gen) {
				return; // cancelled while the briefing was fetched
			}
			// A flight already flown holds on that alone: the verdict and the
			// SIGMETs judge the flight from the present on (briefingWindow).
			if (!past) {
				const verdict = briefingVerdictNow();
				if (verdict.reasons.length > 0) {
					addPrintIssue(gen, { code: 'notams', reasons: verdict.reasons, source: verdict.source });
				}
				// A SIGMET the flight meets is said before the paper states it,
				// and so is a feed that never answered.
				if (sigmetsRead) {
					const ps = planSigmetsNow();
					if (ps.status === 'unknown') {
						addPrintIssue(gen, { code: 'sigmets-unknown' });
					} else if (ps.status === 'ok' && ps.list.length > 0) {
						addPrintIssue(gen, { code: 'sigmets', list: ps.list, fromMs: ps.fromMs });
					}
				}
			}
			briefGen = briefingGeneration();
			judgedKey = past ? null : judged();
			// A timed performance column that the forecast did not answer and
			// no METAR speaks for (within two hours before its instant: the
			// one just fetched, else the one the session holds) prints on an
			// older observation or the estimates (runwayPerf.ts wxPick): a
			// loss like any other, said before the dialog.
			if (perfIdents.length > 0) {
				const instantAt = perfInstants(fuelComputation());
				const nowMs = Date.now();
				for (const icao of perfIdents) {
					const fetched = out.wx?.entries.find((e) => e.icao === icao && e.status === 'ok')?.pick;
					const obsMs = (fetched ?? usableNearest(nearestWx(icao), nowMs))?.metar.obsTime;
					const lacking = (['takeoff', 'landing'] as const).some((phase) => {
						const at = instantAt(icao, phase);
						return at !== null && !aerodromeForecastAt(icao, at) && !(obsMs != null && at - obsMs * 1000 <= METAR_VALID_MS);
					});
					if (lacking) {
						addPrintIssue(gen, { code: 'perf-forecast', param: icao });
					}
				}
			}
			// Anything missing holds the print here, before the dialog, for the
			// pilot to decide: print anyway, retry the whole prefetch, or cancel.
			if (printProgress.issues.length > 0) {
				const decision = await awaitPrintDecision(gen);
				if (decision === 'retry') {
					again = true;
				}
				if (decision !== 'print') {
					return;
				}
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
			if (sheets) {
				docMsa = msa;
				docTerrain = terrain;
				docGroundFill = groundFill;
			}
			if (dossier) {
				// The annex prints the trip chain's own stops; the grid's extra
				// aerodromes rode the same pass but have no card.
				docWx = out.wx
					? {
							fetchedAtMs: out.wx.fetchedAtMs,
							entries: out.wx.entries.filter((e) => annexStops.some((a) => a.icao === e.icao)),
						}
					: null;
				docCharts = out.charts;
				docFronts = out.fronts;
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
					const m = await measureNavlogCards(r, msa[r.id], KNEEBOARD_CARD);
					if (m) {
						meas[r.id] = measuredChunks(m, KNEEBOARD_CARD);
						pads[r.id] = measuredMinWaypoints(m, r.waypoints.length);
						partPads[r.id] = measuredCardPads(m, meas[r.id]);
					}
					const sm = await measureScheduleCards(r, KNEEBOARD_CARD, {
						heading: routeTitle(r),
					});
					if (sm) {
						schedMeas[r.id] = measuredScheduleChunks(sm, KNEEBOARD_CARD);
					}
				}
				docMeasured = meas;
				docPad = pads;
				docPartPads = partPads;
				docSchedMeasured = schedMeas;
			}
			if (printProgress.cancelled || gen !== printProgress.gen) {
				// Cancelled during the prefetch: nothing mounts, so the multi-MB
				// chart images are not held until the next print.
				docCharts = null;
				docFronts = null;
				return;
			}
			stepStart(gen, 'pages');
			// The M&B sheets two to a landscape sheet where both fit, measured
			// at the sheet's own width before the doc mounts.
			const tripCount = fuelComputation().inputs.length;
			docMbBlocks = pages && tripCount > 1 ? await measureMbBlocks(tripCount) : null;
			if (printProgress.cancelled || gen !== printProgress.gen) {
				docCharts = null;
				docFronts = null;
				return;
			}
			if (planMoved() || briefingMoved() || judgedMoved()) {
				docCharts = null;
				docFronts = null;
				again = true;
				return; // edited, briefed or judged again during the review or the measures
			}
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
				resetPrintMode(gen); // cancelled during the layout settle
				return;
			}
			if (planMoved() || briefingMoved() || judgedMoved()) {
				resetPrintMode(gen);
				again = true;
				return; // edited, briefed or judged again during the layout settle
			}
			window.addEventListener(
				'afterprint',
				() => {
					resetPrintMode(gen);
					packPrint.preparing = false;
				},
				{ once: true },
			);
			started = true;
			// This flow prints a document of its own, so the user-print claim
			// must stay out of its way (surfacePrint).
			markDocumentPrint(planPrintStem(PRINT_KIND[mode]));
			printPage(DOCUMENT_ORIENTATION);
			// The card's work ends at the hand-off. In the Android shell the
			// job outlasts the dialog while the printer works through it, and
			// the app stays usable meanwhile, every print row standing down
			// on the job (printBusy).
			settlePrintProgress(gen);
		} finally {
			if (!started) {
				packPrint.preparing = false;
			}
			if (again) {
				// Reaches beginPrintProgress before its first await, so the card
				// resets in place with no frame showing an idle host.
				void printPack(mode);
			}
		}
	}
</script>

{#if printMode !== null}
	<div use:portal>
		<PrintDoc
			mode={printMode}
			{printableRoutes}
			msaByRoute={docMsa}
			terrainByRoute={docTerrain}
			groundFillByRoute={docGroundFill}
			tripWx={docWx}
			tripCharts={docCharts}
			frontCharts={docFronts}
			measuredChunks={docMeasured}
			measuredPad={docPad}
			measuredPartPads={docPartPads}
			schedMeasured={docSchedMeasured}
			mbBlocks={docMbBlocks}
			{wideFuel}
		/>
	</div>
{/if}

<PrintProgress modes={['prep', 'dossier', 'profiles']} />
