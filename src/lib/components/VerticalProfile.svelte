<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	import { createPlotGestures } from '$lib/ui/plotGestures';
	import type { VerticalColumn, VerticalOverlay } from './verticalProfile';
	import {
		PAD_L,
		PAD_R,
		PAD_T,
		chartPads,
		overlayCoversWindow,
		windowTicks,
	} from './verticalProfile';

	interface Props {
		columns: VerticalColumn[];
		overlays: VerticalOverlay[];
		/** Upper bound of the Y axis in feet, from `profileWindow`. The caller
		 *  also passes only the columns `windowColumns` KEPT, so nothing is
		 *  silently squashed onto an edge; the primitive only renders. */
		ceilingFt: number;
		/** Lower bound of the Y axis in feet (0 = GND, the usual case). */
		floorFt?: number;
		title?: string;
		/** Minimum per-column pixel width. The intrinsic viewBox is sized
		 *  to `columns.length × minColumnPx + axis padding`; the parent
		 *  CSS decides whether to stretch the SVG (inline use) or let
		 *  it overflow horizontally (modal use). */
		minColumnPx?: number;
		/** Maximum per-column pixel width; columns won't stretch wider
		 *  than this regardless of available space, so a single-column
		 *  chart doesn't fill the panel. */
		maxColumnPx?: number;
		/** SVG intrinsic height in px. Inline use leaves the default
		 *  (compact, fits in the detail panel); the modal passes a
		 *  larger value (~3x) so the chart is easier to read. */
		heightPx?: number;
		/** Show the label row + class chips below the plot. Off by
		 *  default for the compact inline view (label row would eat
		 *  the plot height); on for the modal. */
		showLabels?: boolean;
		/** Fired when a column is clicked. The id matches the column's
		 *  `id` field; column-click semantics are the caller's call. */
		onColumnClick?: ((id: string) => void) | undefined;
		/** Fired when the pointer enters a column (passing its `id`) or
		 *  leaves it (passing null), so the caller can mirror the hover
		 *  elsewhere, e.g. flash the airspace on the map. */
		onColumnHover?: ((id: string | null) => void) | undefined;
		/** Ground elevation (ft AMSL) of the point this profile is over, or null.
		 *  When set, a terrain band + line is drawn up to it from the window
		 *  floor. */
		groundFt?: number | null;
		/** Scale the altitude window's span by `factor` (> 1 zooms out). A range
		 *  control: the caller anchors it at the window's own floor, so the
		 *  ground keeps the bottom of the frame and the ceiling is what moves;
		 *  the drag-pan and the slider are what take the window off the ground.
		 *  The chart only EMITS; the caller applies and clamps (the route
		 *  profile's ownership rule). Absent = no wheel zoom and the wheel keeps
		 *  its native scroll, which is what leaves the inline detail-panel chart
		 *  alone. */
		onZoom?: ((factor: number) => void) | undefined;
		/** Shift the altitude window by `dFt` (drag-pan, keyboard). Caller clamps. */
		onPan?: ((dFt: number) => void) | undefined;
		/** Back to the fitted window: double-click off a column, or Home. */
		onFit?: (() => void) | undefined;
	}
	const {
		columns,
		overlays,
		ceilingFt,
		floorFt = 0,
		title,
		minColumnPx = 6,
		maxColumnPx = 24,
		heightPx = 160,
		showLabels = false,
		onColumnClick,
		onColumnHover,
		groundFt = null,
		onZoom,
		onPan,
		onFit,
	}: Props = $props();

	// SVG layout: the gutters live in ./verticalProfile.ts, shared with the
	// surface that lines its altitude slider up with these gridlines. Width is
	// sized to the number of columns; the parent can stretch via `width: 100%`
	// (inline) or let intrinsic width drive horizontal scroll (modal).

	// Column width: distribute the minimum plot width over the columns,
	// clamped to [minColumnPx, maxColumnPx]. Few columns widen toward the
	// max instead of leaving the minimum-width plot mostly empty; many
	// columns floor at the min and let plotW grow (horizontal scroll in
	// the modal). Callers pinning min === max get exactly that width.
	const MIN_PLOT_W = 120;
	const colW = $derived(
		Math.max(minColumnPx, Math.min(maxColumnPx, MIN_PLOT_W / Math.max(1, columns.length))),
	);
	const gapPx = $derived(Math.max(1, Math.min(4, colW * 0.15)));
	const plotW = $derived(Math.max(MIN_PLOT_W, columns.length * colW));
	const width = $derived(PAD_L + plotW + PAD_R);

	// Optional label row below the plot when `showLabels` is on AND at least one
	// column actually has a label, else the shorter class-chip row when the
	// columns are wide enough for a chip to read. The rule is shared
	// (chartPads), so the surface's altitude slider pads to the same gutters.
	const hasLabels = $derived(
		showLabels &&
			columns.some((c) => c.shortLabel != null && c.shortLabel !== ''),
	);
	const hasBadges = $derived(
		colW - gapPx >= 16 &&
			columns.some((c) => c.badge != null && c.badge !== ''),
	);
	const PAD_B = $derived(chartPads(columns, { showLabels, colW }).padB);
	// `heightPx` is the total SVG height; PAD_B grows to host the optional
	// label row (or the shorter class-chip row), eating into the plot area.
	// The caller picks a larger heightPx (modal does ~3x inline) when it wants
	// a roomy plot even with the label row reserved.
	const HEIGHT = $derived(heightPx);
	const PLOT_H = $derived(HEIGHT - PAD_T - PAD_B);

	// When any column is flagged `highlight`, the rest dim so the focus
	// column (the selected airspace) stands out. No column sets it on the
	// NOTAM / map / aerodrome profiles, so they render unchanged.
	const someHighlight = $derived(columns.some((c) => c.highlight));

	// Window span, never zero: profileWindow enforces a minimum, and the guard
	// keeps a hand-built caller from dividing by it.
	const spanFt = $derived(Math.max(1, ceilingFt - floorFt));

	function yFt(ft: number): number {
		// Clamped, unlike route/routeProfile's yOf: this chart has no clip rect,
		// and windowColumns has already dropped whatever lies entirely outside the
		// window, so clamping IS the crop. It puts a crossing column's edge on the
		// frame, where the perforation marks it.
		const clamped = Math.max(floorFt, Math.min(ft, ceilingFt));
		return PAD_T + PLOT_H * (1 - (clamped - floorFt) / spanFt);
	}

	// Gridlines from the window's own SPAN (the shared rule, so the axis, the
	// rounding of the window top and the tests agree). A short chart thins the
	// ladder rather than overprinting its labels: ~16 px per label at 9 px.
	const ticks = $derived(
		windowTicks({ floorFt, ceilingFt }, Math.max(2, Math.floor(PLOT_H / 16))),
	);

	const placedColumns = $derived.by(() => {
		const drawW = colW - gapPx;
		// Airspaces start at the ground, not at sea level: an SFC/GND floor sits on
		// the terrain, so a column's floor is clamped up to groundFt (when known).
		// The same clamp windowColumns applies for its own decisions.
		const floorClamp = Math.max(groundFt ?? 0, 0);
		return columns.map((c, i) => {
			const lower = Math.max(c.knownExtent ? c.lowerFt : floorFt, floorClamp);
			// Upper never below the (clamped) floor: an airspace whose whole extent is
			// below the local ground collapses to a thin sliver on the ground line.
			const upper = Math.max(c.knownExtent ? c.upperFt : ceilingFt, lower);
			const y1 = yFt(upper);
			const y2 = yFt(lower);
			return {
				column: c,
				// topOpen alone still perforates, so a caller that skips
				// windowColumns keeps the published-UNL behaviour.
				cutTop: c.cutTop === true || c.topOpen === true,
				cutBottom: c.cutBottom === true,
				x: PAD_L + i * colW + gapPx / 2,
				w: drawW,
				y: y1,
				h: Math.max(2, y2 - y1),
			};
		});
	});

	function overlayBox(o: VerticalOverlay): { x: number; y: number; w: number; h: number } {
		const top = yFt(o.ceilingFt ?? ceilingFt);
		const bot = yFt(o.floorFt ?? floorFt);
		return { x: PAD_L, y: top, w: plotW, h: Math.max(1, bot - top) };
	}

	// An overlay spanning the whole window carries nothing: the altitude
	// filter's dashed outline would trace the plot frame (the window IS that
	// band in the common case) and a fill would cover everything. Decided here
	// rather than by the caller because the window is live: zooming out past the
	// band turns it back into a sub-band worth drawing.
	const shownOverlays = $derived(
		overlays.filter((o) => !overlayCoversWindow(o, { floorFt, ceilingFt })),
	);

	/* --- altitude-window gestures: wheel zoom + one-pointer drag-pan. The chart
	 * only EMITS (onZoom / onPan / onFit) and the surface applies + clamps
	 * through the pure zoomWindow / panWindow, the route profile's ownership
	 * rule. One axis carrying a datum at its floor, so the wheel needs neither
	 * an axis choice nor an anchor: the surface scales the span about the
	 * window's own floor, which keeps the ground where every column starts, and
	 * the terrain band with it, on the frame. Pinch stays off: the surface puts
	 * a two-handle slider beside this chart, and a vertical pinch in a 90 px
	 * dock is not a gesture anyone makes. --- */
	const interactive = $derived(onZoom != null || onPan != null);

	let svgEl = $state<SVGSVGElement>();
	let panning = $state(false);

	/* The shared slop-then-capture machine (ui/plotGestures.ts): one pointer,
	 * no pinch. This chart's own hooks: the y-only pan mapping, and the hover
	 * drop on engage, because capture retargets the compatibility mouse events
	 * to the svg, so a column panned over never gets its mouseleave and the
	 * map highlight would stick to whatever was under the press. */
	const gestures = createPlotGestures(
		{
			captureEl: () => svgEl,
			onPan: (_dxPx: number, dyPx: number) => emitPan(dyPx),
			onEngage: () => {
				panning = true;
				onColumnHover?.(null);
			},
			onSettle: () => {
				panning = false;
			},
		},
		// The middle button pans here too, so the gesture is one rule across
		// every profile chart; here it is redundant with the plain drag, and it
		// costs a line to keep them the same.
		{ middlePan: () => true },
	);

	function gestureWheel(e: WheelEvent): void {
		if (!onZoom) {
			return; // unwired mounts (the inline chart) keep native scrolling
		}
		const factor = gestures.wheel(e, !svgEl);
		if (factor !== null) {
			onZoom(factor);
		}
	}

	function gestureDown(e: PointerEvent): void {
		if (!onPan) {
			return;
		}
		if (gestures.down(e) && e.button === 1) {
			e.preventDefault(); // no middle-click autoscroll / paste under a plot
		}
	}
	function gestureMove(e: PointerEvent): void {
		gestures.move(e);
	}
	function gestureUp(e: PointerEvent): void {
		gestures.up(e);
	}
	function gestureLost(e: PointerEvent): void {
		gestures.lost(e);
	}

	// Client px to feet over the window span. NO minus: screen-y is already
	// inverted, so dragging DOWN raises the window and the grabbed altitude
	// follows the pointer (the route chart's minus belongs to its x axis).
	function emitPan(dyPx: number): void {
		if (!onPan || !svgEl || dyPx === 0) {
			return;
		}
		const rect = svgEl.getBoundingClientRect();
		const ky = rect.height > 0 ? HEIGHT / rect.height : 1;
		const dFt = (dyPx * ky * spanFt) / Math.max(1, PLOT_H);
		if (dFt !== 0) {
			onPan(dFt);
		}
	}

	// The columns own their clicks, so fit only from the plot background or the
	// axis gutter. Double-click + Home is the dock grip's own reset pair.
	function plotDblClick(e: MouseEvent): void {
		if (!onFit || (e.target as Element).closest('.column')) {
			return;
		}
		onFit();
	}

	/* Keyboard window control, acting ONLY while the svg itself holds focus: the
	 * columns are role="button" tabindex="0" and own Enter / Space, so a key
	 * pressed on a column has to fall through untouched. */
	function plotKeydown(e: KeyboardEvent): void {
		if (!interactive || e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) {
			return;
		}
		switch (e.key) {
			case 'ArrowUp':
				onPan?.(spanFt * 0.1);
				break;
			case 'ArrowDown':
				onPan?.(-spanFt * 0.1);
				break;
			case 'PageUp':
				onPan?.(spanFt);
				break;
			case 'PageDown':
				onPan?.(-spanFt);
				break;
			case '+':
			case '=':
				onZoom?.(1 / 1.25);
				break;
			case '-':
				onZoom?.(1.25);
				break;
			case 'Home':
				onFit?.();
				break;
			default:
				return;
		}
		e.preventDefault();
	}

	// Terrain draws only where there IS terrain in the window: with a raised
	// floor (a 10000-20000 ft filter) the ground is below the plot, and a band on
	// the bottom frame would claim the ground is at the window floor.
	const terrainFt = $derived(groundFt != null && groundFt > floorFt ? groundFt : null);
