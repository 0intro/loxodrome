<script lang="ts">
	/* The raw NOTAM card list of the feature panels: one bordered card per
	 * source NOTAM (id button + full raw text), grouped by ICAO Q-code
	 * subject family when asked (sub-headed once the list spans more than
	 * one family), with an activated variant (hatched card + ACTIVE tag in
	 * the caller's accent). Head extras (tier chip, activation window) and
	 * the caption line are caller snippets, styled by the caller. */
	import type { Snippet } from 'svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { groupNotamsBySubject } from '$lib/notam/qcode';
	import type { IndexedNotam } from '$lib/state/notam.svelte';
	import NotamIdButton from './NotamIdButton.svelte';

	interface Props {
		items: IndexedNotam[];
		/** Group by subject family, sub-headed when more than one family. */
		grouped?: boolean;
		/** Activated-list variant: hatched card + ACTIVE tag per card. */
		active?: boolean;
		/** Tooltip on the ACTIVE tag. */
		activeTip?: string | undefined;
		/** Accent of the activated variant (a CSS colour / var()). */
		activeAccent?: string | undefined;
		/** Extra head spans after the id button (tier chip, window). */
		headExtra?: Snippet<[IndexedNotam]> | undefined;
		/** Caption line between the head and the raw text. */
		caption?: Snippet<[IndexedNotam]> | undefined;
	}
	let {
		items,
		grouped = false,
		active = false,
		activeTip,
		activeAccent,
		headExtra,
		caption,
	}: Props = $props();

	interface CardGroup {
		key: string;
		label: string | null;
		items: IndexedNotam[];
	}

	// Grouped: subject families in briefing order, labelled only when the
	// list spans more than one; ungrouped: one unlabelled run kept in the
	// caller's order.
	const groups = $derived.by((): CardGroup[] => {
		if (!grouped) {
			return [{ key: 'all', label: null, items }];
		}
		const gs = groupNotamsBySubject(items, (it) => it.notam.qCode);
		return gs.map((g) => ({
			key: g.group.key,
			label: gs.length > 1 ? t.notam.firGroups[g.group.key] : null,
			items: g.items,
		}));
	});
</script>

{#if items.length > 0}
	<div class="notam-cards">
		{#each groups as g (g.key)}
			{#if g.label}
				<h4 class="cat-head">{g.label}</h4>
			{/if}
			{#each g.items as item (item.notam.id)}
				<div
					class="notam-card"
					class:notam-card--active={active}
					style:--active-accent={activeAccent}
				>
					{#if active || headExtra}
						<div class="notam-card-head">
							{#if active}<span class="active-tag" title={activeTip}>ACTIVE</span>{/if}
							<NotamIdButton {item} />
							{#if headExtra}{@render headExtra(item)}{/if}
						</div>
					{:else}
						<NotamIdButton {item} />
					{/if}
					{#if caption}{@render caption(item)}{/if}
					<pre class="notam-raw" lang="en">{item.notam.fullContent}</pre>
				</div>
			{/each}
		{/each}
	</div>
{/if}

<style>
	.notam-cards {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	/* Subject-family sub-heading, shown only when the list spans more than
	 * one ICAO Q-code family (via firSubjectGroup). */
	.cat-head {
		margin: 4px 0 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted);
	}

	.notam-card {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px 12px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.notam-card--active {
		border-color: var(--active-accent);
		background:
			repeating-linear-gradient(
				45deg,
				var(--surface-2) 0,
				var(--surface-2) 6px,
				color-mix(in srgb, var(--active-accent) 12%, var(--surface-2)) 6px,
				color-mix(in srgb, var(--active-accent) 12%, var(--surface-2)) 9px
			);
	}

	.notam-card-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.active-tag {
		padding: 2px 7px;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: #fff;
		background: var(--active-accent);
		border-radius: 999px;
	}

	.notam-raw {
		margin: 0;
		padding: 8px 10px;
		font-family: ui-monospace, "SF Mono", "Cascadia Code", consolas, monospace;
		font-size: 11px;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: break-word;
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 4px;
	}
</style>
