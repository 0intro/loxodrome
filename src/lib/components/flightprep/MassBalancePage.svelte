<script lang="ts">
	/* Mass & balance: one loading sheet per trip, every trip's the same
	 * (TripSheet: the fuel at its takeoff, its loading, its states, its CG
	 * envelope and what it breaks), a weight and balance being made per
	 * flight (aircraft/tripLoads.ts through shared.ts tripLoadsComputation;
	 * contract docs/flight-preparation.md "Fuel at each takeoff"). The fuel at
	 * each takeoff is set here or on the fuel plan page, one control and one
	 * state; the fuel story across the trips (what arrives, the uplift, the
	 * window, each landing's reserve) is the fuel plan page's. With several
	 * trips a strip of chips heads the sheets, each trip's verdict and a way
	 * onto its sheet. Every chart reads the same axes, so a point near a
	 * limit looks near it on each. The packs print the sheets two to a
	 * landscape sheet where the pair fits (measured, mbMeasure.ts), the two
	 * tables and the two charts level, alone otherwise. */

	import { tick } from 'svelte';
	import { selectedAircraft, tankedFuelType } from '$lib/state/aircraft.svelte';
	import { clearMbSheet, flightPrepModal } from '$lib/state/flightPrepModal.svelte';
	import { aircraftKey, type FuelType } from '$lib/aircraft/schema';
	import { dryBefore } from '$lib/aircraft/tripLoads';
	import { fuelSlots } from '$lib/aircraft/massBalance';
	import { gradeLabel } from '$lib/data/fuel';
	import { ensureAerodromeFuel } from '$lib/state/data.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { fuelComputation, tripLoadsComputation } from './shared';
	import { dependsOnRefused, fuelLines, type FuelLine, type MbLinesInput } from './mbLines';
	import { onBoardLineInput } from './onBoardText';
	import type { LineWords } from './lineText';
	import { tripTitle } from './tripText';
	import { cgTripPlot, type TripChart } from './cgChart';
	import { PAIR_CHART_H, singleBlocks } from './mbBlocks';
	import TripSheet from './TripSheet.svelte';

	interface Props {
		/** Mounted by the print packs (PrintDoc) and their measure: text
		 *  only, the sheets in `blocks`. */
		pack?: boolean | undefined;
		/** The packs' sheets: each entry the trips one landscape sheet holds
		 *  (two side by side, or one alone); absent, one trip a sheet. The
		 *  measure (mbMeasure.ts) lays out every pair two neighbours could
		 *  make. */
		blocks?: number[][] | null | undefined;
	}

	const { pack = false, blocks = null }: Props = $props();

	/** The grades NCO.OP.145(a) names (AVGAS), which no stop refuels with
	 *  passengers aboard. */
	const AVGAS: readonly FuelType[] = ['100LL', 'UL91'];

	/** The chart heights, viewBox px over the 480 px width: one trip keeps
	 *  the sheet's chart; several trips a little lower, six of them stacked on
	 *  a phone; a pack's pair column lower still (mbBlocks.ts). */
	const CHART_H = 300;
	const TRIP_CHART_H = 260;

	// Ids are per instance: the packs mount the page again, and so does
	// their measure.
	const uid = $props.id();

	const aircraft = $derived(selectedAircraft());
	const fuel = $derived(fuelComputation());
	const comp = $derived(tripLoadsComputation(fuel));

	/* What the AIP says of each takeoff's pump (stopFuel.ts): the fuel
	   control marks a refusal, so this page asks for the fuel dataset itself,
	   whichever page was opened first. */
	$effect(() => {
		void ensureAerodromeFuel('fr').catch(() => {});
	});

	const mb = $derived(comp?.aircraft.massBalance ?? null);
	const trips = $derived(comp?.loads.trips ?? []);
	const multi = $derived(trips.length > 1);
	const tanked = $derived(aircraft?.fuel ? tankedFuelType(aircraftKey(aircraft), aircraft.fuel) : null);
	const consumptionKnown = $derived(fuel.consumptionLph != null && fuel.consumptionLph > 0);

	const linesInput = $derived<MbLinesInput | null>(
		comp
			? {
					loads: comp.loads,
					mb,
					consumptionKnown,
					points: comp.points,
					avgas: tanked !== null && AVGAS.includes(tanked),
					usableL: comp.aircraft.fuel?.usableL ?? 0,
					onBoard: onBoardLineInput(comp),
				}
			: null,
	);
	const fLines = $derived(linesInput ? fuelLines(linesInput) : []);
	const words = $derived<LineWords | null>(
		comp ? { fuel, comp, multi, grade: tanked ? gradeLabel(tanked) : '' } : null,
	);
	const refused = $derived(comp ? dependsOnRefused({ loads: comp.loads, points: comp.points }) : []);

	/** Trip k's own fuel lines, said under its fuel control: its target's
	 *  notes, a refusal at its pump, a window the limits leave empty, and at
	 *  the departure its fuel on board as read. */
	function notesOf(k: number): FuelLine[] {
		return fLines.filter(
			(l) =>
				(l.kind === 'onBoard' ||
					l.kind === 'aboardUnknown' ||
					l.kind === 'aboveMaxAboard' ||
					l.kind === 'unavailable' ||
					l.kind === 'aboveUsable' ||
					l.kind === 'noDefuel' ||
					l.kind === 'refusedTick' ||
					l.kind === 'emptyWindow') &&
				l.trip === k,
		);
	}

	/** One chart per trip, keyed by its chain index: its plot, or why it has
	 *  none (several trips only; one trip keeps the empty envelope it always
	 *  showed). */
	const charts = $derived.by((): TripChart[] => {
		if (!mb) {
			return [];
		}
		const words = {
			takeoff: t.flightprep.pointTakeoff,
			landing: t.flightprep.pointLanding,
			zeroFuel: t.flightprep.zeroFuel,
		};
		return trips.map((tr) => {
			const r = tr.mb?.result;
			const dryOn = dryBefore(tr);
			if (!r || dryOn !== null) {
				return { k: tr.chainIndex, plot: null, dryOn };
			}
			const plot = cgTripPlot(
				{
					takeoff: r.takeoff,
					takeoffOut: !r.takeoffInside,
					landing: tr.mb!.landingKnown ? r.landing : null,
					landingOut: !r.landingInside,
					zeroFuel: r.zeroFuel,
					zeroFuelOut: !r.zeroFuelInside,
					fuelMassKg: r.fuelMassKg,
					fuelL: r.fuelL,
				},
				fuelSlots(mb),
				words,
			);
			return { k: tr.chainIndex, plot, dryOn: null };
		});
	});
	/** The shared axes: every drawn trip's points, so a mass reads at one
	 *  height and an arm at one abscissa on every chart. */
	const allPoints = $derived(charts.flatMap((c) => c.plot?.points ?? []));
	const limits = $derived(
		mb
			? [
					...(mb.maxLandingMassKg != null ? [{ massKg: mb.maxLandingMassKg, label: t.flightprep.maxLandingLine }] : []),
					...(mb.maxZeroFuelMassKg != null ? [{ massKg: mb.maxZeroFuelMassKg, label: t.flightprep.maxZeroFuelLine }] : []),
				]
			: [],
	);

	/** A chip's verdict on its trip's limits. */
	function chipVerdict(k: number): { text: string; ink: 'ok' | 'danger' | null } {
		const v = trips[k]?.mb?.withinLimits ?? null;
		return v === null
			? { text: '—', ink: null }
			: v
				? { text: t.flightprep.yes, ink: 'ok' }
				: { text: t.flightprep.noCaps, ink: 'danger' };
	}

	// The sheets on screen, to bring one into view (a chip, the fuel plan
	// page's link). Never through the URL: the map lives in its hash. State,
	// since Svelte binds an element only into a reactive array; read in a
	// tick's callback alone, so nothing tracks it.
	const slots: (HTMLElement | undefined)[] = $state([]);
	let chipsH = $state(0);
	let chipsEl = $state<HTMLElement | null>(null);

	/** The box `el` scrolls in: the surface's body. */
	function scrollParent(el: HTMLElement): HTMLElement | null {
		for (let p = el.parentElement; p; p = p.parentElement) {
			const oy = getComputedStyle(p).overflowY;
			if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) {
				return p;
			}
		}
		return null;
	}

	function reveal(k: number): void {
		const el = slots[k];
		if (!el) {
			return;
		}
		el.scrollIntoView({ block: 'start' });
		// Clear of the sticky chips, wherever the scroll box's own padding
		// pins them (the scroll margin alone counts from the box's edge).
		const chips = chipsEl?.getBoundingClientRect();
		if (chips && chips.height > 0) {
			const over = chips.bottom + 8 - el.getBoundingClientRect().top;
			if (Math.abs(over) > 1) {
				scrollParent(el)?.scrollBy({ top: -over });
			}
		}
		// i18n-ignore: CSS selector, not user-visible text
		el.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
	}

	// The sheet the fuel plan page asked for, once this page is up.
	$effect(() => {
		if (pack) {
			return;
		}
		const k = flightPrepModal.mbSheet;
		if (k === null || trips.length === 0) {
			return;
		}
		void tick().then(() => {
			reveal(k);
			clearMbSheet();
		});
	});

	const shownBlocks = $derived(blocks ?? singleBlocks(trips.length));
