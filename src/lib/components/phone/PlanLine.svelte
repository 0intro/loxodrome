<script lang="ts">
	/* The flight plan on a phone, one row atop the Plan page (PhonePages): its
	 * name, else its route, the amber dot while it holds unsaved work, the
	 * plan menu on a tap (a bottom sheet, state/planDocument.svelte.ts), and
	 * Save in one tap. The page's head holds Back and the five sections on a
	 * 392 px row, and the toolbar its own five controls, so the plan has a row
	 * of its own, between the head and the page it is about. */
	import Icon from '../Icon.svelte';
	import { planStateText } from '../planStateText';
	import { canSavePlan, planUnsaved } from '$lib/state/activePlan.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { openPlanMenu, planDocument, planIdentity, savePlan } from '$lib/state/planDocument.svelte';

	const identity = $derived(planIdentity());
	const unsaved = $derived(planUnsaved());
	const title = $derived(t.plan.chipTitle(identity, planStateText()));

	function open(e: MouseEvent): void {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		openPlanMenu({ x: r.left, y: r.bottom + 4 });
	}
</script>

<div class="plan-line">
	<button
		type="button"
		class="plan-id"
		aria-expanded={planDocument.menuOpen}
		aria-label={title}
		onclick={open}
	>
		<Icon name="save" size={16} />
		<span class="label" class:muted={identity === ''}>{identity === '' ? t.plan.title : identity}</span>
		<span class="slot" aria-hidden="true">
			{#if planDocument.receipt != null}
				<Icon name="check" size={14} />
			{:else if unsaved}
				<span class="dot"></span>
			{/if}
		</span>
		<Icon name="chevron-down" size={14} />
	</button>
	<button
		type="button"
		class="btn"
		onclick={() => void savePlan()}
		disabled={!canSavePlan() || planDocument.saving}
	>
		{planDocument.saving ? t.plan.savingPlan : t.plan.saveShort}
	</button>
</div>

<style>
	.plan-line {
		display: flex;
		flex: 0 0 auto;
		gap: 8px;
		align-items: center;
		padding: 4px max(12px, var(--sar)) 4px max(12px, var(--sal));
		border-bottom: 1px solid var(--border);
	}

	/* The identity takes the row and gives way first; the slot is a fixed
	   width, so the dot and the receipt never move the Save button. */
	.plan-id {
		display: inline-grid;
		flex: 1 1 auto;
		grid-template-columns: auto minmax(0, 1fr) 14px auto;
		gap: 8px;
		align-items: center;
		min-width: 0;
		min-height: 44px;
		padding: 0 4px;
		font: inherit;
		color: var(--text-muted);
		text-align: left;
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
	}

	.label {
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
		width: 14px;
		color: var(--accent);
	}

	.dot {
		width: 8px;
		height: 8px;
		background: var(--workbook-orange);
		border-radius: 50%;
	}

	.btn {
		flex: none;
	}
</style>
