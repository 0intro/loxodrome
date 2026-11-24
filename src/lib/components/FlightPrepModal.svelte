<script lang="ts">
	/* The flight-preparation modal: four printable pages (Overview, Fuel
	 * plan, Mass & balance, Performance) over the drawn routes and the
	 * selected aircraft. Follows the NavLogModal skeleton: portal + focus
	 * trap, Escape to close, html.flight-prep-print isolation while open, a
	 * static portrait @page with a landscape override injected for the
	 * overview and performance pages. The header's printer (the shell's,
	 * pinned) prints the four pages (PackPrintHost, all-landscape, since one
	 * job allows one orientation), and the browser's own print the page on
	 * screen. The flight dossier prints from the toolbar's printer, the
	 * weather briefing from the Weather tab. */

	import Icon from './Icon.svelte';
	import PageTabs from './PageTabs.svelte';
	import SurfaceShell from './SurfaceShell.svelte';
	import { planPrintStem } from '$lib/state/printName';
	import DossierPage from './flightprep/DossierPage.svelte';
	import FuelPlanPage from './flightprep/FuelPlanPage.svelte';
	import MassBalancePage from './flightprep/MassBalancePage.svelte';
	import PerformancePage from './flightprep/PerformancePage.svelte';
	import {
		flightPrepModal,
		closeFlightPrep,
		type FlightPrepPage,
	} from '$lib/state/flightPrepModal.svelte';
	import {
		aircraftLabel,
		aircraftState,
		selectedAircraft,
		ensureAircraftLibrary,
	} from '$lib/state/aircraft.svelte';
	import { dataState, ensureAirports } from '$lib/state/data.svelte';
	import { requestPackPrint } from '$lib/state/packPrint.svelte';
	import { fuelComputation, tripLoadsComputation } from './flightprep/shared';
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

	/* A NO on a page dots its tab, so a pilot on another page sees it: the
	   fuel verdicts on the fuel plan and the M&B page, the limits on the M&B
	   page. Read only while the header renders (the shell gates it on the
	   surface being open), so a closed workbook computes nothing. */
	const fuelNow = $derived(fuelComputation());
	const verdictLoads = $derived(tripLoadsComputation(fuelNow)?.loads ?? null);
	/** From five trips the fuel page's tables cannot fit a portrait sheet:
	 *  its own print turns landscape, and the packs widen its column. */
	const wideFuel = $derived(fuelNow.inputs.length >= 5);
	const fuelNo = $derived(verdictLoads?.fuelSufficient === false);
	const mbNo = $derived(fuelNo || verdictLoads?.withinLimits === false);

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
	 * strip. Read at claim time, so it reports the page actually showing. */
	// i18n-ignore: injected print CSS, not user-visible text
	const LANDSCAPE_PAGE = '@media print { @page { size: A4 landscape; margin: 0; } }';

	function pageCss(): string | null {
		const landscape =
			flightPrepModal.page === 'perf' ||
			flightPrepModal.page === 'dossier' ||
			(flightPrepModal.page === 'fuel' && wideFuel);
		return landscape ? LANDSCAPE_PAGE : null;
	}

	const aircraft = $derived(selectedAircraft());
	const unknownKey = $derived(aircraftState.selectedKey !== null && aircraft === null);

	function goToAircraftTab(): void {
		closeFlightPrep();
		selectTab('aircraft');
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
	actionsLabel={t.flightprep.printPrep}
	onPrint={() => requestPackPrint('prep')}
>
	{#snippet header()}
		<h2>{t.flightprep.title}</h2>
		{#snippet verdictDot(id: FlightPrepPage)}
			{#if ((id === 'mb' && mbNo) || (id === 'fuel' && fuelNo)) && flightPrepModal.page !== id}
				<span class="dot" aria-hidden="true" title={t.flightprep.verdictDotSr}></span>
				<span class="sr-only">{t.flightprep.verdictDotSr}</span>
			{/if}
		{/snippet}
		<PageTabs
			pages={PAGES}
			current={flightPrepModal.page}
			onSelect={(id: FlightPrepPage) => (flightPrepModal.page = id)}
			ariaLabel={t.flightprep.pagesAria}
			labelFor={pageLabel}
			badge={verdictDot}
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
					? t.flightprep.unknownChipTip(aircraftLabel(aircraftState.selectedKey ?? ''))
					: t.flightprep.selectAircraftTip}
				onclick={goToAircraftTab}
			>
				<Icon name="plane" size={13} />
				{unknownKey ? `${aircraftLabel(aircraftState.selectedKey ?? '')}?` : t.flightprep.noAircraft}
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

	/* On a phone the window IS the screen, which is margin enough: 8 px of
	   air rather than 16, given back to the pages (docs/workspace-surfaces.md
	   "Phones"). Screen only: paper keeps its own 12 mm. */
	@media screen {
		:global(:root.mobile-ui) .body {
			padding: 8px;
		}
	}

	/* A page tab's verdict dot (a NO on that page), the aircraft editor's
	   error dot. */
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 999px;
		background: var(--danger);
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

		/* Global: the pages' own on-screen controls (add-aerodrome, remove
		   buttons) carry .no-print too, beyond this component's scope. */
		:global(html.flight-prep-print .no-print) {
			display: none !important;
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

			/* Inks ride the shared paper palette on this box (app.css), the
			   workbook orange included: paper prints the day ink, the sheet's
			   own lighter orange having printed pale. The page itself is
			   white by app.css's rule for every flow. */
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
