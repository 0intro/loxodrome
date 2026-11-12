<script lang="ts">
	/* The CG envelope ("centrogramme"): the certified polygon in the
	 * (arm, mass) plane with the takeoff / landing / zero-fuel points and the
	 * fuel-burn CG travel line of one trip. SVG with theme variables.
	 * A takeoff draws as a filled dot, a landing as a hollow one, a zero-fuel
	 * point as a square; a point out of the envelope takes the danger ink, a
	 * ring and a bold label, so it reads on a black-and-white printer too.
	 * The scale, the points of a trip and the label placement are cgChart.ts:
	 * a label goes right of its dot when it fits, else left, and the stack
	 * stays inside the plot. A plan of several trips draws one chart per trip
	 * on SHARED axes (`scalePoints`: every trip's points), so a point near a
	 * limit looks near it on every chart. */

	import type { EnvelopePoint } from '$lib/aircraft/schema';
	import { t } from '$lib/state/i18n.svelte';
	import { CG_PAD, CG_W, cgLabelBox, cgScale, placeCgLabels, type CgPoint } from './cgChart';

	interface Props {
		envelope: EnvelopePoint[];
		points: CgPoint[];
		/** The burn line. */
		travel?: { armM: number; massKg: number }[][];
		/** Mass limits drawn as dashed lines across the plot (a maximum
		 *  landing mass), each labelled at its right end. */
		limits?: { massKg: number; label: string }[];
		heightPx?: number;
		/** More points the axes cover besides the envelope, the limits and
		 *  the chart's own: every trip's, for charts that share their axes. */
		scalePoints?: { armM: number; massKg: number }[] | undefined;
		/** The image's name; absent, "CG envelope". */
		ariaLabel?: string | undefined;
	}

	const { envelope, points, travel = [], limits = [], heightPx = 300, scalePoints, ariaLabel }: Props = $props();

	const scale = $derived(
		cgScale(
			envelope,
			[
				...points,
				...(scalePoints ?? []),
				...limits.map((l) => ({ armM: envelope[0]?.armM ?? 0, massKg: l.massKg })),
			],
			heightPx,
		),
	);

	const envelopePath = $derived(
		envelope
			.map((p, i) => `${i === 0 ? 'M' : 'L'}${scale.x(p.armM).toFixed(1)},${scale.y(p.massKg).toFixed(1)}`)
			.join(' ') + ' Z',
	);

	const travelPaths = $derived(
		travel
			.filter((line) => line.length > 1)
			.map((line) =>
				line
					.map((p, i) => `${i === 0 ? 'M' : 'L'}${scale.x(p.armM).toFixed(1)},${scale.y(p.massKg).toFixed(1)}`)
					.join(' '),
			),
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

<svg viewBox="0 0 {CG_W} {heightPx}" class="cg-chart" role="img" aria-label={ariaLabel ?? t.flightprep.cgEnvelope}>
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

	<!-- mass limits below the envelope's top -->
	{#each limits as limit (limit.label)}
		<line
			class="limit"
			x1={CG_PAD.left}
			y1={scale.y(limit.massKg)}
			x2={CG_W - CG_PAD.right}
			y2={scale.y(limit.massKg)}
		/>
		<text class="limit-label" x={CG_W - CG_PAD.right - 2} y={scale.y(limit.massKg) - 3} text-anchor="end">
			{limit.label}
		</text>
	{/each}

	<!-- fuel-burn CG travel -->
	{#each travelPaths as d, i (i)}
		<path class="travel" {d} />
	{/each}

	<!-- points + placed labels -->
	{#each points as p (p.id)}
		{@const x = scale.x(p.armM)}
		{@const y = scale.y(p.massKg)}
		{#if p.out}
			<circle class="ring" cx={x} cy={y} r="7" />
		{/if}
		{#if p.kind === 'zeroFuel'}
			<rect class="pt" class:out={p.out} x={x - 3.5} y={y - 3.5} width="7" height="7" />
		{:else}
			<circle class="pt" class:hollow={p.kind === 'landing'} class:out={p.out} cx={x} cy={y} r="4" />
		{/if}
	{/each}
	{#each placedLabels as item (item.p.id)}
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

	.pt.hollow {
		fill: var(--surface);
		stroke: var(--accent);
		stroke-width: 1.5;
	}

	.pt.out {
		fill: var(--danger);
	}

	.pt.hollow.out {
		fill: var(--surface);
		stroke: var(--danger);
	}

	/* An out-of-envelope point's own mark, besides its ink: a ring, so it
	   stands out on paper printed in black and white. */
	.ring {
		fill: none;
		stroke: var(--danger);
		stroke-width: 1.5;
	}

	.limit {
		stroke: var(--accent);
		stroke-width: 1;
		stroke-dasharray: 6 3;
	}

	.limit-label {
		font-size: 9px;
		fill: var(--accent);
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
