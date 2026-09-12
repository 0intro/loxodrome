<script lang="ts">
	/* The shared scaffold for every workspace surface: portal to <body>, the
	 * box positioned by its placement, a header bar ending in the placement
	 * switcher and the close button.
	 *
	 * Modality follows the placement, not the component. A surface covering
	 * the screen (full, dialog) keeps the dialog treatment: dimmed backdrop,
	 * focus trap, aria-modal, a history entry so system Back dismisses it, and
	 * window-level Escape. A docked or paged surface is furniture: the sidebar
	 * and the panels stay live beside it, so it takes none of those, and
	 * Escape only reaches it while focus is inside it.
	 *
	 * The box stays portaled and position:fixed in every placement. That is
	 * what keeps the print flows working unchanged (they hide #app and un-fix
	 * the box); the space a docked surface occupies is reserved instead by the
	 * empty spacers in App.svelte's stage, which is what shrinks the map.
	 *
	 * The chrome CSS (.modal-backdrop / .modal-box / .modal-header /
	 * .modal-close) is global in app.css; per-surface sizing and print rules
	 * hang off `boxClass` via :global(.its-unique-class) selectors in the
	 * caller (its scoped .modal-box rules cannot reach the shell-owned
	 * element). Snippet content keeps the caller's CSS scope, so everything
	 * inside header / children / extra styles as before. */
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import HeadOverlay from './HeadOverlay.svelte';
	import { observeBox } from '$lib/ui/stageRect';
	import PlacementSwitcher from './PlacementSwitcher.svelte';
	import { portal } from '$lib/ui/portal';
	import { focusTrapIf } from '$lib/ui/focusTrap';
	import { registerBackClose } from '$lib/ui/backClose';
	import { t } from '$lib/state/i18n.svelte';
	import {
		type DockEdge,
		type DockRelease,
		type SurfaceId,
		dockEdgeOf,
		dockRelease,
		isModalPlacement,
		minDockPx,
		pageRelease,
		surfaceDef,
	} from '$lib/surfaces';
	import {
		commitDockPx,
		movePlacement,
		placementOf,
		registerSurfaceClose,
		resetDockPx,
		setDockPx,
		setPlacement,
		workspace,
	} from '$lib/state/workspace.svelte';
	import {
		isPrintingSurface,
		registerPageSetup,
		registerPrintName,
	} from '$lib/ui/surfacePrint.svelte';
	import { FLICK, TAP_SLOP, startSheetDrag } from '$lib/ui/sheet';
	import { startResize } from '$lib/ui/resize';
	import { ui } from '$lib/state/ui.svelte';

	interface Props {
		/** Registry id; the placement, and with it the whole open/closed
		 *  question, comes from the workspace slots. */
		id: SurfaceId;
		/** Called by the backdrop, the close button, and (by default) Escape. */
		onClose: () => void;
		/** Escape override for surfaces that close an inner layer first. */
		onEscape?: () => void;
		/** Accessible name: pass exactly one of label / labelledby. */
		label?: string;
		labelledby?: string;
		/** Unique per-surface class on .modal-box for the caller's :global
		 *  sizing and print selectors. Omit for the default-width box. */
		boxClass?: string;
		closeLabel?: string | undefined;
		/** Header content, left of the placement switcher and close button. */
		header: Snippet;
		/** The surface's own actions (print, export), one worded `.item` row
		 *  each, rendered in a disclosure pinned beside the placement switcher
		 *  on every form factor (HeadOverlay: an anchored popup on desktop, a
		 *  bottom sheet on phones). Rows carry words because icons need hover
		 *  to explain themselves and neither a sheet nor a tablet has any; a
		 *  row the surface cannot serve is ABSENT, never disabled (the
		 *  FlightsModal doctrine), and when no row would render at all, pass
		 *  `undefined` so the button goes too. Occasional actions belong
		 *  here; anything pressed in flight or carrying state (the replay
		 *  transport, a route switcher, page tabs, a popover anchored to its
		 *  own button) stays in `header` and never folds. `close` is for the
		 *  rows: call it before acting, never after (the action must fire
		 *  inside the user activation, ahead of the overlay's teardown). */
		actions?: Snippet<[{ close: () => void }]> | undefined;
		/** The disclosure button's glyph: give the set's own face when every
		 *  row shares one (the print menus' printer). */
		actionsIcon?: string;
		/** The disclosure's accessible name and tooltip, and the sheet's
		 *  title on a phone. */
		actionsLabel?: string | undefined;
		/** Box content: the caller's .body (and footer, if any). */
		children: Snippet;
		/** Siblings of the box inside the portal root: print-only documents
		 *  and above-surface menus. */
		extra?: Snippet;
		/** The default `@page` this surface needs, installed only while IT is
		 *  the one printing. `@page` cannot be scoped, so a surface that
		 *  injected its own while merely open re-sized every other surface's
		 *  job; see $lib/ui/surfacePrint.svelte.ts. */
		pageCss?: () => string | null;
		/** What this surface's print job is CALLED: the file-name stem, the
		 *  browser appending the extension. Read at claim time, so it names
		 *  what is on screen; a surface without one keeps the page's own
		 *  title. */
		printName?: () => string;
	}
	const {
		id,
		onClose,
		onEscape,
		label,
		labelledby,
		boxClass,
		closeLabel,
		header,
		actions,
		actionsIcon = 'more-vertical',
		actionsLabel,
		children,
		extra,
		pageCss,
		printName,
	}: Props = $props();

	// Rule 4 (docs/i18n.md): no t.* in $props() fallbacks; derive instead.
	const actionsText = $derived(actionsLabel ?? t.common.more);

	/* Which way the header strip can still scroll. It is `overflow-x: auto`
	 * with its scrollbar hidden at every width, not only on a phone, so the
	 * flight-prep strip could hide its Performances tab with nothing at all
	 * saying so. The edges fade while there is more that way, the tab rail's
	 * treatment (Sidebar.svelte). */
	let stripEl = $state<HTMLElement | undefined>(undefined);
	let stripL = $state(false);
	let stripR = $state(false);

	function syncStripEdges(): void {
		const el = stripEl;
		if (!el) {
			return;
		}
		stripL = el.scrollLeft > 1;
		stripR = Math.ceil(el.scrollLeft + el.clientWidth) < el.scrollWidth - 1;
	}

	$effect(() => {
		const el = stripEl;
		if (!el) {
			stripL = false;
			stripR = false;
			return;
		}
		syncStripEdges();
		return observeBox(el, syncStripEdges);
	});

	/* The actions disclosure. Anchored like every other HeadOverlay caller;
	 * on a phone HeadOverlay is a bottom sheet and the anchor is unused, but
	 * it keeps one call shape. */
	let actionsOpen = $state(false);
	let actionsAnchor = $state({ x: 0, y: 0 });

	function openActions(e: MouseEvent): void {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		actionsAnchor = { x: r.left, y: r.bottom + 4 };
		actionsOpen = true;
	}

	/* Handed to the menu rendition so a row can close the sheet before it
	 * acts: a print or a picker has to fire inside the user activation, and
	 * the sheet's own teardown would otherwise land on top of it
	 * (FlightsModal's fromMenu). */
	function closeActions(): void {
		actionsOpen = false;
	}

	const placement = $derived(placementOf(id));
	const open = $derived(placement !== null);
	const modal = $derived(placement !== null && isModalPlacement(placement));
	const edge = $derived(placement === null ? null : dockEdgeOf(placement));
	const docked = $derived(edge !== null);

	/* The divider gesture runs continuously from docked to maximised: drag the
	 * grip past the dock's resting ceiling and the strip of map left is too
	 * thin to be a map, so the surface takes the whole area as a page; drag a
	 * page's top edge back down and it becomes a dock again at that height.
	 * The rules are pure (dockRelease / pageRelease); this only drives them.
	 *
	 * A maximised surface carries the grip only when it could become a bottom
	 * dock and that slot is free. On a phone the maximised form is full
	 * screen (there is no side panel to keep), and it grips the same way, so
	 * the gesture is never one-way. Deliberately no drag-to-close: a stray
	 * drag must not dismiss a chart in flight; the X does that. */
	const maximised = $derived(placement === 'page' || (ui.isMobile && placement === 'full'));
	const maxGrip = $derived(
		maximised && surfaceDef(id).placements.includes('dock-bottom') && workspace.dockBottom === null,
	);
	const gripEdge = $derived(edge ?? (maxGrip ? 'bottom' : null));

	const gripRange = $derived.by(() => {
		if (!gripEdge) {
			return { stage: 0, min: 0, size: 0 };
		}
		const stage = gripEdge === 'bottom' ? workspace.stage.h : workspace.stage.w;
		return {
			stage,
			min: Math.min(minDockPx(surfaceDef(id), gripEdge), Math.max(1, stage)),
			// A maximised surface has no dock size of its own: it holds the stage.
			size: maximised ? stage : workspace.dockPx[gripEdge],
		};
	});

	/** Apply a released drag: a size keeps the dock, otherwise maximise. */
	function applyRelease(result: DockRelease, releaseEdge: DockEdge): void {
		if (result.kind === 'page') {
			// Already maximised: a phone renders `page` as `full`, so moving
			// would change nothing on screen while silently rewriting the
			// user's own stored choice from `full` to `page`.
			if (maximised) {
				return;
			}
			if (!setPlacement(id, 'page')) {
				// Refused by whoever holds the overlay slot. The surface is
				// still a dock, and the live drag left it past the resting
				// ceiling, so settle it back inside the range.
				commitDockPx(releaseEdge, workspace.dockPx[releaseEdge]);
			}
			return;
		}
		setPlacement(id, releaseEdge === 'bottom' ? 'dock-bottom' : 'dock-right');
		commitDockPx(releaseEdge, result.px);
	}

	function onGripDown(e: PointerEvent): void {
		if (!gripEdge) {
			return;
		}
		const def = surfaceDef(id);
		const wasMaximised = maximised;
		const { stage, min } = gripRange;
		/* The stage can move mid-drag (a rotation, the on-screen keyboard, a
		 * banner appearing), and the release decides page-vs-dock against its
		 * ceiling, so read it live rather than trusting the value captured at
		 * pointerdown against a ceiling that may no longer exist. */
		const liveStage = (): number =>
			gripEdge === 'bottom' ? workspace.stage.h : workspace.stage.w;
		/* A maximised surface becomes a dock so the drag is an ordinary one,
		 * but only once the pointer has genuinely moved: onMove fires from the
		 * first pointermove while onRelease waits for TAP_SLOP, so demoting on
		 * any movement let a 1-5px twitch leave a full-stage dock behind with
		 * nothing committed. It also keeps its CURRENT height rather than
		 * taking the whole stage, which used to collapse an open side dock and
		 * the detail panel for the duration of the drag. */
		let demoted = false;
		const demote = (moved: number): void => {
			if (wasMaximised && !demoted && moved >= TAP_SLOP) {
				demoted = true;
				movePlacement(id, 'dock-bottom');
			}
		};
		if (gripEdge === 'bottom') {
			startSheetDrag(e, {
				startHeight: gripRange.size,
				min,
				max: stage,
				onMove: (px, moved) => {
					demote(moved);
					if (demoted || !wasMaximised) {
						setDockPx('bottom', px);
					}
				},
				onRelease: (px, velocity) => {
					const now = liveStage();
					// A flick runs the divider to the end it was thrown at.
					const target = velocity > FLICK ? now : velocity < -FLICK ? min : px;
					applyRelease(
						wasMaximised
							? pageRelease(def, now, target)
							: dockRelease(def, 'bottom', now, target),
						'bottom',
					);
				},
			});
			return;
		}
		// The grip is on the panel's left edge, so dragging right shrinks it.
		startResize(
			e,
			gripRange.size,
			{ dir: -1, min, max: stage },
			(px) => setDockPx('right', px),
			(px) => applyRelease(dockRelease(def, 'right', liveStage(), px), 'right'),
		);
	}

	/** Back to the surface's own share of the stage, forgetting a remembered
	 *  drag. A maximised surface comes back down to its dock on the way. */
	function resetGrip(): void {
		if (!gripEdge) {
			return;
		}
		if (maximised) {
			setPlacement(id, gripEdge === 'bottom' ? 'dock-bottom' : 'dock-right');
		}
		resetDockPx(gripEdge);
	}

	function onGripKey(e: KeyboardEvent): void {
		if (!gripEdge) {
			return;
		}
		if (e.key === 'Home') {
			e.preventDefault();
			resetGrip();
			return;
		}
		const grow = gripEdge === 'bottom' ? 'ArrowUp' : 'ArrowLeft';
		const shrink = gripEdge === 'bottom' ? 'ArrowDown' : 'ArrowRight';
		const step = e.key === grow ? 16 : e.key === shrink ? -16 : 0;
		if (step === 0) {
			return;
		}
		e.preventDefault();
		const def = surfaceDef(id);
		const target = gripRange.size + step;
		applyRelease(
			maximised
				? pageRelease(def, gripRange.stage, target)
				: dockRelease(def, gripEdge, gripRange.stage, target),
			gripEdge,
		);
	}

	// Rule 4 (docs/i18n.md): no t.* in $props() fallbacks; derive instead.
	const closeText = $derived(closeLabel ?? t.common.close);

	function dismiss(): void {
		(onEscape ?? onClose)();
	}

	/* System/browser Back dismisses a surface that owns the screen, and a
	 * phone's dock, which is the same half-screen sheet gesture the sidebar
	 * and detail panels already answer to. A desktop dock is persistent
	 * furniture and takes no history entry.
	 *
	 * The effect reads the single boolean, never the placement it comes from.
	 * registerBackClose's release consumes its entry with history.back(),
	 * which is async, so a re-registration in the same tick pushes its
	 * replacement BEFORE that back() lands and the position drifts down one
	 * entry each time; a few placement changes and it steps off the app's own
	 * entries entirely and the page reloads. Collapsing the dependency to the
	 * value means a surface that stays dismissable (a phone dock going full
	 * screen and back) never re-registers at all. */
	const needsBackEntry = $derived(modal || (docked && ui.isMobile));
	$effect(() => {
		if (!needsBackEntry) {
			return;
		}
		return registerBackClose(dismiss);
	});

	/* The page setup is registered while open but installed only for the
	 * duration of a job that names this surface. */
	$effect(() => {
		if (!open || !pageCss) {
			return;
		}
		return registerPageSetup(id, pageCss);
	});

	/* And what that job is called, the same way: registered while open so the
	 * bare Ctrl+P auto-claim names itself too. */
	$effect(() => {
		if (!open || !printName) {
			return;
		}
		return registerPrintName(id, printName);
	});

	/* Another surface claiming this one's slot closes it through the same
	 * handler as its own X, so a close that asks first (the aircraft editor's
	 * unsaved-edits confirm) still gets to, and can refuse. */
	$effect(() => {
		if (!open) {
			return;
		}
		return registerSurfaceClose(id, onClose);
	});
