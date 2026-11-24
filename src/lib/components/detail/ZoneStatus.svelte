<script lang="ts">
	/* A zone's state at the head of its panel (an airspace, a supplement's
	   zone, a NOTAM's area): the state over the viewed time, why, and what
	   changes next, from the reading the alerts make
	   (state/activity.svelte.ts zoneActivity). The viewed time is the one the
	   map draws states at (drawnStateAt): the current minute, the planned
	   flight, a typed period. In the flight app the pilot's note of what a
	   unit said follows it (ZoneNote.svelte). */
	import { zoneStateLines, type ZoneSpan } from '$lib/components/zoneStateText';
	import { planScope } from '$lib/state/planScope.svelte';
	import ZoneNote from './ZoneNote.svelte';
	import type { AlertVolume } from '$lib/nav/alertVolumes';
	import { zoneActivity } from '$lib/state/activity.svelte';
	import { filter } from '$lib/state/filter.svelte';
	import { drawnStateAt } from '$lib/state/notam.svelte';

	interface Props {
		volume: AlertVolume;
	}

	let { volume }: Props = $props();

	const at = $derived(drawnStateAt());
	const span = $derived<ZoneSpan>(
		at.fromMs === at.toMs ? 'now' : filter.window.mode === 'flight' ? 'flight' : 'period',
	);
	const zone = $derived(zoneActivity(volume, at));
	const lines = $derived(zoneStateLines(zone, span, at));
</script>

<section class="zone-status zone-status--{zone.answer.state}">
	<p class="state">{lines.state}</p>
	{#if lines.reason}
		<p class="line">{lines.reason}</p>
	{/if}
	{#if lines.next}
		<p class="line">{lines.next}</p>
	{/if}
	{#if planScope.zoneNotes}
		{#key volume.id}
			<ZoneNote {volume} {zone} notes={planScope.zoneNotes} />
		{/key}
	{/if}
</section>

<style>
	.zone-status {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.zone-status p {
		margin: 0;
	}

	.state {
		font-weight: 600;
	}

	.zone-status--active .state {
		color: var(--danger);
	}

	.line {
		font-size: var(--fs-xs);
		color: var(--text-muted);
	}
</style>
