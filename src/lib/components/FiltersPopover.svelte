<script lang="ts">
	/* The NOTAM data filters (flight rules, kind), opened from the funnel
	 * button in the NOTAMs tab head. What is left here is NOTAM-only: the
	 * period and the level band govern the whole map, so they are toolbar
	 * chrome (ViewConditions) rather than a briefing filter, and the popover
	 * opens by saying so. Presentation (anchored popup / phone bottom sheet)
	 * is HeadOverlay's. */
	import { filter } from '$lib/state/filter.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { notamState } from '$lib/state/notam.svelte';
	import { routeDrivesTrafficMode } from '$lib/state/route.svelte';
	import HeadOverlay from './HeadOverlay.svelte';
	import Icon from './Icon.svelte';
	import Segmented from './Segmented.svelte';

	let {
		open,
		x,
		y,
		onClose,
	}: {
		open: boolean;
		x: number;
		y: number;
		onClose: () => void;
	} = $props();

	const total = $derived(notamState.notams.length);
	const fromRoute = $derived(routeDrivesTrafficMode());

</script>

<HeadOverlay {open} {x} {y} title={t.filter.open} {onClose}>
	<div class="filters popover-panel">
		<!-- A funnel states its reach: the period and the level band left for
		     the toolbar, so everything here really is NOTAM-only. -->
		<p class="muted small scope">{t.filter.scopeNote}</p>

		<fieldset class="group">
			<legend>
				{t.filter.flightRulesLegend}
				{#if fromRoute}
					<span class="prov" title={t.filter.setByRoute}><Icon name="route" size={11} /></span>
				{/if}
			</legend>
			<Segmented
				options={[
					{ value: 'all', label: t.filter.modeAll },
					{ value: 'vfr', label: 'VFR' },
					{ value: 'ifr', label: 'IFR' },
				]}
				value={filter.trafficMode}
				onSelect={(v) => (filter.trafficMode = v as 'all' | 'vfr' | 'ifr')}
				ariaLabel={t.filter.flightRulesLegend}
				title={fromRoute ? t.filter.setByRoute : undefined}
			/>
			<p class="muted small">{t.filter.flightRulesNote}</p>
		</fieldset>

		{#if total === 0}
			<p class="muted">{t.filter.noNotams}</p>
		{:else}
			<fieldset class="group">
				<legend>{t.filter.kindLegend}</legend>
				<label class="check">
					<input type="checkbox" bind:checked={filter.kind.position} />
					<span>{t.filter.kindPositions}</span>
				</label>
				<label class="check">
					<input type="checkbox" bind:checked={filter.kind.area} />
					<span>{t.filter.kindAreas}</span>
				</label>
				<label class="check">
					<input type="checkbox" bind:checked={filter.kind.qualifierLine} />
					<span>{t.filter.kindQline}</span>
				</label>
			</fieldset>

		{/if}
	</div>
</HeadOverlay>

<style>
	.filters {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 6px;
	}

	/* The legend carries an inline provenance mark, so it lays its content
	   out; everything else about it is the shared chrome. */
	legend {
		display: flex;
		align-items: center;
		gap: 5px;
	}

	/* The "set by your route" provenance mark on the flight-rules group. */
	.prov {
		display: inline-flex;
		color: var(--accent);
	}

	.scope {
		margin: 0 2px;
	}

	.small {
		font-size: 11px;
	}

</style>
