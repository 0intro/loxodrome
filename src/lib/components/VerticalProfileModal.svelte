<script lang="ts">
	/* The stacked-airspace altitude profile as a workspace surface. Two
	 * surfaces render it: `mapProfile` (the stack over a point picked on the
	 * map) and `airspaceProfile` (a detail panel's own airspaces).
	 *
	 * VerticalProfile draws at an intrinsic pixel size, so the chart is sized
	 * from the measured box here: the height it is given, and columns wide
	 * enough to spread across it. That is what lets the same chart read in a
	 * short bottom dock and at full screen. */
	import SurfaceShell from './SurfaceShell.svelte';
	import VerticalProfile from './VerticalProfile.svelte';
	import RangeSlider from './RangeSlider.svelte';
	import AirspaceAboveLine from './AirspaceAboveLine.svelte';
	import Segmented from './Segmented.svelte';
	import Icon from './Icon.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { display, setProfileAllAirspaces } from '$lib/state/display.svelte';
	import { panWindow, zoomWindow } from '$lib/route/routeProfile';
	import { untrack } from 'svelte';
	import type { SurfaceId } from '$lib/surfaces';
	import type { VerticalColumn, VerticalOverlay } from './verticalProfile';
	import {
		PAD_L,
		PAD_R,
		WINDOW_MIN_SPAN_FT,
		airspaceAbove,
		chartPads,
		levelLabel,
		profileBounds,
		windowColumns,
		windowNoteText,
	} from './verticalProfile';

	interface Props {
		/** Which surface this instance is; see $lib/surfaces.ts. */
		id: SurfaceId;
		title: string;
		/** Second header line: what the chart is over (the map profile states its
		 *  point, which moves). Content, so it prints with the chart. */
		subtitle?: string | undefined;
		/** The whole stack; this surface crops it to its own live window. */
		columns: VerticalColumn[];
		overlays: VerticalOverlay[];
		/** The FITTED window from `profileWindow`. An untouched surface follows it
		 *  live; a zoomed or panned one holds until Fit. */
		fitCeilingFt: number;
		fitFloorFt?: number;
		/** Ground elevation (ft) of the profiled point; null = no terrain. */
		groundFt?: number | null;
		onColumnClick?: (id: string) => void;
		/** Forwarded to the chart: a column id on pointer enter, null on leave, so
		 *  the caller can mirror the hover (flash the airspace on the map). The
		 *  chart keys its columns by index, so a hovered column can be REPLACED
		 *  under a still pointer with no leave event: hold the value and drop it
		 *  when the key leaves your data rather than writing straight through. */
		onColumnHover?: (id: string | null) => void;
		onClose: () => void;
	}
	const {
		id,
		title,
		subtitle,
		columns,
		overlays,
		fitCeilingFt,
		fitFloorFt = 0,
		groundFt = null,
		onColumnClick,
		onColumnHover,
		onClose,
	}: Props = $props();

	/** The width the chart's axis costs (its own gutters). */
	const PAD_X = PAD_L + PAD_R;
	/** Below this the vertical name labels (a 110 px row) would leave less
	 *  plot than label; the chart falls back to its badge row. */
	const LABEL_MIN_H = 280;
	const MIN_CHART_H = 90;
	/** Below this the slider's handles plus the chart's gutters leave a track too
	 *  short to aim at; Fit, the gestures and the keyboard are the whole control
	 *  set then. */
	const SLIDER_MIN_H = 180;

	let boxW = $state(0);
	let boxH = $state(0);

	const chartH = $derived(Math.max(MIN_CHART_H, boxH));
	const showLabels = $derived(chartH >= LABEL_MIN_H);

	/* The live altitude window. Component state, because the mount lifetimes
	 * already give the right granularity: MapProfileModal is mounted once in
	 * App.svelte, so the map profile's window survives close / reopen for the
	 * session, while detail/AltitudeProfile is remounted per panel, so a new
	 * panel starts from the fit. Not persisted, deliberately: profileLayers
	 * persists reading PREFERENCES, and a window frames one point's data, which
	 * does not survive a reload anyway.
	 *
	 * `touched` is the route profile's flag. An untouched window follows the fit
	 * live (a re-target, a filter change, the ground tile landing); a touched one
	 * holds. A re-target does NOT reset it: the map marker's drag re-targets
	 * continuously, so any reset rule would fire on every pointermove, and a
	 * cropped column's perforated edge already says there is more outside the
	 * frame. Fit is the reset. */
	let touched = $state(false);
	let winFloorFt = $state(0);
	let winCeilingFt = $state(10000);

	const bounds = $derived(
		profileBounds(columns, {
			// A band the chart draws has to stay reachable by zooming out.
			overlayCeilingFt: overlays.reduce((m, o) => Math.max(m, o.ceilingFt ?? 0), 0),
		}),
	);

	$effect(() => {
		const lo = fitFloorFt;
		const hi = fitCeilingFt;
		const b = bounds;
		const held = touched;
		untrack(() => {
			if (!held) {
				winFloorFt = lo;
				winCeilingFt = hi;
				return;
			}
			// The data ceiling can SHRINK under a held window (the marker moves to
			// a thinner stack). Re-clamp through zoomWindow's factor-1 path rather
			// than leaving a window outside its own bounds, which the slider would
			// render off its track.
			[winFloorFt, winCeilingFt] = zoomWindow(
				winFloorFt,
				winCeilingFt,
				(winFloorFt + winCeilingFt) / 2,
				1,
				b.minFt,
				b.maxFt,
				WINDOW_MIN_SPAN_FT,
			);
		});
	});

	// The stack cropped to the LIVE window, and the statement of what that costs.
	const win = $derived({ floorFt: winFloorFt, ceilingFt: winCeilingFt });
	const placed = $derived(windowColumns(columns, win, groundFt));
	const windowNote = $derived(windowNoteText(win, placed, t.detail));

	// Over the WHOLE stack, not the drawn subset: what is above you cannot depend
	// on how far the chart happens to be zoomed in.
	const above = $derived(airspaceAbove(columns, groundFt));

	/* Spread the columns over the measured width, chunky enough to point at on
	 * touch and capped so a lone column does not become a slab. */
	const colW = $derived.by(() => {
		const n = Math.max(1, placed.drawn.length);
		const ideal = Math.floor(Math.max(60, boxW - PAD_X) / n);
		return Math.max(22, Math.min(72, ideal));
	});

	const pads = $derived(chartPads(placed.drawn, { showLabels, colW }));
	const showSlider = $derived(chartH >= SLIDER_MIN_H);

	/* Zoom is a RANGE control: the span scales about the window's own FLOOR, so
	 * the ceiling moves and the bottom of the frame stays where it is. On the
	 * fitted window that floor is the ground, which is the datum every column
	 * stands on and what the terrain band and the GND rung read against, so
	 * zooming in to read the low structure is exactly when it must not slide
	 * off; anchoring at the LIVE floor rather than at the ground then leaves a
	 * deliberate pan or slider drag up to a high slab alone (a wheel would
	 * otherwise drag the window back down under the pointer). Zooming fully out
	 * still lands back on the ground, since zoomWindow shifts a window that
	 * reaches its maximum span back inside the bounds.
	 *
	 * Touched flips only when the window actually MOVES: a wheel pinned at the
	 * minimum span, or a pan at a bound, is a no-op and must not latch the view. */
	function applyZoom(factor: number): void {
		const [lo, hi] = zoomWindow(
			winFloorFt,
			winCeilingFt,
			winFloorFt,
			factor,
			bounds.minFt,
			bounds.maxFt,
			WINDOW_MIN_SPAN_FT,
		);
		if (lo === winFloorFt && hi === winCeilingFt) {
			return;
		}
		winFloorFt = lo;
		winCeilingFt = hi;
		touched = true;
	}

	function applyPan(dFt: number): void {
		const [lo, hi] = panWindow(winFloorFt, winCeilingFt, dFt, bounds.minFt, bounds.maxFt);
		if (lo === winFloorFt) {
			return;
		}
		winFloorFt = lo;
		winCeilingFt = hi;
		touched = true;
	}

	function onSliderWindow(low: number, high: number): void {
		winFloorFt = low;
		winCeilingFt = high;
		touched = true;
	}

	function fitReset(): void {
		touched = false;
		winFloorFt = fitFloorFt;
		winCeilingFt = fitCeilingFt;
	}

	/* Which airspaces the profiles plot, in the header of the chart it governs
	 * rather than two tabs away in Display. A segmented control, not an icon
	 * toggle: the bug is that the current mode was invisible, and two states of
	 * one icon keep it nearly so. Derived, never a module const, so it follows a
	 * locale switch (docs/i18n.md rule 2). */
	const scopeOptions = $derived([
		{ value: 'all', label: t.detail.profileScopeAll },
		{ value: 'map', label: t.detail.profileScopeMap },
	]);
