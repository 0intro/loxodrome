<script lang="ts">
	/* The Brief page's SUP AIP section: the supplements in force in the
	 * viewing period, the ones the map draws (state/supaip visibleSupaipZones),
	 * one row per supplement. A row opens the supplement's sheet in the pane. */
	import { t } from '$lib/state/i18n.svelte';
	import { i18n } from '$lib/state/i18n.svelte';
	import { visibleSupaipZones } from '$lib/state/supaip.svelte';
	import { closePage, selectSupaip } from '$lib/state/ui.svelte';
	import type { SupAip } from '$lib/data/supaip';

	const sups = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a per-read dedup, never rendered
		const seen = new Map<string, SupAip>();
		for (const z of visibleSupaipZones()) {
			if (!seen.has(z.sup.id)) {
				seen.set(z.sup.id, z.sup);
			}
		}
		return [...seen.values()].sort((a, b) => a.region.localeCompare(b.region) || b.year - a.year || b.number - a.number);
	});

	function subject(s: SupAip): string {
		return i18n.locale === 'fr' || !s.descriptionEn ? s.descriptionFr : s.descriptionEn;
	}

	function pick(s: SupAip): void {
		selectSupaip(s.id);
		closePage();
	}
</script>

<div class="tab-panel">
	<fieldset class="group">
		<legend>{t.layers.supaipInForce}</legend>
		{#if sups.length === 0}
			<p class="muted">{t.layers.supaipNone}</p>
		{:else}
			<ul class="sups">
				{#each sups as s (s.id)}
					<li>
						<button type="button" class="row" onclick={() => pick(s)}>
							<span class="title">{s.title}</span>
							<span class="sub">{s.lieu ? `${s.lieu} · ` : ''}{subject(s)}</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</fieldset>
</div>

<style>
	.sups {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		display: flex;
		flex-direction: column;
		gap: 2px;
		align-items: flex-start;
		width: 100%;
		min-height: 44px;
		padding: 6px 4px;
		font: inherit;
		color: var(--text);
		text-align: left;
		background: none;
		border: 0;
		border-bottom: 1px solid var(--border);
		cursor: pointer;
	}

	.title {
		font-weight: 600;
	}

	.sub {
		overflow: hidden;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		font-size: var(--fs-xs);
		color: var(--text-muted);
	}
</style>
