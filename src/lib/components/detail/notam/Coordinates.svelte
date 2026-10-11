<script lang="ts">
	import type { Notam, NotamCoordinate } from '$lib/notam/types';
	import { formatDMS, radiusUnitDisplay } from '$lib/notam';
	import { flyToVisible } from '$lib/map/focus';
	import { focusNotam } from '$lib/map/notamLayer';
	import { t } from '$lib/state/i18n.svelte';
	import { mapState } from '$lib/state/map.svelte';
	import { notamState } from '$lib/state/notam.svelte';

	interface Props {
		notam: Notam;
	}
	let { notam }: Props = $props();

	// A source NOTAM may define several areas; the parser splits them into
	// separate entries sharing the same id.
	const areas = $derived(
		notam.isPolygon
			? notamState.notams.filter((n) => n.id === notam.id && n.isPolygon)
			: [],
	);

	function radiusLabel(c: NotamCoordinate): string {
		if (c.radius == null) {
			return '';
		}
		// Qualifier-line coordinates carry a radius but no unit; it is NM.
		const unit = c.radiusUnit ? radiusUnitDisplay[c.radiusUnit] : 'NM';
		return `${c.radius} ${unit}`;
	}

	function focusCoordinate(c: NotamCoordinate): void {
		flyToVisible({ lat: c.lat, lng: c.lon });
	}

	// One sibling area of a multi-area NOTAM: the map frames that ring, the
	// same recipe the panel crosshair applies to the selected entry.
	function focusArea(area: Notam): void {
		if (mapState.map) {
			focusNotam(mapState.map, area);
		}
	}
</script>

{#snippet coordList(coords: NotamCoordinate[])}
	<ul class="coords">
		{#each coords.slice(0, 20) as c, i (i)}
			<li>
				<button
					class="coord-btn"
					onclick={() => focusCoordinate(c)}
					title={t.notam.centerCoordinateTip}
				>
					{formatDMS(c.lat, c.lon)}
					{#if c.radius != null}
						<span class="radius">· {t.notam.radiusLabel(radiusLabel(c))}</span>
					{/if}
				</button>
			</li>
		{/each}
	</ul>
	{#if coords.length > 20}
		<p class="coords-more">{t.notam.moreVertices(coords.length - 20)}</p>
	{/if}
{/snippet}

{#if notam.coordinates.length > 0}
	<section class="block">
		<h3>{t.notam.coordinates}</h3>
		{#if notam.isPolygon && areas.length > 1}
			{#each areas as area, i (i)}
				<div class="area-group">
					<button
						class="area-label"
						class:current={area === notam}
						onclick={() => focusArea(area)}
						title={t.notam.centerAreaTip}
					>
						{t.notam.areaN(i + 1)}
					</button>
					{@render coordList(area.coordinates)}
				</div>
			{/each}
		{:else}
			{@render coordList(notam.coordinates)}
		{/if}
	</section>
{/if}

<style>
	.block h3 {
		margin: 0 0 4px;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.coords {
		margin: 0;
		padding-left: 18px;
		font-family: ui-monospace, monospace;
		font-size: 12px;
		line-height: 1.6;
	}

	.coords .radius {
		color: var(--text-muted);
	}

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

	.area-group + .area-group {
		margin-top: 8px;
	}

	.area-label {
		display: block;
		margin-bottom: 2px;
		padding: 0;
		font-family: inherit;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		text-align: left;
		color: var(--text-muted);
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.area-label:hover {
		color: var(--accent);
		text-decoration: underline;
	}

	.area-label:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.area-label.current {
		color: var(--accent);
	}

	.coords-more {
		margin: 2px 0 0;
		font-size: 12px;
		color: var(--text-muted);
	}
</style>
