<script lang="ts">
	import { untrack } from 'svelte';
	import {
		airportSearch,
		searchAirportsFor,
		TOWN_RADIUS_NM,
		type TownGroup,
	} from '$lib/state/airportSearch.svelte';
	import { searchReference } from '$lib/state/searchRef';
	import { occurrenceKeys } from '$lib/data/dedup';
	import { ensureAirports, dataState } from '$lib/state/data.svelte';
	import { ensurePlaces, placeTarget } from '$lib/state/places.svelte';
	import { aerodromeClosedByNotam, aerodromeNotamIdents } from '$lib/state/aerodromeState.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { ui, selectAirport, selectPlace, revealMap } from '$lib/state/ui.svelte';
	import { mapState } from '$lib/state/map.svelte';
	import { flyToVisible } from '$lib/map/focus';
	import { aerodromeNotams } from '$lib/state/notam.svelte';
	import { clearHover, hoverFeature, hoverPlace } from '$lib/map/selectionHighlight';
	import { airportSwatchColor } from '$lib/map/airportSymbols';
	import { prettyAirportType, type Airport } from '$lib/data/airports';
	import type { Place } from '$lib/data/places';
	import type { NearestAerodrome } from '$lib/nav/nearest';
	import { compassPoint } from '$lib/format/compass';
	import { fmtNM } from '$lib/route/format';
	import { ensureAerodromeFuel, fuelForIdent } from '$lib/state/data.svelte';
	import { civilGrades, gradeLabel } from '$lib/data/fuel';
	import { FUEL_TYPES, type FuelType } from '$lib/aircraft/schema';

	// Airports load lazily (only when an airport map layer is enabled), so kick
	// off the fetch when this tab opens; ensureAirports() is idempotent. It
	// rethrows after recording the failure (dataState.airportsError), so
	// swallow the rejection here.
	$effect(() => {
		void ensureAirports().catch(() => {});
	});

	/* The fuel filter answers a question the tab could not before: for a
	 * Rotax on unleaded, thirty-odd French fields sell UL91 and finding them
	 * by opening panels one at a time is not a plan. It narrows a search
	 * rather than browsing on its own, since the ranked lookup needs a query
	 * to rank against. */
	$effect(() => {
		void ensureAerodromeFuel('fr').catch(() => {});
	});

	// The towns load on the first search, as the palette's do: a town's
	// name lists the aerodromes nearest it.
	let placesAsked = false;
	$effect(() => {
		if (placesAsked || airportSearch.query.trim() === '') {
			return;
		}
		placesAsked = true;
		void ensurePlaces().catch(() => {});
	});

	function toggleGrade(g: FuelType): void {
		airportSearch.grades = airportSearch.grades.includes(g)
			? airportSearch.grades.filter((x) => x !== g)
			: [...airportSearch.grades, g];
	}

	/** An aerodrome passes when it publishes ANY ticked grade, to a civil
	 *  pilot: a military pump is not an answer to "where can I refuel". */
	function passesFuel(a: Airport): boolean {
		if (airportSearch.grades.length === 0) {
			return true;
		}
		const row = fuelForIdent(a.ident, a.source);
		if (!row || row.avail === 'no') {
			return false;
		}
		const civil = civilGrades(row);
		return airportSearch.grades.some((g) => civil.some((c) => c === g));
	}

	// The palette's ~120 ms trailing debounce: a keystroke ranks every
	// loaded aerodrome and names a town among every loaded place, some 60 ms
	// on a busy desktop and four times that on a slow phone, so the list
	// follows the text once the typing pauses. It starts on the query the tab
	// opens with (the palette's "more in the Airports tab" row sets one).
	let debounced = $state(airportSearch.query);
	$effect(() => {
		const q = airportSearch.query;
		const id = setTimeout(() => {
			debounced = q;
		}, 120);
		return () => clearTimeout(id);
	});

	// The nearest come first: from the aircraft in flight, else the map's
	// centre, taken once per query so neither a pan nor a fix reshuffles the
	// list under the pointer.
	const ref = $derived.by(() => {
		void debounced;
		return untrack(searchReference);
	});
	const search = $derived(searchAirportsFor(debounced, passesFuel, ref));
	// Under the town's group, the matches it does not already list.
	const listed = $derived(search.town?.first ? search.town.others : search.results);
	// Keyed by occurrence (the ident, '#2' on a repeat): an ident can repeat
	// in the merged data (16 FAA strips share MM), and a keyed each throws on
	// a duplicate key in production too. The ident shown is never rewritten.
	const listedKeys = $derived(occurrenceKeys(listed, (a) => a.ident));

	type TownRow = NearestAerodrome & { closed: boolean };

	// A field a NOTAM has shut is MARKED, never dropped (nav/nearest.ts).
	const townRows = $derived.by((): TownRow[] => {
		const town = search.town;
		if (!town) {
			return [];
		}
		const shut = aerodromeNotamIdents();
		return town.near.map((h) => ({
			...h,
			closed: shut.has(h.airport.ident.toUpperCase()) && aerodromeClosedByNotam(h.airport),
		}));
	});
	const townKeys = $derived(occurrenceKeys(townRows, (r) => r.airport.ident));

	/** The grades on a result row, so a filtered list says why each row is
	 *  in it. Absent for every aerodrome outside France, which is the only
	 *  AIP that states this at all. */
	function fuelSummary(a: Airport): string {
		const row = fuelForIdent(a.ident, a.source);
		if (!row) {
			return '';
		}
		const civil = civilGrades(row);
		return civil.length > 0 ? civil.map(gradeLabel).join(', ') : '';
	}
	const selectedIdent = $derived(
		ui.detail?.kind === 'airport' ? ui.detail.id : null,
	);

	function onSelect(a: Airport): void {
		selectAirport(a.ident);
		flyToVisible(
			{ lat: a.lat, lng: a.lon },
			Math.max(mapState.map?.getZoom() ?? 12, 12),
		);
		// On a phone the page steps aside so the map, and the aerodrome's
		// sheet opening in the pane, are in view.
		revealMap();
	}

	// The catalog table carries literal keys; the dataset field is an open
	// string, so the lookup widens at the read site and falls back to the
	// canonical English helper (the AirportDetail pattern). Called from the
	// template, so the t read is tracked and a locale switch re-renders.
	function typeLabel(type: string): string {
		return (t.data.airportTypes as Record<string, string>)[type] ?? prettyAirportType(type);
	}

	function subtitle(a: Airport): string {
		return [a.ident, a.iata, typeLabel(a.type), a.city, a.country].filter(Boolean).join(', ');
	}

	function townName(p: Place): string {
		return [p.name, p.admin].filter(Boolean).join(', ');
	}

	/** The town's own panel, the palette's way: its position, its fields
	 *  within 25 NM, its reporting points and airspaces. */
	function openTown(p: Place): void {
		selectPlace(placeTarget(p));
		flyToVisible({ lat: p.lat, lng: p.lon }, Math.max(mapState.map?.getZoom() ?? 11, 11));
		revealMap();
	}
