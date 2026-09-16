<script lang="ts">
	/* One closed-form flap configuration: phase, flaps, the default flag
	 * (the parent keeps at most one per phase, radio-like), the mass law,
	 * and the two fitted metrics (distance over 15 m, ground roll), each
	 * [a, b, c, d] coefficients plus per-knot wind rates. The coefficients
	 * come from fitting the manual's charts offline (see
	 * docs/flight-preparation.md), so these fields are for transcription,
	 * not derivation. */

	import {
		decimalStep,
		type ClosedFormConfigDraft,
		type ClosedFormMetricDraft,
	} from '$lib/aircraft/edit';
	import { t } from '$lib/state/i18n.svelte';

	let {
		config = $bindable(),
		onremove,
		onsetdefault,
	}: {
		config: ClosedFormConfigDraft;
		onremove: () => void;
		/** Checked: the parent clears the same-phase sibling defaults. */
		onsetdefault: (on: boolean) => void;
	} = $props();

	function v(e: Event): string {
		return (e.target as HTMLInputElement).value;
	}

	const COEFS: { i: 0 | 1 | 2 | 3; name: string }[] = [
		{ i: 0, name: 'a' },
		{ i: 1, name: 'b' },
		{ i: 2, name: 'c' },
		{ i: 3, name: 'd' },
	];
</script>

{#snippet metric(m: ClosedFormMetricDraft, label: string)}
	<div class="metric">
		<span class="metric-lbl">{label}</span>
		{#each COEFS as c (c.i)}
			<label class="coef">
				<span>{c.name}</span>
				<input type="number" step={decimalStep(m.coefficients[c.i])} value={m.coefficients[c.i]} oninput={(e) => (m.coefficients[c.i] = v(e))} />
			</label>
		{/each}
		<label class="coef wide">
			<span>{t.aircraft.headwindPerKt}</span>
			<input type="number" step={decimalStep(m.headwindPerKt)} value={m.headwindPerKt} oninput={(e) => (m.headwindPerKt = v(e))} />
		</label>
		<label class="coef wide">
			<span>{t.aircraft.tailwindPerKt}</span>
			<input type="number" step={decimalStep(m.tailwindPerKt)} value={m.tailwindPerKt} oninput={(e) => (m.tailwindPerKt = v(e))} />
		</label>
	</div>
{/snippet}

<div class="cfg">
	<div class="sect-head">
		<h5>
			{t.aircraft.cfgTitle({
				phase: config.phase === 'takeoff' ? t.aircraft.takeoff : t.aircraft.landing,
				flaps: config.flapsDeg.trim() === '' ? '?' : config.flapsDeg,
			})}
		</h5>
		<button class="link-btn" onclick={onremove}>{t.aircraft.removeConfig}</button>
	</div>
	<div class="row">
		<label class="field">
			<span>{t.aircraft.phase}</span>
			<select
				value={config.phase}
				onchange={(e) => (config.phase = (e.target as HTMLSelectElement).value as 'takeoff' | 'landing')}
			>
				<option value="takeoff">{t.aircraft.optTakeoff}</option>
				<option value="landing">{t.aircraft.optLanding}</option>
			</select>
		</label>
		<label class="field">
			<span>{t.aircraft.flaps}</span>
			<input class="num" type="number" step={decimalStep(config.flapsDeg)} value={config.flapsDeg} oninput={(e) => (config.flapsDeg = v(e))} />
			<span class="unit">°</span>
		</label>
	</div>
	<div class="row">
		<label class="check" title={t.aircraft.defaultForVerdictTip}>
			<input
				type="checkbox"
				checked={config.isDefault}
				onchange={(e) => onsetdefault((e.target as HTMLInputElement).checked)}
			/>
			{t.aircraft.defaultForVerdict}
		</label>
		<label class="field" title={t.aircraft.massExponentTip}>
			<span>{t.aircraft.massExponent}</span>
			<input class="num" type="number" min="0" step={decimalStep(config.massExponent)} value={config.massExponent} oninput={(e) => (config.massExponent = v(e))} />
		</label>
	</div>
	{@render metric(config.distance15m, t.aircraft.distanceOver15)}
	{@render metric(config.groundRoll, t.aircraft.groundRoll)}
</div>

<style>
	.cfg {
		display: flex;
		flex-direction: column;
		gap: 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 10px 12px;
	}

	h5 {
		margin: 0;
		font-size: 12.5px;
		font-weight: 600;
	}

	.row {
		display: flex;
		gap: 18px;
		flex-wrap: wrap;
		align-items: center;
	}

	.metric {
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
	}

	.metric-lbl {
		width: 130px;
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.coef {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
	}

	.coef > span {
		color: var(--text-muted);
	}

	.coef input {
		width: 84px;
		font: inherit;
		font-size: 12px;
		background: var(--surface);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 2px 6px;
	}

	.coef.wide input {
		width: 72px;
	}
</style>
