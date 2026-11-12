<script lang="ts">
	/* One trip's weight and balance, the same sheet for every trip (a weight
	 * and balance is made per flight, NCO.GEN.105(a)(4), NCO.POL.100): the
	 * fuel at its takeoff (the control the fuel plan page shows too, one
	 * state), its loading (mass x arm = moment; trip 1's loads typed here,
	 * a later trip's carried over from the one before unless typed, a change
	 * made at the stop), its takeoff, burn-off, landing and zero-fuel states,
	 * its CG envelope, and what its loading breaks with the fuel change that
	 * cures it where one does. The packs print it as a column of a pair or
	 * on a sheet of its own (`rendition`), text only: no input, no button. */

	import { flightPrep, setMbLoad, setStopLoad } from '$lib/state/flightPrep.svelte';
	import { tankedFuelType } from '$lib/state/aircraft.svelte';
	import { FUEL_TYPE_INFO, aircraftKey } from '$lib/aircraft/schema';
	import { computeMassBalance } from '$lib/aircraft/massBalance';
	import { takeoffWindow } from '$lib/aircraft/tripLoads';
	import { t } from '$lib/state/i18n.svelte';
	import CgEnvelopeChart from './CgEnvelopeChart.svelte';
	import TakeoffFuelControl from './TakeoffFuelControl.svelte';
	import { fmtArm, type FuelComputation, type TripLoadsComputation } from './shared';
	import { tripMassLines, type FuelLine, type MassFix, type MbLinesInput } from './mbLines';
	import { fixesText, fuelText, massText, sheetWindowParts, type LineWords } from './lineText';
	import { setTakeoffTarget } from './takeoffFuel';
	import { fuelVerdictCell, load1, num1, takeoffAt, tripTitle } from './tripText';
	import type { TripChart } from './cgChart';

	interface Props {
		comp: TripLoadsComputation;
		fuel: FuelComputation;
		k: number;
		multi: boolean;
		chart: TripChart;
		/** Every trip's points: the axes all the charts share. */
		scalePoints: { armM: number; massKg: number }[] | undefined;
		limits: { massKg: number; label: string }[];
		chartH: number;
		/** On screen; a column of a pack's pair; alone on a pack's sheet. */
		rendition: 'screen' | 'pair' | 'single';
		linesInput: MbLinesInput;
		words: LineWords;
		/** This takeoff's fuel lines (its target notes, a refusal, an empty
		 *  window), said under its fuel control. */
		notes: FuelLine[];
		/** The fuel line's verdict is unwelcome where a stop the AIP refuses
		 *  fuels the trip (mbLines dependsOnRefused). */
		refused: boolean;
		/** The page's own id prefix (the page mounts again for the packs). */
		uid: string;
	}

	const {
		comp,
		fuel,
		k,
		multi,
		chart,
		scalePoints,
		limits,
		chartH,
		rendition,
		linesInput,
		words,
		notes,
		refused,
		uid,
	}: Props = $props();

	const paper = $derived(rendition !== 'screen');
	const tr = $derived(comp.loads.trips[k]);
	const mb = $derived(comp.aircraft.massBalance!);
	const usableL = $derived(comp.aircraft.fuel?.usableL ?? 0);
	const win = $derived(takeoffWindow(tr, usableL));
	const stopKey = $derived(k > 0 ? (comp.stopKeys[k] ?? null) : null);
	const tanked = $derived(
		comp.aircraft.fuel ? tankedFuelType(aircraftKey(comp.aircraft), comp.aircraft.fuel) : null,
	);
	const heading = $derived(t.flightprep.tripCaption({ n: k + 1, route: tripTitle(fuel, k) }));

	/** The trip's own weighing, or, while its fuel is unknown, its stations
	 *  over no fuel (they still take their loads; the fuel rows read unknown,
	 *  never 0 L). */
	const table = $derived.by(() => {
		if (tr.mb) {
			return { result: tr.mb.result, fuelKnown: true, landingKnown: tr.mb.landingKnown };
		}
		const result = computeMassBalance({
			mb,
			stationMassesKg: tr.payloadKg,
			fuelL: 0,
			burnL: 0,
			densityKgPerL: comp.densityKgPerL,
		});
		return { result, fuelKnown: false, landingKnown: false };
	});

	const burnArm = $derived(
		table.result.burnMassKg > 0 ? table.result.burnMomentKgM / table.result.burnMassKg : (mb.fuelArmM ?? null),
	);

	const drawn = $derived(chart.plot !== null || !multi);
	const lines = $derived(drawn ? tripMassLines(linesInput, k) : []);
	/** The fuel change a line's verified fix names (mbLines MassFix): the
	 *  block's start at its Maximum within limits. */
	const cure = $derived.by((): MassFix | null => {
		for (const l of lines) {
			if ((l.kind === 'aboveMax' || l.kind === 'cgOut' || l.kind === 'touchdownOver') && l.fix) {
				return l.fix;
			}
		}
		return null;
	});
	const fuelVerdict = $derived(fuelVerdictCell(tr, refused));
	const limitsOk = $derived(tr.mb?.withinLimits ?? null);

	/** One trip: the plan's single fuel sentence (several trips read it in
	 *  the verdict line under the heading). */
	const oneTripVerdict = $derived.by((): { text: string; ok: boolean } | null => {
		if (multi || tr.sufficient === null || tr.startL === null || tr.blockMinimumL === null) {
			return null;
		}
		const p = { start: load1(tr.startL), need: String(Math.ceil(tr.blockMinimumL - 1e-6)) };
		if (tr.sufficient) {
			return { text: t.flightprep.fuelSufficientOne(p), ok: true };
		}
		const short = comp.loads.shortTrips.find((s) => s.chainIndex === k);
		return { text: `${t.flightprep.fuelShortOne(p)} ${fixesText(fuel, short?.fixes ?? [])}`, ok: false };
	});

	function numOrNull(e: Event): number | null {
		const v = Number.parseFloat((e.target as HTMLInputElement).value);
		return Number.isFinite(v) && v >= 0 ? v : null;
	}
