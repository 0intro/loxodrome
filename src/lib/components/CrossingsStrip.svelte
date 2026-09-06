<script lang="ts">
	/* The safety strip under a profile title: every crossed volume, forbidden
	 * first (bandCrossings order). Three renditions of the same rows:
	 *
	 * - Desktop interactive: ONE wrapping row. A forbidden crossing leads it
	 *   with a filled alarm pill (role=alert, the full sentence in its
	 *   title); the chips follow, hover highlights the band in the chart and
	 *   click navigates. The old standalone banner line was folded into the
	 *   pill (user-decided): the forbidden chips already wear the alarm ink,
	 *   and a dock's height belongs to the chart.
	 * - Phone interactive: ONE summary line (the forbidden count + the
	 *   crossing count) opening a bottom sheet of worded rows, tap navigates
	 *   (user-decided: chips' hover does not exist on touch, and the two
	 *   rows the banner + chips cost were the chart's). The full row stays
	 *   in the DOM, screen-hidden, so printing FROM a phone still prints the
	 *   whole strip.
	 * - The printed dossier's static text (unchanged: its geometry is pinned
	 *   by pdftotext -bbox, so the static markup and metrics keep the
	 *   dossier's exact shape, full banner sentence included).
	 *
	 * Chips are otherwise locale-invariant (designators, formatVLimit
	 * output, NM). */
	import { t } from '$lib/state/i18n.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import Icon from './Icon.svelte';
	import HeadOverlay from './HeadOverlay.svelte';
	import type { SurfaceId } from '$lib/surfaces';
	import { fmtRangeNM, type BandCrossing } from '$lib/route/routeProfile';

	interface Props {
		crossings: BandCrossing[];
		interactive?: boolean;
		/** The workspace surface the interactive rendition lives in, so the
		 *  phone sheet clears a full-screen box (HeadOverlay's surface). */
		surfaceId?: SurfaceId;
		/** Chip pointer in / out (interactive only); null = pointer left. */
		onhover?: (key: string | null) => void;
		/** Chip / sheet-row click (interactive only). */
		onselect?: (key: string) => void;
	}
	const { crossings, interactive = false, surfaceId, onhover, onselect }: Props = $props();

	const forbiddenCount = $derived(crossings.filter((c) => c.forbidden).length);
	let sheetOpen = $state(false);
</script>

