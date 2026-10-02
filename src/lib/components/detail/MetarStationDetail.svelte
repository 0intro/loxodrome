<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	/* Dedicated detail panel for a METAR station: a weather-first view keyed
	 * by ICAO ident. The observed values paint instantly from the map tile
	 * feed, then the authoritative METAR + TAF are resolved by ident through
	 * the shared weather session cache (the tile cache deliberately carries no
	 * TAF; see docs/metar-stations.md). The station's elevation comes from the
	 * feed itself (metres MSL), so even a station absent from the airports
	 * dataset shows one. Links to the aerodrome when the ident is a known
	 * airport. Display-gated by display.liveWeather. */

	import { display } from '$lib/state/display.svelte';
	import { navigateToAirport } from '$lib/state/ui.svelte';
	import {
		airportByIdent,
		dataState,
		ensureMetarStationCatalog,
		metarStationByIdent,
	} from '$lib/state/data.svelte';
	import { airportWx } from '$lib/state/weather.svelte';
	import { stationFeed } from '$lib/state/metarStations.svelte';
	import { STATION_CAT_COLORS, STATION_NO_CAT_COLOR } from '$lib/map/metarLayer';
	import { flightCategory, stationName } from '$lib/weather/metar';
	import CoordButton from './CoordButton.svelte';
	import Fields from './Fields.svelte';
	import WeatherSection from './WeatherSection.svelte';

	interface Props {
		station: { id: string; lat: number; lon: number; name?: string | undefined };
	}

	let { station }: Props = $props();

	// Load the static station catalog once (metadata by ident: identifiers,
	// country, elevation, METAR/TAF capability). Not gated on live weather;
	// a failed fetch just leaves the catalog fields empty.
	$effect(() => {
		void ensureMetarStationCatalog().catch(() => {});
	});

	// The canonical catalog record for this ident, once loaded (else null).
	const catalog = $derived(metarStationByIdent(station.id));

	// The by-ident record (WeatherSection ensures + renders it); the header
	// chip and elevation read the same observation.
	const own = $derived(display.liveWeather ? airportWx(station.id) : null);
	// Instant paint from the map tile feed while the by-ident fetch is in
	// flight (and a fallback for a station the by-ident endpoint can't serve).
	const seed = $derived(stationFeed().find((s) => s.metar.icaoId === station.id) ?? null);
	const metar = $derived(own?.metar ?? seed?.metar ?? null);
	const cat = $derived(metar ? flightCategory(metar) : null);
	const catColor = $derived(cat ? STATION_CAT_COLORS[cat] : STATION_NO_CAT_COLOR);
	// airportByIdent reads a plain (non-reactive) index: track the load flag
	// (the selectedObstacle idiom) so the aerodrome link and elevation
	// fallback fill in once the airports dataset arrives.
	const airport = $derived(dataState.airportsLoaded ? airportByIdent(station.id) : null);
	// Prefer the catalog's clean site name; fall back to the observation's
	// name (suffix trimmed) and finally the hit's name.
	const name = $derived(catalog?.site || stationName(metar?.name ?? station.name ?? ''));

	// Station elevation, metres MSL -> feet. Prefer the static catalog (present
	// for every station), then the observation, then the aerodrome's published
	// elevation (already feet).
	const elevFt = $derived.by(() => {
		if (catalog?.elevM != null) {
			return Math.round(catalog.elevM / 0.3048);
		}
		if (metar?.elev != null) {
			return Math.round(metar.elev / 0.3048);
		}
		return airport?.elevFt ?? null;
	});
</script>

<div class="station">
	<div class="cat-row">
		<span class="cat-chip" style:background={catColor}>
			{cat ?? t.weather.station.noCategory}
		</span>
		{#if name}
			<span class="station-name">{name}</span>
		{/if}
	</div>

	<Fields>
		{#if catalog && (catalog.iata || catalog.faa || catalog.wmo)}
			<dt>{t.detail.identifiers}</dt>
			<dd class="ids">
				<!-- Codes are ICAO Doc 8400 abbreviations, invariant. -->
				{#if catalog.iata}<span class="idchip"><span class="idkind">IATA</span>{catalog.iata}</span>{/if}
				{#if catalog.faa}<span class="idchip"><span class="idkind">FAA</span>{catalog.faa}</span>{/if}
				{#if catalog.wmo}<span class="idchip"><span class="idkind">WMO</span>{catalog.wmo}</span>{/if}
			</dd>
		{/if}

		{#if catalog?.country}
			<dt>{t.detail.country}</dt>
			<dd>{catalog.country}{catalog.region ? ` / ${catalog.region}` : ''}</dd>
		{/if}

		{#if elevFt != null}
			<dt>{t.detail.elevation}</dt>
			<dd>
				{elevFt.toLocaleString('en-US')} ft
				<abbr title={t.detail.amslTip}>AMSL</abbr>
			</dd>
		{/if}

		<dt>{t.detail.position}</dt>
		<dd>
			<CoordButton lat={station.lat} lon={station.lon} />
		</dd>

		{#if catalog}
			<dt>{t.detail.reporting}</dt>
			<dd class="ids">
				<!-- METAR / TAF are invariant codes. -->
				<span class="idchip">METAR</span>
				{#if catalog.taf}<span class="idchip">TAF</span>{/if}
			</dd>
		{/if}
	</Fields>

	<WeatherSection ident={station.id} seedMetar={seed?.metar ?? null} />

	{#if airport}
		<button
			class="aerodrome-link"
			onclick={() => navigateToAirport(station.id)}
			title={t.detail.openAirportTip}
		>
			{t.detail.viewAerodrome(station.id)}
		</button>
	{/if}
</div>

<style>
	.station {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.cat-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.cat-chip {
		padding: 2px 8px;
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.03em;
		color: #fff;
		border-radius: 4px;
	}

	.station-name {
		font-size: 13px;
		color: var(--text-muted);
	}

	.ids {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.idchip {
		display: inline-flex;
		align-items: baseline;
		gap: 4px;
		font-size: 12px;
		padding: 1px 6px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--surface-2);
	}

	.idkind {
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.03em;
		color: var(--text-muted);
	}

	abbr[title] {
		text-decoration: none;
		cursor: inherit;
	}

	.aerodrome-link {
		align-self: flex-start;
		padding: 0;
		font: inherit;
		font-size: 13px;
		font-weight: 600;
		color: var(--accent);
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.aerodrome-link:hover {
		text-decoration: underline;
	}

	.aerodrome-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
</style>
