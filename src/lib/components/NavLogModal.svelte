<script lang="ts">
	import { tick } from 'svelte';
	import Icon from './Icon.svelte';
	import SurfaceShell from './SurfaceShell.svelte';
	import NavLogColumnsPopover from './NavLogColumnsPopover.svelte';
	import { markDocumentPrint, printSurface } from '$lib/ui/surfacePrint.svelte';
	import { planPrintStem, routePrintStem } from '$lib/state/printName';
	import { printPage } from '$lib/ui/print';
	import { DOCUMENT_ORIENTATION, installDocumentPageCss } from '$lib/ui/printJob';
	import RouteSwitcher from './RouteSwitcher.svelte';
	import NavLogSheet from './NavLogSheet.svelte';
	import NavLogSchedule from './NavLogSchedule.svelte';
	import { airspaceNavigator } from './featureHover.svelte';
	import {
		cardKey,
		estimatorCardChunks,
		expandCards,
		pairCards,
		type RouteCard,
	} from './navlogCards';
	import {
		measureKneeboardCards,
		measureScheduleCards,
		measuredCardPads,
		measuredChunks,
		measuredMinWaypoints,
		measuredScheduleChunks,
	} from './navlogMeasure';
	import { isEditableTarget } from '$lib/ui/focus';
	import { t } from '$lib/state/i18n.svelte';
	import { navLogModal, closeNavLog } from '$lib/state/navLogModal.svelte';
	import {
		activeRoute,
		routes,
		routeSettings,
		stepActiveRoute,
		type Route,
		type Waypoint,
	} from '$lib/state/route.svelte';
	import { routeTitle } from '$lib/route/routeLabel';
	import type { Obstacle } from '$lib/data/obstacles';
	import { computeMinAltitudes } from '$lib/route/minAltitude';
	import { ensureRouteWindFor } from '$lib/state/routeWind.svelte';
	import {
		ensureAirspaces,
		ensureAirports,
		ensureNavaids,
		ensureObstacles,
		dataState,
		airportByIdent,
	} from '$lib/state/data.svelte';
	import { contactRadios } from '$lib/data/airports';
	import { selectAirport, selectNavaid, ui } from '$lib/state/ui.svelte';
	import { surfaceKeepsMapVisible } from '$lib/state/workspace.svelte';
	import { navLiveFor } from '$lib/state/navLive.svelte';
	import { flyToVisible } from '$lib/map/focus';
	import { mapState } from '$lib/state/map.svelte';

	// The merged live overlay (navigation mode) for the route ON SCREEN, not
	// for the one being flown: a plan of consecutive routes keeps every flown
	// route's stamps, so paging back through the switcher shows that route's
	// own completed plog rather than the current one's overlaid on it.
	// Screen-only in spirit; the modal's plain print consequently prints what
	// the screen shows (a stamped post-flight record, schedule included),
	// while the kneeboard / dossier mounts below never receive it.
	const liveInfo = $derived(navLiveFor(activeRoute().id));

	// Load airspaces (for the schedule), airports (for the per-report frequencies)
	// and navaids (for the radials) when the modal opens, so the sheets work
	// without a fetch.
	$effect(() => {
		if (navLogModal.open && !dataState.airspacesLoaded) {
			void ensureAirspaces().catch(() => {
				/* error surfaced via dataState.airspacesError */
			});
		}
		if (navLogModal.open && !dataState.airportsLoaded) {
			void ensureAirports().catch(() => {
				/* error surfaced via dataState.airportsError */
			});
		}
		if (navLogModal.open && !dataState.navaidsLoaded) {
			void ensureNavaids().catch(() => {
				/* error surfaced via dataState.navaidsError */
			});
		}
	});

	// Isolate the modal for printing: while open, tag <html> so the print
	// stylesheet hides the rest of the app. Closed -> a normal Ctrl+P prints
	// the app as usual (rules are scoped under html.navlog-print).
	$effect(() => {
		const el = document.documentElement;
		if (navLogModal.open) {
			el.classList.add('navlog-print');
		} else {
			el.classList.remove('navlog-print');
		}
		return () => el.classList.remove('navlog-print');
	});

	const activeEnough = $derived(activeRoute().waypoints.length >= 2);

	// Columns popover: one header icon button; NavLogColumnsPopover (the
	// extra snippet) renders the anchored panel + backdrop above the modal
	// box with the three nav-log content toggles (they live in routeSettings
	// and persist with the route workspace).
	let columnsOpen = $state(false);
	let columnsBtn = $state<HTMLButtonElement>();

	// Closing the modal (any path) dismisses the popover.
	$effect(() => {
		if (!navLogModal.open) {
			columnsOpen = false;
		}
	});

	// Every route with a flyable leg, for the all-routes kneeboard print.
	const printableRoutes = $derived(routes.list.filter((r) => r.waypoints.length >= 2));

	// Nav-log cards for the kneeboard: each printable route through the
	// chunker (navlogCards), so a log outgrowing one A5 card continues on
	// numbered self-contained cards (legs = waypoints - 1, the computeNavLog
	// row count the sheet renders); the parts flow in order through the same
	// two-cards-per-sheet pairing. Schedules split the same way off their
	// own measured chunks (kbSchedPairs below). The estimator is the no-DOM
	// FALLBACK when a route's measured split is missing (the shared
	// estimatorCardChunks, PrintDoc prices identically).
	function estimatorChunks(r: Route): { from: number; to: number }[] {
		return estimatorCardChunks(
			r.waypoints,
			dataState.airportsLoaded && routeSettings.airportFreqsInNavlog
				? (ident: string) => contactRadios(airportByIdent(ident))
				: null,
			{
				enrouteFreqs: routeSettings.enrouteFreqsInNavlog,
				vorRadials: routeSettings.vorRadialsInNavlog,
			},
		);
	}

	// Per-route MEASURED card splits, filled by printKneeboard's prep off a
	// real off-viewport mount of each log at card geometry (navlogMeasure);
	// a failed measure leaves its route on the estimator fallback.
	let measured = $state<Record<string, { from: number; to: number }[]>>({});
	// Measured pad allowance per route (single cards) and per part (split
	// cards): blank form rows are added only while they fit the card beside
	// the real content.
	let measuredPad = $state<Record<string, number>>({});
	let measuredPartPads = $state<Record<string, number[]>>({});
	// Per-route MEASURED schedule card splits, same prep; a failed measure
	// keeps that route's schedule on one card (no estimator exists for it).
	let measuredSched = $state<Record<string, { from: number; to: number }[]>>({});

	// The measured splits are print-prep artifacts: drop them with the modal
	// so a stale split can't outlive route edits.
	$effect(() => {
		if (!navLogModal.open) {
			measured = {};
			measuredPad = {};
			measuredPartPads = {};
			measuredSched = {};
		}
	});

	const kbCardPairs = $derived(
		pairCards(
			printableRoutes.flatMap(
				(r): RouteCard<Route>[] =>
					expandCards(r, measured[r.id] ?? estimatorChunks(r), measuredPartPads[r.id]),
			),
		),
	);

	// Schedule cards for the kneeboard, the same expansion + pairing off the
	// measured schedule splits. NO estimator fallback: a route without a
	// measure stays one card per route, the previous behavior.
	const kbSchedPairs = $derived(
		pairCards(
			printableRoutes.flatMap((r): RouteCard<Route>[] => expandCards(r, measuredSched[r.id] ?? [])),
		),
	);

	/* A schedule row opens that airspace's panel, and the log steps aside only
	 * when it covers the map (docs/workspace-surfaces.md): at its default dock
	 * the log, the map and the panel are all on screen at once, which is what
	 * docking is for, and DetailPanel insets itself by the dock so nothing
	 * overlaps. */
	const goToAirspace = airspaceNavigator('navlog', closeNavLog);

	// Clicking any waypoint centres the map on it; an anchored point (airport /
	// navaid) also opens its detail panel. The log steps aside first only when
	// it covers the map, the schedule rows' rule, so the flight below runs on
	// the map the pilot is actually looking at. flyToVisible runs after a tick
	// so the just-opened panel is laid out and the target stays clear of it.
	async function goToWaypoint(wp: Waypoint): Promise<void> {
		if (!surfaceKeepsMapVisible('navlog')) {
			closeNavLog();
		}
		if (wp.kind === 'airport' && wp.refId) {
			selectAirport(wp.refId);
		} else if (wp.kind === 'navaid' && wp.refId) {
			// Navaids may not be loaded yet; the panel fills in once they arrive.
			void ensureNavaids().catch(() => {});
			selectNavaid(wp.refId);
		}
		await tick();
		flyToVisible({ lat: wp.lat, lng: wp.lon }, Math.max(mapState.map?.getZoom() ?? 10, 10));
	}

	// ---- printing ----------------------------------------------------------

	// 'kneeboard' while the all-routes A5 layout is being printed; null otherwise,
	// when a plain window.print() prints the active route on A4 portrait, as before.
	let printMode = $state<'kneeboard' | null>(null);
	let preparingPrint = $state(false);
	// Per-route minimum safe altitudes, fetched up front so every printed log shows
	// MSA and the sheets render synchronously (no async terrain fetch during print).
	let kneeboardMsa = $state<Record<string, (number | null)[]>>({});

	// While kneeboard-printing, tag <html> (the print rules switch to the A5
	// doc) and inject the landscape @page (installDocumentPageCss). Zero page
	// margin: the margin is carried in the content (.kb-sheet padding), which
	// the print dialog's own "Margins" control cannot strip. Both torn down
	// when the mode clears after printing.
	$effect(() => {
		if (printMode !== 'kneeboard') {
			return;
		}
		return installDocumentPageCss(['navlog-kneeboard']);
	});

	function resetPrintMode(): void {
		printMode = null;
	}

	async function printKneeboard(): Promise<void> {
		if (preparingPrint || printableRoutes.length === 0) {
			return;
		}
		preparingPrint = true;
		try {
			// Ensure the datasets the sheets and schedules read are present.
			// Each degrades alone: an obstacle fetch failure prints MSA from
			// terrain only (the documented degradation posture) instead of
			// aborting the whole print job.
			const [obstacles] = await Promise.all([
				ensureObstacles().catch((): Obstacle[] => []),
				ensureAirspaces().catch(() => {}),
				ensureAirports().catch(() => {}),
				ensureNavaids().catch(() => {}),
			]);
			// Per-route minimum safe altitudes, so each printed log shows MSA;
			// forecast winds awaited alongside so the paper's MH / ETE-W match
			// the screen (a mount-time effect fetch cannot land before the
			// snapshot; a wind failure just falls back to the manual wind).
			const msa: Record<string, (number | null)[]> = {};
			await Promise.all([
				...printableRoutes.map(async (r) => {
					const pts = r.waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));
					msa[r.id] = await computeMinAltitudes(pts, obstacles, {
						halfWidthNM: routeSettings.minAltCorridorRadiusNM,
						vfr: routeSettings.vfr,
					});
				}),
				...printableRoutes.map((r) => ensureRouteWindFor(r).catch(() => {})),
			]);
			kneeboardMsa = msa;
			// MEASURED card splits: mount each log (and each schedule) once at
			// card geometry and pack the real row heights (media-independent
			// kneeboard prop, so no print-mode html class is needed while
			// measuring); a failed log measure leaves that route on the
			// estimator fallback, a failed schedule measure on one card.
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
			measured = meas;
			measuredPad = pads;
			measuredPartPads = partPads;
			measuredSched = schedMeas;
			printMode = 'kneeboard';
			await tick();
			// One more frame so the two-up layout settles before the snapshot.
			await new Promise((res) => requestAnimationFrame(() => res(undefined)));
			window.addEventListener('afterprint', resetPrintMode, { once: true });
			// This flow prints a document of its own, so the user-print claim
			// must stay out of its way (surfacePrint).
			markDocumentPrint(planPrintStem('navlog'));
			printPage(DOCUMENT_ORIENTATION);
		} finally {
			preparingPrint = false;
		}
	}
