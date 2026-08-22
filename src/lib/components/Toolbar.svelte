<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	import { onMount } from 'svelte';
	import Icon from './Icon.svelte';
	import ViewConditions from './ViewConditions.svelte';
	import LanguageToggle from './LanguageToggle.svelte';
	import ThemeToggle from './ThemeToggle.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import HeadOverlay from './HeadOverlay.svelte';
	import { ui, toggleSidebar, closeDetail } from '$lib/state/ui.svelte';
	import { activeRoute } from '$lib/state/route.svelte';
	import { navLogModal, toggleNavLog } from '$lib/state/navLogModal.svelte';
	import { routeProfileModal, toggleRouteProfile } from '$lib/state/routeProfileModal.svelte';
	import { flightPrepModal, toggleFlightPrep } from '$lib/state/flightPrepModal.svelte';
	import { flightsModal, toggleFlights } from '$lib/state/flightsModal.svelte';
	import { nav } from '$lib/state/navRecording.svelte';
	import { flightAction, startFlight, confirmPending, dismissPending } from '$lib/state/flightAction.svelte';
	import { traceStartMs } from '$lib/nav/trace';
	import { fmtDurationMs } from '$lib/route/format';
	import { openAbout } from '$lib/state/aboutModal.svelte';
	import { openSearchPalette } from '$lib/state/searchPalette.svelte';
	import { mapState } from '$lib/state/map.svelte';
	import { placementOf, workspace } from '$lib/state/workspace.svelte';
	import { visibleNotams } from '$lib/state/notam.svelte';
	import { fitToNotams } from '$lib/map/notamLayer';
	import { exportMapPdf } from '$lib/export/pdf';
	import { registerBackClose } from '$lib/ui/backClose';

	const fitCount = $derived(visibleNotams().length);

	// The generated mark, shown alone where the wordmark does not fit. The tile
	// rather than assets/mark.svg: the bare spiral is drawn in the day accent,
	// which is wrong against the night toolbar, while the tile carries its own
	// ground and reads the same in both themes. Built from the Vite base, since
	// a root-relative string in a template is not rewritten at build time.
	const markSrc = `${import.meta.env.BASE_URL}favicon.svg`;

	let printing = $state(false);
	let isFullscreen = $state(false);
	let moreOpen = $state(false);

	// Unique id for the More popup, the aria-controls target.
	const uid = $props.id();

	/* Whether the desktop toolbar can seat the four labeled surface
	 * launchers beside everything else. Below it they fold into the one
	 * "Flight" disclosure, so nothing ever overflows the bar. The threshold
	 * is sized against the FRENCH labels (the wider language): the whole
	 * bar measures 1352px at natural widths there, so 1360 keeps the
	 * cluster on a 1366-wide laptop and leaves the conditions chips (the
	 * bar's one shrinkable item) to absorb the transient wider states (the
	 * recording pill's pre-fix wording, a custom period chip). Phones never
	 * see either form, their launchers ride the More menu. */
	const TOOLBAR_LAUNCHERS_MEDIA = '(min-width: 1360px)';
	let clusterWide = $state(false);

	onMount(() => {
		const onChange = (): void => {
			isFullscreen = document.fullscreenElement !== null;
		};
		document.addEventListener('fullscreenchange', onChange);
		const mq = window.matchMedia(TOOLBAR_LAUNCHERS_MEDIA);
		const syncWide = (): void => {
			clusterWide = mq.matches;
		};
		syncWide();
		mq.addEventListener('change', syncWide);
		return () => {
			document.removeEventListener('fullscreenchange', onChange);
			mq.removeEventListener('change', syncWide);
		};
	});

	// System/browser Back dismisses the More menu like the backdrop does
	// (the Android back gesture).
	$effect(() => {
		if (!moreOpen) {
			return;
		}
		return registerBackClose(() => {
			moreOpen = false;
		});
	});

	/* A paged surface takes the map's own box (display: none), so both map
	 * actions would work against a zero-sized container: the PDF export
	 * divides by that width and throws into its own catch, and the fit runs
	 * against Leaflet's stale cached size. Nothing covers the toolbar while a
	 * page is up, so the buttons have to say so themselves. */
	const mapUsable = $derived(
		mapState.map !== null &&
			!(workspace.overlay !== null && placementOf(workspace.overlay) === 'page'),
	);

	async function onPrint(): Promise<void> {
		if (!mapUsable || !mapState.map || printing) {
			return;
		}
		printing = true;
		try {
			await exportMapPdf(mapState.map);
		} catch {
			/* capture failed; e.g. cross-origin map tiles */
		} finally {
			printing = false;
		}
	}

	function onFit(): void {
		if (mapUsable && mapState.map) {
			fitToNotams(mapState.map, visibleNotams());
		}
	}

	function onFullscreen(): void {
		if (document.fullscreenElement) {
			void document.exitFullscreen();
			return;
		}
		// Collapse the panels so the map fills the screen, then request real
		// fullscreen (silently ignored where the API is unavailable, e.g. iOS).
		ui.sidebarCollapsed = true;
		closeDetail();
		void document.documentElement.requestFullscreen().catch(() => {});
	}

	/* Each overflow action defined once: the desktop button row and the
	 * mobile More menu render the same records, so an action edit reaches
	 * both. */
	interface ToolbarAction {
		id: string;
		icon: string;
		label: string;
		aria: string;
		disabled: boolean;
		run: () => void;
		/** True while the surface this action toggles is on screen; the
		 *  button reads as pressed, the way the in-tab launchers do. */
		pressed?: boolean;
		/** Shown as the title while disabled, saying why (the Route tab
		 *  states the same want as visible text). */
		tip?: string;
	}

	const searchAction: ToolbarAction = $derived({
		id: 'search',
		icon: 'search',
		label: t.search.palette.title,
		aria: t.search.palette.title,
		disabled: false,
		run: openSearchPalette,
	});

	const printAction: ToolbarAction = $derived({
		id: 'print',
		icon: 'printer',
		label: t.common.exportPdf,
		aria: t.common.exportPdf,
		disabled: printing || !mapUsable,
		run: () => void onPrint(),
	});

	const fullscreenAction: ToolbarAction = $derived({
		id: 'fullscreen',
		icon: 'maximize',
		label: isFullscreen ? t.common.exitFullScreen : t.common.fullScreen,
		aria: isFullscreen ? t.common.exitFullScreen : t.common.enterFullScreen,
		disabled: false,
		run: onFullscreen,
	});

	const aboutAction: ToolbarAction = $derived({
		id: 'about',
		icon: 'info',
		label: t.common.aboutApp,
		aria: t.common.aboutApp,
		disabled: false,
		run: openAbout,
	});

	const menuActions = $derived([searchAction, printAction, fullscreenAction, aboutAction]);

	/* The workflow surfaces promoted into the chrome (docs/workspace-surfaces
	 * launcher doctrine: their own button toggles them, so an open surface
	 * reads as pressed and the next press puts it away). ONE record set,
	 * rendered three ways: the wide desktop cluster, the narrow-desktop
	 * Flight disclosure, and the top of the phone More menu. The route
	 * VERTICAL PROFILE rides with them (SkyDemon keeps its route profile
	 * permanently under the planning map; it is a primary planning surface
	 * here too); only the trace profile (a debrief tool, in the Navigation
	 * tab) and the positional profiles stay where their subject lives. */
	const launcherActions: ToolbarAction[] = $derived([
		{
			id: 'navlog',
			icon: 'navlog',
			label: t.route.navigationLog,
			aria: t.route.navigationLog,
			disabled: activeRoute().waypoints.length < 2,
			tip: t.route.twoWaypointsHint,
			pressed: navLogModal.open,
			run: toggleNavLog,
		},
		{
			id: 'route-profile',
			icon: 'profile',
			label: t.route.verticalProfile,
			aria: t.route.verticalProfile,
			disabled: activeRoute().waypoints.length < 2,
			tip: t.route.twoWaypointsHint,
			pressed: routeProfileModal.open,
			run: toggleRouteProfile,
		},
		{
			id: 'flight-prep',
			icon: 'clipboard-check',
			label: t.route.flightPreparation,
			aria: t.route.flightPreparation,
			disabled: false,
			pressed: flightPrepModal.open,
			run: () => toggleFlightPrep(),
		},
		{
			id: 'flights',
			icon: 'logbook',
			label: t.flights.title,
			aria: t.flights.title,
			disabled: false,
			pressed: flightsModal.open,
			// Arrow on purpose: toggleFlights takes an optional view, and a
			// bare reference handed to onclick would receive the MouseEvent.
			run: () => toggleFlights(),
		},
	]);

	/** The narrow-desktop Flight disclosure (HeadOverlay, the route-actions
	 *  menu idiom), anchored on its button's own rect. */
	let flightMenuOpen = $state(false);
	let flightMenuAnchor = $state({ x: 0, y: 0 });

	function openFlightMenu(e: MouseEvent): void {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		flightMenuAnchor = { x: r.left, y: r.bottom + 4 };
		flightMenuOpen = true;
	}

	/* The flight button's elapsed readout: nav.nowMs ticks at 1 Hz exactly
	 * while recording, even parked (the trace-span figure freezes on the
	 * stationary jitter gate); null before the first fix, so no misleading
	 * 0:00 while waiting for GPS. */
	const flightElapsed = $derived.by(() => {
		if (!nav.recording) {
			return null;
		}
		const start = traceStartMs(nav.points);
		return start != null ? fmtDurationMs(nav.nowMs - start) : null;
	});

	/* The flight gesture's confirms render HERE because the toolbar is
	 * always mounted (the FileOpenHost idiom over state/flightAction);
	 * mapped in a $derived so an open dialog re-words on a locale switch. */
	const flightConfirm = $derived.by(() => {
		switch (flightAction.pending) {
			case 'stop':
				return { message: t.navigation.stopConfirm, label: t.navigation.stop, danger: true };
			case 'replace':
				return {
					message: t.navigation.replaceConfirm,
					label: t.navigation.replaceConfirmAction,
					danger: true,
				};
			// The last two destroy nothing: one offers a settings screen, the
			// other asks for consent, and Play wants a consent dialog worded
			// plainly and not dressed as a system warning.
			case 'battery':
				return { message: t.navigation.bgBatteryAsk, label: t.navigation.bgBatteryAction, danger: false };
			case 'location':
				return {
					message: t.navigation.locationDisclosure,
					label: t.navigation.locationAgree,
					danger: false,
				};
			default:
				return null;
		}
	});
