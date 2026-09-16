<script lang="ts">
	/* A collapsible group of compact NOTAM rows (NotamRowList): used by the
	 * FIR-briefing subject groups, the checklist section, the opt-in
	 * geometric list, and the airport "Referenced by position" list;
	 * collapsed by default so a 400-NOTAM FIR panel mounts as a handful of
	 * headers. Renders nothing for an empty group. */
	import type { IndexedNotam } from '$lib/state/notam.svelte';
	import NotamRowList from './NotamRowList.svelte';

	interface Props {
		title: string;
		items: IndexedNotam[];
		open?: boolean;
	}
	let { title, items, open = false }: Props = $props();

	// The prop seeds the initial state only; the user's toggle owns it after.
	// svelte-ignore state_referenced_locally
	let expanded = $state(open);
</script>

{#if items.length > 0}
	<div class="group">
		<button
			type="button"
			class="group-head"
			aria-expanded={expanded}
			onclick={() => (expanded = !expanded)}
		>
			<span class="chev" class:open={expanded} aria-hidden="true"></span>
			<span class="group-title">{title}</span>
			<span class="count">{items.length}</span>
		</button>
		{#if expanded}
			<NotamRowList {items} />
		{/if}
	</div>
{/if}

<style>
	.group-head {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 4px 2px;
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		text-align: left;
		color: var(--text);
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.group-head:hover .group-title {
		text-decoration: underline;
	}

	.group-head:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.chev {
		flex: 0 0 auto;
		width: 0;
		height: 0;
		border-top: 4px solid transparent;
		border-bottom: 4px solid transparent;
		border-left: 5px solid var(--text-muted);
		transition: transform 0.12s ease;
	}

	.chev.open {
		transform: rotate(90deg);
	}

	.count {
		padding: 0 6px;
		font-size: 11px;
		font-weight: 700;
		color: var(--text-muted);
		background: var(--surface-2);
		border-radius: 999px;
	}
</style>
