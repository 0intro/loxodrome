<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	import Icon from './Icon.svelte';
	import NotamsTab from './tabs/NotamsTab.svelte';
	import AirportsTab from './tabs/AirportsTab.svelte';
	import LayersTab from './tabs/LayersTab.svelte';
	import SettingsTab from './tabs/SettingsTab.svelte';
	import RouteTab from './tabs/RouteTab.svelte';
	import AircraftTab from './tabs/AircraftTab.svelte';
	import NavigationTab from './tabs/NavigationTab.svelte';
	import WeatherTab from './tabs/WeatherTab.svelte';
	import { ui, selectTab, type SidebarTab } from '$lib/state/ui.svelte';
	import { startSheetDrag, MIN_OPEN_FRAC, FLICK } from '$lib/ui/sheet';
	import { observeBox } from '$lib/ui/stageRect';
	import {
		startResize,
		nudgeResize,
		loadPanelWidth,
		savePanelWidth,
		type ResizeOptions,
	} from '$lib/ui/resize';

	// Labels resolve through t.tabs at render (never captured here: the
	// sidebar lives for the whole session, docs/i18n.md rule 2).
	// `sep` marks the entry OPENING a new rail group: 'group' is a gap
	// (briefing | planning | in-flight), 'settings' the stronger hairline
	// before the two settings tabs.
	type TabLabelKey = keyof typeof t.tabs;
	const TABS: { id: SidebarTab; labelKey: TabLabelKey; icon: string; sep?: 'group' | 'settings' }[] = [
		{ id: 'notams', labelKey: 'notams', icon: 'file-text' },
		{ id: 'airports', labelKey: 'airports', icon: 'aerodrome' },
		{ id: 'route', labelKey: 'route', icon: 'route', sep: 'group' },
		{ id: 'aircraft', labelKey: 'aircraft', icon: 'plane' },
		{ id: 'weather', labelKey: 'weather', icon: 'wind' },
		{ id: 'navigation', labelKey: 'navigation', icon: 'navigation', sep: 'group' },
		{ id: 'layers', labelKey: 'layers', icon: 'layers', sep: 'settings' },
		{ id: 'settings', labelKey: 'settings', icon: 'sliders' },
	];

	const WIDTH_KEY = 'loxodrome:sidebar-width';
	const RESIZE: ResizeOptions = { dir: 1, min: 280, max: 640 };

	// Mobile bottom-sheet peek floor (px): roughly the grip + tab rail, which
	// on touch is the 16px strip over the rail's 44px touch floor and its
	// hairline padding. Used as the drag floor and the collapse threshold, not
	// a snap.
	const PEEK_PX = 66;

	let panelWidth = $state(loadPanelWidth(WIDTH_KEY, 400));

	// On mobile the panel is always rendered (so a drag from peek grows it
	// smoothly); on desktop it mounts only when the sidebar is open.
	const renderPanel = $derived(ui.isMobile || !ui.sidebarCollapsed);

	// Live sheet height (px) during a drag; null when the fraction owns it.
	let dragHeight = $state<number | null>(null);
	let railEl = $state<HTMLElement>();
	let gripEl = $state<HTMLElement>();

	// The sheet's own top border, above the grip and the rail it measures.
	const SHEET_BORDER_PX = 1;

	// The mobile sheet's inline height: live px while dragging, else a fraction
	// of the workspace when open (1 == full screen over the map), else peek
	// (left to the .peek CSS rule, which uses auto height).
	const sheetHeightStyle = $derived(
		!ui.isMobile
			? undefined
			: dragHeight !== null
				? `${dragHeight}px`
				: ui.sidebarCollapsed
					? undefined
					// Of the whole workspace: the sheet is anchored to the screen's
					// bottom edge and grows upward OVER a bottom dock, which sits
					// between the map and this bar rather than under it.
					: `calc((100% - var(--kb, 0px)) * ${ui.sheetHeight})`,
	);

	// At (rested) full height the rounded top corners would reveal a sliver of
	// map; flatten them so the sheet meets the toolbar seamlessly.
	const atFull = $derived(
		ui.isMobile && !ui.sidebarCollapsed && dragHeight === null && ui.sheetHeight >= 0.995,
	);

	/* Covers the whole map (the Leaflet-control rule's real question), which
	   the fraction reaches at 1 because it is taken over the whole workspace,
	   the bar and any bottom dock included. */
	const coversMap = $derived(ui.isMobile && !ui.sidebarCollapsed && ui.sheetHeight >= 0.995);

	function onResizeStart(e: PointerEvent): void {
		startResize(
			e,
			panelWidth,
			RESIZE,
			(w) => (panelWidth = w),
			(w) => savePanelWidth(WIDTH_KEY, w),
		);
	}

	function onResizeKey(e: KeyboardEvent): void {
		const w = nudgeResize(e, panelWidth, RESIZE);
		if (w !== null) {
			panelWidth = w;
			savePanelWidth(WIDTH_KEY, w);
		}
	}

	function maxSheetPx(sheet: HTMLElement): number {
		// The workspace is the sheet's containing block, and its padding box
		// (clientHeight) is the 100% the fraction is of: the sheet may grow
		// over a bottom dock, so nothing is subtracted here.
		return Math.max(1, sheet.parentElement?.clientHeight ?? window.innerHeight);
	}

	// Tap or Enter on the grip cycles the presets: peek -> half -> full -> peek.
	function cycleSnap(): void {
		if (ui.sidebarCollapsed) {
			ui.sidebarCollapsed = false;
			ui.sheetHeight = 0.5;
		} else if (ui.sheetHeight < 0.9) {
			ui.sheetHeight = 1;
		} else {
			ui.sidebarCollapsed = true;
		}
	}

	function onGripDown(e: PointerEvent): void {
		const sheet = (e.currentTarget as HTMLElement).closest('.sidebar');
		if (!(sheet instanceof HTMLElement)) {
			return;
		}
		const max = maxSheetPx(sheet);
		startSheetDrag(e, {
			startHeight: sheet.getBoundingClientRect().height,
			min: PEEK_PX,
			max,
			onMove: (h) => (dragHeight = h),
			onRelease: (h, velocity) => {
				dragHeight = null;
				// Rest anywhere between peek and full; a fast flick or a release
				// near the bottom jumps to full / collapses to the peek.
				const frac = h / max;
				if (velocity < -FLICK || frac < MIN_OPEN_FRAC) {
					ui.sidebarCollapsed = true;
				} else {
					ui.sidebarCollapsed = false;
					ui.sheetHeight = velocity > FLICK ? 1 : Math.min(1, frac);
				}
			},
			onTap: cycleSnap,
		});
	}

	function onGripKey(e: KeyboardEvent): void {
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (ui.sidebarCollapsed) {
				ui.sidebarCollapsed = false;
				ui.sheetHeight = 0.5;
			} else {
				ui.sheetHeight = Math.min(1, ui.sheetHeight + 0.1);
			}
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (ui.sidebarCollapsed || ui.sheetHeight <= MIN_OPEN_FRAC) {
				ui.sidebarCollapsed = true;
			} else {
				ui.sheetHeight = Math.max(MIN_OPEN_FRAC, ui.sheetHeight - 0.1);
			}
		} else if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			cycleSnap();
		}
	}

	/* The bar the phone's workspace reserves. On a phone this sheet at rest IS
	 * the bottom bar, so the stage has to end above it: App.svelte pads the
	 * workspace by --sheet-peek, which puts a bottom dock between the map and
	 * this bar instead of under it, on the screen edge the app's own
	 * navigation owns. Measured rather than named, since the rail carries the
	 * touch floor and the bottom safe-area inset, both of which move with the
	 * device; ui.sheetPeekPx is the same figure for the code that cannot read
	 * CSS (map/focus.ts). Desktop stamps neither: there is no bar. */
	$effect(() => {
		const root = document.documentElement;
		const rail = railEl;
		const grip = gripEl;
		if (!ui.isMobile || !rail || !grip) {
			root.style.removeProperty('--sheet-peek');
			ui.sheetPeekPx = 0;
			return;
		}
		const publish = (): void => {
			const px = grip.offsetHeight + rail.offsetHeight + SHEET_BORDER_PX;
			root.style.setProperty('--sheet-peek', `${px}px`);
			ui.sheetPeekPx = px;
		};
		publish();
		const stopRail = observeBox(rail, publish);
		const stopGrip = observeBox(grip, publish);
		return () => {
			stopRail();
			stopGrip();
			root.style.removeProperty('--sheet-peek');
			ui.sheetPeekPx = 0;
		};
	});

	/* Which way the rail can still scroll. Eight labelled tabs measure 588px
	 * in French against a 393px phone bar, so three destinations sit off the
	 * bar at rest; the scrollbar is hidden by design, which left nothing at
	 * all saying they exist. The edges fade while there is more that way. */
	let railL = $state(false);
	let railR = $state(false);

	function syncRailEdges(): void {
		const rail = railEl;
		if (!rail) {
			return;
		}
		railL = rail.scrollLeft > 1;
		railR = Math.ceil(rail.scrollLeft + rail.clientWidth) < rail.scrollWidth - 1;
	}

	$effect(() => {
		void ui.activeTab;
		void ui.isMobile;
		const rail = railEl;
		if (!ui.isMobile || !rail) {
			railL = false;
			railR = false;
			return;
		}
		syncRailEdges();
		const stop = observeBox(rail, syncRailEdges);
		return stop;
	});

	// Keep the active tab scrolled into view in the horizontal mobile rail.
	// Scroll ONLY the rail's own scrollLeft (never scrollIntoView, which walks
	// up and scrolls ancestors, dragging the whole page sideways).
	$effect(() => {
		void ui.activeTab;
		if (!ui.isMobile || !railEl) {
			return;
		}
		const btn = railEl.querySelector<HTMLElement>('.rail-btn.active');
		if (!btn) {
			return;
		}
		const railRect = railEl.getBoundingClientRect();
		const btnRect = btn.getBoundingClientRect();
		const left =
			railEl.scrollLeft + (btnRect.left - railRect.left) - (railEl.clientWidth - btnRect.width) / 2;
		railEl.scrollTo({ left, behavior: 'smooth' });
	});
