<script lang="ts">
	/* The route sub-tab strip: one flat underline tab bar (label = the
	 * endpoint pair, double-click to rename), HTML5 drag-and-drop reordering
	 * with edge auto-scroll, the WAI-ARIA tabs keyboard pattern, and the
	 * overflow scroller behind overlay chevrons. Self-contained over the
	 * route state module; RouteTab only mounts it.
	 *
	 * The bar is also the tab's head, so it carries the route-actions button
	 * beside the + : the strip owns its own chrome (one grammar for both
	 * buttons by construction), while the menu that button opens, and
	 * everything in it, belongs to RouteTab. */
	import { tick } from 'svelte';
	import Icon from '../../Icon.svelte';
	import {
		routes,
		addRoute,
		removeRoute,
		setActiveRoute,
		stepActiveRoute,
		reorderRoute,
		renameRoute,
		canAddRoute,
		type Waypoint,
		type Route,
	} from '$lib/state/route.svelte';
	import { routeColor, routeColorMap } from '$lib/route/routeColors';
	import { routeEndpointLabel } from '$lib/route/routeLabel';
	import { t } from '$lib/state/i18n.svelte';

	let {
		onMenu,
		menuOpen,
		unstored,
	}: {
		/** Open the route-actions menu, anchored on the button's own rect. */
		onMenu: (e: MouseEvent) => void;
		menuOpen: boolean;
		/** The active flight plan holds unstored changes (activePlanDirty).
		 *  Marked HERE because this is where the editing happens: until now the
		 *  only sign was the catalog row's amber bar, a surface away, which is
		 *  why its own tip has to send the pilot back to this menu. */
		unstored: boolean;
	} = $props();

	// Route id -> dot colour (an alternate shares its trip's hue), matching the map.
	const routeHues = $derived(routeColorMap(routes.list));

	// --- route sub-tabs: the label is the endpoint pair, double-click to rename. ---
	let editingId = $state<string | null>(null);

	function autofocus(node: HTMLInputElement): void {
		node.focus();
		node.select();
	}

	function startRename(id: string): void {
		setActiveRoute(id);
		editingId = id;
	}

	function commitRename(id: string, value: string): void {
		renameRoute(id, value);
		editingId = null;
	}

	// --- drag & drop to reorder the route tabs (the order flows into the YAML save).
	// HTML5 native DnD: a real drag gesture is needed to start, so click-to-activate
	// and double-click-to-rename keep working untouched. ---
	let draggingId = $state<string | null>(null);
	let dragOverId = $state<string | null>(null);
	let dragAfter = $state(false); // drop after the hovered tab vs before it

	function onTabDragStart(r: Route, e: DragEvent): void {
		if (editingId === r.id || !e.dataTransfer) {
			return; // never drag the tab being renamed
		}
		draggingId = r.id;
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/plain', r.id); // Firefox requires data to drag
	}

	function onTabDragOver(r: Route, e: DragEvent): void {
		if (!draggingId || r.id === draggingId) {
			return;
		}
		e.preventDefault(); // allow drop
		if (e.dataTransfer) {
			e.dataTransfer.dropEffect = 'move';
		}
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		dragOverId = r.id;
		dragAfter = e.clientX > rect.left + rect.width / 2; // before/after by midpoint
	}

	function onTabDrop(r: Route, e: DragEvent): void {
		if (!draggingId) {
			return;
		}
		e.preventDefault();
		const from = routes.list.findIndex((x) => x.id === draggingId);
		let to = routes.list.findIndex((x) => x.id === r.id);
		if (from >= 0 && to >= 0) {
			if (dragAfter) {
				to += 1;
			}
			if (from < to) {
				to -= 1; // removing the dragged item shifts later indices left
			}
			reorderRoute(from, to);
		}
		clearDrag();
	}

	function clearDrag(): void {
		stopAutoScroll();
		draggingId = null;
		dragOverId = null;
	}

	// Auto-scroll the tab strip while a tab is dragged near either end, so a tab can
	// be dropped beyond the currently visible ones. HTML5 dragover only fires on
	// movement, so a rAF loop keeps scrolling while the pointer rests in the hot
	// zone; it stops when the pointer leaves the zone (next dragover), leaves the
	// strip, or the drag ends. Speed ramps with how deep into the zone the pointer
	// is. Plain (non-reactive) vars: read only by the loop and handlers.
	let autoScrollVel = 0; // signed px/frame; 0 = idle
	let autoScrollRAF: number | null = null;

	function startAutoScroll(): void {
		if (autoScrollRAF !== null) {
			return;
		}
		const step = (): void => {
			const el = tabScroller;
			if (!el || autoScrollVel === 0 || !draggingId) {
				autoScrollRAF = null;
				return;
			}
			el.scrollLeft += autoScrollVel;
			autoScrollRAF = requestAnimationFrame(step);
		};
		autoScrollRAF = requestAnimationFrame(step);
	}

	function stopAutoScroll(): void {
		autoScrollVel = 0;
		if (autoScrollRAF !== null) {
			cancelAnimationFrame(autoScrollRAF);
			autoScrollRAF = null;
		}
	}

	function onStripDragOver(e: DragEvent): void {
		const el = tabScroller;
		if (!draggingId || !el) {
			return;
		}
		const rect = el.getBoundingClientRect();
		const edge = Math.min(44, rect.width / 3); // px hot zone at each end
		const max = 16; // px per frame at the very edge
		const ramp = (d: number): number => max * Math.min(1, Math.max(0, 1 - d / edge));
		let vel = 0;
		if (e.clientX < rect.left + edge) {
			vel = -ramp(e.clientX - rect.left);
		} else if (e.clientX > rect.right - edge) {
			vel = ramp(rect.right - e.clientX);
		}
		autoScrollVel = vel;
		if (vel !== 0) {
			startAutoScroll();
		} else {
			stopAutoScroll();
		}
	}

	function onStripDragLeave(e: DragEvent): void {
		const el = e.currentTarget as HTMLElement;
		const related = e.relatedTarget as Node | null;
		if (!related || !el.contains(related)) {
			stopAutoScroll(); // pointer left the strip entirely
		}
	}

	// The auto endpoint label (ignores a custom name), shown as the rename
	// placeholder so a blank field reverts to it.
	function autoLabel(r: { waypoints: Waypoint[] }): string {
		return routeEndpointLabel({ name: null, waypoints: r.waypoints }, t.route.newRoute);
	}

	// --- tab strip keyboard support (the WAI-ARIA tabs pattern): Left / Right
	// step through the routes (activation follows focus, roving tabindex),
	// Home / End jump to the ends, and Ctrl (or Cmd) + Left / Right moves the
	// focused route, echoing the browsers' tab-strip shortcuts. ---
	function onTabKeydown(e: KeyboardEvent): void {
		const idx = routes.list.findIndex((r) => r.id === routes.activeId);
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			const delta = e.key === 'ArrowLeft' ? -1 : 1;
			if (e.ctrlKey || e.metaKey) {
				reorderRoute(idx, idx + delta);
			} else {
				stepActiveRoute(delta);
			}
		} else if (e.key === 'Home') {
			setActiveRoute(routes.list[0].id);
		} else if (e.key === 'End') {
			setActiveRoute(routes.list[routes.list.length - 1].id);
		} else {
			return;
		}
		e.preventDefault();
		// Focus follows the active tab (the strip's only tabbable label).
		const strip = (e.currentTarget as HTMLElement).closest('.route-tabs');
		void tick().then(() => {
			strip?.querySelector<HTMLElement>('.route-tab.active .route-tab-label')?.focus();
		});
	}

	// --- tab strip overflow: once the tabs can't all fit at their readable floor,
	// the strip scrolls (wheel-to-horizontal, hidden scrollbar) behind overlay
	// chevrons, and the active tab is kept in view. ---
	let tabScroller = $state<HTMLDivElement>();
	let tabWrap = $state<HTMLDivElement>();
	let canScrollLeft = $state(false);
	let canScrollRight = $state(false);
	// While the strip overflows, the + button docks outside the scroller (always
	// reachable, Firefox-style); while everything fits, it trails the last tab.
	const stripOverflows = $derived(canScrollLeft || canScrollRight);

	function updateScrollAffordance(): void {
		const el = tabScroller;
		if (!el) {
			return;
		}
		canScrollLeft = el.scrollLeft > 1;
		canScrollRight = Math.ceil(el.scrollLeft + el.clientWidth) < el.scrollWidth - 1;
	}

	function scrollTabs(dir: -1 | 1): void {
		const el = tabScroller;
		if (el) {
			el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.7), behavior: 'smooth' });
		}
	}

	function onTabWheel(e: WheelEvent): void {
		const el = tabScroller;
		if (!el || el.scrollWidth <= el.clientWidth) {
			return;
		}
		const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
		if (delta !== 0) {
			el.scrollLeft += delta;
			e.preventDefault();
		}
	}

	// Keep the active tab visible and the chevron affordance fresh whenever the
	// active route or the route count changes (e.g. activating a route from the map).
	$effect(() => {
		void routes.activeId;
		void routes.list.length;
		const el = tabScroller;
		if (!el) {
			return;
		}
		const tab = el.querySelector<HTMLElement>('.route-tab.active');
		if (tab) {
			const margin = 32; // clear an overlay chevron
			const left = tab.offsetLeft;
			const right = left + tab.offsetWidth;
			if (left - margin < el.scrollLeft) {
				el.scrollLeft = Math.max(0, left - margin);
			} else if (right + margin > el.scrollLeft + el.clientWidth) {
				el.scrollLeft = right + margin - el.clientWidth;
			}
		}
		updateScrollAffordance();
	});

	// Refresh the affordance when the strip resizes (panel resize, sidebar toggle).
	$effect(() => {
		const el = tabScroller;
		if (!el) {
			return;
		}
		const ro = new ResizeObserver(() => updateScrollAffordance());
		ro.observe(el);
		updateScrollAffordance();
		return () => ro.disconnect();
	});

	// Drag auto-scroll listeners live on the wrapper (so they also fire over the
	// overlay scroll chevrons at the ends). Attached imperatively: a dragover
	// attribute on the static wrapper would trip the a11y lint, and this is
	// behaviour, not a control. Bubbles up from the tab buttons' own dragover.
	$effect(() => {
		const el = tabWrap;
		if (!el) {
			return;
		}
		el.addEventListener('dragover', onStripDragOver);
		el.addEventListener('dragleave', onStripDragLeave);
		return () => {
			el.removeEventListener('dragover', onStripDragOver);
			el.removeEventListener('dragleave', onStripDragLeave);
			stopAutoScroll();
		};
	});
