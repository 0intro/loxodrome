<script lang="ts">
	import type { Notam } from '$lib/notam/types';
	import { formatZulu } from '$lib/format/datetime';
	import { t } from '$lib/state/i18n.svelte';
	import { airportLookup, dataState } from '$lib/state/data.svelte';
	import { navigateToAirport } from '$lib/state/ui.svelte';
	import { clearHover, hoverFeature } from '$lib/map/selectionHighlight';

	interface Props {
		notam: Notam;
	}
	let { notam }: Props = $props();
</script>

<dl class="fields">
	{#if notam.icaoCodes.length > 0}
		<div class="field">
			<dt>{t.notam.location}</dt>
			<dd>
				{#each notam.icaoCodes as code, i (i)}
					{#if i > 0}, {/if}
					<!-- airportLookup reads a plain (non-reactive) index: the
					 airportsLoaded read makes the link appear once the dataset
					 arrives (the selectedObstacle idiom). -->
					{#if dataState.airportsLoaded && airportLookup(code)}
						<button
							class="airport-link"
							onclick={() => navigateToAirport(code)}
							onmouseenter={() => hoverFeature('airport', code)}
							onmouseleave={clearHover}
							title={t.detail.openAirportTip}
						>{code}</button>
					{:else}{code}{/if}
				{/each}
			</dd>
		</div>
	{/if}
	<div class="field">
		<dt>{t.detail.valid}</dt>
		<dd>
			{#if notam.permanent}
				{formatZulu(notam.startDate)} → {t.notam.status.permanent}
			{:else}
				{formatZulu(notam.startDate)} → {formatZulu(notam.endDate)}
				{#if notam.estimated}<span class="tag">EST</span>{/if}
			{/if}
		</dd>
	</div>
</dl>

<style>
	.fields {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 0;
	}

	.field {
		display: flex;
		gap: 8px;
	}

	.field dt {
		flex: 0 0 70px;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.field dd {
		margin: 0;
	}

	.airport-link {
		display: inline;
		padding: 0;
		font: inherit;
		color: var(--accent);
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.airport-link:hover {
		text-decoration: underline;
	}

	.airport-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.tag {
		padding: 1px 5px;
		font-size: 10px;
		font-weight: 700;
		background: var(--surface-3);
		border-radius: 3px;
	}
</style>
