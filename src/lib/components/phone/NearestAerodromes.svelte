<script lang="ts">
	/* The Airports page's Nearest section: the diversion list read from the
	 * position (nav/nearest.ts, pure), nearest first, each row with the
	 * distance, the magnetic bearing, the minutes at the live ground speed,
	 * the frequency to call (the nav log's own rule: airportContactUnit +
	 * contactLines) and the longest runway. A row opens the aerodrome's full
	 * sheet in the pane, where every frequency, the runways, the fuel, the
	 * charts, the NOTAMs and the weather are, with "Direct to" at its head.
	 * Also rendered at the head of the desktop Airports tab while a pose
	 * exists (the same list beside the search). */
	import { t } from '$lib/state/i18n.svelte';
	import { currentPose, nav } from '$lib/state/navRecording.svelte';
	import { dataState, getAirports } from '$lib/state/data.svelte';
	import { airportContactUnit } from '$lib/state/navLive.svelte';
	import { revealMap, selectAirport } from '$lib/state/ui.svelte';
	import { flyToVisible } from '$lib/map/focus';
	import { mapState } from '$lib/state/map.svelte';
	import { contactLines } from '$lib/format/radio';
	import { fmtNM, fmtTrack } from '$lib/route/format';
	import { decimalYearFromDate, magneticFromTrue } from '$lib/route/magnetic';
	import { longestRunwayFt, nearestAerodromes, nearestCandidates } from '$lib/nav/nearest';
	import type { Airport } from '$lib/data/airports';

	/* The candidates memo, keyed on the airports array ref (assigned once per
	 * session), the navOverflight idiom. */
	let memo: { airports: readonly Airport[]; candidates: Airport[] } | null = null;
	function candidatesFor(airports: Airport[]): Airport[] {
		if (!memo || memo.airports !== airports) {
			memo = { airports, candidates: nearestCandidates(airports) };
		}
		return memo.candidates;
	}

	const pose = $derived(currentPose());
	const rows = $derived.by(() => {
		const airports = dataState.airportsLoaded ? getAirports() : null;
		if (!pose || !airports) {
			return [];
		}
		const year = decimalYearFromDate(new Date(nav.playheadMs));
		const gs = pose.speedKt != null && pose.speedKt >= 20 ? pose.speedKt : null;
		return nearestAerodromes(candidatesFor(airports), pose.lat, pose.lon).map((h) => {
			const unit = airportContactUnit(h.airport);
			const line = unit ? contactLines(unit.radio, unit.kind)[0] : undefined;
			const rwyFt = longestRunwayFt(h.airport);
			return {
				airport: h.airport,
				distNM: h.distNM,
				brgMag: magneticFromTrue(h.bearingTrueDeg, pose.lat, pose.lon, year),
				minutes: gs ? Math.round((h.distNM / gs) * 60) : null,
				freq: line ? `${line.label} ${line.freq}` : '',
				rwyM: rwyFt != null ? Math.round(rwyFt * 0.3048) : null,
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
			<p class="muted">{dataState.airportsLoaded ? t.search.nearestNone : t.search.loading}</p>
		{:else}
			<p class="muted small">{t.search.nearestHint}</p>
			<ul class="near">
				{#each rows as r (r.airport.ident)}
					<li>
						<button type="button" class="row" onclick={() => pick(r.airport)}>
							<span class="head">
								<span class="ident">{r.airport.ident}</span>
								<span class="name">{r.airport.name}</span>
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