{#if crossings.some((c) => c.forbidden) && !interactive}
	<div class="forbid-print">
		<b aria-hidden="true">⚠</b>
		{t.route.crossesForbidden}
	</div>
{/if}

{#if interactive && ui.isMobile && crossings.length > 0}
	<!-- The phone's whole strip: one line, the sheet holds the rows. Screen
	     only (.no-print): the hidden full row below is what paper gets. -->
	<button class="cx-sum no-print" aria-label={t.route.crossingsOpenAria} onclick={() => (sheetOpen = true)}>
		{#if forbiddenCount > 0}
			<span class="cx-sum-warn" role="alert" title={t.route.crossesForbidden}>
				<span aria-hidden="true">⚠</span>
				{forbiddenCount}
			</span>
		{/if}
		<span class="cx-sum-label">{t.route.crossesLabel}</span>
		<span class="cx-sum-n">{crossings.length}</span>
		<Icon name="chevron-right" size={14} />
	</button>
	<HeadOverlay
		open={sheetOpen}
		x={0}
		y={0}
		title={t.route.crossesLabel}
		surface={surfaceId}
		onClose={() => (sheetOpen = false)}
	>
		{#each crossings as c (c.key)}
			{@const ranges = c.pens.map((p) => fmtRangeNM(p.fromNM, p.toNM)).join(', ')}
			<button
				class="item cx-row"
				class:accent={c.badgeKind === 'zone' || c.key.startsWith('notam:')}
				class:forbidden={c.forbidden}
				style:--cx-color={c.color}
				onclick={() => {
					sheetOpen = false;
					onselect?.(c.key);
				}}
			>
				{#if c.forbidden}<span class="cx-warn" aria-hidden="true">⚠</span>{/if}
				{#if c.badge}<span class="cx-badge">{c.badge}</span>{/if}
				<span class="cx-row-name">{c.label}</span>
				{#if c.forbidden && c.active}<span class="cx-badge">{t.route.activeWord}</span>{/if}
				<span class="cx-row-fig">
					<span class="cx-lim">{c.limitsText}</span>
					{#if c.extentUnknown}<span class="cx-extent">{t.route.extentUnknownShort}</span>{/if}
					<span class="cx-rng">{ranges} NM</span>
				</span>
			</button>
		{/each}
	</HeadOverlay>
{/if}

{#if crossings.length > 0}
	<div class={['crossings', !interactive && 'print']}>
		<span class="cx-label">{t.route.crossesLabel}</span>
		{#if interactive && forbiddenCount > 0}
			<!-- The NO-GO callout folded into the row: filled alarm pill, the
			     full sentence on its title and for assistive tech. -->
			<span class="cx-chip cx-forbid" role="alert" title={t.route.crossesForbidden}>
				<span aria-hidden="true">⚠</span>
				{t.route.crossesForbiddenShort}
				<span class="sr-only">{t.route.crossesForbidden}</span>
			</span>
		{/if}
		{#each crossings as c (c.key)}
			{@const ranges = c.pens.map((p) => fmtRangeNM(p.fromNM, p.toNM)).join(', ')}
			{#if interactive}
				<button
					class="cx-chip"
					class:accent={c.badgeKind === 'zone' || c.key.startsWith('notam:')}
					class:forbidden={c.forbidden}
					style:--cx-color={c.color}
					title={c.tooltip}
					onmouseenter={() => onhover?.(c.key)}
					onmouseleave={() => onhover?.(null)}
					onclick={() => onselect?.(c.key)}
				>
					{#if c.forbidden}<span class="cx-warn" aria-hidden="true">⚠</span>{/if}
					{#if c.badge}<span class="cx-badge">{c.badge}</span>{/if}
					<span class="cx-name">{c.label}</span>
					{#if c.forbidden && c.active}<span class="cx-badge">{t.route.activeWord}</span>{/if}
					<span class="cx-lim">{c.limitsText}</span>
					{#if c.extentUnknown}<span class="cx-extent">{t.route.extentUnknownShort}</span>{/if}
					<span class="cx-rng">{ranges} NM</span>
				</button>
			{:else}
				<span
					class="cx-static"
					class:accent={c.badgeKind === 'zone' || c.key.startsWith('notam:')}
					class:forbidden={c.forbidden}
					style:--cx-color={c.color}
				>
					{#if c.forbidden}<b aria-hidden="true">⚠</b>{/if}
					{#if c.badge}<b>{c.badge}</b>{/if}
					{c.label}
					{#if c.forbidden && c.active}<b>{t.route.activeWord}</b>{/if}
					{c.limitsText},
					{#if c.extentUnknown}{t.route.extentUnknownShort},{/if}
					{ranges} NM
				</span>
			{/if}
		{/each}
	</div>
{/if}

<style>
	/* The caveat on a crossing the publisher's limits could not settle:
	 * the row is a lateral statement, and it must not read like a
	 * vertical one. */
	.cx-extent {
		font-size: var(--fs-2xs);
		font-style: italic;
		opacity: 0.75;
	}

	/* Crossings strip: compact wrapping chips under the title line. Zone
	 * (R/D/P) and NOTAM chips take their band's ink via --cx-color; the
	 * controlled rest stays neutral (transits are routinely intentional). */
	.crossings {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		font-size: 11px;
	}

	.crossings:not(.print) {
		gap: 4px 6px;

		/* NO negative top margin: the interactive rendition lives inside the
		   modal's .cx-scroll, and a scroll container CLIPS what a first child
		   pulls above its content origin (the strip's top border was a
		   missing band of pixels on both platforms). */
		margin: 0 0 10px;
	}

	/* Phones show the summary line instead; the full row stays in the DOM so
	   printing FROM a phone prints the whole strip (the counter-rule below). */
	:global(:root.mobile-ui) .crossings:not(.print) {
		display: none;
	}

	.cx-label {
		font-weight: 600;
		color: var(--text-muted);
	}

	.cx-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 1px 7px;
		font-family: inherit;
		font-size: 11px;
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: 9px;
		cursor: pointer;
	}

	.cx-chip:hover {
		background: var(--surface-3);
	}

	/* The folded NO-GO callout: the strip's one loud element, leading the
	 * row in the restricted ink (a status, not a button). */
	.cx-forbid,
	.cx-forbid:hover {
		gap: 5px;
		color: #fff;
		background: var(--airspace-restricted);
		border-color: var(--airspace-restricted);
		font-weight: 700;
		cursor: default;
	}

	/* (.sr-only is the app.css global utility.) */

	/* An 18 to 29px chip is what a wrapping strip can afford, and on a phone
	   the strip is already the part that scrolls, so the floor comes from
	   slop rather than from a taller row. Print keeps its pinned metrics. */
	:global(:root.touch-ui) .crossings:not(.print) .cx-chip {
		position: relative;
	}

	:global(:root.touch-ui) .crossings:not(.print) .cx-chip::after {
		position: absolute;
		inset: -8px -2px;
		content: '';
	}

	.cx-chip.accent {
		color: var(--cx-color);
		border-color: var(--cx-color);
	}

	/* NO-GO crossing: filled alarm chip, listed first by bandCrossings. */
	.cx-chip.forbidden,
	.cx-chip.forbidden:hover {
		color: #fff;
		background: var(--cx-color);
		border-color: var(--cx-color);
		font-weight: 600;
	}

	.cx-chip.forbidden .cx-rng {
		color: #fff;
		opacity: 0.85;
	}

	.cx-warn {
		font-weight: 700;
	}

	.cx-badge {
		font-weight: 700;
	}

	.cx-lim,
	.cx-rng {
		font-family: ui-monospace, monospace;
	}

	.cx-rng {
		color: var(--text-muted);
	}

	/* ---- the phone's summary line + sheet rows ---- */
	.cx-sum {
		display: flex;
		align-items: center;
		gap: 7px;
		width: 100%;
		min-height: 28px;
		margin: 0 0 6px;
		padding: 2px 4px;
		font: inherit;
		font-size: 12px;
		color: var(--text);
		text-align: left;
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	:global(:root.touch-ui) .cx-sum {
		min-height: 44px;
	}

	.cx-sum-warn {
		display: inline-flex;
		gap: 4px;
		align-items: center;
		padding: 1px 8px;
		font-weight: 700;
		color: #fff;
		background: var(--airspace-restricted);
		border-radius: 9px;
	}

	.cx-sum-label {
		font-weight: 600;
		color: var(--text-muted);
	}

	.cx-sum-n {
		font-weight: 600;
	}

	/* Sheet rows: the app.css .item base (touch floor, hover) plus the
	 * chips' ink grammar. The figures right-align so limits and ranges
	 * line up down the sheet. */
	.cx-row {
		gap: 6px;
		font-size: 12px;
	}

	.cx-row.accent {
		color: var(--cx-color);
	}

	.cx-row.forbidden {
		color: #fff;
		background: var(--cx-color);
		border-radius: var(--radius-sm);
		font-weight: 600;
	}

	.cx-row.forbidden:hover {
		background: var(--cx-color);
	}

	.cx-row-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.cx-row-fig {
		display: inline-flex;
		gap: 8px;
		align-items: baseline;
		margin-left: auto;
		font-size: 11px;
	}

	.cx-row.forbidden .cx-rng {
		color: #fff;
		opacity: 0.85;
	}

	/* The dossier sheet's static rendition (print-only, like the .fpd-*
	 * rules these replace: the parked print doc carries no screen styling). */
	@media print {
		/* Printing FROM a phone: the summary is screen furniture (.no-print)
		   and the full strip un-hides, wrapping like desktop paper. */
		:global(:root.mobile-ui) .crossings:not(.print) {
			display: flex;
			flex-wrap: wrap;
		}

		.crossings.print {
			gap: 3px 6px;
			margin: 0 0 6px;
		}

		.cx-static {
			padding: 0 6px;
			color: var(--text);
			border: 1px solid var(--border-strong);
			border-radius: 8px;
		}

		.cx-static.accent {
			color: var(--cx-color);
			border-color: var(--cx-color);
		}

		.cx-static.forbidden {
			color: #fff;
			background: var(--cx-color);
			border-color: var(--cx-color);
			font-weight: 600;
		}

		/* The page's one loud line: a forbidden crossing on paper.
		 * Content-width, like the on-screen callout. */
		.forbid-print {
			display: flex;
			gap: 6px;
			align-items: center;
			width: fit-content;
			margin: 0 0 5px;
			padding: 3px 8px;
			font-size: 12px;
			font-weight: 600;
			color: var(--airspace-restricted);
			border: 1px solid var(--airspace-restricted);
			border-radius: 4px;
		}
	}
</style>
