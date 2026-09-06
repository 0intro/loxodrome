<script lang="ts" module>
	import type { VLimit } from '$lib/vertical/limits';

	/** One NOTAM row of the stack: the notams-dataset index for the click
	 *  callback and the F)/G) extent (known=false renders the dash, the
	 *  unknown-extent convention). */
	export interface StackNotamRow {
		id: string;
		index: number;
		vLower: VLimit | null;
		vUpper: VLimit | null;
		known: boolean;
	}
</script>

<script lang="ts">
	/* The profile modals' right-click menu: the airspaces AND NOTAM bands
	 * under the cursor, one row each with swatch / class chip / name /
	 * limits, mirroring the map's ContextMenu and layered above the modal
	 * box. The caller owns the open state and assembles the rows (its
	 * containment test at the click point); this owns the backdrop, the
	 * viewport-clamped positioning and the chrome. Escape routes through
	 * the caller's SurfaceShell onEscape chain. */
	import { t } from '$lib/state/i18n.svelte';
	import { isZoneType } from '$lib/data/airspaces';
	import type { AirspaceCorridorBand } from '$lib/route/airspaces';
	import { formatVLimit } from '$lib/vertical/limits';

	interface Props {
		/** Airspace bands at the click, sorted floor-up by the caller. */
		bands: AirspaceCorridorBand[];
		notams?: StackNotamRow[];
		/** Empty result BELOW every charted floor at this distance: the
		 *  pilot's conclusion is Classe G, so the empty row says so. */
		belowCharted: boolean;
		/** Click position (viewport px); the menu flips / clamps around it. */
		x: number;
		y: number;
		onSelectBand: (key: string) => void;
		onSelectNotam?: (index: number) => void;
		/** Row hover highlights that band in the chart; NOTAM rows report
		 *  the chart's `notam:<id>` band key; null on leave. */
		onHoverBand: (key: string | null) => void;
		onClose: () => void;
	}
	const {
		bands,
		notams = [],
		belowCharted,
		x,
		y,
		onSelectBand,
		onSelectNotam,
		onHoverBand,
		onClose,
	}: Props = $props();

	let menuEl = $state<HTMLDivElement>();
	let pos = $state({ left: 0, top: 0 });

	// Position the menu at the cursor, flipping / clamping to the viewport
	// (mirrors ContextMenu).
	$effect(() => {
		if (!menuEl) {
			return;
		}
		const m = 4;
		const w = menuEl.offsetWidth;
		const h = menuEl.offsetHeight;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		let left = x;
		if (left + w > vw - m) {
			left = x - w;
		}
		left = Math.max(m, left);
		let top = y;
		if (top + h > vh - m) {
			top = y - h;
		}
		top = Math.max(m, top);
		pos = { left, top };
	});
</script>

<button
	class="ctx-backdrop no-print"
	aria-label={t.common.dismissMenu}
	onpointerdown={onClose}
	oncontextmenu={(e) => e.preventDefault()}
></button>
<div class="ctx-menu no-print" bind:this={menuEl} style="left:{pos.left}px;top:{pos.top}px">
	{#if bands.length === 0 && notams.length === 0}
		{#if belowCharted}
			<div class="ctx-empty" title={t.data.airspaceClasses.G}>{t.route.ctxClassG}</div>
		{:else}
			<div class="ctx-empty">{t.route.ctxNoAirspace}</div>
		{/if}
	{:else}
		{#if bands.length > 0}
			<div class="ctx-title">{t.route.ctxAirspaces(bands.length)}</div>
			{#each bands as b (b.key)}
				<button
					class="ctx-item"
					onclick={() => onSelectBand(b.key)}
					onmouseenter={() => onHoverBand(b.key)}
					onmouseleave={() => onHoverBand(null)}
				>
					<span class="ctx-swatch" style:background={`var(--airspace-${b.category})`}></span>
					{#if b.airClass}<span class="ctx-cls">{b.airClass}</span>{/if}
					{#if isZoneType(b.type)}
						<span
							class="ctx-zone"
							title={(t.data.airspaceTypes as Record<string, string>)[b.type] ?? b.type}
							>{b.type}</span
						>
					{:else}
						<span class="ctx-type">{b.type}</span>
					{/if}
					<span class="ctx-name">{b.name}</span>
					<span class="ctx-band">
						{#if b.vLower || b.vUpper}
							{formatVLimit(b.vLower) || '?'} – {formatVLimit(b.vUpper) || '?'}
						{:else}
							–
						{/if}
					</span>
				</button>
			{/each}
		{/if}
		{#if notams.length > 0}
			<div class="ctx-title">{t.route.ctxNotams(notams.length)}</div>
			{#each notams as nrow (nrow.id)}
				<button
					class="ctx-item"
					onclick={() => onSelectNotam?.(nrow.index)}
					onmouseenter={() => onHoverBand(`notam:${nrow.id}`)}
					onmouseleave={() => onHoverBand(null)}
				>
					<span class="ctx-swatch notam"></span>
					<span class="ctx-name">{nrow.id}</span>
					<span class="ctx-band">
						{#if nrow.known}
							{nrow.vLower ? formatVLimit(nrow.vLower) : 'SFC'} – {nrow.vUpper
								? formatVLimit(nrow.vUpper)
								: 'UNL'}
						{:else}
							–
						{/if}
					</span>
				</button>
			{/each}
		{/if}
	{/if}
</div>

<style>
	/* Layered above the modal box (z-index > 1100), the map ContextMenu's
	 * chrome. */
	.ctx-backdrop {
		position: fixed;
		inset: 0;
		z-index: 1101;
		padding: 0;
		border: none;
		background: transparent;
		cursor: default;
	}

	.ctx-menu {
		position: fixed;
		z-index: 1102;
		min-width: 240px;
		max-width: 360px;
		max-height: 60vh;
		overflow-y: auto;
		padding: 4px;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow-2);
	}

	.ctx-title {
		padding: 4px 8px 6px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.ctx-empty {
		padding: 6px 8px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.ctx-item {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 5px 8px;
		text-align: left;
		background: transparent;
		border: none;
		border-radius: 5px;
		cursor: pointer;
		color: var(--text);
	}

	.ctx-item:hover {
		background: var(--surface-3);
	}

	.ctx-swatch {
		flex: 0 0 auto;
		width: 10px;
		height: 10px;
		border-radius: 2px;
	}

	/* NOTAM rows: the map's area orange (fixed hex, like the band hatch). */
	.ctx-swatch.notam {
		background: #ff7800;
	}

	.ctx-type {
		font-weight: 600;
		font-size: 12px;
		color: var(--text-muted);
	}

	.ctx-cls,
	.ctx-zone {
		flex: 0 0 auto;
		min-width: 16px;
		padding: 1px 4px;
		font-size: 11px;
		font-weight: 700;
		text-align: center;
		color: var(--accent-text);
		border-radius: 3px;
	}

	.ctx-cls {
		background: var(--accent);
	}

	/* R / D / P special-use zones: the designator in the restricted red,
	 * mirroring the map ContextMenu and the vertical-profile column badge. */
	.ctx-zone {
		background: var(--airspace-restricted);
	}

	.ctx-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
	}

	.ctx-band {
		flex: 0 0 auto;
		font-size: 11px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
</style>
