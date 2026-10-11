<script lang="ts">
	/* The print menu's word on the TEMSI / WINTEM annex, before the click:
	 * what a print now would carry, or why it would carry none (the catalogs
	 * still being asked, one unavailable, a chart not out yet, the flight
	 * already flown). Mounted with the menu, it asks the zones' catalogs
	 * through the Weather tab's own ensure (cheap when fresh; a failure older
	 * than the menu is asked once more, opening it being a gesture), nothing
	 * for a flight already flown, which the print would not ask either, and
	 * reads them through the print's own selection (chartsReadiness), so the
	 * line cannot promise what the paper will not carry. */
	import { untrack } from 'svelte';
	import type { Route } from '$lib/state/route.svelte';
	import { notamState } from '$lib/state/notam.svelte';
	import { ensureSofiaCharts, sofiaCharts } from '$lib/state/sofiaCharts.svelte';
	import { chartPlan, chartsReadiness, pastFlight } from './chartsPrefetch';
	import { readinessText } from './chartsText';

	let { routes }: { routes: Route[] } = $props();

	const openedAtMs = Date.now();
	// The minute tick: a chart comes out, the flight goes by, with the menu
	// open.
	const plan = $derived.by(() => {
		void notamState.tick;
		return chartPlan(routes);
	});
	const past = $derived.by(() => {
		void notamState.tick;
		return pastFlight();
	});
	// The zones as one value, so a plan recomputed with the same zones asks
	// nothing again.
	const zonesKey = $derived(past ? '' : plan.zones.join(','));

	$effect(() => {
		void zonesKey;
		// The ensure writes the cache: untracked, or this effect would
		// subscribe to the entries it starts.
		untrack(() => {
			if (past) {
				return;
			}
			for (const zone of plan.zones) {
				ensureSofiaCharts(zone, { errorsBeforeMs: openedAtMs });
			}
		});
	});

	const text = $derived.by(() => {
		void notamState.tick;
		const now = Date.now();
		return readinessText(chartsReadiness(plan, sofiaCharts.byZone, now, past), now);
	});
</script>

{#if text}
	<p class="charts-ready" role="status">{text}</p>
{/if}

<style>
	.charts-ready {
		margin: 4px 0 0;
		padding: 6px 8px 2px;
		border-top: 1px solid var(--border);
		color: var(--text-muted);
		font-size: var(--fs-sm);
		line-height: 1.4;
	}
</style>
