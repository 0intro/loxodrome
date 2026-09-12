<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	/* One decoded METAR card: the raw report first (pilots read raw), decoded
	 * chips under it, and a freshness-tinted age line. Shared by the airport
	 * panel's WeatherSection and the dedicated MetarStationDetail so the two
	 * renderings never drift. Age recomputes from the caller's nowMs (the
	 * shared minute tick), keeping this component free of its own clock. */

	import type { AwcMetar } from '$lib/weather/awc';
	import {
		metarAgeMin,
		metarFreshness,
		formatAge,
		formatWind,
		formatVisib,
		formatClouds,
		formatWeather,
		qnhFromMetar,
	} from '$lib/weather/metar';

	interface Props {
		metar: AwcMetar;
		/** Now, in ms, from the caller's minute-tick derived. */
		nowMs: number;
		/** Optional provenance line (e.g. a nearest-station note). */
		sourceNote?: string | null;
	}

	let { metar, nowMs, sourceNote = null }: Props = $props();

	const age = $derived(metarAgeMin(metar, nowMs));
	const qnh = $derived(qnhFromMetar(metar));

	function tempLine(m: AwcMetar): string | null {
		if (m.temp == null) {
			return null;
		}
		return m.dewp == null ? `${m.temp} °C` : `${m.temp} / ${m.dewp} °C`;
	}
</script>

<div class="card">
	{#if sourceNote}
		<div class="source">{sourceNote}</div>
	{/if}
	<!-- Raw METAR: aviation-code source data (docs/i18n.md rule 11). -->
	<pre class="raw" lang="en">{metar.rawOb}</pre>
	<div class="chips">
		{#if formatWind(metar, t.weather.metar)}<span class="chip">{formatWind(metar, t.weather.metar)}</span>{/if}
		{#if formatVisib(metar.visib, t.weather.metar)}<span class="chip">{formatVisib(metar.visib, t.weather.metar)}</span>{/if}
		{#if formatWeather(metar.wxString, t.weather.wx)}<span class="chip wx">{formatWeather(metar.wxString, t.weather.wx)}</span>{/if}
		{#if formatClouds(metar.clouds)}<span class="chip">{formatClouds(metar.clouds)}</span>{/if}
		{#if tempLine(metar)}<span class="chip">{tempLine(metar)}</span>{/if}
		{#if qnh != null}<span class="chip">Q{qnh}</span>{/if}
	</div>
	<div class="age {metarFreshness(age)}">
		{metar.metarType === 'SPECI' ? 'SPECI, ' : ''}{formatAge(age, t.weather.metar)}
	</div>
</div>

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-2);
	}

	.source {
		font-size: 11px;
		font-weight: 600;
		color: var(--text-muted);
	}

	.raw {
		margin: 0;
		font-size: 11.5px;
		line-height: 1.4;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.chip {
		font-size: 11px;
		padding: 1px 7px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface);
		color: var(--text);
		white-space: nowrap;
	}

	/* Present weather gets a warm border: it is the operationally significant
	 * chip (precipitation, thunderstorm, freezing, fog). */
	.chip.wx {
		border-color: var(--airspace-activity);
	}

	.age {
		font-size: 11px;
		color: var(--text-muted);
	}

	.age.aging {
		color: var(--airspace-activity);
	}

	.age.expired {
		color: var(--danger);
	}
</style>
