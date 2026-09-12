<script lang="ts">
	/* The closed-form performance chart drawn as the manual's chained
	 * nomogram: a temperature panel with the pressure-altitude lines, a
	 * mass-guides panel (omitted for configs without a mass term) and a
	 * wind-guides panel (headwind solid, tailwind dashed), sharing the
	 * distance axis; the current conditions draw as the dashed reading path
	 * with the kink values labelled. SVG with theme variables, like
	 * CgEnvelopeChart. The result shown is the dry-paved figure; surface
	 * factors and the margin stay rows of the page table. */

	import type { ClosedFormConfig, ClosedFormPerformance } from '$lib/aircraft/schema';
	import type { PerfConditions } from '$lib/aircraft/performance';
	import { nomogramModel, niceStep, type NomogramMetric, type NomogramPoint } from '$lib/aircraft/performanceChart';
	import { t } from '$lib/state/i18n.svelte';

	interface Props {
		perf: ClosedFormPerformance;
		config: ClosedFormConfig;
		metric: NomogramMetric;
		conditions: PerfConditions | null;
	}

	const { perf, config, metric, conditions }: Props = $props();

	const model = $derived(nomogramModel(perf, config, metric, conditions));

	const W = 680;
	const H = 380;
	const PAD_L = 46;
	const PAD_R = 40;
	const PAD_T = 16;
	const PAD_B = 34;
	const GAP = 10;

	const innerH = H - PAD_T - PAD_B;
	const innerW = W - PAD_L - PAD_R;

	/** Panel x ranges: temp 46%, mass 27%, wind 27% (temp 60/40 without mass). */
	const panels = $derived.by(() => {
		const hasMass = model.massDomainLb !== null;
		const wTemp = innerW * (hasMass ? 0.46 : 0.58);
		const wMass = hasMass ? innerW * 0.27 - GAP : 0;
		const wWind = innerW - wTemp - (hasMass ? wMass + 2 * GAP : GAP);
		const x0 = PAD_L;
		const temp = { x0, x1: x0 + wTemp };
		const mass = hasMass ? { x0: temp.x1 + GAP, x1: temp.x1 + GAP + wMass } : null;
		const wind0 = (mass ? mass.x1 : temp.x1) + GAP;
		const wind = { x0: wind0, x1: wind0 + wWind };
		return { temp, mass, wind };
	});

	function y(m: number): number {
		const [lo, hi] = model.yDomain;
		return PAD_T + (1 - (m - lo) / (hi - lo)) * innerH;
	}

	const xTemp = $derived((t: number) => {
		const [t0, t1] = model.tempDomainC;
		const { x0, x1 } = panels.temp;
		return x0 + ((t - t0) / (t1 - t0)) * (x1 - x0);
	});

	const xMass = $derived((lb: number) => {
		const p = panels.mass;
		const d = model.massDomainLb;
		if (!p || !d) {
			return 0;
		}
		return p.x0 + ((lb - d[0]) / (d[1] - d[0])) * (p.x1 - p.x0);
	});

	const xWind = $derived((kt: number) => {
		// Reference (0 kt) at the left edge; headwind grows right, tailwind
		// is drawn on the same axis left of the head scale start.
		const { x0, x1 } = panels.wind;
		const span = model.windDomainKt[1] - model.windDomainKt[0];
		return x0 + ((kt - model.windDomainKt[0]) / span) * (x1 - x0);
	});

	function poly(points: NomogramPoint[], x: (v: number) => number): string {
		return points.map((p) => `${x(p.x).toFixed(1)},${y(p.m).toFixed(1)}`).join(' ');
	}

	const yTicks = $derived.by(() => {
		const [lo, hi] = model.yDomain;
		const step = niceStep(hi - lo, 6);
		const out: number[] = [];
		for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
			out.push(v);
		}
		return out;
	});

	const KG_TO_LB = 2.20462;
	const massTicksKg = $derived.by(() => {
		const d = model.massDomainLb;
		if (!d) {
			return [];
		}
		const kgHi = d[0] / KG_TO_LB;
		const kgLo = d[1] / KG_TO_LB;
		const out: number[] = [Math.round(kgHi)];
		for (let v = Math.floor(kgHi / 100) * 100; v >= kgLo; v -= 100) {
			// Skip ticks crowding the reference label at the panel edge.
			if (kgHi - v > 60) {
				out.push(v);
			}
		}
		return out;
	});

	const fmtM = (m: number) => `${Math.round(m)} m`;
	const pathD = $derived.by(() => {
		const p = model.path;
		if (!p) {
			return null;
		}
		const parts: string[] = [];
		const xT = xTemp(p.tempC);
		// Rise at the temperature to the PA interpolation, then across.
		parts.push(`M ${xT.toFixed(1)} ${(PAD_T + innerH).toFixed(1)} L ${xT.toFixed(1)} ${y(p.baseM).toFixed(1)}`);
		const massPanel = panels.mass;
		if (massPanel && p.massSeg.length > 0) {
			parts.push(`L ${massPanel.x0.toFixed(1)} ${y(p.baseM).toFixed(1)}`);
			parts.push(`L ${poly(p.massSeg, xMass).split(' ').join(' L ')}`);
		}
		parts.push(`L ${xWind(0).toFixed(1)} ${y(p.afterMassM).toFixed(1)}`);
		if (p.windSeg.length > 1) {
			parts.push(`L ${poly(p.windSeg, xWind).split(' ').join(' L ')}`);
		}
		parts.push(`L ${panels.wind.x1.toFixed(1)} ${y(p.exitM).toFixed(1)}`);
		return parts.join(' ');
	});
