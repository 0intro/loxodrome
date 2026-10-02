<script lang="ts">
	/* The fly-to position button of the feature panels: DMS with the muted
	 * decimal pair below, the whole cell clickable to centre the map on the
	 * position (flyToVisible keeps it clear of the open panels). Two
	 * renderings: the stacked per-axis form (obstacle / navaid / station /
	 * nature) and the airport panel's one-line DMS + tabular decimal. */
	import { t } from '$lib/state/i18n.svelte';
	import { formatDMS, formatDMSAxis } from '$lib/notam/format';
	import { flyToVisible } from '$lib/map/focus';

	interface Props {
		lat: number;
		lon: number;
		/** One-line DMS + tabular decimal (the airport panel form). */
		inline?: boolean;
	}
	let { lat, lon, inline = false }: Props = $props();
</script>

<button
	type="button"
	class="coord-btn"
	onclick={() => flyToVisible({ lat, lng: lon })}
	title={t.detail.centerPositionTip}
>
	{#if inline}
		<div>{formatDMS(lat, lon)}</div>
		<div class="dec">{lat.toFixed(5)}, {lon.toFixed(5)}</div>
	{:else}
		<div>{formatDMSAxis(lat, 'N', 'S', 2)}</div>
		<div>{formatDMSAxis(lon, 'E', 'W', 3)}</div>
		<div class="muted">{lat.toFixed(5)}, {lon.toFixed(5)}</div>
	{/if}
</button>

<style>
	.coord-btn {
		display: block;
		width: 100%;
		padding: 0;
		font: inherit;
		text-align: left;
		color: var(--accent);
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.coord-btn:hover {
		text-decoration: underline;
	}

	.coord-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	/* Secondary decimal line: muted + tabular-nums so the digits align
	 * with the DMS row above; no underline on hover. */
	.dec {
		font-size: 12px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		text-decoration: none;
	}

	.muted {
		color: var(--text-muted);
		font-size: 11px;
		text-decoration: none;
	}
</style>
