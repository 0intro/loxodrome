<script lang="ts">
	/* The route sub-tab strip: one flat underline tab bar (label = the
	 * endpoint pair, double-click to rename), a reordering drag with edge
	 * auto-scroll (a mouse's drag, a finger's long press), the WAI-ARIA tabs
	 * keyboard pattern, and the overflow scroller behind overlay chevrons.
	 * Self-contained over the route state module; RouteTab only mounts it.
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
		moveRoute,
		moveRouteTo,
		renameRoute,
		canAddRoute,
		type Waypoint,
		type Route,
	} from '$lib/state/route.svelte';
	import { routeColor, routeColorMap } from '$lib/route/routeColors';
	import { dropBarIndex, dropSlot } from '$lib/route/routeList';
	import { dragHandle } from '$lib/ui/dragReorder';
	import { reorderFloor } from '$lib/state/navRoute.svelte';
	import { routeEndpointLabel } from '$lib/route/routeLabel';
	import { t } from '$lib/state/i18n.svelte';

	let {
		onMenu,
		menuOpen,
	}: {
		/** Open the route-actions menu, anchored on the button's own rect. */
		onMenu: (e: MouseEvent) => void;
		menuOpen: boolean;
	} = $props();

	// Route id -> dot colour (an alternate shares its trip's hue), matching the map.
	const routeHues = $derived(routeColorMap(routes.list));

	// --- route sub-tabs: the label is the endpoint pair, double-click to rename. ---
	let editingId = $state<string | null>(null);
	/* Discarding has to SAY so: Escape closes the editor by removing the
	 * input, and Chromium fires `blur` on a focused element it removes
	 * (Firefox does not), so the blur commit would otherwise rename the route
	 * to the abandoned text. A plain let: nothing renders it. */
	let cancelled = false;

	function autofocus(node: HTMLInputElement): void {
		node.focus();
		node.select();
	}

	function startRename(id: string): void {
		setActiveRoute(id);
		cancelled = false;
		editingId = id;
	}

	function cancelRename(): void {
		cancelled = true;
		editingId = null;
	}

	function commitRename(id: string, value: string): void {
		editingId = null;
		if (cancelled) {
			return;
		}
		renameRoute(id, value);
	}

	// --- the drag that reorders the route tabs (the order flows into the YAML
	// save): ui/dragReorder.ts, a mouse past a few pixels, a finger after the
	// long press, so a click activates, a double-click renames and a finger
	// still pans the strip. The drop lands in the nearest slot the route may
	// take (route/routeList.ts routeSlots), a trip with its alternate, and the
	// bar shows that slot, not the pointer. ---
	let draggingId = $state<string | null>(null);
	let dropGap = $state<number | null>(null);
	// The tab the bar stands before (the count: after the last); null, no move.
	const barIndex = $derived(
		draggingId !== null && dropGap !== null ? dropBarIndex(routes.list, draggingId, dropGap) : null,
	);

	/** The slot a drop at `x` (client px) lands in: before the first tab
	 *  whose middle lies past it. */
	function slotAt(id: string, x: number): number | null {
		const tabs = [...(tabScroller?.querySelectorAll<HTMLElement>('.route-tab') ?? [])];
		let ins = tabs.length;
		for (let k = 0; k < tabs.length; k++) {
			const r = tabs[k].getBoundingClientRect();
			if (x < r.left + r.width / 2) {
				ins = k;
				break;
			}
		}
		return dropSlot(routes.list, id, ins, reorderFloor());
	}

	function drop(id: string): void {
		if (dropGap !== null) {
			moveRouteTo(id, dropGap);
		}
		clearDrag();
	}

	function clearDrag(): void {
		draggingId = null;
		dropGap = null;
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
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			const delta = e.key === 'ArrowLeft' ? -1 : 1;
			if (e.ctrlKey || e.metaKey) {
				moveRoute(routes.activeId, delta, reorderFloor());
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
</script>

<div class="route-bar">
	<div class="route-tabs-wrap">
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
					class:drop-before={barIndex === i}
					class:drop-after={barIndex === routes.list.length && i === routes.list.length - 1}
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
									cancelRename();
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
							use:dragHandle={{
								axis: 'x',
								enabled: () => editingId !== r.id && routes.list.length > 1 && i >= reorderFloor(),
								scroller: () => tabScroller,
								onLift: () => (draggingId = r.id),
								onMove: (x) => (dropGap = slotAt(r.id, x)),
								onDrop: () => drop(r.id),
								onCancel: clearDrag,
							}}
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
	<button
		class="route-menu"
		title={t.route.actionsMenu}
		aria-label={t.route.actionsMenu}
		aria-expanded={menuOpen}
		onclick={onMenu}
	>
		<Icon name="more-vertical" size={16} />
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
		overflow-y: hidden;
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

	/* A finger's long press lifts the tab: no text selection, no callout. */
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
		-webkit-touch-callout: none;
		user-select: none;
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

	.route-add:hover,
	.route-menu:hover {
		color: var(--text);
		background: var(--surface-3);
	}

	/* 24px boxes in a bar whose height the route tabs set: the finger gets
	   the touch floor from invisible slop rather than from a taller bar,
	   the WaypointRow idiom. Horizontal slop stays short of the neighbour. */
	:global(:root.touch-ui) .route-add::after,
	:global(:root.touch-ui) .route-menu::after {
		position: absolute;
		inset: -10px -6px;
		content: '';
	}

	/* While the + rides in the strip, its slop is the strip's scrollable
	   overflow. The strip keeps the slop's reach as end padding, and never
	   scrolls vertically. Past the strip's edge the slop would make tabs
	   that fill the strip read as overflowing, which docks the + beside the
	   strip, where everything fits, which brings it back, every frame. The
	   room stays in both states, so the + still costs less in the strip than
	   beside it and the switch settles (tests/routeStripSlop.spec.ts). */
	:global(:root.touch-ui) .route-tabs {
		padding-inline-end: 6px;
	}

	/* Its margin, border and padding (2 + 1 + 4 above the text, 4 + 1 + 1
	 * under it) add up to the label's own 6 + 7, so the strip keeps its height
	 * while a tab is renamed instead of growing a pixel. */
	.route-rename {
		flex: 1 1 auto;
		width: 100%;
		min-width: 0;
		padding: 4px 7px;
		margin: 2px 0 1px;
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
