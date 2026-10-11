<script lang="ts">
	import type { IndexedNotam } from '$lib/state/notam.svelte';
	import { navigateToNotam } from '$lib/state/ui.svelte';

	interface Props {
		title: string;
		items: IndexedNotam[];
		linkTitle: string;
	}
	let { title, items, linkTitle }: Props = $props();
</script>

{#if items.length > 0}
	<section class="block">
		<h3>{title} ({items.length})</h3>
		<ul class="trigger-links">
			{#each items as it (it.notam.id)}
				<li>
					<button
						class="trigger-link"
						onclick={() => navigateToNotam(it.index)}
						title={linkTitle}
					>
						<span class="trigger-id">{it.notam.id}</span>
						{#if it.notam.qCode}
							<span class="trigger-qcode">{it.notam.qCode}</span>
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

	.trigger-links {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.trigger-link {
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

	.trigger-link:hover {
		background: var(--surface-2);
		border-color: var(--border);
	}

	.trigger-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.trigger-id {
		flex: 0 0 auto;
		font-family: ui-monospace, monospace;
		font-size: 12px;
		font-weight: 700;
	}

	.trigger-qcode {
		flex: 0 0 auto;
		font-family: ui-monospace, monospace;
		font-size: 11px;
		padding: 1px 5px;
		background: var(--surface-2);
		border-radius: 3px;
		color: var(--text-muted);
	}
</style>
