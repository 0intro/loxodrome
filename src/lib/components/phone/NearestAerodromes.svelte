<script lang="ts">
	/* The Airports page's Nearest section: the diversion list read from the
	 * position (nav/nearest.ts, pure), nearest first, each row with the
	 * distance, the magnetic bearing, the minutes at the live ground speed,
	 * the frequency to call (the nav log's own rule: airportContactUnit +
	 * contactLines) and the longest runway. A row opens the aerodrome's full
	 * sheet in the pane, where every frequency, the runways, the fuel, the
	 * charts, the NOTAMs and the weather are, with "Direct to" at its head.
	 * The phone's Airports page is its one mount; the desktop tab keeps its
	 * own search head. */
	import { untrack } from 'svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { currentPose, nav } from '$lib/state/navRecording.svelte';
	import { dataState, getAirports } from '$lib/state/data.svelte';
	import { airportContactUnit } from '$lib/state/navLive.svelte';
	import { revealMap, selectAirport } from '$lib/state/ui.svelte';
	import { flyToVisible } from '$lib/map/focus';
	import { mapState } from '$lib/state/map.svelte';
	import { contactLines } from '$lib/format/radio';
	import { fmtNM, fmtTrack } from '$lib/route/format';
	import { NEAREST_RADIUS_NM } from '$lib/nav/nearest';
	import { decimalYearFromDate, magneticFromTrue } from '$lib/route/magnetic';
	import { longestRunwayFt, nearestAerodromes, nearestCandidatesFor } from '$lib/nav/nearest';
	import {
		aerodromeClosedByNotam,
		aerodromeNotamIdents,
	} from '$lib/state/aerodromeState.svelte';
	import type { Airport } from '$lib/data/airports';

	const pose = $derived(currentPose());
	/* The ranking's ONLY pose dependency, quantised to about a tenth of a
	 * mile: the scan is 31k candidates and each row then resolves a contact
	 * unit through the NOTAM overrides, which at one fix a second is work the
	 * band's own contract would not allow. Svelte stops a derived whose value
	 * did not change, so the list recomputes when the aircraft has actually
	 * moved, and the figures it holds between times are a tenth of a mile
	 * stale, which no diversion decision turns on. */
	const poseStep = $derived(
		pose ? `${Math.round(pose.lat * 600)}|${Math.round(pose.lon * 600)}` : '',
	);
	/* The clock's dependency, the playhead to the minute: an aircraft that
	 * does not move (on the ground with the recording running, a hold over
	 * one spot) still sees a closure start and a frequency change take
	 * effect within the minute, the heartbeat's own granularity. */
	const minuteStep = $derived(Math.floor(nav.playheadMs / 60_000));
	const rows = $derived.by(() => {
		void poseStep;
		void minuteStep;
		const airports = dataState.airportsLoaded ? getAirports() : null;
		const p = untrack(() => currentPose());
		if (!p || !airports) {
			return [];
		}
		const tMs = untrack(() => nav.playheadMs);
		const year = decimalYearFromDate(new Date(tMs));
		// The pose's own instant, the band's (navOverflight's): a replay reads
		// the channel and the closure the flight had, and a change dated
		// later does not reach the list.
		const at = { fromMs: tMs, toMs: tMs };
		const gs = p.speedKt != null && p.speedKt >= 20 ? p.speedKt : null;
		// A field a NOTAM has shut is MARKED, never dropped. The module's own
		// rule is that a strip answering nobody is still a runway, and the
		// same holds here: this is the list read when the plan stops
		// applying, and a closed aerodrome an emergency can still use must
		// not be the one the app hid.
		const shut = aerodromeNotamIdents();
		return nearestAerodromes(nearestCandidatesFor(airports), p.lat, p.lon).map((h) => {
			const unit = airportContactUnit(h.airport, at);
			const line = unit ? contactLines(unit.radio, unit.kind)[0] : undefined;
			const rwyFt = longestRunwayFt(h.airport);
			return {
				airport: h.airport,
				distNM: h.distNM,
				brgMag: magneticFromTrue(h.bearingTrueDeg, p.lat, p.lon, year),
				minutes: gs ? Math.round((h.distNM / gs) * 60) : null,
				freq: line ? `${line.label} ${line.freq}` : '',
				rwyM: rwyFt != null ? Math.round(rwyFt * 0.3048) : null,
				closed:
					shut.has(h.airport.ident.toUpperCase()) && aerodromeClosedByNotam(h.airport, at),
			};
		});
	});

	function pick(a: Airport): void {
		selectAirport(a.ident);
		flyToVisible({ lat: a.lat, lng: a.lon }, Math.max(mapState.map?.getZoom() ?? 11, 11));
		revealMap();
	}
</script>

<div class="tab-panel">
	<fieldset class="group">
		<legend>{t.search.nearest}</legend>
		{#if !pose}
			<p class="muted">{t.search.nearestNoPose}</p>
		{:else if rows.length === 0}
			<p class="muted">{dataState.airportsLoaded ? t.search.nearestNone(NEAREST_RADIUS_NM) : t.search.loading}</p>
		{:else}
			<p class="muted small">{t.search.nearestHint(NEAREST_RADIUS_NM)}</p>
			<ul class="near">
				{#each rows as r (r.airport.ident)}
					<li>
						<button type="button" class="row" onclick={() => pick(r.airport)}>
							<span class="head">
								<span class="ident">{r.airport.ident}</span>
								<span class="name">{r.airport.name}</span>
								{#if r.closed}
									<span class="shut" title={t.detail.adClosedTag}>{t.detail.adClosedTag}</span>
								{/if}
							</span>
							<span class="figs">
								<!-- i18n-ignore: NM, the degree sign, M, min and m are locale-invariant units -->
								<span class="fig">{fmtNM(r.distNM)} NM</span>
								<span class="fig">{fmtTrack(r.brgMag)}M</span>
								{#if r.minutes != null}<span class="fig">{r.minutes} min</span>{/if}
								{#if r.freq}<span class="fig freq">{r.freq}</span>{/if}
								{#if r.rwyM != null}<span class="fig">{r.rwyM} m</span>{/if}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</fieldset>
</div>

<style>
	.near {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		display: flex;
		flex-direction: column;
		gap: 3px;
		align-items: stretch;
		width: 100%;
		min-height: 44px;
		padding: 6px 4px;
		font: inherit;
		color: var(--text);
		text-align: left;
		background: none;
		border: 0;
		border-bottom: 1px solid var(--border);
		cursor: pointer;
	}

	.head {
		display: flex;
		gap: 6px;
		align-items: baseline;
		min-width: 0;
	}

	.ident {
		font-weight: 700;
	}

	.name {
		overflow: hidden;
		font-size: var(--fs-xs);
		color: var(--text-muted);
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	/* The one thing on this row that changes whether you may land, so it
	   takes the danger ink and never shrinks away with the name. */
	.shut {
		flex: none;
		padding: 0 4px;
		border-radius: var(--radius-sm);
		background: var(--danger);
		color: var(--surface);
		font-size: var(--fs-2xs);
		font-weight: 600;
		white-space: nowrap;
	}

	.figs {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 10px;
		font-size: var(--fs-xs);
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	.fig.freq {
		font-weight: 600;
		color: var(--text);
	}

	:global(:root.in-flight) .row {
		min-height: 64px;
	}
</style>
