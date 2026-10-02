<script lang="ts">
	/* The Brief page's SUP AIP section: the supplements IN FORCE over the
	 * viewing period, one row each, which is a briefing question and not the
	 * map's (state/supaip supaipsInForce, not visibleSupaipZones: a
	 * supplement whose PDF yielded no coordinates draws nothing and still
	 * has to be read). A row opens the supplement's sheet in the pane. */
	import { t } from '$lib/state/i18n.svelte';
	import { i18n } from '$lib/state/i18n.svelte';
	import { supaipsInForce } from '$lib/state/supaip.svelte';
	import { ensureSupaip, dataState } from '$lib/state/data.svelte';
	import { closePage, selectSupaip } from '$lib/state/ui.svelte';
	import type { SupAip } from '$lib/data/supaip';

	/* Ask for the supplements: the section is their one door on a phone, and
	 * the dataset otherwise loads only for the map layer or the alert engine,
	 * so with the layer off the list had nothing to show and said so. */
	$effect(() => {
		void ensureSupaip().catch(() => {});
	});

	const sups = $derived(
		[...supaipsInForce()].sort(
			(a, b) => a.region.localeCompare(b.region) || b.year - a.year || b.number - a.number,
		),
	);

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
			<!-- An empty list is three different answers and only one of them is
			     "none in force": a briefing must never read a fetch that has not
			     landed, or one that failed, as a statement that no supplement
			     applies. The Layers tab's own rows for this dataset say which,
			     and so does this one. -->
			{#if dataState.supaipError}
				<p class="muted error" role="alert">{t.layers.supaipFailed}</p>
			{:else if !dataState.supaipLoaded}
				<p class="muted">{t.layers.loadingSupaip}</p>
			{:else}
				<p class="muted">{t.layers.supaipNone}</p>
			{/if}
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
