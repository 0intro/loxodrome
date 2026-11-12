<script lang="ts">
	/* The fuel plan ("bilan carburant"): ONE table, a column per trip
	 * (FuelTable: what each trip burns and must land with, the club form's
	 * rows with the pilot's minutes typed in place, then the fuel at each
	 * takeoff, set here or on the trip's sheet on the M&B page, one state,
	 * and what is left), then the refuelling advice: the recommendation
	 * among every stopover subset flown at its minimum loads, within the
	 * usable fuel, the aerodromes and the mass and CG limits, why the
	 * cheapest lost its place, the flight without refuelling, and the whole
	 * comparison behind a toggle, on screen only. Minutes come from the
	 * routes + the route settings' cruise speed and wind. */

	import { routes, routeSettings } from '$lib/state/route.svelte';
	import {
		automaticCruiseFrom,
		effectiveConsumptionLph,
		effectiveCruiseSpeedKt,
		planCruiseSetting,
		selectedAircraft,
	} from '$lib/state/aircraft.svelte';
	import { tripWindBases } from './windBasis';
	import { fuelBasisLines } from './fuelBasis';
	import { orphanAlternates } from '$lib/aircraft/trips';
	import { waypointLabel } from '$lib/route/navlog';
	import { ceilLitres, type RefuelStrategy } from '$lib/aircraft/fuel';
	import {
		alternateFuel,
		firstPerIdent,
		fuelComputation,
		refuelPoints,
		tripLoadsComputation,
		servedRecommendation,
		strategyChecks,
		strategyIsFlyable,
		strategyIsServed,
		fmtHHMM,
		type RefuelPoint,
	} from './shared';
	import { ensureAerodromeFuel } from '$lib/state/data.svelte';
	import type { IndexedNotam } from '$lib/state/notam.svelte';
	import type { FuelRefusal } from '$lib/data/fuel';
	import type { StrategyCheck } from '$lib/aircraft/tripLoads';
	import { accessText, plannedFuelLookup, refusalParts, refusalText } from './stopFuel';
	import { applyStrategy } from './takeoffFuel';
	import { num1, takeoffAt } from './tripText';
	import FuelTable from './FuelTable.svelte';
	import NotamIdButton from '../detail/NotamIdButton.svelte';
	import { t } from '$lib/state/i18n.svelte';

	const fuel = $derived(fuelComputation());
	// What these figures were computed with (fuelBasis.ts): the wind the
	// allowances read and the cruise the plan burns at, said under the table
	// and on paper, so a plan on a hypothetical wind or speed says so where
	// its fuel is read.
	const basisLines = $derived(
		fuelBasisLines(tripWindBases(fuel), {
			custom: routeSettings.cruiseSpeedKt !== null || routeSettings.cruiseConsumptionLph !== null,
			setting: planCruiseSetting(),
			plane: automaticCruiseFrom(),
			kt: effectiveCruiseSpeedKt(),
			lph: effectiveConsumptionLph(),
		}),
	);

	/* Whether each takeoff point of the refuelling plan can serve this
	 * aeroplane. The plan itself is pure arithmetic and stays that way; this
	 * is the question it cannot ask, and it is answered only where the AIP
	 * was positive about the answer (stopFuel.ts, which the M&B page's
	 * refuel ticks read too). */
	$effect(() => {
		void ensureAerodromeFuel('fr').catch(() => {});
	});
	const myGrades = $derived(selectedAircraft()?.fuel?.types ?? []);
	const fuelAt = $derived(plannedFuelLookup());
	const refuelPts = $derived(refuelPoints(fuel, myGrades, fuelAt));

	/** The sentence a marked column carries, and the note under the table
	 *  repeats. Empty for a point the AIP says nothing about. */
	function fuelWarning(pt: RefuelPoint<IndexedNotam> | undefined): string | undefined {
		return pt?.ident && pt.refusal ? refusalText(pt.ident, pt.refusal, myGrades) : undefined;
	}

	/* The alternates this plan could not refuel at. Not a shortfall - the
	 * diversion is carried from the last stop - but an aeroplane that
	 * diverts lands on its final reserve and stays there. */
	const altFuel = $derived(alternateFuel(myGrades, fuelAt));

	/* The plan as the pilot fuels it (the table, the M&B sheets), and
	 * every refuelling strategy flown through the same chain at its own
	 * loads: computeRefuelPlan is fuel arithmetic alone, so this is where its
	 * takeoffs meet the mass and the CG. */
	const comp = $derived(tripLoadsComputation(fuel));
	const checks = $derived(strategyChecks(comp, fuel.refuel));
	const checkOf = (i: number): StrategyCheck | null => checks?.[i] ?? null;
	/** What the departure's tanks hold before its refuel, as read (null:
	 *  nobody stated it): a dry departure does not block a strategy whose
	 *  load it already holds. */
	const aboardL = $derived(comp?.input.departure.aboardL ?? null);

	/* The refuelling plan as the AERODROMES and the LIMITS leave it.
	 * computeRefuelPlan recommends on fuel quantities alone, so it will name a
	 * stop this same page marks as having none, or a load the takeoff cannot
	 * carry; `best` is the same rule asked again over the strategies that can
	 * actually be flown, and `demoted` keeps the arithmetic answer visible
	 * with its reason rather than hiding it. */
	const servedRec = $derived(servedRecommendation(fuel.refuel, refuelPts, checks, aboardL));

	/** A strategy's fault that is the fuel already on board: its departure's
	 *  block flown with what is aboard (nothing is drained, its own load
	 *  being less) and that above the most the limits allow there. */
	function aboardFault(f: NonNullable<StrategyCheck['fault']>): boolean {
		return (
			aboardL !== null &&
			f.blockStart === 0 &&
			Math.abs(f.startL - aboardL) < 1e-6 &&
			aboardL > f.maxWithinL + 1e-6
		);
	}

	/** No strategy keeps the limits, and every one fails on the fuel already
	 *  on board at the departure: no refuelling choice cures that, only a
	 *  defuel or a lighter load. The most the limits allow there, else null. */
	const aboardOverMax = $derived.by((): number | null => {
		const faults = (checks ?? []).flatMap((c) => (c.fault ? [c.fault] : []));
		return faults.length > 0 && faults.every(aboardFault) ? Math.max(...faults.map((f) => f.maxWithinL)) : null;
	});

	/* The uplift points this plan cannot refuel at, in the table's own column
	 * order. Held as the refusals themselves and worded at the render, since
	 * the note links each NOTAM and a joined string cannot carry a button. */
	const refuelRefusals = $derived(
		firstPerIdent(
			refuelPts.flatMap((pt) =>
				pt.ident && pt.refusal ? [{ ident: pt.ident, refusal: pt.refusal }] : [],
			),
		),
	);
	/* The stops that CAN serve this aeroplane and state a condition on doing
	 * it. A refusal outranks a caution, so one aerodrome gets one line: LFCT
	 * is a dry field whose flags were read off its lubricant sentence, and
	 * "no fuel here" is the only thing worth saying about it. */
	const refuelCautions = $derived(
		firstPerIdent(
			refuelPts.flatMap((pt) => {
				if (!pt.ident || pt.refusal || !pt.access) {
					return [];
				}
				const text = accessText(pt.ident, pt.access);
				return text ? [{ ident: pt.ident, text }] : [];
			}),
		),
	);

	const aircraft = $derived(selectedAircraft());
	const orphans = $derived(orphanAlternates(routes.list));
	const litres = $derived(fuel.consumptionLph != null);

	// A trip with a time to plan (a route of two waypoints or more).
	const anyRow = $derived(fuel.inputs.length > 0);

	/** The stops the pilot refuels at, in the strategies' numbering (stop i is
	 *  the one before chain trip i + 1): the row that is their plan. */
	const pilotStops = $derived(
		comp ? comp.loads.trips.filter((tr) => tr.chainIndex > 0 && tr.fuelSet).map((tr) => tr.chainIndex - 1) : null,
	);

	function isPilotPlan(s: RefuelStrategy): boolean {
		return (
			pilotStops !== null &&
			s.stops.length === pilotStops.length &&
			s.stops.every((stop) => pilotStops.includes(stop))
		);
	}

	/** Take a strategy as the plan (takeoffFuel.ts applyStrategy): its stops
	 *  refuelled, at the Minimum where not refuelled yet, so the fuel table
	 *  reproduces the row; the departure and a kept stop as the pilot set
	 *  them, unless that breaks a limit the fuel decides. */
	function usePlan(s: RefuelStrategy): void {
		if (comp) {
			applyStrategy(comp, s);
		}
	}

	/** A quantity to LOAD, in whole litres rounded up: every litre figure on
	 *  this page is a minimum to embark (a requirement, a strategy load), and a
	 *  minimum rounded down would leave the aircraft short of it. */
	function fmtLoadL(l: number): string {
		return `${ceilLitres(l)}`;
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

	/** The strategies' takeoff column i: the departure, then each stop. */
	function takeoffLabel(i: number): string {
		return i === 0 ? depLabel(0) : stopLabel(i - 1);
	}

	/** A strategy's takeoff i as flown at its loads: the fuel at takeoff, and
	 *  where what is on board is known (a stop's arrival, the departure's
	 *  journey log), the uplift over it (whole litres, rounded up: a minimum
	 *  to load). More already aboard than the load: that, as carried, since
	 *  nothing is drained. */
	function cellOf(si: number, s: RefuelStrategy, i: number): { load: number | null; uplift: number | null; carried: boolean } {
		const load = loadFor(s, i);
		if (load === null) {
			const startL = checkOf(si)?.loads.trips[i]?.startL ?? null;
			return { load: startL, uplift: null, carried: true };
		}
		const flown = checkOf(si)?.takeoffs.find((x) => x.chainIndex === i);
		if (flown?.startL != null && flown.startL - ceilLitres(load) > 1e-6) {
			return { load: flown.startL, uplift: null, carried: true };
		}
		const up = s.feasible && flown?.upliftL != null ? ceilLitres(flown.upliftL) : null;
		return { load, uplift: up, carried: false };
	}

	function strategyLabel(s: RefuelStrategy): string {
		return s.stops.length === 0
			? t.flightprep.noRefuelling
			: t.flightprep.refuelAt(s.stops.map(stopLabel).join(' + '));
	}

	function loadFor(s: RefuelStrategy, tripIndex: number): number | null {
		return s.loads.find((l) => l.tripIndex === tripIndex)?.litres ?? null;
	}

	/** The flight without refuelling, said under the advice when it outgrows
	 *  the tanks. Within them it is the fewest refuels, so the arithmetic
	 *  recommendation, which the advice names already: as the recommendation,
	 *  or as the cheapest strategy passed over and why. */
	const noRefuelLine = $derived.by((): string | null => {
		const s = fuel.inputs.length > 1 ? fuel.refuel?.strategies.find((x) => x.stops.length === 0) : undefined;
		return s && !s.feasible
			? t.flightprep.withoutRefuelling({
					litres: fmtLoadL(s.maxLoadL),
					time: fmtHHMM(s.maxLoadMin),
					usable: fuel.usableFuelL ?? 0,
				})
			: null;
	});
</script>

<!-- One refusal, worded and linked: the sentence carries the reason and its
     NOTAM id is the way onto the NOTAM panel. Read by both the uplift note
     and the alternates list, so the two cannot come to say it differently. -->
{#snippet refusalLine(icao: string, refusal: FuelRefusal<IndexedNotam>)}
	{@const p = refusalParts(icao, refusal, myGrades)}
	<span>{p.head}{#if p.item}<NotamIdButton item={p.item} />{/if}{p.tail}</span>
{/snippet}

<div class="page fp-page">
	{#if !anyRow}
		<p class="muted">{t.flightprep.planRouteFuel}</p>
	{:else}
		<FuelTable {fuel} {comp} />
		<p class="basis">
			{#each basisLines as line, i (i)}
				<span class="basis-line {line.ink}">{line.text}</span>
			{/each}
		</p>

		{#if fuel.refuel && fuel.inputs.length > 1}
			<div class="refuel">
				<h3>{t.flightprep.refuelPlanHeading}</h3>
				<p class="recommend">
					{#if servedRec.best}
						{t.flightprep.recommendationLead} <strong>{strategyLabel(servedRec.best)}</strong>
						{t.flightprep.maxLoadOf({
							load: fmtLoadL(servedRec.best.maxLoadL),
							usable: fuel.usableFuelL ?? 0,
						})}
						{#if comp && !isPilotPlan(servedRec.best)}
							{@const best = servedRec.best}
							<button class="use-plan inline no-print" title={t.flightprep.useThisPlanTip} onclick={() => usePlan(best)}>
								{t.flightprep.useThisPlan}
							</button>
						{/if}
					{:else if servedRec.noneServed}
						<!-- The tank is big enough and the aerodromes are the
						     problem, which is a different answer from the one
						     below and calls for a different decision. -->
						<span class="warn">{t.flightprep.refuelNoneServed}</span>
					{:else if servedRec.noneWithinLimits}
						<!-- The aerodromes serve, the payload is the problem, or the
						     fuel already on board at the departure. -->
						<span class="danger"
							>{aboardOverMax !== null && aboardL !== null
								? t.flightprep.refuelNoneWithinLimitsAboard({
										at: takeoffAt(fuel, 0),
										aboard: num1(aboardL),
										max: aboardOverMax,
									})
								: t.flightprep.refuelNoneWithinLimits}</span
						>
					{:else}
						<span class="danger">{t.flightprep.noFeasible(fuel.usableFuelL ?? 0)}</span>
					{/if}
				</p>
				{#if servedRec.demoted && servedRec.demotedLimits?.fault}
					{@const f = servedRec.demotedLimits.fault}
					<!-- The arithmetic answer the limits cost its place: its own
					     loads put a trip out of a limit the fuel decides. -->
					<p class="demoted">
						{t.flightprep.refuelDemotedLead}
						<strong>{strategyLabel(servedRec.demoted)}</strong>{t.flightprep.refuelDemotedJoin}
						{aboardFault(f) && aboardL !== null
							? t.flightprep.refuelDemotedAboard({ at: takeoffAt(fuel, 0), aboard: num1(aboardL), max: f.maxWithinL })
							: f.why === 'massMax' && f.phase === 'takeoff'
							? t.flightprep.refuelDemotedMassMax({
									at: takeoffAt(fuel, f.trip),
									kg: num1(f.massKg),
									max: f.limitKg ?? 0,
									from: takeoffAt(fuel, f.blockStart),
									maxL: f.maxWithinL,
								})
							: t.flightprep.refuelDemotedLimits({ from: takeoffAt(fuel, f.blockStart), maxL: f.maxWithinL })}
					</p>
				{/if}
				{#if checks?.some((c) => c.payloadOut)}
					<p class="demoted">{t.flightprep.refuelPayloadOut}</p>
				{/if}
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
				<!-- What the AIP wants arranged at a stop that CAN serve. Under
				     the refusals and in muted ink, never the warning orange:
				     "you cannot fuel here" and "you must ring first" are
				     different facts, and a reader must tell them apart without
				     reading a word. -->
				{#if refuelCautions.length > 0}
					<p class="caution-lead">{t.flightprep.refuelCautionLead}</p>
					<ul class="uplift-caution">
						{#each refuelCautions as c (c.ident)}
							<li>{c.text}</li>
						{/each}
					</ul>
				{/if}
				{#if noRefuelLine}
					<p class="without">{noRefuelLine}</p>
				{/if}
				<!-- Every combination of stops, for whoever wants to weigh them:
				     on screen only, the advice above is what paper keeps. -->
				<details class="compare no-print">
					<summary>{t.flightprep.compareAllPlans(fuel.refuel.strategies.length)}</summary>
					<p class="note">{t.flightprep.refuelPlanNote}</p>
					<div class="table-wrap">
						<table class="fp-table strategies">
							<!-- The stops share one head, each column headed by its
							     aerodrome alone. "Refuel at LFAD (L)" repeated over every
							     column set each one's width by its longest word, so four
							     trips outgrew the portrait-width column and six the whole
							     landscape sheet, which then shrank the dossier with it
							     (French "Avitaillement à" the worst). -->
							<thead>
								<tr>
									<th class="rowhead" rowspan="2">{t.flightprep.strategy}</th>
									<th class="group" colspan={fuel.inputs.length}>{t.flightprep.fuelAtTakeoff} (L)</th>
									<th rowspan="2">{t.flightprep.maxLoad}</th>
									<th rowspan="2">{t.flightprep.withinUsable}</th>
									{#if checks && comp?.aircraft.massBalance}
										<th rowspan="2">{t.flightprep.rowWithinLimits}</th>
									{/if}
								</tr>
								<tr>
									{#each fuel.inputs as _unused, i (i)}
										{@const pt = refuelPts[i]}
										<th class:warn={pt?.serves === false} title={fuelWarning(pt)}>{takeoffLabel(i)}</th>
									{/each}
								</tr>
							</thead>
							<tbody>
								{#each fuel.refuel.strategies as s, si (s.stops.join('-'))}
									{@const blocked = !strategyIsServed(s, refuelPts, aboardL)}
									{@const check = checkOf(si)}
									{@const overLimits = s.feasible && check?.withinLimits === false}
									<tr>
										<!-- A row whose load lands under a marked column is not a
										     plan, so it wears the same mark as that column: the
										     table has to agree with itself. A row whose loads break
										     a mass or CG limit is not one either, in the danger
										     ink. -->
										<th
											class="rowhead"
											class:warn={blocked && !overLimits}
											class:danger={overLimits}
											title={overLimits
												? t.flightprep.refuelStrategyOverLimitsTip
												: blocked
													? t.flightprep.refuelStrategyBlockedTip
													: null}
										>
											{strategyLabel(s)}
											{#if isPilotPlan(s)}
												<!-- The pilot's own targets, not the row's minimum loads:
												     it says when they leave a trip short, or out of the
												     limits the row itself keeps. -->
												{@const short = comp?.loads.fuelSufficient === false}
												{@const over = comp?.loads.withinLimits === false}
												<span class="mine" class:danger={short || over}>
													{short
														? t.flightprep.yourPlanShort
														: over
															? t.flightprep.yourPlanOverLimits
															: t.flightprep.yourPlan}
												</span>
											{:else if comp && strategyIsFlyable(s, refuelPts, check, aboardL)}
												<button class="use-plan no-print" title={t.flightprep.useThisPlanTip} onclick={() => usePlan(s)}>
													{t.flightprep.useThisPlan}
												</button>
											{/if}
										</th>
										{#each fuel.inputs as _unused, i (i)}
											{@const c = cellOf(si, s, i)}
											<td class:carried={c.carried}>
												{#if c.load !== null}
													{c.carried ? num1(c.load) : fmtLoadL(c.load)}
												{/if}
												{#if c.uplift !== null}
													<span class="up">{t.flightprep.upliftShort(String(c.uplift))}</span>
												{/if}
											</td>
										{/each}
										<td title={t.flightprep.minEndurance(s.maxLoadMin)}>{fmtLoadL(s.maxLoadL)} L</td>
										<td class={s.feasible ? 'ok' : 'danger'}>{s.feasible ? t.flightprep.yes : t.flightprep.no}</td>
										{#if checks && comp?.aircraft.massBalance}
											<td
												class:ok={s.feasible && check?.withinLimits === true}
												class:danger={overLimits}
												class:box={overLimits}
											>
												{!s.feasible || !check || check.withinLimits === null
													? '—'
													: check.withinLimits
														? t.flightprep.yes
														: t.flightprep.noCaps}
											</td>
										{/if}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</details>
			</div>
		{/if}

		{#if altFuel.length > 0}
			<div class="alt-fuel">
				<h3>{t.flightprep.alternates}</h3>
				<p>{t.flightprep.alternateFuelNote}</p>
				<ul>
					{#each altFuel as a (a.ident)}
						{#if a.refusal}
							<li>{@render refusalLine(a.ident, a.refusal)}</li>
						{:else if a.access}
							<li class="caution">{accessText(a.ident, a.access)}</li>
						{/if}
					{/each}
				</ul>
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
	/* What the figures were computed with: under the table, on paper too, a
	   plan on a manual wind or its own speed in the manual ink. */
	.basis {
		margin: 6px 0 0;
		font-size: 11.5px;
		line-height: 1.35;
	}

	.basis-line {
		display: block;
	}

	.basis-line.muted {
		color: var(--text-muted);
	}

	.basis-line.manual {
		color: var(--workbook-orange);
	}

	.page {
		display: flex;
		flex-direction: column;
		gap: 14px;

		/* .muted and the comparison's .fp-table ride styles/workbook.css. */
	}

	/* Screen only (a scroll container on paper would clip at the page edge):
	   on a phone the comparison pans under its sticky row heads instead of
	   panning the whole page. */
	@media screen {
		.table-wrap {
			overflow-x: auto;
		}

		:global(:root.mobile-ui) .table-wrap .fp-table .rowhead {
			position: sticky;
			left: 0;
			z-index: 1;
		}
	}

	/* A failing verdict is boxed as well as inked (the M&B trips table's
	   rule), so it reads on a black-and-white printer. */
	.fp-table td.box {
		outline: 1.5px solid var(--danger);
		outline-offset: -3px;
	}

	/* The plan the pilot loaded, named on its strategy row; the others offer
	   to become it. */
	.mine {
		display: block;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--accent);
	}

	.mine.danger {
		color: var(--danger);
	}

	.use-plan {
		display: block;
		font: inherit;
		font-size: 11.5px;
		font-weight: 500;
		background: none;
		border: 0;
		padding: 0;
		color: var(--accent);
		cursor: pointer;
		text-align: left;
	}

	.use-plan:hover {
		text-decoration: underline;
	}

	/* The recommendation's own: beside its sentence rather than under a row
	   head. */
	.use-plan.inline {
		display: inline;
		margin-left: 8px;
		font-size: 12.5px;
	}

	:global(:root.touch-ui) .use-plan {
		min-height: 44px;
	}

	/* On a touch screen the recommendation's button takes a line of its own:
	   inline, its 44 px floor raised its line and opened a gap inside the
	   sentence (a button lays out as an inline block). */
	:global(:root.touch-ui) .use-plan.inline {
		display: block;
		margin-left: 0;
	}

	/* A strategy's takeoff as flown at its loads: the fuel at takeoff, its
	   uplift under it at a stop it refuels at, and at a stop it does not, the
	   fuel carried over, muted. */
	.strategies td .up {
		display: block;
		font-size: 11px;
		font-weight: 400;
		color: var(--text-muted);
	}

	.strategies td.carried {
		color: var(--text-muted);
	}

	/* The fuel tables' heads and row labels wrap when a table cannot fit its
	   column. The shared workbook cells never wrap (styles/workbook.css),
	   right for figures, but the labels grow with the plan and the language:
	   a table wider than its column ran off the portrait sheet, or off the
	   landscape one, where every engine then shrank the whole dossier to fit
	   it (six trips in French printed it at 70%). Auto layout wraps only when
	   it must, so a table that fits reads as before; the figures never break. */
	.page .fp-table th {
		white-space: normal;
	}

	/* The refuelling strategies' two-row head reads as one: every head sits
	   on the rule above the figures, and the stops' shared head is centred
	   over its columns with a light rule under it. */
	.strategies thead th {
		vertical-align: bottom;
	}

	.strategies th.group {
		text-align: center;
		border-bottom-width: 1px;
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
	   global-collision trap, one level down. A strategy the limits forbid
	   takes the danger ink the same way. */
	.refuel .fp-table .rowhead.warn {
		color: var(--workbook-orange);
	}

	.refuel .fp-table .rowhead.danger {
		color: var(--danger);
	}

	/* Its own class rather than the global .muted: app.css owns that name, and
	   this needs the gap that separates two lists as much as it needs the ink. */
	.caution-lead {
		margin: 8px 0 0;
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.uplift-caution {
		margin: 2px 0 0;
		padding-left: 18px;
		font-size: 12.5px;
	}

	.uplift-caution li,
	.alt-fuel li.caution {
		color: var(--text-muted);
	}

	.demoted {
		margin: 2px 0 0;
		font-size: 12.5px;
		color: var(--workbook-orange);
	}

	/* The refusals' lead. Its ink is the shared .fp-page .warn; its size and
	   margins it never had, having ridden the old `.refuel p` note rule, and
	   without one it took the body's 14 px and the browser's 1 em margins. It
	   reads like the recommendation above it, its list hanging 2 px under. */
	.refuel p.warn {
		margin: 6px 0 0;
		font-size: 12.5px;
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

	.alt-fuel h3,
	.refuel h3 {
		margin: 0 0 4px;
		font-size: 13px;
	}

	/* The refuelling plan's note by its class. As `.refuel p` it reached
	   every paragraph of the plan and, scoped, weighed (0,2,1) against their
	   (0,2,0): it overrode .recommend, .demoted, .caution-lead and the shared
	   .fp-page .warn, so the refusal lead and the demoted strategy printed
	   grey instead of orange. */
	.alt-fuel p,
	.refuel .note {
		margin: 0 0 6px;
		font-size: 12px;
		color: var(--text-muted);
	}

	/* The flight without refuelling, where no line above says it. */
	.without {
		margin: 6px 0 0;
		font-size: 12.5px;
	}

	/* Every combination of stops, folded under the advice. */
	.compare {
		margin-top: 10px;
	}

	.compare summary {
		font-size: 12.5px;
		font-weight: 500;
		color: var(--accent);
		cursor: pointer;
	}

	/* The touch floor by padding: a flex summary is no longer a list item,
	   which is what draws its disclosure triangle (the phone lost it). */
	:global(:root.touch-ui) .compare summary {
		box-sizing: border-box;
		min-height: 44px;
		padding-block: 12px;
	}

	.compare[open] summary {
		margin-bottom: 6px;
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
		/* The sheet's height must not depend on the platform's own face (the
		   Overview's rule, DossierPage): unpinned, Segoe UI's 1.33 em lines
		   pushed a one-trip plan's refuelling list onto a second sheet that
		   Adwaita Sans's 1.21 em kept on the first. Unitless, so every size
		   scales its own. */
		.page {
			line-height: 1.2;
		}

		/* The advice follows the table on its sheet, whole: where it moves to
		   the next, its top margin is the sheet's own, which both engines now
		   repeat on every page it runs onto. */
		.refuel {
			break-inside: avoid;
		}
	}
</style>
