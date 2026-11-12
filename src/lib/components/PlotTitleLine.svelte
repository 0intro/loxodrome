<script lang="ts">
	/* The dep -> dest / distance / ETE title line over a route profile
	 * chart, shared by the route-profile modal (interactive: ETE tooltip
	 * plus the one loading / degradation cap) and the printed dossier's
	 * profile sheet (static; its geometry is pinned by pdftotext -bbox, so
	 * the print variant keeps the dossier's exact metrics). */
	import { t } from '$lib/state/i18n.svelte';
	import { fmtEte, fmtNM } from '$lib/route/format';
	import { routeTitle } from '$lib/route/routeLabel';
	import type { Waypoint } from '$lib/state/route.svelte';

	interface Props {
		route: { name: string | null; waypoints: Waypoint[] };
		totalNM: number;
		/** Wind-corrected when the caller has one; null hides the ETE. */
		eteMin: number | null;
		/** Modal variant: ETE tooltip + the cap slot; print variant otherwise. */
		interactive?: boolean;
		/** The one loading / degradation cap (interactive only; null = none). */
		cap?: string | null;
	}
	const { route, totalNM, eteMin, interactive = false, cap = null }: Props = $props();
</script>

<!-- has-cap marks a carried loading / degradation cap: the phone hides
     this line except then (the cap is the route profile's only such
     surface, most needed exactly on a phone). -->
<div class={['title-line', !interactive && 'print', cap !== null && 'has-cap']}>
	<strong>{routeTitle(route)}</strong>
	<span>{fmtNM(totalNM)} NM</span>
	{#if eteMin !== null}<span title={interactive ? t.route.profileEteTip : undefined}
			>ETE {fmtEte(eteMin)}</span
		>{/if}
	{#if cap !== null}<span class="cap">{cap}</span>{/if}
</div>

<style>
	.title-line {
		display: flex;
		align-items: baseline;
		font-size: 13px;
		color: var(--text-muted);
	}

	.title-line:not(.print) {
		flex-wrap: wrap;
		gap: 6px 14px;
		margin-bottom: 10px;
	}

	.title-line strong {
		font-size: 14px;
		color: var(--text);
	}

	.cap {
		color: var(--text-muted);
	}

	/* The dossier sheet's metrics (print-only, like the .fpd-* rules these
	   replace: the parked print doc carries no screen styling). */
	@media print {
		.title-line.print {
			gap: 14px;
			margin: 0 0 8px;
		}
	}
</style>
