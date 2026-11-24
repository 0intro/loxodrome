<script lang="ts">
	/* Empty mass and arms, the loading stations, and the CG envelope with a
	 * live chart preview over the rows that already hold finite numbers,
	 * the default load drawn on it: where a typical loading sits while the
	 * arms are typed. The section is optional: absent disables the
	 * flight-prep M&B page, exactly like importing a partial data sheet. */

	import Icon from '../Icon.svelte';
	import CgEnvelopeChart from '../flightprep/CgEnvelopeChart.svelte';
	import PlausibilityList from './PlausibilityList.svelte';
	import type { CgPoint } from '../flightprep/cgChart';
	import {
		blankEnvelopePointDraft,
		blankFuelTankDraft,
		blankMassBalanceDraft,
		blankStationDraft,
		decimalStep,
		draftDefaultLoad,
		draftEnvelopePoints,
		SOME_TEXT,
		type AircraftDraft,
	} from '$lib/aircraft/edit';
	import { cgTravel, pointInEnvelope } from '$lib/aircraft/massBalance';
	import type { PlausibilityWarning } from '$lib/aircraft/plausibility';
	import { t } from '$lib/state/i18n.svelte';
	import { gridPaste } from '$lib/ui/gridPaste';
	import { askRemoval } from './removal';

	let {
		draft = $bindable(),
		fromGeneric = false,
		warnings = [],
	}: {
		draft: AircraftDraft;
		fromGeneric?: boolean;
		/** The figures to check on this page (the envelope's outline). */
		warnings?: PlausibilityWarning[];
	} = $props();

	function v(e: Event): string {
		return (e.target as HTMLInputElement).value;
	}

	const preview = $derived(draft.massBalance ? draftEnvelopePoints(draft.massBalance) : []);

	/* The default load on the preview, the flight preparation's marks: the
	 * aircraft without fuel as a square, with the full usable fuel as a dot,
	 * the burn between them, either in the danger ink outside the envelope
	 * drawn. */
	const load = $derived(draftDefaultLoad(draft));
	const loadPoints = $derived.by((): CgPoint[] => {
		if (!load) {
			return [];
		}
		const at = (p: { armM: number; massKg: number }) => ({
			armM: p.armM,
			massKg: p.massKg,
			out: !pointInEnvelope(preview, p.armM, p.massKg),
		});
		return [
			...(load.takeoff
				? [{ id: 'to', kind: 'takeoff' as const, label: t.flightprep.pointTakeoff(Math.round(load.takeoff.massKg)), ...at(load.takeoff) }]
				: []),
			{ id: 'zf', kind: 'zeroFuel' as const, label: t.flightprep.zeroFuel, ...at(load.zeroFuel) },
		];
	});
	const loadTravel = $derived(
		load?.takeoff ? [cgTravel(load.takeoff, load.slots, load.fuelL, load.densityKgPerL)] : [],
	);

	/* Tanks come two at a time or not at all (one tank is the fuel arm): the
	 * first added takes the fuel arm and the fuel section's litres, and
	 * taking out the last but one leaves its arm as the fuel arm. */
	function addTank(): void {
		const m = draft.massBalance;
		if (!m) {
			return;
		}
		if (m.fuelTanks.length === 0) {
			m.fuelTanks.push(
				{ label: '', armM: m.fuelArmM, capacityL: draft.fuel?.capacityL ?? '', usableL: draft.fuel?.usableL ?? '' },
				blankFuelTankDraft(),
			);
			return;
		}
		m.fuelTanks.push(blankFuelTankDraft());
	}

	function removeTank(i: number): void {
		const m = draft.massBalance;
		if (!m) {
			return;
		}
		if (m.fuelTanks.length <= 2) {
			m.fuelArmM = m.fuelTanks[1 - i]?.armM ?? m.fuelArmM;
			m.fuelTanks = [];
			return;
		}
		m.fuelTanks.splice(i, 1);
	}
	// The mass limits typed below the envelope's top, as the flight
	// preparation draws them.
	const limits = $derived.by(() => {
		const m = draft.massBalance;
		const kg = (s: string | undefined): number | null => {
			const n = s === undefined || s.trim() === '' ? NaN : Number(s);
			return Number.isFinite(n) && n > 0 ? n : null;
		};
		const landing = kg(m?.maxLandingMassKg);
		const zeroFuel = kg(m?.maxZeroFuelMassKg);
		return [
			...(landing !== null ? [{ massKg: landing, label: t.flightprep.maxLandingLine }] : []),
			...(zeroFuel !== null ? [{ massKg: zeroFuel, label: t.flightprep.maxZeroFuelLine }] : []),
		];
	});

	// The section holding figures asks before it goes (the editor's question).
	const askRemove = askRemoval();
</script>

