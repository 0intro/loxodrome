<script lang="ts">
	/* Print-only host for the Weather tab's standalone briefing: the meteo
	 * part of the flight dossier (METAR / TAF cards, then the flight-relevant
	 * TEMSI and WINTEM charts), printed without opening the flight-prep
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
	import { ensureAircraftLibrary } from '$lib/state/aircraft.svelte';
	import { ensureAirports, ensureAirspaces } from '$lib/state/data.svelte';
	import { orderedTrips, orphanAlternates } from '$lib/aircraft/trips';
	import { tripWxStops } from '$lib/aircraft/aerodromes';
	import { fetchTripWx, type TripWxDoc } from '$lib/weather/tripWx';
	import type { TripChartsDoc } from '$lib/weather/tripCharts';
	import { fetchChartsForPrint } from './flightprep/chartsPrefetch';

	const printableRoutes = $derived(routes.list.filter((r) => r.waypoints.length >= 2));

	let docWx = $state<TripWxDoc | null>(null);
	let docCharts = $state<TripChartsDoc | null>(null);
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
			plan.push({ kind: 'charts' }, { kind: 'pages' });
			const ctrl = new AbortController();
			// The card's Cancel also stands this host down (cancelWxPrint), the
			// same flag a portaled modal opening flips; the effect below then
			// drops the card in the opposite direction.
			const gen = beginPrintProgress('wx', plan, () => {
				ctrl.abort();
				cancelWxPrint();
			});
			stepStart(gen, 'datasets');
			const dsSettled = (p: Promise<unknown>): Promise<void> =>
				p.then(
					() => stepAdvance(gen, 'datasets'),
					() => {
						addPrintIssue(gen, { code: 'datasets' });
						stepAdvance(gen, 'datasets', false);
					},
				);
			await Promise.all([
				dsSettled(ensureAircraftLibrary()), // the dossier timeline reads the fleet's fuel data
				dsSettled(ensureAirports()), // wx card airport names
				dsSettled(ensureAirspaces()), // the FRANCE / EUROC zone pick
			]);
			stepStart(gen, 'wx');
			stepStart(gen, 'charts');
			// An object holder, not two lets: TS cannot see the closure writes
			// and would narrow plain lets to null (never past a != null guard).
			const out: { wx: TripWxDoc | null; charts: TripChartsDoc | null } = {
				wx: null,
				charts: null,
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
						const doc = await fetchChartsForPrint(routesNow, {
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
				]),
				abortedPromise(ctrl.signal),
			]);
			if (!wxPrint.preparing || printProgress.cancelled || gen !== printProgress.gen) {
				return; // cancelled during the prefetch (a portaled modal opened)
			}
			const anything =
				(out.wx != null && out.wx.entries.length > 0) ||
				(out.charts != null &&
					(out.charts.entries.length > 0 ||
						out.charts.notes.length > 0 ||
						out.charts.failedCount > 0 ||
						out.charts.catalogError));
			if (!anything) {
				wxPrint.note = 'empty';
				closePrintProgress();
				return;
			}
			docWx = out.wx;
			docCharts = out.charts;
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
				resetPrint(); // cancelled during the layout settle
				closePrintProgress();
				return;
			}
			window.addEventListener('afterprint', resetPrint, { once: true });
			// This flow prints a document of its own, so the user-print claim
		// must stay out of its way (surfacePrint).
		markDocumentPrint(planPrintStem('weather'));
		printPage(DOCUMENT_ORIENTATION);
		} finally {
			wxPrint.preparing = false;
		}
	}

	function resetPrint(): void {
		printing = false;
		docWx = null;
		docCharts = null;
		// After the print dialog closes: summary card when anything degraded.
		settlePrintProgress();
	}

	// A portaled modal opening cancels a pending briefing print by flipping
	// wxPrint.preparing (cancelWxPrint); drop this host's card right away
	// rather than when the abandoned prefetch settles. The post-print summary
	// (preparing already false, printing reset) stays until its Close.
	$effect(() => {
		if (
			!wxPrint.preparing &&
			!printing &&
			printProgress.active &&
			printProgress.mode === 'wx' &&
			!printProgress.summary
		) {
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
