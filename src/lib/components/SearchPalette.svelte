<script lang="ts">
	/* The Ctrl+K search palette: one fast face over the app's three search
	 * implementations (the Airports-tab catalogue ranking, the waypointSearch
	 * navaid ranking, the loaded NOTAM briefing) plus a small action registry
	 * (surfaces + chart-layer toggles). The Airports tab stays the richer
	 * results panel; the airports group closes with a "more in the Airports
	 * tab" row that hands the query over. A centred top-third dialog on the
	 * shared .modal-backdrop / .modal-box chrome (the ResetDialog /
	 * ShortcutsOverlay precedent: portal, Escape, focus lands in the input,
	 * deliberately NOT a workspace surface); on phones the same component
	 * renders full screen (ui.isMobile decides, the at-full box pads the
	 * safe-area insets). Selection reuses the established select + fly paths
	 * (AirportsTab / NotamsTab rows), so the detail panel and the map behave
	 * exactly as those do. */
	import Icon from './Icon.svelte';
	import { decodeQ, t } from '$lib/state/i18n.svelte';
	import { nav } from '$lib/state/navRecording.svelte';
	import { startFlight } from '$lib/state/flightAction.svelte';
	import { focusTrap } from '$lib/ui/focusTrap';
	import { portal } from '$lib/ui/portal';
	import {
		closeSearchPalette,
		openSearchPalette,
		searchPalette,
		type PaletteAction,
	} from '$lib/state/searchPalette.svelte';
	import { airportSearch, searchAirportsFor } from '$lib/state/airportSearch.svelte';
	import { rankWaypointHits, vfrAerodromes } from '$lib/state/waypointSearch.svelte';
	import { dataState, getAirports, getNavaids } from '$lib/state/data.svelte';
	import { visibleNotams, type IndexedNotam } from '$lib/state/notam.svelte';
	import { selectAirport, selectNavaid, selectNotam, selectTab, ui } from '$lib/state/ui.svelte';
	import { mapState } from '$lib/state/map.svelte';
	import { flyToVisible } from '$lib/map/focus';
	import { focusNotam } from '$lib/map/notamLayer';
	import { clearHover, hoverFeature } from '$lib/map/selectionHighlight';
	import { airportSwatchColor } from '$lib/map/airportSymbols';
	import { availableChartLayers } from '$lib/map/chartOverlays';
	import { layers, toggleChartLayer } from '$lib/state/layers.svelte';
	import { navLogModal, toggleNavLog } from '$lib/state/navLogModal.svelte';
	import { routeProfileModal, toggleRouteProfile } from '$lib/state/routeProfileModal.svelte';
	import { flightPrepModal, toggleFlightPrep } from '$lib/state/flightPrepModal.svelte';
	import { flightsModal, toggleFlights } from '$lib/state/flightsModal.svelte';
	import { openAbout } from '$lib/state/aboutModal.svelte';
	import { openShortcuts } from '$lib/state/shortcutsOverlay.svelte';
	import { navaidFreqLabel, type Navaid } from '$lib/data/navaids';
	import type { Airport } from '$lib/data/airports';
	import type { Notam } from '$lib/notam/types';

	/** Cap per group; the airports group closes with the hand-over row when
	 *  the ranking holds more. */
	const GROUP_CAP = 6;

	/** Ids for the combobox wiring below (aria-activedescendant needs one per
	 *  row); the palette is mounted once, but $props.id is the house rule. */
	const uid = $props.id();

	let query = $state('');
	let debounced = $state('');
	let selIndex = $state(0);
	let inputEl = $state<HTMLInputElement | null>(null);
	let listEl = $state<HTMLElement | null>(null);

	// ~120 ms trailing debounce. The lookups are sync in-memory scans; the
	// debounce only spares them per keystroke. A fresh term re-arms the
	// highlight on the top row.
	$effect(() => {
		const q = query;
		const id = setTimeout(() => {
			debounced = q;
			selIndex = 0;
		}, 120);
		return () => clearTimeout(id);
	});

	// Fresh palette each open; tracks only the open flag, so the input
	// binding landing after render can't wipe what was typed meanwhile.
	$effect(() => {
		if (!searchPalette.open) {
			return;
		}
		query = '';
		debounced = '';
		selIndex = 0;
	});

	$effect(() => {
		if (searchPalette.open) {
			inputEl?.focus();
		}
	});

	/* ---- Group lookups (all pure sync over loaded datasets) ---- */

	const airportRes = $derived(searchAirportsFor(debounced));
	const airportRows = $derived(airportRes.results.slice(0, GROUP_CAP));
	const moreAirports = $derived(airportRes.total - airportRows.length);

	const navaidRows = $derived.by(() => {
		const navaids = dataState.navaidsLoaded ? getNavaids() : null;
		if (!navaids) {
			return [] as Navaid[];
		}
		const airports = dataState.airportsLoaded ? getAirports() : null;
		const m = mapState.map;
		const c = m ? m.getCenter() : null;
		const ranked = rankWaypointHits(
			null,
			navaids,
			debounced,
			c ? { lat: c.lat, lon: c.lng } : null,
			vfrAerodromes(airports, navaids),
		);
		const out: Navaid[] = [];
		for (const hit of ranked.results) {
			if (hit.kind === 'navaid') {
				out.push(hit.navaid);
			}
			if (out.length === GROUP_CAP) {
				break;
			}
		}
		return out;
	});

	// Prefix match on the NOTAM id and on the A) location idents (the
	// notamsByIdent keys), id matches ranked first. Multi-area NOTAMs share
	// an id, so dedupe to one row per source NOTAM (the AirportDetail rule).
	const notamRows = $derived.by(() => {
		const q = debounced.trim().toUpperCase();
		if (!q) {
			return [] as IndexedNotam[];
		}
		const idHits: IndexedNotam[] = [];
		const identHits: IndexedNotam[] = [];
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local dedupe scratch, only the rows are returned
		const seen = new Set<string>();
		for (const item of visibleNotams()) {
			if (seen.has(item.notam.id)) {
				continue;
			}
			if (item.notam.id.toUpperCase().startsWith(q)) {
				seen.add(item.notam.id);
				idHits.push(item);
			} else if (item.notam.icaoCodes.some((code) => code.toUpperCase().startsWith(q))) {
				seen.add(item.notam.id);
				identHits.push(item);
			}
		}
		return idHits.concat(identHits).slice(0, GROUP_CAP);
	});

	// The static registry + one toggle per available chart layer; labels are
	// read here (a $derived, so a locale switch rebuilds them), the chart
	// rows restate the stack membership live, and the surface rows restate
	// whether the surface is up, since their run() puts it away again. Only
	// the open state is worded: the French for a hidden / shown pair would
	// have to agree with each label's gender, and one invariable phrase
	// spares the registry that.
	const onScreen = (up: boolean): string => (up ? t.search.palette.surfaceOnScreen : '');
	const allActions = $derived.by(() => {
		const rows: PaletteAction[] = [
			// The flight gesture leads: the palette closes before run(), so
			// the flow's confirms surface cleanly over the map.
			{
				id: 'flight',
				label: nav.recording ? t.navigation.stopFlight : t.navigation.start,
				state: nav.recording ? t.navigation.recording : '',
				run: startFlight,
			},
			{
				id: 'navlog',
				label: t.route.navigationLog,
				state: onScreen(navLogModal.open),
				run: toggleNavLog,
			},
			{
				id: 'route-profile',
				label: t.route.verticalProfile,
				state: onScreen(routeProfileModal.open),
				run: toggleRouteProfile,
			},
			{
				id: 'flight-prep',
				label: t.route.flightPreparation,
				state: onScreen(flightPrepModal.open),
				run: () => toggleFlightPrep(),
			},
			{
				id: 'flights',
				label: t.flights.title,
				state: onScreen(flightsModal.open),
				run: () => toggleFlights(),
			},
			{ id: 'about', label: t.common.aboutApp, state: '', run: openAbout },
			{ id: 'shortcuts', label: t.shortcuts.title, state: '', run: openShortcuts },
		];
		for (const def of availableChartLayers()) {
			const on = layers.chartStack.includes(def.id);
			rows.push({
				id: `chart-${def.id}`,
				label: def.label,
				state: on ? t.search.palette.chartShown : t.search.palette.chartHidden,
				run: () => toggleChartLayer(def.id),
			});
		}
		return rows;
	});

	// Substring match on the label (and the state word, so "chart" / "carte"
	// surfaces the layer toggles in both languages).
	const actionRows = $derived.by(() => {
		const q = debounced.trim().toLowerCase();
		if (!q) {
			return [] as PaletteAction[];
		}
		return allActions
			.filter((a) => a.label.toLowerCase().includes(q) || a.state.toLowerCase().includes(q))
			.slice(0, GROUP_CAP);
	});

	/* ---- One flat list across the groups for the keyboard ---- */

	type PaletteRow =
		| { kind: 'airport'; a: Airport }
		| { kind: 'more' }
		| { kind: 'navaid'; n: Navaid }
		| { kind: 'notam'; item: IndexedNotam }
		| { kind: 'action'; act: PaletteAction };

	const flat = $derived.by(() => {
		const out: PaletteRow[] = [];
		for (const a of airportRows) {
			out.push({ kind: 'airport', a });
		}
		if (moreAirports > 0) {
			out.push({ kind: 'more' });
		}
		for (const n of navaidRows) {
			out.push({ kind: 'navaid', n });
		}
		for (const item of notamRows) {
			out.push({ kind: 'notam', item });
		}
		for (const act of actionRows) {
			out.push({ kind: 'action', act });
		}
		return out;
	});

	// A dataset landing mid-query can shrink the list under the highlight;
	// a same-value write notifies nobody, so this settles in one pass.
	$effect(() => {
		if (selIndex >= flat.length) {
			selIndex = 0;
		}
	});

	const loadingAny = $derived(dataState.airportsLoading || dataState.navaidsLoading);

	type GroupId = 'airports' | 'navaids' | 'notams' | 'actions';

	function groupOf(row: PaletteRow): GroupId {
		switch (row.kind) {
			case 'airport':
			case 'more':
				return 'airports';
			case 'navaid':
				return 'navaids';
			case 'notam':
				return 'notams';
			case 'action':
				return 'actions';
		}
	}

	// Called from the template, so the t reads track the locale.
	function groupTitle(g: GroupId): string {
		switch (g) {
			case 'airports':
				return t.search.palette.airports;
			case 'navaids':
				return t.search.palette.navaids;
			case 'notams':
				return t.search.palette.notams;
			case 'actions':
				return t.search.palette.actions;
		}
	}

	function rowKey(row: PaletteRow): string {
		switch (row.kind) {
			case 'airport':
				return `a:${row.a.ident}`;
			case 'more':
				return 'more';
			case 'navaid':
				return `n:${row.n.id}`;
			case 'notam':
				return `t:${row.item.index}`;
			case 'action':
				return `x:${row.act.id}`;
		}
	}

	/* ---- Row subtitles (template-called, t tracked) ---- */

	function airportDesc(a: Airport): string {
		const place = [a.city, a.country].filter(Boolean).join(', ');
		return [a.name, place].filter(Boolean).join(' · ');
	}

	function navaidDesc(n: Navaid): string {
		const name = n.name && n.name !== n.ident ? n.name : '';
		return [t.data.navaidTypes[n.type], name, navaidFreqLabel(n)].filter(Boolean).join(' · ');
	}

	function notamDesc(notam: Notam): string {
		return decodeQ(notam.qCode) || (notam.isPolygon ? t.notam.kindArea : t.notam.kindPosition);
	}

	/* ---- Selection: the established select + fly paths ---- */

	function close(): void {
		closeSearchPalette();
		clearHover();
	}

	// On mobile the sidebar sheet would cover the detail sheet; collapse it
	// so the opened panel is visible (the AirportsTab row rule).
	function collapseForDetail(): void {
		if (ui.isMobile) {
			ui.sidebarCollapsed = true;
		}
	}

	function pick(row: PaletteRow): void {
		close();
		switch (row.kind) {
			case 'airport': {
				const a = row.a;
				selectAirport(a.ident);
				flyToVisible({ lat: a.lat, lng: a.lon }, Math.max(mapState.map?.getZoom() ?? 12, 12));
				collapseForDetail();
				break;
			}
			case 'more':
				// Hand the typed query to the Airports tab's own box.
				airportSearch.query = query;
				selectTab('airports');
				break;
			case 'navaid': {
				const n = row.n;
				selectNavaid(n.id);
				// Zoom floor 10: every navaid group draws from there
				// (waypoints / reporting points gate at 9).
				flyToVisible({ lat: n.lat, lng: n.lon }, Math.max(mapState.map?.getZoom() ?? 10, 10));
				collapseForDetail();
				break;
			}
			case 'notam': {
				selectNotam(row.item.index);
				const m = mapState.map;
				if (m) {
					focusNotam(m, row.item.notam);
				}
				collapseForDetail();
				break;
			}
			case 'action':
				row.act.run();
				break;
		}
	}

	/* ---- Hover: flash the feature on the map, viewport-gated (the
	 * RouteTextField suggestion-menu rule), and move the highlight row. ---- */

	function onHoverRow(row: PaletteRow, i: number): void {
		selIndex = i;
		const m = mapState.map;
		if (!m) {
			return;
		}
		const pos =
			row.kind === 'airport'
				? { lat: row.a.lat, lon: row.a.lon }
				: row.kind === 'navaid'
					? { lat: row.n.lat, lon: row.n.lon }
					: null;
		if (!pos || !m.getBounds().contains([pos.lat, pos.lon])) {
			return;
		}
		if (row.kind === 'airport') {
			hoverFeature('airport', row.a.ident);
		} else if (row.kind === 'navaid') {
			hoverFeature('navaid', row.n.id);
		}
	}

	/* ---- Keyboard ---- */

	function onInputKeydown(e: KeyboardEvent): void {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (flat.length === 0) {
				return;
			}
			selIndex =
				e.key === 'ArrowDown'
					? (selIndex + 1) % flat.length
					: (selIndex - 1 + flat.length) % flat.length;
			// Index addressing works pre-flush: the node set is unchanged,
			// only the active class moves (the RouteTextField idiom).
			listEl?.querySelectorAll('.row')[selIndex]?.scrollIntoView({ block: 'nearest' });
			return;
		}
		if (e.key === 'Enter') {
			const row = flat[Math.min(selIndex, flat.length - 1)];
			if (row) {
				e.preventDefault();
				pick(row);
			}
		}
	}

	function onBoxKeydown(e: KeyboardEvent): void {
		// Focus is trapped inside, so Escape always lands here; stopping it
		// keeps the key from any surface's window-level handler beneath
		// (the ResetDialog rule).
		if (e.key === 'Escape') {
			e.stopPropagation();
			close();
		}
	}

	function onWindowKey(e: KeyboardEvent): void {
		if (e.key.toLowerCase() !== 'k' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) {
			return;
		}
		// The chord is the app's even from an input (the palette convention),
		// so the browser default (e.g. Firefox's search-bar focus) never runs.
		e.preventDefault();
		if (searchPalette.open) {
			close();
			return;
		}
		// An open backdrop means a modal is already up (a modal surface, the
		// reset confirm, the keyboard map): the ShortcutsOverlay stacking rule.
		if (document.querySelector('.modal-backdrop')) {
			return;
		}
		openSearchPalette();
	}