<div class="page">
	{#if draft.massBalance}
		{@const m = draft.massBalance}
		<div class="sect-head">
			<h4>{t.aircraft.pageMb}</h4>
			<button class="link-btn" onclick={() => askRemove('section', () => t.aircraft.pageMb, draft.massBalance, blankMassBalanceDraft(), () => (draft.massBalance = null))}>{t.aircraft.removeSection}</button>
		</div>
		<div class="cols">
			<div class="col">
				<section class="card">
					<h5>{t.aircraft.emptyAircraft}</h5>
					{#if fromGeneric}
						<p class="generic-hint">{t.aircraft.genericWeighingHint}</p>
					{/if}
					<label class="field">
						<span>{t.aircraft.emptyMass}</span>
						<input class="num" type="number" lang="en" min="1" required step={decimalStep(m.emptyMassKg)} value={m.emptyMassKg} oninput={(e) => (m.emptyMassKg = v(e))} />
						<span class="unit">kg</span>
					</label>
					<label class="field">
						<span>{t.aircraft.emptyArm}</span>
						<input class="num" type="number" lang="en" required step={decimalStep(m.emptyArmM)} value={m.emptyArmM} oninput={(e) => (m.emptyArmM = v(e))} />
						<span class="unit">m</span>
					</label>
					{#if m.fuelTanks.length === 0}
						<label class="field">
							<span>{t.aircraft.fuelArm}</span>
							<input class="num" type="number" lang="en" required step={decimalStep(m.fuelArmM)} value={m.fuelArmM} oninput={(e) => (m.fuelArmM = v(e))} />
							<span class="unit">m</span>
						</label>
					{/if}
				</section>
				<section class="card">
					<h5>{t.aircraft.massLimits}</h5>
					<label class="field">
						<span>{t.aircraft.maxLandingMass}</span>
						<input class="num" type="number" lang="en" min="1" step={decimalStep(m.maxLandingMassKg)} value={m.maxLandingMassKg} oninput={(e) => (m.maxLandingMassKg = v(e))} />
						<span class="unit">kg</span>
					</label>
					<label class="field">
						<span>{t.aircraft.maxZeroFuelMass}</span>
						<input class="num" type="number" lang="en" min="1" step={decimalStep(m.maxZeroFuelMassKg)} value={m.maxZeroFuelMassKg} oninput={(e) => (m.maxZeroFuelMassKg = v(e))} />
						<span class="unit">kg</span>
					</label>
					<p class="hint">{t.aircraft.massLimitsHint}</p>
				</section>
				<section class="card">
					<h5>{t.aircraft.stations}</h5>
					{#if m.stations.length > 0}
						<!-- Four columns are about a phone's width: the table pans in
						     its own scroller, never the whole editor. -->
						<div class="table-scroll">
						<table
							class="etable stations"
							use:gridPaste={{
								grow: (_grid: string, rows: number) => {
									while (m.stations.length < rows) {
										m.stations.push(blankStationDraft());
									}
								},
							}}
						>
							<thead>
								<tr>
									<th>{t.aircraft.station}</th>
									<th>{t.aircraft.armM}</th>
									<th>{t.aircraft.defaultKg}</th>
									<th>{t.aircraft.maxKg}</th>
									<th class="plain"></th>
								</tr>
							</thead>
							<tbody>
								{#each m.stations as s, i (i)}
									<tr>
										<td><input class="text-cell" type="text" autocapitalize="sentences" required pattern={SOME_TEXT} data-row={i} data-col="0" aria-label={t.aircraft.ariaStationName(i + 1)} value={s.label} oninput={(e) => (m.stations[i].label = v(e))} /></td>
										<td><input class="cell" type="number" lang="en" required data-row={i} data-col="1" aria-label={t.aircraft.ariaStationArm(s.label || String(i + 1))} step={decimalStep(s.armM)} value={s.armM} oninput={(e) => (m.stations[i].armM = v(e))} /></td>
										<td><input class="cell" type="number" lang="en" min="0" required data-row={i} data-col="2" aria-label={t.aircraft.ariaStationMass(s.label || String(i + 1))} step={decimalStep(s.defaultMassKg)} value={s.defaultMassKg} oninput={(e) => (m.stations[i].defaultMassKg = v(e))} /></td>
										<td><input class="cell" type="number" lang="en" min="1" data-row={i} data-col="3" aria-label={t.aircraft.ariaStationMax(s.label || String(i + 1))} step={decimalStep(s.maxMassKg)} value={s.maxMassKg} oninput={(e) => (m.stations[i].maxMassKg = v(e))} /></td>
										<td class="plain">
											<button class="icon" title={t.aircraft.removeStationTip} onclick={() => m.stations.splice(i, 1)}>
												<Icon name="x" size={13} />
											</button>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
						</div>
					{/if}
					<button class="add-btn" onclick={() => m.stations.push(blankStationDraft())}>
						<Icon name="plus" size={12} />
						{t.aircraft.addStation}
					</button>
					<p class="hint">{t.aircraft.stationMaxHint}</p>
				</section>
				<section class="card">
					<h5>{t.aircraft.fuelTanks}</h5>
					{#if m.fuelTanks.length > 0}
						<div class="table-scroll">
						<table
							class="etable tanks"
							use:gridPaste={{
								grow: (_grid: string, rows: number) => {
									while (m.fuelTanks.length < rows) {
										m.fuelTanks.push(blankFuelTankDraft());
									}
								},
							}}
						>
							<thead>
								<tr>
									<th>{t.aircraft.tank}</th>
									<th>{t.aircraft.armM}</th>
									<th>{t.aircraft.tankCapacityL}</th>
									<th>{t.aircraft.tankUsableL}</th>
									<th class="plain"></th>
								</tr>
							</thead>
							<tbody>
								{#each m.fuelTanks as tk, i (i)}
									<tr>
										<td><input class="text-cell" type="text" autocapitalize="sentences" required pattern={SOME_TEXT} data-row={i} data-col="0" aria-label={t.aircraft.ariaTankName(i + 1)} value={tk.label} oninput={(e) => (m.fuelTanks[i].label = v(e))} /></td>
										<td><input class="cell" type="number" lang="en" required data-row={i} data-col="1" aria-label={t.aircraft.ariaTankArm(tk.label || String(i + 1))} step={decimalStep(tk.armM)} value={tk.armM} oninput={(e) => (m.fuelTanks[i].armM = v(e))} /></td>
										<td><input class="cell" type="number" lang="en" min="1" required data-row={i} data-col="2" aria-label={t.aircraft.ariaTankCapacity(tk.label || String(i + 1))} step={decimalStep(tk.capacityL)} value={tk.capacityL} oninput={(e) => (m.fuelTanks[i].capacityL = v(e))} /></td>
										<!-- Empty is the capacity, which the placeholder shows and
										     the spinner steps from. -->
										<td><input class="cell" type="number" lang="en" min="1" data-row={i} data-col="3" aria-label={t.aircraft.ariaTankUsable(tk.label || String(i + 1))} placeholder={tk.capacityL} step={decimalStep(tk.usableL || tk.capacityL)} value={tk.usableL} oninput={(e) => (m.fuelTanks[i].usableL = v(e))} /></td>
										<td class="plain">
											<button class="icon" title={t.aircraft.removeTankTip} onclick={() => removeTank(i)}>
												<Icon name="x" size={13} />
											</button>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
						</div>
					{/if}
					<button class="add-btn" onclick={addTank}>
						<Icon name="plus" size={12} />
						{t.aircraft.addTank}
					</button>
					<p class="hint">{t.aircraft.fuelTanksHint}</p>
				</section>
			</div>
			<div class="col">
				<section class="card">
					<h5>{t.aircraft.cgEnvelope}</h5>
					<table
						class="etable"
						use:gridPaste={{
							grow: (_grid: string, rows: number) => {
								while (m.envelope.length < rows) {
									m.envelope.push(blankEnvelopePointDraft());
								}
							},
						}}
					>
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
									<td><input class="cell" type="number" lang="en" required data-row={i} data-col="0" aria-label={t.aircraft.ariaVertexArm(i + 1)} step={decimalStep(p.armM)} value={p.armM} oninput={(e) => (m.envelope[i].armM = v(e))} /></td>
									<td><input class="cell" type="number" lang="en" min="1" required data-row={i} data-col="1" aria-label={t.aircraft.ariaVertexMass(i + 1)} step={decimalStep(p.massKg)} value={p.massKg} oninput={(e) => (m.envelope[i].massKg = v(e))} /></td>
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
					<p class="hint">{t.aircraft.pasteHint}</p>
					{#if preview.length >= 3}
						<CgEnvelopeChart envelope={preview} points={loadPoints} travel={loadTravel} {limits} heightPx={240} />
						{#if loadPoints.length > 0}
							<p class="hint">{t.aircraft.defaultLoadHint}</p>
						{/if}
					{/if}
					<PlausibilityList {warnings} />
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
	/* Two columns as wide as a form needs, left-aligned: a wide window
	   leaves the space after them empty rather than stretching the boxes and
	   the chart. The page's head ends where they do. */
	.page {
		--cols-w: calc(2 * 560px + 12px);

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

	.page > .sect-head {
		max-inline-size: var(--cols-w);
	}

	.cols {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		flex-wrap: wrap;
		max-inline-size: var(--cols-w);
	}

	.col {
		flex: 1 1 450px;
		min-width: 320px;
		max-inline-size: 560px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	/* Screen only: paper never clips the table. */
	@media screen {
		.table-scroll {
			overflow-x: auto;
		}
	}

	/* The cards are flat sections (styles/workbook.css), and the two columns
	   sit side by side from 912 px of the editor's body, its query container:
	   two 450 px bases (the stations table's width, its headers in French)
	   and the 12 px gap. Side by side a card keeps to its
	   column, a hairline bleeding to the window's edges crossing the gutter
	   into the other one, and nothing follows a column's last card. Stacked,
	   the second column's first card follows the first column's last, which
	   keeps the hairline a page's last card goes without. Screen only. */
	@media screen {
		@container (width >= 912px) {
			.col > .card {
				margin-inline: 0;
				padding-inline: 0;
			}
		}

		@container (width < 912px) {
			.col:not(:last-child) > .card:last-child {
				border-bottom-width: 1px;
			}
		}
	}

	/* A copy of a generic sheet starts with its empty point blank: this says
	   where the figures come from. */
	.generic-hint {
		margin: 0 0 6px;
		font-size: 12px;
		color: var(--workbook-orange);
	}
</style>
