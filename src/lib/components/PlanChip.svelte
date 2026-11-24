<script lang="ts">
	/* The flight plan in the desktop toolbar, after the brand: its name, else
	 * its route, the amber dot while it holds unsaved work, and the plan menu
	 * on a click (state/planDocument.svelte.ts). A pill, the conditions chips'
	 * own grammar beside them.
	 *
	 * It is the bar's FIRST give: its label shrinks before the conditions
	 * chips do, down to the icon, the state slot and the caret. The zero basis
	 * takes free room before anything else grows, and its minimum is the
	 * grid's min-content, the label's track contributing nothing. A flex-shrink
	 * ratio instead would shave a fraction of a pixel off the conditions and
	 * ellipsize them. The state slot is a fixed width, so the dot coming and
	 * going and the receipt's check never move the bar. */
	import Icon from './Icon.svelte';
	import { planStateText } from './planStateText';
	import { planUnsaved } from '$lib/state/activePlan.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { openPlanMenu, planDocument, planIdentity } from '$lib/state/planDocument.svelte';

	const identity = $derived(planIdentity());
	const unsaved = $derived(planUnsaved());
	const title = $derived(t.plan.chipTitle(identity, planStateText()));

	function open(e: MouseEvent): void {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		openPlanMenu({ x: r.left, y: r.bottom + 4 });
	}
</script>

<button
	type="button"
	class="plan-chip"
	aria-expanded={planDocument.menuOpen}
	aria-label={title}
	{title}
	onclick={open}
>
	<Icon name="save" size={14} />
	<span class="label" class:muted={identity === ''}>{identity === '' ? t.plan.title : identity}</span>
	<span class="slot" aria-hidden="true">
		{#if planDocument.receipt != null}
			<Icon name="check" size={12} />
		{:else if unsaved}
			<span class="dot"></span>
		{/if}
	</span>
	<Icon name="chevron-down" size={12} />
</button>

<style>
	.plan-chip {
		display: inline-grid;
		flex: 1000 1 0;
		grid-template-columns: auto minmax(0, max-content) 12px auto;
		gap: 5px;
		align-items: center;
		max-width: max-content;
		margin-left: 2px;
		padding: 4px 10px;
		font: inherit;
		font-size: 12px;
		line-height: 1.25;
		color: var(--text-muted);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 999px;
		cursor: pointer;
	}

	.plan-chip:hover,
	.plan-chip[aria-expanded='true'] {
		color: var(--text);
		background: var(--surface-3);
	}

	.plan-chip:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.label {
		max-width: 28ch;
		overflow: hidden;
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.label.muted {
		font-weight: 400;
		color: var(--text-muted);
	}

	.slot {
		display: grid;
		place-items: center;
		width: 12px;
		color: var(--accent);
	}

	.dot {
		width: 8px;
		height: 8px;
		background: var(--workbook-orange);
		border-radius: 50%;
	}
</style>
