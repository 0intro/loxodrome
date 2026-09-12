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
	import {
		alternateFuel,
		fuelComputation,
		refuelPoints,
		servedRecommendation,
		strategyIsServed,
		fmtHHMM,
		type RefuelPoint,
	} from './shared';
	import {
		ensureAerodromeFuel,
		fuelForIdent,
		fuelNotamIdents,
		resolveAerodromeFuel,
	} from '$lib/state/data.svelte';
	import type { IndexedNotam } from '$lib/state/notam.svelte';
	import { gradeLabel, type FuelOffering, type FuelRefusal } from '$lib/data/fuel';
	import NotamIdButton from '../detail/NotamIdButton.svelte';
	import { t } from '$lib/state/i18n.svelte';

	const fuel = $derived(fuelComputation());

	/* Whether each takeoff point of the refuelling plan can serve this
	 * aeroplane. The plan itself is pure arithmetic and stays that way; this
	 * is the question it cannot ask, and it is answered only where the AIP
	 * was positive about the answer. */
	$effect(() => {
		void ensureAerodromeFuel('fr').catch(() => {});
	});
	const myGrades = $derived(selectedAircraft()?.fuel?.types ?? []);
	/* Resolved rather than published: a grade a NOTAM has withdrawn is not
	 * one this stop can serve, and a plan made days ahead is where that
	 * matters most. The ident index is read ONCE per pass, not per stop. */
	const fuelNotams = $derived(fuelNotamIdents());
	const fuelAt = (icao: string): FuelOffering<IndexedNotam> | null =>
		fuelNotams.has(icao.toUpperCase())
			? resolveAerodromeFuel(icao, 'fr').fuel
			: fuelForIdent(icao, 'fr');
	const refuelPts = $derived(refuelPoints(fuel, myGrades, fuelAt));

	/** Why an aerodrome cannot serve this aeroplane, in words.
	 *
	 *  The four reasons read differently on purpose. The AIP's two are
	 *  permanent until the next cycle and the answer is to plan around
	 *  them; a NOTAM's two carry an id and a date and may be gone by the
	 *  flight, so the sheet names the NOTAM to go and read. */
	function refusalText(icao: string, refusal: FuelRefusal<IndexedNotam>): string {
		const grades = myGrades.map(gradeLabel).join(', ');
		switch (refusal.kind) {
			case 'aipNone':
				return t.flightprep.fuelNoneAt(icao);
			case 'aipGrade':
				return t.flightprep.fuelNotServed({ icao, grades });
			case 'notamAll':
				return t.flightprep.fuelNotamNoneAt({ icao, notam: refusal.by.notam.id });
			case 'notamGrade':
				return t.flightprep.fuelNotamGradeAt({
					icao,
					notam: refusal.by.notam.id,
					grades: refusal.grades.map(gradeLabel).join(', '),
				});
		}
	}

	/** The sentence a marked column carries, and the note under the table
	 *  repeats. Empty for a point the AIP says nothing about. */
	function fuelWarning(pt: RefuelPoint<IndexedNotam> | undefined): string | undefined {
		return pt?.ident && pt.refusal ? refusalText(pt.ident, pt.refusal) : undefined;
	}

	/** The same sentence, cut around its NOTAM id so the id can be the link
	 *  onto the NOTAM panel.
	 *
	 *  Cutting beats a pair of half-sentences in the catalogs: the id is a
	 *  locale-invariant token appearing exactly once, so each language keeps
	 *  its own word order and there is still one message to translate. The
	 *  AIP's two reasons name no NOTAM and come back whole, with no link. */
	function refusalParts(
		icao: string,
		refusal: FuelRefusal<IndexedNotam>,
	): { head: string; item: IndexedNotam | null; tail: string } {
		const text = refusalText(icao, refusal);
		const item =
			refusal.kind === 'notamAll' || refusal.kind === 'notamGrade' ? refusal.by : null;
		const at = item ? text.indexOf(item.notam.id) : -1;
		return item && at >= 0
			? { head: text.slice(0, at), item, tail: text.slice(at + item.notam.id.length) }
			: { head: text, item: null, tail: '' };
	}

	/* The alternates this plan could not refuel at. Not a shortfall - the
	 * diversion is carried from the last stop - but an aeroplane that
	 * diverts lands on its final reserve and stays there. */
	const altFuel = $derived(alternateFuel(myGrades, fuelAt));

	/* The refuelling plan as the AERODROMES leave it. computeRefuelPlan
	 * recommends on fuel quantities alone, so it will name a stop this same
	 * page marks as having none; `best` is the same rule asked again over the
	 * strategies that can actually be flown, and `demoted` keeps the
	 * arithmetic answer visible with its reason rather than hiding it. */
	const servedRec = $derived(servedRecommendation(fuel.refuel, refuelPts));

	/* The uplift points this plan cannot refuel at, in the table's own column
	 * order. Held as the refusals themselves and worded at the render, since
	 * the note links each NOTAM and a joined string cannot carry a button. */
	const refuelRefusals = $derived(
		refuelPts.flatMap((pt) =>
			pt.ident && pt.refusal ? [{ ident: pt.ident, refusal: pt.refusal }] : [],
		),
	);
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
	const inputColumns = $derived(fuel.inputColumns);

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

