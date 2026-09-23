<script lang="ts">
	/* The desktop's detail panel: the side overlay ui.detail drives. On a
	 * phone the detail is the pane instead (DetailSurface.svelte, the
	 * `detail` workspace surface, opened by App.svelte's bridge), so this
	 * component renders nothing there. The presentation (title, subtitle,
	 * back link, centring, the NOTAM stepper) is the shared detailHead
	 * module, one definition for both homes. */
	import { t } from '$lib/state/i18n.svelte';
	import Icon from './Icon.svelte';
	import DetailBody from './detail/DetailBody.svelte';
	import { ui, closeDetail, type DetailTarget } from '$lib/state/ui.svelte';
	import {
		startResize,
		nudgeResize,
		loadPanelWidth,
		savePanelWidth,
		type ResizeOptions,
	} from '$lib/ui/resize';
	import { registerBackClose } from '$lib/ui/backClose';
	import {
		centerSelected,
		detailBack,
		detailBackLabel,
		detailCanCenter,
		detailKeydown,
		detailOpen,
		detailScrollKey,
		detailSelection,
		detailSubtitle,
		detailTitle,
		notamStepper,
		stepToNotam,
	} from './detail/detailHead.svelte';

	const selection = $derived(detailSelection());
	const open = $derived(!ui.isMobile && detailOpen(selection));
	const title = $derived(detailTitle(selection));
	const subtitle = $derived(detailSubtitle(selection));
	const canCenter = $derived(detailCanCenter(selection));
	const backLabel = $derived(detailBackLabel());
	const notamNav = $derived(notamStepper());

	function onKeydown(e: KeyboardEvent): void {
		if (open) {
			detailKeydown(e, notamNav);
		}
	}

	const WIDTH_KEY = 'loxodrome:detail-width';
	// The handle sits on the panel's left edge, so dragging right shrinks it.
	const RESIZE: ResizeOptions = { dir: -1, min: 320, max: 760 };

	let panelWidth = $state(loadPanelWidth(WIDTH_KEY, 480));

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

	// Per-target scroll memory; when navigating between linked panels
	// (e.g. airport → NOTAM → back), restore the previous panel's scroll
	// position rather than jumping to the top. Local non-reactive cache;
	// the map of remembered offsets is small (one entry per visited
	// target) and lives for the page lifetime.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const scrollPositions = new Map<string, number>();
	let scrollEl = $state<HTMLDivElement>();
	let prevDetail: DetailTarget | null = null;

	function onDetailScroll(): void {
		// Save the current target's scroll position each time the user
		// scrolls; by the time `ui.detail` changes, scrollTop already
		// reflects the new panel, so we have to capture continuously.
		if (prevDetail && scrollEl) {
			scrollPositions.set(detailScrollKey(prevDetail), scrollEl.scrollTop);
		}
	}

	$effect(() => {
		const next = ui.detail;
		prevDetail = next;
		if (!next) {
			return;
		}
		const saved = scrollPositions.get(detailScrollKey(next)) ?? 0;
		// Defer until the new panel's content has rendered.
		requestAnimationFrame(() => {
			if (scrollEl) {
				scrollEl.scrollTop = saved;
			}
		});
	});

	// System/browser Back closes the open panel (the Android back gesture).
	// Keyed on `open` only: linked-panel navigation keeps it true, so one
	// history entry per panel session, and Back dismisses the whole panel.
	// On a phone the surface's shell registers instead.
	$effect(() => {
		if (!open) {
			return;
		}
		return registerBackClose(closeDetail);
	});
</script>

<svelte:window onkeydown={onKeydown} />

