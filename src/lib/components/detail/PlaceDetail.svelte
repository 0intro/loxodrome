<script lang="ts">
	/* A place the search went to (docs/search.md "The place panel"): a town,
	 * or a position typed as coordinates. What a pilot asks of a name on the
	 * map: where it is, what lies near it to land on or report over, what
	 * airspace is over it, and the way into the route. A row navigates
	 * (navigateTo*), so Back returns here. */
	import Icon from '../Icon.svelte';
	import AltitudeProfile from './AltitudeProfile.svelte';
	import CoordButton from './CoordButton.svelte';
	import DirectToButton from './DirectToButton.svelte';
	import Fields from './Fields.svelte';
	import { i18n, t } from '$lib/state/i18n.svelte';
	import { navigateToAirport, navigateToNavaid, type PlaceTarget } from '$lib/state/ui.svelte';
	import {
		dataState,
		ensureAirspaces,
		ensureNavaids,
		getAirports,
		getAirspaces,
		getNavaids,
	} from '$lib/state/data.svelte';
	import { aerodromeClosedByNotam, aerodromeNotamIdents } from '$lib/state/aerodromeState.svelte';
	import { activeRoute, addWaypointFromSnap, insertWaypointAfter, selectWaypoint } from '$lib/state/route.svelte';
	import { offerUndoFor } from '$lib/state/undoChip.svelte';
	import { useAirportHover, useNavaidHover } from '../featureHover.svelte';
	import { airspacesOver } from '$lib/data/airspaces';
	import { occurrenceKeys } from '$lib/data/dedup';
	import { nearestAerodromes, nearestCandidatesFor, nearestPoints } from '$lib/nav/nearest';
	import { bestInsertionIndex } from '$lib/route/bestInsertion';
	import { fmtNM } from '$lib/route/format';
	import { compassPoint } from '$lib/format/compass';
	import { formatCoord } from '$lib/format/coord';
	import { vrpLandmark } from '$lib/format/remark';
	import { intFormat } from '$lib/i18n/intl';
	import { copyText } from '$lib/ui/clipboard';

	interface Props {
		place: PlaceTarget;
	}
	const { place }: Props = $props();

	// How far each list looks: the aerodromes a flight to the place could
	// use, and the reporting points an arrival there is cleared through.
	const AERODROME_RADIUS_NM = 25;
	const VRP_RADIUS_NM = 10;
	const LIST_LIMIT = 6;
	const COPIED_MS = 2000;

	// The airspace and navaid datasets load on demand; the lists fill in when
	// they land (the airport sheet's idiom).
	$effect(() => {
		void ensureAirspaces().catch(() => {});
		void ensureNavaids().catch(() => {});
	});

	// A field a NOTAM has shut is MARKED, never dropped (nav/nearest.ts).
	const aerodromes = $derived.by(() => {
		const airports = getAirports();
		if (!airports) {
			return [];
		}
		const shut = aerodromeNotamIdents();
		return nearestAerodromes(nearestCandidatesFor(airports), place.lat, place.lon, {
			limit: LIST_LIMIT,
			radiusNM: AERODROME_RADIUS_NM,
		}).map((h) => ({
			...h,
			closed: shut.has(h.airport.ident.toUpperCase()) && aerodromeClosedByNotam(h.airport),
		}));
	});
	// An ident can repeat in the merged data, and a keyed each throws on a
	// duplicate key.
	const aerodromeKeys = $derived(occurrenceKeys(aerodromes, (r) => r.airport.ident));

	const vrps = $derived.by(() => {
		const navaids = getNavaids();
		if (!navaids) {
			return [];
		}
		const points = navaids.filter((n) => n.type === 'VFR_REPORTING_POINT');
		return nearestPoints(points, place.lat, place.lon, { limit: LIST_LIMIT, radiusNM: VRP_RADIUS_NM }, (n) => n.ident);
	});

	// From the full dataset, as the airport sheet's: the profile is
	// independent of the map's zoom and category toggles.
	const overhead = $derived(
		dataState.airspacesLoaded ? airspacesOver(getAirspaces() ?? [], place.lat, place.lon) : [],
	);

	const adHover = useAirportHover(() => aerodromes.map((r) => r.airport.ident));
	const vrpHover = useNavaidHover(() => vrps.map((r) => r.item.id));

	/* Into the active route as a named free point (a town keeps its name in
	 * the plan file and the exports), on the leg it lengthens least; a route
	 * of fewer than two points takes it at its end. One undo step, offered
	 * back on the map. A worded action, so the in-flight lock allows it. */
	function addToRoute(): void {
		const point = { kind: 'free' as const, lat: place.lat, lon: place.lon, label: place.name };
		const at = bestInsertionIndex(activeRoute().waypoints, place);
		const wp =
			at === null
				? offerUndoFor('added', () => addWaypointFromSnap(point))
				: offerUndoFor('inserted', () => insertWaypointAfter(at, point));
		selectWaypoint(wp.id);
	}

	let copied = $state(false);
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;

	async function copyCoords(): Promise<void> {
		if (await copyText(formatCoord(place.lat, place.lon).decimal)) {
			copied = true;
			clearTimeout(copiedTimer);
			copiedTimer = setTimeout(() => (copied = false), COPIED_MS);
		}
	}

	$effect(() => () => clearTimeout(copiedTimer));
