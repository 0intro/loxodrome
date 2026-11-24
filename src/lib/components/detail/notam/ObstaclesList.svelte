<script lang="ts">
	import type { Obstacle } from '$lib/data/obstacles';
	import { t } from '$lib/state/i18n.svelte';
	import { navigateToObstacle } from '$lib/state/ui.svelte';
	import { clearHover, hoverFeature } from '$lib/map/selectionHighlight';

	interface Props {
		obstacles: Obstacle[];
	}
	let { obstacles }: Props = $props();
</script>

{#if obstacles.length > 0}
	<section class="block">
		<h3>{t.notam.affectedObstacles} ({obstacles.length})</h3>
		<ul class="obstacle-links">
			{#each obstacles as o (o.id)}
				<li>
					<button
						class="obstacle-link"
						onclick={() => navigateToObstacle(o.id)}
						onmouseenter={() => hoverFeature('obstacle', o.id)}
						onmouseleave={clearHover}
					>
						<span class="obstacle-type">{t.data.obstacleTypes[o.type]}</span>
						<span class="obstacle-name">{o.name || '–'}</span>
						{#if o.hgt != null}
							<span class="obstacle-band">{o.hgt} ft AGL</span>
						{/if}
						<span class="obstacle-lit">{o.lit ? t.detail.litShort : t.detail.unlitShort}</span>
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

	.obstacle-links {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.obstacle-link {
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

	.obstacle-link:hover {
		background: var(--surface-2);
		border-color: var(--border);
	}

	.obstacle-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.obstacle-type {
		flex: 0 0 auto;
		font-size: 12px;
		font-weight: 600;
	}

	.obstacle-name {
		flex: 1;
		overflow: hidden;
		font-size: 12px;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: ui-monospace, monospace;
	}

	.obstacle-band {
		flex: 0 0 auto;
		font-size: 11px;
		color: var(--text-muted);
	}

	.obstacle-lit {
		flex: 0 0 auto;
		font-size: 11px;
		color: var(--text-muted);
	}
</style>
