<script lang="ts">
	/* The viewing-conditions popover: the period the whole map is read at, and
	 * the level band it is read through. Opened by either toolbar chip. The
	 * NOTAM-only filters keep their own funnel in the NOTAMs tab; these two are
	 * app-wide, which is why they are toolbar chrome. Presentation (anchored
	 * popup / phone bottom sheet, portal, Escape, Back) is HeadOverlay's. */
	import {
		filter,
		altitudeError,
		windowError,
		setWindowHorizon,
		setWindowMode,
		HORIZON_CHOICES_H,
		type WindowMode,
	} from '$lib/state/filter.svelte';
	import { hasFlyableRoute, plannedFlightWindow } from '$lib/state/timeWindow.svelte';
	import { flightPrep } from '$lib/state/flightPrep.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { formatZuluSpan, groupThousands } from '$lib/format/datetime';
	import HeadOverlay from './HeadOverlay.svelte';
	import RangeSlider from './RangeSlider.svelte';
	import Segmented from './Segmented.svelte';
	import TimeField from './TimeField.svelte';

	let {
		open,
		x,
		y,
		id,
		onClose,
	}: {
		open: boolean;
		x: number;
		y: number;
		id: string;
		onClose: () => void;
	} = $props();

	const mode = $derived(filter.window.mode);
	const winError = $derived(windowError());
	const altError = $derived(altitudeError());
	const hasRoute = $derived(hasFlyableRoute());
	const flightWin = $derived(mode === 'flight' ? plannedFlightWindow() : null);
	// Without an explicit ETD the flight window still resolves, anchored on
	// the next whole hour; the popover says so rather than presenting an
	// assumed span as an exact one.
	const etdSet = $derived(!!flightPrep.dossier.departureTime);

	function flHint(ft: number): string {
		if (!Number.isFinite(ft)) {
			return '';
		}
		if (ft <= 0) {
			return 'GND';
		}
		return 'FL' + Math.round(ft / 100).toString().padStart(3, '0');
	}

	function horizonLabel(h: number | null): string {
		return h == null ? t.conditions.horizonAll : t.conditions.horizonHours(h);
	}

	function setBand(low: number, high: number): void {
		filter.altitude.floor = low;
		filter.altitude.ceiling = high;
	}

</script>

