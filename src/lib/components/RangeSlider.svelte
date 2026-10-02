<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	/* A two-handle range slider, vertical or horizontal, for the route profile's
	 * altitude and distance windows. Controlled: values come in as props, changes
	 * report via onChange. Pointer-drag + arrow-key nudge. Vertical maps high
	 * values to the top; horizontal maps low values to the left.
	 *
	 * The selected span is the window's thumb, so it is draggable too: grabbing
	 * it pans the window at a constant span, which is what makes this a
	 * scrollbar rather than a pair of bounds. It is the one pan affordance
	 * every pointer has, which the trace profile depends on (its plot's primary
	 * button belongs to the replay scrub; docs/route-profile.md). */

	interface Props {
		min: number;
		max: number;
		low: number;
		high: number;
		orientation?: 'vertical' | 'horizontal';
		/** Smallest allowed window (in value units). */
		minSpan?: number;
		/** Arrow-key nudge size. */
		step?: number;
		/** Drag snap granularity. */
		snap?: number;
		/** Value formatter for the drag bubble and aria-valuetext; absent =
		 *  no bubble (the handles stay bare). */
		format?: (v: number) => string;
		ariaLow?: string;
		ariaHigh?: string;
		onChange: (low: number, high: number) => void;
	}
	const {
		min,
		max,
		low,
		high,
		orientation = 'vertical',
		minSpan = 1,
		step = 1,
		snap = 1,
		format,
		ariaLow,
		ariaHigh,
		onChange,
	}: Props = $props();

	const vertical = $derived(orientation === 'vertical');
	let trackEl = $state<HTMLDivElement>();
	let active = $state<'low' | 'high' | null>(null);
	/** A live span drag: the pointer it owns, the press position along the
	 *  travel axis, and the window it started from (span held, so a parent that
	 *  re-clamps mid-drag cannot shrink it stride by stride). */
	let spanDrag = $state<{ id: number; from: number; low: number; span: number } | null>(null);

	const range = $derived(Math.max(1, max - min));
	/** value -> % along the track from its start (vertical start = top = max;
	 *  horizontal start = left = min). */
	const pos = (v: number): number =>
		vertical ? (1 - (v - min) / range) * 100 : ((v - min) / range) * 100;

	function snapV(v: number): number {
		return Math.round(v / snap) * snap;
	}
	function valueAt(e: PointerEvent): number {
		const el = trackEl;
		if (!el) {
			return min;
		}
		const r = el.getBoundingClientRect();
		const frac = vertical
			? (e.clientY - r.top) / Math.max(1, r.height)
			: (e.clientX - r.left) / Math.max(1, r.width);
		return snapV(min + (vertical ? 1 - frac : frac) * range);
	}
	function apply(which: 'low' | 'high', v: number): void {
		if (which === 'low') {
			onChange(Math.max(min, Math.min(v, high - minSpan)), high);
		} else {
			onChange(low, Math.min(max, Math.max(v, low + minSpan)));
		}
	}
	function down(which: 'low' | 'high', e: PointerEvent): void {
		active = which;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	function move(which: 'low' | 'high', e: PointerEvent): void {
		if (active === which) {
			apply(which, valueAt(e));
		}
	}
	function up(e: PointerEvent): void {
		active = null;
		(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
	}
	/** Travel-axis client px -> value delta, signed so the window follows the
	 *  pointer (vertical maps up the screen to higher values). */
	function deltaVal(px: number): number {
		const el = trackEl;
		if (!el) {
			return 0;
		}
		const r = el.getBoundingClientRect();
		const len = Math.max(1, vertical ? r.height : r.width);
		return ((vertical ? -px : px) * range) / len;
	}
	function spanDown(e: PointerEvent): void {
		if (e.button !== 0) {
			return;
		}
		spanDrag = {
			id: e.pointerId,
			from: vertical ? e.clientY : e.clientX,
			low,
			span: high - low,
		};
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	function spanMove(e: PointerEvent): void {
		const d = spanDrag;
		if (!d || e.pointerId !== d.id) {
			return;
		}
		// Snap the low bound so the span stays exact and the window still lands
		// on the grain the handles use.
		const raw = d.low + deltaVal((vertical ? e.clientY : e.clientX) - d.from);
		const lo = Math.max(min, Math.min(snapV(raw), max - d.span));
		// A window already against its bound does not move, and must not latch
		// the caller's touched flag (the applyPan / applyZoom rule).
		if (lo !== low) {
			onChange(lo, lo + d.span);
		}
	}
	function spanUp(e: PointerEvent): void {
		if (!spanDrag) {
			return;
		}
		spanDrag = null;
		(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
	}
	function key(which: 'low' | 'high', e: KeyboardEvent): void {
		// vertical: Up = +, Down = -. horizontal: Right = +, Left = -.
		const inc = vertical
			? e.key === 'ArrowUp'
				? 1
				: e.key === 'ArrowDown'
					? -1
					: 0
			: e.key === 'ArrowRight'
				? 1
				: e.key === 'ArrowLeft'
					? -1
					: 0;
		if (inc !== 0) {
			e.preventDefault();
			apply(which, (which === 'low' ? low : high) + inc * step);
		}
	}
</script>

<div class="rslider" class:vertical class:horizontal={!vertical}>
	<div class="track" bind:this={trackEl}>
		<!-- The window thumb: drawn before the handles, so where they overlap it
		 the handles still take the press. Not a tab stop (tabindex="-1"): the
		 keyboard pans through the two handles' arrows and the chart's own. -->
		{#if vertical}
			<button
				class="fill"
				class:panning={spanDrag !== null}
				style:top="{pos(high)}%"
				style:height="{pos(low) - pos(high)}%"
				tabindex="-1"
				aria-label={t.common.panWindow}
				onpointerdown={spanDown}
				onpointermove={spanMove}
				onpointerup={spanUp}
				onpointercancel={spanUp}
			></button>
		{:else}
			<button
				class="fill"
				class:panning={spanDrag !== null}
				style:left="{pos(low)}%"
				style:width="{pos(high) - pos(low)}%"
				tabindex="-1"
				aria-label={t.common.panWindow}
				onpointerdown={spanDown}
				onpointermove={spanMove}
				onpointerup={spanUp}
				onpointercancel={spanUp}
			></button>
		{/if}
		<button
			class="handle"
			class:active={active === 'high'}
			style:--pos="{pos(high)}%"
			role="slider"
			aria-label={ariaHigh ?? t.common.upperBound}
			aria-orientation={vertical ? 'vertical' : undefined}
			aria-valuemin={min}
			aria-valuemax={max}
			aria-valuenow={high}
			aria-valuetext={format ? format(high) : undefined}
			onpointerdown={(e) => down('high', e)}
			onpointermove={(e) => move('high', e)}
			onpointerup={up}
			onpointercancel={up}
			onkeydown={(e) => key('high', e)}
		></button>
		<button
			class="handle"
			class:active={active === 'low'}
			style:--pos="{pos(low)}%"
			role="slider"
			aria-label={ariaLow ?? t.common.lowerBound}
			aria-orientation={vertical ? 'vertical' : undefined}
			aria-valuemin={min}
			aria-valuemax={max}
			aria-valuenow={low}
			aria-valuetext={format ? format(low) : undefined}
			onpointerdown={(e) => down('low', e)}
			onpointermove={(e) => move('low', e)}
			onpointerup={up}
			onpointercancel={up}
			onkeydown={(e) => key('low', e)}
		></button>
		{#if active && format}
			{@const bubbleV = active === 'low' ? low : high}
			<!-- value bubble while dragging; keyboard nudges rely on aria-valuetext -->
			<div class="bubble" style:--pos="{pos(bubbleV)}%" aria-hidden="true">{format(bubbleV)}</div>
		{/if}
	</div>
</div>

<style>
	.rslider.vertical {
		display: flex;
		flex: 0 0 30px;
		width: 30px;
		min-width: 30px;
		align-items: stretch;
		justify-content: center;

		/* match the chart's PAD_T / PAD_B so the handles line up with the gridlines */
		padding: 28px 0 22px;
	}

	.rslider.horizontal {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		height: 28px;
		min-height: 28px;

		/* match the chart's PAD_L gutter / PAD_R margin */
		padding: 0 16px 0 46px;
	}

	.track {
		position: relative;
		background: var(--surface-3);
		border: 1px solid var(--border);
		border-radius: 3px;
	}

	.vertical .track {
		width: 6px;
	}

	.horizontal .track {
		width: 100%;
		height: 6px;
	}

	.fill {
		position: absolute;
		padding: 0;
		background: var(--accent);
		opacity: 0.3;
		border: none;
		border-radius: 3px;
		cursor: grab;
		touch-action: none;
	}

	.fill.panning {
		cursor: grabbing;
		opacity: 0.45;
	}

	.vertical .fill {
		left: 0;
		right: 0;
	}

	.horizontal .fill {
		top: 0;
		bottom: 0;
	}

	/* The thumb is only as thick as the 6 px track, so its grab area is bled
	   across the container's cross axis (the .handle::before idiom): 6 + 2 x 12
	   fills the 30 px slider, 6 + 2 x 17 the 40 px coarse one. Along the TRAVEL
	   axis the bar keeps its true extent (it states the window) while the grab
	   area has a floor, centred on it, the scrollbar rule: a profile whose
	   altitude track runs to a FL 660 band paints a window of a few pixels, and
	   a thumb thinner than the handles it sits between cannot be grabbed. */
	.fill::before {
		content: '';
		position: absolute;
	}

	.vertical .fill::before {
		top: 50%;
		right: -12px;
		left: -12px;
		height: 100%;
		min-height: 24px;
		transform: translateY(-50%);
	}

	.horizontal .fill::before {
		top: -12px;
		bottom: -12px;
		left: 50%;
		width: 100%;
		min-width: 24px;
		transform: translateX(-50%);
	}

	.handle {
		position: absolute;
		padding: 0;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		box-shadow: var(--shadow-1);
		cursor: grab;
		touch-action: none;
	}

	.vertical .handle {
		top: var(--pos);
		left: 50%;
		width: 18px;
		height: 14px;
		transform: translate(-50%, -50%);
	}

	.horizontal .handle {
		left: var(--pos);
		top: 50%;
		width: 14px;
		height: 18px;
		transform: translate(-50%, -50%);
	}

	/* Bigger grab area in flight. Only the cross axis grows (vertical slider
	   -> width, horizontal -> height); the travel-axis padding that aligns
	   the handles to the chart gridlines is left untouched. Keyed off the
	   touch-ui class rather than a media query, like every other in-flight
	   control: the replay transport and the level band are dragged while
	   recording, on whatever pointer is attached. 44px, not the 40 this
	   block used to stop at: the app's touch floor is one number. */
	:global(:root.touch-ui) .rslider.vertical {
		flex-basis: 44px;
		width: 44px;
		min-width: 44px;
	}

	:global(:root.touch-ui) .vertical .handle {
		width: 34px;
		height: 22px;
	}

	:global(:root.touch-ui) .rslider.horizontal {
		height: 44px;
		min-height: 44px;
	}

	:global(:root.touch-ui) .horizontal .handle {
		width: 22px;
		height: 34px;
	}

	:global(:root.touch-ui) .vertical .fill::before {
		right: -17px;
		left: -17px;
		min-height: 34px;
	}

	:global(:root.touch-ui) .horizontal .fill::before {
		top: -17px;
		bottom: -17px;
		min-width: 34px;
	}

	/* grip lines across the drag axis */
	.handle::before {
		content: '';
		position: absolute;
	}

	.vertical .handle::before {
		inset: 4px 3px;
		border-top: 1px solid var(--text-muted);
		border-bottom: 1px solid var(--text-muted);
	}

	.horizontal .handle::before {
		inset: 3px 4px;
		border-left: 1px solid var(--text-muted);
		border-right: 1px solid var(--text-muted);
	}

	.handle:hover,
	.handle.active {
		border-color: var(--accent);
	}

	.handle.active {
		cursor: grabbing;
	}

	.handle:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	/* Value bubble beside the active handle: vertical slider floats it right
	   over the plot edge, horizontal above the track. */
	.bubble {
		position: absolute;
		z-index: 1;
		padding: 2px 6px;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		box-shadow: var(--shadow-1);
		pointer-events: none;
	}

	.vertical .bubble {
		top: var(--pos);
		left: calc(100% + 10px);
		transform: translateY(-50%);
	}

	.horizontal .bubble {
		left: var(--pos);
		bottom: calc(100% + 10px);
		transform: translateX(-50%);
	}
</style>
