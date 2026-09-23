<script lang="ts">
	/* The relative-terrain shading's key (docs/terrain-awareness.md), in the
	 * map's bottom-left corner above the cursor badge: the two tiers in the
	 * inks the map paints them, and the altitude they are read against, the
	 * same figure as the band's GPS ALT cell, so the colours never have to be
	 * guessed at. Garmin's Terrain page carries the same key and the same
	 * altitude readout (GSL). When a pose is on the map and the shading is
	 * withheld (a degraded or lost fix, no GPS altitude: Garmin's TER N/A),
	 * the key says so instead of disappearing, and a view zoomed out past
	 * the terrain's coarsest level says to zoom in. The pilot's inhibit of the
	 * terrain alerts is annunciated here too, beside the display it concerns,
	 * the place Garmin's TER INHB takes, and on its own when the shading is
	 * off: the inhibit silences every terrain and obstacle alert for the rest
	 * of the trace, and a display toggle must not hide that it does.
	 * Pointer-inert, like the badge under it. */
	import { layers } from '$lib/state/layers.svelte';
	import { terrainReferenceState, terrainShade } from '$lib/state/terrainAwareness.svelte';
	import { alertPrefs } from '$lib/state/airspaceAlert.svelte';
	import { terrainInhibited, terrainPrefs } from '$lib/state/terrainAlert.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { TERRAIN_NODATA_INK, terrainSwatchCss, terrainSwatches } from '$lib/map/terrainShade';

	const SWATCH = terrainSwatches();
	const NODATA_SWATCH = terrainSwatchCss(TERRAIN_NODATA_INK, 0.7);

	const refState = $derived(layers.terrainAwareness ? terrainReferenceState() : null);
	const ref = $derived(refState?.ref ?? null);
	const withheld = $derived(refState?.withheld ?? null);
	// The band's own rounding (NavStrip's GPS ALT cell), so the two agree.
	const altText = $derived(ref ? String(Math.round(ref.altFt)) : '');
	const inhibited = $derived(
		alertPrefs.enabled && (terrainPrefs.terrain || terrainPrefs.obstacle) && terrainInhibited(),
	);
</script>

{#if ref || withheld}
	<div class="terrain-legend no-print">
		<div class="head">
			<span class="title">{t.layers.terrain.legend}</span>
			{#if ref}
				<!-- i18n-ignore: GPS ALT is the band's own Doc 8400 label, locale-invariant -->
				<span class="ref">GPS ALT {altText} ft</span>
			{/if}
		</div>
		{#if withheld}
			<div class="note na">{t.layers.terrain.withheld[withheld]}</div>
		{:else if terrainShade.zoomedOut}
			<div class="note">{t.layers.terrain.zoomedOut}</div>
		{:else}
			<div class="row">
				<span class="swatch" style:background={SWATCH.red}></span>
				<span>{t.layers.terrain.red}</span>
			</div>
			<div class="row">
				<span class="swatch" style:background={SWATCH.yellow}></span>
				<span>{t.layers.terrain.yellow}</span>
			</div>
			{#if terrainShade.failed > 0}
				<div class="row">
					<span class="swatch nodata" style:--nodata={NODATA_SWATCH}></span>
					<span>{t.layers.terrain.noData}</span>
				</div>
			{/if}
			{#if terrainShade.pending > 0}
				<div class="note">{t.layers.terrain.loading}</div>
			{/if}
		{/if}
		{#if inhibited}
			<div class="note inhb">{t.navigation.alertTerrainInhibited}</div>
		{/if}
	</div>
{:else if inhibited}
	<div class="terrain-legend no-print">
		<div class="note inhb">{t.navigation.alertTerrainInhibited}</div>
	</div>
{/if}

<style>
	/* The cursor badge's own chrome, so the corner reads as one family. */
	.terrain-legend {
		min-width: 11em;
		max-width: 21em;
		padding: 4px 8px;
		font-size: 11px;
		line-height: 1.3;
		color: var(--text);
		background: rgb(255 255 255 / 88%);
		border: 1px solid var(--border);
		border-radius: 4px;
		pointer-events: none;
	}

	:global([data-theme="dark"]) .terrain-legend,
	:global([data-theme="night"]) .terrain-legend {
		background: rgb(20 22 26 / 88%);
	}

	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 2px;
	}

	.title {
		font-weight: 600;
	}

	.ref {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.swatch {
		flex: 0 0 auto;
		width: 10px;
		height: 10px;
		border: 1px solid rgb(0 0 0 / 25%);
		border-radius: 2px;
	}

	/* The no-data dither's look: a lattice of the map's own grey. */
	.swatch.nodata {
		background:
			repeating-linear-gradient(45deg, var(--nodata) 0 1px, transparent 1px 4px),
			repeating-linear-gradient(-45deg, var(--nodata) 0 1px, transparent 1px 4px);
	}

	.note {
		color: var(--text-muted);
	}

	.note.na {
		color: var(--text);
	}

	.note.inhb {
		font-weight: 600;
		color: var(--workbook-orange);
	}

	/* A finger's reading distance: the in-flight type size, still out of the
	   way of the map it explains. */
	:global(:root.touch-ui) .terrain-legend {
		font-size: 12px;
	}
</style>
