<script lang="ts">
	/* Mass & balance: the station table (mass x arm = moment) with editable
	 * loads, the fuel mode (full tanks / minimum for the plan / to tabs /
	 * custom) and burn-off mode (all fuel / trip only), the takeoff /
	 * burn-off / landing rows, and the CG envelope chart with the takeoff,
	 * landing and zero-fuel points plus the fuel-burn CG travel line. */

	import {
		selectedAircraft,
		tankedFuelType,
		tankedFuelDensityKgPerL,
	} from '$lib/state/aircraft.svelte';
	import { flightPrep, setMb, setMbLoad, type MbFuelMode } from '$lib/state/flightPrep.svelte';
	import { FUEL_TYPE_INFO, aircraftKey } from '$lib/aircraft/schema';
	import { cgTravel } from '$lib/aircraft/massBalance';
	import { fuelComputation, mbComputation, fmtArm } from './shared';
	import CgEnvelopeChart, { type CgPoint } from './CgEnvelopeChart.svelte';
	import { printValue } from '$lib/ui/printValue';
	import { t } from '$lib/state/i18n.svelte';

	const aircraft = $derived(selectedAircraft());
	const fuel = $derived(fuelComputation());
	const mb = $derived(mbComputation(fuel));

	// Radio groups are document-wide by name: the print doc mounts a second
	// copy of this page, so the group name must be per-instance or the browser
	// unchecks the on-screen radio when the copy mounts.
	const uid = $props.id();

	const tabsPreset = $derived(aircraft?.fuel?.presets.find((p) => p.name === 'tabs') ?? null);

	const points = $derived.by((): CgPoint[] => {
		if (!mb) {
			return [];
		}
		const r = mb.result;
		return [
			{ label: t.flightprep.pointTakeoff(Math.round(r.takeoff.massKg)), armM: r.takeoff.armM, massKg: r.takeoff.massKg, out: !r.takeoffInside },
			{ label: t.flightprep.pointLanding(Math.round(r.landing.massKg)), armM: r.landing.armM, massKg: r.landing.massKg, out: !r.landingInside },
			{ label: t.flightprep.zeroFuel, armM: r.zeroFuel.armM, massKg: r.zeroFuel.massKg, out: !r.zeroFuelInside },
		];
	});

	const travel = $derived(
		mb ? cgTravel(mb.result.takeoff, mb.aircraft.massBalance!.fuelArmM, mb.result.fuelMassKg) : [],
	);

	const allInside = $derived(
		mb !== null && mb.result.takeoffInside && mb.result.landingInside && mb.result.zeroFuelInside,
	);

	function numOrNull(e: Event): number | null {
		const v = Number.parseFloat((e.target as HTMLInputElement).value);
		return Number.isFinite(v) && v >= 0 ? v : null;
	}

	function fuelModeLabel(mode: MbFuelMode): string {
		switch (mode) {
			case 'full':
				return t.flightprep.modeFull(aircraft?.fuel?.usableL ?? '?');
			case 'minimum':
				return t.flightprep.modeMinimum;
			case 'tabs':
				return `${tabsPreset?.label ?? t.flightprep.modeTabs} (${tabsPreset?.litres ?? '?'} L)`;
			case 'custom':
				return t.flightprep.modeCustom;
		}
	}

	const fuelModes = $derived.by((): MbFuelMode[] => {
		const modes: MbFuelMode[] = ['full', 'minimum'];
		if (tabsPreset) {
			modes.push('tabs');
		}
		modes.push('custom');
		return modes;
	});
</script>