</script>

<svelte:window onkeydown={onWindowKey} />

{#if searchPalette.open}
	<div use:portal>
		<button
			class="modal-backdrop"
			aria-label={t.common.dismiss}
			onpointerdown={close}
			oncontextmenu={(e) => e.preventDefault()}
		></button>
		<div
			class="modal-box palette-box"
			class:at-dialog={!ui.isMobile}
			class:at-full={ui.isMobile}
			role="dialog"
			aria-modal="true"
			aria-label={t.search.palette.title}
			tabindex="-1"
			use:focusTrap
			onkeydown={onBoxKeydown}
		>
			<div class="head">
				<Icon name="search" size={16} />
				<!-- A combobox in full: the arrow keys move a selection the input
				     itself keeps, so without aria-activedescendant a screen reader
				     hears nothing change as the user walks the results, and the
				     placeholder is not a name once anything is typed. The aircraft
				     editor's ICAO-type field is the same pattern. -->
				<input
					bind:this={inputEl}
					class="q"
					type="text"
					autocapitalize="characters"
					autocomplete="off"
					spellcheck="false"
					enterkeyhint="go"
					role="combobox"
					aria-label={t.search.palette.title}
					aria-autocomplete="list"
					aria-expanded={flat.length > 0}
					aria-controls={flat.length > 0 ? `${uid}-listbox` : undefined}
					aria-activedescendant={flat.length > 0 && selIndex >= 0
						? `${uid}-opt-${selIndex}`
						: undefined}
					placeholder={t.search.palette.placeholder}
					bind:value={query}
					onkeydown={onInputKeydown}
				/>
				{#if ui.isMobile}
					<button class="icon-btn" onclick={close} aria-label={t.common.close}>
						<Icon name="x" size={18} />
					</button>
				{/if}
			</div>
			<div
				class="list"
				bind:this={listEl}
				id="{uid}-listbox"
				role="listbox"
				aria-label={t.search.palette.title}
			>
				{#if debounced.trim() === ''}
					<p class="muted note">{t.search.palette.hint}</p>
				{:else}
					{#each flat as row, i (rowKey(row))}
						{#if i === 0 || groupOf(flat[i - 1]) !== groupOf(row)}
							<h3 class="grp" role="presentation">{groupTitle(groupOf(row))}</h3>
						{/if}
						<button
							class="row"
							class:active={i === selIndex}
							id="{uid}-opt-{i}"
							role="option"
							aria-selected={i === selIndex}
							tabindex="-1"
							onmousedown={(e) => e.preventDefault()}
							onmouseenter={() => onHoverRow(row, i)}
							onmouseleave={clearHover}
							onclick={() => pick(row)}
						>
							{#if row.kind === 'airport'}
								{@const dot = airportSwatchColor(row.a)}
								<span class="swatch" style:background={dot} style:border-color={dot}></span>
								<span class="row-text">
									<span class="row-id">
										{row.a.ident}
										{#if row.a.type === 'closed'}
											<span class="closed-chip" title={t.detail.closedTip}
												>{t.detail.closedTag}</span
											>
										{/if}
									</span>
									<span class="row-desc">{airportDesc(row.a)}</span>
								</span>
							{:else if row.kind === 'more'}
								<span class="row-text">
									<span class="row-desc">{t.search.palette.moreAirports(moreAirports)}</span>
								</span>
							{:else if row.kind === 'navaid'}
								<span class="row-text">
									<span class="row-id">{row.n.ident}</span>
									<span class="row-desc">{navaidDesc(row.n)}</span>
								</span>
							{:else if row.kind === 'notam'}
								<span class="row-text">
									<span class="row-id">{row.item.notam.id}</span>
									<span class="row-desc">{notamDesc(row.item.notam)}</span>
								</span>
							{:else if row.kind === 'action'}
								<span class="row-text">
									<span class="row-id act">{row.act.label}</span>
								</span>
								{#if row.act.state}
									<span class="state">{row.act.state}</span>
								{/if}
							{/if}
						</button>
					{/each}
					{#if flat.length === 0 && !loadingAny}
						<p class="muted note">{t.search.palette.noMatches}</p>
					{/if}
				{/if}
				{#if loadingAny}
					<p class="muted note">{t.search.palette.loading}</p>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	/* The centred top-third launcher: at-dialog centres vertically, a palette
	   sits high so the result list grows downward under the input. */
	.palette-box.at-dialog {
		--modal-width: min(600px, 92vw);

		top: 14%;
		max-height: min(64vh, 560px);
		transform: translate(-50%, 0);
	}

	.head {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		color: var(--text-muted);
		border-bottom: 1px solid var(--border);
	}

	.q {
		flex: 1;
		min-width: 0;
		padding: 2px 0;
		font: inherit;
		font-size: 14px;
		color: var(--text);
		background: transparent;
		border: none;
		outline: none;
	}

	/* 16px on phones so focusing the input never triggers the iOS zoom. */
	.palette-box.at-full .q {
		font-size: 16px;
	}

	.list {
		flex: 1;
		min-height: 0;
		padding: 6px;
		overflow-y: auto;
	}

	.grp {
		margin: 8px 6px 3px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.note {
		margin: 8px 6px;
		font-size: 12.5px;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 9px;
		width: 100%;
		padding: 7px 8px;
		font: inherit;
		text-align: left;
		color: var(--text);
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius);
		cursor: pointer;
	}

	.row:hover,
	.row.active {
		background: var(--surface-2);
	}

	.row.active {
		border-color: var(--accent);
	}

	:global(:root.touch-ui) .row {
		min-height: 44px;
	}

	/* Round status swatch, the AirportsTab row's colour cue. */
	.swatch {
		flex: 0 0 auto;
		width: 10px;
		height: 10px;
		border-style: solid;
		border-width: 1px;
		border-radius: 50%;
	}

	.row-text {
		display: flex;
		flex: 1;
		min-width: 0;
		flex-direction: column;
	}

	.row-id {
		overflow: hidden;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row-id.act {
		font-weight: 500;
	}

	.row-desc {
		overflow: hidden;
		font-size: 12px;
		color: var(--text-muted);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.state {
		flex: 0 0 auto;
		margin-left: auto;
		font-size: 11px;
		color: var(--text-muted);
	}
</style>
