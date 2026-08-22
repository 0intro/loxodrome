<script lang="ts">
	/* The NOTAM id button of the detail panels: navigates to the NOTAM as a
	 * linked navigation (the panel keeps a "Back to ..." arrow) and wires
	 * the map hover highlight; mouseleave restores the panel's current
	 * NOTAM selection (none while a feature is selected, so it clears). */
	import { t } from '$lib/state/i18n.svelte';
	import type { IndexedNotam } from '$lib/state/notam.svelte';
	import { navigateToNotam } from '$lib/state/ui.svelte';
	import { clearHover, hoverFeature } from '$lib/map/selectionHighlight';

	interface Props {
		item: IndexedNotam;
		/** Tooltip; the open-NOTAM tip unless the context says more. */
		title?: string | undefined;
	}
	let { item, title }: Props = $props();
</script>

<button
	type="button"
	class="notam-id-btn"
	onclick={() => navigateToNotam(item.index)}
	onmouseenter={() => hoverFeature('notam', item.index)}
	onmouseleave={clearHover}
	title={title ?? t.detail.openNotamTip}
>{item.notam.id}</button>

<style>
	.notam-id-btn {
		align-self: flex-start;
		padding: 0;
		font: inherit;
		font-weight: 700;
		color: var(--accent);
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.notam-id-btn:hover {
		text-decoration: underline;
	}

	.notam-id-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
</style>
