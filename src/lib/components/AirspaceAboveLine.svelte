<script lang="ts">
	/* The actionable number a point profile implies: the base of the lowest
	 * controlled or restricted airspace above the reference, and the free height
	 * under it (SkyDemon's PLOG "Airspace Above" column). Shared by the profile
	 * surfaces' header and the detail panel's inline chart, so the sentence
	 * exists once. Content, not chrome: it prints with the chart.
	 *
	 * The figure is arithmetic over the columns the chart drew; the zone names
	 * its floor as PUBLISHED, so the two can never contradict each other. That
	 * is also its limit, and the third case below: over a filtered stack the
	 * arithmetic is over the wrong set, and it answers "nothing above" for a
	 * point under a class A TMA. It says so instead. */
	import { t } from '$lib/state/i18n.svelte';
	import type { AirspaceAbove } from './verticalProfile';

	interface Props {
		above: AirspaceAbove;
		/** Ground at the profiled point. Without it the reference would be sea
		 *  level, which is nowhere anybody is, so the line is suppressed: that is
		 *  what keeps it off the NOTAM panel's ground-less profile. */
		groundFt: number | null;
		/** Header form: no label and one elided line, because a title bar has no
		 *  room to spend on a label the sentence carries anyway. The panel form
		 *  keeps the label and wraps. */
		compact?: boolean;
		/** Is `above` still the WHOLE stack's answer, or did a filter hide the
		 *  volume that IS the one overhead (aboveIsComplete)? The figure is
		 *  arithmetic over the drawn columns, and `airspaceAbove([])` returns
		 *  the same "nothing above" as a real stack with nothing counted over
		 *  you, so a filtered chart answered "no controlled or restricted
		 *  airspace above" for a point under a class A TMA. False is taken
		 *  FIRST and prints no figure at all. */
		complete?: boolean;
	}
	const { above, groundFt, compact = false, complete = true }: Props = $props();

	const zone = $derived.by(() => {
		const c = above.column;
		if (!c) {
			return '';
		}
		const name = c.shortLabel ?? c.id;
		// i18n-ignore: invariant altitude tokens (Doc 8400), data otherwise
		const base = c.lowerText ? c.lowerText : `${Math.round(above.baseFt ?? 0)} ft AMSL`;
		return `${name} (${base})`;
	});
</script>

{#if groundFt != null}
	<p class="above" class:compact title={t.detail.airspaceAboveTip}>
		{#if !compact}
			<span class="lbl">{t.detail.airspaceAboveLabel}</span>
		{/if}
		{#if !complete}
			{t.detail.airspaceAboveHidden}
		{:else if above.column}
			{t.detail.airspaceAboveFree({ ft: String(Math.round(above.freeFt)), zone })}
		{:else}
			{t.detail.airspaceAboveNone}
		{/if}
	</p>
{/if}

<style>
	/* Panel form: wraps, since a detail block has the width and no controls to
	   push off the end. */
	.above {
		margin: 0 0 4px;
		font-size: 11px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	/* Header form: one line that elides, like the title beside it. */
	.above.compact {
		margin: 0;
		min-width: 0;
		overflow: hidden;
		font-size: 12px;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.lbl {
		color: var(--text-muted);
	}
</style>
