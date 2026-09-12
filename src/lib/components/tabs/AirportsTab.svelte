<script lang="ts">
	import { airportSearch, searchAirports } from '$lib/state/airportSearch.svelte';
	import { ensureAirports, dataState } from '$lib/state/data.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { ui, selectAirport } from '$lib/state/ui.svelte';
	import { mapState } from '$lib/state/map.svelte';
	import { flyToVisible } from '$lib/map/focus';
	import { notamsByIdent } from '$lib/state/notam.svelte';
	import { clearHover, hoverFeature } from '$lib/map/selectionHighlight';
	import { airportSwatchColor } from '$lib/map/airportSymbols';
	import { prettyAirportType, type Airport } from '$lib/data/airports';
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

	const search = $derived(searchAirports(passesFuel));

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
	const notamCounts = $derived(notamsByIdent());
	const selectedIdent = $derived(
		ui.detail?.kind === 'airport' ? ui.detail.id : null,
	);

	function onSelect(a: Airport): void {
		selectAirport(a.ident);
		flyToVisible(
			{ lat: a.lat, lng: a.lon },
			Math.max(mapState.map?.getZoom() ?? 12, 12),
		);
		// On mobile the detail panel is full-width and the sidebar is a bottom
		// sheet over the map; collapse it so the airport panel is visible.
		if (ui.isMobile) {
			ui.sidebarCollapsed = true;
		}
	}

	// The catalog table carries literal keys; the dataset field is an open
	// string, so the lookup widens at the read site and falls back to the
	// canonical English helper (the AirportDetail pattern). Called from the
	// template, so the t read is tracked and a locale switch re-renders.
	function typeLabel(type: string): string {
		return (t.data.airportTypes as Record<string, string>)[type] ?? prettyAirportType(type);
	}

	function subtitle(a: Airport): string {
		const parts = [a.iata ? `${a.ident} · ${a.iata}` : a.ident, typeLabel(a.type)];
		const place = [a.city, a.country].filter(Boolean).join(', ');
		if (place) {
			parts.push(place);
		}
		return parts.join(' · ');
	}
</script>

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
	{:else if airportSearch.query.trim() === ''}
		<p class="muted">{t.search.hint}</p>
	{:else if search.total === 0}
		<p class="muted">{t.search.noMatches}</p>
	{:else}
		{#if search.total > search.results.length}
			<p class="muted count">
				{t.search.showingMatches({ shown: search.results.length, total: search.total })}
			</p>
		{/if}
		<ul class="airport-list">
			{#each search.results as a (a.ident)}
				{@const dot = airportSwatchColor(a)}
				{@const n = notamCounts.get(a.ident.toUpperCase())?.length ?? 0}
				{@const fuel = fuelSummary(a)}
				<li>
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
						{#if n > 0}
							<span class="notam-count" title={t.map.notamCount(n)}>
								{n}
							</span>
						{/if}
					</button>
				</li>
			{/each}
		</ul>
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

	.notam-count {
		flex: 0 0 auto;
		min-width: 16px;
		padding: 1px 5px;
		font-size: 11px;
		font-weight: 700;
		text-align: center;
		color: #fff;
		background: var(--notam-cue, #d35400);
		border-radius: 999px;
	}
</style>
