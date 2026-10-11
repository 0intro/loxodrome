<script lang="ts">
	/* The fuel at one takeoff: the ONE control the fuel plan page's takeoff
	 * table and each trip's sheet on the M&B page both show, bound to the same
	 * state (takeoffFuel.ts), so a change on either page is the plan's. The
	 * departure and each stop take a target or no refuel, the fuel then being
	 * what the tanks hold: at a stop what arrives, at the departure what the
	 * journey log or the gauges said, read in the form its button opens
	 * (OnBoardForm), which is why the departure's no refuel is greyed until
	 * something was read. Beside it, what the AIP or a NOTAM says of the pump
	 * there, and for Custom the litres. In a table cell the targets read short
	 * (the rows under them carry the figures); on a sheet's fuel line each
	 * reads with the figure it gives. On paper the control prints its choice,
	 * and the departure where its fuel on board came from. */

	import { ceilLitres, floorLitres } from '$lib/aircraft/fuel';
	import { printValue } from '$lib/ui/printValue';
	import { t } from '$lib/state/i18n.svelte';
	import NotamIdButton from '../detail/NotamIdButton.svelte';
	import { refusalShort, refusalText } from './stopFuel';
	import { setTakeoffLitres, setTakeoffTarget, takeoffLitres, takeoffMode, type TakeoffMode } from './takeoffFuel';
	import { load1, takeoffAt } from './tripText';
	import { onBoardResult, onBoardSource } from './onBoardText';
	import OnBoardForm from './OnBoardForm.svelte';
	import type { FuelComputation, TripLoadsComputation } from './shared';

	interface Props {
		comp: TripLoadsComputation;
		fuel: FuelComputation;
		/** The takeoff, by chain index (0 = the departure). */
		k: number;
		layout: 'cell' | 'line';
		/** The packs' rendition: the choice as text, no control. */
		paper?: boolean | undefined;
	}

	const { comp, fuel, k, layout, paper = false }: Props = $props();

	const tr = $derived(comp.loads.trips[k] ?? null);
	const mode = $derived(takeoffMode(comp, k));
	const spec = $derived(comp.aircraft.fuel);
	const usable = $derived(spec?.usableL ?? null);
	const tabs = $derived(spec?.presets.find((p) => p.name === 'tabs') ?? null);
	const hasMb = $derived(comp.aircraft.massBalance != null);
	const at = $derived(takeoffAt(fuel, k));
	const types = $derived(spec?.types ?? []);
	const pt = $derived(comp.points[k] ?? null);
	/** The departure's fuel on board, as read (null: nothing known). */
	const aboard = $derived(k === 0 ? (comp.input.departure.aboardL ?? null) : null);
	const source = $derived(k === 0 ? onBoardSource(comp) : null);
	const read = $derived(k === 0 && comp.onBoard.kind !== 'unknown');
	const sourceTip = $derived(
		k === 0
			? read
				? `${onBoardResult(comp).text} ${t.flightprep.onBoardCheck}`
				: t.flightprep.onBoardLead
			: undefined,
	);
	let formOpen = $state(false);
	let anchor = $state({ x: 0, y: 0 });

	function openForm(e: MouseEvent): void {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		anchor = { x: r.left, y: r.bottom + 4 };
		formOpen = true;
	}
	/** The figures a target gives here: computed where the fuel is set (an
	 *  unticked stop's block is not its own yet, so its Minimum and Maximum
	 *  read plain). `maxL` undefined = not computed, null = none within. */
	const minimumL = $derived(tr?.fuelSet && tr.blockMinimumL != null ? ceilLitres(tr.blockMinimumL) : null);
	const maxL = $derived.by((): number | null | undefined => {
		const mx = tr?.fuelSet ? tr.maxWithinLimits : null;
		if (!mx) {
			return undefined;
		}
		return mx.litres === null ? null : floorLitres(mx.litres);
	});

	interface Opt {
		value: TakeoffMode;
		label: string;
		disabled: boolean;
	}

	const options = $derived.by((): Opt[] => {
		const cell = layout === 'cell';
		const out: Opt[] = [];
		// The departure takes off with what is on board only once something
		// was read (a no refuel already set stays offered, and says so). The
		// row is listed all the same: a list is as wide as its longest row,
		// so the departure's column keeps its width when the reading lands.
		out.push({ value: 'none', label: t.flightprep.modeNone, disabled: k === 0 && aboard === null && mode !== 'none' });
		out.push({
			value: 'full',
			label: cell ? t.flightprep.stopModeFull : t.flightprep.modeFull(usable ?? '?'),
			disabled: false,
		});
		out.push({
			value: 'minimum',
			label: cell || minimumL === null ? t.flightprep.stopModeMinimum : t.flightprep.modeMinimumL(minimumL),
			disabled: false,
		});
		if (tabs || mode === 'tabs') {
			out.push({
				value: 'tabs',
				label: cell ? t.flightprep.stopModeTabs : t.flightprep.modeTabs(tabs?.litres ?? '?'),
				disabled: false,
			});
		}
		out.push({
			value: 'max',
			label: cell
				? t.flightprep.stopModeMax
				: maxL === undefined
					? t.flightprep.modeMax
					: maxL === null
						? t.flightprep.modeMaxNone
						: t.flightprep.modeMaxL(maxL),
			// Nothing to resolve to: no mass and balance, or no quantity within
			// the limits (a target already there stays shown, and says so).
			disabled: (!hasMb || maxL === null) && mode !== 'max',
		});
		out.push({ value: 'custom', label: t.flightprep.modeCustom, disabled: false });
		return out;
	});

	const choice = $derived(options.find((o) => o.value === mode)?.label ?? '');
	/** What the Custom box shows, which is what paper prints: the litres
	 *  typed, else the value in force its placeholder shows (the Minimum). */
	const customShown = $derived(takeoffLitres(comp, k) ?? minimumL);

	function numOrNull(e: Event): number | null {
		const v = Number.parseFloat((e.target as HTMLInputElement).value);
		return Number.isFinite(v) && v >= 0 ? v : null;
	}
