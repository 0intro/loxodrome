<script lang="ts">
	import {
		display,
		setAipRemarkLang,
		setGpsAltDatum,
		setLiveWeather,
		setLayersControl,
		setToolbarInFlight,
		setFlightFullscreen,
		setLockRouteInFlight,
		setProfileAllAirspaces,
		setSofiaLang,
		setSupaipLang,
		setConvertImportedTraces,
		setDisplayFlag,
		setTraceExportFormat,
	} from '$lib/state/display.svelte';
	import { localePref, setLocalePref, t } from '$lib/state/i18n.svelte';
	import { setThemePref, theme, type ThemePref } from '$lib/state/theme.svelte';
	import { ui } from '$lib/state/ui.svelte';
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
	import ConfirmDialog from '../ConfirmDialog.svelte';
	import ResetDialog from '../ResetDialog.svelte';
	import Segmented from '../Segmented.svelte';
	import { canRestoreDefaults, restoreDefaultSettings } from '$lib/state/defaultSettings';
	import { onDestroy } from 'svelte';

	// The reset confirm (ResetDialog) is mounted only while open, so its
	// Escape / focus wiring exists exactly as long as the dialog does.
	let resetOpen = $state(false);

	// Restore default settings (state/defaultSettings.ts): asked through the
	// shared confirm, then a status line that says it happened, since nothing
	// reloads and a row already at its default does not move.
	let restoreAsk = $state(false);
	let restored = $state(false);
	let restoredTimer: ReturnType<typeof setTimeout> | null = null;
	onDestroy(() => {
		if (restoredTimer !== null) {
			clearTimeout(restoredTimer);
		}
	});

	function confirmRestore(): void {
		restoreAsk = false;
		// Refused while a recording runs, one having begun under the confirm
		// included (state/defaultSettings.ts canRestoreDefaults).
		if (!restoreDefaultSettings()) {
			return;
		}
		restored = true;
		if (restoredTimer !== null) {
			clearTimeout(restoredTimer);
		}
		restoredTimer = setTimeout(() => {
			restoredTimer = null;
			restored = false;
		}, 6000);
	}

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
			<input
				type="checkbox"
				checked={display.typeIcons}
				onchange={(e) => setDisplayFlag('typeIcons', inputChecked(e))}
			/>
			{t.display.typeIcons}
		</label>
		<label class="check">
			<input
				type="checkbox"
				checked={display.qlineMarkers}
				onchange={(e) => setDisplayFlag('qlineMarkers', inputChecked(e))}
			/>
			{t.display.qlineMarkers}
		</label>
		<label class="check">
			<input
				type="checkbox"
				checked={display.qlineRadius}
				onchange={(e) => setDisplayFlag('qlineRadius', inputChecked(e))}
			/>
			{t.display.qlineRadius}
		</label>
		<label class="check" title={t.display.hideAirportNotamMarkersTip}>
			<input
				type="checkbox"
				checked={display.hideAirportNotamMarkers}
				onchange={(e) => setDisplayFlag('hideAirportNotamMarkers', inputChecked(e))}
			/>
			{t.display.hideAirportNotamMarkers}
		</label>
		<label class="check" title={t.display.affectedAirspacesTip}>
			<input
				type="checkbox"
				checked={display.affectedAirspaces}
				onchange={(e) => setDisplayFlag('affectedAirspaces', inputChecked(e))}
			/>
			{t.display.affectedAirspaces}
		</label>
		<label class="check" title={t.display.showInAirspacesTip}>
			<input
				type="checkbox"
				checked={display.showInAirspaces}
				onchange={(e) => setDisplayFlag('showInAirspaces', inputChecked(e))}
			/>
			{t.display.showInAirspaces}
		</label>
	</fieldset>

	<fieldset class="group">
		<legend>{t.display.sectionLanguages}</legend>
		<!-- The app language first, then three independent languages of
		     downloaded content, each persisted only when pinned (through the
		     setters, not bind:). Auto follows the browser for the first
		     (state/i18n.svelte.ts) and the app language for the others; the
		     toolbar's EN / FR pins the first. -->
		<div class="lang-grid">
			{@render langRow(
				t.display.uiLang,
				t.display.uiLangTip,
				localePref.value,
				setLocalePref,
			)}
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
		<!-- The theme choice (state/theme.svelte.ts): Auto follows the device's
		     light or dark appearance and is the key's absence, Day / Night pin
		     it, and so does the toolbar's sun / moon. The recording's automatic
		     night is not a choice and never moves this row: the note says when
		     it is in force. -->
		<div class="datum-row">
			<span title={t.display.themeTip}>{t.display.theme}</span>
			<Segmented
				options={[
					{ value: 'auto', label: t.display.themeAuto },
					{ value: 'day', label: t.display.themeDay },
					{ value: 'night', label: t.display.themeNight },
				]}
				value={theme.pref}
				onSelect={(v) => setThemePref(v as ThemePref)}
				ariaLabel={t.display.theme}
				title={t.display.themeTip}
			/>
		</div>
		{#if theme.autoNight}
			<p class="muted note">{t.display.themeAutoNight}</p>
		{/if}
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
		<label class="check">
			<input
				type="checkbox"
				checked={display.cursorCoords}
				onchange={(e) => setDisplayFlag('cursorCoords', inputChecked(e))}
			/>
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
	</fieldset>

	<!-- Settings > Interface: how the chrome behaves, on every layout for the
	     route lock, the three phone choices the pilot took on the mock
	     (docs/mobile-ui-review.md) on a phone. Each persists through its
	     setter, stored only away from its default. -->
	<fieldset class="group">
		<legend>{t.display.sectionInterface}</legend>
		<!-- In flight the route takes no drag on the map
		     (state/routeLock.svelte.ts); the menu's Move waypoint frees one
		     pin for one drag. -->
		<label class="check" title={t.display.lockRouteInFlightTip}>
			<input
				type="checkbox"
				checked={display.lockRouteInFlight}
				onchange={(e) => setLockRouteInFlight(e.currentTarget.checked)}
			/>
			{t.display.lockRouteInFlight}
		</label>
		{#if ui.isMobile}
			<div class="pref-row">
				<span>{t.display.layersControl}</span>
				<Segmented
					options={[
						{ value: 'toolbar', label: t.display.layersControlToolbar },
						{ value: 'map', label: t.display.layersControlMap },
					]}
					value={display.layersControl}
					onSelect={(v) => setLayersControl(v === 'map' ? 'map' : 'toolbar')}
					ariaLabel={t.display.layersControl}
				/>
			</div>
			<div class="pref-row">
				<span>{t.display.toolbarInFlight}</span>
				<Segmented
					options={[
						{ value: 'kept', label: t.display.toolbarKept },
						{ value: 'folded', label: t.display.toolbarFolded },
					]}
					value={display.toolbarInFlight}
					onSelect={(v) => setToolbarInFlight(v === 'folded' ? 'folded' : 'kept')}
					ariaLabel={t.display.toolbarInFlight}
				/>
			</div>
			<label class="check" title={t.display.flightFullscreenTip}>
				<input
					type="checkbox"
					checked={display.flightFullscreen}
					onchange={(e) => setFlightFullscreen(e.currentTarget.checked)}
				/>
				{t.display.flightFullscreen}
			</label>
		{/if}
	</fieldset>

	<!-- Restore default settings: every preference back, in place, nothing
	     erased, so it sits above the danger zone rather than in it. It is
	     unavailable while recording, when it would re-arm or silence the
	     alerts and move the GNSS datum under a pilot in flight. The status
	     line is always in the DOM, so the live region exists before its text
	     does. -->
	<div class="restore-row">
		<button
			type="button"
			class="btn"
			disabled={!canRestoreDefaults()}
			title={t.display.restoreTip}
			onclick={() => {
				restored = false;
				restoreAsk = true;
			}}
		>
			{t.display.restoreDefaults}
		</button>
		{#if !canRestoreDefaults()}
			<p class="muted note">{t.display.restoreRecording}</p>
		{/if}
		<p class="muted note restore-status" role="status">
			{restored ? t.display.restoreDone : ''}
		</p>
	</div>

	<!-- Danger zone at the tab's foot: the reset entry point stays visually
	     apart from the everyday preferences above it. -->
	<div class="danger-zone">
		<button type="button" class="btn reset-btn" onclick={() => (resetOpen = true)}>
			{t.display.reset}
		</button>
	</div>
</div>

{#if restoreAsk}
	<ConfirmDialog
		message={t.display.restoreConfirm}
		confirmLabel={t.display.restoreConfirmAction}
		onConfirm={confirmRestore}
		onCancel={() => (restoreAsk = false)}
	/>
{/if}

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
			{ value: 'en', label: 'EN', title: t.common.langEnglish },
			{ value: 'fr', label: 'FR', title: t.common.langFrench },
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

	.restore-row {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
		margin-top: 4px;
	}

	.restore-status:empty {
		margin: 0;
	}

	.danger-zone {
		margin-top: 8px;
		padding-top: 12px;
		border-top: 1px solid var(--border);
	}

	/* Muted danger over the shared .btn: the ink says destructive, the frame
	   stays quiet until hovered so the foot does not shout at every visit.
	   Its size, focus ring and touch floor are .btn's: a bespoke button here
	   stayed 26px high under touch-ui, beside the 44px Restore above it. */
	.reset-btn {
		font-size: 12.5px;
		color: var(--danger);
		background: transparent;
	}

	.reset-btn:hover:not(:disabled) {
		border-color: var(--danger);
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

	/* Label and pill on one line while they fit, the pill on a line of its
	   own when they do not, never an option broken over two lines inside
	   its button (the French phone's "Barre d'outils" and "Sur la carte"
	   did, beside "Commande des couches"). */
	.pref-row {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 8px;
		align-items: center;
		justify-content: space-between;
		min-height: 36px;
	}

	.pref-row :global(.seg button),
	.datum-row :global(.seg button) {
		white-space: nowrap;
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
