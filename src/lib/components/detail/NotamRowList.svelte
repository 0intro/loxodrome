<script lang="ts">
	/* Compact NOTAM rows: status dot, monospace id, Q-code chip, one-line
	 * E)-text excerpt; each row navigates to the NOTAM. The row body shared
	 * by NotamGroup (FIR briefing groups, checklists, geometric lists) and
	 * the runway-badge expansion in AirportDetail. */
	import type { Notam } from '$lib/notam/types';
	import { parseSections } from '$lib/notam';
	import { notamStatus } from '$lib/format/datetime';
	import { t } from '$lib/state/i18n.svelte';
	import type { IndexedNotam } from '$lib/state/notam.svelte';
	import { navigateToNotam } from '$lib/state/ui.svelte';

	interface Props {
		items: IndexedNotam[];
	}
	let { items }: Props = $props();

	// One-line excerpt: the E) text when present, else the whole body; the
	// row's CSS clips it with an ellipsis.
	function excerpt(notam: Notam): string {
		const e = parseSections(notam.fullContent).E ?? notam.fullContent;
		return e.replace(/\s+/g, ' ').trim();
	}

	function status(notam: Notam): 'active' | 'future' | 'expired' {
		const s = notamStatus(notam.startDate, notam.endDate, notam.permanent);
		return s === 'permanent' ? 'active' : s;
	}
</script>

<ul class="rows">
	{#each items as it (it.notam.id)}
		<li>
			<button
				type="button"
				class="row"
				onclick={() => navigateToNotam(it.index)}
				title={t.detail.openNotamTip}
			>
				<span
					class="dot dot--{status(it.notam)}"
					title={t.notam.status[
						notamStatus(it.notam.startDate, it.notam.endDate, it.notam.permanent)
					]}
				></span>
				<span class="id">{it.notam.id}</span>
				{#if it.notam.qCode}
					<span class="qcode">{it.notam.qCode}</span>
				{/if}
				<!-- Raw NOTAM E)-text excerpt (docs/i18n.md rule 11). -->
				<span class="excerpt" lang="en">{excerpt(it.notam)}</span>
			</button>
		</li>
	{/each}
</ul>

<style>
	.rows {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 2px 0 6px;
		padding: 0;
		list-style: none;
	}

	.row {
		display: flex;
		align-items: baseline;
		gap: 7px;
		width: 100%;
		min-width: 0;
		padding: 3px 6px;
		font: inherit;
		text-align: left;
		color: var(--text);
		background: transparent;
		border: 1px solid transparent;
		border-radius: 4px;
		cursor: pointer;
	}

	.row:hover {
		background: var(--surface-2);
		border-color: var(--border);
	}

	.row:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.dot {
		flex: 0 0 auto;
		align-self: center;
		width: 7px;
		height: 7px;
		border-radius: 50%;
	}

	.dot--active {
		background: var(--status-active);
	}

	.dot--future {
		background: var(--accent);
	}

	.dot--expired {
		background: var(--surface-3);
		border: 1px solid var(--border);
	}

	.id {
		flex: 0 0 auto;
		font-family: ui-monospace, monospace;
		font-size: 12px;
		font-weight: 700;
	}

	.qcode {
		flex: 0 0 auto;
		padding: 1px 5px;
		font-family: ui-monospace, monospace;
		font-size: 11px;
		color: var(--text-muted);
		background: var(--surface-2);
		border-radius: 3px;
	}

	.excerpt {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		font-size: 11px;
		color: var(--text-muted);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