</script>

<div class="route-bar">
	<div class="route-tabs-wrap" bind:this={tabWrap}>
		<div
			class="route-tabs"
			role="tablist"
			aria-label={t.route.routesAria}
			bind:this={tabScroller}
			onscroll={updateScrollAffordance}
			onwheel={onTabWheel}
		>
			{#snippet routeStripItem(r: Route, i: number)}
				<div
					class="route-tab"
					class:active={r.id === routes.activeId}
					class:alt={r.alternate}
					class:dragging={draggingId === r.id}
					class:drop-before={dragOverId === r.id && !dragAfter}
					class:drop-after={dragOverId === r.id && dragAfter}
					style:--route-hue={routeHues.get(r.id) ?? routeColor(i)}
				>
					{#if editingId === r.id}
						<input
							class="route-rename"
								autocapitalize="sentences"
								spellcheck="false"
							type="text"
							value={r.name ?? ''}
							placeholder={autoLabel(r)}
							aria-label={t.route.renameAria}
							use:autofocus
							onkeydown={(e) => {
								if (e.key === 'Enter') {
									commitRename(r.id, e.currentTarget.value);
								} else if (e.key === 'Escape') {
									editingId = null;
								}
							}}
							onblur={(e) => commitRename(r.id, e.currentTarget.value)}
						/>
					{:else}
						<button
							class="route-tab-label"
							role="tab"
							aria-selected={r.id === routes.activeId}
							tabindex={r.id === routes.activeId ? 0 : -1}
							title={`${routeEndpointLabel(r, t.route.newRoute)}\n${t.route.tabTip}`}
							draggable="true"
							onpointerdown={(e) => {
								// Mouse only: a touch press may be the start of a strip
								// scroll pan, so touch / pen activate via the click below
								// (the browser's own tap-vs-pan slop suppresses it on a
								// scroll), while the mouse keeps the browser-tab press feel.
								if (e.button === 0 && e.pointerType === 'mouse') {
									setActiveRoute(r.id); // activate on press, like a browser tab
								}
							}}
							onclick={() => setActiveRoute(r.id)}
							ondblclick={() => startRename(r.id)}
							onauxclick={(e) => {
								if (e.button === 1 && routes.list.length > 1) {
									removeRoute(r.id);
								}
							}}
							onkeydown={onTabKeydown}
							ondragstart={(e) => onTabDragStart(r, e)}
							ondragover={(e) => onTabDragOver(r, e)}
							ondrop={(e) => onTabDrop(r, e)}
							ondragend={clearDrag}
						>
							<span class="route-tab-text">{routeEndpointLabel(r, t.route.newRoute)}</span>
						</button>
					{/if}
					{#if routes.list.length > 1}
						<button
							class="route-close"
							title={t.route.closeRoute}
							aria-label={t.route.closeRoute}
							onclick={() => removeRoute(r.id)}
						>
							<Icon name="x" size={11} />
						</button>
					{/if}
				</div>
			{/snippet}
			{#each routes.list as r, i (r.id)}
				{@render routeStripItem(r, i)}
			{/each}
			{#if canAddRoute() && !stripOverflows}
				<button class="route-add" title={t.route.addRoute} aria-label={t.route.addRoute} onclick={() => addRoute()}>
					<Icon name="plus" size={16} />
				</button>
			{/if}
		</div>
		{#if canScrollLeft}
			<button
				class="route-scroll left"
				aria-label={t.route.scrollLeft}
				tabindex="-1"
				onclick={() => scrollTabs(-1)}
			>
				<Icon name="chevron-left" size={16} />
			</button>
		{/if}
		{#if canScrollRight}
			<button
				class="route-scroll right"
				aria-label={t.route.scrollRight}
				tabindex="-1"
				onclick={() => scrollTabs(1)}
			>
				<Icon name="chevron-right" size={16} />
			</button>
		{/if}
	</div>
	{#if canAddRoute() && stripOverflows}
		<button class="route-add" title={t.route.addRoute} aria-label={t.route.addRoute} onclick={() => addRoute()}>
			<Icon name="plus" size={16} />
		</button>
	{/if}
	<!-- The unstored-changes marker rides the button that opens Store, and the
	     button's own label carries the state (the SendFPL rows' idiom): a dot
	     explains itself on no platform, and a phone sheet has no hover. -->
	<button
		class="route-menu"
		title={unstored ? t.route.actionsMenuUnstored : t.route.actionsMenu}
		aria-label={unstored ? t.route.actionsMenuUnstored : t.route.actionsMenu}
		aria-expanded={menuOpen}
		onclick={onMenu}
	>
		<Icon name="more-vertical" size={16} />
		{#if unstored}<span class="unstored-dot" aria-hidden="true"></span>{/if}
	</button>
</div>

<style>
	/* Route sub-tabs: a flat underline tab bar over a baseline rule, one single
	 * row, Firefox-style: the tabs share the width equally but never shrink below
	 * a floor that keeps the endpoint label ("LFPL → LFPK") readable; once they
	 * can't all fit, the strip scrolls horizontally (wheel / overlay chevrons,
	 * scrollbar hidden), the active tab is kept in view, and edge drags
	 * auto-scroll, so reordering can reach past the visible tabs. The route's
	 * map colour is the tab's underline (the Firefox container-tab convention;
	 * faded when inactive, dashed for an alternate), not a dot, spending the
	 * width on the label instead. */
	.route-bar {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.route-tabs-wrap {
		position: relative;
		flex: 1;
		min-width: 0;
	}

	.route-tabs {
		display: flex;
		align-items: stretch;
		gap: 2px;
		overflow-x: auto;
		border-bottom: 1px solid var(--border);
		scrollbar-width: none;
	}

	.route-tabs::-webkit-scrollbar {
		display: none;
	}

	.route-tab {
		display: inline-flex;
		flex: 1 1 0;
		align-items: center;
		min-width: 104px;
		max-width: 168px;
		border-bottom: 2px solid color-mix(in srgb, var(--route-hue) 40%, transparent);
		cursor: pointer;
	}

	/* The active tab's floor is one close button wider: it is the only tab
	 * always showing its ×, so both floors leave the same room for the label. */
	.route-tab.active {
		min-width: 124px;
		border-bottom-color: var(--route-hue);
	}

	/* Alternate (diversion) routes: a dashed underline + italic label. */
	.route-tab.alt {
		border-bottom-style: dashed;
	}

	/* Drag & drop reordering: dim the tab being dragged, and draw an insertion bar
	 * (inset box-shadow, so it never reflows the strip) on the side of the hovered
	 * tab where the drop would land. */
	.route-tab.dragging {
		opacity: 0.4;
	}

	.route-tab.drop-before {
		box-shadow: inset 2px 0 0 var(--accent);
	}

	.route-tab.drop-after {
		box-shadow: inset -2px 0 0 var(--accent);
	}

	.route-tab-label {
		display: inline-flex;
		flex: 1 1 auto;
		align-items: center;
		min-width: 0;
		padding: 6px 4px 7px 6px;
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted);
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.route-tab.dragging .route-tab-label {
		cursor: grabbing;
	}

	.route-tab-label:hover {
		color: var(--text);
	}

	.route-tab-label:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.route-tab.active .route-tab-label {
		color: var(--text);
	}

	.route-tab.alt .route-tab-text {
		font-style: italic;
	}

	.route-tab-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.route-close {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		margin-right: 2px;
		padding: 0;
		color: var(--text-muted);
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.route-close:hover {
		color: var(--text);
		background: var(--surface-3);
	}

	/* Browser-style close: only the active, hovered or keyboard-focused tab shows
	 * its ×, so squeezed inactive tabs keep the room for their label. Tab widths
	 * are flex-determined, so the × appearing never resizes or shifts the tabs. */
	.route-tab:not(.active, :hover, :focus-within) .route-close {
		display: none;
	}

	/* Overlay scroll chevrons: absolutely placed over each end of the strip, each
	 * with a fade gradient that doubles as the overflow hint. Shown only when the
	 * strip can scroll that way, so they never reflow the scroller. */
	.route-scroll {
		position: absolute;
		top: 0;
		bottom: 1px;
		display: flex;
		align-items: center;
		width: 30px;
		padding: 0;
		color: var(--text);
		border: none;
		cursor: pointer;
	}

	.route-scroll.left {
		left: 0;
		justify-content: flex-start;
		background: linear-gradient(to right, var(--surface) 45%, transparent);
	}

	.route-scroll.right {
		right: 0;
		justify-content: flex-end;
		background: linear-gradient(to left, var(--surface) 45%, transparent);
	}

	.route-scroll:hover {
		color: var(--accent);
	}

	/* The bar's own action buttons, one grammar: the + that adds a route and
	 * the ... that opens the tab's route-actions menu. */
	.route-add,
	.route-menu {
		position: relative;
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 0;
		color: var(--text-muted);
		background: transparent;
		border: none;
		border-radius: var(--radius);
		cursor: pointer;
		align-self: center;
	}

	/* The active flight plan's unstored changes, in the amber the catalog
	   row's own bar uses (PlansView), so one ink means one thing. A child
	   span rather than a pseudo-element: ::after below is the touch hit
	   slop, and that is the platform this matters most on. Static, never
	   pulsing, the pulse being the recording identity. */
	.unstored-dot {
		position: absolute;
		top: 1px;
		right: 1px;
		width: 6px;
		height: 6px;
		background: var(--workbook-orange);
		border-radius: 50%;
	}

	.route-add:hover,
	.route-menu:hover {
		color: var(--text);
		background: var(--surface-3);
	}

	/* 24px boxes in a bar whose height the route tabs set: the finger gets
	   the touch floor from invisible slop rather than from a taller bar,
	   the WaypointRow idiom. Horizontal slop stays short of the neighbour.
	   (The positioning context is on the base rule, the dot needing it on
	   every platform.) */
	:global(:root.touch-ui) .route-add::after,
	:global(:root.touch-ui) .route-menu::after {
		position: absolute;
		inset: -10px -6px;
		content: '';
	}

	.route-rename {
		flex: 1 1 auto;
		width: 100%;
		min-width: 0;
		padding: 4px 7px;
		margin: 2px 0;
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--accent);
		border-radius: 4px;
	}

	.route-rename:focus-visible {
		outline: none;
	}
</style>