</script>

<SurfaceShell {id} {onClose} label={title} boxClass="vertical-profile-box">
	{#snippet header()}
		<!-- The header carries the title, the one actionable figure, and what the
		 window left out; the window's own top and bottom are its labelled
		 gridlines and the ground is the terrain label, so neither is repeated
		 here. `subtitle` (the profiled point) is the first thing dropped when the
		 strip runs out of room. -->
		<h2>{title}</h2>
		<AirspaceAboveLine {above} {groundFt} compact />
		{#if windowNote}
			<p class="sub win" title={t.detail.profileWindowTip}>{windowNote}</p>
		{/if}
		{#if subtitle}
			<p class="sub pos">{subtitle}</p>
		{/if}
		<div class="controls no-print">
			<Segmented
				options={scopeOptions}
				value={display.profileAllAirspaces ? 'all' : 'map'}
				onSelect={(v) => setProfileAllAirspaces(v === 'all')}
				ariaLabel={t.detail.profileScopeAria}
				title={t.detail.profileScopeTip}
			/>
			<button
				class="modal-close"
				title={t.route.fitTip}
				aria-label={t.route.fitAria}
				onclick={fitReset}
			>
				<Icon name="maximize" />
			</button>
		</div>
	{/snippet}

	<div class="body">
		<div class="plot-row">
			{#if showSlider}
				<!-- Outside .scroll on purpose: inside, it would scroll away with a
				 chart wider than the box. Padded to the chart's own gutters, so the
				 handles line up with the GND line and the top gridline, and held to
				 the chart's OWN height: a chart wider than the box puts a horizontal
				 scrollbar inside .scroll, which its clientHeight (and so the chart)
				 excludes while the flex row does not. -->
				<div
					class="alt-slider no-print"
					style:height="{chartH}px"
					style:padding="{pads.padT}px 0 {pads.padB}px"
				>
					<RangeSlider
						orientation="vertical"
						min={bounds.minFt}
						max={bounds.maxFt}
						low={winFloorFt}
						high={winCeilingFt}
						minSpan={WINDOW_MIN_SPAN_FT}
						step={500}
						snap={50}
						format={levelLabel}
						ariaLow={t.route.sliderAltBottomAria}
						ariaHigh={t.route.sliderAltTopAria}
						onChange={onSliderWindow}
					/>
				</div>
			{/if}
			<!-- overflow-x: auto lets the SVG's intrinsic width drive horizontal
			 scrolling when the columns outnumber the measured width even at their
			 narrowest; the auto inline margin centres it when they do not. -->
			<div class="scroll" bind:clientWidth={boxW} bind:clientHeight={boxH}>
				<VerticalProfile
					columns={placed.drawn}
					{overlays}
					ceilingFt={winCeilingFt}
					floorFt={winFloorFt}
					{groundFt}
					{title}
					minColumnPx={colW}
					maxColumnPx={colW}
					heightPx={chartH}
					{showLabels}
					{onColumnClick}
					{onColumnHover}
					onZoom={applyZoom}
					onPan={applyPan}
					onFit={fitReset}
				/>
			</div>
		</div>
	</div>
</SurfaceShell>

<style>
	/* No flex-grow, so the subtitle reads as this title's caption instead of
	   being pushed to the far end of the header strip. The chrome's own
	   `overflow: hidden` (app.css) still lets a long title shrink and elide. */
	h2 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--text);
	}

	/* Caption lines beside the title. They elide rather than push the header's
	   pinned controls off a narrow surface, the way the shell treats the title
	   itself; the strip scrolls horizontally beyond that. */
	.sub {
		margin: 0;
		min-width: 0;
		overflow: hidden;
		font-size: 12px;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.win {
		cursor: help;
	}

	/* The header strip is the query container, so its own width decides what it
	   can hold. SCREEN ONLY: containment must never touch the print flow (the
	   app.css rule the surfaces' @container blocks all follow). The shell owns
	   the element, so a scoped rule cannot reach it; the boxClass hook can. */
	@media screen {
		:global(.vertical-profile-box .modal-header-main) {
			container-type: inline-size;
		}

		/* The point is on the map as the crosshair and in the right-click menu's
		   "Copy coordinates"; it is the header's least load-bearing line, so it
		   goes first rather than eliding everything beside it. */
		@container (max-width: 560px) {
			.pos {
				display: none;
			}
		}

		/* At a side dock's own floor even the title would elide, which reads as
		   broken where a dropped control does not: the scope stays one checkbox
		   away in the Display tab. */
		@container (max-width: 340px) {
			.controls :global(.seg) {
				display: none;
			}
		}
	}

	/* Pinned beside the scrolling header strip, the route profile's own shape. */
	.controls {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 6px;
	}

	.body {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-height: 0;
		padding: 12px 16px;
	}

	.plot-row {
		display: flex;
		flex: 1;
		min-height: 0;
	}

	/* The slider component's own padding is tuned to the route chart's gutters;
	   this call site pads the wrapper instead, from the live chart values, so the
	   handles sit on the gridlines whatever rows the plot reserves. */
	.alt-slider {
		display: flex;
		align-self: flex-start;
		box-sizing: border-box;
	}

	.alt-slider :global(.rslider.vertical) {
		padding: 0;
	}

	.scroll {
		flex: 1;
		min-width: 0;
		min-height: 0;
		overflow: auto;
	}

	/* The chart is a plain block at its intrinsic width; centre it when the
	   box is wider than the columns need. An overflowing chart has no free
	   space, so the auto margins resolve to 0 and nothing is clipped. */
	.scroll :global(svg) {
		margin-inline: auto;
	}
</style>