</script>

{#snippet aerodromeRow(a: Airport, near: TownRow | null)}
	{@const dot = airportSwatchColor(a)}
	{@const n = aerodromeNotams(a.ident).length}
	{@const fuel = fuelSummary(a)}
	<button
		class="row"
		class:active={selectedIdent === a.ident}
		onclick={() => onSelect(a)}
		onmouseenter={() => hoverFeature('airport', a.ident)}
		onmouseleave={clearHover}
	>
		<span
			class="swatch"
			style:background={dot}
			style:border-color={dot}
		></span>
		<span class="row-text">
			<span class="row-id">{a.name || a.ident}</span>
			<span class="row-desc">{subtitle(a)}</span>
			{#if fuel}
				<span class="row-fuel">{fuel}</span>
			{/if}
		</span>
		{#if near?.closed}
			<span class="shut-tag">{t.detail.adClosedTag}</span>
		{/if}
		{#if near}
			<!-- i18n-ignore: NM and the compass points are Doc 8400 abbreviations, locale-invariant -->
			<span class="row-fig">{fmtNM(near.distNM)} NM {compassPoint(near.bearingTrueDeg)}</span>
		{/if}
		{#if n > 0}
			<span class="notam-count" title={t.map.notamCount(n)}>
				{n}
			</span>
		{/if}
	</button>
{/snippet}

{#snippet townGroup(town: TownGroup)}
	<h3 class="group-head">
		{t.search.nearestTown}
		<button
			type="button"
			class="town-link"
			onclick={() => openTown(town.hit.item)}
			onmouseenter={() => hoverPlace(town.hit.item)}
			onmouseleave={clearHover}>{townName(town.hit.item)}</button
		>
	</h3>
	{#if townRows.length === 0}
		<p class="muted">{t.search.nearestNone(TOWN_RADIUS_NM)}</p>
	{:else}
		<ul class="airport-list">
			{#each townRows as r, i (townKeys[i])}
				<li>{@render aerodromeRow(r.airport, r)}</li>
			{/each}
		</ul>
	{/if}
{/snippet}

{#snippet matches()}
	{#if search.total > search.results.length}
		<p class="muted count">
			{t.search.showingMatches({ shown: search.results.length, total: search.total })}
		</p>
	{/if}
	<ul class="airport-list">
		{#each listed as a, i (listedKeys[i])}
			<li>{@render aerodromeRow(a, null)}</li>
		{/each}
	</ul>
{/snippet}

<div class="tab-panel">
	<h2>{t.search.title}</h2>

	<input
		class="search"
		type="search"
		autocapitalize="characters"
		autocomplete="off"
		spellcheck="false"
		enterkeyhint="search"
		placeholder={t.search.placeholder}
		bind:value={airportSearch.query}
	/>

	<div class="fuel-filter" title={t.search.fuelFilterTip}>
		<span class="fuel-filter-label">{t.search.fuelFilter}</span>
		{#each FUEL_TYPES as g (g)}
			<button
				type="button"
				class="fuel-pick"
				class:on={airportSearch.grades.includes(g)}
				aria-pressed={airportSearch.grades.includes(g)}
				onclick={() => toggleGrade(g)}>{gradeLabel(g)}</button
			>
		{/each}
	</div>

	{#if dataState.airportsError}
		<p class="muted">{t.search.loadError(dataState.airportsError)}</p>
	{:else if !dataState.airportsLoaded && dataState.airportsLoading}
		<p class="muted">{t.search.loading}</p>
	{:else if debounced.trim() === ''}
		<p class="muted">{t.search.hint}</p>
	{:else if search.total === 0 && !search.town}
		<p class="muted">{t.search.noMatches}</p>
	{:else if search.town?.first}
		{@render townGroup(search.town)}
		{#if listed.length > 0}
			<h3 class="group-head">{t.search.otherMatches}</h3>
			{@render matches()}
		{/if}
	{:else}
		{@render matches()}
		{#if search.town}
			{@render townGroup(search.town)}
		{/if}
	{/if}
</div>

<style>
	.count {
		font-size: 12px;
	}

	.airport-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 9px;
		width: 100%;
		padding: 7px 8px;
		text-align: left;
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius);
		cursor: pointer;
	}

	.row:hover {
		background: var(--surface-2);
	}

	.row.active {
		background: var(--surface-2);
		border-color: var(--accent);
	}

	/* Round status swatch; fill + border come from the inline airportSwatchColor
	   so each row shows its civil / military / restricted / closed colour. */
	.swatch {
		flex: 0 0 auto;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		border-style: solid;
		border-width: 1px;
	}

	.row-text {
		display: flex;
		flex: 1;
		min-width: 0;
		flex-direction: column;
	}

	.row-id {
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row-desc {
		font-size: 12px;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row-fuel {
		font-size: 11px;
		font-weight: 600;
		color: var(--accent);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.fuel-filter {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		align-items: center;
		margin-top: 6px;
	}

	.fuel-filter-label {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.fuel-pick {
		padding: 2px 8px;
		font: inherit;
		font-size: 12px;
		color: var(--text-muted);
		cursor: pointer;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 999px;
	}

	.fuel-pick:hover {
		color: var(--accent);
		border-color: var(--accent);
	}

	.fuel-pick.on {
		color: var(--accent-text);
		background: var(--accent);
		border-color: var(--accent);
	}

	/* The town's group and the matches under it, each named. */
	.group-head {
		margin: 4px 0 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted);
	}

	/* The town is a link to its own panel (NavaidDetail's link). */
	.town-link {
		padding: 0;
		font: inherit;
		color: var(--accent);
		text-align: left;
		background: none;
		border: 0;
		cursor: pointer;
	}

	.town-link:hover {
		text-decoration: underline;
	}

	.row-fig {
		flex: none;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	.notam-count {
		flex: 0 0 auto;
		min-width: 16px;
		padding: 1px 5px;
		font-size: 11px;
		font-weight: 700;
		text-align: center;
		color: #fff;
		background: var(--notam-cue);
		border-radius: 999px;
	}
</style>
