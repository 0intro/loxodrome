<script lang="ts">
	/* The performance model: shared safety factors, then either the POH
	 * table kind (mass anchors, headwind factor tables, the two distance
	 * grids) or the closed-form kind (reference mass + fitted flap
	 * configs). The two shapes do not map onto each other, so switching
	 * kind means removing the section and adding the other one. */

	import Icon from '../Icon.svelte';
	import PerfGridEditor from './PerfGridEditor.svelte';
	import WindAnchorsEditor from './WindAnchorsEditor.svelte';
	import ClosedFormConfigCard from './ClosedFormConfigCard.svelte';
	import {
		blankClosedFormConfigDraft,
		blankClosedFormPerformanceDraft,
		blankTablePerformanceDraft,
		decimalStep,
		referenceFigures,
		type AircraftDraft,
		type ClosedFormConfigDraft,
		type ClosedFormPerformanceDraft,
	} from '$lib/aircraft/edit';
	import type { AircraftPerformance } from '$lib/aircraft/schema';
	import { t } from '$lib/state/i18n.svelte';

	let {
		draft = $bindable(),
		validPerformance,
	}: {
		draft: AircraftDraft;
		/** The schema-validated performance when the whole draft parses. */
		validPerformance: AircraftPerformance | null;
	} = $props();

	const figures = $derived(validPerformance ? referenceFigures(validPerformance) : null);

	let addKind = $state<'table' | 'closed-form'>('table');

	// A script-level alias for the closed-form branch: template {@const}
	// aliases defeat typescript-eslint's type resolution inside each blocks.
	const cf = $derived(draft.performance?.kind === 'closed-form' ? draft.performance : null);

	function v(e: Event): string {
		return (e.target as HTMLInputElement).value;
	}

	/* The schema defaults (aircraft/schema.ts) an empty factor box shows as its
	 * gray placeholder, which the spinner also anchors on (ui/numberStepAnchor).
	 * The step reads the value SHOWN, so an empty box steps exactly as the same
	 * number typed does; decimalStep('') alone would step it by a whole 1. */
	const DEFAULTS = { margin: '1.3', grass: '1.15', wet: '1.15', tailwind: '10' };

	function addSection(): void {
		draft.performance = addKind === 'table' ? blankTablePerformanceDraft() : blankClosedFormPerformanceDraft();
	}

	/** Checking a config's default clears its same-phase siblings. */
	function setDefault(p: ClosedFormPerformanceDraft, target: ClosedFormConfigDraft, on: boolean): void {
		if (!on) {
			target.isDefault = false;
			return;
		}
		for (const c of p.configs) {
			if (c.phase === target.phase) {
				c.isDefault = c === target;
			}
		}
	}
</script>

