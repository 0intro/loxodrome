<script lang="ts">
	import {
		display,
		setAipRemarkLang,
		setGpsAltDatum,
		setLiveWeather,
		setProfileAllAirspaces,
		setSofiaLang,
		setSupaipLang,
		setConvertImportedTraces,
		setTraceExportFormat,
	} from '$lib/state/display.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { inputChecked } from '$lib/ui/dom';
	import {
		DIM_MAX_PCT,
		DIM_MIN_PCT,
		nightDim,
		setNightDim,
	} from '$lib/state/nightDim.svelte';
	import type { LangPref } from '$lib/i18n/locale';
	import type { AltDatumPref } from '$lib/nav/altitudeDatum';
	import { TRACE_FORMAT_LABEL, TRACE_FORMATS, type TraceFormat } from '$lib/nav/traceExport';
	import ResetDialog from '../ResetDialog.svelte';
	import Segmented from '../Segmented.svelte';

	// The reset confirm (ResetDialog) is mounted only while open, so its
	// Escape / focus wiring exists exactly as long as the dialog does.
	let resetOpen = $state(false);

	// Labels are the invariant format codes; only the per-option tips are
	// translated, so the options rebuild with the locale ($derived, never a
	// module const: docs/i18n.md rule 2).
	const formatTips: Record<TraceFormat, string> = $derived({
		gpx: t.display.traceExportGpxTip,
		igc: t.display.traceExportIgcTip,
		kml: t.display.traceExportKmlTip,
	});
	const formatOptions = $derived(
		TRACE_FORMATS.map((f) => ({
			value: f,
			label: TRACE_FORMAT_LABEL[f],
			title: formatTips[f],
		})),
	);
</script>

<div class="tab-panel">
	<h2>{t.display.title}</h2>


	<fieldset class="group">
		<legend>{t.display.notamMarkersLegend}</legend>
		<label class="check">
			<input type="checkbox" bind:checked={display.typeIcons} />
			{t.display.typeIcons}
		</label>
		<label class="check">
			<input type="checkbox" bind:checked={display.qlineMarkers} />
			{t.display.qlineMarkers}
		</label>
		<label class="check">
			<input type="checkbox" bind:checked={display.qlineRadius} />
			{t.display.qlineRadius}
		</label>
		<label class="check" title={t.display.hideAirportNotamMarkersTip}>
			<input type="checkbox" bind:checked={display.hideAirportNotamMarkers} />
			{t.display.hideAirportNotamMarkers}
		</label>
		<label class="check" title={t.display.affectedAirspacesTip}>
			<input type="checkbox" bind:checked={display.affectedAirspaces} />
			{t.display.affectedAirspaces}
		</label>
		<label class="check" title={t.display.showInAirspacesTip}>
			<input type="checkbox" bind:checked={display.showInAirspaces} />
			{t.display.showInAirspaces}
		</label>
	</fieldset>

	<fieldset class="group">
		<legend>{t.display.sectionLanguages}</legend>
		<!-- Three independent content languages, each persisted when pinned
		     (through the setters, not bind:). The UI language itself switches
		     from the toolbar's LanguageToggle. -->
		<div class="lang-grid">
			{@render langRow(
				t.display.supaipLang,
				t.display.supaipLangTip,
				display.supaipLang,
				setSupaipLang,
			)}
			{@render langRow(
				t.display.sofiaLang,
				t.display.sofiaLangTip,
				display.sofiaLang,
				setSofiaLang,
			)}
			{@render langRow(
				t.display.aipRemarkLang,
				t.display.aipRemarkLangTip,
				display.aipRemarkLang,
				setAipRemarkLang,
			)}
		</div>
	</fieldset>

	<fieldset class="group">
		<legend>{t.display.sectionLiveData}</legend>
		<label class="check" title={t.display.liveWeatherTip}>
			<!-- Through the setter (not bind:): off must survive a reload. -->
			<input
				type="checkbox"
				checked={display.liveWeather}
				onchange={(e) => setLiveWeather(e.currentTarget.checked)}
			/>
			{t.display.liveWeather}
		</label>
	</fieldset>

	<fieldset class="group">
		<legend>{t.display.sectionPosition}</legend>
		<!-- A wrapping row, not the language grid: the long label plus the
		     three-way pill would otherwise overlap in a narrow panel (an
		     end-justified grid item wider than its track spills LEFT over
		     the label). Wrapped, the pill takes its own line instead. -->
		<div class="datum-row">
			<span title={t.display.gpsAltDatumTip}>{t.display.gpsAltDatum}</span>
			<Segmented
				options={[
					{ value: 'auto', label: t.display.gpsAltAuto },
					{ value: 'ellipsoid', label: t.display.gpsAltEllipsoid, title: t.display.gpsAltEllipsoidTip },
					{ value: 'msl', label: t.display.gpsAltMsl, title: t.display.gpsAltMslTip },
				]}
				value={display.gpsAltDatum}
				onSelect={(v) => setGpsAltDatum(v as AltDatumPref)}
				ariaLabel={t.display.gpsAltDatum}
				title={t.display.gpsAltDatumTip}
			/>
		</div>
		<!-- Beside the datum because they answer the same question in turn:
		     what the recorded altitudes MEAN, then how the trace is written
		     out. The choice governs all three export actions (Navigation
		     tab, a flight row, the archive ZIP), which is why it lives here
		     rather than beside any one of them (docs/trace-files.md).
		     It governs what this application RECORDS: an imported trace is
		     handed back as the file it arrived as, which the note below the
		     control states rather than leaving to be discovered. -->
		<div class="datum-row">
			<span title={t.display.traceExportFormatTip}>{t.display.traceExportFormat}</span>
			<Segmented
				options={formatOptions}
				value={display.traceExportFormat}
				onSelect={(v) => setTraceExportFormat(v as TraceFormat)}
				ariaLabel={t.display.traceExportFormat}
				title={t.display.traceExportFormatTip}
			/>
		</div>
		<p class="muted note">{t.display.traceExportImported}</p>
		<label class="check" title={t.display.traceConvertImportedTip}>
			<!-- Through the setter, not bind:, so the choice persists. -->
			<input
				type="checkbox"
				checked={display.convertImportedTraces}
				onchange={(e) => setConvertImportedTraces(inputChecked(e))}
			/>
			{t.display.traceConvertImported}
		</label>
	</fieldset>

	<fieldset class="group">
		<legend>{t.display.sectionAppearance}</legend>
		<label class="check">
			<input type="checkbox" bind:checked={display.cursorCoords} />
			{t.display.cursorCoords}
		</label>
		<label class="check" title={t.display.profileAllAirspacesTip}>
			<!-- Through the setter (not bind:): the choice persists, and the profile
			     charts carry the same switch in their header. -->
			<input
				type="checkbox"
				checked={display.profileAllAirspaces}
				onchange={(e) => setProfileAllAirspaces(e.currentTarget.checked)}
			/>
			{t.display.profileAllAirspaces}
		</label>
		<!-- The night theme's raster brightness, manual or automatic alike;
		     recording past civil twilight merely triggers that same theme
		     (docs/nav-live.md "In-flight ergonomics"). -->
		<label class="dim-row" title={t.display.nightDimTip}>
			<span>{t.display.nightDim}</span>
			<!-- i18n-ignore: % is locale-invariant -->
			<span class="dim-val">{nightDim.pct}%</span>
			<input
				type="range"
				min={DIM_MIN_PCT}
				max={DIM_MAX_PCT}
				step="5"
				value={nightDim.pct}
				aria-label={t.display.nightDim}
				oninput={(e) => setNightDim(Number(e.currentTarget.value))}
			/>
		</label>
	</fieldset>

	<!-- Danger zone at the tab's foot: the reset entry point stays visually
	     apart from the everyday preferences above it. -->
	<div class="danger-zone">
		<button type="button" class="reset-btn" onclick={() => (resetOpen = true)}>
			{t.display.reset}
		</button>
	</div>
