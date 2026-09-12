<script lang="ts" generics="Id extends string">
	/* The workbook modals' page-tab strip (FlightPrepModal, the aircraft
	 * editor): icon + label buttons, one active. Key-only page registry;
	 * labels resolve through labelFor at render so a locale switch
	 * re-labels the tabs (docs/i18n.md rule 2). The strip is screen
	 * furniture and carries no-print itself, so a bare Ctrl+P over a
	 * docked surface never prints the pills.
	 *
	 * It is a real tablist, on RouteStrip's pattern: role + aria-selected +
	 * a roving tabindex so the whole strip is one tab stop and the arrows
	 * move between pages. It is the primary navigation of both workbooks,
	 * and it had carried nothing but an .active class, so a screen reader
	 * could not tell which page was open and a keyboard user tabbed through
	 * every pill to reach the last. */

	import { tick } from 'svelte';
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	interface Props {
		pages: readonly { id: Id; icon: string }[];
		current: Id;
		onSelect: (id: Id) => void;
		ariaLabel: string;
		labelFor: (id: Id) => string;
		/** Optional per-tab badge after the label (the aircraft editor's
		 *  error dot). */
		badge?: Snippet<[Id]>;
	}
	let { pages, current, onSelect, ariaLabel, labelFor, badge }: Props = $props();

	let strip = $state<HTMLElement>();

	function onKeydown(e: KeyboardEvent): void {
		const idx = pages.findIndex((p) => p.id === current);
		let next: number;
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			// Wrap, the way a browser tab strip does; the pages are a short
			// cycle, not a list with ends worth stopping at.
			const delta = e.key === 'ArrowLeft' ? -1 : 1;
			next = (idx + delta + pages.length) % pages.length;
		} else if (e.key === 'Home') {
			next = 0;
		} else if (e.key === 'End') {
			next = pages.length - 1;
		} else {
			return;
		}
		e.preventDefault();
		onSelect(pages[next].id);
		// Focus follows the selection, which is the strip's only tab stop.
		void tick().then(() => {
			strip?.querySelector<HTMLElement>('.page-tab.active')?.focus();
		});
	}
</script>

<nav class="pages no-print" aria-label={ariaLabel} bind:this={strip}>
	<div class="tablist" role="tablist" aria-label={ariaLabel}>
		{#each pages as p (p.id)}
			<button
				class="page-tab"
				class:active={current === p.id}
				role="tab"
				aria-selected={current === p.id}
				tabindex={current === p.id ? 0 : -1}
				onclick={() => onSelect(p.id)}
				onkeydown={onKeydown}
			>
				<Icon name={p.icon} size={14} />
				<span>{labelFor(p.id)}</span>
				{@render badge?.(p.id)}
			</button>
		{/each}
	</div>
</nav>

<style>
	.pages {
		display: flex;
		flex: 1;
		margin-left: 12px;
	}

	.tablist {
		display: flex;
		gap: 4px;
	}

	.page-tab {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font: inherit;
		font-size: var(--fs-md);
		padding: 4px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text-muted);
		cursor: pointer;
	}

	.page-tab:hover {
		background: var(--surface-2);
	}

	.page-tab:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.page-tab.active {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-text);
	}

	/* The workbooks are worked on a tablet, and these pills were the
	   smallest target in the app at about 26px. */
	:global(:root.touch-ui) .page-tab {
		min-height: 44px;
		padding: 4px 14px;
	}
</style>
