<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	/* Live weather by ident: the station's own METAR + TAF, shared by the
	 * airport panel and the dedicated METAR station panel. The airport case
	 * passes fallbackPos so an aerodrome without a station of its own shows
	 * the nearest reporting one (with its distance); the station panel
	 * passes seedMetar, the map tile-feed observation, for instant paint
	 * while the by-ident fetch is in flight. The decoded METAR card is the
	 * shared MetarReadout, the TAF its own raw block below. Age is always
	 * shown and tinted once an observation cycle is missed. Display-gated
	 * by display.liveWeather; data via the weather session cache (NOAA AWC
	 * through the notam-proxy). */

	import type { AwcMetar, AwcTaf } from '$lib/weather/awc';
	import { display } from '$lib/state/display.svelte';
	import { notamState } from '$lib/state/notam.svelte';
	import {
		airportWx,
		nearestWx,
		ensureAirportWx,
		ensureNearestMetar,
		refreshWeather,
	} from '$lib/state/weather.svelte';
	import { formatDistanceNM, tafBlockText } from '$lib/weather/metar';
	import { formatActivationSpan } from '$lib/format/datetime';
	import MetarReadout from './MetarReadout.svelte';

	interface Props {
		/** ICAO ident the METAR + TAF resolve by. */
		ident: string;
		/** Nearest-station fallback anchor: set for an aerodrome, so a field
		 *  whose ident probe comes back empty shows the closest reporting
		 *  station instead. */
		fallbackPos?: { lat: number; lon: number } | null;
		/** Instant-paint observation while the by-ident fetch is in flight
		 *  (the station panel's map tile feed). */
		seedMetar?: AwcMetar | null;
	}

	let { ident, fallbackPos = null, seedMetar = null }: Props = $props();

	const own = $derived(display.liveWeather ? airportWx(ident) : null);
	const metar = $derived(own?.metar ?? seedMetar);
	// The nearest-station fallback applies once the ident probe came back
	// empty (the field has no METAR station of its own).
	const near = $derived(
		display.liveWeather && fallbackPos && own?.status === 'ok' && !own.metar
			? nearestWx(ident)
			: null,
	);

	// The minute tick auto-refreshes an open panel at the records' 5 min TTL.
	$effect(() => {
		void notamState.tick;
		if (!display.liveWeather) {
			return;
		}
		ensureAirportWx(ident);
		if (fallbackPos) {
			const rec = airportWx(ident);
			if (rec?.status === 'ok' && !rec.metar) {
				ensureNearestMetar(ident, fallbackPos.lat, fallbackPos.lon);
			}
		}
	});

	// Live ages: re-evaluate on the shared 60-second tick.
	const nowMs = $derived.by(() => {
		void notamState.tick;
		return Date.now();
	});

	function tafValidity(taf: AwcTaf): string {
		return formatActivationSpan(
			new Date(taf.validTimeFrom * 1000),
			new Date(taf.validTimeTo * 1000),
		);
	}
</script>

{#if display.liveWeather}
	<section class="block">
		<div class="head">
			<h3>{t.weather.title}</h3>
			<button
				class="refresh"
				onclick={refreshWeather}
				title={t.weather.refreshWxTip}
			>{t.weather.refresh}</button>
		</div>

		{#if metar}
			<MetarReadout {metar} {nowMs} />
			{#if own?.taf}
				<div class="card taf">
					<div class="source">{t.weather.tafValid(tafValidity(own.taf))}</div>
					<!-- Raw TAF: aviation-code source data (docs/i18n.md rule 11). -->
					<pre class="raw" lang="en">{tafBlockText(own.taf.rawTAF)}</pre>
				</div>
			{/if}
		{:else if !own || own.status === 'loading'}
			<p class="empty">{t.weather.loadingWx}</p>
		{:else if own.status === 'error'}
			<p class="empty">{t.weather.wxUnavailable}</p>
		{:else if fallbackPos}
			<p class="empty">{t.weather.noStationAt(ident)}</p>
			<!-- The observation is read before the fetch status, the rule the
			     nearest records follow everywhere (state/weather.svelte.ts): a
			     failed refresh keeps the one it had, and the panel would
			     otherwise say "unavailable" about an observation the flight-prep
			     grid is still computing from. Its age line carries the truth. -->
			{#if near?.metar && near.distanceM != null}
				<MetarReadout
					metar={near.metar}
					{nowMs}
					sourceNote={t.weather.nearestMetar({
						id: near.metar.icaoId,
						dist: formatDistanceNM(near.distanceM),
					})}
				/>
			{:else if !near || near.status === 'loading'}
				<p class="empty">{t.weather.searchingNearest}</p>
			{:else if near.status === 'error'}
				<p class="empty">{t.weather.nearestUnavailable}</p>
			{:else}
				<p class="empty">{t.weather.noStation50}</p>
			{/if}
		{:else}
			<p class="empty">{t.weather.loadingWx}</p>
		{/if}
	</section>
{/if}

<style>
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}

	.block h3 {
		margin: 0 0 6px;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.refresh {
		font: inherit;
		font-size: 11px;
		padding: 0 6px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-2);
		color: var(--text-muted);
		cursor: pointer;
	}

	.refresh:hover {
		color: var(--text);
		background: var(--surface-3);
	}

	.card {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-2);
	}

	.taf {
		margin-top: 6px;
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

	.empty {
		margin: 0;
		font-size: 12px;
		color: var(--text-muted);
	}
</style>
