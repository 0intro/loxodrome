<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		/** Heading content (a publisher link, optionally with trailing
		 *  text), rendered inside the card's <h4>. */
		heading: Snippet;
		/** Rows that are sentences rather than figures (the live services
		 *  and the bundled models say what they carry, not how many). A
		 *  shared label column is what aligns a whole group of counters;
		 *  on a card whose every value is prose it would hand 10.5rem to
		 *  three short labels and squeeze the sentences into what is left,
		 *  so those cards size their labels to their own content. */
		prose?: boolean;
		/** The <dt>/<dd> rows, rendered inside the card's <dl>. */
		children: Snippet;
	}
	let { heading, prose = false, children }: Props = $props();
</script>

<article class="source" class:prose>
	<h4>{@render heading()}</h4>
	<dl>{@render children()}</dl>
</article>

<style>
	/* The cards flow down a multicolumn container rather than a row grid, so
	 * each is its own height and the gap is a margin, not a grid gap. A row
	 * grid stretched every card to the tallest in its row: the SUP AIP card
	 * carried 185px of empty box beside the France one, and sixteen others
	 * carried 24 to 145px. */
	.source {
		padding: 8px 10px;
		margin: 0 0 10px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 6px;
		break-inside: avoid;
	}

	.source h4 {
		margin: 0 0 6px;
		font-size: 12px;
		font-weight: 600;
		color: var(--text);
	}

	/* The label column is a WIDTH, not a measurement of this card's own
	 * labels. fit-content(45%) sized each card to its own widest label, and
	 * since the cards say different things that produced nine different
	 * label widths in English and twelve in French: reading down a column,
	 * the values stepped left and right at every card. min() is content
	 * independent, and every card in the container is the same width, so
	 * they all resolve it to the same number and the values line up.
	 *
	 * The 45% arm is the ceiling commit f09b4b5d measured, kept: one long
	 * label must not starve the values. The nature families label a row
	 * "Site with special marking of prohibited low overflying", 53
	 * characters, and labels come from the catalogs and are translated, so
	 * their length is not something this card gets to assume. It wraps
	 * inside its track instead of widening it. On a phone the card is
	 * narrow enough that 45% wins and 10.5rem never applies. */
	.source dl {
		display: grid;
		grid-template-columns: min(10.5rem, 45%) minmax(0, 1fr);
		column-gap: 10px;
		row-gap: 2px;
		margin: 0;
		font-size: 12px;
	}

	/* Prose cards get a much narrower column, but still a shared WIDTH for
	 * the same reason: three labels ("Data", "Fetched", "License", and only
	 * two of them on a card with nothing to fetch) sized to their own
	 * content put the values 27px apart between neighbours in French.
	 * 5.5rem clears the longest of the three in both catalogs. */
	.source.prose dl {
		grid-template-columns: min(5.5rem, 45%) minmax(0, 1fr);
	}

	/* The dt/dd rows come from the caller's `children` snippet, so they
	 * carry the caller's scope rather than this component's; :global lets
	 * the card style its own rows. The `.source` ancestor keeps every rule
	 * confined to cards. */
	.source :global(dt) {
		color: var(--text-muted);
		font-weight: 500;
	}

	.source :global(dd) {
		margin: 0;
		color: var(--text);
	}

	.source :global(dd.muted) {
		color: var(--text-muted);
	}

	.source :global(dd .aside) {
		color: var(--text-muted);
		font-size: 11px;
	}

	/* Freshness signal on the "Generated" line, by AIRAC cycle: data from
	 * the current 28-day cycle reads normal; one cycle behind (a newer cycle
	 * is effective, the refresh pending) turns amber; two or more cycles
	 * behind is a stalled feed and the row goes red. */
	.source :global(dd.fresh) {
		color: var(--text);
	}

	/* The theme's own middle-tier ink, not a hand-picked orange: the literal
	 * this used to carry measured 3.80:1 on the day card and 3.77:1 on the
	 * night one, under AA at 12px on both. The token is tuned per theme and
	 * pinned by tests/contrast.spec.ts (5.30:1 / 8.82:1 here). */
	.source :global(dd.stale) {
		color: var(--workbook-orange);
	}

	.source :global(dd.expired) {
		color: var(--danger);
		font-weight: 600;
	}
</style>
