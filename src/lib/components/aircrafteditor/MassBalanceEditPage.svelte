<script lang="ts">
	/* Empty mass and arms, the loading stations, and the CG envelope with a
	 * live chart preview over the rows that already hold finite numbers.
	 * The section is optional: absent disables the flight-prep M&B page,
	 * exactly like importing a partial data sheet. */

	import Icon from '../Icon.svelte';
	import CgEnvelopeChart from '../flightprep/CgEnvelopeChart.svelte';
	import {
		blankEnvelopePointDraft,
		blankMassBalanceDraft,
		blankStationDraft,
		decimalStep,
		draftEnvelopePoints,
		type AircraftDraft,
	} from '$lib/aircraft/edit';
	import { t } from '$lib/state/i18n.svelte';

	let { draft = $bindable() }: { draft: AircraftDraft } = $props();

	function v(e: Event): string {
		return (e.target as HTMLInputElement).value;
	}

	const preview = $derived(draft.massBalance ? draftEnvelopePoints(draft.massBalance) : []);
</script>

<div class="page">
	{#if draft.massBalance}
		{@const m = draft.massBalance}
		<div class="sect-head">
			<h4>{t.aircraft.pageMb}</h4>
			<button class="link-btn" onclick={() => (draft.massBalance = null)}>{t.aircraft.removeSection}</button>
		</div>
		<div class="cols">
			<div class="col">
				<section class="card">
					<h5>{t.aircraft.emptyAircraft}</h5>
					<label class="field">
						<span>{t.aircraft.emptyMass}</span>
						<input class="num" type="number" min="1" step={decimalStep(m.emptyMassKg)} value={m.emptyMassKg} oninput={(e) => (m.emptyMassKg = v(e))} />
						<span class="unit">kg</span>
					</label>
					<label class="field">
						<span>{t.aircraft.emptyArm}</span>
						<input class="num" type="number" step={decimalStep(m.emptyArmM)} value={m.emptyArmM} oninput={(e) => (m.emptyArmM = v(e))} />
						<span class="unit">m</span>
					</label>
					<label class="field">
						<span>{t.aircraft.fuelArm}</span>
						<input class="num" type="number" step={decimalStep(m.fuelArmM)} value={m.fuelArmM} oninput={(e) => (m.fuelArmM = v(e))} />
						<span class="unit">m</span>
					</label>
				</section>
				<section class="card">
					<h5>{t.aircraft.stations}</h5>
					{#if m.stations.length > 0}
						<table class="etable">
							<thead>
								<tr>
									<th>{t.aircraft.station}</th>
									<th>{t.aircraft.armM}</th>
									<th>{t.aircraft.defaultKg}</th>
									<th class="plain"></th>
								</tr>
							</thead>
							<tbody>
								{#each m.stations as s, i (i)}
									<tr>
										<td><input class="text-cell" type="text" autocapitalize="sentences" aria-label={t.aircraft.ariaStationName(i + 1)} value={s.label} oninput={(e) => (m.stations[i].label = v(e))} /></td>
										<td><input class="cell" type="number" aria-label={t.aircraft.ariaStationArm(s.label || String(i + 1))} step={decimalStep(s.armM)} value={s.armM} oninput={(e) => (m.stations[i].armM = v(e))} /></td>
										<td><input class="cell" type="number" min="0" aria-label={t.aircraft.ariaStationMass(s.label || String(i + 1))} step={decimalStep(s.defaultMassKg)} value={s.defaultMassKg} oninput={(e) => (m.stations[i].defaultMassKg = v(e))} /></td>
										<td class="plain">
											<button class="icon" title={t.aircraft.removeStationTip} onclick={() => m.stations.splice(i, 1)}>
												<Icon name="x" size={13} />
											</button>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					{/if}
					<button class="add-btn" onclick={() => m.stations.push(blankStationDraft())}>
						<Icon name="plus" size={12} />
						{t.aircraft.addStation}
					</button>
					<p class="hint">{t.aircraft.renameStationHint}</p>
				</section>
			</div>
			<div class="col">
				<section class="card">
					<h5>{t.aircraft.cgEnvelope}</h5>
					<table class="etable">
						<thead>
							<tr>
								<th>{t.aircraft.armM}</th>
								<th>{t.aircraft.massKg}</th>
								<th class="plain"></th>
							</tr>
						</thead>
						<tbody>
							{#each m.envelope as p, i (i)}
								<tr>
									<td><input class="cell" type="number" aria-label={t.aircraft.ariaVertexArm(i + 1)} step={decimalStep(p.armM)} value={p.armM} oninput={(e) => (m.envelope[i].armM = v(e))} /></td>
									<td><input class="cell" type="number" min="1" aria-label={t.aircraft.ariaVertexMass(i + 1)} step={decimalStep(p.massKg)} value={p.massKg} oninput={(e) => (m.envelope[i].massKg = v(e))} /></td>
									<td class="plain">
										<button
											class="icon"
											title={t.aircraft.removeVertexTip}
											disabled={m.envelope.length <= 3}
											onclick={() => m.envelope.splice(i, 1)}
										>
											<Icon name="x" size={13} />
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
					<button class="add-btn" onclick={() => m.envelope.push(blankEnvelopePointDraft())}>
						<Icon name="plus" size={12} />
						{t.aircraft.addVertex}
					</button>
					<p class="hint">{t.aircraft.envelopeHint}</p>
					{#if preview.length >= 3}
						<CgEnvelopeChart envelope={preview} points={[]} heightPx={240} />
					{/if}
				</section>
			</div>
		</div>
	{:else}
		<section class="card">
			<h4>{t.aircraft.pageMb}</h4>
			<p class="hint">{t.aircraft.noMbHint}</p>
			<div>
				<button class="add-btn" onclick={() => (draft.massBalance = blankMassBalanceDraft())}>
					<Icon name="plus" size={12} />
					{t.aircraft.addMb}
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

	.cols {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		flex-wrap: wrap;
	}

	.col {
		flex: 1 1 380px;
		min-width: 320px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
</style>
