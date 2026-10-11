<script lang="ts">
	/* The fuel plan in one table (docs/flight-preparation.md "Fuel plan"):
	 * one column per trip, each a time | litres pair, the way OzRunways,
	 * AvPlan and an operational flight plan lay theirs out, every figure
	 * once. Down each column, what the trip needs: its burn-off and the
	 * reserve it must land with, each folding on screen into its total, their
	 * parts the club form's rows with the pilot's minutes typed in place
	 * (aircraft/fuel.ts applies the defaults the placeholders show); then
	 * what is aboard: the takeoff's one fuel control (the same the trip's
	 * sheet on the M&B page shows, one state), what arrives, the uplift, the
	 * window the fuel must fall in, the fuel at takeoff; then what is left:
	 * the fuel at landing, how far above the reserve, the verdicts. Under it,
	 * the lines saying what fails and what cures it, and the refuelling list.
	 * Without the aircraft's fuel data, one minutes column per trip.
	 *
	 * Times read in minutes where the parts add up, as the club form does,
	 * and in hours and minutes where they are an endurance; a load and an
	 * uplift in whole litres rounded the safe way; a failing figure is boxed
	 * as well as inked, so the sheet reads on a black-and-white printer. */

	import type { FuelType } from '$lib/aircraft/schema';
	import { aircraftKey } from '$lib/aircraft/schema';
	import { tankedFuelType } from '$lib/state/aircraft.svelte';
	import { takeoffWindow } from '$lib/aircraft/tripLoads';
	import { ceilLitres } from '$lib/aircraft/fuel';
	import { gradeLabel } from '$lib/data/fuel';
	import { setTripFuel, tripFuel } from '$lib/state/flightPrep.svelte';
	import { flightPrepModal, setFuelGroupOpen, showMbSheet } from '$lib/state/flightPrepModal.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import Icon from '../Icon.svelte';
	import { fmtHHMM, type FuelComputation, type TripLoadsComputation } from './shared';
	import { dependsOnRefused, fuelLines, type FuelLine, type MbLinesInput } from './mbLines';
	import { fuelText, startOutside, windowLineText, type LineWords } from './lineText';
	import { fuelVerdictWord, load1, margin1, num1, tripTitle } from './tripText';
	import TakeoffFuelControl from './TakeoffFuelControl.svelte';
	import { onBoardCell, onBoardLineInput } from './onBoardText';

	interface Props {
		fuel: FuelComputation;
		comp: TripLoadsComputation | null;
	}

	const { fuel, comp }: Props = $props();

	// Ids are per instance: the pack mounts a second copy of the page.
	const uid = $props.id();

	/** The grades NCO.OP.145(a) names (AVGAS), which no stop refuels with
	 *  passengers aboard. */
	const AVGAS: readonly FuelType[] = ['100LL', 'UL91'];

	/** The trips with a time to plan, chain index k = their position. */
	const cols = $derived(fuel.inputColumns);
	const rows = $derived(fuel.plan.trips);
	const trips = $derived(comp?.loads.trips ?? []);
	/** Time | litres per trip once the aircraft's fuel data is known. */
	const paired = $derived(comp !== null);
	const span = $derived(paired ? 2 : 1);
	const lpm = $derived(fuel.consumptionLph != null && fuel.consumptionLph > 0 ? fuel.consumptionLph / 60 : null);
	const mb = $derived(comp?.aircraft.massBalance ?? null);
	const usableL = $derived(comp?.aircraft.fuel?.usableL ?? 0);
	const windows = $derived(trips.map((tr) => takeoffWindow(tr, usableL)));
	const refused = $derived(comp ? dependsOnRefused({ loads: comp.loads, points: comp.points }) : []);
	const tanked = $derived(
		comp?.aircraft.fuel ? tankedFuelType(aircraftKey(comp.aircraft), comp.aircraft.fuel) : null,
	);

	const linesInput = $derived<MbLinesInput | null>(
		comp
			? {
					loads: comp.loads,
					mb,
					consumptionKnown: lpm !== null,
					points: comp.points,
					avgas: tanked !== null && AVGAS.includes(tanked),
					usableL,
					onBoard: onBoardLineInput(comp),
				}
			: null,
	);
	const fLines = $derived(linesInput ? fuelLines(linesInput) : []);
	const words = $derived<LineWords | null>(
		comp ? { fuel, comp, multi: trips.length > 1, grade: tanked ? gradeLabel(tanked) : '' } : null,
	);
	const listLines = $derived(fLines.filter((l): l is Extract<FuelLine, { kind: 'window' }> => l.kind === 'window'));
	const otherLines = $derived(fLines.filter((l) => l.kind !== 'window'));

	const burnOffOpen = $derived(flightPrepModal.fuelOpen.includes('burnOff'));
	const reserveOpen = $derived(flightPrepModal.fuelOpen.includes('reserve'));
	/** A folded group holding a minute the pilot typed says so: a typed 10 is
	 *  a decision, even where it equals the default. */
	const burnOffStated = $derived(
		cols.some((c) => {
			const f = tripFuel(c.trip.index);
			return f.taxiMin != null || f.procedureMin != null || f.contingencyMin != null;
		}),
	);
	const reserveStated = $derived(
		cols.some((c) => {
			const f = tripFuel(c.trip.index);
			return f.altProcedureMin != null || f.marginMin != null || f.finalReserveMin != null;
		}),
	);

	/** Minutes at the consumption, one decimal; unknown without one. */
	function litresOf(min: number): string {
		return lpm === null ? '—' : num1(min * lpm);
	}

	/** An endurance in hours and minutes, rounded down (never more time than
	 *  the fuel gives); unknown below zero, where the tanks ran dry. */
	function enduranceOf(litres: number | null): string {
		if (litres === null || lpm === null || litres < 0) {
			return '—';
		}
		return fmtHHMM(Math.floor(litres / lpm));
	}

	/** The fuel above the reserve as time, rounded toward the verdict like
	 *  its litres (margin1): never more than there is, never a deficit that
	 *  reads as none. */
	function overReserveTime(marginL: number, sufficient: boolean): string {
		if (lpm === null) {
			return '—';
		}
		const min = marginL / lpm;
		return sufficient
			? `+${fmtHHMM(Math.max(0, Math.floor(min + 1e-9)))}`
			: `−${fmtHHMM(Math.max(1, Math.ceil(-min - 1e-9)))}`;
	}

	/** Empty (or junk) -> null = automatic: the value aircraft/fuel.ts applies,
	 *  which is what the box shows as its placeholder. */
	function numOrNull(e: Event): number | null {
		const v = Number.parseFloat((e.target as HTMLInputElement).value);
		return Number.isFinite(v) && v >= 0 ? v : null;
	}

	type MinuteKey = 'taxiMin' | 'procedureMin' | 'contingencyMin' | 'altProcedureMin' | 'marginMin' | 'finalReserveMin';

	function setMinutes(k: number, key: MinuteKey, e: Event): void {
		const c = cols[k];
		if (c) {
			setTripFuel(c.trip.index, { [key]: numOrNull(e) });
		}
	}

	function limitsVerdict(k: number): { text: string; ink: 'ok' | 'danger' | null } {
		const v = trips[k]?.mb?.withinLimits ?? null;
		return v === null
			? { text: '—', ink: null }
			: v
				? { text: t.flightprep.yes, ink: 'ok' }
				: { text: t.flightprep.noCaps, ink: 'danger' };
	}