</script>

<svelte:window
	onkeydown={(e: KeyboardEvent) => {
		if (e.key === 'Escape' && moreOpen) {
			moreOpen = false;
		}
	}}
/>

<header class="toolbar">
	<button
		class="icon-btn"
		onclick={toggleSidebar}
		title={t.common.toggleSidebar}
		aria-label={t.common.toggleSidebar}
	>
		<Icon name="menu" />
	</button>

	<div class="brand">
		<!-- i18n-ignore-start: brand name, invariant in both languages -->
		<img class="brand-mark" src={markSrc} alt="Loxodrome" width="20" height="20" />
		<span class="brand-name">Loxodrome</span>
		<!-- i18n-ignore-end -->
		<!-- i18n-ignore: release channel, invariant in both languages -->
		<span class="beta-badge" title={t.common.betaTip(__APP_VERSION__)}>BETA</span>
	</div>

	<ViewConditions />

	<div class="spacer"></div>

	{#if ui.isMobile}
		<!-- The flight gesture (docs/nav-live.md "In-flight ergonomics"): one
		     tap starts the recording and ends on the map; while recording, the
		     same button asks to stop. Never in the More overflow (the mode
		     toggle must not hide behind a menu), and FILLED, so the bar's one
		     mode control cannot be mistaken for the utility icons beside it. -->
		<button
			class="icon-btn flight-btn"
			class:rec={nav.recording}
			onclick={startFlight}
			aria-pressed={nav.recording}
			title={nav.recording ? t.navigation.stopFlight : t.navigation.start}
			aria-label={nav.recording ? t.navigation.stopFlight : t.navigation.start}
		>
			<Icon name={nav.recording ? 'stop' : 'navigation'} />
			{#if nav.recording}<span class="flight-dot" aria-hidden="true"></span>{/if}
		</button>
	{:else if clusterWide}
		<!-- The surface launchers, one click from anywhere; below the
		     TOOLBAR_LAUNCHERS_MEDIA width they fold into the Flight
		     disclosure instead, so the bar never overflows. -->
		{#each launcherActions as a (a.id)}
			<button
				class="btn"
				class:on={a.pressed}
				aria-pressed={a.pressed}
				disabled={a.disabled}
				title={a.disabled && a.tip ? a.tip : a.label}
				onclick={() => a.run()}
			>
				<Icon name={a.icon} size={14} />
				{a.label}
			</button>
		{/each}
	{:else}
		<!-- Disclosure, not a menu (the More button's rule): a plain group of
		     buttons without menu keyboard semantics, so no aria-haspopup. -->
		<button class="btn" aria-expanded={flightMenuOpen} onclick={openFlightMenu}>
			{t.common.flightMenu}
			<Icon name="chevron-down" size={14} />
		</button>
	{/if}

	<button
		class="icon-btn"
		onclick={onFit}
		disabled={fitCount === 0 || !mapUsable}
		title={t.common.fitMap}
		aria-label={t.common.fitMap}
	>
		<Icon name="crosshair" />
	</button>
	{#if ui.isMobile}
		<!-- Disclosure, not a menu: the popup is a plain group of buttons
		     without menu keyboard semantics, so no aria-haspopup claim. -->
		<button
			class="icon-btn"
			onclick={() => (moreOpen = !moreOpen)}
			aria-expanded={moreOpen}
			aria-controls={moreOpen ? `${uid}-more-menu` : undefined}
			aria-label={t.common.more}
		>
			<Icon name="more-vertical" />
		</button>
	{:else}
		{@render actionBtn(searchAction)}
		{@render actionBtn(printAction)}
		{@render actionBtn(fullscreenAction)}
		<LanguageToggle />
		<ThemeToggle />
		{@render actionBtn(aboutAction)}
		<!-- The flight gesture at the bar's corner (docs/nav-live.md
		     "In-flight ergonomics"): the one filled control, one click to
		     start and end on the map; recording, it carries the elapsed
		     time and asks to stop. Both fills are the contrast-pinned .btn
		     pairs (accent-text on accent, surface on danger). -->
		<button
			class="btn flight-btn flight-pill"
			class:primary={!nav.recording}
			class:danger={nav.recording}
			onclick={startFlight}
			aria-pressed={nav.recording}
			title={nav.recording ? t.navigation.stopFlight : t.navigation.start}
			aria-label={nav.recording ? t.navigation.stopFlight : t.navigation.start}
		>
			<Icon name={nav.recording ? 'stop' : 'navigation'} size={15} />
			{nav.recording ? (flightElapsed ?? t.navigation.recording) : t.navigation.fly}
			{#if nav.recording}<span class="flight-dot" aria-hidden="true"></span>{/if}
		</button>
	{/if}
</header>

{#snippet actionBtn(a: ToolbarAction)}
	<button class="icon-btn" onclick={a.run} disabled={a.disabled} title={a.label} aria-label={a.aria}>
		<Icon name={a.icon} />
	</button>
{/snippet}

{#if ui.isMobile && moreOpen}
	<button
		class="more-backdrop"
		aria-label={t.common.dismissMenu}
		onpointerdown={() => (moreOpen = false)}
	></button>
	<div class="more-menu" id="{uid}-more-menu">
		<!-- The surface launchers lead (the desktop cluster's phone home),
		     the utilities follow under a hairline. -->
		{#each launcherActions as a (a.id)}
			<button
				class="more-item"
				class:on={a.pressed}
				aria-pressed={a.pressed}
				onclick={() => {
					moreOpen = false;
					a.run();
				}}
				disabled={a.disabled}
				aria-label={a.aria}
			>
				<Icon name={a.icon} size={16} />
				<span>{a.label}</span>
			</button>
		{/each}
		<div class="more-sep" aria-hidden="true"></div>
		{#each menuActions as a (a.id)}
			<button
				class="more-item"
				onclick={() => {
					moreOpen = false;
					a.run();
				}}
				disabled={a.disabled}
				aria-label={a.aria}
			>
				<Icon name={a.icon} size={16} />
				<span>{a.label}</span>
			</button>
		{/each}
		<div class="more-toggles">
			<LanguageToggle />
			<ThemeToggle />
		</div>
	</div>
{/if}

{#if !ui.isMobile}
	<!-- The folded cluster's rows: the same records, the route-actions menu
	     presentation. The open flag carries the render conditions so a
	     breakpoint crossing can never strand a stale popup. -->
	<HeadOverlay
		open={flightMenuOpen && !clusterWide}
		x={flightMenuAnchor.x}
		y={flightMenuAnchor.y}
		title={t.common.flightMenu}
		minWidthPx={220}
		onClose={() => (flightMenuOpen = false)}
	>
		{#each launcherActions as a (a.id)}
			<button
				class="item"
				class:on={a.pressed}
				aria-pressed={a.pressed}
				disabled={a.disabled}
				title={a.disabled && a.tip ? a.tip : a.label}
				onclick={() => {
					flightMenuOpen = false;
					a.run();
				}}
			>
				<Icon name={a.icon} size={14} />
				{a.label}
			</button>
		{/each}
	</HeadOverlay>
{/if}

{#if flightConfirm}
	<ConfirmDialog
		message={flightConfirm.message}
		confirmLabel={flightConfirm.label}
		danger={flightConfirm.danger}
		onConfirm={confirmPending}
		onCancel={dismissPending}
	/>
{/if}

<style>
	/* Safe areas: the bar owns the top screen edge, so it grows by the top
	   inset and pads its row below it; the sides keep their 10px unless the
	   inset is larger (all four vars are 0 off-device). */
	.toolbar {
		display: flex;
		align-items: center;
		gap: 6px;
		height: calc(var(--toolbar-h) + var(--sat));
		flex: 0 0 calc(var(--toolbar-h) + var(--sat));
		padding: var(--sat) max(10px, var(--sar)) 0 max(10px, var(--sal));
		background: var(--surface);
		border-bottom: 1px solid var(--border);
		box-shadow: var(--shadow-1);
		z-index: 600;
	}

	.brand {
		display: flex;
		flex: none;
		white-space: nowrap;
		align-items: baseline;
		gap: 5px;
		margin-left: 2px;
		font-size: 16px;
		letter-spacing: 0.02em;
	}

	.brand-mark {
		display: none;
		flex: none;
		align-self: center;
		border-radius: 3px;
	}

	.brand-name {
		font-weight: 700;
		color: var(--accent);
	}

	.spacer {
		flex: 1;
	}

	/* The bar's fixed furniture never gives up width: the conditions chips are
	   the one shrinkable item, and they truncate with the value in their title.
	   Global because LanguageToggle / ThemeToggle own their own .icon-btn. */
	.toolbar :global(.icon-btn) {
		flex: none;
	}

	/* The labeled buttons (the launcher cluster, the Flight disclosure, the
	   fly pill) hold their width the same way; their labels never wrap. */
	.toolbar .btn {
		flex: none;
		white-space: nowrap;
	}

	/* The flight control: a pulsing dot on the corner while recording, drawn
	   in the label's own ink since both recording fills (.btn.danger on the
	   desktop pill, --danger on the phone circle) label with --surface. */
	.flight-btn {
		position: relative;
	}

	/* The elapsed readout rides inside the pill, so the digits must not
	   make it breathe every second. */
	.flight-pill {
		font-variant-numeric: tabular-nums;
	}

	.flight-dot {
		position: absolute;
		top: 3px;
		right: 3px;
		width: 8px;
		height: 8px;
		background: currentcolor;
		border-radius: 50%;
		animation: pulse 1.4s ease-in-out infinite;
	}

	@keyframes pulse {
		50% {
			opacity: 0.25;
		}
	}

	/* The phone keeps the 44px .icon-btn square (touch-ui pins it) but wears
	   the fill: the FILL is what sets the bar's one mode control apart, so
	   the shape stays the bar's own rounded square (user-decided; a circle
	   was the app's only circular control and read as imported FAB
	   vocabulary). Recording swaps to the danger fill; --surface is the
	   label value that clears AA on it in both themes (the .btn.danger
	   rationale). */
	:global(:root.mobile-ui) .flight-btn {
		background: var(--accent);
		color: var(--accent-text);
	}

	:global(:root.mobile-ui) .flight-btn:hover {
		background: var(--accent-hover);
	}

	:global(:root.mobile-ui) .flight-btn.rec {
		background: var(--danger);
		color: var(--surface);
	}

	:global(:root.mobile-ui) .flight-btn.rec:hover {
		background: var(--danger);
	}

	/* Phones need the width for the conditions chip, and the wordmark stops
	   resolving well below the toolbar's size anyway, so the mark carries the
	   brand alone (docs/brand.md "The wordmark"). */
	:global(:root.mobile-ui) .brand-name {
		display: none;
	}

	:global(:root.mobile-ui) .brand-mark {
		display: block;
	}

	/* The badge belongs to the wordmark, so a phone that drops the wordmark
	   drops it too: that width is the conditions chip's, and the About modal
	   states the beta status on every viewport. */
	:global(:root.mobile-ui) .beta-badge {
		display: none;
	}

	/* Mobile "More" overflow menu, anchored under the toolbar's right edge. */
	.more-backdrop {
		position: fixed;
		inset: 0;

		/* Above docked and paged surfaces (1090), below the modal backdrop
		   (1099): on a phone a bottom dock otherwise swallowed most of this
		   menu, and its dismiss layer with it. */
		z-index: 1095;
		padding: 0;
		border: none;
		background: transparent;
		cursor: default;
	}

	.more-menu {
		position: fixed;
		top: calc(var(--toolbar-h) + var(--sat) + 4px);
		right: max(6px, var(--sar));
		z-index: 1096;
		display: flex;
		min-width: 190px;
		flex-direction: column;
		gap: 2px;
		padding: 6px;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow-2);
	}

	.more-item {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		min-height: 44px;
		padding: 8px 10px;
		font: inherit;
		color: var(--text);
		text-align: left;
		background: transparent;
		border: none;
		border-radius: 6px;
		cursor: pointer;
	}

	.more-item:hover {
		background: var(--surface-3);
	}

	.more-item:disabled {
		opacity: 0.45;
		cursor: default;
	}

	/* A launcher row whose surface is open reads as pressed, the .btn.on
	   convention. */
	.more-item.on {
		color: var(--accent);
	}

	.more-sep {
		margin: 2px 0;
		border-top: 1px solid var(--border);
	}

	.more-toggles {
		display: flex;
		gap: 4px;
		margin-top: 2px;
		padding-top: 4px;
		border-top: 1px solid var(--border);
	}
</style>
