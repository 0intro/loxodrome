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
	 * points draw in the danger colour. Point labels get a small vertical
	 * de-collision pass so stacked points stay readable. */

	import type { EnvelopePoint } from '$lib/aircraft/schema';
	import { t } from '$lib/state/i18n.svelte';

	interface Props {
		envelope: EnvelopePoint[];
		points: CgPoint[];
		travel?: { armM: number; massKg: number }[];
		heightPx?: number;
	}

	const { envelope, points, travel = [], heightPx = 300 }: Props = $props();

	const W = 480;
	const PAD_L = 50;
	const PAD_R = 14;
	const PAD_T = 12;
	const PAD_B = 30;

	const extents = $derived.by(() => {
		const arms = [...envelope.map((p) => p.armM), ...points.map((p) => p.armM)];
		const masses = [...envelope.map((p) => p.massKg), ...points.map((p) => p.massKg)];
		const a0 = Math.min(...arms);
		const a1 = Math.max(...arms);
		const m0 = Math.min(...masses);
		const m1 = Math.max(...masses);
		const aPad = (a1 - a0 || 0.1) * 0.08;
		const mPad = (m1 - m0 || 100) * 0.08;
		return { a0: a0 - aPad, a1: a1 + aPad, m0: m0 - mPad, m1: m1 + mPad };
	});

	const innerW = $derived(W - PAD_L - PAD_R);
	const innerH = $derived(heightPx - PAD_T - PAD_B);

	function x(armM: number): number {
		const { a0, a1 } = extents;
		return PAD_L + ((armM - a0) / (a1 - a0)) * innerW;
	}

	function y(massKg: number): number {
		const { m0, m1 } = extents;
		return PAD_T + (1 - (massKg - m0) / (m1 - m0)) * innerH;
	}

	/** A nice 1/2/5 step covering the span with ~n ticks. */
	function niceStep(span: number, n: number): number {
		const raw = span / n;
		const mag = 10 ** Math.floor(Math.log10(raw));
		for (const m of [1, 2, 5, 10]) {
			if (raw <= m * mag) {
				return m * mag;
			}
		}
		return 10 * mag;
	}

	function ticks(lo: number, hi: number, n: number): number[] {
		const step = niceStep(hi - lo, n);
		const out: number[] = [];
		for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
			out.push(v);
		}
		return out;
	}

	const armTicks = $derived(ticks(extents.a0, extents.a1, 6));
	const massTicks = $derived(ticks(extents.m0, extents.m1, 5));

	const envelopePath = $derived(
		envelope.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.armM).toFixed(1)},${y(p.massKg).toFixed(1)}`).join(' ') + ' Z',
	);

	const travelPath = $derived(
		travel.length > 1
			? travel.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.armM).toFixed(1)},${y(p.massKg).toFixed(1)}`).join(' ')
			: '',
	);

	// Labels right of their dot, pushed apart vertically when they collide.
	const placedLabels = $derived.by(() => {
		const items = points
			.map((p) => ({ p, lx: x(p.armM) + 8, ly: y(p.massKg) + 4 }))
			.sort((a, b) => a.ly - b.ly);
		for (let i = 1; i < items.length; i++) {
			if (items[i].ly - items[i - 1].ly < 13) {
				items[i].ly = items[i - 1].ly + 13;
			}
		}
		return items;
	});

	function fmtArmTick(v: number): string {
		return v.toFixed(2);
	}
</script>

<svg viewBox="0 0 {W} {heightPx}" class="cg-chart" role="img" aria-label={t.flightprep.cgEnvelope}>
	<!-- gridlines + axis labels -->
	{#each massTicks as tick (tick)}
		<line class="grid" x1={PAD_L} y1={y(tick)} x2={W - PAD_R} y2={y(tick)} />
		<text class="tick" x={PAD_L - 6} y={y(tick) + 3} text-anchor="end">{Math.round(tick)}</text>
	{/each}
	{#each armTicks as tick (tick)}
		<line class="grid" x1={x(tick)} y1={PAD_T} x2={x(tick)} y2={heightPx - PAD_B} />
		<text class="tick" x={x(tick)} y={heightPx - PAD_B + 14} text-anchor="middle">{fmtArmTick(tick)}</text>
	{/each}
	<text class="axis" x={PAD_L + innerW / 2} y={heightPx - 4} text-anchor="middle">
		{t.flightprep.armM}
	</text>
	<text class="axis" transform="rotate(-90 12 {PAD_T + innerH / 2})" x="12" y={PAD_T + innerH / 2} text-anchor="middle">
		{t.flightprep.massKg}
	</text>

	<!-- the certified envelope -->
	<path class="envelope" d={envelopePath} />

	<!-- fuel-burn CG travel -->
	{#if travelPath}
		<path class="travel" d={travelPath} />
	{/if}

	<!-- points + de-collided labels -->
	{#each points as p (p.label)}
		<circle class="pt" class:out={p.out} cx={x(p.armM)} cy={y(p.massKg)} r="4" />
	{/each}
	{#each placedLabels as item (item.p.label)}
		<text class="pt-label" class:out={item.p.out} x={item.lx} y={item.ly}>{item.p.label}</text>
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
	}

	.pt-label.out {
		fill: var(--danger);
		font-weight: 600;
	}
</style>
