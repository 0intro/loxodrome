<script lang="ts">
	/* Shared presentation for the NOTAMs-tab head overlays (the Filters
	 * popover and the loader): on desktop / tablet an anchored popup via
	 * PopupMenu at the invocation point (the head button's rect), on phones
	 * a backdropped full-width sheet pinned to the bottom. The branch is
	 * decided in state via ui.isMobile (the resolvePlacement doctrine),
	 * never by a media query; z levels follow PopupMenu's backdrop
	 * conventions (1095 / 1096, and 1101 / 1102 over a modal surface box,
	 * see `surface`). PopupMenu owns Escape and the system Back gesture on
	 * desktop; the sheet branch wires the same two here. */
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import PopupMenu from './PopupMenu.svelte';
	import { type SurfaceId, isModalPlacement } from '$lib/surfaces';
	import { placementOf } from '$lib/state/workspace.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import { registerBackClose } from '$lib/ui/backClose';
	import { portal } from '$lib/ui/portal';

	let {
		open,
		x,
		y,
		title,
		minWidthPx = 320,
		maxWidthPx = 380,
		surface,
		onClose,
		children,
	}: {
		open: boolean;
		x: number;
		y: number;
		/** Sheet-header title (phones only; the desktop popup hangs under
		 *  its labelled head button). */
		title: string;
		minWidthPx?: number;
		/** Desktop popup width cap (PopupMenu's CSS default; the alert
		 *  panel widens it). The sheet branch is full-width regardless. */
		maxWidthPx?: number;
		/** The workspace surface this overlay is raised from, when it is
		 *  raised from inside one. Both renditions rest in the popup band
		 *  (1095 / 1096), which clears a docked or paged box (1090) but NOT a
		 *  full-screen or dialog one (1100), and on a phone every non-docking
		 *  surface collapses to full screen: unnamed, the flight-prep and
		 *  nav-log overflow sheets opened behind their own box and the head
		 *  button read as dead. Naming the surface lifts scrim and sheet over
		 *  it for exactly the placements that need it, and leaves the rest in
		 *  the band, where a modal opening on top still covers them. */
		surface?: SurfaceId | undefined;
		onClose: () => void;
		children: Snippet;
	} = $props();

	const aboveSurface = $derived.by(() => {
		if (surface === undefined) {
			return false;
		}
		const placement = placementOf(surface);
		return placement !== null && isModalPlacement(placement);
	});

	$effect(() => {
		if (!open || !ui.isMobile) {
			return;
		}
		return registerBackClose(onClose);
	});
</script>

<svelte:window
	onkeydown={(e: KeyboardEvent) => {
		if (e.key === 'Escape' && open && ui.isMobile) {
			onClose();
		}
	}}
/>

<!-- Portaled to <body>: the sidebar is a z-500 stacking context (a flex
     item with z-index), so a fixed overlay rendered inside it would paint
     UNDER Leaflet's controls (z 1000). The portal lifts the backdrop and
     box into the root context where the 1095/1096 levels actually win. -->
<div use:portal>
	{#if ui.isMobile}
		{#if open}
			<button
				class="scrim no-print"
				class:above={aboveSurface}
				aria-label={t.common.dismissMenu}
				onpointerdown={onClose}
			></button>
			<!-- Portaled chrome sits outside #app, which the print flows hide
			     wholesale, so the sheet carries its own no-print. -->
			<div class="sheet no-print" class:above={aboveSurface}>
				<div class="sheet-head">
					<h3>{title}</h3>
					<button class="icon-btn" onclick={onClose} aria-label={t.common.close}>
						<Icon name="x" size={16} />
					</button>
				</div>
				<div class="sheet-body menu-panel">
					{@render children()}
				</div>
			</div>
		{/if}
	{:else}
		<PopupMenu {open} {x} {y} {minWidthPx} {maxWidthPx} {aboveSurface} {onClose}>
			{@render children()}
		</PopupMenu>
	{/if}
</div>

<style>
	.scrim {
		position: fixed;
		inset: 0;

		/* Above docked and paged surfaces (1090), below the modal backdrop
		   (1099): the PopupMenu z conventions. */
		z-index: 1095;
		padding: 0;
		border: none;
		background: rgb(0 0 0 / 32%);
		cursor: default;
	}

	:global([data-theme='night']) .scrim {
		background: rgb(0 0 0 / 55%);
	}

	/* Over a modal surface box (1100), PopupMenu's own raised band: the sheet
	   a full-screen surface opens has to clear the box it hangs from. */
	.scrim.above {
		z-index: 1101;
	}

	.sheet {
		position: fixed;
		right: 0;

		/* --kb is the mobile keyboard inset (App.svelte); the sheet rides
		   above it so its inputs stay reachable while typing. */
		bottom: var(--kb, 0);
		left: 0;
		z-index: 1096;
		display: flex;
		flex-direction: column;
		max-height: 80dvh;
		background: var(--surface);
		border-top: 1px solid var(--border-strong);
		border-radius: 12px 12px 0 0;
		box-shadow: var(--shadow-2);
	}

	.sheet.above {
		z-index: 1102;
	}

	.sheet-head {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 6px 6px 0 14px;
	}

	.sheet-head h3 {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}

	.sheet-body {
		flex: 1;
		min-height: 0;

		/* The home-indicator inset, which the two sibling bottom sheets
		   already pay: without it this sheet's last row of controls (the
		   level band's fields, the loader's buttons) sits under it.
		   --sheet-sab is the share still owed after a bottom dock or the
		   keyboard has stood in for it. */
		padding: 4px 12px max(12px, var(--sheet-sab));
		overflow-y: auto;
	}
</style>