</script>

<section class="sheet {rendition}" aria-labelledby={multi ? `${uid}-sheet-${k}` : undefined}>
	{#if multi}
		<header class="sheet-head">
			<h3 id="{uid}-sheet-{k}" tabindex="-1">{heading}</h3>
			<p class="sheet-verdicts">
				<span>
					{t.flightprep.rowFuelSufficient}
					<b class:ok={fuelVerdict.ink === 'ok'} class:warn={fuelVerdict.ink === 'warn'} class:danger={fuelVerdict.ink === 'danger'}
						>{fuelVerdict.text}</b
					>
				</span>
				<span>
					{t.flightprep.rowWithinLimits}
					<b class:ok={limitsOk === true} class:danger={limitsOk === false}
						>{limitsOk === null ? '—' : limitsOk ? t.flightprep.yes : t.flightprep.noCaps}</b
					>
				</span>
			</p>
		</header>
	{/if}

	<!-- A pack's pair holds its two columns' parts level, row by row (the
	     style's pair rendition): the head, the fuel at takeoff with its notes
	     (.lead), the table, the notes under it (.after), the chart (.figure)
	     and its verdicts (.chart-lines). Elsewhere the wrappers draw no box. -->
	<div class="sheet-body">
		<div class="main">
			<div class="lead">
				<div class="fuel-line">
					<span class="fl-label">
						{multi ? t.flightprep.fuelAtTakeoffFrom(takeoffAt(fuel, k)) : t.flightprep.fuelAtTakeoff}
					</span>
					<TakeoffFuelControl {comp} {fuel} {k} layout="line" {paper} />
					{#if tr.carriedL !== null}
						<!-- What the tanks hold here: at a stop what arrives, at the
						     departure what the journey log (an estimate, marked) or
						     the gauges said. -->
						{@const aboard =
							k === 0 && comp.onBoard.kind === 'estimate'
								? t.flightprep.aboutLitres(num1(tr.carriedL))
								: num1(tr.carriedL)}
						<span class="fl-text">
							{#if tr.fuelSet && tr.target !== null}
								<!-- The uplift the plan makes here; unknown while its
								     target resolves to nothing (a Maximum with none
								     within the limits), which is not "nothing to add". -->
								{win?.planUpliftL == null
									? t.flightprep.aboardOnly(aboard)
									: win.planUpliftL > 0
										? t.flightprep.aboardUplift({ aboard, uplift: String(win.planUpliftL) })
										: t.flightprep.aboardNothing(aboard)}
							{:else if tr.fuelSet}
								{t.flightprep.aboardOnly(aboard)}
							{:else}
								{t.flightprep.carriedOver(aboard)}
							{/if}
						</span>
					{/if}
					{#if win}
						{@const parts = sheetWindowParts(win, tr)}
						<!-- The space after the comma is the whitespace between the two
						     blocks, which Svelte keeps (inside a block it trims it). -->
						<span class="fl-window"
							>{#if parts.needed}<span class:danger={parts.needed.bad}>{parts.needed.text}</span
								>{#if parts.max},{/if}{/if}
							{#if parts.max}<span class:danger={parts.max.bad}>{parts.max.text}</span>{/if}</span
						>
					{/if}
				</div>
				{#each notes as line, i (i)}
					{@const w = fuelText(words, line)}
					<!-- The reading's own line is the screen's, as under the fuel
					     table: the fuel line above prints its figure and source. The
					     packs measure their sheets on screen, so there it is left out
					     rather than hidden. -->
					{@const quiet = line.kind === 'onBoard' && w.ink === 'muted'}
					{#if !(paper && quiet)}
						<p class="small {w.ink}" class:no-print={quiet}>{w.text}</p>
					{/if}
				{/each}
			</div>

			<!-- The station table is the one part with an irreducible width:
			     four columns that must not wrap. It scrolls on its own on
			     screen, so the sheet around it does not. -->
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
						{#each table.result.rows as row, i (row.kind + row.key)}
							{@const j = i - 1}
							{@const stated = row.kind === 'station' && k > 0 && (tr.stated[j] ?? false)}
							<tr class:bad={row.overMax}>
								<!-- A tank's row carries its name and litres: the order the
								     sheet fills and burns them is the tip's. -->
								<th class="rowhead" title={row.kind === 'fuel' && row.label ? t.flightprep.tankOrderTip : undefined}>
									{row.kind === 'empty'
										? t.flightprep.rowEmpty
										: row.kind === 'fuel' && !row.label
											? t.flightprep.rowFuel
											: row.label}
									{#if row.maxMassKg != null}
										<span class="limit">{t.flightprep.stationMax(row.maxMassKg)}</span>
									{/if}
									{#if row.kind === 'fuel' && row.label && table.fuelKnown && row.litres != null}
										<span class="limit">{t.flightprep.tankLitres(load1(row.litres))}</span>
									{/if}
								</th>
								<td>
									{#if row.kind === 'fuel' && !table.fuelKnown}
										—
									{:else if row.kind !== 'station' || paper || (k > 0 && stopKey === null)}
										<span class:stated>{row.massKg.toFixed(1)}</span>
									{:else if k === 0}
										<!-- The station's own default mass is the load in force
										     until one is typed, so the box shows it as a
										     placeholder; the span carries the mass onto the sheet,
										     where neither a placeholder nor an empty box prints. -->
										<input
											class="num"
											type="number"
											lang="en"
											min="0"
											step="1"
											inputmode="decimal"
											aria-label={t.flightprep.ariaFuelCell({ row: row.label, trip: tripTitle(fuel, k) })}
											value={flightPrep.mb.loads[row.key] ?? ''}
											placeholder={String(mb.stations[j]?.defaultMassKg ?? 0)}
											oninput={(e) => setMbLoad(row.key, numOrNull(e))}
										/><span class="print-value">{row.massKg.toFixed(1)}</span>
									{:else}
										<!-- A later trip carries the one before's load (the
										     placeholder) until a change made at the stop is typed. -->
										{@const carried = comp.loads.trips[k - 1]?.payloadKg[j]}
										<input
											class="num"
											class:stated
											type="number"
											lang="en"
											min="0"
											step="1"
											inputmode="decimal"
											aria-label={t.flightprep.ariaFuelCell({ row: row.label, trip: tripTitle(fuel, k) })}
											title={carried != null ? t.flightprep.stationCarriedTip(carried) : undefined}
											value={stated ? tr.payloadKg[j] : ''}
											placeholder={carried != null ? String(carried) : ''}
											oninput={(e) => setStopLoad(stopKey!, row.key, numOrNull(e))}
										/><span class="print-value" class:stated>{row.massKg.toFixed(1)}</span>
									{/if}
								</td>
								<td>{fmtArm(row.armM)}</td>
								<td>{row.kind === 'fuel' && !table.fuelKnown ? '—' : row.momentKgM.toFixed(2)}</td>
							</tr>
						{/each}
						<tr class="total" class:bad={table.fuelKnown && !table.result.takeoffInside}>
							<th class="rowhead">{t.flightprep.takeoff}</th>
							{#if table.fuelKnown}
								<td>{table.result.takeoff.massKg.toFixed(1)}</td>
								<td>{fmtArm(table.result.takeoff.armM)}</td>
								<td>{table.result.takeoff.momentKgM.toFixed(2)}</td>
							{:else}
								<td>—</td>
								<td>—</td>
								<td>—</td>
							{/if}
						</tr>
						<tr>
							<th
								class="rowhead"
								title={table.landingKnown && tr.burnL != null && fuel.plan.trips[k]
									? t.flightprep.tripBurnTip(Math.round(fuel.plan.trips[k].burnOffMin))
									: t.flightprep.noTripBurnTip}
							>
								{t.flightprep.burnOffRow}
							</th>
							<!-- The burn-off leaves from the fuel arm, or from the tanks
							     burnt first: its arm is the moment it takes over its mass. -->
							{#if table.landingKnown}
								<td>{table.result.burnMassKg.toFixed(1)}</td>
								<td>{burnArm != null ? fmtArm(burnArm) : '—'}</td>
								<td>{table.result.burnMomentKgM.toFixed(2)}</td>
							{:else}
								<td>—</td>
								<td>{mb.fuelArmM != null ? fmtArm(mb.fuelArmM) : '—'}</td>
								<td>—</td>
							{/if}
						</tr>
						<tr class="total" class:bad={table.landingKnown && !table.result.landingInside}>
							<th class="rowhead">{t.flightprep.landing}</th>
							{#if table.landingKnown}
								<td>{table.result.landing.massKg.toFixed(1)}</td>
								<td>{fmtArm(table.result.landing.armM)}</td>
								<td>{table.result.landing.momentKgM.toFixed(2)}</td>
							{:else}
								<td>—</td>
								<td>—</td>
								<td>—</td>
							{/if}
						</tr>
						{#if mb.maxLandingMassKg != null}
							<tr class:bad={tr.mb?.overMaxLanding === true}>
								<th class="rowhead" title={t.flightprep.rowTouchdownTip}>
									{t.flightprep.touchdownRow}
									<span class="limit">{t.flightprep.stationMax(mb.maxLandingMassKg)}</span>
								</th>
								<td>{tr.mb?.touchdownKg != null ? tr.mb.touchdownKg.toFixed(1) : '—'}</td>
								<td></td>
								<td></td>
							</tr>
						{/if}
						<tr class:bad={!table.result.zeroFuelInside || tr.mb?.overMaxZeroFuel === true}>
							<th class="rowhead" title={t.flightprep.zeroFuelTip}>
								{t.flightprep.zeroFuel}
								{#if mb.maxZeroFuelMassKg != null}
									<span class="limit">{t.flightprep.stationMax(mb.maxZeroFuelMassKg)}</span>
								{/if}
							</th>
							<td>{table.result.zeroFuel.massKg.toFixed(1)}</td>
							<td>{fmtArm(table.result.zeroFuel.armM)}</td>
							<td>{table.result.zeroFuel.momentKgM.toFixed(2)}</td>
						</tr>
					</tbody>
				</table>
			</div>

			<div class="after">
				<!-- A generic sheet's empty point is its manual's sample weighing:
				     said under every sheet, on screen and paper alike. -->
				{#if comp.aircraft.identity.generic !== undefined}
					<p class="small warn">{t.flightprep.genericMbNote}</p>
				{/if}
				<!-- One sentence per line: the fuel loaded, the trip's burn-off. -->
				<div class="fuel-note muted">
					{#if table.fuelKnown && tr.startL != null && tanked}
						<p>
							{t.flightprep.fuelNote({
								litres: load1(tr.startL),
								grade: FUEL_TYPE_INFO[tanked].label,
								density: comp.densityKgPerL,
								kg: table.result.fuelMassKg.toFixed(1),
							})}
						</p>
					{/if}
					{#if table.landingKnown && tr.burnL != null}
						<p>
							{t.flightprep.burnNote({
								litres: load1(Math.min(tr.startL ?? 0, tr.burnL)),
								kg: table.result.burnMassKg.toFixed(1),
							})}
						</p>
					{/if}
				</div>
				{#if oneTripVerdict}
					<p class="verdict" class:ok={oneTripVerdict.ok} class:danger={!oneTripVerdict.ok}>{oneTripVerdict.text}</p>
				{/if}
			</div>
		</div>

		<div class="chart">
			<div class="figure">
				{#if !multi}
					<h4>{t.flightprep.cgEnvelope}</h4>
				{/if}
				{#if drawn}
					<CgEnvelopeChart
						envelope={mb.envelope}
						points={chart.plot?.points ?? []}
						travel={chart.plot?.travel ?? []}
						{limits}
						heightPx={chartH}
						scalePoints={multi ? scalePoints : undefined}
						ariaLabel={multi ? t.flightprep.cgTripHeading({ n: k + 1, route: tripTitle(fuel, k) }) : undefined}
					/>
				{:else if chart.dryOn !== null}
					<p class="no-chart danger">{t.flightprep.cgNoFuelDry(chart.dryOn + 1)}</p>
				{:else}
					<p class="no-chart muted">{t.flightprep.cgNoFuelUnknown}</p>
				{/if}
			</div>
			<div class="chart-lines">
				{#each lines as line, i (i)}
					<p class="verdict danger">{massText(fuel, line)}</p>
				{/each}
				{#if cure && !paper}
					<button
						class="cure no-print"
						title={t.flightprep.takeLitresAtTip}
						onclick={() => setTakeoffTarget(comp, cure.at, 'max')}
					>
						{t.flightprep.takeLitresAt({ litres: cure.litres, at: takeoffAt(fuel, cure.at) })}
					</button>
				{/if}
				{#if lines.length > 0}
					<p class="verdict danger">{t.flightprep.adjustLoading}</p>
				{:else if drawn && limitsOk === true}
					<p class="verdict ok">{t.flightprep.withinEnvelope}</p>
				{/if}
			</div>
		</div>
	</div>
</section>

<style>
	.sheet {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}

	.sheet-head h3 {
		margin: 0;
		font-size: 14px;
	}

	.sheet-head h3:focus {
		outline: none;
	}

	.sheet-head h3:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.sheet-verdicts {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 16px;
		margin: 2px 0 0;
		font-size: 12.5px;
	}

	.sheet-body {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
	}

	.main {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
		max-width: 560px;
	}

	.chart {
		min-width: 0;
		max-width: 560px;
	}

	/* Screen, a surface 760 px wide or more: the loading beside its chart,
	   the chart's lines under it. Narrower, and on paper, one under the
	   other. */
	@container (width >= 760px) {
		.sheet.screen .sheet-body {
			display: grid;
			grid-template-columns: minmax(360px, 1fr) minmax(320px, 1fr);
			column-gap: 24px;
			align-items: start;
			max-width: 1144px;
		}
	}

	@container (width >= 760px) and (width < 960px) {
		.sheet.screen {
			--num-w: 72px;
		}
	}

	:global(:root.mobile-ui) .sheet {
		--num-w: 64px;
	}

	/* The packs: alone on a landscape sheet, the loading at its on-screen
	   width beside the chart; in a pair, a column, the chart under the
	   loading. Both on screen as on paper, so the measure (mbMeasure.ts)
	   reads the printed layout. */
	.sheet.single .sheet-body {
		display: grid;
		grid-template-columns: 150mm minmax(0, 1fr);
		column-gap: 8mm;
		align-items: start;
	}

	.sheet.single .main,
	.sheet.single .chart,
	.sheet.pair .main,
	.sheet.pair .chart {
		max-width: none;
	}

	/* The parts a pair holds level (below) draw no box elsewhere: their
	   children lay out as the sheet's own, as they always did. */
	.lead,
	.after,
	.figure,
	.chart-lines {
		display: contents;
	}

	/* A pair's two columns share six rows (MassBalancePage's .block.pair):
	   the head, the fuel at takeoff with its notes, the table, the notes
	   under it, the chart and its verdicts, each as tall as the taller
	   column's part, so the tables and the charts stand level whatever each
	   trip says above them (user's review 2026-10-06; a two-line fuel line
	   and a note had set one table, and its chart with it, 14.8 mm below
	   its neighbour's). Every level a row subgrid of the one above; the gaps
	   the flex columns gave are margins inside the rows. A pair is then as
	   tall as its two columns' parts together, which the measure reads as
	   printed (mbMeasure.ts). */
	.sheet.pair,
	.sheet.pair .sheet-body,
	.sheet.pair .main,
	.sheet.pair .chart {
		display: grid;
		grid-template-rows: subgrid;
		row-gap: 0;
	}

	.sheet.pair {
		grid-row: 1 / -1;
	}

	.sheet.pair .sheet-body {
		grid-row: 2 / -1;
	}

	.sheet.pair .main {
		grid-row: 1 / 4;
	}

	.sheet.pair .chart {
		grid-row: 4 / -1;
	}

	.sheet.pair .lead,
	.sheet.pair .after {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.sheet.pair .figure,
	.sheet.pair .chart-lines {
		display: block;
	}

	.sheet.pair .lead,
	.sheet.pair .mb-wrap,
	.sheet.pair .after {
		margin-top: 8px;
	}

	.sheet.pair .figure {
		margin-top: 12px;
	}

	.fuel-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 10px;
		font-size: 12.5px;
	}

	.fl-label {
		font-weight: 600;
	}

	.fl-text,
	.fl-window {
		color: var(--text-muted);
	}

	.fl-window .danger {
		color: var(--danger);
		font-weight: 600;
	}

	/* Rides class "muted"; the pairing outranks the shared 13px
	   .fp-page .muted (styles/workbook.css) whatever the bundle order. */
	.small,
	.muted.small {
		font-size: 12px;
		margin: 0;
	}

	/* Screen only: on paper the sheet is wide enough, and a scroll container
	   would clip the table at the page edge. */
	@media screen {
		.mb-wrap {
			overflow-x: auto;
		}
	}

	/* Document-style table: strong outer frame + strong legend rules, light
	   inner grid, tabular figures. */
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

	/* A phone, and the packs' columns: the labels wrap, never the figures
	   (a pair's column is 132.5 mm, and "Toucher des roues (maxi 1050 kg)"
	   held on one line ran the table past it). */
	:global(:root.mobile-ui) .mb-table .rowhead,
	.sheet:not(.screen) .mb-table .rowhead {
		white-space: normal;
	}

	tr.total td,
	tr.total .rowhead {
		font-weight: 700;
		background: var(--surface-3);
	}

	tr.bad td {
		color: var(--danger);
	}

	/* An overloaded station's own box says so too: the cell colour does not
	   reach an input. */
	tr.bad .num {
		color: var(--danger);
		border-color: var(--danger);
	}

	/* A change made at the stop, against the load carried over. */
	.stated {
		font-weight: 600;
	}

	/* A station's published maximum, beside its name. */
	.mb-table .rowhead .limit {
		margin-left: 4px;
		font-weight: 400;
		color: var(--text-muted);
		white-space: nowrap;
	}

	/* Rides class "muted"; the pairing outranks the shared 13px
	   .fp-page .muted (styles/workbook.css) whatever the bundle order. */
	.fuel-note.muted {
		font-size: 12px;
		margin: 0;
	}

	.fuel-note p {
		margin: 0;
	}

	.chart h4 {
		margin: 0 0 6px;
		font-size: 13px;
	}

	/* A trip with nothing to draw says why where its chart would be: dry
	   tanks in the danger ink, an unknown fuel muted. */
	.no-chart {
		margin: 4px 0 0;
		font-size: 12.5px;
		font-weight: 600;
	}

	.no-chart.danger {
		color: var(--danger);
	}

	.no-chart.muted {
		font-size: 12.5px;
		font-weight: 400;
	}

	.verdict {
		font-size: 12.5px;
		font-weight: 600;
		margin: 4px 0 0;
	}

	.verdict.ok,
	.sheet-verdicts .ok {
		color: var(--status-active);
	}

	.verdict.danger,
	.sheet-verdicts .danger {
		color: var(--danger);
	}

	.sheet-verdicts .warn {
		color: var(--workbook-orange);
	}

	/* The cure: the fuel change the verified fix names, one tap. */
	.cure {
		margin: 6px 0 0;
		font: inherit;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--accent);
		background: none;
		border: 1px solid var(--accent);
		border-radius: var(--radius-sm);
		padding: 3px 10px;
		cursor: pointer;
	}

	.cure:hover {
		background: var(--surface-2);
	}

	:global(:root.touch-ui) .cure {
		min-height: 44px;
	}

	:global(:root.touch-ui) .sheet .num {
		min-height: 44px;
	}
</style>
