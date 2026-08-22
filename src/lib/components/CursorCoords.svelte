<script lang="ts">
	import { formatCoord } from '$lib/format/coord';
	import { display } from '$lib/state/display.svelte';

	interface Props {
		coord: { lat: number; lng: number } | null;
	}
	const { coord }: Props = $props();

	// Live readout only. Copying a point happens from the right-click menu,
	// where the coordinate is captured at the click and can't drift as the
	// cursor moves to the action (see ContextMenu's "Copy coordinates").
	const fmt = $derived(coord ? formatCoord(coord.lat, coord.lng) : null);
</script>

{#if fmt && display.cursorCoords}
	<div class="badge">
		<div class="dms">{fmt.dms}</div>
		<div class="dec">{fmt.decimal}</div>
	</div>
{/if}

<style>
	.badge {
		position: absolute;
		left: 8px;
		bottom: 8px;
		z-index: 450;
		min-width: 11em;
		padding: 4px 8px;
		font-size: 11px;
		line-height: 1.3;
		text-align: left;
		color: var(--text);
		background: rgb(255 255 255 / 88%);
		border: 1px solid var(--border);
		border-radius: 4px;

		/* Non-interactive: never intercept clicks / right-clicks meant for the
		 * map beneath it (the badge sits over the bottom-left map corner). */
		pointer-events: none;
	}

	:global([data-theme="dark"]) .badge,
	:global([data-theme="night"]) .badge {
		background: rgb(20 22 26 / 88%);
	}

	.dec {
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	/* Hide on mobile: mousemove doesn't fire on touch, and the bottom
	 * sheet would compete with the badge for the bottom edge anyway.
	 * (mobile-ui: App.svelte's root class, THE breakpoint definition.) */
	:global(:root.mobile-ui) .badge {
		display: none;
	}
</style>
