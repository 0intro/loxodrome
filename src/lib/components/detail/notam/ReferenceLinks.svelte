<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	import type { IndexedNotam } from '$lib/state/notam.svelte';
	import { navigateToNotam } from '$lib/state/ui.svelte';

	interface Ref {
		id: string;
		loaded: IndexedNotam | null;
	}
	interface Refs {
		replaces: Ref | null;
		references: Ref[];
		referencedBy: IndexedNotam[];
	}
	interface Props {
		refs: Refs;
	}
	let { refs }: Props = $props();
</script>

{#if refs.replaces || refs.references.length > 0 || refs.referencedBy.length > 0}
	<section class="block">
		{#if refs.replaces}
			<h3>{t.notam.replaces}</h3>
			<ul class="notam-links">
				<li>
					{#if refs.replaces.loaded}
						{@const target = refs.replaces.loaded}
						<button
							class="notam-link"
							onclick={() => navigateToNotam(target.index)}
							title={t.notam.openReplacedTip}
						>{refs.replaces.id}</button>
					{:else}
						<span class="notam-link notam-link--missing">
							{refs.replaces.id}
							<span class="missing-tag">{t.notam.notInBriefing}</span>
						</span>
					{/if}
				</li>
			</ul>
		{/if}
		{#if refs.references.length > 0}
			<h3>{t.notam.references} ({refs.references.length})</h3>
			<ul class="notam-links">
				{#each refs.references as r, i (i)}
					<li>
						{#if r.loaded}
							{@const target = r.loaded}
							<button
								class="notam-link"
								onclick={() => navigateToNotam(target.index)}
								title={t.notam.openReferencedTip}
							>{r.id}</button>
						{:else}
							<span class="notam-link notam-link--missing">
								{r.id}
								<span class="missing-tag">{t.notam.notInBriefing}</span>
							</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if refs.referencedBy.length > 0}
			<h3>{t.detail.referencedBy} ({refs.referencedBy.length})</h3>
			<ul class="notam-links">
				{#each refs.referencedBy as item (item.notam.id)}
					<li>
						<button
							class="notam-link"
							onclick={() => navigateToNotam(item.index)}
							title={t.notam.openReferencingTip}
						>{item.notam.id}</button>
					</li>
				{/each}
			</ul>
		{/if}
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

	.notam-links {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 4px 0 8px;
		padding: 0;
		list-style: none;
	}

	.notam-link {
		padding: 3px 8px;
		font: inherit;
		font-family: ui-monospace, monospace;
		font-size: 12px;
		font-weight: 700;
		color: var(--accent);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		cursor: pointer;
	}

	.notam-link:hover {
		border-color: var(--accent);
	}

	.notam-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.notam-link--missing {
		cursor: default;
		color: var(--text-muted);
		font-weight: 600;
	}

	.notam-link--missing:hover {
		border-color: var(--border);
	}

	.missing-tag {
		margin-left: 6px;
		font-family: inherit;
		font-size: 10px;
		font-weight: 400;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}
</style>
