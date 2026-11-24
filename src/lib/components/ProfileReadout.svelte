<script lang="ts" module>
	/** One line of a multi-line readout value; `strong` sets it in bold (the
	 *  route readout's cloud layer under the pointer). */
	export interface ReadoutLine {
		text: string;
		strong: boolean;
	}

	/** A readout row: a plain value, or several lines (the route readout's
	 *  cloud layers). */
	export interface ReadoutRow {
		label: string;
		value: string | readonly ReadoutLine[];
	}
</script>

<script lang="ts">
	/* The profile modals' docked cursor readout: label/value rows in the
	 * plot's top-right corner, pointer-transparent so the chart beneath
	 * keeps the pointer. The caller assembles the rows; `children` renders
	 * inside the box (the trace modal's unlock overlay, which restores its
	 * own pointer-events), and `class` carries the caller's state:
	 * `no-print` on the route readout, `locked` on the trace one. */
	import type { Snippet } from 'svelte';

	interface Props {
		rows: readonly ReadoutRow[];
		/** Muted lines under the rows, before the hint (the route readout's
		 *  cloud notes: when the column was read, how far to trust it). */
		notes?: readonly string[] | undefined;
		/** Muted footer line (the route readout's context-menu hint). */
		hint?: string;
		/** The height the box may take, px (the route readout's: its plot's,
		 *  less the box's margins). Where the rows and the notes and hint
		 *  under them would not all fit, the notes and the hint step aside
		 *  together, so a short plot never cuts a line in half (the plot
		 *  clips). Absent: unbounded. */
		room?: number | undefined;
		class?: string;
		children?: Snippet;
	}
	const { rows, notes = [], hint, room, class: boxClass = '', children }: Props = $props();

	/** The box's padding and border around its two parts. */
	const CHROME_PX = 14;
	let coreH = $state(0);
	let extrasH = $state(0);
	// The extras are measured whether shown or set aside (still laid out,
	// out of the flow and unseen) and never wrap, so their height does not
	// depend on the box's width and the test cannot flip on its own outcome.
	const fits = $derived(room == null || coreH + extrasH + CHROME_PX <= room);
</script>

<div class="cursor-readout {boxClass}">
	<div bind:clientHeight={coreH}>
		{@render children?.()}
		<dl>
			{#each rows as row (row.label)}
				<dt>{row.label}</dt>
				{#if typeof row.value === 'string'}
					<dd>{row.value}</dd>
				{:else}
					<!-- Keyed by position: two thin layers can print alike. -->
					<dd class="lines">
						{#each row.value as line, i (i)}
							<span class:strong={line.strong}>{line.text}</span>
						{/each}
					</dd>
				{/if}
			{/each}
		</dl>
	</div>
	{#if notes.length > 0 || hint}
		<div class="extras" class:aside={!fits} bind:clientHeight={extrasH}>
			{#each notes as note, i (i)}
				<p class="note">{note}</p>
			{/each}
			{#if hint}
				<p class="hint">{hint}</p>
			{/if}
		</div>
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

	.lines span {
		display: block;
	}

	.lines .strong {
		font-weight: 600;
	}

	/* Its own formatting context, so the lines' margins count in its
	 * measured height. */
	.extras {
		display: flow-root;
	}

	.extras.aside {
		position: absolute;
		visibility: hidden;
	}

	.note,
	.hint {
		margin: 4px 0 0;
		font-size: 10px;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.note + .note {
		margin-top: 1px;
	}
</style>