</script>

<svelte:window
	onkeydown={(e: KeyboardEvent) => {
		if (modal && e.key === 'Escape') {
			dismiss();
		}
	}}
/>

{#if open && placement !== null}
	<!-- Portal to <body> so a transformed ancestor (DetailPanel's slide-in)
	 can't become the containing block for position:fixed and pull the box
	 off the geometry its placement asks for. -->
	<div use:portal>
		{#if modal}
			<button
				class="modal-backdrop"
				aria-label={t.common.dismiss}
				onpointerdown={onClose}
				oncontextmenu={(e) => e.preventDefault()}
			></button>
		{/if}

		<div
			class={['modal-box', `at-${placement}`, boxClass, isPrintingSurface(id) && 'printing']}
			style:--surface-min-w="{surfaceDef(id).minWidthPx}px"
			use:focusTrapIf={modal}
			role={modal ? 'dialog' : 'region'}
			aria-modal={modal ? 'true' : undefined}
			aria-label={label}
			aria-labelledby={labelledby}
			onkeydown={(e: KeyboardEvent) => {
				// Escape reaches a non-modal surface only from inside it, so it
				// cannot swallow the key from the sidebar or the map.
				if (!modal && e.key === 'Escape') {
					e.stopPropagation();
					dismiss();
				}
			}}
		>
			{#if gripEdge}
				<!-- A button, like the sidebar and detail-panel handles: the drag
				 is pointer-driven but the control has to be reachable and
				 nudgeable from the keyboard. -->
				<button
					type="button"
					class="dock-grip no-print"
					class:vertical={gripEdge === 'right'}
					aria-label={t.common.resizePanel}
					title={t.common.resizePanelTip}
					onpointerdown={onGripDown}
					ondblclick={resetGrip}
					onkeydown={onGripKey}
				></button>
			{/if}
			<header class="modal-header">
				<!-- The snippet renders into its own strip so overflowing header
				 content (the flight-prep page pills on a phone) scrolls behind
				 the pinned controls instead of pushing them off-screen. -->
				<div
					class="modal-header-main"
					class:fade-l={stripL}
					class:fade-r={stripR}
					bind:this={stripEl}
					onscroll={syncStripEdges}
				>
					{@render header()}
				</div>
				{#if actions}
					<!-- Pinned beside the switcher, outside the scrolling strip,
					 so it can never scroll out of reach. -->
					<!-- Disclosure, not a menu: see Toolbar.svelte. -->
					<button
						class="modal-close no-print"
						aria-label={actionsText}
						title={actionsText}
						aria-expanded={actionsOpen}
						onclick={openActions}
					>
						<Icon name={actionsIcon} />
					</button>
				{/if}
				<PlacementSwitcher {id} />
				<button class="modal-close no-print" aria-label={closeText} onclick={onClose}>
					<Icon name="x" />
				</button>
			</header>
			{@render children()}
		</div>

		{#if actions}
			<HeadOverlay
				open={actionsOpen}
				x={actionsAnchor.x}
				y={actionsAnchor.y}
				title={actionsText}
				minWidthPx={240}
				surface={id}
				onClose={closeActions}
			>
				{@render actions({ close: closeActions })}
			</HeadOverlay>
		{/if}

		<!-- Above-surface menus AND print-only documents, so this cannot be
		     blanket .no-print: the kneeboard and dossier docs live here too.
		     The menus carry .no-print themselves; see the profile modals. -->
		{@render extra?.()}
	</div>
{/if}

<style>
	/* The dock's resize handle, straddling the edge it shares with the map.
	   The pill only shows on hover or focus so a chart is not framed by
	   permanent furniture; touch keeps it out, where there is no hover to
	   discover it with, and gets a deeper grab band. */
	.dock-grip {
		position: absolute;
		top: -3px;
		right: 0;
		left: 0;
		z-index: 1;
		height: 9px;
		padding: 0;
		border: none;
		background: transparent;
		cursor: row-resize;
		touch-action: none;
	}

	.dock-grip.vertical {
		top: 0;
		right: auto;
		bottom: 0;
		left: -3px;
		width: 9px;
		height: auto;
		cursor: col-resize;
	}

	.dock-grip::after {
		content: "";
		position: absolute;
		top: 3px;
		left: 50%;
		width: 40px;
		height: 3px;
		border-radius: 2px;
		background: var(--text-muted);
		opacity: 0;
		transform: translateX(-50%);
		transition: opacity 0.12s ease;
	}

	.dock-grip.vertical::after {
		top: 50%;
		left: 3px;
		width: 3px;
		height: 40px;
		transform: translateY(-50%);
	}

	.dock-grip:hover::after,
	.dock-grip:focus-visible::after {
		opacity: 0.8;
	}

	.dock-grip:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	@media (pointer: coarse) {
		.dock-grip {
			top: -6px;
			height: 16px;
		}

		/* A paged surface's top edge IS the stage top, so the overhang would
		   reach the toolbar buttons above it and start a resize instead of
		   activating one. A dock's neighbour is the map, which has nothing to
		   steal. */
		.modal-box.at-page .dock-grip:not(.vertical) {
			top: 0;
			height: 12px;
		}

		.dock-grip.vertical {
			top: 0;
			left: -6px;
			width: 16px;
			height: auto;
		}

		.dock-grip::after {
			top: 6px;
			opacity: 0.8;
		}

		.dock-grip.vertical::after {
			top: 50%;
			left: 6px;
		}
	}
</style>