{#if !ui.isMobile}
	<aside class="detail" class:open style:width={`${panelWidth}px`} aria-hidden={!open}>
		{#if open}
			<button
				class="resize-handle"
				aria-label={t.common.resizeDetail}
				onpointerdown={onResizeStart}
				onkeydown={onResizeKey}
			></button>
			<header class="detail-head">
				{#if backLabel}
					<button class="back-btn" onclick={detailBack}>
						<Icon name="chevron-left" size={14} />
						<span>{backLabel}</span>
					</button>
				{/if}
				{#if notamNav}
					<nav class="notam-nav" aria-label={t.common.stepThroughList}>
						<button
							class="step-btn"
							disabled={notamNav.prev === null}
							onclick={() => notamNav.prev !== null && stepToNotam(notamNav.prev)}
							aria-label={t.common.prevNotam}
						>
							<Icon name="chevron-left" size={14} />
							<span>{t.common.prev}</span>
						</button>
						<span class="step-pos">{notamNav.pos + 1} / {notamNav.total}</span>
						<button
							class="step-btn"
							disabled={notamNav.next === null}
							onclick={() => notamNav.next !== null && stepToNotam(notamNav.next)}
							aria-label={t.common.nextNotam}
						>
							<span>{t.common.next}</span>
							<Icon name="chevron-right" size={14} />
						</button>
					</nav>
				{/if}
				<div class="detail-headline">
					<div class="detail-heading">
						<div class="detail-id">{title}</div>
						<div class="detail-sub">{subtitle}</div>
					</div>
					<div class="detail-actions">
						<button
							class="icon-btn"
							onclick={() => centerSelected(selection)}
							disabled={!canCenter}
							aria-label={t.common.centerMapAria}
							title={t.common.centerMap}
						>
							<Icon name="crosshair" />
						</button>
						<button class="icon-btn" onclick={closeDetail} aria-label={t.common.closeDetail}>
							<Icon name="x" />
						</button>
					</div>
				</div>
			</header>
			<div class="detail-scroll" bind:this={scrollEl} onscroll={onDetailScroll}>
				<DetailBody {selection} />
			</div>
		{/if}
	</aside>
{/if}

<style>
	/* The panel is an overlay: it covers part of the map, and map/focus.ts
	   shifts the centre by its width so a selection still lands where the
	   user can see it. The docks are not overlays, they hold reserved space,
	   so the panel keeps clear of both (each var is 0 when its slot is
	   empty): above the bottom dock, left of the side dock. */
	.detail {
		position: absolute;
		top: 0;
		right: var(--dock-r, 0);
		bottom: var(--dock-b, 0);
		display: flex;
		flex-direction: column;

		/* 100% is the workspace, which includes the sidebar: with a wide side
		   dock the panel could otherwise start left of the stage and paint over
		   the sidebar (520 > 500). Hold it to the stage instead. */
		max-width: calc(100vw - var(--stage-l, 0px) - var(--dock-r, 0px));
		background: var(--surface);
		border-left: 1px solid var(--border);
		box-shadow: var(--shadow-2);

		/* Parked off-screen while closed. The 105% is of the panel's OWN width,
		   which only clears the workspace when its `right` inset is 0: with a
		   side dock the panel is inset by --dock-r, so the park fell short by
		   exactly that and left an empty white panel sitting over the dock
		   (invisible until the z-index above put it there). Clear the inset
		   too. */
		transform: translateX(calc(105% + var(--dock-r, 0px)));
		transition: transform 0.18s ease;

		/* Above a paged surface (1090), below the modal backdrop (1099): a
		   page takes the map's own box, and the panel has always overlaid the
		   map. Under it, clicking a list row opened the panel invisibly
		   behind the workbook and it stayed Tab-reachable while hidden. */
		z-index: 1092;
	}

	.detail.open {
		transform: translateX(0);
	}

	.resize-handle {
		position: absolute;
		top: 0;
		left: -3px;
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

	.detail-head {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--border);
	}

	.detail-headline {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	/* Keep the crosshair + close buttons clustered at the right edge;
	 * without the wrapper the headline's space-between would strand the
	 * crosshair in the middle of the header. */
	.detail-actions {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.back-btn {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		align-self: flex-start;
		padding: 2px 4px;
		margin-left: -4px;
		font: inherit;
		font-size: 12px;
		color: var(--text-muted);
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.back-btn:hover {
		color: var(--accent);
	}

	.back-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.notam-nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.step-btn {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		padding: 2px 7px;
		font: inherit;
		font-size: 12px;
		color: var(--text-muted);
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 4px;
		cursor: pointer;
	}

	.step-btn:hover:not(:disabled) {
		color: var(--accent);
		border-color: var(--accent);
	}

	.step-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.step-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.step-pos {
		font-size: 11px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.detail-id {
		font-size: 16px;
		font-weight: 700;
	}

	.detail-sub {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}

	.detail-scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 14px;
		overscroll-behavior: none;
	}

	/* Touch targets (the app.css .icon-btn pattern): the stepper / back link
	   reach 44px effective via padding + slop on a tablet. */
	@media (pointer: coarse) {
		.step-btn,
		.back-btn {
			position: relative;
			min-height: 36px;
		}

		.step-btn {
			padding: 6px 14px;
		}

		.back-btn {
			padding: 6px 8px;
		}

		.step-btn::after,
		.back-btn::after {
			content: '';
			position: absolute;
			inset: -4px 0;
		}
	}
</style>
