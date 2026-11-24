<script lang="ts">
	/* The label/value grid every detail panel opens with. Convention: the
	 * caller passes bare <dt>/<dd> pairs as direct children ({#if} groups
	 * keep a pair together), so both land in the grid; the max-content
	 * label column never truncates a long French label. Panel-specific
	 * value styling (mono, chips, coordinate buttons) stays in the caller,
	 * whose scoped styles reach its own dt/dd content. */
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
	}
	let { children }: Props = $props();
</script>

<dl class="fields">
	{@render children()}
</dl>

<style>
	.fields {
		display: grid;
		grid-template-columns: max-content 1fr;
		column-gap: 12px;
		row-gap: 6px;
		margin: 0;
		font-size: 13px;
	}

	.fields > :global(dt) {
		color: var(--text-muted);
		font-weight: 500;
	}

	.fields > :global(dd) {
		margin: 0;
	}
</style>
