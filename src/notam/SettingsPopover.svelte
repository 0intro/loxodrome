<script lang="ts">
	/* The preferences this app EXERCISES.
	 *
	 * Loxodrome's Settings tab is 368 lines over the position, the trace
	 * format, the in-flight interface and a reset that sweeps every
	 * `loxodrome:` key. None of that exists here, and `state/reset.ts` reaches
	 * navRecording, routePersist, flightLibrary and sync, none of which this
	 * app exercises (the first rides along with the shared airport panel,
	 * inert: state/appIdentity.ts), on storage it now SHARES with the flight
	 * app.
	 *
	 * What is left is the part this app owes a control: the languages of the
	 * downloaded content it displays, the live weather it shows, and the two
	 * reading preferences its own surfaces read. Every one of them is a
	 * shared `display.*` field with its own setter, so it persists with no
	 * PersistHost, and until this panel existed there was no way to change any
	 * of them here. The scope row is the sharpest case: it is written from the
	 * profile chart's own header, it persists, and a reader who picked "on
	 * map" with no airspace category ticked was left with an emptied profile
	 * and nothing in this app that could undo it.
	 *
	 * Every label and every meaning is the shared catalogs', because every
	 * preference is a shared preference: state/display.svelte.ts is one
	 * definition, and this is a second face on it rather than a second set of
	 * values. One TIP is this app's own, the night dimming's, whose shared text
	 * also describes a recording this app does not have. The rule
	 * this panel states, and the reason it exists: a shell that mounts a shared
	 * component offers a control for every preference that component reads, or
	 * pins it by decision (docs/notam-viewer.md, "The preferences it reads").
	 */
	import HeadOverlay from '$lib/components/HeadOverlay.svelte';
	import Segmented from '$lib/components/Segmented.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import type { LangPref } from '$lib/i18n/locale';
	import {
		display,
		setAipRemarkLang,
		setLiveWeather,
		setProfileAllAirspaces,
		setSofiaLang,
		setSupaipLang,
	} from '$lib/state/display.svelte';
	import {
		DIM_MAX_PCT,
		DIM_MIN_PCT,
		nightDim,
		setNightDim,
	} from '$lib/state/nightDim.svelte';

	let { open, x, y, onClose }: { open: boolean; x: number; y: number; onClose: () => void } =
		$props();
</script>

<HeadOverlay {open} {x} {y} title={t.display.title} minWidthPx={300} {onClose}>
	<div class="settings-pop popover-panel">
		<fieldset class="group">
			<legend>{t.display.sectionLanguages}</legend>
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
			<!-- The aerodrome panel's METAR / TAF. NOT every request the app
			     makes beyond its datasets and briefing source: the base map
			     and the altitude profile's terrain mosaic are fetched as they
			     are drawn and this does not gate them (About says so too). A
			     kill switch has to survive a reload, and setLiveWeather is
			     what makes it. -->
			<label class="check" title={t.display.liveWeatherTip}>
				<input
					type="checkbox"
					checked={display.liveWeather}
					onchange={(e) => setLiveWeather(e.currentTarget.checked)}
				/>
				<span>{t.display.liveWeather}</span>
			</label>
		</fieldset>

		<fieldset class="group">
			<legend>{t.display.sectionAppearance}</legend>
			<!-- The scope the altitude profiles plot at, the row this panel was
			     built for: its other control is the segmented one in the chart's
			     own header, which once went with the columns when the scope
			     emptied the chart, and "on map" was then a door with no way
			     back. The header keeps it now; this row stays the one control a
			     reader finds without opening a profile. -->
			<label class="check" title={t.display.profileAllAirspacesTip}>
				<input
					type="checkbox"
					checked={display.profileAllAirspaces}
					onchange={(e) => setProfileAllAirspaces(e.currentTarget.checked)}
				/>
				<span>{t.display.profileAllAirspaces}</span>
			</label>
			<!-- The one tip of this app's own: the shared one describes the
			     recording's automatic night theme, which this app does not have. -->
			<label class="dim-row" title={t.viewer.nightDimTip}>
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
	</div>
</HeadOverlay>

<!-- One grid row: a label cell + a tri-state Auto / EN / FR segmented control,
     emitted as two grid children so every row's pill aligns in the shared
     second column. The Settings tab's own shape (SettingsTab.svelte). -->
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
	.settings-pop {
		display: flex;
		flex-direction: column;
		gap: 12px;
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
