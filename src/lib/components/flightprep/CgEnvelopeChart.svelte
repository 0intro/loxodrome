<script lang="ts" module>
	export interface CgPoint {
		label: string;
		armM: number;
		massKg: number;
		out?: boolean | undefined;
	}
</script>

<script lang="ts">
	/* The CG envelope ("centrogramme"): the certified polygon in the
	 * (arm, mass) plane with the takeoff / landing / zero-fuel points and the
	 * fuel-burn CG travel line. SVG with theme variables; out-of-envelope
	 * points draw in the danger colour. The scale and the label placement are
	 * cgChart.ts: a label goes right of its dot when it fits, else left of it,
	 * and the stack stays inside the plot. */

	import type { EnvelopePoint } from '$lib/aircraft/schema';
	import { t } from '$lib/state/i18n.svelte';
	import { CG_PAD, CG_W, cgLabelBox, cgScale, placeCgLabels } from './cgChart';

	interface Props {
		envelope: EnvelopePoint[];
		points: CgPoint[];
		travel?: { armM: number; massKg: number }[];
		heightPx?: number;
	}

	const { envelope, points, travel = [], heightPx = 300 }: Props = $props();

	const scale = $derived(cgScale(envelope, points, heightPx));

	const envelopePath = $derived(
		envelope
			.map((p, i) => `${i === 0 ? 'M' : 'L'}${scale.x(p.armM).toFixed(1)},${scale.y(p.massKg).toFixed(1)}`)
			.join(' ') + ' Z',
	);

	const travelPath = $derived(
		travel.length > 1
			? travel
					.map((p, i) => `${i === 0 ? 'M' : 'L'}${scale.x(p.armM).toFixed(1)},${scale.y(p.massKg).toFixed(1)}`)
					.join(' ')
			: '',
	);

	const placedLabels = $derived.by(() => {
		const placed = placeCgLabels(
			points.map((p) => ({ x: scale.x(p.armM), y: scale.y(p.massKg), text: p.label })),
			cgLabelBox(heightPx),
		);
		return points.map((p, i) => ({ p, ...placed[i] }));
	});

	function fmtArmTick(v: number): string {
		return v.toFixed(2);
	}
</script>

<svg viewBox="0 0 {CG_W} {heightPx}" class="cg-chart" role="img" aria-label={t.flightprep.cgEnvelope}>
	<!-- gridlines + axis labels -->
	{#each scale.massTicks as tick (tick)}
		<line class="grid" x1={CG_PAD.left} y1={scale.y(tick)} x2={CG_W - CG_PAD.right} y2={scale.y(tick)} />
		<text class="tick" x={CG_PAD.left - 6} y={scale.y(tick) + 3} text-anchor="end">{Math.round(tick)}</text>
	{/each}
	{#each scale.armTicks as tick (tick)}
		<line class="grid" x1={scale.x(tick)} y1={CG_PAD.top} x2={scale.x(tick)} y2={heightPx - CG_PAD.bottom} />
		<text class="tick" x={scale.x(tick)} y={heightPx - CG_PAD.bottom + 14} text-anchor="middle">{fmtArmTick(tick)}</text>
	{/each}
	<text class="axis" x={CG_PAD.left + scale.innerW / 2} y={heightPx - 4} text-anchor="middle">
		{t.flightprep.armM}
	</text>
	<text
		class="axis"
		transform="rotate(-90 12 {CG_PAD.top + scale.innerH / 2})"
		x="12"
		y={CG_PAD.top + scale.innerH / 2}
		text-anchor="middle"
	>
		{t.flightprep.massKg}
	</text>

	<!-- the certified envelope -->
	<path class="envelope" d={envelopePath} />

	<!-- fuel-burn CG travel -->
	{#if travelPath}
		<path class="travel" d={travelPath} />
	{/if}

	<!-- points + placed labels -->
	{#each points as p (p.label)}
		<circle class="pt" class:out={p.out} cx={scale.x(p.armM)} cy={scale.y(p.massKg)} r="4" />
	{/each}
	{#each placedLabels as item (item.p.label)}
		<text class="pt-label" class:out={item.p.out} x={item.x} y={item.y} text-anchor={item.anchor}>{item.p.label}</text>
	{/each}
</svg>

<style>
	.cg-chart {
		display: block;
		width: 100%;
		height: auto;
		font-family: inherit;
	}

	.grid {
		stroke: var(--border);
		stroke-width: 0.5;
	}

	.tick {
		font-size: 9px;
		fill: var(--text-muted);
	}

	.axis {
		font-size: 10px;
		fill: var(--text-muted);
	}

	.envelope {
		fill: var(--accent);
		fill-opacity: 0.08;
		stroke: var(--accent);
		stroke-width: 1.5;
	}

	.travel {
		fill: none;
		stroke: var(--text-muted);
		stroke-width: 1;
		stroke-dasharray: 4 3;
	}

	.pt {
		fill: var(--accent);
		stroke: var(--surface);
		stroke-width: 1;
	}

	.pt.out {
		fill: var(--danger);
	}

	.pt-label {
		font-size: 10px;
		fill: var(--text);

		/* A halo in the surface colour, so a label stays legible where it
		   crosses the envelope's edge or the travel line. */
		paint-order: stroke;
		stroke: var(--surface);
		stroke-width: 3px;
		stroke-linejoin: round;
	}

	.pt-label.out {
		fill: var(--danger);
		font-weight: 600;
	}
</style>