</div>

{#if resetOpen}
	<ResetDialog onClose={() => (resetOpen = false)} />
{/if}

<!-- One grid row: a label cell + a tri-state Auto / EN / FR segmented control,
     emitted as two grid children so every row's pill aligns in the shared
     second column. -->
{#snippet langRow(label: string, tip: string, value: LangPref, set: (v: LangPref) => void)}
	<span title={tip}>{label}</span>
	<Segmented
		options={[
			{ value: 'auto', label: t.display.langAuto },
			{ value: 'en', label: 'EN' },
			{ value: 'fr', label: 'FR' },
		]}
		{value}
		onSelect={(v) => set(v as LangPref)}
		ariaLabel={label}
		title={tip}
	/>
{/snippet}

<style>
	/* The note under the trace-format control: it explains the control
	   above it, so it sits tight under it rather than as its own block. */
	.note {
		margin: -2px 0 2px;
		font-size: var(--fs-2xs);
	}

	.danger-zone {
		margin-top: 8px;
		padding-top: 12px;
		border-top: 1px solid var(--border);
	}

	/* Muted danger: the ink says destructive, the frame stays quiet until
	   hovered so the foot does not shout at every visit. */
	.reset-btn {
		padding: 5px 12px;
		font: inherit;
		font-size: 12.5px;
		color: var(--danger);
		background: transparent;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		cursor: pointer;
	}

	.reset-btn:hover {
		border-color: var(--danger);
	}

	.reset-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	/* Label + pill on one line while they fit; the pill wraps to its own
	   line (right-aligned) in a narrow panel instead of overlapping. */
	.datum-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 4px 8px;
	}

	.lang-grid {
		display: grid;
		grid-template-columns: auto auto;
		align-items: center;
		justify-content: start;
		gap: 8px;
	}

	.lang-grid :global(.seg) {
		justify-self: end;
	}

	/* The night-dim slider row: value readout beside the label, the slider
	   taking the remaining width. */
	.dim-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		cursor: pointer;
	}

	.dim-row input[type='range'] {
		flex: 1;
		min-width: 0;
		margin-left: auto;
		max-width: 50%;
	}

	.dim-val {
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}
</style>
