<script lang="ts">
	/* The fuel plan ("bilan carburant"): one column per trip with the
	 * taxi / trip / procedure / wind-allowance burn-off, the alternate +
	 * discretionary margin + final reserve block, the single-tankful totals,
	 * and the refuelling plan (every stopover subset, feasibility against the
	 * usable fuel, recommendation). Inputs live on the page like the source
	 * workbook; minutes come from the routes + the route settings' cruise
	 * speed and wind. */

	import { routes } from '$lib/state/route.svelte';
	import { setTripFuel, tripFuel } from '$lib/state/flightPrep.svelte';
	import { selectedAircraft } from '$lib/state/aircraft.svelte';
	import { orphanAlternates } from '$lib/aircraft/trips';
	import { waypointLabel } from '$lib/route/navlog';
	import type { FuelTripRow, RefuelStrategy } from '$lib/aircraft/fuel';
	import { fuelComputation, fmtHHMM } from './shared';
	import { t } from '$lib/state/i18n.svelte';

	const fuel = $derived(fuelComputation());
	const aircraft = $derived(selectedAircraft());
	const orphans = $derived(orphanAlternates(routes.list));
	const litres = $derived(fuel.consumptionLph != null);

	// Per-column plan row (null for a trip without computable time).
	const rowByColumn = $derived.by(() => {
		let k = 0;
		return fuel.columns.map((c) => (c.input ? fuel.plan.trips[k++] : null));
	});

	const anyRow = $derived(rowByColumn.some((r) => r !== null));

	/** Empty (or junk) -> null = automatic: the value aircraft/fuel.ts applies,
	 *  which is what the box shows as its placeholder. */
	function numOrNull(e: Event): number | null {
		const v = Number.parseFloat((e.target as HTMLInputElement).value);
		return Number.isFinite(v) && v >= 0 ? v : null;
	}

	function fmtRoundL(l: number): string {
		return `${Math.round(l)}`;
	}

	/** The refuel-stop label: the landing point of trip `stop`. */
	function stopLabel(stop: number): string {
		return fuel.inputs[stop]?.toLabel ?? t.flightprep.stopN(stop + 1);
	}

	// The computable columns, aligned with fuel.inputs (the same filter).
	const inputColumns = $derived(fuel.columns.filter((c) => c.input !== null));

	/** The departure label of computable trip `i`, from the route's first
	 *  waypoint (structured; the column label may be a custom route name,
	 *  so it is never split back apart). */
	function depLabel(i: number): string {
		const wps = inputColumns[i]?.trip.route.waypoints;
		return wps && wps.length > 0 ? waypointLabel(wps[0]) : (fuel.inputs[i]?.label ?? '');
	}

	function strategyLabel(s: RefuelStrategy): string {
		return s.stops.length === 0
			? t.flightprep.noRefuelling
			: t.flightprep.refuelAt(s.stops.map(stopLabel).join(' + '));
	}

	function loadFor(s: RefuelStrategy, tripIndex: number): number | null {
		return s.loads.find((l) => l.tripIndex === tripIndex)?.litres ?? null;
	}

	function reserveTitle(r: FuelTripRow): string {
		const parts = [];
		if (r.alternate) {
			parts.push(t.flightprep.minAlternate(r.alternate.timeMin + r.alternate.procedureMin));
		}
		parts.push(
			t.flightprep.minMargin(r.pilotMarginMin),
			t.flightprep.minFinalReserve(r.finalReserveMin),
		);
		if (r.alternate && r.alternate.windAllowanceMin > 0) {
			parts.push(t.flightprep.minAlternateWind(r.alternate.windAllowanceMin));
		}
		return parts.join(' + ');
	}
</script>