</script>

<div class="place">
	<div class="actions">
		<button type="button" class="act" onclick={addToRoute} title={t.detail.placeAddToRouteTip}>
			<Icon name="route" size={14} />
			<span>{t.detail.placeAddToRoute}</span>
		</button>
		<DirectToButton
			target={{ lat: place.lat, lon: place.lon, kind: 'free', label: place.name }}
			label={place.name !== undefined ? t.detail.directTo(place.name) : t.detail.directToPosition}
			tip={t.detail.directToPointTip}
		/>
		<button type="button" class="act" onclick={copyCoords} title={t.map.copyCoordsTip}>
			{copied ? t.detail.coordsCopied : t.map.copyCoords}
		</button>
	</div>

	<Fields>
		{#if place.pop != null}
			<dt>{t.detail.placePopulation}</dt>
			<dd>{intFormat(i18n.locale).format(place.pop)}</dd>
		{/if}

		<dt>{t.detail.position}</dt>
		<dd>
			<CoordButton lat={place.lat} lon={place.lon} />
		</dd>
	</Fields>

	{#if aerodromes.length > 0}
		<section class="block">
			<h3>{t.detail.placeAerodromes(AERODROME_RADIUS_NM)}</h3>
			<ul class="near">
				{#each aerodromes as r, i (aerodromeKeys[i])}
					<li>
						<button
							type="button"
							class="near-row"
							onclick={() => navigateToAirport(r.airport.ident)}
							onmouseenter={() => adHover.set(r.airport.ident)}
							onmouseleave={() => adHover.set(null)}
						>
							<span class="ident">{r.airport.ident}</span>
							<span class="name">{r.airport.name}</span>
							{#if r.closed}
								<span class="shut-tag">{t.detail.adClosedTag}</span>
							{/if}
							<!-- i18n-ignore: NM and the compass points are Doc 8400 abbreviations, locale-invariant -->
							<span class="fig">{fmtNM(r.distNM)} NM {compassPoint(r.bearingTrueDeg)}</span>
						</button>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if vrps.length > 0}
		<section class="block">
			<h3>{t.detail.placeReportingPoints(VRP_RADIUS_NM)}</h3>
			<ul class="near">
				{#each vrps as r (r.item.id)}
					<li>
						<button
							type="button"
							class="near-row"
							onclick={() => navigateToNavaid(r.item.id)}
							onmouseenter={() => vrpHover.set(r.item.id)}
							onmouseleave={() => vrpHover.set(null)}
						>
							<span class="ident">{r.item.ident}</span>
							<span class="name">{vrpLandmark(r.item.rmk) || r.item.name}</span>
							<!-- i18n-ignore: NM and the compass points are Doc 8400 abbreviations, locale-invariant -->
							<span class="fig">{fmtNM(r.distNM)} NM {compassPoint(r.bearingTrueDeg)}</span>
						</button>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<AltitudeProfile airspaces={overhead} heading={t.detail.airspacesOverhead} lat={place.lat} lon={place.lon} />
</div>

<style>
	.place {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
	}

	/* The sheets' action pill (AirportDetail's). */
	.act {
		display: inline-flex;
		gap: 5px;
		align-items: center;
		padding: 3px 9px;
		font: inherit;
		font-size: 12px;
		color: var(--accent);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 999px;
		cursor: pointer;
	}

	.act:hover {
		border-color: var(--accent);
	}

	.act:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.block h3 {
		margin: 0 0 4px;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.near {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* AirspaceList's row: a link that reads as a line of the list. */
	.near-row {
		display: flex;
		gap: 6px;
		align-items: baseline;
		width: 100%;
		padding: 4px 6px;
		font: inherit;
		font-size: 12px;
		color: var(--text);
		text-align: left;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 4px;
		cursor: pointer;
	}

	.near-row:hover {
		background: var(--surface-2);
		border-color: var(--border);
	}

	.near-row:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.ident {
		flex: none;
		font-weight: 700;
	}

	.name {
		flex: 1;
		overflow: hidden;
		color: var(--text-muted);
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.fig {
		flex: none;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}
</style>
