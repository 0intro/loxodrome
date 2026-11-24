<script lang="ts">
	/* The print menu's word on the NOTAM briefing, before the click: the
	 * stamp while the briefing covers the flight, else the first reason of
	 * the verdict, and that the print fetches the briefing first where it
	 * will and can (state/briefingFetch.ts ensureBriefing: the gesture
	 * wants one, the source can brief the plan, the page is online, the
	 * flight is still ahead). Under ChartsReadiness, whose rule it shares. */
	import {
		briefingSourceReady,
		briefingVerdictNow,
		briefingWanted,
		briefingWatch,
	} from '$lib/state/briefing.svelte';
	import { notamState } from '$lib/state/notam.svelte';
	import { briefingPrintText } from '../briefingText';
	import { pastFlight } from './chartsPrefetch';

	const text = $derived.by(() => {
		const v = briefingVerdictNow();
		const now = Date.now();
		const fetches = briefingWanted(now, v) && briefingSourceReady() && briefingWatch.online && !pastFlight(now);
		return briefingPrintText(v, notamState.lastFetch?.source ?? null, fetches, now);
	});
</script>

<p class="brief-ready">{text}</p>

<style>
	.brief-ready {
		margin: 4px 0 0;
		padding: 6px 8px 2px;
		border-top: 1px solid var(--border);
		color: var(--text-muted);
		font-size: var(--fs-sm);
		line-height: 1.4;
	}

	:global(.charts-ready) + .brief-ready {
		margin-top: 0;
		padding-top: 2px;
		border-top: 0;
	}
</style>