</script>

<figure class="nomogram">
	<svg viewBox="0 0 {W} {H}" role="img" aria-label={t.flightprep.nomogramAria}>
		<!-- y axis (distance, m) -->
		{#each yTicks as v (v)}
			<line class="grid" x1={PAD_L} y1={y(v)} x2={W - PAD_R} y2={y(v)} />
			<text class="tick" x={PAD_L - 6} y={y(v) + 3} text-anchor="end">{v}</text>
		{/each}
		<text class="axis" x={12} y={PAD_T + 8} transform="rotate(-90, 12, {PAD_T + 8})" text-anchor="end">
			{t.flightprep.axisDistanceM}
		</text>

		<!-- temperature panel: PA lines -->
		<rect class="frame" x={panels.temp.x0} y={PAD_T} width={panels.temp.x1 - panels.temp.x0} height={innerH} />
		{#each model.paLines as l (l.paFt)}
			<polyline class="pa" points={poly(l.points, xTemp)} />
			<text class="lbl" x={xTemp(model.tempDomainC[1]) - 4} y={y(l.points[1].m) - 4} text-anchor="end">
				{l.paFt === 0 ? t.flightprep.seaLevel : `${l.paFt} ft`}
			</text>
		{/each}
		{#each [-20, 0, 20, 40] as tc (tc)}
			<!-- The 40 sits on the panel edge: keep it inside, clear of the mass scale. -->
			<text class="tick" x={xTemp(tc)} y={PAD_T + innerH + 14} text-anchor={tc === 40 ? 'end' : 'middle'}>
				{tc}
			</text>
		{/each}
		<text class="axis" x={(panels.temp.x0 + panels.temp.x1) / 2} y={H - 6} text-anchor="middle">
			{t.flightprep.axisTempC}
		</text>

		<!-- mass panel -->
		{#if panels.mass && model.massDomainLb}
			<rect class="frame" x={panels.mass.x0} y={PAD_T} width={panels.mass.x1 - panels.mass.x0} height={innerH} />
			<line class="ref" x1={panels.mass.x0} y1={PAD_T} x2={panels.mass.x0} y2={PAD_T + innerH} />
			{#each model.massGuides as g, i (i)}
				<polyline class="guide" points={poly(g, xMass)} />
			{/each}
			{#each massTicksKg as kg, i (kg)}
				<!-- The reference mass sits on the panel edge: anchor it inward. -->
				<text
					class="tick"
					x={xMass(kg * KG_TO_LB)}
					y={PAD_T + innerH + 14}
					text-anchor={i === 0 ? 'start' : 'middle'}
				>
					{kg}
				</text>
			{/each}
			<text class="axis" x={(panels.mass.x0 + panels.mass.x1) / 2} y={H - 6} text-anchor="middle">
				{t.flightprep.axisMassKg}
			</text>
		{/if}

		<!-- wind panel -->
		<rect class="frame" x={panels.wind.x0} y={PAD_T} width={panels.wind.x1 - panels.wind.x0} height={innerH} />
		<line class="ref" x1={xWind(0)} y1={PAD_T} x2={xWind(0)} y2={PAD_T + innerH} />
		{#each model.headGuides as g, i (i)}
			<polyline class="guide" points={poly(g, xWind)} />
		{/each}
		{#each model.tailGuides as g, i (i)}
			<polyline class="guide tail" points={poly(g.map((p) => ({ ...p, x: -p.x })), xWind)} />
		{/each}
		{#each [-10, -5, 0, 5, 10, 15] as kt (kt)}
			<text
				class="tick"
				x={xWind(kt)}
				y={PAD_T + innerH + 14}
				text-anchor={kt === -10 ? 'start' : kt === 15 ? 'end' : 'middle'}
			>
				{kt}
			</text>
		{/each}
		<text class="axis" x={(panels.wind.x0 + panels.wind.x1) / 2} y={H - 6} text-anchor="middle">
			{t.flightprep.axisWindKt}
		</text>

		<!-- the reading path -->
		{#if model.path && pathD}
			<path class="path" d={pathD} />
			<circle class="kink" cx={xTemp(model.path.tempC)} cy={y(model.path.baseM)} r="3" />
			{#if panels.mass}
				<circle class="kink" cx={xMass(model.path.massLb)} cy={y(model.path.afterMassM)} r="3" />
			{/if}
			<circle class="kink" cx={xWind(model.path.windKt)} cy={y(model.path.exitM)} r="3" />
			<text class="value" x={xTemp(model.path.tempC) + 5} y={y(model.path.baseM) - 6}>
				{fmtM(model.path.baseM)}
			</text>
			{#if panels.mass && Math.abs(model.path.afterMassM - model.path.baseM) > 1}
				<text class="value" x={xMass(model.path.massLb) + 5} y={y(model.path.afterMassM) - 6}>
					{fmtM(model.path.afterMassM)}
				</text>
			{/if}
			<text class="value exit" x={W - PAD_R + 4} y={y(model.path.exitM) + 3}>
				{fmtM(model.path.exitM)}
			</text>
		{/if}
	</svg>
	<figcaption class="muted">
		{#if !model.path}
			{t.flightprep.chartOnly}
		{:else if model.path.clamped.length > 0}
			<span class="warn">
				{t.flightprep.beyondChart(
					model.path.clamped.map((c) => t.flightprep.clampTokens[c]).join(', '),
				)}
			</span>
		{:else}
			{t.flightprep.dryPavedNote}
		{/if}
	</figcaption>
</figure>

<style>
	.nomogram {
		margin: 0.4rem 0 0;
	}

	svg {
		width: 100%;
		height: auto;
		display: block;
	}

	@media print {
		/* Cap the chart so the fold (chart + caption + notes) always fits
		   one A4 landscape sheet (12 mm margins leave about 186 mm of
		   height; the cap keeps the 680x380 aspect at ~205 mm wide). */
		svg {
			width: auto;
			height: auto;
			max-width: 100%;
			max-height: 115mm;
			margin: 0 auto;
		}
	}

	.frame {
		fill: none;
		stroke: var(--border);
		stroke-width: 1;
	}

	.grid {
		stroke: var(--border);
		stroke-opacity: 0.45;
		stroke-width: 0.6;
	}

	.pa {
		fill: none;
		stroke: var(--text-muted);
		stroke-width: 1.4;
	}

	.guide {
		fill: none;
		stroke: var(--text-muted);
		stroke-opacity: 0.55;
		stroke-width: 0.9;
	}

	.guide.tail {
		stroke-dasharray: 4 3;
	}

	.ref {
		stroke: var(--text-muted);
		stroke-width: 1;
		stroke-dasharray: 7 3 1.5 3;
	}

	.path {
		fill: none;
		stroke: var(--accent);
		stroke-width: 1.8;
		stroke-dasharray: 6 4;
	}

	.kink {
		fill: var(--accent);
	}

	.tick {
		font-size: 9px;
		fill: var(--text-muted);
	}

	.lbl {
		font-size: 9px;
		fill: var(--text);
	}

	.axis {
		font-size: 10px;
		fill: var(--text-muted);
	}

	.value {
		font-size: 10px;
		font-weight: 600;
		fill: var(--accent);
	}

	.value.exit {
		font-size: 11px;
	}

	/* The caption carries class "muted" for the app-level colour; the
	   .nomogram hop keeps this size ahead of the workbook pages' 13px
	   .fp-page .muted, which reaches in here (this figure renders inside
	   the performance page). */
	.nomogram figcaption {
		font-size: 0.74rem;
		margin-top: 0.15rem;
	}

	/* Same orange as the page's extrapolation flags. */
	.warn {
		color: var(--workbook-orange);
	}
</style>