<div class="page fp-page">
	{#if !anyRow}
		<p class="muted">{t.flightprep.planRouteFuel}</p>
	{:else}
		<table class="fp-table">
			<thead>
				<tr>
					<th class="rowhead"></th>
					{#each fuel.columns as c (c.trip.route.id)}
						<th>{c.input?.label ?? '—'}</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				<tr>
					<th class="rowhead" title={t.flightprep.taxiTip}>{t.flightprep.taxiMin}</th>
					{#each fuel.columns as c, i (c.trip.route.id)}
						<td>
							{#if c.input}
								<input
									class="num"
									type="number"
									min="0"
									step="1"
									aria-label={t.flightprep.ariaFuelCell({ row: t.flightprep.taxiMin, trip: c.input?.label ?? '' })}
									value={tripFuel(c.trip.index).taxiMin ?? ''}
									placeholder={rowByColumn[i] ? String(rowByColumn[i].taxiMin) : ''}
									oninput={(e) => setTripFuel(c.trip.index, { taxiMin: numOrNull(e) })}
								/><span class="print-value">{rowByColumn[i]?.taxiMin ?? ''}</span>
							{:else}—{/if}
						</td>
					{/each}
				</tr>
				<tr>
					<th class="rowhead">{t.flightprep.trip}</th>
					{#each rowByColumn as r, i (fuel.columns[i].trip.route.id)}
						<td>{r ? r.tripMin : '—'}</td>
					{/each}
				</tr>
				<tr>
					<th class="rowhead">{t.flightprep.procedureMin}</th>
					{#each fuel.columns as c, i (c.trip.route.id)}
						<td>
							{#if c.input}
								<input
									class="num"
									type="number"
									min="0"
									step="1"
									aria-label={t.flightprep.ariaFuelCell({ row: t.flightprep.procedureMin, trip: c.input?.label ?? '' })}
									value={tripFuel(c.trip.index).procedureMin ?? ''}
									placeholder={rowByColumn[i] ? String(rowByColumn[i].procedureMin) : ''}
									oninput={(e) => setTripFuel(c.trip.index, { procedureMin: numOrNull(e) })}
								/><span class="print-value">{rowByColumn[i]?.procedureMin ?? ''}</span>
							{:else}—{/if}
						</td>
					{/each}
				</tr>
				<tr class="total">
					<th class="rowhead">{t.flightprep.burnOffStillAir}</th>
					{#each rowByColumn as r, i (fuel.columns[i].trip.route.id)}
						<td>{r ? r.burnOffStillAirMin : '—'}</td>
					{/each}
				</tr>
				<tr>
					<th class="rowhead">{t.flightprep.windAllowance}</th>
					{#each rowByColumn as r, i (fuel.columns[i].trip.route.id)}
						<td>{r ? r.windAllowanceMin || '' : '—'}</td>
					{/each}
				</tr>
				<tr class="total">
					<th class="rowhead">{t.flightprep.burnOffWithWind}</th>
					{#each rowByColumn as r, i (fuel.columns[i].trip.route.id)}
						<td>{r ? r.burnOffMin : '—'}</td>
					{/each}
				</tr>

				<tr class="section">
					<th class="rowhead">{t.flightprep.alternate}</th>
					{#each rowByColumn as r, i (fuel.columns[i].trip.route.id)}
						<td class="alt-label">{r?.alternate?.label ?? t.flightprep.none}</td>
					{/each}
				</tr>
				<tr>
					<th class="rowhead">{t.flightprep.alternateTime}</th>
					{#each rowByColumn as r, i (fuel.columns[i].trip.route.id)}
						<td>{r?.alternate ? r.alternate.timeMin : ''}</td>
					{/each}
				</tr>
				<tr>
					<th class="rowhead">{t.flightprep.alternateProcedureMin}</th>
					{#each fuel.columns as c, i (c.trip.route.id)}
						<td>
							{#if rowByColumn[i]?.alternate}
								<input
									class="num"
									type="number"
									min="0"
									step="1"
									aria-label={t.flightprep.ariaFuelCell({ row: t.flightprep.alternateProcedureMin, trip: c.input?.label ?? '' })}
									value={tripFuel(c.trip.index).altProcedureMin ?? ''}
									placeholder={String(rowByColumn[i]?.alternate?.procedureMin ?? '')}
									oninput={(e) => setTripFuel(c.trip.index, { altProcedureMin: numOrNull(e) })}
								/><span class="print-value">{rowByColumn[i]?.alternate?.procedureMin ?? ''}</span>
							{/if}
						</td>
					{/each}
				</tr>
				<tr>
					<th class="rowhead" title={t.flightprep.discretionaryTip}>{t.flightprep.discretionaryMargin}</th>
					{#each fuel.columns as c, i (c.trip.route.id)}
						<td>
							{#if c.input}
								<input
									class="num"
									type="number"
									min="0"
									step="1"
									aria-label={t.flightprep.ariaFuelCell({ row: t.flightprep.discretionaryMargin, trip: c.input?.label ?? '' })}
									value={tripFuel(c.trip.index).marginMin ?? ''}
									placeholder={rowByColumn[i] ? String(rowByColumn[i].pilotMarginMin) : ''}
									oninput={(e) => setTripFuel(c.trip.index, { marginMin: numOrNull(e) })}
								/><span class="print-value">{rowByColumn[i]?.pilotMarginMin ?? ''}</span>
							{:else}—{/if}
						</td>
					{/each}
				</tr>
				<tr>
					<th class="rowhead" title={t.flightprep.finalReserveTip}>
						{t.flightprep.finalReserveMin}
					</th>
					{#each fuel.columns as c, i (c.trip.route.id)}
						<td>
							{#if c.input}
								<input
									class="num"
									type="number"
									min="0"
									step="1"
									aria-label={t.flightprep.ariaFuelCell({ row: t.flightprep.finalReserveMin, trip: c.input?.label ?? '' })}
									value={tripFuel(c.trip.index).finalReserveMin ?? ''}
									placeholder={rowByColumn[i] ? String(rowByColumn[i].finalReserveMin) : ''}
									oninput={(e) => setTripFuel(c.trip.index, { finalReserveMin: numOrNull(e) })}
								/><span class="print-value">{rowByColumn[i]?.finalReserveMin ?? ''}</span>
							{:else}—{/if}
						</td>
					{/each}
				</tr>
				<tr>
					<th class="rowhead" title={t.flightprep.altWindTip}>
						{t.flightprep.alternateWindAllowance}
					</th>
					{#each rowByColumn as r, i (fuel.columns[i].trip.route.id)}
						<td>{r?.alternate ? r.alternate.windAllowanceMin || '' : ''}</td>
					{/each}
				</tr>
				<tr class="total">
					<th class="rowhead">{t.flightprep.reserveTotal}</th>
					{#each rowByColumn as r, i (fuel.columns[i].trip.route.id)}
						<td title={r ? reserveTitle(r) : undefined}>{r ? r.reserveWithWindMin : '—'}</td>
					{/each}
				</tr>
				<tr class="grand section">
					<th class="rowhead">{t.flightprep.totalMin}</th>
					{#each rowByColumn as r, i (fuel.columns[i].trip.route.id)}
						<td>{r ? r.totalMin : '—'}</td>
					{/each}
				</tr>
				{#if litres}
					<tr class="grand">
						<th class="rowhead">{t.flightprep.fuelL}</th>
						{#each rowByColumn as r, i (fuel.columns[i].trip.route.id)}
							<td>{r ? fmtRoundL(r.totalL) : '—'}</td>
						{/each}
					</tr>
				{/if}
			</tbody>
		</table>

		<div class="totals">
			<h3>{t.flightprep.minFuelHeading}</h3>
			<p>{t.flightprep.minFuelNote}</p>
			<dl>
				<dt>{t.flightprep.totalStillAir}</dt>
				<dd>{fuel.plan.totalStillAirMin} min ({fmtHHMM(fuel.plan.totalStillAirMin)})</dd>
				<dt>{t.flightprep.totalWithWind}</dt>
				<dd>{fuel.plan.totalMin} min ({fmtHHMM(fuel.plan.totalMin)})</dd>
				{#if litres}
					<dt>{t.flightprep.minimumFuel}</dt>
					<dd>
						{fmtRoundL(fuel.plan.totalL)} L
						{#if fuel.usableFuelL != null && fuel.plan.totalL > fuel.usableFuelL}
							<span class="danger">{t.flightprep.exceedsUsable(fuel.usableFuelL)}</span>
						{/if}
					</dd>
				{/if}
			</dl>
		</div>

		{#if fuel.refuel && fuel.inputs.length > 1}
			<div class="refuel">
				<h3>{t.flightprep.refuelPlanHeading}</h3>
				<p>{t.flightprep.refuelPlanNote}</p>
				<table class="fp-table">
					<thead>
						<tr>
							<th class="rowhead">{t.flightprep.strategy}</th>
							{#each fuel.inputs as _unused, i (i)}
								<th>{i === 0 ? t.flightprep.takeoffAt(depLabel(0)) : t.flightprep.refuelAt(stopLabel(i - 1))} (L)</th>
							{/each}
							<th>{t.flightprep.maxLoad}</th>
							<th>{t.flightprep.withinUsable}</th>
						</tr>
					</thead>
					<tbody>
						{#each fuel.refuel.strategies as s (s.stops.join('-'))}
							<tr>
								<th class="rowhead">{strategyLabel(s)}</th>
								{#each fuel.inputs as _unused, i (i)}
									{@const load = loadFor(s, i)}
									<td>{load != null ? fmtRoundL(load) : ''}</td>
								{/each}
								<td title={t.flightprep.minEndurance(s.maxLoadMin)}>{fmtRoundL(s.maxLoadL)} L</td>
								<td class={s.feasible ? 'ok' : 'danger'}>{s.feasible ? t.flightprep.yes : t.flightprep.no}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="recommend">
					{#if fuel.refuel.recommended}
						{t.flightprep.recommendationLead} <strong>{strategyLabel(fuel.refuel.recommended)}</strong>
						{t.flightprep.maxLoadOf({
							load: fmtRoundL(fuel.refuel.recommended.maxLoadL),
							usable: fuel.usableFuelL ?? 0,
						})}
					{:else}
						<span class="danger">{t.flightprep.noFeasible(fuel.usableFuelL ?? 0)}</span>
					{/if}
				</p>
			</div>
		{/if}

		{#if !litres}
			<p class="muted">
				{#if aircraft}
					{t.flightprep.noConsumption(aircraft.identity.registration ?? aircraft.identity.type)}
				{:else}
					{t.flightprep.selectForLitres}
				{/if}
			</p>
		{/if}

		{#if orphans.length > 0}
			<p class="muted">{t.flightprep.orphansIgnored(orphans.length)}</p>
		{/if}
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 14px;

		/* The shared workbook .num (styles/workbook.css) at this page's
		   column width; .muted and .fp-table ride the same file. */
		--num-w: 72px;
	}

	.fp-table .alt-label {
		font-weight: 600;
	}

	tr.section th,
	tr.section td {
		border-top: 2px solid var(--border-strong);
	}

	tr.total td,
	tr.total .rowhead {
		font-weight: 600;
		background: var(--surface-3);
	}

	tr.grand td,
	tr.grand .rowhead {
		font-weight: 700;
		background: var(--surface-3);
	}

	.totals h3,
	.refuel h3 {
		margin: 0 0 4px;
		font-size: 13px;
	}

	.totals p,
	.refuel p {
		margin: 0 0 6px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.totals dl {
		display: grid;
		grid-template-columns: auto auto;
		justify-content: start;
		gap: 2px 16px;
		margin: 0;
		font-size: 12.5px;
	}

	.totals dt {
		color: var(--text-muted);
	}

	.totals dd {
		margin: 0;
		font-weight: 600;
	}

	.recommend {
		font-size: 12.5px;
		margin: 6px 0 0;
	}

	/* Bolder than the shared workbook verdict inks (colour from
	   .fp-page .ok / .danger in styles/workbook.css). */
	.ok,
	.danger {
		font-weight: 600;
	}

	@media print {
		/* The refuelling plan starts its own sheet in every print mode. Its
		   own top padding stands in for the container's, which the fragment
		   after a forced break does not carry (the @page margin is zero; the
		   container padding is the real margin). */
		.refuel {
			break-before: page;
			padding-top: 12mm;
		}
	}
</style>
