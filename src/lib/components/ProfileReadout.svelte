<script lang="ts">
	/* The profile modals' docked cursor readout: label/value rows in the
	 * plot's top-right corner, pointer-transparent so the chart beneath
	 * keeps the pointer. The caller assembles the rows; `children` renders
	 * inside the box (the trace modal's unlock overlay, which restores its
	 * own pointer-events), and `class` carries the caller's state:
	 * `no-print` on the route readout, `locked` on the trace one. */
	import type { Snippet } from 'svelte';

	interface Props {
		rows: { label: string; value: string }[];
		/** Muted footer line (the route readout's context-menu hint). */
		hint?: string;
		class?: string;
		children?: Snippet;
	}
	const { rows, hint, class: boxClass = '', children }: Props = $props();
</script>

<div class="cursor-readout {boxClass}">
	{@render children?.()}
	<dl>
		{#each rows as row (row.label)}
			<dt>{row.label}</dt>
			<dd>{row.value}</dd>
		{/each}
	</dl>
	{#if hint}
		<p class="hint">{hint}</p>
	{/if}
</div>

<style>
	.cursor-readout {
		position: absolute;
		top: 8px;
		right: 8px;
		z-index: 1;
		padding: 6px 9px;
		font-size: 11px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-1);
		pointer-events: none;
	}

	/* Pinned to a clicked point (the trace modal): the accent border and the
	 * cursor signal that the whole panel is the unlock control. */
	.cursor-readout.locked {
		border-color: var(--accent);
		cursor: pointer;
	}

	.cursor-readout dl {
		display: grid;
		grid-template-columns: auto auto;
		gap: 1px 10px;
		margin: 0;
	}

	.cursor-readout dt {
		color: var(--text-muted);
	}

	.cursor-readout dd {
		margin: 0;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.hint {
		margin: 4px 0 0;
		font-size: 10px;
		color: var(--text-muted);
	}
</style>