</script>

<svelte:window
	onkeydown={(e: KeyboardEvent) => {
		if (
			navLogModal.open &&
			(e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
			!isEditableTarget(e.target)
		) {
			stepActiveRoute(e.key === 'ArrowRight' ? 1 : -1);
		}
	}}
/>

<!-- The print menu (the shell's actions contract): worded rows, one per
     paper; the columns popover stays in the strip, anchored to its own
     button. Passed only while at least one row can render, so a log with no
     flyable route carries no printer button (and no empty sheet). -->
{#snippet printActions({ close }: { close: () => void })}
	{#if activeEnough}
		<button
			class="item"
			title={t.navlog.printRouteTip}
			onclick={() => { close(); void printSurface('navlog'); }}
		>
			<Icon name="printer" size={14} />
			{t.navlog.printRouteAria}
		</button>
	{/if}
	{#if printableRoutes.length > 0}
		<button
			class="item"
			disabled={preparingPrint}
			title={t.navlog.printAllTip}
			onclick={() => { close(); void printKneeboard(); }}
		>
			<Icon name="columns" size={14} />
			{t.navlog.printAllAria}
		</button>
	{/if}
{/snippet}

<SurfaceShell
	id="navlog"
	onClose={closeNavLog}
	onEscape={() => {
		if (columnsOpen) {
			columnsOpen = false;
		} else {
			closeNavLog();
		}
	}}
	label={t.route.navigationLog}
	boxClass="navlog-box print-palette"
	printName={() => routePrintStem('navlog', activeRoute())}
	actions={activeEnough || printableRoutes.length > 0 ? printActions : undefined}
	actionsIcon="printer"
	actionsLabel={t.route.print}
>
	{#snippet header()}
		<h2>{t.route.navigationLog}</h2>
		<RouteSwitcher />
		{#if activeEnough}
			<!-- Stays in the strip: its popover anchors to this button's rect,
			 and a menu row that opens another popover is a worse trade than
			 one icon in a strip that now says when it has more. -->
			<button
				class="modal-close no-print"
				bind:this={columnsBtn}
				aria-label={t.navlog.columnsAria}
				title={t.navlog.columnsTip}
				aria-expanded={columnsOpen}
				onclick={() => (columnsOpen = !columnsOpen)}
			>
				<Icon name="sliders" />
			</button>
		{/if}
	{/snippet}

	<div class="body">
		{#if !activeEnough}
			<p class="muted">{t.navlog.addWaypoints}</p>
		{:else}
			<!-- The phone reads the log COMPACT: the same chevron sheet at
			     phone-tuned tracks, its visible pane ending on the Waypoint
			     column's right border so only Notes pans. Only this mount
			     passes it; the kneeboard and dossier mounts below never do. -->
			<NavLogSheet
				route={activeRoute()}
				interactive
				compact={ui.isMobile}
				live={liveInfo?.log.display ?? null}
				onIdent={(wp: Waypoint) => void goToWaypoint(wp)}
			/>
			<NavLogSchedule
				route={activeRoute()}
				onAirspace={goToAirspace}
				live={liveInfo?.scheduleLive ?? null}
			/>
		{/if}
	</div>

	{#snippet extra()}
		{#if columnsOpen}
			<NavLogColumnsPopover anchorEl={columnsBtn} onClose={() => (columnsOpen = false)} />
		{/if}
		<!-- Print-only: every route's nav log two-up on landscape A4 (each card an
		     A5 half; a long log continues on numbered self-contained cards), then
		     the schedules on their own sheet(s), again two-up (a long schedule
		     continues on numbered part cards the same way).
		     Mounted only while kneeboard-printing; display:none on screen. -->
		{#if printMode === 'kneeboard'}
			<div class="kb-doc print-palette">
				{#each kbCardPairs as pair (cardKey(pair[0]))}
					<div class="kb-sheet">
						{#each pair as c (cardKey(c))}
							<div class="kb-card">
								<NavLogSheet
									route={c.route}
									legMinFt={kneeboardMsa[c.route.id]}
									minWaypoints={c.pad ?? (c.part ? 0 : (measuredPad[c.route.id] ?? 8))}
									legRange={c.range}
									part={c.part}
									kneeboard
								/>
							</div>
						{/each}
					</div>
				{/each}
				{#each kbSchedPairs as pair (cardKey(pair[0]))}
					<div class="kb-sheet">
						{#each pair as c (cardKey(c))}
							<div class="kb-card">
								<NavLogSchedule
									route={c.route}
									heading={routeTitle(c.route)}
									rowRange={c.range}
									part={c.part}
									kneeboard
								/>
							</div>
						{/each}
					</div>
				{/each}
			</div>
		{/if}
	{/snippet}
</SurfaceShell>

<style>
	:global(.navlog-box) {
		--modal-width: min(1040px, 96vw);
	}

	h2 {
		margin: 0;
		flex: 1;
		font-size: 14px;
		font-weight: 600;
		color: var(--text);
	}

	.body {
		flex: 1;
		padding: 16px;
		overflow-y: auto;
	}

	/* The compact sheet's pane is 376px and the phone 392: the 16px side
	   padding must thin so the pane seats whole (392 - 2x8 = 376; a 360px
	   device shrinks the pane into the Waypoint column instead, accepted).
	   Keyed off :root.mobile-ui, never a media query (the ui.svelte.ts
	   doctrine); the print rule below outranks this, so paper margins never
	   move. */
	:global(:root.mobile-ui) .body {
		padding: 12px 8px;
	}

	.muted {
		font-size: 13px;
		color: var(--text-muted);
	}

	/* The kneeboard document is print-only. */
	.kb-doc {
		display: none;
	}

	/* ---- print ---- */
	@media print {
		/* Both print modes drop the app + the dimmed backdrop behind the portaled
		   content: #app keeps height:100dvh even with .app hidden, which would
		   otherwise print a blank leading page. */
		:global(html.navlog-print #app) {
			display: none !important;
		}

		:global(html.navlog-print .modal-backdrop) {
			display: none !important;
		}

		/* On-screen-only controls (the header buttons). */
		.no-print {
			display: none !important;
		}

		/* Portrait: the existing single-route layout. Print the modal as static and
		   pin the light-theme palette (regardless of the active day/night theme) so
		   every var-based border, stripe and text colour carries through; the
		   sheet / schedule inherit the vars. */
		:global(html.navlog-print:not(.navlog-kneeboard) .navlog-box) {
			position: static !important;
			inset: auto !important;
			transform: none !important;
			width: auto;
			max-width: none;
			max-height: none;
			overflow: visible;
			border: none;
			border-radius: 0;
			box-shadow: none;

			/* The 12mm padding is the real print margin (the house zero-@page
			   convention below, matching FlightPrepModal's identical static
			   rule so bundle order can't zero one flow's margins): the print
			   dialog's Margins control overrides an @page margin but cannot
			   strip a content padding. On the BOX, not the body, so the
			   header line prints inside the margin too; cloned per fragment
			   so a long nav log keeps the margin on continuation pages
			   (Gecko; Chromium ignores clone on blocks). */
			padding: 12mm;
			box-decoration-break: clone;

			/* Inks ride the shared .print-palette class on this box
			   (app.css). */
			background: var(--surface);
		}

		:global(html.navlog-print:not(.navlog-kneeboard)) .body {
			overflow: visible;
			padding: 0;
		}

		/* Kneeboard: hide the interactive modal and lay the print-only document out
		   two A5 cards per landscape sheet (the landscape @page is injected from
		   script with a zero page margin). The 8mm sheet padding is the real margin
		   (the print dialog can't strip a content margin); the 16mm gap is centred on
		   the A4 mid-line, so cutting a sheet in half yields two A5 cards each with a
		   uniform 8mm margin. */
		:global(html.navlog-kneeboard .navlog-box) {
			display: none !important;
		}

		/* Inks ride the shared .print-palette class on the doc (app.css). */
		:global(html.navlog-kneeboard) .kb-doc {
			display: block;
		}

		/* One pair of cards per landscape sheet: two side by side, no more. The logs
		   come first; because every sheet but the last page-breaks after itself, the
		   frequencies always start on their own sheet. */
		:global(html.navlog-kneeboard) .kb-sheet {
			display: flex;
			gap: 16mm;
			padding: 8mm;
			box-sizing: border-box;
			break-after: page;
			break-inside: avoid;

			/* A card that still spills (worst-case multi-line frequency
			   banners) keeps the 8mm margin on its continuation fragment. */
			box-decoration-break: clone;
		}

		:global(html.navlog-kneeboard) .kb-sheet:last-child {
			break-after: auto;
		}

		:global(html.navlog-kneeboard) .kb-card {
			flex: 0 0 calc(50% - 8mm);
			min-width: 0;
		}
	}

	/* Zero like FlightPrepModal's identical unconditional rule: @page cannot
	   be class-scoped, so the two static rules must agree regardless of CSS
	   bundle order; the 12mm margin is carried as the printed body's padding
	   above. The kneeboard flow injects its own landscape zero-margin @page. */
	@page {
		size: a4 portrait;
		margin: 0;
	}
</style>
