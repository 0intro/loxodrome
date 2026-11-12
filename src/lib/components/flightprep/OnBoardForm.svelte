<script lang="ts">
	/* The departure's fuel on board, read where the pilot reads it: the
	 * aircraft's journey log since its last refuel, one row per flight with
	 * its block time and the litres added before it, or a quantity measured
	 * at the aircraft (aircraft/onBoard.ts runs the log line by line). Every
	 * field writes through as it is typed (state/flightPrep.svelte.ts), so the
	 * outside press that dismisses the form loses nothing. Anchored under the
	 * fuel control's button on a desktop, a bottom sheet riding the keyboard
	 * on a phone (HeadOverlay); it never prints, the fuel table and the
	 * lines under it saying what it gave. */

	import type { LogFlight } from '$lib/aircraft/onBoard';
	import {
		addOnBoardFlight,
		clearOnBoard,
		flightPrep,
		removeOnBoardFlight,
		setOnBoard,
		setOnBoardFlight,
	} from '$lib/state/flightPrep.svelte';
	import { fmtDayMonth, t } from '$lib/state/i18n.svelte';
	import HeadOverlay from '../HeadOverlay.svelte';
	import Icon from '../Icon.svelte';
	import { flownText, onBoardResult } from './onBoardText';
	import type { TripLoadsComputation } from './shared';

	interface Props {
		open: boolean;
		x: number;
		y: number;
		comp: TripLoadsComputation;
		onClose: () => void;
	}

	const { open, x, y, comp, onClose }: Props = $props();
	const uid = $props.id();

	const reading = $derived(flightPrep.mb.onBoard);
	const fuelSpec = $derived(comp.aircraft.fuel);
	const usable = $derived(fuelSpec?.usableL ?? 0);
	const tabsL = $derived(fuelSpec?.presets.find((p) => p.name === 'tabs')?.litres ?? null);
	const sheetLph = $derived(fuelSpec?.consumptionLph ?? null);
	const last = $derived(reading?.last ?? null);
	/** One empty row while the log holds none: typing in it adds the flight. */
	const rows = $derived<LogFlight[]>(
		reading && reading.flights.length > 0 ? reading.flights : [{ min: null, addedL: null }],
	);
	const other = $derived(comp.onBoard.kind === 'otherAircraft');
	const result = $derived(onBoardResult(comp));
	const flownMin = $derived(rows.reduce((sum, f) => sum + (f.min ?? 0), 0));
	const flights = $derived(rows.filter((f) => (f.min ?? 0) > 0).length);
	/** Something to clear: a reading, or a no refuel standing on none. */
	const clearable = $derived(reading !== null || !flightPrep.mb.refuel);

	/** A whole number typed, else null (the empty box). */
	function intOrNull(e: Event): number | null {
		const v = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
		return Number.isFinite(v) && v >= 0 ? v : null;
	}

	function litresOrNull(e: Event): number | null {
		const v = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
		return Number.isFinite(v) && v >= 0 ? v : null;
	}

	function rateOrNull(e: Event): number | null {
		const v = litresOrNull(e);
		return v !== null && v > 0 ? v : null;
	}

	/* A flight time reads as the log writes it, hours then minutes, each box
	   empty where it holds nothing: 45 min shows no hours, 2 h no minutes,
	   and 90 typed in the minutes reads 1 h 30 min. */
	function hoursOf(min: number | null): string {
		return min === null || min < 60 ? '' : String(Math.floor(min / 60));
	}

	function minutesOf(min: number | null): string {
		return min === null || min % 60 === 0 ? '' : String(min % 60);
	}

	/** A new row under the ones shown: the empty row shown while the log holds
	 *  none becomes a flight too, or the press would seem to do nothing. */
	function addFlight(): void {
		if (!reading || reading.flights.length === 0) {
			addOnBoardFlight();
		}
		addOnBoardFlight();
	}

	function setTime(i: number, part: 'h' | 'm', e: Event): void {
		const v = intOrNull(e);
		const cur = rows[i]?.min ?? null;
		const h = part === 'h' ? v : cur === null ? null : Math.floor(cur / 60);
		const m = part === 'm' ? v : cur === null ? null : cur % 60;
		setOnBoardFlight(i, { min: h === null && m === null ? null : (h ?? 0) * 60 + (m ?? 0) });
	}
