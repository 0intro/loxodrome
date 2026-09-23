<script lang="ts">
	/* What this map draws.
	 *
	 * Loxodrome's Layers tab is 574 lines over chart stacks, offline packs and
	 * VAC georeference, none of which exists here. What is left is the part a
	 * NOTAM viewer needs: the base map, the airspace categories, the aerodrome
	 * groups, the SUP AIP overlay and the NOTAM markers themselves.
	 *
	 * Every string is already in the shared catalogs, because every toggle is a
	 * shared toggle: state/layers.svelte.ts is one definition, and this is a
	 * second face on it rather than a second set of preferences.
	 */
	import HeadOverlay from '$lib/components/HeadOverlay.svelte';
	import { BASE_LAYERS } from '$lib/map/baseLayers';
	import { t } from '$lib/state/i18n.svelte';
	import { CATEGORIES } from '$lib/map/airspaceLayer';
	import { dataState } from '$lib/state/data.svelte';
	import { display } from '$lib/state/display.svelte';
	import { layers, type BaseLayerId } from '$lib/state/layers.svelte';

	let { open, x, y, onClose }: { open: boolean; x: number; y: number; onClose: () => void } =
		$props();
</script>

<HeadOverlay {open} {x} {y} title={t.layers.title} minWidthPx={300} {onClose}>
	<div class="layers-pop popover-panel">
		<fieldset class="group">
			<legend>{t.layers.baseMap}</legend>
			<select
				class="search"
				aria-label={t.layers.baseMap}
				value={layers.baseLayer}
				onchange={(e) => (layers.baseLayer = e.currentTarget.value as BaseLayerId)}
			>
				{#each BASE_LAYERS as b (b.id)}
					<option value={b.id}>{b.label}</option>
				{/each}
			</select>
		</fieldset>

		<fieldset class="group">
			<legend>{t.layers.airspaces}</legend>
			{#each CATEGORIES as c (c)}
				<label class="check">
					<input
						type="checkbox"
						checked={layers.airspace[c]}
						onchange={(e) => (layers.airspace[c] = e.currentTarget.checked)}
					/>
					<span>{t.layers.airspaceCategories[c]}</span>
				</label>
			{/each}
			<label class="check">
				<input type="checkbox" bind:checked={layers.airspaceLabels} />
				<span>{t.layers.designatorLabels}</span>
			</label>
			{#if dataState.airspacesError}
				<p class="error" role="alert">{t.layers.airspacesFailed}</p>
			{/if}
		</fieldset>

		<fieldset class="group">
			<legend>{t.layers.airports}</legend>
			<label class="check">
				<input type="checkbox" bind:checked={layers.airportTypes.airports} />
				<span>{t.layers.airportGroups.airports}</span>
			</label>
			<label class="check">
				<input type="checkbox" bind:checked={layers.airportTypes.heliports} />
				<span>{t.layers.airportGroups.heliports}</span>
			</label>
			<label class="check">
				<input type="checkbox" bind:checked={layers.airportTypes.closed} />
				<span>{t.layers.airportGroups.closed}</span>
			</label>
			{#if dataState.airportsError}
				<p class="error" role="alert">{t.layers.airportsFailed}</p>
			{/if}
		</fieldset>

		<fieldset class="group">
			<legend>{t.layers.supaipAreas}</legend>
			<label class="check">
				<input type="checkbox" bind:checked={layers.supaip} />
				<span>{t.layers.supaipInForce}</span>
			</label>
			<p class="muted small">{t.layers.supaipNote}</p>
			{#if dataState.supaipError}
				<p class="error" role="alert">{t.layers.supaipFailed}</p>
			{/if}
		</fieldset>

		<fieldset class="group">
			<legend>{t.display.notamMarkersLegend}</legend>
			<label class="check">
				<input type="checkbox" bind:checked={display.typeIcons} />
				<span>{t.display.typeIcons}</span>
			</label>
			<label class="check">
				<input type="checkbox" bind:checked={display.qlineMarkers} />
				<span>{t.display.qlineMarkers}</span>
			</label>
			<label class="check">
				<input type="checkbox" bind:checked={display.qlineRadius} />
				<span>{t.display.qlineRadius}</span>
			</label>
			<!-- The other two of the six the Settings tab keeps in this group.
			     Both were reachable only from that tab, so this app pinned
			     them at Loxodrome's defaults with nothing to say so: the
			     airport markers collapsed into their cue rings with no way
			     back, in an app whose whole subject is NOTAM markers. -->
			<label class="check" title={t.display.hideAirportNotamMarkersTip}>
				<input type="checkbox" bind:checked={display.hideAirportNotamMarkers} />
				<span>{t.display.hideAirportNotamMarkers}</span>
			</label>
			<label class="check" title={t.display.affectedAirspacesTip}>
				<input type="checkbox" bind:checked={display.affectedAirspaces} />
				<span>{t.display.affectedAirspaces}</span>
			</label>
			<label class="check">
				<input type="checkbox" bind:checked={display.showInAirspaces} />
				<span>{t.display.showInAirspaces}</span>
			</label>
		</fieldset>
	</div>
</HeadOverlay>

<style>
	.layers-pop {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
</style>