<div class="page fp-page">
	{#if !aircraft}
		<p class="muted">{t.flightprep.selectForMb}</p>
	{:else if !mb}
		<p class="muted">
			{t.flightprep.noMbSheet(aircraft.identity.registration ?? aircraft.identity.type)}
		</p>
	{:else}
		<div class="main">
			<fieldset class="modes">
				<legend>{t.flightprep.fuelAtTakeoff}</legend>
				{#each fuelModes as mode (mode)}
					<label class="radio">
						<input
							type="radio"
							name="fuel-mode-{uid}"
							checked={flightPrep.mb.fuelMode === mode}
							use:printValue={flightPrep.mb.fuelMode === mode}
							onchange={() => setMb({ fuelMode: mode })}
						/>
						<span>{fuelModeLabel(mode)}</span>
					</label>
				{/each}
				{#if flightPrep.mb.fuelMode === 'custom'}
					<label class="custom-litres">
						<input
							class="num"
							type="number"
							min="0"
							step="1"
							value={flightPrep.mb.customLitres ?? ''}
							use:printValue={flightPrep.mb.customLitres ?? ''}
							oninput={(e) => setMb({ customLitres: numOrNull(e) })}
						/>
						<span>L</span>
					</label>
				{/if}
				{#if !mb.fuelResolved}
					<p class="muted small">
						{#if flightPrep.mb.fuelMode === 'minimum'}
							{t.flightprep.noFeasibleYet}
						{:else}
							{t.flightprep.fuelUnresolved}
						{/if}
					</p>
				{/if}
			</fieldset>

			<!-- The station table is the one part with an irreducible width:
				 five numeric columns that must not wrap. It scrolls on its own so
				 the workbook around it does not (PerformancePage's .grid-wrap). -->
			<div class="mb-wrap">
				<table class="mb-table">
				<thead>
					<tr>
						<th class="rowhead"></th>
						<th>{t.flightprep.massKg}</th>
						<th>{t.flightprep.armM}</th>
						<th>{t.flightprep.momentKgM}</th>
					</tr>
				</thead>
				<tbody>
					{#each mb.result.rows as row, i (row.kind + row.label)}
						<tr>
							<th class="rowhead">
								{row.kind === 'empty'
									? t.flightprep.rowEmpty
									: row.kind === 'fuel'
										? t.flightprep.rowFuel
										: row.label}
							</th>
							<td>
								{#if row.kind !== 'station'}
									{row.massKg.toFixed(1)}
								{:else}
									<!-- The station's own default mass is the load in force until
									     one is typed, so the box shows it as a placeholder; the
									     span carries the mass onto the sheet, where neither a
									     placeholder nor an empty box prints, in the column's own
									     format (styles/workbook.css). -->
									<input
										class="num"
										type="number"
										min="0"
										step="1"
										value={flightPrep.mb.loads[row.label] ?? ''}
										placeholder={String(mb.aircraft.massBalance!.stations[i - 1]?.defaultMassKg ?? 0)}
										oninput={(e) => setMbLoad(row.label, numOrNull(e))}
									/><span class="print-value">{row.massKg.toFixed(1)}</span>
								{/if}
							</td>
							<td>{fmtArm(row.armM)}</td>
							<td>{row.momentKgM.toFixed(2)}</td>
						</tr>
					{/each}
					<tr class="total" class:bad={!mb.result.takeoffInside}>
						<th class="rowhead">{t.flightprep.takeoff}</th>
						<td>{mb.result.takeoff.massKg.toFixed(1)}</td>
						<td>{fmtArm(mb.result.takeoff.armM)}</td>
						<td>{mb.result.takeoff.momentKgM.toFixed(2)}</td>
					</tr>
					<tr>
						<th
							class="rowhead"
							title={mb.tripBurnMin != null
								? t.flightprep.tripBurnTip(Math.round(mb.tripBurnMin))
								: t.flightprep.noTripBurnTip}
						>
							{t.flightprep.burnOffRow}
						</th>
						<td>{mb.result.burnMassKg.toFixed(1)}</td>
						<td>{fmtArm(mb.aircraft.massBalance!.fuelArmM)}</td>
						<td>{(mb.result.burnMassKg * mb.aircraft.massBalance!.fuelArmM).toFixed(2)}</td>
					</tr>
					<tr class="total" class:bad={!mb.result.landingInside}>
						<th class="rowhead">{t.flightprep.landing}</th>
						<td>{mb.result.landing.massKg.toFixed(1)}</td>
						<td>{fmtArm(mb.result.landing.armM)}</td>
						<td>{mb.result.landing.momentKgM.toFixed(2)}</td>
					</tr>
					<tr class:bad={!mb.result.zeroFuelInside}>
						<th class="rowhead" title={t.flightprep.zeroFuelTip}>
							{t.flightprep.zeroFuel}
						</th>
						<td>{mb.result.zeroFuel.massKg.toFixed(1)}</td>
						<td>{fmtArm(mb.result.zeroFuel.armM)}</td>
						<td>{mb.result.zeroFuel.momentKgM.toFixed(2)}</td>
					</tr>
				</tbody>
				</table>
			</div>

			<!-- One sentence per line: fuel loaded, burn-off, plan minimum. The
			     no-trip caveat rides the burn-off line it qualifies; the minimum
			     line shows only when the refuelling plan resolves one. -->
			<div class="fuel-note muted">
				<p>
					{t.flightprep.fuelNote({
						litres: mb.fuelL.toFixed(0),
						grade: FUEL_TYPE_INFO[tankedFuelType(aircraftKey(mb.aircraft), mb.aircraft.fuel!)]
							.label,
						density: tankedFuelDensityKgPerL(aircraftKey(mb.aircraft), mb.aircraft.fuel!),
						kg: mb.result.fuelMassKg.toFixed(1),
					})}
				</p>
				<p>
					{t.flightprep.burnNote({
						litres: mb.burnL.toFixed(0),
						kg: mb.result.burnMassKg.toFixed(1),
					})}
					{#if !mb.burnResolved}
						{t.flightprep.noTripNote}
					{/if}
				</p>
				{#if mb.minimumL != null}
					<p>{t.flightprep.minimumNote(Math.round(mb.minimumL))}</p>
				{/if}
			</div>
		</div>

		<div class="chart">
			<h3>{t.flightprep.cgEnvelope}</h3>
			<CgEnvelopeChart envelope={mb.aircraft.massBalance!.envelope} {points} {travel} />
			<p class={allInside ? 'verdict ok' : 'verdict danger'}>
				{#if allInside}
					{t.flightprep.withinEnvelope}
				{:else}
					{t.flightprep.outsideEnvelope(
						[
							!mb.result.takeoffInside ? t.flightprep.takeoffLower : null,
							!mb.result.landingInside ? t.flightprep.landingLower : null,
							!mb.result.zeroFuelInside ? t.flightprep.zeroFuelLower : null,
						]
							.filter(Boolean)
							.join(', '),
					)}
				{/if}
			</p>
		</div>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 14px;
		max-width: 560px;

		/* The shared workbook .num (styles/workbook.css) at this page's
		   column width; .muted rides the same file. */
		--num-w: 80px;
	}

	/* Rides class "muted"; the pairing outranks the shared 13px
	   .fp-page .muted (styles/workbook.css) whatever the bundle order. */
	.muted.small {
		font-size: 12px;
		margin: 4px 0 0;
	}

	.modes {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 8px 12px;
		display: flex;
		flex-wrap: wrap;
		gap: 4px 16px;
		font-size: 12.5px;
	}

	.modes legend {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted);
		padding: 0 4px;
	}

	.radio {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		cursor: pointer;
	}

	.custom-litres {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	/* Screen only: on paper the sheet is wide enough, and a scroll container
	   would clip the table at the page edge. */
	@media screen {
		.mb-wrap {
			overflow-x: auto;
		}
	}

	/* Document-style table: strong outer frame + strong legend rules, light
	   inner grid, tabular figures (see FuelPlanPage). */
	.mb-table {
		border-collapse: collapse;
		border: 2px solid var(--border-strong);
		font-size: 12.5px;
		font-variant-numeric: tabular-nums;
		width: 100%;
	}

	.mb-table th,
	.mb-table td {
		border: 1px solid var(--border);
		padding: 3px 8px;
		text-align: right;
		white-space: nowrap;
	}

	.mb-table thead th {
		background: var(--surface-2);
		font-weight: 600;
		border-bottom: 2px solid var(--border-strong);
	}

	.mb-table .rowhead {
		text-align: left;
		font-weight: 500;
		background: var(--surface-2);
		border-right: 2px solid var(--border-strong);
	}

	tr.total td,
	tr.total .rowhead {
		font-weight: 700;
		background: var(--surface-3);
	}

	tr.bad td {
		color: var(--danger);
	}

	/* Rides class "muted"; the pairing outranks the shared 13px
	   .fp-page .muted (styles/workbook.css) whatever the bundle order. */
	.fuel-note.muted {
		font-size: 12px;
		margin: 0;
	}

	/* One sentence per line, tightly stacked. */
	.fuel-note p {
		margin: 0;
	}

	.chart h3 {
		margin: 0 0 6px;
		font-size: 13px;
	}

	.verdict {
		font-size: 12.5px;
		font-weight: 600;
		margin: 4px 0 0;
	}

	.verdict.ok {
		color: var(--status-active);
	}

	.verdict.danger {
		color: var(--danger);
	}

	/* Layout-inert on screen and in the portrait per-page print (its children
	   stay direct .page flex items); the pack print turns it into the left
	   column beside the chart. */
	.main {
		display: contents;
	}

	@media print {
		/* Packs (landscape): the loads column and the CG envelope side by
		   side on one sheet. The left column keeps its on-screen width; the
		   chart (a viewBox SVG at width 100%) scales into the rest. */
		:global(html.flight-prep-doc) .page {
			flex-direction: row;
			align-items: flex-start;
			gap: 8mm;
			max-width: none;
		}

		:global(html.flight-prep-doc) .main {
			display: flex;
			flex: 0 0 150mm;
			flex-direction: column;
			gap: 14px;
			min-width: 0;
		}

		:global(html.flight-prep-doc) .chart {
			flex: 1 1 0;
			min-width: 0;
			break-inside: avoid;
		}
	}
</style>
