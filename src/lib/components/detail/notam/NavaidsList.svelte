<script lang="ts">
	import type { Navaid } from '$lib/data/navaids';
	import { navaidFreqLabel } from '$lib/data/navaids';
	import { t } from '$lib/state/i18n.svelte';
	import { navigateToNavaid } from '$lib/state/ui.svelte';
	import { unserviceableNavaids } from '$lib/state/notamNavaidLinks.svelte';
	import { clearHover, hoverFeature } from '$lib/map/selectionHighlight';

	interface Props {
		navaids: Navaid[];
	}
	let { navaids }: Props = $props();

	const us = $derived(unserviceableNavaids());
</script>

{#if navaids.length > 0}
	<section class="block">
		<h3>{t.notam.affectedNavaids} ({navaids.length})</h3>
		<ul class="navaid-links">
			{#each navaids as n (n.id)}
				<li>
					<button
						class="navaid-link"
						onclick={() => navigateToNavaid(n.id)}
						onmouseenter={() => hoverFeature('navaid', n.id)}
						onmouseleave={clearHover}
					>
						<span class="navaid-type">{t.data.navaidTypes[n.type] ?? n.type}</span>
						<span class="navaid-ident">{n.ident || '–'}</span>
						{#if us.has(n.id)}
							<span class="navaid-us" title={t.map.unserviceable}>U/S</span>
						{/if}
						<span class="navaid-name">{n.name}</span>
						{#if navaidFreqLabel(n)}
							<span class="navaid-freq">{navaidFreqLabel(n)}</span>
						{/if}
					</button>
				</li>
			{/each}
		</ul>
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

	.navaid-links {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.navaid-link {
		display: flex;
		align-items: baseline;
		gap: 8px;
		width: 100%;
		padding: 4px 6px;
		font: inherit;
		text-align: left;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 4px;
		cursor: pointer;
		color: var(--text);
	}

	.navaid-link:hover {
		background: var(--surface-2);
		border-color: var(--border);
	}

	.navaid-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.navaid-type {
		flex: 0 0 auto;
		font-size: 12px;
		font-weight: 600;
	}

	.navaid-ident {
		flex: 0 0 auto;
		font-size: 12px;
		font-weight: 700;
		font-family: ui-monospace, monospace;
	}

	.navaid-name {
		flex: 1;
		overflow: hidden;
		font-size: 12px;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-muted);
	}

	.navaid-freq {
		flex: 0 0 auto;
		font-size: 11px;
		color: var(--text-muted);
		font-family: ui-monospace, monospace;
	}

	.navaid-us {
		flex: 0 0 auto;
		padding: 0 5px;
		font-size: 10px;
		font-weight: 700;
		color: #fff;
		background: var(--danger);
		border-radius: 999px;
	}
</style>