</script>

<!-- What the AIP or a NOTAM says of the pump here, short, the NOTAM id a link
     onto its panel (text alone on paper's own rendition). -->
{#snippet pump()}
	{#if pt?.refusal && pt.ident}
		{@const p = refusalShort(pt.refusal, types)}
		<span class="pump warn" title={refusalText(pt.ident, pt.refusal, types)}
			>{p.head}{#if p.item}{#if paper}{p.item.notam.id}{:else}<NotamIdButton item={p.item} />{/if}{/if}{p.tail}</span
		>
	{:else if pt?.access === 'onRequest'}
		<span class="pump muted">{t.flightprep.accessShortOnRequest}</span>
	{:else if pt?.access === 'noHours'}
		<span class="pump muted">{t.flightprep.accessShortNoHours}</span>
	{/if}
{/snippet}

<span class="ctl" class:cell={layout === 'cell'} class:line={layout === 'line'}>
	{#if mode === null}
		<span class="choice muted">—</span>
	{:else if paper}
		<span class="choice">{choice}{#if mode === 'custom' && customShown != null}&nbsp;{load1(customShown)} L{/if}</span>
		<!-- The packs' rendition is measured on screen, so its words are
		     ordinary text, never a print-only span. -->
		{#if source && read}
			<span class="source" class:warn={source.ink === 'warn'} class:danger={source.ink === 'danger'}>{source.text}</span>
		{/if}
	{:else}
		<span class="pick">
			<select
				class="mode"
				aria-label={t.flightprep.fuelAtTakeoffFrom(at)}
				title={mode === 'tabs' ? t.flightprep.modeTabsTip : undefined}
				value={mode}
				use:printValue={mode}
				onchange={(e) => setTakeoffTarget(comp, k, e.currentTarget.value as TakeoffMode)}
			>
				{#each options as o (o.value)}
					<option value={o.value} disabled={o.disabled}>{o.label}</option>
				{/each}
			</select>
			{#if mode === 'custom'}
				<span class="custom">
					<input
						class="num"
						type="number"
						lang="en"
						min="0"
						step="1"
						inputmode="numeric"
						aria-label={t.flightprep.customLitresAria(at)}
						value={takeoffLitres(comp, k) ?? ''}
						placeholder={minimumL !== null ? String(minimumL) : ''}
						oninput={(e) => setTakeoffLitres(comp, k, numOrNull(e))}
					/><span class="print-value">{customShown != null ? load1(customShown) : ''}</span>
					<span>L</span>
				</span>
			{/if}
		</span>
		{#if source}
			<button
				class="source no-print"
				class:warn={source.ink === 'warn'}
				class:danger={source.ink === 'danger'}
				title={sourceTip}
				aria-expanded={formOpen}
				onclick={openForm}>{source.text}</button
			>{#if read}<span
					class="source print-only"
					class:warn={source.ink === 'warn'}
					class:danger={source.ink === 'danger'}>{source.text}</span
				>{/if}
		{/if}
	{/if}
	{@render pump()}
</span>

{#if k === 0 && !paper}
	<OnBoardForm open={formOpen} x={anchor.x} y={anchor.y} {comp} onClose={() => (formOpen = false)} />
{/if}

<style>
	.ctl {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
		text-align: left;
	}

	/* In a table cell, one under another: the target, the litres for Custom,
	   then the pump's note, so every column's select sits on one line
	   whether or not its pump says anything, and the column keeps its width
	   whatever the target (the box beside the select widened it by half). */
	.ctl.cell {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 2px;
	}

	.ctl.cell .pick {
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
	}

	/* A note wraps inside the cell and never widens its column: no width of
	   its own to give the table, the cell's once laid out. Every trip's
	   column is then its list's width, on screen and on paper, where the
	   notes had made three columns 150, 131 and 146 px. (Size containment
	   does the first half, but a column flexbox then sizes the note's height
	   at no width at all, a word a line.) */
	.ctl.cell .pump,
	.ctl.cell .source {
		width: 0;
		min-width: 100%;
	}

	.pick {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 6px;
	}

	.mode {
		max-width: 100%;
		font: inherit;
		font-size: 12px;
		background: var(--surface-2);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 1px 4px;
	}

	.custom {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.pump {
		font-size: 11.5px;
		white-space: normal;
	}

	.cell .choice {
		white-space: normal;
	}

	/* Where the departure's fuel on board comes from, and the way into its
	   form: a quiet link in the line's own size, the caution or danger ink
	   where the reading wants checking. */
	.source {
		font-size: 11.5px;
		white-space: normal;
		text-align: left;
	}

	button.source {
		font-family: inherit;
		color: var(--accent);
		background: none;
		border: 0;
		padding: 0;
		cursor: pointer;
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 2px;
	}

	.source.warn {
		color: var(--workbook-orange);
	}

	.source.danger {
		color: var(--danger);
	}

	.print-only {
		display: none;
	}

	/* The touch floor (app.css's :root.touch-ui, the in-flight and
	   coarse-pointer state): a 44 px target for each control. */
	:global(:root.touch-ui) .mode,
	:global(:root.touch-ui) .ctl .num,
	:global(:root.touch-ui) button.source {
		min-height: 44px;
	}

	/* On paper the select prints its choice as text. */
	@media print {
		.mode {
			appearance: none;
			border: 0;
			background: none;
			padding: 0;
		}

		.print-only {
			display: inline;
		}
	}
</style>
