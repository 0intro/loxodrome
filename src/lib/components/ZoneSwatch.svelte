<script lang="ts">
	/* A temporary zone's look in one state, as the map draws it
	   (docs/zone-activity.md, "The map"): hatched whole when active, the
	   chart's band inside its edge when it may be active, a dashed outline
	   when it comes later in the period. A supplement's zone in its magenta,
	   a zone a NOTAM creates in the NOTAM areas' orange. The patterns are
	   HatchDefs' (both map views mount it), read by id like the map's own
	   paths, and the inks are the map's fixed ones (map/supaipLayer.ts,
	   map/notamLayer.ts). */

	interface Props {
		state: 'active' | 'may' | 'later';
		family?: 'sup' | 'notam';
	}

	let { state, family = 'sup' }: Props = $props();

	const uid = $props.id();
	const ink = $derived(family === 'notam' ? '#ff7800' : '#c2185b');
	const hatch = $derived(family === 'notam' ? 'hatch-notam' : 'hatch-supaip');
</script>

<svg class="zone-swatch" width="28" height="14" viewBox="0 0 28 14" aria-hidden="true" focusable="false">
	<defs>
		<clipPath id="{uid}-inside"><rect x="1" y="1" width="26" height="12" /></clipPath>
	</defs>
	{#if state === 'active'}
		<rect x="1" y="1" width="26" height="12" fill="url(#{hatch})" stroke={ink} stroke-width="1.5" />
	{:else if state === 'may'}
		<rect
			x="1"
			y="1"
			width="26"
			height="12"
			fill="none"
			stroke="url(#{hatch}-band)"
			stroke-width="8"
			clip-path="url(#{uid}-inside)"
		/>
		<rect x="1" y="1" width="26" height="12" fill="none" stroke={ink} stroke-width="1.2" />
	{:else}
		<rect x="1" y="1" width="26" height="12" fill="none" stroke={ink} stroke-width="1.2" stroke-dasharray="4 3" />
	{/if}
</svg>

<style>
	.zone-swatch {
		flex: none;
		vertical-align: middle;
	}
</style>