</script>

<HeadOverlay {open} {x} {y} title={t.flightprep.onBoardTitle} minWidthPx={320} maxWidthPx={400} surface="flightPrep" {onClose}>
	<div class="ob-form popover-panel">
		{#if other}
			<p class="warn">{result.text}</p>
		{:else}
			<p class="lead">{t.flightprep.onBoardLead}</p>

			<fieldset class="group">
				<legend>{t.flightprep.onBoardLastRefuel}</legend>
				<label class="check">
					<input
						type="radio"
						name="{uid}-last"
						checked={last?.kind === 'full'}
						onchange={() => setOnBoard({ last: { kind: 'full' } })}
					/>{t.flightprep.onBoardLastFull(usable)}
				</label>
				{#if tabsL !== null || last?.kind === 'tabs'}
					<label class="check">
						<input
							type="radio"
							name="{uid}-last"
							checked={last?.kind === 'tabs'}
							onchange={() => setOnBoard({ last: { kind: 'tabs' } })}
						/>{t.flightprep.onBoardLastTabs(tabsL ?? '?')}
					</label>
				{/if}
				<span class="litres-row">
					<label class="check">
						<input
							type="radio"
							name="{uid}-last"
							checked={last?.kind === 'litres'}
							onchange={() =>
								setOnBoard({ last: { kind: 'litres', litres: last?.kind === 'litres' ? last.litres : null } })}
						/>{t.flightprep.onBoardLastLitres}
					</label>
					<input
						class="litres"
						type="number"
						lang="en"
						min="0"
						step="1"
						inputmode="decimal"
						aria-label={t.flightprep.onBoardLastLitresAria}
						value={last?.kind === 'litres' ? (last.litres ?? '') : ''}
						oninput={(e) => setOnBoard({ last: { kind: 'litres', litres: litresOrNull(e) } })}
					/><span>L</span>
				</span>
			</fieldset>

			<fieldset class="group">
				<legend>{t.flightprep.onBoardFlights}</legend>
				<div class="rows">
					<span class="head" title={t.flightprep.onBoardFlightTimeTip}>{t.flightprep.onBoardFlightTime}</span>
					<span class="head">{t.flightprep.onBoardAddedBefore}</span>
					<span></span>
					{#each rows as f, i (i)}
						<span class="time">
							<input
								class="hh"
								type="number"
								lang="en"
								min="0"
								step="1"
								inputmode="numeric"
								aria-label={t.flightprep.onBoardHoursAria(i + 1)}
								value={hoursOf(f.min)}
								oninput={(e) => setTime(i, 'h', e)}
							/><span>h</span>
							<input
								class="mm"
								type="number"
								lang="en"
								min="0"
								step="1"
								inputmode="numeric"
								aria-label={t.flightprep.onBoardMinutesAria(i + 1)}
								value={minutesOf(f.min)}
								oninput={(e) => setTime(i, 'm', e)}
							/><span>min</span>
						</span>
						<span class="added">
							<input
								class="litres"
								type="number"
								lang="en"
								min="0"
								step="1"
								inputmode="decimal"
								aria-label={t.flightprep.onBoardAddedAria(i + 1)}
								value={f.addedL ?? ''}
								oninput={(e) => setOnBoardFlight(i, { addedL: litresOrNull(e) })}
							/><span>L</span>
						</span>
						{#if reading && i < reading.flights.length}
							<button
								class="icon-btn"
								aria-label={t.flightprep.onBoardRemoveFlight(i + 1)}
								title={t.flightprep.onBoardRemoveFlight(i + 1)}
								onclick={() => removeOnBoardFlight(i)}
							>
								<Icon name="x" size={14} />
							</button>
						{:else}
							<span></span>
						{/if}
					{/each}
				</div>
				<div class="under-rows">
					<button class="btn" onclick={addFlight}>
						<Icon name="plus" size={14} />
						{t.flightprep.onBoardAddFlight}
					</button>
					{#if flights > 0}
						<span class="muted">{t.flightprep.onBoardTotal({ flown: flownText(flownMin), n: flights })}</span>
					{/if}
				</div>
				<span class="field">
					<span title={t.flightprep.onBoardConsumptionTip}>{t.flightprep.onBoardConsumption}</span>
					<input
						class="litres"
						type="number"
						lang="en"
						min="0"
						step="1"
						inputmode="decimal"
						aria-label={t.flightprep.onBoardConsumption}
						title={t.flightprep.onBoardConsumptionTip}
						placeholder={sheetLph !== null ? String(sheetLph) : ''}
						value={reading?.lph ?? ''}
						oninput={(e) => setOnBoard({ lph: rateOrNull(e) })}
					/><span>L/h</span>
				</span>
			</fieldset>

			<p class="result" class:warn={result.ink === 'warn'} class:danger={result.ink === 'danger'}>
				{result.text}
			</p>

			<fieldset class="group">
				<legend>{t.flightprep.onBoardMeasured}</legend>
				<span class="field">
					<input
						class="litres"
						type="number"
						lang="en"
						min="0"
						step="1"
						inputmode="decimal"
						aria-label={t.flightprep.onBoardMeasuredAria}
						value={reading?.measuredL ?? ''}
						oninput={(e) => setOnBoard({ measuredL: litresOrNull(e) })}
					/><span>L</span>
					<span class="muted">{t.flightprep.onBoardMeasuredNote}</span>
				</span>
			</fieldset>

			{#if reading && comp.onBoardStale}
				<p class="warn">
					{t.flightprep.onBoardStale({ read: fmtDayMonth(reading.readOn), flight: fmtDayMonth(comp.flightDate) })}
				</p>
			{:else if reading}
				<p class="muted">{t.flightprep.onBoardReadOn(fmtDayMonth(reading.readOn))}</p>
			{/if}
			<p class="muted">{t.flightprep.onBoardCheck}</p>
		{/if}

		<div class="actions">
			<button class="btn" disabled={!clearable} onclick={clearOnBoard}>{t.flightprep.onBoardClear}</button>
			<button class="btn primary" onclick={onClose}>{t.flightprep.onBoardDone}</button>
		</div>
	</div>
</HeadOverlay>

<style>
	.ob-form {
		display: flex;
		flex-direction: column;
		gap: 12px;
		font-size: 13px;
	}

	.ob-form p {
		margin: 0;
	}

	.lead,
	.muted {
		color: var(--text-muted);
	}

	.warn {
		color: var(--workbook-orange);
	}

	.danger {
		color: var(--danger);
	}

	.result {
		font-weight: 600;
	}

	input[type='number'] {
		font: inherit;
		padding: 2px 4px;
		text-align: right;
		color: var(--text);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 4px;
	}

	/* Every box the same width, the hours and minutes as the litres. */
	.hh,
	.mm,
	.litres {
		width: 4.6em;
	}

	.litres-row,
	.time,
	.added,
	.field {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 6px;
	}

	.rows {
		display: grid;
		grid-template-columns: auto auto auto;
		gap: 4px 12px;
		align-items: center;
		justify-content: start;
	}

	.head {
		font-size: 11.5px;
		color: var(--text-muted);
	}

	.under-rows {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 12px;
		margin: 6px 0;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	/* The touch floor (app.css's :root.touch-ui): a 44 px target for every
	   box; the buttons get theirs from .btn and .icon-btn. */
	:global(:root.touch-ui) .ob-form input[type='number'] {
		min-height: 44px;
	}
</style>
