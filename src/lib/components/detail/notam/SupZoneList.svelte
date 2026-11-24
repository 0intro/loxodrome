<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	import type { VisibleZone } from '$lib/state/supaip.svelte';
	import { navigateToSupaip } from '$lib/state/ui.svelte';
	import { hoverSupaipZone } from '$lib/map/supaipLayer';

	interface Props {
		title: string;
		zones: VisibleZone[];
	}
	let { title, zones }: Props = $props();
</script>

{#if zones.length > 0}
	<section class="block">
		<h3>{title} ({zones.length})</h3>
		<ul class="zone-links">
			{#each zones as z, i (i)}
				<li>
					<button
						class="zone-link"
						onclick={() => navigateToSupaip(z.sup.id, z.zoneIndex)}
						onmouseenter={() => hoverSupaipZone(z.zone.geometry)}
						onmouseleave={() => hoverSupaipZone(null)}
						title={t.notam.showSupZoneTip}
					>
						<span class="swatch"></span>
						<span class="sup-id">{z.sup.title}</span>
						<span class="zone-name">{z.zone.name || t.detail.zoneN(z.zoneIndex + 1)}</span>
						{#if z.zone.geometry === null}
							<span class="muted">{t.detail.noArea}</span>
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

	.zone-links {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.zone-link {
		display: flex;
		align-items: center;
		gap: 6px;
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

	.zone-link:hover {
		background: var(--surface-2);
		border-color: var(--border);
	}

	.zone-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.swatch {
		flex: 0 0 auto;
		width: 10px;
		height: 10px;
		background: var(--supaip);
		border-radius: 2px;
	}

	.sup-id {
		flex: 0 0 auto;
		font-family: ui-monospace, monospace;
		font-size: 12px;
		font-weight: 700;
	}

	.zone-name {
		flex: 1;
		overflow: hidden;
		font-size: 12px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.muted {
		flex: 0 0 auto;
		font-size: 11px;
		color: var(--text-muted);
	}
</style>
