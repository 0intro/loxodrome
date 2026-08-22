<script lang="ts">
	import { onDestroy } from 'svelte';
	import { t } from '$lib/state/i18n.svelte';
	import {
		DEFAULT_LEVEL_FT,
		animationWindow,
		effectiveWindModel,
		floorHourMs,
		modelRunMs,
		nextHourMs,
		setShowWindOnMap,
		setWindIsobars,
		setWindIsotherm,
		setWindIsothermC,
		setWindLevel,
		setWindModel,
		windAloft,
		windGrid,
	} from '$lib/state/windAloft.svelte';
	import { WIND_MODELS, windModel, type WindModelId } from '$lib/weather/openMeteo';
	import { drawWindBarb } from '$lib/weather/windBarbs';
	import { display } from '$lib/state/display.svelte';
	import { mapState } from '$lib/state/map.svelte';
	import { notamState } from '$lib/state/notam.svelte';
	import { effectiveTransitionAltFt } from '$lib/state/transitionAlt.svelte';
	import { theme } from '$lib/state/theme.svelte';
	import {
		metarStations,
		refreshStations,
		setShowStationsOnMap,
		stationFeed,
	} from '$lib/state/metarStations.svelte';
	import { STATION_CAT_COLORS, STATION_NO_CAT_COLOR } from '$lib/map/metarLayer';
	import { formatAge } from '$lib/weather/metar';
	import {
		ensureSofiaCharts,
		refreshSofiaCharts,
		sofiaCharts,
		sofiaChartsEntry,
	} from '$lib/state/sofiaCharts.svelte';
	import {
		refreshSigmets,
		setShowSigmetsOnMap,
		sigmetRings,
		sigmets,
		visibleSigmets,
	} from '$lib/state/sigmets.svelte';
	import { focusSigmet, hoverSigmet } from '$lib/map/sigmetLayer';
	import {
		HAZARD_STYLES,
		sigmetLabel,
		type Sigmet,
		type SigmetHazard,
	} from '$lib/weather/sigmet';
	import { selectSigmet } from '$lib/state/ui.svelte';
	import {
		SOFIA_TEMSI_PAGE,
		SOFIA_WINTEM_PAGE,
		SOFIA_ZONES,
		type SofiaChart,
		type SofiaZone,
	} from '$lib/sofia/charts';
	import { fmtLevel } from '$lib/route/format';
	import { requestWxPrint, wxPrint } from '$lib/state/wxPrint.svelte';
	import { routes } from '$lib/state/route.svelte';
	import FeedStatus from '../FeedStatus.svelte';
	import Icon from '../Icon.svelte';
	import TimeField from '../TimeField.svelte';

	const LEVEL_PRESETS: number[] = [1000, 1500, 2000, 2500, 3000, 4000, 5000, 6500, 8000, 10000];

	// The briefing print needs a planned flight (the NavLog / FlightPrep
	// "printable" rule: a route with a flyable leg).
	const printableRouteCount = $derived(
		routes.list.filter((r) => r.waypoints.length >= 2).length,
	);

	const modelInUse = $derived(
		windGrid.model ?? effectiveWindModel(mapState.center.lat, mapState.center.lng),
	);
	const modelSpec = $derived(windModel(modelInUse));
	const runMs = $derived(modelRunMs(modelInUse));

	const levelValue = $derived(
		windAloft.levelFt === 'sfc'
			? 'sfc'
			: LEVEL_PRESETS.includes(windAloft.levelFt)
				? String(windAloft.levelFt)
				: 'custom',
	);
	let customLevel = $state(false);

	function levelLabel(ft: number): string {
		const s = fmtLevel(ft, effectiveTransitionAltFt());
		return s.startsWith('FL') ? s : `${s} ft`;
	}

	function onLevelSelect(e: Event): void {
		const v = (e.currentTarget as HTMLSelectElement).value;
		if (v === 'custom') {
			customLevel = true;
			if (windAloft.levelFt === 'sfc') {
				setWindLevel(DEFAULT_LEVEL_FT);
			}
			return;
		}
		customLevel = false;
		setWindLevel(v === 'sfc' ? 'sfc' : Number(v));
	}

	function onCustomLevel(e: Event): void {
		const n = Number((e.currentTarget as HTMLInputElement).value);
		if (Number.isFinite(n) && n >= 0 && n <= 60_000) {
			setWindLevel(Math.round(n));
		}
	}

	const dateStr = $derived(new Date(windAloft.validTimeMs).toISOString().slice(0, 10));
	const timeStr = $derived(new Date(windAloft.validTimeMs).toISOString().slice(11, 16));

	function setDateTime(date: string, time: string): void {
		// The inputs are UTC (the filter.svelte.ts convention): the trailing Z
		// is what keeps a browser in any timezone honest.
		const ms = Date.parse(`${date}T${time || '00:00'}:00Z`);
		if (Number.isFinite(ms)) {
			windAloft.validTimeMs = ms;
			windAloft.animating = false;
			windAloft.playing = false;
		}
	}

	function onNow(): void {
		windAloft.validTimeMs = nextHourMs(Date.now());
		windAloft.animating = false;
		windAloft.playing = false;
	}

	const slider = $derived.by(() => {
		// The window ends "now"-relative: track the shared minute tick so the
		// slider bounds follow the wall clock instead of freezing at the
		// Date.now() of the last model change.
		void notamState.tick;
		return animationWindow(modelInUse, Date.now());
	});

	function onSlider(e: Event): void {
		windAloft.animating = true;
		windAloft.validTimeMs = Number((e.currentTarget as HTMLInputElement).value);
	}

	function togglePlay(): void {
		if (windAloft.playing) {
			windAloft.playing = false;
			return;
		}
		windAloft.animating = true;
		windAloft.playing = true;
		if (windAloft.validTimeMs < slider.startMs || windAloft.validTimeMs >= slider.endMs) {
			windAloft.validTimeMs = slider.startMs;
		}
	}

	$effect(() => {
		if (!windAloft.playing) {
			return;
		}
		const win = animationWindow(modelInUse, Date.now());
		const id = setInterval(() => {
			const next = floorHourMs(windAloft.validTimeMs) + 3600_000;
			windAloft.validTimeMs = next > win.endMs ? win.startMs : next;
		}, 700);
		return () => clearInterval(id);
	});

	// The play mode is global state but its tick loop lives in this component:
	// pause on unmount (like the pause button; `animating` keeps the slider
	// position) so leaving the tab can't strand a "playing" animation that no
	// loop advances, silently resuming whenever the tab reopens.
	onDestroy(() => {
		windAloft.playing = false;
	});

	/** "07-04 14:00Z" (compact UTC month-day + hour). */
	function fmtUtc(ms: number): string {
		return `${new Date(ms).toISOString().slice(5, 16).replace('T', ' ')}Z`;
	}

	// Key-only rows (docs/i18n.md rule 2): the four category codes are
	// locale-invariant and render as-is; null is the no-category row, whose
	// label comes from the catalog at render time.
	const STATION_CATS: { code: 'VFR' | 'MVFR' | 'IFR' | 'LIFR' | null; color: string }[] = [
		{ code: 'VFR', color: STATION_CAT_COLORS.VFR },
		{ code: 'MVFR', color: STATION_CAT_COLORS.MVFR },
		{ code: 'IFR', color: STATION_CAT_COLORS.IFR },
		{ code: 'LIFR', color: STATION_CAT_COLORS.LIFR },
		{ code: null, color: STATION_NO_CAT_COLOR },
	];
	const stationCount = $derived(metarStations.showOnMap ? stationFeed().length : 0);
	const stationAge = $derived.by(() => {
		void notamState.tick;
		if (!metarStations.fetchedAtMs) {
			return null;
		}
		return formatAge(Math.round((Date.now() - metarStations.fetchedAtMs) / 60_000), t.weather.metar);
	});

	// The FeedStatus line: one resolved {status, ageText?, error?} record per
	// feed, keeping the branch order the inline markup had (hidden / zoom-in
	// win over a stale error state).
	const stationLine = $derived.by(() => {
		if (!metarStations.showOnMap) {
			return { status: t.weather.stationsHidden };
		}
		if (metarStations.status === 'zoom-in') {
			return { status: t.weather.zoomInStations };
		}
		if (metarStations.status === 'error') {
			return { status: '', error: `${t.weather.fetchFailed} ${metarStations.error}` };
		}
		if (metarStations.status === 'loading') {
			return { status: t.weather.loadingStations };
		}
		return {
			status: t.weather.stationCount(stationCount),
			ageText: stationAge ? t.weather.refreshedAgo(stationAge) : null,
		};
	});

	// TEMSI / WINTEM catalog: fetched while the tab shows the section (the
	// component only exists on the active tab) and the zone changes. The
	// minute tick auto-refreshes the catalog at its 5 min TTL, so the
	// tokenized links stay live while the tab sits open.
	$effect(() => {
		void notamState.tick;
		if (display.liveWeather) {
			ensureSofiaCharts(sofiaCharts.zone);
		}
	});
	const sofiaEntry = $derived(sofiaChartsEntry());
	const sofiaAge = $derived.by(() => {
		void notamState.tick;
		const at = sofiaEntry?.fetchedAtMs ?? 0;
		return at > 0 ? formatAge(Math.round((Date.now() - at) / 60_000), t.weather.metar) : null;
	});

	const sofiaLine = $derived.by(() => {
		if (!display.liveWeather) {
			return { status: t.weather.liveWeatherOff };
		}
		if (sofiaEntry?.status === 'loading') {
			return { status: t.weather.loadingCatalog };
		}
		if (sofiaEntry?.status === 'error') {
			return { status: '', error: sofiaEntry.error };
		}
		if (sofiaEntry && sofiaEntry.temsi.length === 0 && sofiaEntry.wintem.length === 0) {
			return { status: t.weather.noCharts };
		}
		// The age IS the sentence here (it carries the link-expiry warning);
		// before the first fetch settles the line is just the button.
		return { status: sofiaAge ? t.weather.catalogFetched(sofiaAge) : '' };
	});

	// Called from the template, so the t.* read is tracked (product / zone /
	// level are data passthrough; only the "valid" word translates).
	function chartLabel(c: SofiaChart): string {
		return t.weather.chartLabel({
			chart: `${c.product} ${c.zone}${c.level ? ` ${c.level}` : ''}`,
			deadline: c.deadline,
		});
	}

	// SIGMET advisories: the list shows whenever the tab is open (the map
	// toggle only gates the polygons), so mark the tab open for the fetch
	// gate while this component exists.
	$effect(() => {
		sigmets.tabOpen = true;
		return () => {
			sigmets.tabOpen = false;
		};
	});
	const SIGMET_LEGEND: SigmetHazard[] = ['TS', 'TURB', 'ICE', 'MTW', 'VA', 'TC'];
	const sigmetList = $derived(
		display.liveWeather ? [...visibleSigmets()].sort((a, b) => a.validFromMs - b.validFromMs) : [],
	);
	const sigmetAge = $derived.by(() => {
		void notamState.tick;
		const at = sigmets.fetchedAtMs;
		return at > 0 ? formatAge(Math.round((Date.now() - at) / 60_000), t.weather.metar) : null;
	});

	const sigmetLine = $derived.by(() => {
		if (!display.liveWeather) {
			return { status: t.weather.liveWeatherOff };
		}
		if (sigmets.status === 'error') {
			return { status: '', error: sigmets.error };
		}
		if (sigmets.status === 'loading') {
			return { status: t.weather.loadingAdvisories };
		}
		if (sigmetList.length === 0) {
			return { status: t.weather.noAdvisories };
		}
		return {
			status: t.weather.advisoriesWorldwide(sigmetList.length),
			ageText: sigmetAge ? t.weather.refreshedAgo(sigmetAge) : null,
		};
	});

	function sigmetUntil(s: Sigmet): string {
		const d = new Date(s.validToMs);
		const hh = String(d.getUTCHours()).padStart(2, '0');
		const mm = String(d.getUTCMinutes()).padStart(2, '0');
		return t.weather.sigmetUntil(`${hh}:${mm}`);
	}

	function onSigmetRow(s: Sigmet): void {
		selectSigmet(s.id);
		hoverSigmet(null);
		if (mapState.map) {
			focusSigmet(mapState.map, { sigmet: s, rings: sigmetRings(s) });
		}
	}

	function onSigmetRefresh(): void {
		refreshSigmets();
	}

	function onSofiaRefresh(): void {
		refreshSofiaCharts();
		ensureSofiaCharts(sofiaCharts.zone);
	}

	let legendCanvas: HTMLCanvasElement | undefined = $state();
	let legendBox = $state({ w: 0, h: 0 });

	// The canvas fills its group, so the width it has to draw in is whatever
	// the sidebar leaves. Track the box the way MapView keeps Leaflet in sync
	// with its container; the draw effect below lays the samples out to fit.
	$effect(() => {
		const c = legendCanvas;
		if (!c) {
			return;
		}
		const ro = new ResizeObserver(() => {
			legendBox = { w: c.clientWidth, h: c.clientHeight };
		});
		ro.observe(c);
		return () => ro.disconnect();
	});

	$effect(() => {
		// Redraw the legend in the panel's own text colour on theme flips; the
		// t.weather.barb read below re-runs it on locale switches too, so the
		// baked canvas text never goes stale (docs/i18n.md rule 3).
		void theme.value;
		const c = legendCanvas;
		const ctx = c?.getContext('2d');
		const { w, h } = legendBox;
		if (!c || !ctx || w < 8 || h < 8) {
			return;
		}
		const dpr = window.devicePixelRatio || 1;
		c.width = Math.round(w * dpr);
		c.height = Math.round(h * dpr);
		ctx.scale(dpr, dpr);
		ctx.clearRect(0, 0, w, h);
		const ink = getComputedStyle(c).color || '#31414f';
		const samples: [number, string][] = [
			[0, t.weather.barb.calm],
			[5, '5 kt'],
			[10, '10 kt'],
			[25, '25 kt'],
			[50, '50 kt'],
		];
		// The design geometry is a 52px pitch at a 40px staff. Where the panel
		// cannot seat the five samples at that, they share the width out and
		// the staff shrinks with the pitch, so neighbours never collide.
		const pitch = Math.min(52, (w - 4) / samples.length);
		const staff = Math.min(40, pitch - 8);
		samples.forEach(([spd, label], i) => {
			const cx = 2 + pitch * (i + 0.5);
			// The NWS reference-tile pose: staff horizontal (wind from the
			// west), feathers up, station at the right end; drawn at the
			// tiles' own staff-to-stroke scale. Calm centers on its label.
			drawWindBarb(ctx, spd === 0 ? cx : cx + staff / 2, h / 2, 270, spd, staff, {
				stroke: ink,
			});
			// i18n-ignore: CSS font shorthand, not user-visible text
			ctx.font = '10px system-ui, sans-serif';
			ctx.fillStyle = ink;
			ctx.textAlign = 'center';
			ctx.fillText(label, cx, h - 4);
		});
	});