</script>

<!-- The tabindex is the point: on an interactive mount this chart IS a keyboard
 window control (arrows pan, +/- zoom, Home fits), and it has to be focusable to
 receive those keys. Its columns keep their own button semantics and their own
 Enter / Space; the handler here acts only while the svg itself holds focus. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<svg
	bind:this={svgEl}
	viewBox="0 0 {width} {HEIGHT}"
	preserveAspectRatio="xMidYMid meet"
	width={width}
	height={HEIGHT}
	class:interactive
	class:panning
	role={interactive ? 'group' : 'img'}
	aria-label={title ?? t.detail.altitudeProfile}
	tabindex={interactive ? 0 : undefined}
	onwheel={gestureWheel}
	onpointerdown={gestureDown}
	onpointermove={gestureMove}
	onpointerup={gestureUp}
	onpointercancel={gestureUp}
	onlostpointercapture={gestureLost}
	ondblclick={plotDblClick}
	onkeydown={plotKeydown}
>
	{#if terrainFt != null}
		<!-- Terrain ground: a band from the window floor up to the point's ground
		     elevation, behind the airspace columns. The line + label are drawn last
		     so they read over the columns. -->
		<rect
			class="terrain"
			x={PAD_L}
			y={yFt(terrainFt)}
			width={plotW}
			height={Math.max(0, yFt(floorFt) - yFt(terrainFt))}
		/>
	{/if}

	{#each ticks as t (t.ft)}
		<line
			x1={PAD_L}
			x2={PAD_L + plotW}
			y1={yFt(t.ft)}
			y2={yFt(t.ft)}
			class="grid"
		/>
		<text
			x={PAD_L - 4}
			y={yFt(t.ft) + 3}
			class="grid-label"
			text-anchor="end"
		>{t.label}</text>
	{/each}

	{#each shownOverlays as o, i (i)}
		{@const box = overlayBox(o)}
		<rect
			x={box.x}
			y={box.y}
			width={box.w}
			height={box.h}
			class={o.kind === 'fill' ? 'overlay-fill' : 'overlay-outline'}
			style:--overlay-color={o.color}
		>
			<title>{o.label}</title>
		</rect>
	{/each}

	{#each placedColumns as p, i (i)}
		{#if onColumnClick}
			<g
				class="column clickable"
				class:unknown={!p.column.knownExtent}
				class:highlight={p.column.highlight}
				class:dimmed={someHighlight && !p.column.highlight}
				style:--col-color={p.column.color}
				onclick={() => onColumnClick(p.column.id)}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						onColumnClick(p.column.id);
					}
				}}
				onmouseenter={() => onColumnHover?.(p.column.id)}
				onmouseleave={() => onColumnHover?.(null)}
				role="button"
				tabindex="0"
				aria-label={p.column.label}
			>
				<rect x={p.x} y={p.y} width={p.w} height={p.h} />
				{#if p.cutTop}
					<line class="open-edge" x1={p.x} x2={p.x + p.w} y1={p.y} y2={p.y} />
				{/if}
				{#if p.cutBottom}
					<line
						class="open-edge"
						x1={p.x}
						x2={p.x + p.w}
						y1={p.y + p.h}
						y2={p.y + p.h}
					/>
				{/if}
				<title>{p.column.label}</title>
			</g>
		{:else}
			<g
				class="column"
				class:unknown={!p.column.knownExtent}
				class:highlight={p.column.highlight}
				class:dimmed={someHighlight && !p.column.highlight}
				style:--col-color={p.column.color}
				onmouseenter={() => onColumnHover?.(p.column.id)}
				onmouseleave={() => onColumnHover?.(null)}
				role="img"
				aria-label={p.column.label}
			>
				<rect x={p.x} y={p.y} width={p.w} height={p.h} />
				{#if p.cutTop}
					<line class="open-edge" x1={p.x} x2={p.x + p.w} y1={p.y} y2={p.y} />
				{/if}
				{#if p.cutBottom}
					<line
						class="open-edge"
						x1={p.x}
						x2={p.x + p.w}
						y1={p.y + p.h}
						y2={p.y + p.h}
					/>
				{/if}
				<title>{p.column.label}</title>
			</g>
		{/if}
	{/each}

	{#if hasLabels}
		<!-- Label row beneath the plot. The vertical name reads
		 bottom-up. Width gate keeps narrow inline columns from
		 showing illegible micro-text. -->
		{#each placedColumns as p, i (i)}
			{#if p.column.shortLabel && p.w >= 12}
				{@const cx = p.x + p.w / 2}
				{@const cy = HEIGHT - 4}
				<text
					x={cx}
					y={cy}
					class="col-label"
					transform="rotate(-90 {cx} {cy})"
					text-anchor="start"
				>{p.column.shortLabel}</text>
			{/if}
		{/each}
	{/if}

	{#if hasBadges}
		<!-- Class chip centred at the TOP of the bottom row, just under the
		 GND line, so it shows for every column regardless of altitude range.
		 Drawn after the labels so it sits on top if a vertical name's top
		 edge runs into it. Same accent styling as .airspace-class in
		 AirspaceList. -->
		{#each placedColumns as p, i (i)}
			{#if p.column.badge && p.w >= 16}
				{@const bw = 16}
				{@const bh = 12}
				{@const bx = p.x + p.w / 2 - bw / 2}
				{@const by = HEIGHT - PAD_B + 4}
				<rect
					x={bx}
					y={by}
					width={bw}
					height={bh}
					rx={2}
					class="col-badge-bg"
					class:zone={p.column.badgeKind === 'zone'}
				/>
				<text
					x={bx + bw / 2}
					y={by + bh / 2 + 0.5}
					class="col-badge-text"
					text-anchor="middle"
					dominant-baseline="middle"
				>{p.column.badge}</text>
			{/if}
		{/each}
	{/if}

	{#if terrainFt != null}
		<line
			class="terrain-line"
			x1={PAD_L}
			x2={PAD_L + plotW}
			y1={yFt(terrainFt)}
			y2={yFt(terrainFt)}
		/>
		<text
			class="terrain-label"
			x={PAD_L + plotW - 2}
			y={yFt(terrainFt) - 3}
			text-anchor="end">{Math.round(terrainFt)} ft</text>
	{/if}
</svg>

<style>
	/* The chart keeps the intrinsic px width set on the width attribute: a
	 * `max-width: 100%` here would scale it down to its scroll container,
	 * defeating overflow-x. Callers that want it to follow a container size
	 * their columns from the measured box instead (VerticalProfileModal,
	 * detail/AltitudeProfile). */
	svg {
		display: block;
	}

	/* Interactive mount only (a surface, never the inline thumbnail).
	   touch-action is pan-x, NOT the route chart's `none`: this chart's scroll
	   container pans horizontally when the columns outnumber the box, so
	   horizontal touch panning stays with the browser while a vertical drag pans
	   the altitude window. The grab cursor is overridden per column by
	   .column.clickable, which is informative: the background pans, a column
	   navigates. */
	svg.interactive {
		user-select: none;
		touch-action: pan-x;
		cursor: grab;
	}

	svg.interactive.panning {
		cursor: grabbing;
	}

	svg.interactive:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.grid {
		stroke: var(--border);
		stroke-width: 1;
	}

	/* Terrain ground: same tan/brown as the route vertical profile. */
	.terrain {
		fill: var(--terrain-fill);
	}

	/* An edge the chart does not own: a published UNL ceiling, or a real limit
	 * outside the altitude window. Perforate it so the column reads as
	 * continuing past the frame rather than capped at it. One vocabulary for
	 * both facts; which one it is stays in the column's <title>, which states
	 * the published limits whatever the window does. */
	.open-edge {
		stroke: var(--surface);
		stroke-width: 2;
		stroke-dasharray: 3 3;
	}

	.terrain-line {
		stroke: var(--terrain-line);
		stroke-width: 1.5;
	}

	.terrain-label {
		font-size: 9px;
		font-weight: 600;
		fill: var(--terrain-line);
	}

	.grid-label {
		font-size: 9px;
		fill: var(--text-muted);
		font-family: ui-monospace, monospace;
	}

	/* `fill` overlay (e.g. NOTAM Q-line band) — translucent rect with
	 * a thin outline at low opacity. `pointer-events: all` makes the band
	 * hoverable for its <title> tooltip; columns paint on top, so this only
	 * catches the gaps between them and never blocks a column click. */
	.overlay-fill {
		fill: var(--overlay-color);
		fill-opacity: 0.12;
		stroke: var(--overlay-color);
		stroke-width: 0.75;
		stroke-opacity: 0.4;
		pointer-events: all;
	}

	/* `outline` overlay (e.g. altitude-filter band) — dashed outline,
	 * no fill, so it stays legible on top of a `fill` overlay.
	 * `pointer-events: all` (not the default `visiblePainted`, which would
	 * only catch the thin dashes) makes the whole band hoverable for its
	 * <title> tooltip. */
	.overlay-outline {
		fill: none;
		stroke: var(--overlay-color);
		stroke-width: 1;
		stroke-dasharray: 3 3;
		pointer-events: all;
	}

	.column rect {
		fill: var(--col-color);
		stroke: var(--col-color);
		fill-opacity: 0.7;
		stroke-width: 1;
		transition: fill-opacity 0.1s;
	}

	.column.clickable {
		cursor: pointer;
	}

	.column:hover rect {
		fill-opacity: 1;
	}

	.column.unknown rect {
		fill: none;
		stroke-dasharray: 3 2;
		stroke-opacity: 0.5;
	}

	/* Focus column (the selected airspace): solid accent outline at full
	 * opacity. The dimmed siblings drop to 0.3 so it reads as "this one".
	 * A dimmed column still brightens on hover via the rule above, so it
	 * stays previewable before a click. */
	.column.highlight rect {
		fill-opacity: 1;
		stroke: var(--accent);
		stroke-width: 2;
	}

	.column.dimmed rect {
		fill-opacity: 0.3;
	}

	/* Vertical short-label in the label row below the plot. Sits on
	 * the SVG background, so a single text colour works on both
	 * themes via the existing CSS var. pointer-events: none so the
	 * label can't intercept clicks bound for the column rect above. */
	.col-label {
		fill: var(--text);
		font-family: ui-monospace, monospace;
		font-size: 10px;
		font-weight: 600;
		pointer-events: none;
	}

	/* Class chip at the column's base. Mirrors .airspace-class from
	 * AirspaceList.svelte: accent-coloured background, accent-text
	 * (white) glyph. A thin white outline keeps the chip readable
	 * over any category colour underneath. */
	.col-badge-bg {
		fill: var(--accent);
		stroke: rgb(255 255 255 / 80%);
		stroke-width: 0.75;
		pointer-events: none;
	}

	/* R / D / P special-use zones: the same chip in the restricted-airspace
	 * red instead of the accent blue. The accent-text glyph keeps enough
	 * contrast on the red in both themes (it flips light/dark like --accent). */
	.col-badge-bg.zone {
		fill: var(--airspace-restricted);
	}

	.col-badge-text {
		fill: var(--accent-text);
		font-family: ui-monospace, monospace;
		font-size: 9px;
		font-weight: 700;
		pointer-events: none;
	}
</style>
