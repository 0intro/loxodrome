<script lang="ts">
	/* The performance model: shared safety factors, then either the POH
	 * table kind (mass anchors, headwind factor tables, the two distance
	 * grids) or the closed-form kind (reference mass + fitted flap
	 * configs). The two shapes do not map onto each other: a switch of kind
	 * keeps the four safety factors they share and drops the rest, asking
	 * first when the rest holds figures. */

	import Icon from '../Icon.svelte';
	import PerfGridEditor from './PerfGridEditor.svelte';
	import MetricGridEditor from './MetricGridEditor.svelte';
	import WindAnchorsEditor from './WindAnchorsEditor.svelte';
	import ClosedFormConfigCard from './ClosedFormConfigCard.svelte';
	import PlausibilityList from './PlausibilityList.svelte';
	import {
		blankAccelerateStopDraft,
		blankClosedFormConfigDraft,
		blankClosedFormPerformanceDraft,
		blankMetricTableDraft,
		blankOneEngineDraft,
		blankTablePerformanceDraft,
		decimalStep,
		referenceFigures,
		type AircraftDraft,
		type ClosedFormConfigDraft,
		type ClosedFormPerformanceDraft,
		type PerformanceDraft,
	} from '$lib/aircraft/edit';
	import type { AircraftPerformance, OneEngineInoperative, TakeoffProcedure } from '$lib/aircraft/schema';
	import type { PlausibilityWarning } from '$lib/aircraft/plausibility';
	import { t } from '$lib/state/i18n.svelte';
	import { askRemoval } from './removal';

	let {
		draft = $bindable(),
		validPerformance,
		validOei = null,
		warnings = [],
	}: {
		draft: AircraftDraft;
		/** The schema-validated performance when the whole draft parses. */
		validPerformance: AircraftPerformance | null;
		/** A twin's schema-validated one engine inoperative section. */
		validOei?: OneEngineInoperative | null;
		/** The figures to check on this page, read from that sheet. */
		warnings?: PlausibilityWarning[];
	} = $props();

	const figures = $derived(validPerformance ? referenceFigures(validPerformance, validOei) : null);
	const twin = $derived(draft.engines === '2');

	/** The net ceiling's words: the ceiling, a floor of it, or nil already
	 *  at sea level. */
	function ceilingText(c: NonNullable<NonNullable<typeof figures>['oeiCeiling']>): string {
		const ft = Math.floor(c.ceiling.altFt / 100) * 100;
		return c.ceiling.kind === 'ceiling'
			? t.aircraft.refOeiCeiling(ft)
			: c.ceiling.kind === 'above'
				? t.aircraft.refOeiCeilingAbove(ft)
				: t.aircraft.refOeiCeilingBelow;
	}

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

	// The section and a configuration holding figures ask before they go (the
	// editor's question); freshly added, they go at once.
	const askRemove = askRemoval();

	function removeSection(p: NonNullable<AircraftDraft['performance']>): void {
		const blank = p.kind === 'table' ? blankTablePerformanceDraft() : blankClosedFormPerformanceDraft();
		askRemove('section', () => t.aircraft.pagePerf, p, blank, () => (draft.performance = null));
	}

	function removeConfig(p: ClosedFormPerformanceDraft, c: ClosedFormConfigDraft): void {
		const name = (): string =>
			t.aircraft.cfgTitle({
				phase: c.phase === 'takeoff' ? t.aircraft.takeoff : t.aircraft.landing,
				flaps: c.flapsDeg.trim() === '' ? '?' : c.flapsDeg,
			});
		askRemove('config', name, c, blankClosedFormConfigDraft(c.phase), () => p.configs.splice(p.configs.indexOf(c), 1));
	}

	/** The other kind, the safety factors carried over: the four fields both
	 *  kinds hold, which a remove and an add used to lose. The current kind's
	 *  own figures go, so a model holding some asks first. */
	function switchKind(p: PerformanceDraft): void {
		const factors = {
			marginFactor: p.marginFactor,
			grassFactor: p.grassFactor,
			wetFactor: p.wetFactor,
			flaplessLandingFactor: p.flaplessLandingFactor,
		};
		const toTable = p.kind === 'closed-form';
		const asAdded = { ...(toTable ? blankClosedFormPerformanceDraft() : blankTablePerformanceDraft()), ...factors };
		const target = (): string => (toTable ? t.aircraft.switchTargetTable : t.aircraft.switchTargetClosedForm);
		askRemove('model', target, p, asAdded, () => {
			draft.performance = { ...(toTable ? blankTablePerformanceDraft() : blankClosedFormPerformanceDraft()), ...factors };
		});
	}

	function addSection(): void {
		draft.performance = addKind === 'table' ? blankTablePerformanceDraft() : blankClosedFormPerformanceDraft();
	}

	/** A twin's sections go as the others do: asking first when they hold
	 *  figures. */
	function removeAsd(p: NonNullable<AircraftDraft['performance']>): void {
		askRemove('section', () => t.aircraft.asdTitle, p.accelerateStop, blankAccelerateStopDraft(), () => (p.accelerateStop = null));
	}

	function removeOei(): void {
		askRemove('section', () => t.aircraft.oeiTitle, draft.oneEngine, blankOneEngineDraft(), () => (draft.oneEngine = null));
	}

	function removeTakeoffClimb(): void {
		const o = draft.oneEngine;
		if (o) {
			askRemove('section', () => t.aircraft.oeiTakeoffClimb, o.takeoffClimb, blankMetricTableDraft(), () => (o.takeoffClimb = null));
		}
	}

	/** Checking a landing config's default clears the other landing configs'. */
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
			<span class="sect-actions">
				<button class="link-btn" onclick={() => switchKind(p)}>
					{t.aircraft.switchModel(p.kind === 'table' ? t.aircraft.switchTargetClosedForm : t.aircraft.switchTargetTable)}
				</button>
				<button class="link-btn" onclick={() => removeSection(p)}>{t.aircraft.removeSection}</button>
			</span>
		</div>
		<section class="card">
			<h5>{t.aircraft.safetyFactors}</h5>
			<label class="field">
				<span>{t.aircraft.margin}</span>
				<input class="num" type="number" lang="en" min="0" step={decimalStep(p.marginFactor || DEFAULTS.margin)} value={p.marginFactor} placeholder={DEFAULTS.margin} oninput={(e) => (p.marginFactor = v(e))} />
			</label>
			<label class="field">
				<span>{t.aircraft.grass}</span>
				<input class="num" type="number" lang="en" min="0" step={decimalStep(p.grassFactor || DEFAULTS.grass)} value={p.grassFactor} placeholder={DEFAULTS.grass} oninput={(e) => (p.grassFactor = v(e))} />
			</label>
			<label class="field">
				<span>{t.aircraft.wet}</span>
				<input class="num" type="number" lang="en" min="0" step={decimalStep(p.wetFactor || DEFAULTS.wet)} value={p.wetFactor} placeholder={DEFAULTS.wet} oninput={(e) => (p.wetFactor = v(e))} />
			</label>
			<label class="field" title={t.aircraft.flaplessLandingTip}>
				<span>{t.aircraft.flaplessLanding}</span>
				<input class="num" type="number" lang="en" min="0" step={decimalStep(p.flaplessLandingFactor)} value={p.flaplessLandingFactor} placeholder="—" oninput={(e) => (p.flaplessLandingFactor = v(e))} />
			</label>
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
				{#if figures.asd}
					<p class="hint" class:warn={figures.asd.extrapolated}>
						{t.aircraft.refAsd({ m: Math.round(figures.asd.m), kg: Math.round(figures.asd.massKg) })}
					</p>
				{/if}
				{#if figures.oeiCeiling}
					<p class="hint">{ceilingText(figures.oeiCeiling)} ({Math.round(figures.oeiCeiling.massKg)} kg)</p>
				{/if}
			{:else}
				<p class="hint">{t.aircraft.refFiguresPending}</p>
			{/if}
			<PlausibilityList {warnings} />
		</section>
		{#if p.kind === 'table'}
			<section class="card">
				<h5>{t.aircraft.massAnchors}</h5>
				<label class="field">
					<span>{t.aircraft.maxMass}</span>
					<input class="num" type="number" lang="en" min="1" required step={decimalStep(p.massMaxKg)} value={p.massMaxKg} oninput={(e) => (p.massMaxKg = v(e))} />
					<span class="unit">kg</span>
				</label>
				<label class="field">
					<span>{t.aircraft.minMass}</span>
					<input class="num" type="number" lang="en" min="1" required step={decimalStep(p.massMinKg)} value={p.massMinKg} oninput={(e) => (p.massMinKg = v(e))} />
					<span class="unit">kg</span>
				</label>
				<!-- An option of the anchors, on the box column. -->
				<div class="field">
					<span></span>
					<label class="check" title={t.aircraft.holdBelowTableTip}>
						<input
							type="checkbox"
							checked={p.holdBelowTable}
							onchange={(e) => (p.holdBelowTable = (e.target as HTMLInputElement).checked)}
						/>
						{t.aircraft.holdBelowTable}
					</label>
				</div>
				<p class="hint">{t.aircraft.massAnchorsHint}</p>
			</section>
			<section class="card">
				<h5>{t.aircraft.tableConfig}</h5>
				<label class="field">
					<span>{t.aircraft.takeoffFlaps}</span>
					<input class="num" type="number" lang="en" step={decimalStep(p.takeoffFlapsDeg)} value={p.takeoffFlapsDeg} placeholder="—" oninput={(e) => (p.takeoffFlapsDeg = v(e))} />
					<span class="unit">°</span>
				</label>
				<label class="field" title={t.aircraft.procedureTip}>
					<span>{t.aircraft.procedure}</span>
					<select
						value={p.takeoffProcedure}
						onchange={(e) =>
							(p.takeoffProcedure = (e.target as HTMLSelectElement).value as '' | TakeoffProcedure)}
					>
						<option value="">{t.aircraft.procedureUnset}</option>
						<option value="normal">{t.aircraft.procedureNormal}</option>
						<option value="short-field">{t.aircraft.procedureShortField}</option>
					</select>
				</label>
				<label class="field">
					<span>{t.aircraft.landingFlaps}</span>
					<input class="num" type="number" lang="en" step={decimalStep(p.landingFlapsDeg)} value={p.landingFlapsDeg} placeholder="—" oninput={(e) => (p.landingFlapsDeg = v(e))} />
					<span class="unit">°</span>
				</label>
				<p class="hint">{t.aircraft.tableConfigHint}</p>
			</section>
			<section class="card">
				<h5>{t.aircraft.wind}</h5>
				<div class="wind-cols">
					<WindAnchorsEditor bind:anchors={p.takeoffHeadwind} title={t.aircraft.takeoffHeadwindFactors} />
					<WindAnchorsEditor bind:anchors={p.landingHeadwind} title={t.aircraft.landingHeadwindFactors} />
				</div>
				<label class="field" title={t.aircraft.tailwindTip}>
					<span>{t.aircraft.tailwind}</span>
					<input class="num" type="number" lang="en" min="0" step={decimalStep(p.tailwindPctPer2Kt || DEFAULTS.tailwind)} value={p.tailwindPctPer2Kt} placeholder={DEFAULTS.tailwind} oninput={(e) => (p.tailwindPctPer2Kt = v(e))} />
					<span class="unit">{t.aircraft.pctPer2Kt}</span>
				</label>
			</section>
			<section class="card">
				<PerfGridEditor bind:grid={p.takeoff} title={t.aircraft.takeoffDistances} hint={t.aircraft.pasteHint} />
			</section>
			<section class="card">
				<PerfGridEditor bind:grid={p.landing} title={t.aircraft.landingDistances} />
			</section>
		{:else if cf}
			<section class="card">
				<h5>{t.aircraft.reference}</h5>
				<label class="field" title={t.aircraft.referenceMassTip}>
					<span>{t.aircraft.referenceMass}</span>
					<input class="num" type="number" lang="en" min="1" required step={decimalStep(cf.massReferenceLb)} value={cf.massReferenceLb} oninput={(e) => (cf.massReferenceLb = v(e))} />
					<!-- i18n-ignore: lb is an invariant unit token -->
					<span class="unit">lb</span>
				</label>
				<p class="hint">{t.aircraft.closedFormHint}</p>
			</section>
			<!-- Each configuration an object card of its own width: a wide
			     window sets them side by side, a phone one under another. -->
			<div class="cfg-grid">
				{#each cf.configs as c, i (i)}
					<ClosedFormConfigCard
						bind:config={cf.configs[i]}
						onremove={() => removeConfig(cf, c)}
						onsetdefault={(on: boolean) => setDefault(cf, c, on)}
					/>
				{/each}
			</div>
			<div>
				<button class="add-btn" onclick={() => cf.configs.push(blankClosedFormConfigDraft('takeoff'))}>
					<Icon name="plus" size={12} />
					{t.aircraft.addConfig}
				</button>
			</div>
		{/if}
		<!-- A twin's accelerate-stop distance, a one-figure grid at masses of
		     its own with its own wind correction. -->
		{#if twin}
			{#if p.accelerateStop}
				{@const asd = p.accelerateStop}
				<section class="card">
					<div class="sect-head">
						<h5>{t.aircraft.asdTitle}</h5>
						<span class="sect-actions">
							<button class="link-btn" onclick={() => removeAsd(p)}>{t.aircraft.removeSection}</button>
						</span>
					</div>
					<p class="hint">{t.aircraft.asdHint}</p>
					<div class="wind-cols">
						<WindAnchorsEditor bind:anchors={asd.headwind} title={t.aircraft.asdHeadwindFactors} />
					</div>
					<label class="field" title={t.aircraft.tailwindTip}>
						<span>{t.aircraft.tailwind}</span>
						<input class="num" type="number" lang="en" min="0" step={decimalStep(asd.tailwindPctPer2Kt || DEFAULTS.tailwind)} value={asd.tailwindPctPer2Kt} placeholder={DEFAULTS.tailwind} oninput={(e) => (asd.tailwindPctPer2Kt = v(e))} />
						<span class="unit">{t.aircraft.pctPer2Kt}</span>
					</label>
					<MetricGridEditor bind:grid={p.accelerateStop} title={t.aircraft.asdGrid} what={t.aircraft.asdWhat} hint={t.aircraft.pasteHint} />
				</section>
			{:else}
				<div>
					<button class="add-btn" onclick={() => (p.accelerateStop = blankAccelerateStopDraft())}>
						<Icon name="plus" size={12} />
						{t.aircraft.addAsd}
					</button>
				</div>
			{/if}
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
	<!-- A twin's one engine inoperative section: its speeds and climb, the
	     aircraft's own (not the performance section's). -->
	{#if twin}
		{#if draft.oneEngine}
			{@const o = draft.oneEngine}
			<section class="card">
				<div class="sect-head">
					<h5>{t.aircraft.oeiTitle}</h5>
					<span class="sect-actions">
						<button class="link-btn" onclick={removeOei}>{t.aircraft.removeSection}</button>
					</span>
				</div>
				<p class="hint">{t.aircraft.oeiHint}</p>
				<label class="field" title={t.aircraft.vmcTip}>
					<span>{t.aircraft.vmc}</span>
					<input class="num" type="number" lang="en" min="1" required step={decimalStep(o.vmcKt)} value={o.vmcKt} oninput={(e) => (o.vmcKt = v(e))} />
					<span class="unit">kt</span>
				</label>
				<label class="field" title={t.aircraft.vyseTip}>
					<span>{t.aircraft.vyse}</span>
					<input class="num" type="number" lang="en" min="1" required step={decimalStep(o.vyseKt)} value={o.vyseKt} oninput={(e) => (o.vyseKt = v(e))} />
					<span class="unit">kt</span>
				</label>
				<label class="field">
					<span>{t.aircraft.vxse}</span>
					<input class="num" type="number" lang="en" min="1" step={decimalStep(o.vxseKt)} value={o.vxseKt} placeholder="—" oninput={(e) => (o.vxseKt = v(e))} />
					<span class="unit">kt</span>
				</label>
				{#if o.climb}
					<MetricGridEditor bind:grid={o.climb} title={t.aircraft.oeiClimb} what={t.aircraft.climbWhat} negative />
				{:else}
					<div>
						<button class="add-btn" onclick={() => (o.climb = blankMetricTableDraft())}>
							<Icon name="plus" size={12} />
							{t.aircraft.addOeiClimb}
						</button>
					</div>
				{/if}
				{#if o.takeoffClimb}
					<div class="sect-head">
						<span class="sect-actions">
							<button class="link-btn" onclick={removeTakeoffClimb}>{t.aircraft.removeTakeoffClimb}</button>
						</span>
					</div>
					<MetricGridEditor bind:grid={o.takeoffClimb} title={t.aircraft.oeiTakeoffClimb} what={t.aircraft.climbWhat} negative />
				{:else}
					<p class="hint">{t.aircraft.takeoffClimbHint}</p>
					<div>
						<button class="add-btn" onclick={() => (o.takeoffClimb = blankMetricTableDraft())}>
							<Icon name="plus" size={12} />
							{t.aircraft.addTakeoffClimb}
						</button>
					</div>
				{/if}
			</section>
		{:else}
			<div>
				<button class="add-btn" onclick={() => (draft.oneEngine = blankOneEngineDraft())}>
					<Icon name="plus" size={12} />
					{t.aircraft.addOei}
				</button>
			</div>
		{/if}
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

	/* The section's two actions, one row at the head's end, under the title
	   where the head cannot hold all three. */
	.sect-actions {
		display: flex;
		gap: 16px;
		margin-inline-start: auto;
	}

	.cfg-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(380px, 100%), 440px));
		gap: 12px;
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

	/* The kind is a choice for adding the section: absent from a read-only
	   view, like the add control it goes with. */
	:global(.read-only) .kind-row {
		display: none;
	}

	/* Extrapolated reference rows (and a twin's accelerate-stop line): the
	   workbook's orange flag. */
	tr.warn td,
	p.hint.warn {
		color: var(--workbook-orange);
	}
</style>