</script>

<div class="tab-panel">
	<div class="tab-head">
		<h2>{t.weather.title}</h2>
		<button
			class="btn"
			onclick={requestWxPrint}
			disabled={!display.liveWeather || printableRouteCount === 0 || wxPrint.preparing}
			title={t.weather.printBriefTip}
		>
			<Icon name="printer" size={13} />
			{t.weather.printBrief}
		</button>
	</div>
	{#if wxPrint.note === 'empty'}
		<p class="muted small">{t.weather.printBriefEmpty}</p>
	{/if}

	{#if !display.liveWeather}
		<p class="warn">
			{t.weather.liveWeatherDisabled}
		</p>
	{/if}

	<fieldset class="group">
		<legend>{t.weather.windsAloftLegend}</legend>
		<label class="check">
			<input
				type="checkbox"
				checked={windAloft.showOnMap}
				onchange={(e) => setShowWindOnMap(e.currentTarget.checked)}
			/>
			<span>{t.weather.showWindBarbs}</span>
		</label>
		<div class="check iso-row">
			<input
				id="wind-isotherm-on"
				type="checkbox"
				checked={windAloft.isotherm0}
				onchange={(e) => setWindIsotherm(e.currentTarget.checked)}
			/>
			<label for="wind-isotherm-on">{t.weather.isothermAtLevel}</label>
			<select
				value={String(windAloft.isothermC)}
				disabled={!windAloft.isotherm0}
				onchange={(e) => setWindIsothermC(Number(e.currentTarget.value))}
				aria-label={t.weather.isothermTempAria}
			>
				{#each [-20, -15, -10, -5, 0, 5, 10] as c (c)}
					<option value={String(c)}>{c > 0 ? `+${c}` : String(c)} °C</option>
				{/each}
			</select>
		</div>
		<label class="check" title={t.weather.isobarsTip}>
			<input
				type="checkbox"
				checked={windAloft.isobars}
				onchange={(e) => setWindIsobars(e.currentTarget.checked)}
			/>
			<span>{t.weather.isobars}</span>
		</label>
		<!-- A canvas maps to a generic element, which exposes no name, so the
	     legend is its FALLBACK CONTENT: that subtree is what a screen reader
	     reads, and an aria-label here was silently dropped. -->
		<canvas class="legend" bind:this={legendCanvas}>{t.weather.barbLegendAria}</canvas>

		<!-- One select each, so Model and Altitude are rows of this group
		     rather than fieldsets of their own; their notes ride along. -->
		<label class="range-label row">
			<span>{t.weather.model}</span>
			<select value={windAloft.model} onchange={(e) => setWindModel(e.currentTarget.value as 'auto' | WindModelId)}>
				<option value="auto">{t.weather.autoByRegion}</option>
				{#each WIND_MODELS as m (m.id)}
					<option value={m.id}>{t.weather.windModels[m.id]}</option>
				{/each}
			</select>
		</label>
		<p class="muted small">
			{t.weather.modelLine({ model: t.weather.windModels[modelSpec.id], days: Math.round(modelSpec.horizonH / 24) })}{runMs != null
				? `, ${t.weather.modelRun(fmtUtc(runMs))}`
				: ''}.
			{#if windGrid.status === 'loading'}{t.weather.updating}{/if}
			{#if windGrid.status === 'error'}<span class="warn-inline" role="alert">{t.weather.fetchFailed} {windGrid.error?.()}</span>{/if}
		</p>
		<label class="range-label row">
			<span>{t.weather.level}</span>
			<select value={customLevel ? 'custom' : levelValue} onchange={onLevelSelect}>
				<option value="sfc">{t.weather.surface10m}</option>
				{#each LEVEL_PRESETS as ft (ft)}
					<option value={String(ft)}>{levelLabel(ft)}</option>
				{/each}
				<option value="custom">{t.weather.custom}</option>
			</select>
		</label>
		{#if customLevel || levelValue === 'custom'}
			<label class="range-label row">
				<span>{t.weather.feet}</span>
				<input
					type="number"
					min="0"
					max="60000"
					step="500"
					value={windAloft.levelFt === 'sfc' ? DEFAULT_LEVEL_FT : windAloft.levelFt}
					onchange={onCustomLevel}
				/>
				<span class="hint">ft AMSL</span>
			</label>
		{/if}
		<p class="muted small">
			{t.weather.altitudesNote}
		</p>
	</fieldset>

	<fieldset class="group">
		<legend>{t.weather.dateTimeLegend}</legend>
		<div class="range">
			<div class="range-label">
				<span>{t.weather.valid}</span>
				<input
					type="date"
					value={dateStr}
					onchange={(e) => setDateTime(e.currentTarget.value, timeStr)}
					aria-label={t.weather.validDateAria}
				/>
				<TimeField
					value={timeStr}
					oncommit={(v: string) => setDateTime(dateStr, v)}
					ariaLabel={t.weather.validTimeAria}
				/>
				<button class="btn" onclick={onNow}>{t.weather.now}</button>
			</div>
			<div class="range-label">
				<button
					class="btn play"
					onclick={togglePlay}
					aria-label={windAloft.playing ? t.weather.pauseAnimation : t.weather.playAnimation}
				>
					<Icon name={windAloft.playing ? 'pause' : 'play'} size={14} />
				</button>
				<input
					type="range"
					min={slider.startMs}
					max={slider.endMs}
					step={3600_000}
					value={Math.min(Math.max(windAloft.validTimeMs, slider.startMs), slider.endMs)}
					oninput={onSlider}
					aria-label={t.weather.animateAria}
				/>
			</div>
			<p class="muted small slider-time">{t.weather.showing(fmtUtc(windAloft.validTimeMs))}</p>
		</div>
	</fieldset>

	<fieldset class="group">
		<legend>{t.weather.metarStationsLegend}</legend>
		<label class="check">
			<input
				type="checkbox"
				checked={metarStations.showOnMap}
				onchange={(e) => setShowStationsOnMap(e.currentTarget.checked)}
			/>
			<span>{t.weather.showStations}</span>
		</label>
		<p class="cat-legend">
			{#each STATION_CATS as c (c.code ?? 'none')}
				<span class="cat"><span class="cat-dot" style:background={c.color}></span>{c.code ?? t.weather.station.noCategory}</span>
			{/each}
		</p>
		<p class="muted small">
			{t.weather.stationsNote}
		</p>
		<FeedStatus {...stationLine} onRefresh={refreshStations} disabled={!metarStations.showOnMap} />
	</fieldset>

	<fieldset class="group">
		<legend>SIGMET</legend>
		<label class="check">
			<input
				type="checkbox"
				checked={sigmets.showOnMap}
				onchange={(e) => setShowSigmetsOnMap(e.currentTarget.checked)}
			/>
			<span>{t.weather.showSigmets}</span>
		</label>
		<p class="cat-legend">
			{#each SIGMET_LEGEND as h (h)}
				<span class="cat"><span class="cat-dot" style:background={HAZARD_STYLES[h].color}></span>{t.weather.hazards[h]}</span>
			{/each}
		</p>
		{#if sigmetList.length > 0}
			<ul class="sigmet-list">
				{#each sigmetList as s (s.id)}
					<li>
						<button
							class="sigmet-row"
							onmouseenter={() => hoverSigmet({ sigmet: s, rings: sigmetRings(s) })}
							onmouseleave={() => hoverSigmet(null)}
							onclick={() => onSigmetRow(s)}
						>
							<span class="cat-dot" style:background={HAZARD_STYLES[s.hazard].color}></span>
							<span class="sigmet-text">
								<span class="sigmet-what">{sigmetLabel(s, t.weather.sigmet)}</span>
								<span class="sigmet-where">{s.firName ?? s.fir ?? 'US'}, {sigmetUntil(s)}</span>
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
		<FeedStatus {...sigmetLine} onRefresh={onSigmetRefresh} disabled={!display.liveWeather} />
		<p class="muted small">
			{t.weather.advisoriesBy}
		</p>
	</fieldset>

	<fieldset class="group">
		<legend>TEMSI &amp; WINTEM (SOFIA)</legend>
		<label class="range-label">
			<span>{t.weather.zone}</span>
			<select
				value={sofiaCharts.zone}
				onchange={(e) => (sofiaCharts.zone = e.currentTarget.value as SofiaZone)}
				aria-label={t.weather.chartZoneAria}
			>
				{#each SOFIA_ZONES as z (z)}
					<option value={z}>{z}</option>
				{/each}
			</select>
		</label>
		{#if sofiaEntry && (sofiaEntry.temsi.length > 0 || sofiaEntry.wintem.length > 0)}
			<ul class="chart-list">
				{#each [...sofiaEntry.temsi, ...sofiaEntry.wintem] as c (c.url)}
					<li>
						<a href={c.url} target="_blank" rel="noopener noreferrer" title={t.weather.downloadPdfTip}>
							<Icon name="download" size={13} />
							<span>{chartLabel(c)}</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
		<FeedStatus {...sofiaLine} onRefresh={onSofiaRefresh} disabled={!display.liveWeather} />
		<p class="muted small">
			{t.weather.sofiaCreditPre}
			<a href={SOFIA_TEMSI_PAGE} target="_blank" rel="noopener noreferrer">SOFIA TEMSI</a>
			{t.weather.sofiaCreditAnd}
			<a href={SOFIA_WINTEM_PAGE} target="_blank" rel="noopener noreferrer">SOFIA WINTEM</a>
			(DGAC).
		</p>
	</fieldset>

	<p class="muted small attribution">
		<a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer"
			>{t.weather.openMeteoCredit}</a
		>, CC BY 4.0.
	</p>
</div>

<style>
	.tab-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.tab-head h2 {
		flex: 1;
		min-width: 0;
	}

	.tab-head .btn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}

	.iso-row label {
		cursor: pointer;
	}

	.iso-row select {
		margin-left: auto;
		padding: 3px 6px;
		font: inherit;
		font-size: 11px;
		color: var(--text);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 4px;
	}

	.iso-row select:disabled {
		opacity: 0.5;
	}

	.cat-legend {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 12px;
		margin: 6px 0 0;
		font-size: 11px;
		color: var(--text-muted);
	}

	.cat {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.cat-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
	}

	.sigmet-list {
		max-height: 240px;
		margin: 6px 0 0;
		padding: 0;
		overflow-y: auto;
		list-style: none;
		font-size: 12px;
	}

	.sigmet-row {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 3px 0;
		font: inherit;
		text-align: left;
		color: var(--text);
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.sigmet-row:hover .sigmet-what {
		color: var(--accent);
		text-decoration: underline;
	}

	.sigmet-row:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.sigmet-row .cat-dot {
		flex: none;
	}

	/* The hazard over its FIR and validity, the NOTAM list's row shape: the
	   label wraps whole and only the secondary line is cut. */
	.sigmet-text {
		display: flex;
		min-width: 0;
		flex-direction: column;
	}

	.sigmet-what {
		font-weight: 600;
	}

	.sigmet-where {
		overflow: hidden;
		color: var(--text-muted);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chart-list {
		margin: 6px 0 0;
		padding: 0;
		list-style: none;
		font-size: 12px;
	}

	.chart-list a {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 0;
		color: var(--text);
		text-decoration: none;
	}

	.chart-list a:hover {
		color: var(--accent);
		text-decoration: underline;
	}

	.range {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 6px;
	}

	.range-label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
	}

	.range-label > span:first-child {
		flex: 0 0 50px;
		color: var(--text-muted);
	}

	/* The Model / Level rows folded into the winds group: air above each,
	   since they stand alone rather than inside the .range column's gap. */
	.range-label.row {
		margin-top: 6px;
	}

	.range-label input,
	.range-label select {
		flex: 1;
		min-width: 0;
		padding: 5px 7px;
		font: inherit;
		color: var(--text);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 4px;
	}

	.range-label input[type='range'] {
		padding: 0;
		border: none;
		background: transparent;
		accent-color: var(--accent);
	}

	.btn.play {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
	}

	.hint {
		flex: 0 0 56px;
		white-space: nowrap;
		font-size: 11px;
		color: var(--text-muted);
	}

	/* The box the legend effect draws into: full width, so the samples follow
	   the sidebar rather than sit at a width a narrow panel cannot seat. */
	.legend {
		display: block;
		width: 100%;
		height: 48px;
		margin-top: 6px;
		color: var(--text);
	}

	.small {
		font-size: 11px;
	}

	.slider-time {
		margin: 0;
	}

	.warn-inline {
		color: var(--danger);
	}

	.attribution a {
		color: inherit;
	}
</style>