</script>

<!-- A pair's two cells: the time, then the litres when the aircraft's fuel
     data is known. -->
{#snippet pair(time: string, litres: string, cls = '')}
	<td class="t {cls}">{time}</td>
	{#if paired}<td class="l {cls}">{litres}</td>{/if}
{/snippet}

<!-- A minute the pilot may type, the value in force its placeholder and, on
     paper, the figure itself. -->
{#snippet minutes(k: number, key: MinuteKey, inForce: number, label: string)}
	<td class="t">
		<input
			class="num"
			type="number"
			lang="en"
			min="0"
			step="1"
			inputmode="numeric"
			aria-label={t.flightprep.ariaFuelCell({ row: `${label} (${t.flightprep.colMin})`, trip: tripTitle(fuel, k) })}
			value={cols[k] ? (tripFuel(cols[k].trip.index)[key] ?? '') : ''}
			placeholder={String(inForce)}
			oninput={(e) => setMinutes(k, key, e)}
		/><span class="print-value">{inForce}</span>
	</td>
	{#if paired}<td class="l">{litresOf(inForce)}</td>{/if}
{/snippet}

<!-- A group's head: its total, and on screen the fold. Paper carries no
     control, so there the label alone (the M&B verdict's pattern). -->
{#snippet groupHead(group: 'burnOff' | 'reserve', open: boolean, stated: boolean, label: string, tip: string | undefined)}
	<th class="rowhead" scope="rowgroup" title={tip}>
		<button
			class="fold no-print"
			aria-expanded={open}
			aria-controls="{uid}-{group}"
			onclick={() => setFuelGroupOpen(group, !open)}
			><span class="chev"><Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} /></span>{label}</button
		><span class="print-only">{label}</span>{#if !open && stated}<span
				class="stated no-print"
				role="img"
				aria-label={t.flightprep.foldStated}
				title={t.flightprep.foldStated}
			></span>{/if}
	</th>
{/snippet}

<div class="fuel-wrap">
	<table class="fuel-plan" class:paired>
		<caption class="sr-only">{t.flightprep.fuelTableCaption}</caption>
		<colgroup><col /></colgroup>
		{#each cols as c (c.trip.route.id)}
			<colgroup span={span}></colgroup>
		{/each}
		<thead>
			<tr>
				<td class="corner" rowspan={paired ? 2 : 1}></td>
				{#each cols as c, k (c.trip.route.id)}
					<th class="trip" scope="colgroup" colspan={span}>
						<span class="trip-n">{t.flightprep.tripN(k + 1)}</span>
						<span class="trip-route">{tripTitle(fuel, k)}</span>
					</th>
				{/each}
			</tr>
			{#if paired}
				<tr>
					{#each cols as c (c.trip.route.id)}
						<th class="sub t" scope="col">{t.flightprep.colMin}</th>
						<th class="sub l" scope="col">{t.flightprep.colL}</th>
					{/each}
				</tr>
			{/if}
		</thead>

		<!-- What the trip burns: the club form's consumption block. -->
		<tbody id="{uid}-burnOff" class="group" class:folded={!burnOffOpen}>
			<tr class="group-head total" data-row="burnOff">
				{@render groupHead('burnOff', burnOffOpen, burnOffStated, t.flightprep.burnOff, t.flightprep.burnOffTip)}
				{#each rows as r, k (cols[k]?.trip.route.id ?? k)}
					{@render pair(String(r.burnOffMin), litresOf(r.burnOffMin))}
				{/each}
			</tr>
			<tr class="detail" data-row="taxi">
				<th class="rowhead" scope="row" title={t.flightprep.taxiTip}>{t.flightprep.taxi}</th>
				{#each rows as r, k (cols[k]?.trip.route.id ?? k)}
					{@render minutes(k, 'taxiMin', r.taxiMin, t.flightprep.taxi)}
				{/each}
			</tr>
			<tr class="detail" data-row="enRoute">
				<th class="rowhead" scope="row" title={t.flightprep.enRouteTip}>{t.flightprep.enRoute}</th>
				{#each rows as r, k (cols[k]?.trip.route.id ?? k)}
					{@render pair(String(r.tripMin), litresOf(r.tripMin))}
				{/each}
			</tr>
			<tr class="detail" data-row="arrivalProcedure">
				<th class="rowhead" scope="row">{t.flightprep.arrivalProcedure}</th>
				{#each rows as r, k (cols[k]?.trip.route.id ?? k)}
					{@render minutes(k, 'procedureMin', r.procedureMin, t.flightprep.arrivalProcedure)}
				{/each}
			</tr>
			<tr class="detail" data-row="windAllowance">
				<th class="rowhead" scope="row">{t.flightprep.windAllowance}</th>
				{#each rows as r, k (cols[k]?.trip.route.id ?? k)}
					{@render pair(String(r.windAllowanceMin), litresOf(r.windAllowanceMin))}
				{/each}
			</tr>
			<tr class="detail" data-row="contingency">
				<th class="rowhead" scope="row" title={t.flightprep.contingencyTip}>{t.flightprep.contingency}</th>
				{#each rows as r, k (cols[k]?.trip.route.id ?? k)}
					{@render minutes(k, 'contingencyMin', r.contingencyMin, t.flightprep.contingency)}
				{/each}
			</tr>
		</tbody>

		<!-- What the trip must land with: the club form's diversion block. -->
		<tbody id="{uid}-reserve" class="group" class:folded={!reserveOpen}>
			<tr class="group-head total" data-row="reserve">
				{@render groupHead('reserve', reserveOpen, reserveStated, t.flightprep.rowReserve, t.flightprep.rowReserveTip)}
				{#each rows as r, k (cols[k]?.trip.route.id ?? k)}
					{@render pair(String(r.reserveWithWindMin), litresOf(r.reserveWithWindMin))}
				{/each}
			</tr>
			<tr class="detail" data-row="alternate">
				<th class="rowhead" scope="row">{t.flightprep.alternate}</th>
				{#each rows as r, k (cols[k]?.trip.route.id ?? k)}
					<td class="alt-label" colspan={span}>{r.alternate?.label ?? t.flightprep.none}</td>
				{/each}
			</tr>
			<tr class="detail" data-row="alternateTime">
				<th class="rowhead" scope="row">{t.flightprep.alternateTime}</th>
				{#each rows as r, k (cols[k]?.trip.route.id ?? k)}
					{#if r.alternate}
						{@render pair(String(r.alternate.timeMin), litresOf(r.alternate.timeMin))}
					{:else}
						{@render pair('', '')}
					{/if}
				{/each}
			</tr>
			<tr class="detail" data-row="alternateProcedure">
				<th class="rowhead" scope="row">{t.flightprep.alternateProcedure}</th>
				{#each rows as r, k (cols[k]?.trip.route.id ?? k)}
					{#if r.alternate}
						{@render minutes(k, 'altProcedureMin', r.alternate.procedureMin, t.flightprep.alternateProcedure)}
					{:else}
						{@render pair('', '')}
					{/if}
				{/each}
			</tr>
			<tr class="detail" data-row="alternateWind">
				<th class="rowhead" scope="row" title={t.flightprep.altWindTip}>{t.flightprep.alternateWindAllowance}</th>
				{#each rows as r, k (cols[k]?.trip.route.id ?? k)}
					{#if r.alternate}
						{@render pair(String(r.alternate.windAllowanceMin), litresOf(r.alternate.windAllowanceMin))}
					{:else}
						{@render pair('', '')}
					{/if}
				{/each}
			</tr>
			<tr class="detail" data-row="discretionary">
				<th class="rowhead" scope="row" title={t.flightprep.discretionaryTip}>{t.flightprep.discretionaryMargin}</th>
				{#each rows as r, k (cols[k]?.trip.route.id ?? k)}
					{@render minutes(k, 'marginMin', r.pilotMarginMin, t.flightprep.discretionaryMargin)}
				{/each}
			</tr>
			<tr class="detail" data-row="finalReserve">
				<th class="rowhead" scope="row" title={t.flightprep.finalReserveTip}>{t.flightprep.finalReserve}</th>
				{#each rows as r, k (cols[k]?.trip.route.id ?? k)}
					{@render minutes(k, 'finalReserveMin', r.finalReserveMin, t.flightprep.finalReserve)}
				{/each}
			</tr>
		</tbody>

		<tbody>
			<tr class="grand" data-row="minimumAtTakeoff">
				<th class="rowhead" scope="row" title={t.flightprep.minimumAtTakeoffTip}>{t.flightprep.minimumAtTakeoff}</th>
				{#each rows as r, k (cols[k]?.trip.route.id ?? k)}
					{@render pair(String(r.totalMin), lpm === null ? '—' : String(ceilLitres(r.totalL)))}
				{/each}
			</tr>
		</tbody>

		{#if comp}
			<!-- What is aboard: set here or on the trip's sheet, one state. -->
			<tbody class="aboard">
				<tr class="refuel-row" data-row="refuel">
					<th class="rowhead" scope="row" title={t.flightprep.rowRefuelTip}>{t.flightprep.rowRefuel}</th>
					{#each trips as tr (tr.chainIndex)}
						<td class="control" colspan={span}>
							<TakeoffFuelControl {comp} {fuel} k={tr.chainIndex} layout="cell" />
						</td>
					{/each}
				</tr>
				<!-- What the tanks hold before any refuel: at a stop what the
				     previous trip leaves, at the departure what the journey log
				     or the gauges said (empty while nobody read it, an estimate
				     marked as one, its source as the title). -->
				<tr data-row="onArrival">
					<th class="rowhead" scope="row">{t.flightprep.rowOnArrival}</th>
					{#each trips as tr (tr.chainIndex)}
						{#if tr.chainIndex === 0}
							{@const c = onBoardCell(comp)}
							<td class="t"></td>
							<td class="l" class:warn={c.ink === 'warn'} class:danger={c.ink === 'danger'} title={c.title}>{c.text}</td>
						{:else}
							{@render pair('', tr.carriedL !== null ? num1(tr.carriedL) : '—')}
						{/if}
					{/each}
				</tr>
				<tr data-row="uplift">
					<th class="rowhead" scope="row" title={t.flightprep.rowUpliftTip}>{t.flightprep.rowUplift}</th>
					{#each trips as tr, k (tr.chainIndex)}
						{@const up = windows[k]?.planUpliftL ?? null}
						<!-- Nothing at a takeoff taking off with what is on board, nor
						     at a departure whose tanks nobody read. -->
						{@render pair(
							'',
							!tr.fuelSet || tr.target === null || (tr.chainIndex === 0 && tr.carriedL === null)
								? ''
								: up === null
									? '—'
									: up > 0
										? `+${up}`
										: '0',
							'uplift',
						)}
					{/each}
				</tr>
				<tr data-row="needed">
					<th class="rowhead" scope="row" title={t.flightprep.rowNeededTip}>{t.flightprep.rowNeeded}</th>
					{#each trips as tr, k (tr.chainIndex)}
						{@const w = windows[k]}
						<td class="t"></td>
						<td class="l" class:danger={w?.beyondTank} class:box={w?.beyondTank}>
							{!tr.fuelSet ? '' : w && w.neededL !== null ? load1(w.neededL) : '—'}
						</td>
					{/each}
				</tr>
				<tr class="total" data-row="fuelAtTakeoff">
					<th class="rowhead" scope="row" title={t.flightprep.rowEnduranceTip}>{t.flightprep.fuelAtTakeoff}</th>
					{#each trips as tr (tr.chainIndex)}
						{@const out = tr.fuelSet ? startOutside(tr) : { below: false, above: false }}
						{@const bad = out.below || out.above}
						<td class="t">{enduranceOf(tr.startL)}</td>
						<td class="l" class:danger={bad} class:box={bad}>{tr.startL !== null ? num1(tr.startL) : '—'}</td>
					{/each}
				</tr>
				{#if mb}
					<tr data-row="maxWithin">
						<th class="rowhead" scope="row" title={t.flightprep.rowMaxWithinTip}>{t.flightprep.rowMaxWithin}</th>
						{#each trips as tr, k (tr.chainIndex)}
							{@const w = windows[k]}
							{@const none = w !== null && w.limitsChecked && w.maxL === null}
							<td class="t"></td>
							<td class="l" class:danger={none} class:box={none}>
								{!tr.fuelSet
									? ''
									: w && w.limitsChecked
										? w.maxL === null
											? t.flightprep.maxNoneCell
											: load1(w.maxL)
										: '—'}
							</td>
						{/each}
					</tr>
				{/if}
			</tbody>

			<!-- What is left: at landing, above the reserve, the verdicts. -->
			<tbody class="result">
				<tr class="total" data-row="fuelAtLanding">
					<th class="rowhead" scope="row">{t.flightprep.rowFuelAtLanding}</th>
					{#each trips as tr (tr.chainIndex)}
						{@const short = tr.sufficient === false}
						<td class="t">{enduranceOf(tr.landingL)}</td>
						<td class="l" class:danger={short} class:box={short}>{tr.landingL !== null ? num1(tr.landingL) : '—'}</td>
					{/each}
				</tr>
				<tr data-row="overReserve">
					<th class="rowhead" scope="row" title={t.flightprep.overReserveTip}>{t.flightprep.overReserve}</th>
					{#each trips as tr (tr.chainIndex)}
						{#if tr.marginL !== null && tr.sufficient !== null}
							{@const ok = tr.sufficient}
							<td class="t" class:ok class:danger={!ok}>{overReserveTime(tr.marginL, ok)}</td>
							<td class="l" class:ok class:danger={!ok} class:box={!ok}>{margin1(tr.marginL, ok)}</td>
						{:else}
							{@render pair('—', '—')}
						{/if}
					{/each}
				</tr>
				<tr class="verdict-row" data-row="sufficient">
					<th class="rowhead" scope="row">{t.flightprep.rowFuelSufficient}</th>
					{#each trips as tr (tr.chainIndex)}
						{@const v = fuelVerdictWord(tr, refused[tr.chainIndex] ?? false)}
						<td
							colspan={span}
							class:ok={v.ink === 'ok'}
							class:warn={v.ink === 'warn'}
							class:danger={v.ink === 'danger'}
							class:box={v.ink === 'danger'}
							title={v.title}
						>
							{v.text}
						</td>
					{/each}
				</tr>
				{#if mb}
					<tr class="verdict-row" data-row="mb">
						<th class="rowhead" scope="row" title={t.flightprep.rowMbTip}>{t.flightprep.rowMb}</th>
						{#each trips as tr (tr.chainIndex)}
							{@const v = limitsVerdict(tr.chainIndex)}
							<td colspan={span} class:ok={v.ink === 'ok'} class:danger={v.ink === 'danger'} class:box={v.ink === 'danger'}>
								<button
									class="to-sheet no-print"
									aria-label={t.flightprep.openMbSheet({ n: tr.chainIndex + 1, route: tripTitle(fuel, tr.chainIndex) })}
									onclick={() => showMbSheet(tr.chainIndex)}>{v.text}</button
								><span class="print-only">{v.text}</span>
							</td>
						{/each}
					</tr>
				{/if}
			</tbody>
		{/if}
	</table>
</div>

{#if words && (otherLines.length > 0 || listLines.length > 0)}
	<div class="fuel-lines" role="status">
		{#each otherLines as line, i (i)}
			{@const w = fuelText(words, line)}
			<!-- The reading's own line is the screen's: paper prints its figure
			     in the departure's cell and its source under the control, and a
			     one-trip sheet has no line to spare. One that wants checking
			     (another day, more added than fits, a refuel missing) prints. -->
			<p class="line {w.ink}" class:no-print={line.kind === 'onBoard' && w.ink === 'muted'}>{w.text}</p>
		{/each}
		{#if listLines.length > 0}
			<div class="refuel-block">
				<p class="line muted lead">{t.flightprep.refuelListLead}</p>
				<ul class="refuel-list">
					{#each listLines as line (line.trip)}
						<li>{windowLineText(words, line)}</li>
					{/each}
				</ul>
			</div>
		{/if}
	</div>
{/if}

<style>
	/* Screen only: a scroll container on paper would clip the table at the
	   page edge. On a phone the columns keep their width and the table pans
	   under its sticky row heads, a trip's pair snapping into place; a group
	   folds into its total. */
	@media screen {
		.fuel-wrap {
			overflow-x: auto;
			scroll-snap-type: x proximity;
			scroll-padding-left: var(--rowhead-w);
		}

		.fuel-plan th.trip,
		.fuel-plan td.t,
		.fuel-plan td.control,
		.fuel-plan td[colspan] {
			scroll-snap-align: start;
		}

		/* The label column takes the room the table leaves it, its labels on
		   one line where there is room, as on paper (capped at this width,
		   they wrapped with room to spare: a one-trip plan left a phone 83 px
		   unused, the longest French label on three lines). It is never
		   narrower than the snap padding, which is its width once the table
		   pans, a table that pans being at its narrowest; give or take a
		   label word wider than the padding (a bold French one, by a pixel,
		   on a phone), which tucks that much of the trip's own left padding
		   under it, never a figure. */
		.fuel-plan .rowhead {
			position: sticky;
			left: 0;
			z-index: 1;
			min-width: var(--rowhead-w);
		}

		.fuel-plan tbody.folded tr.detail {
			display: none;
		}
	}

	.fuel-wrap {
		--rowhead-w: 150px;
		--l-w: 60px;

		/* The shared workbook .num (styles/workbook.css) at this table's
		   time column. */
		--num-w: 52px;

		/* The minutes column holds that box within its cell's padding and
		   rule (8 + 8 + 1 px), folded or not: a folded group hides its boxes,
		   and the column widened when it unfolded. */
		--min-w: calc(var(--num-w) + 17px);
	}

	:global(:root.mobile-ui) .fuel-wrap {
		--rowhead-w: 112px;
	}

	/* Separate borders, drawn right and below each cell: a sticky cell keeps
	   its rules where a collapsed border would stay behind. */
	.fuel-plan {
		border-collapse: separate;
		border-spacing: 0;
		border: 2px solid var(--border-strong);
		font-size: 12.5px;
		font-variant-numeric: tabular-nums;
	}

	.fuel-plan th,
	.fuel-plan td {
		border-right: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
		padding: 3px 8px;
		text-align: right;
		white-space: nowrap;
		box-sizing: border-box;
	}

	/* Every pair the same two widths at the least, on screen and on paper:
	   left to its own figures, each trip's pair printed a few pixels apart
	   from the next. */
	.fuel-plan th.sub.t,
	.fuel-plan td.t {
		min-width: var(--min-w);
	}

	.fuel-plan th.sub.l,
	.fuel-plan td.l {
		min-width: var(--l-w);
	}

	/* A pair reads as one column: a light rule between its time and its
	   litres, the trip's own rule after them. */
	.fuel-plan.paired td.t,
	.fuel-plan.paired th.sub.t {
		border-right-color: color-mix(in srgb, var(--border) 45%, transparent);
	}

	.fuel-plan tr > :last-child {
		border-right: 0;
	}

	.fuel-plan tbody:last-of-type tr:last-child > * {
		border-bottom: 0;
	}

	/* The heads and the row labels wrap when the table cannot fit its column
	   (the figures never do): the labels grow with the plan and the language,
	   and a table wider than its sheet shrinks the whole print. */
	.fuel-plan th {
		white-space: normal;
	}

	.fuel-plan thead th,
	.fuel-plan thead td {
		background: var(--surface-2);
		vertical-align: bottom;
	}

	.fuel-plan thead tr:last-child > * {
		border-bottom: 2px solid var(--border-strong);
	}

	/* The corner closes both strong rules of the legend: the label column's,
	   and the head's foot, which the last-row rule misses where the corner
	   spans the head's two rows. */
	.fuel-plan td.corner {
		border-right: 2px solid var(--border-strong);
		border-bottom: 2px solid var(--border-strong);
	}

	.fuel-plan th.trip {
		text-align: center;
	}

	.fuel-plan th.sub {
		font-weight: 400;
		color: var(--text-muted);
		font-size: 11.5px;
		text-align: center;
	}

	.fuel-plan .rowhead {
		text-align: left;
		font-weight: 500;
		background: var(--surface-2);
		color: var(--text);
		border-right: 2px solid var(--border-strong);
	}

	.trip-n {
		display: block;
		font-weight: 400;
		color: var(--text-muted);
	}

	.trip-route {
		display: block;
		font-weight: 700;
	}

	/* Each block opens on a strong rule: what the trip needs, what is
	   aboard, what is left. */
	.fuel-plan tbody + tbody > tr:first-child > * {
		border-top: 2px solid var(--border-strong);
	}

	/* The group's head is its total, and on screen the way to its parts. */
	.fold {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		font: inherit;
		color: inherit;
		background: none;
		border: 0;
		padding: 0;
		cursor: pointer;
		text-align: left;
	}

	.chev {
		display: inline-flex;
		color: var(--text-muted);
	}

	/* A folded group holding a typed minute. */
	.stated {
		display: inline-block;
		width: 7px;
		height: 7px;
		margin-left: 6px;
		border-radius: 50%;
		background: var(--accent);
		vertical-align: middle;
	}

	:global(:root.touch-ui) .fold {
		min-height: 44px;
	}

	/* A part's label under its group's: on screen at the group label's own
	   start past the fold (its 14 px chevron and 2 px gap), on paper, which
	   prints no fold, at the same place, indented under the group. */
	tr.detail .rowhead {
		padding-left: 24px;
		font-weight: 400;
	}

	/* An input inherits none of its cell's alignment, and on paper the span
	   that replaces it takes the cell's own right: the minute typed or in
	   force reads on the column's side on screen as on the sheet. */
	.fuel-plan td.t .num {
		text-align: right;
	}

	td.alt-label {
		text-align: center;
		font-weight: 600;
	}

	/* The refuel row reads from the top, so every column's select sits on
	   one line whether or not its pump carries a note. */
	.refuel-row > * {
		vertical-align: top;
	}

	td.control {
		text-align: left;
		white-space: normal;
	}

	td.uplift {
		font-weight: 600;
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

	tr.verdict-row td,
	tr.verdict-row .rowhead {
		font-weight: 700;
	}

	tr.verdict-row td {
		text-align: center;
	}

	/* A failing figure is boxed, not only inked: the sheet must read on a
	   black-and-white printer. An outline prints where a shadow may not. */
	.fuel-plan td.box {
		outline: 1.5px solid var(--danger);
		outline-offset: -3px;
	}

	/* The verdict opens the trip's sheet on the M&B page: a quiet link in the
	   verdict's own ink. */
	.to-sheet {
		font: inherit;
		color: inherit;
		background: none;
		border: 0;
		padding: 0;
		cursor: pointer;
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 2px;
	}

	:global(:root.touch-ui) .to-sheet {
		min-height: 44px;
		min-width: 44px;
	}

	.print-only {
		display: none;
	}

	.fuel-lines {
		margin-top: 6px;
	}

	.fuel-lines .line {
		margin: 4px 0 0;
		font-size: 12.5px;
	}

	.fuel-lines .line.danger {
		font-weight: 600;
	}

	.fuel-lines .line.lead {
		margin-top: 8px;
	}

	.refuel-list {
		margin: 2px 0 0;
		padding-left: 18px;
		font-size: 12.5px;
	}

	@media print {
		.print-only {
			display: inline;
		}

		.fuel-plan {
			width: 100%;
		}

		/* Every row printed, so a row's air is the sheet's: a one-trip plan
		   fits one landscape sheet whatever the face (the line box is the
		   page's, FuelPlanPage). */
		.fuel-plan th,
		.fuel-plan td {
			padding-top: 2px;
			padding-bottom: 2px;
		}

		/* A block and a row are never cut by a page's end: the refuel row
		   holds a target over the pump's note. Nor is the refuelling list,
		   whose lead once printed alone at a sheet's foot. */
		.fuel-plan tbody,
		.fuel-plan tr,
		.refuel-block {
			break-inside: avoid;
		}

		/* A verdict is words as well as a figure, and the words wrap on
		   paper, which has no pan: held on one line, "NON, à sec en
		   navigation 3" in four columns of six ran the French table 97 px
		   past its sheet. */
		tr.verdict-row td {
			white-space: normal;
		}
	}
</style>