</script>

<div class="page fp-page" class:multi class:pack style:--chips-h="{chipsH}px">
	{#if !aircraft}
		<p class="muted">{t.flightprep.selectForMb}</p>
	{:else if !comp || !mb || !linesInput || !words}
		<p class="muted">
			{t.flightprep.noMbSheet(aircraft.identity.registration ?? aircraft.identity.type)}
		</p>
	{:else if pack}
		{#each shownBlocks as block (block.join('-'))}
			{@const pair = block.length > 1}
			<div class="block" class:pair class:single={!pair} data-block={block.join('-')}>
				{#each block as k (k)}
					{#if trips[k]}
						<div class="col" data-sheet={k}>
							<TripSheet
								{comp}
								{fuel}
								{k}
								{multi}
								chart={charts[k] ?? { k, plot: null, dryOn: null }}
								scalePoints={allPoints}
								{limits}
								chartH={pair ? PAIR_CHART_H : CHART_H}
								rendition={pair ? 'pair' : 'single'}
								{linesInput}
								{words}
								notes={notesOf(k)}
								refused={refused[k] ?? false}
								{uid}
							/>
						</div>
					{/if}
				{/each}
			</div>
		{/each}
	{:else}
		{#if multi}
			<nav class="chips no-print" aria-label={t.flightprep.sheetsNavAria} bind:offsetHeight={chipsH} bind:this={chipsEl}>
				{#each trips as tr (tr.chainIndex)}
					{@const v = chipVerdict(tr.chainIndex)}
					<button
						class="chip"
						aria-label={t.flightprep.tripChipAria({
							n: tr.chainIndex + 1,
							route: tripTitle(fuel, tr.chainIndex),
							verdict: v.text,
						})}
						onclick={() => reveal(tr.chainIndex)}
					>
						<span class="chip-n">{t.flightprep.tripN(tr.chainIndex + 1)}</span>
						<span class="chip-v" class:ok={v.ink === 'ok'} class:danger={v.ink === 'danger'}>{v.text}</span>
					</button>
				{/each}
			</nav>
		{/if}
		{#each trips as tr (tr.chainIndex)}
			<div class="slot" bind:this={slots[tr.chainIndex]}>
				<TripSheet
					{comp}
					{fuel}
					k={tr.chainIndex}
					{multi}
					chart={charts[tr.chainIndex] ?? { k: tr.chainIndex, plot: null, dryOn: null }}
					scalePoints={allPoints}
					{limits}
					chartH={multi ? TRIP_CHART_H : CHART_H}
					rendition="screen"
					{linesInput}
					{words}
					notes={notesOf(tr.chainIndex)}
					refused={refused[tr.chainIndex] ?? false}
					{uid}
				/>
			</div>
		{/each}
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 22px;

		/* The shared workbook .num (styles/workbook.css) at this page's
		   column width; .muted rides the same file. */
		--num-w: 80px;
	}

	/* The trips' chips: each its verdict, a tap away from its sheet, sticky
	   over the sheets as they scroll. */
	.chips {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding: 6px 0;
		margin-bottom: -10px;
		background: var(--surface);
		border-bottom: 1px solid var(--border);
	}

	:global(:root.mobile-ui) .chips {
		flex-wrap: nowrap;
		overflow-x: auto;
	}

	.chip {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
		flex: none;
		font: inherit;
		font-size: 12.5px;
		background: var(--surface-2);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 3px 10px;
		cursor: pointer;
	}

	.chip:hover {
		border-color: var(--border-strong);
	}

	.chip-v {
		font-weight: 700;
	}

	.chip-v.ok {
		color: var(--status-active);
	}

	.chip-v.danger {
		color: var(--danger);
	}

	:global(:root.touch-ui) .chip {
		min-height: 44px;
		align-items: center;
	}

	/* A sheet brought into view stops under the chips. */
	.slot {
		scroll-margin-top: calc(var(--chips-h) + 8px);
	}

	/* The packs' sheets, on screen as on paper (the measure reads them): the
	   line box pinned, whatever face the platform resolves (the Overview's
	   lesson), and a pair two columns. */
	.page.pack {
		line-height: 1.2;
		gap: 0;
	}

	/* A pair's two columns share TripSheet's six rows (its pair rendition:
	   the head, the fuel at takeoff with its notes, the table, the notes
	   under it, the chart, its verdicts), each as tall as the taller
	   column's part, so the tables and the charts stand level. */
	.block.pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		grid-template-rows: repeat(6, auto);
		column-gap: 8mm;
	}

	.block.pair > .col {
		display: grid;
		grid-row: 1 / -1;
		grid-template-rows: subgrid;
	}

	.col {
		min-width: 0;
	}

	@media print {
		/* A sheet is never cut by a page's end. A pack's sheet after the
		   first starts the next landscape sheet with its own 12 mm (a natural
		   break would start it at the paper's edge, the page margin being
		   zeroed); the page's own portrait print does the same for each
		   trip's sheet after the first. */
		.block,
		.page.multi:not(.pack) .slot {
			break-inside: avoid;
		}

		.block + .block,
		.page.multi:not(.pack) .slot + .slot {
			break-before: page;
			padding-top: 12mm;
		}
	}
</style>