<div class="page">
	{#if draft.performance}
		{@const p = draft.performance}
		<div class="sect-head">
			<h4>{t.aircraft.perfTitle(p.kind === 'table' ? t.aircraft.kindTable : t.aircraft.kindClosedForm)}</h4>
			<button class="link-btn" onclick={() => (draft.performance = null)}>{t.aircraft.removeSection}</button>
		</div>
		<section class="card">
			<h5>{t.aircraft.safetyFactors}</h5>
			<div class="factors">
				<label class="field">
					<span>{t.aircraft.margin}</span>
					<input class="num" type="number" min="0.01" step={decimalStep(p.marginFactor || DEFAULTS.margin)} value={p.marginFactor} placeholder={DEFAULTS.margin} oninput={(e) => (p.marginFactor = v(e))} />
				</label>
				<label class="field">
					<span>{t.aircraft.grass}</span>
					<input class="num" type="number" min="0.01" step={decimalStep(p.grassFactor || DEFAULTS.grass)} value={p.grassFactor} placeholder={DEFAULTS.grass} oninput={(e) => (p.grassFactor = v(e))} />
				</label>
				<label class="field">
					<span>{t.aircraft.wet}</span>
					<input class="num" type="number" min="0.01" step={decimalStep(p.wetFactor || DEFAULTS.wet)} value={p.wetFactor} placeholder={DEFAULTS.wet} oninput={(e) => (p.wetFactor = v(e))} />
				</label>
				<label class="field" title={t.aircraft.flaplessLandingTip}>
					<span>{t.aircraft.flaplessLanding}</span>
					<input class="num" type="number" min="0.01" step={decimalStep(p.flaplessLandingFactor)} value={p.flaplessLandingFactor} placeholder="—" oninput={(e) => (p.flaplessLandingFactor = v(e))} />
				</label>
			</div>
			<p class="hint">{t.aircraft.factorsHint}</p>
		</section>
		<section class="card">
			<h5>{t.aircraft.referenceFigures}</h5>
			{#if figures}
				<table class="etable">
					<thead>
						<tr>
							<th>{t.aircraft.phase}</th>
							<th class="numeric">{t.aircraft.rollM}</th>
							<th class="numeric">{t.aircraft.d15M}</th>
						</tr>
					</thead>
					<tbody>
						{#each figures.rows as row (row.phase)}
							<tr class:warn={row.extrapolated}>
								<td>
									{row.phase === 'takeoff' ? t.aircraft.takeoff : t.aircraft.landing}{row.flapsDeg == null
										? ''
										: t.aircraft.flapsSuffix(row.flapsDeg)}
								</td>
								<td class="numeric">{Math.round(row.rollM)}</td>
								<td class="numeric">{Math.round(row.d15M)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="hint">
					{t.aircraft.refFiguresHint(
						`${Math.round(figures.massKg)} kg${figures.massLb == null ? '' : ` (${figures.massLb} lb)`}`,
					)}
				</p>
			{:else}
				<p class="hint">{t.aircraft.refFiguresPending}</p>
			{/if}
		</section>
		{#if p.kind === 'table'}
			<section class="card">
				<h5>{t.aircraft.massAnchors}</h5>
				<div class="factors">
					<label class="field">
						<span>{t.aircraft.maxMass}</span>
						<input class="num" type="number" min="1" step={decimalStep(p.massMaxKg)} value={p.massMaxKg} oninput={(e) => (p.massMaxKg = v(e))} />
						<span class="unit">kg</span>
					</label>
					<label class="field">
						<span>{t.aircraft.minMass}</span>
						<input class="num" type="number" min="1" step={decimalStep(p.massMinKg)} value={p.massMinKg} oninput={(e) => (p.massMinKg = v(e))} />
						<span class="unit">kg</span>
					</label>
				</div>
				<p class="hint">{t.aircraft.massAnchorsHint}</p>
			</section>
			<section class="card">
				<h5>{t.aircraft.wind}</h5>
				<div class="wind-cols">
					<WindAnchorsEditor bind:anchors={p.takeoffHeadwind} title={t.aircraft.takeoffHeadwindFactors} />
					<WindAnchorsEditor bind:anchors={p.landingHeadwind} title={t.aircraft.landingHeadwindFactors} />
				</div>
				<label class="field" title={t.aircraft.tailwindTip}>
					<span>{t.aircraft.tailwind}</span>
					<input class="num" type="number" min="0.01" step={decimalStep(p.tailwindPctPer2Kt || DEFAULTS.tailwind)} value={p.tailwindPctPer2Kt} placeholder={DEFAULTS.tailwind} oninput={(e) => (p.tailwindPctPer2Kt = v(e))} />
					<span class="unit">{t.aircraft.pctPer2Kt}</span>
				</label>
			</section>
			<section class="card">
				<PerfGridEditor bind:grid={p.takeoff} title={t.aircraft.takeoffDistances} />
			</section>
			<section class="card">
				<PerfGridEditor bind:grid={p.landing} title={t.aircraft.landingDistances} />
			</section>
		{:else if cf}
			<section class="card">
				<h5>{t.aircraft.reference}</h5>
				<label class="field" title={t.aircraft.referenceMassTip}>
					<span>{t.aircraft.referenceMass}</span>
					<input class="num" type="number" min="1" step={decimalStep(cf.massReferenceLb)} value={cf.massReferenceLb} oninput={(e) => (cf.massReferenceLb = v(e))} />
					<!-- i18n-ignore: lb is an invariant unit token -->
					<span class="unit">lb</span>
				</label>
				<p class="hint">{t.aircraft.closedFormHint}</p>
			</section>
			{#each cf.configs as c, i (i)}
				<ClosedFormConfigCard
					bind:config={cf.configs[i]}
					onremove={() => cf.configs.splice(cf.configs.indexOf(c), 1)}
					onsetdefault={(on: boolean) => setDefault(cf, c, on)}
				/>
			{/each}
			<div>
				<button class="add-btn" onclick={() => cf.configs.push(blankClosedFormConfigDraft('takeoff'))}>
					<Icon name="plus" size={12} />
					{t.aircraft.addConfig}
				</button>
			</div>
		{/if}
	{:else}
		<section class="card">
			<h4>{t.aircraft.pagePerf}</h4>
			<p class="hint">{t.aircraft.noPerfHint}</p>
			<div class="kind-row">
				<label class="check">
					<input type="radio" name="perf-kind" value="table" bind:group={addKind} />
					{t.aircraft.kindTableRadio}
				</label>
				<label class="check">
					<input type="radio" name="perf-kind" value="closed-form" bind:group={addKind} />
					{t.aircraft.kindClosedFormRadio}
				</label>
			</div>
			<div>
				<button class="add-btn" onclick={addSection}>
					<Icon name="plus" size={12} />
					{t.aircraft.addPerf}
				</button>
			</div>
		</section>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	h4 {
		margin: 0;
		font-size: 13px;
	}

	h5 {
		margin: 0;
		font-size: 12.5px;
		font-weight: 600;
	}

	.factors {
		display: flex;
		gap: 18px;
		flex-wrap: wrap;
	}

	.factors .field > span:first-child {
		width: auto;
	}

	.wind-cols {
		display: flex;
		gap: 24px;
		flex-wrap: wrap;
	}

	.kind-row {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	/* Extrapolated reference rows: the workbook's orange flag. */
	tr.warn td {
		color: var(--workbook-orange);
	}
</style>