<!-- One refusal, worded and linked: the sentence carries the reason and its
     NOTAM id is the way onto the NOTAM panel. Read by both the uplift note
     and the alternates list, so the two cannot come to say it differently. -->
{#snippet refusalLine(icao: string, refusal: FuelRefusal<IndexedNotam>)}
	{@const p = refusalParts(icao, refusal)}
	<span>{p.head}{#if p.item}<NotamIdButton item={p.item} />{/if}{p.tail}</span>
{/snippet}

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

		{#if altFuel.length > 0}
			<div class="alt-fuel">
				<h3>{t.flightprep.alternates}</h3>
				<p>{t.flightprep.alternateFuelNote}</p>
				<ul>
					{#each altFuel as a (a.ident)}
						<li>{@render refusalLine(a.ident, a.refusal)}</li>
					{/each}
				</ul>
			</div>
		{/if}

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
								{@const pt = refuelPts[i]}
								<th class:warn={pt?.serves === false} title={fuelWarning(pt)}>
									{i === 0
										? t.flightprep.takeoffAt(depLabel(0))
										: t.flightprep.refuelAt(stopLabel(i - 1))} (L)
								</th>
							{/each}
							<th>{t.flightprep.maxLoad}</th>
							<th>{t.flightprep.withinUsable}</th>
						</tr>
					</thead>
					<tbody>
						{#each fuel.refuel.strategies as s (s.stops.join('-'))}
							{@const blocked = !strategyIsServed(s, refuelPts)}
							<tr>
								<!-- A row whose load lands under a marked column is not a
								     plan, so it wears the same mark as that column: the
								     table has to agree with itself. -->
								<th
									class="rowhead"
									class:warn={blocked}
									title={blocked ? t.flightprep.refuelStrategyBlockedTip : null}
								>{strategyLabel(s)}</th>
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
					{#if servedRec.best}
						{t.flightprep.recommendationLead} <strong>{strategyLabel(servedRec.best)}</strong>
						{t.flightprep.maxLoadOf({
							load: fmtRoundL(servedRec.best.maxLoadL),
							usable: fuel.usableFuelL ?? 0,
						})}
					{:else if fuel.refuel.recommended}
						<!-- The tank is big enough and the aerodromes are the
						     problem, which is a different answer from the one
						     below and calls for a different decision. -->
						<span class="warn">{t.flightprep.refuelNoneServed}</span>
					{:else}
						<span class="danger">{t.flightprep.noFeasible(fuel.usableFuelL ?? 0)}</span>
					{/if}
				</p>
				<!-- The arithmetic answer, where the aerodromes cost it its place.
				     Kept and explained rather than dropped: the fuel dataset is
				     read from the AIP's prose, and the reader is owed both facts
				     with the NOTAM one click away.

				     The joiner is "but" and not "where": the point that blocks a
				     strategy is often not the stop its label names. Every
				     strategy embarks at the DEPARTURE, so a dry departure blocks
				     "Refuel at LFAC" too, and "where" would pin the reason on
				     the wrong aerodrome. -->
				{#if servedRec.demoted && servedRec.demotedAt?.ident && servedRec.demotedAt.refusal}
					<p class="demoted">
						{t.flightprep.refuelDemotedLead}
						<strong>{strategyLabel(servedRec.demoted)}</strong>{t.flightprep.refuelDemotedJoin}
						{@render refusalLine(servedRec.demotedAt.ident, servedRec.demotedAt.refusal)}
					</p>
				{/if}
				<!-- Only the points the AIP is positive about. An aerodrome it
				     says nothing about raises nothing: a warning nobody can act
				     on is worse than silence, and the panel quotes the AIP. -->
				{#if refuelRefusals.length > 0}
					<p class="warn">{t.flightprep.refuelGradeLead}</p>
					<ul class="uplift-warn">
						{#each refuelRefusals as r (r.ident)}
							<li>{@render refusalLine(r.ident, r.refusal)}</li>
						{/each}
					</ul>
				{/if}
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

	.alt-fuel {
		margin-top: 10px;
	}

	.alt-fuel ul {
		margin: 0;
		padding-left: 18px;
		font-size: 12.5px;
	}

	.alt-fuel li {
		color: var(--workbook-orange);
	}

	/* The blocked strategy's own ink. styles/workbook.css colours .rowhead at
	   three classes, which outranks the shared .fp-page .warn at two, so the
	   row label would stay black beside its amber column head; the app.css
	   global-collision trap, one level down. */
	.refuel .fp-table .rowhead.warn {
		color: var(--workbook-orange);
	}

	.demoted {
		margin: 2px 0 0;
		font-size: 12.5px;
		color: var(--workbook-orange);
	}

	/* The uplift clauses, one per column the plan cannot refuel at. A list
	   rather than a comma-joined sentence now that each one carries its own
	   NOTAM link, and it reads the same on paper. */
	.uplift-warn {
		margin: 2px 0 0;
		padding-left: 18px;
		font-size: 12.5px;
	}

	.uplift-warn li {
		color: var(--workbook-orange);
	}

	.totals h3,
	.alt-fuel h3,
	.refuel h3 {
		margin: 0 0 4px;
		font-size: 13px;
	}

	.totals p,
	.alt-fuel p,
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
