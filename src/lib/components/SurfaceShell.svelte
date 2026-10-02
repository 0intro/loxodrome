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
	import { onDestroy, type Snippet } from 'svelte';
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
		PHONE_LANDSCAPE_FRACS,
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
		releaseOrphanedSurface,
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
	import { FLICK, TAP_SLOP, startSheetDrag, suppressNextClick } from '$lib/ui/sheet';
	import { startResize } from '$lib/ui/resize';
	import { ui } from '$lib/state/ui.svelte';
	import { dismissOnDown } from '$lib/ui/dismissOnDown';

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
	// Closed with the surface, and with the rows it lists: left open, the
	// menu reappeared unasked at the next open (the Offline surface offers
	// its actions only while its queue runs), a sheet grabbing focus and a
	// Back entry on a phone.
	$effect(() => {
		if (!open || !actions) {
			actionsOpen = false;
		}
	});
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
	/** The phone pane: a map-coupled surface on the phone layout, docked or
	 *  at its full (page) detent. Its head carries the handle that cycles the
	 *  detents; the placement switcher stays off it. */
	const pane = $derived(ui.isMobile && surfaceDef(id).mapCoupled && (docked || placement === 'page'));

	/** A press anywhere on the pane's head ARMS the same drag the handle
	 *  does and takes the pointer only once it has moved past the slop. The
	 *  head is both the surface a bottom sheet is dragged by and the strip
	 *  carrying its controls, so it cannot choose between them at press
	 *  time: an un-moved press is left to whatever is under it (the
	 *  profile's Route | Trace hop, the layers button, the actions), and a
	 *  drag moves the window even when it began on one. The rule the
	 *  profile charts already use for their own pan (ui/plotGestures.ts). */
	function headerDragDown(e: PointerEvent): void {
		// Only where the head IS the edge a bottom sheet is dragged by. Held
		// sideways the pane is a right dock, so the head's own axis is the
		// one its strip scrolls along: arming a width drag on a vertical
		// wiggle would be a gesture nobody aimed at, and arming it on the
		// horizontal one would take the strip's scroll away.
		if (gripEdge !== 'bottom' || e.button !== 0) {
			return;
		}
		const hdr = e.currentTarget as HTMLElement;
		const startY = e.clientY;
		// On the WINDOW, not the head: nothing captures the pointer while
		// the press is only armed (an un-moved press has to stay available
		// to the control under it), so a finger that leaves the head would
		// take its moves and its release with it, arming nothing and leaving
		// this pair attached for good.
		// The teardown handle: these three listeners come off on the arming
		// pointer's own release or when the press becomes a drag, and a
		// surface can be evicted (or closed by a rotation's reflow) while a
		// press is merely armed. Without this they outlive the component,
		// closed over a detached head.
		const disarm = (ev?: PointerEvent): void => {
			// Only the pointer that armed this: on the window another
			// finger's release would otherwise cancel a press still waiting
			// to become a drag.
			if (ev && ev.pointerId !== e.pointerId) {
				return;
			}
			window.removeEventListener('pointermove', armedMove);
			window.removeEventListener('pointerup', disarm);
			window.removeEventListener('pointercancel', disarm);
		};
		function armedMove(ev: PointerEvent): void {
			if (ev.pointerId !== e.pointerId) {
				return;
			}
			if (Math.abs(ev.clientY - startY) < TAP_SLOP) {
				return;
			}
			disarm();
			// The drag began where the finger first landed, not where it
			// crossed the slop, so the surface does not jump on take-over.
			// It runs on the HEAD, which is what the drag then captures.
			onGripDown(ev, false, startY, hdr);
		}
		window.addEventListener('pointermove', armedMove);
		window.addEventListener('pointerup', disarm);
		window.addEventListener('pointercancel', disarm);
		disarmArmed = () => disarm();
	}

	/** Set while a header press is armed; the destroy teardown below calls it. */
	let disarmArmed: (() => void) | null = null;
	$effect(() => () => disarmArmed?.());

	/** Enter / Space on the handle. A keyboard activation fires a click with
	 *  no pointer behind it (`detail` 0) and is the only one this answers:
	 *  the pointer paths do their own tap-versus-drag detection, and a touch
	 *  release synthesises a click of its own that would otherwise cycle the
	 *  detent a drag had just chosen. */
	function handleKeyClick(e: MouseEvent): void {
		if (e.detail === 0) {
			cycleDetent();
		}
	}

	/** A tap on the pane's handle: portrait cycles half (the dock) and full
	 *  (the page); landscape cycles the two right-dock widths. Through
	 *  movePlacement / commitDockPx, which on the phone remember nothing, so
	 *  the pane always reopens at half (the remembered-height defect). */
	function cycleDetent(): void {
		if (!pane) {
			return;
		}
		if (ui.isLandscapePhone) {
			const stage = workspace.stage.w;
			if (stage <= 0) {
				return;
			}
			const [narrow, wide] = PHONE_LANDSCAPE_FRACS;
			const cur = workspace.dockPx.right / stage;
			const target = Math.abs(cur - narrow) <= Math.abs(cur - wide) ? wide : narrow;
			commitDockPx('right', Math.round(stage * target));
			return;
		}
		if (placement === 'page') {
			movePlacement(id, 'dock-bottom');
		} else if (surfaceDef(id).placements.includes('page')) {
			movePlacement(id, 'page');
		}
	}
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
			min: Math.min(minDockPx(surfaceDef(id), gripEdge, pane), Math.max(1, stage)),
			// A maximised surface has no dock size of its own: it holds the stage.
			size: maximised ? stage : workspace.dockPx[gripEdge],
		};
	});

	/** Apply a released drag: a size keeps the dock, otherwise maximise. */
	function applyRelease(result: DockRelease, releaseEdge: DockEdge): void {
		// The pane remembers nothing: a drag is a detent change, not a choice
		// the next open should come back to (openSurface's rule).
		const move = pane ? movePlacement : setPlacement;
		if (result.kind === 'page') {
			// Already maximised: a phone renders `page` as `full`, so moving
			// would change nothing on screen while silently rewriting the
			// user's own stored choice from `full` to `page`.
			if (maximised) {
				return;
			}
			// The width the drag was let go at, read BEFORE the move: claiming
			// a slot re-seeds a pane's size to its own detent.
			const livePx = workspace.dockPx[releaseEdge];
			const before = placementOf(id);
			if (!move(id, 'page')) {
				// Refused by whoever holds the overlay slot. The surface is
				// still a dock, and the live drag left it past the resting
				// ceiling, so settle it back inside the range.
				commitDockPx(releaseEdge, livePx);
				return;
			}
			if (placementOf(id) === before) {
				// A LANDSCAPE phone pane has no page to become: resolvePlacement
				// sends `page` back to the right dock it already holds, so the
				// move reports success having changed nothing on screen while
				// re-seeding the width to the narrow detent. Nothing moved, so
				// the release is a SIZE after all and the pane keeps what the
				// pilot let go at (clamped to the resting range, remembered for
				// nobody, which is the pane's rule).
				commitDockPx(releaseEdge, livePx);
			}
			return;
		}
		move(id, releaseEdge === 'bottom' ? 'dock-bottom' : 'dock-right');
		commitDockPx(releaseEdge, result.px);
	}

	/* `tappable`: the HANDLE's press cycles the detents when it never moved;
	 * a press that started on the rest of the head only drags, because a tap
	 * on a title that quietly resized the window would be a control nobody
	 * aimed at. */
	function onGripDown(
		e: PointerEvent,
		tappable = true,
		startY?: number,
		target?: HTMLElement,
	): void {
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
				...(startY === undefined ? {} : { startY }),
				...(target === undefined ? {} : { target }),
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
							? pageRelease(def, now, target, pane)
							: dockRelease(def, 'bottom', now, target, pane),
						'bottom',
					);
				},
				// The pane's handle: a press that never moved is the detent tap.
				onTap: pane && tappable ? cycleDetent : undefined,
			});
			return;
		}
		// The grip is on the panel's left edge, so dragging right shrinks it.
		const from = gripRange.size;
		let moved = false;
		startResize(
			e,
			from,
			{ dir: -1, min, max: stage },
			(px) => {
				if (Math.abs(px - from) >= TAP_SLOP) {
					moved = true;
				}
				setDockPx('right', px);
			},
			(px) => {
				// A press that never became a drag is the detent tap, the
				// mirror of startSheetDrag's onTap on the other edge. Either
				// branch moves the pane under the finger, so either has to
				// swallow the click the release synthesises on whatever has
				// taken its place (the rule ui/sheet.ts states); a press that
				// moved nothing and cycles nothing synthesises none worth
				// eating, so it arms nothing.
				const settle = (): void => {
					if (e.pointerType !== 'mouse') {
						suppressNextClick();
					}
				};
				if (!moved) {
					if (pane && tappable) {
						settle();
						cycleDetent();
					}
					return;
				}
				settle();
				applyRelease(dockRelease(def, 'right', liveStage(), px, pane), 'right');
			},
		);
		// `moved` lives per GESTURE and is read only by the closures above, so
		// a second finger's refused press cannot clear it under the running
		// drag, whose own release then read as a tap and threw the drag away.
	}

	/** Back to the surface's own share of the stage, forgetting a remembered
	 *  drag. A maximised surface comes back down to its dock on the way. */
	function resetGrip(): void {
		// The PANE has nothing to reset and nothing to reset it to: it opens at
		// its own detent every time and remembers no size (openSurface's rule).
		// Running the desktop reset from its grip would write the surface's
		// remembered DESKTOP placement through setPlacement and delete its
		// remembered desktop dock size, from a double-tap on a 9 px strip whose
		// single taps cycle the detents.
		if (!gripEdge || pane) {
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
				? pageRelease(def, gripRange.stage, target, pane)
				: dockRelease(def, gripEdge, gripRange.stage, target, pane),
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
	const needsBackEntry = $derived(modal || (ui.isMobile && (docked || placement === 'page')));
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

	/* A shell that goes while its surface is open releases the slot, a
	 * microtask later (outside the teardown, whose state reads answer the
	 * values from before the flush) and unless a new shell for the same id
	 * has registered since. This is what keeps a conditional PARENT harmless
	 * (docs/workspace-surfaces.md): its branch flipping destroys the shell,
	 * and the surface closes with it instead of staying claimed with nothing
	 * to draw it or close it. */
	onDestroy(() => {
		queueMicrotask(() => releaseOrphanedSurface(id));
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
			<!-- `above-bar` is what ends this backdrop over the phone's nav bar:
			     a FULL surface is furniture the bar stays reachable beside,
			     which a genuinely blocking dialog is not (app.css). -->
			<button
				class={['modal-backdrop', placement === 'full' && 'above-bar']}
				aria-label={t.common.dismiss}
				onpointerdown={dismissOnDown(onClose)}
				oncontextmenu={(e) => e.preventDefault()}
			></button>
		{/if}

		<!-- A phone PAGE is opaque over the whole stage at z 1093, and a
		     docked or paged surface sits at 1090 UNDER it. App.svelte stamps
		     the workspace inert for exactly this, but a surface is portaled
		     to <body> and is no descendant of it, so the page hid a live nav
		     log: its cells stayed in the tab order and a screen reader's
		     swipe order behind an opaque page. A modal surface (full /
		     dialog, z 1100) is ABOVE the page and stays live. -->
		<div
			class={['modal-box', `at-${placement}`, boxClass, isPrintingSurface(id) && 'printing']}
			inert={(ui.page !== null && !modal) || undefined}
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
			<!-- On the phone pane the WHOLE head is the drag surface, not just
			     its handle: the head is what a bottom sheet is dragged by, and
			     the strip inside it scrolls sideways, so a drag on the title
			     used to slide the text along the bar instead of moving the
			     window. A press that lands on one of the head's own controls
			     is left alone (headerDragDown), so the hop, the layers button,
			     the actions and the X still take their taps. -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<header
				class="modal-header"
				class:pane-head={pane}
				onpointerdown={pane ? headerDragDown : undefined}
			>
				{#if pane}
					<!-- The pane's handle: a tap cycles the detents (half / full in
					     portrait, the two widths in landscape), a drag resizes
					     through the same grip logic as the edge. -->
					<button
						type="button"
						class="pane-handle no-print"
						aria-label={t.common.paneDetent}
						title={ui.isLandscapePhone ? t.common.paneDetentTipWide : t.common.paneDetentTip}
						onpointerdown={onGripDown}
						onclick={handleKeyClick}
						onkeydown={onGripKey}
					>
						<span class="grip-bar"></span>
					</button>
				{/if}
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
				{#if !pane}
					<PlacementSwitcher {id} />
				{/if}
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

	/* The pane's handle (phones): the pill every bottom sheet on the platform
	   wears, in the head so the head IS the grip. 48 px wide, the head's
	   36 px tall, a 44 px reach through the outset. */
	.pane-handle {
		position: relative;
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		width: 48px;
		height: 36px;
		padding: 0;
		cursor: grab;
		background: transparent;
		border: none;
		touch-action: none;
	}

	.pane-handle::after {
		position: absolute;
		inset: -4px 0;
		content: '';
	}

	.pane-handle .grip-bar {
		width: 32px;
		height: 4px;
		background: var(--border-strong);
		border-radius: 2px;
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
