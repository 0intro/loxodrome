<script lang="ts">
	/* One closed-form flap configuration: phase, flaps, the take-off
	 * PROCEDURE its chart belongs to (normal or short-field; the runway
	 * verdict tries the normal one first) or, on a landing config, the
	 * default flag (the parent keeps at most one, radio-like), the mass law,
	 * and the two fitted metrics (distance over 15 m, ground roll), each
	 * [a, b, c, d] coefficients plus per-knot wind rates. The metrics are the
	 * two columns of one table, a row per coefficient, so every box holds its
	 * whole figure (-0.00000162 included) and the card keeps one width down to
	 * a phone's. The coefficients come from fitting the manual's charts
	 * offline (see docs/flight-preparation.md), so these fields are for
	 * transcription, not derivation. */

	import {
		decimalStep,
		type ClosedFormConfigDraft,
		type ClosedFormMetricDraft,
	} from '$lib/aircraft/edit';
	import type { TakeoffProcedure } from '$lib/aircraft/schema';
	import { t } from '$lib/state/i18n.svelte';
	import { gridPaste } from '$lib/ui/gridPaste';

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

	/** Each phase keeps its own field: a procedure means nothing on a landing
	 *  config, the landing default nothing on a take-off one. */
	function setPhase(phase: 'takeoff' | 'landing'): void {
		config.phase = phase;
		if (phase === 'takeoff') {
			config.isDefault = false;
		} else {
			config.procedure = '';
		}
	}

	/* The table's rows: the four coefficients, named as the formula names
	 * them, then the two per-knot wind rates. Keys only: the wind rows' labels
	 * resolve through t at render (docs/i18n.md rule 2). */
	type CoefRow = 0 | 1 | 2 | 3 | 'head' | 'tail';
	const ROWS: CoefRow[] = [0, 1, 2, 3, 'head', 'tail'];
	const LETTERS = ['a', 'b', 'c', 'd'];

	function rowLabel(row: CoefRow): string {
		if (row === 'head') {
			return t.aircraft.headwindPerKt;
		}
		if (row === 'tail') {
			return t.aircraft.tailwindPerKt;
		}
		return LETTERS[row];
	}

	function valueOf(m: ClosedFormMetricDraft, row: CoefRow): string {
		if (row === 'head') {
			return m.headwindPerKt;
		}
		if (row === 'tail') {
			return m.tailwindPerKt;
		}
		return m.coefficients[row];
	}

	function setValue(m: ClosedFormMetricDraft, row: CoefRow, value: string): void {
		if (row === 'head') {
			m.headwindPerKt = value;
		} else if (row === 'tail') {
			m.tailwindPerKt = value;
		} else {
			m.coefficients[row] = value;
		}
	}
</script>

{#snippet coef(m: ClosedFormMetricDraft, metric: string, row: CoefRow, col: number)}
	<input
		class="coef"
		type="number"
		lang="en"
		required
		data-row={ROWS.indexOf(row)}
		data-col={col}
		step={decimalStep(valueOf(m, row))}
		value={valueOf(m, row)}
		aria-label={t.aircraft.ariaCoef({ metric, coef: rowLabel(row) })}
		oninput={(e) => setValue(m, row, v(e))}
	/>
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
	<label class="field">
		<span>{t.aircraft.phase}</span>
		<select
			value={config.phase}
			onchange={(e) => setPhase((e.target as HTMLSelectElement).value as 'takeoff' | 'landing')}
		>
			<option value="takeoff">{t.aircraft.optTakeoff}</option>
			<option value="landing">{t.aircraft.optLanding}</option>
		</select>
	</label>
	<label class="field">
		<span>{t.aircraft.flaps}</span>
		<input class="num" type="number" lang="en" required step={decimalStep(config.flapsDeg)} value={config.flapsDeg} oninput={(e) => (config.flapsDeg = v(e))} />
		<span class="unit">°</span>
	</label>
	{#if config.phase === 'takeoff'}
		<label class="field" title={t.aircraft.procedureTip}>
			<span>{t.aircraft.procedure}</span>
			<select
				value={config.procedure}
				onchange={(e) =>
					(config.procedure = (e.target as HTMLSelectElement).value as '' | TakeoffProcedure)}
			>
				<option value="">{t.aircraft.procedureUnset}</option>
				<option value="normal">{t.aircraft.procedureNormal}</option>
				<option value="short-field">{t.aircraft.procedureShortField}</option>
			</select>
		</label>
	{:else}
		<!-- In the procedure's place, on the box column: a landing has no
		     procedure, and its configs one default between them. -->
		<div class="field">
			<span></span>
			<label class="check" title={t.aircraft.defaultForVerdictTip}>
				<input
					type="checkbox"
					checked={config.isDefault}
					onchange={(e) => onsetdefault((e.target as HTMLInputElement).checked)}
				/>
				{t.aircraft.defaultForVerdict}
			</label>
		</div>
	{/if}
	<label class="field" title={t.aircraft.massExponentTip}>
		<span>{t.aircraft.massExponent}</span>
		<input class="num" type="number" lang="en" min="0" step={decimalStep(config.massExponent)} value={config.massExponent} oninput={(e) => (config.massExponent = v(e))} />
	</label>
	<!-- A fitted table pastes whole (ui/gridPaste): a column of a, b, c, d
	     from the spreadsheet the fit was made in. -->
	<div class="coefs" use:gridPaste>
		<span></span>
		<span class="coef-head">{t.aircraft.distanceOver15}</span>
		<span class="coef-head">{t.aircraft.groundRoll}</span>
		{#each ROWS as row (row)}
			<span class="coef-label">{rowLabel(row)}</span>
			{@render coef(config.distance15m, t.aircraft.distanceOver15, row, 0)}
			{@render coef(config.groundRoll, t.aircraft.groundRoll, row, 1)}
		{/each}
	</div>
</div>

<style>
	/* An object card (one configuration you act on), so it keeps its frame
	   inside the flat section. Its own label column: its labels are shorter
	   than the page's longest ("Exposant de masse", 122 px), and it gives way
	   on the narrowest phones (a 360 px one leaves the card 318 px), where a
	   long label wraps rather than the coefficients' column overflowing. */
	.cfg {
		--label-w: clamp(96px, 34%, 132px);

		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	h5 {
		margin: 0;
		font-size: 12.5px;
		font-weight: 600;
	}

	/* The coefficients: the label column, then a column per metric, each box
	   on the field boxes' line. */
	.coefs {
		display: grid;
		grid-template-columns: var(--label-w) var(--w-coef) var(--w-coef);
		gap: 4px var(--field-gap);
		align-items: center;
		font-size: 12.5px;
	}

	/* A metric's name may take two lines over its box ("Passage des 15 m"):
	   both names then stand on the boxes, not mid-air. */
	.coef-head {
		align-self: end;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted);
	}

	.coef-label {
		color: var(--text-muted);
	}
</style>
