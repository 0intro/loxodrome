<script lang="ts">
	/* Print-only host for the Weather tab's standalone briefing: the meteo
	 * part of the flight dossier (METAR / TAF cards, then the DWD front charts
	 * and the flight-relevant TEMSI and WINTEM charts), printed without opening the flight-prep
	 * modal. Mounted once in App; each requestWxPrint bump prefetches like
	 * FlightPrepModal.printPack's dossier branch, mounts PrintDoc in wx mode
	 * through the shared portal (outside #app, which the print isolation
	 * hides), prints, and clears. Isolation classes: its own html.wx-print
	 * (two generic rules in app.css, the global-.no-print rationale) plus
	 * flight-prep-doc, PrintDoc's activation contract; NOT flight-prep-print
	 * (owned by the flight-prep modal's open effect, which would strip it)
	 * and NOT navlog-kneeboard (no nav-log cards here). */

	import { tick } from 'svelte';
	import { markDocumentPrint } from '$lib/ui/surfacePrint.svelte';
	import { planPrintStem } from '$lib/state/printName';
	import { printPage } from '$lib/ui/print';
	import { DOCUMENT_ORIENTATION, installDocumentPageCss } from '$lib/ui/printJob';
	import PrintDoc from './flightprep/PrintDoc.svelte';
	import PrintProgress from './flightprep/PrintProgress.svelte';
	import { portal } from '$lib/ui/portal';
	import { wxPrint, cancelWxPrint } from '$lib/state/wxPrint.svelte';
	import {
		abortedPromise,
		addPrintIssue,
		awaitPrintDecision,
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
	import { routes } from '$lib/state/route.svelte';
	import { display } from '$lib/state/display.svelte';
	import { requireAircraftLibrary } from '$lib/state/aircraft.svelte';
	import { ensureAirports, ensureAirspaces, extendCoverage } from '$lib/state/data.svelte';
	import { retryDataNow, retryingGroup, type RetryGroup } from '$lib/state/dataRetry.svelte';
	import { orderedTrips, orphanAlternates } from '$lib/aircraft/trips';
	import { tripWxStops } from '$lib/aircraft/aerodromes';
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

	const printableRoutes = $derived(routes.list.filter((r) => r.waypoints.length >= 2));

	/** The datasets this paper reads: the fleet (the dossier timeline's
	 *  fuel data), the airports (the cards' names) and the airspaces (the
	 *  FRANCE / EUROC zone pick). */
	const WX_PRINT_READS: readonly RetryGroup[] = ['aircraft', 'airports', 'airspaces'];

	let docWx = $state<TripWxDoc | null>(null);
	let docCharts = $state<TripChartsDoc | null>(null);
	let docFronts = $state<FrontChartsDoc | null>(null);
	let printing = $state(false);

	// One job per requestWxPrint bump; the microtask escapes the effect's
	// tracking context, so the job's own state writes can't re-trigger it.
	let lastSeq = 0;
	$effect(() => {
		const seq = wxPrint.seq;
		if (seq !== lastSeq) {
			lastSeq = seq;
			queueMicrotask(() => void run());
		}
	});

	async function run(): Promise<void> {
		if (wxPrint.preparing || printing) {
			return;
		}
		wxPrint.preparing = true;
		// A review's Retry: this run returns and runs again from the finally.
		let again = false;
		try {
			const routesNow = printableRoutes;
			if (!display.liveWeather || routesNow.length === 0) {
				wxPrint.note = 'empty';
				return;
			}
			const stops = tripWxStops(orderedTrips(routesNow), orphanAlternates(routesNow));
			const plan: { kind: PrintStepKind; total?: number }[] = [{ kind: 'datasets', total: 3 }];
			if (stops.length > 0) {
				plan.push({ kind: 'wx', total: stops.length });
			}
			plan.push({ kind: 'fronts' }, { kind: 'charts' }, { kind: 'pages' });
			const ctrl = new AbortController();
			// The card's Cancel also stands this host down (cancelWxPrint), the
			// same flag a portaled modal opening flips; the effect below then
			// drops the card in the opposite direction.
			const gen = beginPrintProgress('wx', plan, () => {
				ctrl.abort();
				cancelWxPrint();
			});
			// The run's start (sofiaChartsFor), and its catalogs asked for now,
			// beside the dataset reads; none for a flight already behind us.
			const runStartMs = Date.now();
			if (!pastFlight(runStartMs)) {
				startChartCatalogs(routesNow, runStartMs);
			}
			// Printing is a gesture: every read waiting for its retry is asked
			// now, and awaited with the ensures (a published dataset's ensure
			// answers at once, whatever of it is still being read): the
			// datasets this paper reads, and only their parts known to matter
			// (RetryAsk).
			const retried = retryDataNow({ groups: WX_PRINT_READS, wantedOnly: true });
			stepStart(gen, 'datasets');
			const dsSettled = (p: Promise<unknown>): Promise<void> =>
				p.then(
					() => stepAdvance(gen, 'datasets'),
					() => {
						addPrintIssue(gen, { code: 'datasets' });
						stepAdvance(gen, 'datasets', false);
					},
				);
			// Each wait here can take a stalled read's 30 s: raced against
			// Cancel, which the progress card offers from the first moment.
			await Promise.race([
				Promise.all([
					dsSettled(requireAircraftLibrary()), // the dossier timeline reads the fleet's fuel data
					dsSettled(ensureAirports()), // wx card airport names
					dsSettled(ensureAirspaces()), // the FRANCE / EUROC zone pick
					retried,
				]),
				abortedPromise(ctrl.signal),
			]);
			// The plan's countries, which the map widens to on its own time:
			// the zone pick and the card names read them.
			if (!printProgress.cancelled && gen === printProgress.gen) {
				await Promise.race([extendCoverage(), abortedPromise(ctrl.signal)]);
			}
			if (!wxPrint.preparing || printProgress.cancelled || gen !== printProgress.gen) {
				return; // cancelled while the datasets were read
			}
			// A dataset loaded with a country still missing settled as a success.
			if (WX_PRINT_READS.some(retryingGroup)) {
				addPrintIssue(gen, { code: 'datasets' });
			}
			// The flight the briefing is for is already behind us: its charts
			// would be for a flight already flown (the fleet is read now, which
			// the dossier timeline needs).
			const past = pastFlight();
			if (past) {
				addPrintIssue(gen, { code: 'flight-past', ...past });
			}
			stepStart(gen, 'wx');
			stepStart(gen, 'fronts');
			stepStart(gen, 'charts');
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
			await Promise.race([
				Promise.all([
					...(stops.length > 0
						? [
								(async () => {
									const doc = await fetchTripWx(stops, (done, total) =>
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
							]
						: []),
					(async () => {
						if (past) {
							// No chart is asked for a flight already flown: the
							// notes sheet says why there is none.
							stepEnd(gen, 'charts', false);
							out.charts = pastChartsDoc(past);
							return;
						}
						const doc = await fetchChartsForPrint(routesNow, {
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
					// only while no TEMSI serves the flight's start; nothing
					// asked for a flight already flown.
					(async () => {
						if (past) {
							stepEnd(gen, 'fronts', false);
							return;
						}
						const fronts = await fetchFrontsForPrint(routesNow, {
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
				]),
				abortedPromise(ctrl.signal),
			]);
			if (!wxPrint.preparing || printProgress.cancelled || gen !== printProgress.gen) {
				return; // cancelled during the prefetch (a portaled modal opened)
			}
			const anything =
				(out.wx != null && out.wx.entries.length > 0) ||
				(out.fronts != null &&
					(out.fronts.entries.length > 0 ||
						out.fronts.notes.length > 0 ||
						out.fronts.failed.length > 0)) ||
				(out.charts != null &&
					(out.charts.past != null ||
						out.charts.entries.length > 0 ||
						out.charts.notes.length > 0 ||
						out.charts.failed.length > 0 ||
						out.charts.catalogFailures.length > 0));
			if (!anything) {
				wxPrint.note = 'empty';
				closePrintProgress();
				return;
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
			docWx = out.wx;
			docCharts = out.charts;
			docFronts = out.fronts;
			stepStart(gen, 'pages');
			printing = true;
			await tick();
			// One frame for layout, then the chart images' decode: a print
			// snapshot of a not-yet-decoded data-URL img is blank.
			await new Promise((res) => requestAnimationFrame(() => res(undefined)));
			await Promise.allSettled(
				// i18n-ignore: CSS selector, not user-visible text
				Array.from(document.querySelectorAll<HTMLImageElement>('.fpd-doc img'), (img) =>
					img.decode(),
				),
			);
			stepEnd(gen, 'pages', true);
			if (!wxPrint.preparing || printProgress.cancelled || gen !== printProgress.gen) {
				resetPrint(gen); // cancelled during the layout settle
				closePrintProgress();
				return;
			}
			window.addEventListener('afterprint', () => resetPrint(gen), { once: true });
			// This flow prints a document of its own, so the user-print claim
			// must stay out of its way (surfacePrint).
			markDocumentPrint(planPrintStem('weather'));
			printPage(DOCUMENT_ORIENTATION);
		} finally {
			wxPrint.preparing = false;
			if (again) {
				// Reaches beginPrintProgress before its first await, so the card
				// resets in place and the effect below never sees an idle host.
				void run();
			}
		}
	}

	function resetPrint(gen: number): void {
		printing = false;
		docWx = null;
		docCharts = null;
		docFronts = null;
		// After the print dialog closes: drop the overlay (whatever degraded
		// was read in the review, before the paper).
		settlePrintProgress(gen);
	}

	// A portaled modal opening cancels a pending briefing print by flipping
	// wxPrint.preparing (cancelWxPrint); drop this host's card right away
	// rather than when the abandoned prefetch settles. A review holds with
	// preparing still set, so this answers it as a Cancel too.
	$effect(() => {
		if (!wxPrint.preparing && !printing && printProgress.active && printProgress.mode === 'wx') {
			requestPrintCancel();
			closePrintProgress();
		}
	});

	// While printing, tag <html> (the wx-print isolation in app.css plus the
	// flight-prep-doc rules PrintDoc keys on) and inject the landscape @page
	// (installDocumentPageCss).
	$effect(() => {
		if (!printing) {
			return;
		}
		return installDocumentPageCss(['wx-print', 'flight-prep-doc']);
	});
</script>

{#if printing}
	<div use:portal>
		<PrintDoc
			mode="wx"
			{printableRoutes}
			msaByRoute={{}}
			terrainByRoute={{}}
			groundFillByRoute={{}}
			tripWx={docWx}
			tripCharts={docCharts}
			frontCharts={docFronts}
		/>
	</div>
{/if}

<!-- The progress card, portaled full-screen (no surrounding dialog, so the
     standalone variant brings its own role + focus trap). Mounted only while
     shown: the fixed full-viewport wrapper would otherwise eat clicks.
     `no-print`: under html.wx-print only #app is hidden and the portal sits
     outside it. -->
{#if printProgress.active && printProgress.mode === 'wx'}
	<div class="wx-progress no-print" use:portal>
		<PrintProgress modes={['wx']} standalone />
	</div>
{/if}

<style>
	.wx-progress {
		position: fixed;
		inset: 0;
		z-index: 1100;
	}
</style>