<HeadOverlay {open} {x} {y} title={t.conditions.title} minWidthPx={300} {onClose}>
	<div class="conds-pop popover-panel" {id}>
		<fieldset class="group">
			<legend>{t.conditions.periodLegend}</legend>
			<Segmented
				options={[
					{ value: 'now', label: t.conditions.now },
					{ value: 'flight', label: t.conditions.flight, disabled: !hasRoute },
					{ value: 'custom', label: t.conditions.custom },
				]}
				value={mode}
				onSelect={(v) => setWindowMode(v as WindowMode)}
				ariaLabel={t.conditions.periodLegend}
			/>

			{#if mode === 'now'}
				<div class="horizon">
					<span class="lbl">{t.conditions.horizonLegend}</span>
					<Segmented
						options={HORIZON_CHOICES_H.map((h) => ({
							value: String(h),
							label: horizonLabel(h),
						}))}
						value={String(filter.window.horizonH)}
						onSelect={(v) => setWindowHorizon(v === 'null' ? null : Number(v))}
						ariaLabel={t.conditions.horizonLegend}
					/>
				</div>
				<p class="muted small">{t.conditions.nowNote}</p>
			{:else if mode === 'flight'}
				{#if flightWin}
					<p class="muted small">{t.conditions.flightWindow(formatZuluSpan(flightWin.from, flightWin.to))}</p>
					{#if !etdSet}
						<p class="muted small">{t.conditions.flightNoEtd}</p>
					{/if}
				{/if}
			{:else}
				<div class="range">
					<div class="range-label">
						<span>{t.conditions.from}</span>
						<input
							type="date"
							bind:value={filter.window.fromDate}
							aria-label={t.conditions.fromDateAria}
						/>
						<TimeField
							value={filter.window.fromTime}
							oncommit={(v: string) => (filter.window.fromTime = v)}
							allowEmpty
							ariaLabel={t.conditions.fromTimeAria}
						/>
					</div>
					<div class="range-label">
						<span>{t.conditions.to}</span>
						<input
							type="date"
							bind:value={filter.window.toDate}
							aria-label={t.conditions.toDateAria}
						/>
						<TimeField
							value={filter.window.toTime}
							oncommit={(v: string) => (filter.window.toTime = v)}
							allowEmpty
							ariaLabel={t.conditions.toTimeAria}
						/>
					</div>
				</div>
				{#if winError}
					<p class="warn" role="alert">{winError}</p>
				{/if}
			{/if}
			{#if !hasRoute}
				<p class="muted small">{t.conditions.flightNeedsRoute}</p>
			{/if}
		</fieldset>

		<fieldset class="group">
			<legend>{t.conditions.levelsLegend}</legend>
			<label class="check">
				<input type="checkbox" bind:checked={filter.altitude.enabled} />
				<span>{t.conditions.limitToBand}</span>
			</label>
			{#if filter.altitude.enabled}
				<div class="band">
					<RangeSlider
						orientation="horizontal"
						min={0}
						max={60000}
						minSpan={500}
						step={500}
						snap={500}
						low={filter.altitude.floor}
						high={filter.altitude.ceiling}
						format={(v: number) => `${groupThousands(v)} ft`}
						ariaLow={t.conditions.floorAria}
						ariaHigh={t.conditions.ceilingAria}
						onChange={setBand}
					/>
				</div>
				<div class="range">
					<label class="range-label">
						<span>{t.conditions.floor}</span>
						<input
							type="number"
							min="0"
							max="60000"
							step="500"
							bind:value={filter.altitude.floor}
						/>
						<!-- i18n-ignore: ft / FL are ICAO Doc 8400 abbreviations -->
						<span class="hint">ft · {flHint(filter.altitude.floor)}</span>
					</label>
					<label class="range-label">
						<span>{t.conditions.ceiling}</span>
						<input
							type="number"
							min="0"
							max="60000"
							step="500"
							bind:value={filter.altitude.ceiling}
						/>
						<!-- i18n-ignore: ft / FL are ICAO Doc 8400 abbreviations -->
						<span class="hint">ft · {flHint(filter.altitude.ceiling)}</span>
					</label>
				</div>
				{#if altError}
					<p class="warn" role="alert">{altError}</p>
				{/if}
			{/if}
			<p class="muted small">{t.conditions.levelsNote}</p>
		</fieldset>
	</div>
</HeadOverlay>

<style>
	.conds-pop {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 6px;
	}

	/* This popover's groups stack their controls, unlike the tabs' rows.
	   Everything else (border, radius, padding, the legend) is the shared
	   chrome; a padding override here would lose to it anyway, the global
	   selector carrying a type as well as two classes. */
	.group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	/* The group is a stretch column, which would pull the mode picker the whole
	   way across; it is a control, so it takes its content width. Scoped to the
	   fieldset's own children: the look-ahead picker sits in a centred row and
	   must not be pulled to its top. */
	.group > :global(.seg) {
		align-self: flex-start;
	}

	.horizon {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 2px 0;
	}

	.horizon .lbl {
		font-size: 12px;
		color: var(--text-muted);
	}

	/* RangeSlider's horizontal padding lines its track up with the profile
	   chart's gutters; a popover has none. 17px is half a coarse-pointer
	   handle, so one parked at either bound is not clipped. */
	.band :global(.rslider.horizontal) {
		padding: 0 17px;
	}

	.range {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.range-label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.range-label > span:first-child {
		width: 5.5em;
		flex: none;
		white-space: nowrap;
	}

	.range-label input {
		min-width: 0;
		flex: 1;
		padding: 5px 7px;
		font: inherit;
		font-size: 12px;
		color: var(--text);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 4px;
	}

	/* Fixed width, not content width: the input takes the rest of the row, so a
	   hint that shrinks from "ft · FL100" to "ft · GND" would stretch its input
	   and leave the two fields ending 8px apart. Sized for the longest form the
	   flight level can take. */
	.hint {
		flex: 0 0 5em;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	.small {
		font-size: 11px;
		line-height: 1.4;
	}

	.warn {
		margin: 0;
		font-size: 12px;
		color: var(--danger);
	}
</style>
