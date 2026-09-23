<script lang="ts">
	/* The map's own layers and fit buttons (Settings > Interface, "Layers
	 * control: on the map"): a floating pair on the map's right edge, the
	 * mock the pilot chose them on, so the toolbar's two buttons go and the
	 * chart is one tap from the thumb. Phone only, rendered by MapView
	 * beside the band. */
	import Icon from '../Icon.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { display } from '$lib/state/display.svelte';
	import { fitMap } from '$lib/state/phoneNav.svelte';
	import { openPage, ui } from '$lib/state/ui.svelte';

	const shown = $derived(ui.isMobile && display.layersControl === 'map');
</script>

{#if shown}
	<div class="map-btns no-print">
		<button type="button" class="icon-btn" onclick={() => openPage('layers')} title={t.tabs.layers} aria-label={t.tabs.layers}>
			<Icon name="layers" />
		</button>
		<button type="button" class="icon-btn" onclick={fitMap} title={t.common.fitMap} aria-label={t.common.fitMap}>
			<Icon name="crosshair" />
		</button>
	</div>
{/if}

<style>
	/* Right edge, mid-height: under the band, above the pane, clear of the
	   Leaflet controls at the top left and the attribution at the bottom
	   right. Same z as the band. */
	.map-btns {
		position: absolute;
		top: 50%;
		right: max(8px, var(--sar));
		z-index: 470;
		display: flex;
		flex-direction: column;
		gap: 8px;
		transform: translateY(-50%);
	}

	.map-btns .icon-btn {
		width: 44px;
		height: 44px;
		background: color-mix(in srgb, var(--surface) 92%, transparent);
		border: 1px solid var(--border-strong);
		border-radius: 10px;
		box-shadow: var(--shadow-1);
	}

	:global(:root.in-flight) .map-btns .icon-btn {
		width: 52px;
		height: 52px;
	}
</style>