</script>

<aside
	class="sidebar"
	class:collapsed={ui.sidebarCollapsed}
	class:mobile={ui.isMobile}
	class:peek={ui.isMobile && ui.sidebarCollapsed}
	class:full={atFull}
	class:covers-map={coversMap}
	class:dragging={dragHeight !== null}
	style:height={sheetHeightStyle}
>
	{#if ui.isMobile}
		<button
			type="button"
			class="sheet-grip"
			aria-label={t.common.resizeSidebar}
			bind:this={gripEl}
			onpointerdown={onGripDown}
			onkeydown={onGripKey}
		>
			<span class="grip-bar"></span>
		</button>
	{/if}

	<nav
		class="rail"
		class:fade-l={railL}
		class:fade-r={railR}
		aria-label={t.common.sidebarTabs}
		bind:this={railEl}
		onscroll={syncRailEdges}
	>
		{#each TABS as tab (tab.id)}
			<button
				class="rail-btn"
				class:group-start={tab.sep === 'group'}
				class:settings-start={tab.sep === 'settings'}
				class:active={ui.activeTab === tab.id && (ui.isMobile || !ui.sidebarCollapsed)}
				aria-current={ui.activeTab === tab.id && (ui.isMobile || !ui.sidebarCollapsed)
					? 'true'
					: undefined}
				onclick={() => selectTab(tab.id)}
				title={t.tabs[tab.labelKey]}
				aria-label={t.tabs[tab.labelKey]}
			>
				<Icon name={tab.icon} />
				<span class="rail-label">{t.tabs[tab.labelKey]}</span>
			</button>
		{/each}
	</nav>

	{#if renderPanel}
		<div class="panel" style:width={ui.isMobile ? undefined : `${panelWidth}px`}>
			<div class="panel-body">
				{#if ui.activeTab === 'notams'}
					<NotamsTab />
				{:else if ui.activeTab === 'airports'}
					<AirportsTab />
				{:else if ui.activeTab === 'route'}
					<RouteTab />
				{:else if ui.activeTab === 'aircraft'}
					<AircraftTab />
				{:else if ui.activeTab === 'weather'}
					<WeatherTab />
				{:else if ui.activeTab === 'navigation'}
					<NavigationTab />
				{:else if ui.activeTab === 'layers'}
					<LayersTab />
				{:else if ui.activeTab === 'settings'}
					<SettingsTab />
				{/if}
			</div>
			{#if !ui.isMobile}
				<button
					class="resize-handle"
					aria-label={t.common.resizeSidebar}
					onpointerdown={onResizeStart}
					onkeydown={onResizeKey}
				></button>
			{/if}
		</div>
	{/if}
</aside>

<style>
	.sidebar {
		display: flex;
		flex: 0 0 auto;
		background: var(--surface);
		z-index: 500;
	}

	.rail {
		display: flex;
		flex-direction: column;
		flex: 0 0 var(--rail-w);
		gap: 2px;
		padding: 6px 0;
		background: var(--surface-2);
		border-right: 1px solid var(--border);
	}

	.rail-btn {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
		padding: 8px 2px;
		border: none;
		border-left: 2px solid transparent;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	.rail-btn:hover {
		color: var(--text);
		background: var(--surface-3);
	}

	.rail-btn.active {
		color: var(--accent);
		background: var(--surface);
		border-left-color: var(--accent);
	}

	/* Rail groups: a gap opens each group, and the settings pair sits behind
	   a hairline rule. Drawn as a ::before in the widened margin (never a
	   border on the button: border-left is the active accent on desktop). */
	.rail-btn.group-start {
		margin-top: 10px;
	}

	.rail-btn.settings-start {
		position: relative;
		margin-top: 16px;
	}

	.rail-btn.settings-start::before {
		content: '';
		position: absolute;
		top: -9px;
		right: 6px;
		left: 6px;
		border-top: 1px solid var(--border);
	}

	.rail-label {
		font-size: 10px;
		letter-spacing: 0.01em;
	}

	.panel {
		position: relative;
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--border);
	}

	.panel-body {
		flex: 1;
		min-height: 0;
		padding: 14px;
		overflow-y: auto;
	}

	.resize-handle {
		position: absolute;
		top: 0;
		right: -3px;
		bottom: 0;
		width: 7px;
		padding: 0;
		border: none;
		background: transparent;
		cursor: col-resize;
		touch-action: none;
		z-index: 2;
	}

	.resize-handle:hover,
	.resize-handle:focus-visible {
		background: var(--accent);
		outline: none;
	}

	/* Mobile: the sidebar is a draggable bottom sheet over the map. Peek shows
	   just the grip + tab rail (map-first); the grip drags it up to half /
	   full. Heights are CSS (dvh, so interactive-widget shrinks them for the
	   keyboard); the live drag height is an inline style.

	   It owns the screen's bottom edge: this is the app's navigation, and a
	   bottom dock stacks above it (the workspace reserves --sheet-peek, so
	   the stage ends at this bar's top). Only the on-screen keyboard lifts
	   it. */
	.sidebar.mobile {
		position: absolute;
		top: auto;
		right: 0;
		bottom: var(--kb, 0);
		left: 0;
		flex-direction: column;
		overflow: hidden;
		border-top: 1px solid var(--border);
		border-radius: 12px 12px 0 0;
		box-shadow: var(--shadow-2);
		transition: height 0.22s ease, border-radius 0.15s ease;
	}

	.sidebar.mobile.dragging {
		transition: none;
	}

	.sidebar.mobile.peek {
		height: auto;
	}

	/* At rest in peek, show only the grip + tab rail (no panel). Keep it
	   visible mid-drag (.dragging) so a drag up from peek previews content. */
	.sidebar.mobile.peek:not(.dragging) .panel {
		display: none;
	}

	/* Full height: flatten the top so the sheet meets the toolbar seamlessly
	   (the rounded corners would otherwise reveal a sliver of map). */
	.sidebar.mobile.full {
		border-top: none;
		border-radius: 0;
	}

	.sheet-grip {
		order: 0;
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		height: 14px;
		padding: 0;
		border: none;
		background: transparent;
		cursor: grab;
		touch-action: none;
	}

	.grip-bar {
		width: 36px;
		height: 4px;
		border-radius: 2px;
		background: var(--border-strong);
	}

	.sidebar.mobile .panel {
		order: 1;
		flex: 1;
		min-height: 0;
		width: auto;
		border-right: none;
	}

	/* Safe areas: the rail is the sheet's bottom edge, so it pads by the
	   share of the bottom inset nothing below it covers (--sheet-sab), and
	   by the side insets in landscape; all 0 off-device. */
	.sidebar.mobile .rail {
		order: 2;
		flex-direction: row;
		flex: 0 0 auto;
		flex-wrap: nowrap;
		overflow-x: auto;
		scrollbar-width: none;
		border-right: none;
		border-top: 1px solid var(--border);
		scroll-snap-type: x proximity;

		/* The bar rests ON the touch floor: the buttons' own 44px is the whole
		   of it, so the padding is a hairline either side and the strip reads
		   as a tab bar rather than a slab. */
		padding: 2px var(--sar) calc(2px + var(--sheet-sab)) var(--sal);
	}

	.sidebar.mobile .rail::-webkit-scrollbar {
		display: none;
	}

	/* The tabs off the bar are the only sign there are more of them: the
	   scrollbar is hidden and a chevron would cost 30px of a 393px bar, so
	   the edge itself fades while there is more that way. */
	.sidebar.mobile .rail.fade-l {
		mask-image: linear-gradient(to right, transparent 0, #000 22px);
	}

	.sidebar.mobile .rail.fade-r {
		mask-image: linear-gradient(to left, transparent 0, #000 22px);
	}

	.sidebar.mobile .rail.fade-l.fade-r {
		mask-image: linear-gradient(
			to right,
			transparent 0,
			#000 22px,
			#000 calc(100% - 22px),
			transparent 100%
		);
	}

	/* Vertical padding down to a hair: the icon, its label and the 44px touch
	   floor set the height, nothing else. Horizontal padding is untouched, it
	   is what separates the tabs. */
	.sidebar.mobile .rail-btn {
		flex: 0 0 auto;
		padding: 4px 14px;
		border-left: none;
		border-bottom: 2px solid transparent;
		scroll-snap-align: center;
	}

	.sidebar.mobile .rail-btn.active {
		border-left-color: transparent;
		border-bottom-color: var(--accent);
	}

	/* The horizontal rail turns the group gaps sideways and stands the
	   settings hairline upright. */
	.sidebar.mobile .rail-btn.group-start {
		margin-top: 0;
		margin-left: 10px;
	}

	.sidebar.mobile .rail-btn.settings-start {
		margin-top: 0;
		margin-left: 16px;
	}

	.sidebar.mobile .rail-btn.settings-start::before {
		top: 8px;
		right: auto;
		bottom: 8px;
		left: -9px;
		border-top: none;
		border-left: 1px solid var(--border);
	}

	@media (pointer: coarse) {
		.rail-btn {
			min-height: 44px;
			justify-content: center;
		}

		/* The grip is a strip, not a band: it is only a drag affordance, and
		   the rail below it opens the sheet on its own (selectTab clears
		   sidebarCollapsed, and the active tab collapses it again). So the
		   height stays near the pill and the hit area is bought with
		   invisible slop instead. The slop is useful downward only: the
		   sheet's overflow:hidden clips the part above the top edge. 7px
		   reaches the rail's 2px padding plus the 5px of dead margin above
		   the icons, so it takes no pixel any tab button draws in. */
		.sheet-grip {
			position: relative;
			height: 16px;
		}

		.sheet-grip::after {
			content: '';
			position: absolute;
			inset: -7px 0;
		}
	}
</style>
