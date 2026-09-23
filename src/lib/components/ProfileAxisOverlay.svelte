<script lang="ts">
	/* The phone strip's altitude labels (docs/route-profile.md "Phones: the
	 * strip"). The chart scrolls sideways under the box, so labels drawn in
	 * its own SVG would leave with it: these sit in an overlay pinned to
	 * the box's left edge, over the chart's own mapping (yOf at the strip's
	 * zero pads, yTicks' level vocabulary), just above their gridline and
	 * haloed like the chart's inside labels. The bottom strip is left to
	 * the distance labels and the top line to the idents; the unit rides
	 * the highest plain-feet label, an FL label naming its own. Pointer-
	 * transparent: the strip underneath keeps every gesture. */
	import { yOf, yTicks } from '$lib/route/routeProfile';

	interface Props {
		floorFt: number;
		ceilingFt: number;
		heightPx: number;
		transitionAltFt?: number | null;
	}
	const { floorFt, ceilingFt, heightPx, transitionAltFt = null }: Props = $props();

	const y = (ft: number): number => yOf(ft, floorFt, ceilingFt, Math.max(1, heightPx), 0);
	/* Clear of the ident row at the top and of the distance labels at the
	 * foot. A level label is drawn at `y - 3` in 10 px type, so its box runs
	 * from about `y - 13`; the idents sit on baseline 11 and theirs ends at
	 * about 13, which is what puts the top guard three px above the 22 it
	 * read at first (both are haloed, so an overlap eats into both). */
	const shown = $derived(yTicks(floorFt, ceilingFt, transitionAltFt).filter((t) => y(t.ft) > 25 && y(t.ft) < heightPx - 14));
	const unitFt = $derived.by(() => {
		let best: number | null = null;
		for (const t of shown) {
			if (!t.label.startsWith('FL') && (best === null || t.ft > best)) {
				best = t.ft;
			}
		}
		return best;
	});
</script>

<svg class="axis-overlay no-print" width="80" height={Math.max(1, heightPx)} aria-hidden="true">
	{#each shown as t (t.ft)}
		<text class="lbl" x={4} y={y(t.ft) - 3}>{t.label}{t.ft === unitFt ? ' ft' : ''}</text>
	{/each}
</svg>

<style>
	.axis-overlay {
		position: absolute;
		top: 0;
		left: 0;
		pointer-events: none;
	}

	.lbl {
		font-family: ui-monospace, monospace;
		font-size: 10px;
		fill: var(--text-muted);
		paint-order: stroke;
		stroke: var(--surface);
		stroke-width: 2.6px;
		stroke-linejoin: round;
	}
</style>
