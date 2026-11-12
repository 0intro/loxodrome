<script lang="ts">
	/* The search palette, THE search of the app (docs/search.md): one face
	 * over the search engine (src/lib/search), its groups ordered by their
	 * best hit, plus a small action registry (surfaces + chart-layer
	 * toggles). The Airports tab stays the aerodrome directory; the
	 * aerodrome group closes with a "more in the Airports tab" row that
	 * hands the query over. A centred top-third dialog on the shared
	 * .modal-backdrop / .modal-box chrome (the ResetDialog / ShortcutsOverlay
	 * precedent: portal, Escape, focus lands in the input, deliberately NOT a
	 * workspace surface), opened by Ctrl+K and the toolbar's search on every
	 * layout. On a phone it is full screen (ui.isMobile decides, the at-full
	 * box pads the safe-area insets): the bar stays in sight under its scrim,
	 * a blocking dialog's, so a tap there closes it rather than opening a
	 * page behind it, and the system Back closes it. Selection reuses the
	 * established select + fly paths (AirportsTab / NotamsTab rows), so the
	 * detail panel and the map behave exactly as those do. */
	import Icon from './Icon.svelte';
	import { decodeQ, fmtInt, i18n, t } from '$lib/state/i18n.svelte';
	import { regionNames } from '$lib/i18n/intl';
	import { nav } from '$lib/state/navRecording.svelte';
	import { flightButtonState, startFlight } from '$lib/state/flightAction.svelte';
	import { focusTrap } from '$lib/ui/focusTrap';
	import { registerBackClose } from '$lib/ui/backClose';
	import { portal } from '$lib/ui/portal';
	import {
		closeSearchPalette,
		openSearchPalette,
		searchPalette,
		type PaletteAction,
	} from '$lib/state/searchPalette.svelte';
	import { untrack } from 'svelte';
	import { airportSearch } from '$lib/state/airportSearch.svelte';
	import { vfrAerodromes } from '$lib/state/waypointSearch.svelte';
	import { searchReference } from '$lib/state/searchRef';
	import { prepareQuery } from '$lib/search/query';
	import { rankAirports } from '$lib/search/airports';
	import { rankNavaids } from '$lib/search/navaids';
	import { rankNotams } from '$lib/search/notams';
	import { rankAirspaces } from '$lib/search/airspaces';
	import { countryIndex, rankCountries, type Country } from '$lib/search/countries';
	import { rankActions } from '$lib/search/actions';
	import { orderGroups } from '$lib/search/combine';
	import { rankCoords } from '$lib/search/coords';
	import { rankPlaces } from '$lib/search/places';
	import type { Place } from '$lib/data/places';
	import { ensurePlaces, getPlaces, placeTarget, placesState } from '$lib/state/places.svelte';
	import { placeSubtitle } from './detail/detailHead.svelte';
	import { vrpLandmark } from '$lib/format/remark';
	import { formatCoord, formatCoordShort } from '$lib/format/coord';
	import type { LatLon } from '$lib/notam/types';
	import type { Ranked } from '$lib/search/rank';
	import { publisherCountry } from '$lib/data/publishers';
	import {
		dataState,
		ensureAirspaces,
		fuelForIdent,
		getAirports,
		getAirspaces,
		searchAllCountries,
		searchAllState,
		searchScope,
		getNavaids,
	} from '$lib/state/data.svelte';
	import { civilGrades, gradeLabel } from '$lib/data/fuel';
	import { visibleNotams, type IndexedNotam } from '$lib/state/notam.svelte';
	import {
		positionPlace,
		selectAirport,
		selectAirspace,
		selectNavaid,
		selectNotam,
		selectPlace,
		showTab,
		ui,
		revealMap,
	} from '$lib/state/ui.svelte';
	import { mapState } from '$lib/state/map.svelte';
	import { flyToBoundsVisible, flyToVisible } from '$lib/map/focus';
	import { formatVLimit } from '$lib/vertical/limits';
	import type { Airspace } from '$lib/data/airspaces';
	import { focusNotam } from '$lib/map/notamLayer';
	import { clearHover, hoverFeature, hoverPlace } from '$lib/map/selectionHighlight';
	import { airportSwatchColor } from '$lib/map/airportSymbols';
	import { availableChartLayers } from '$lib/map/chartOverlays';
	import { layers, toggleChartLayer } from '$lib/state/layers.svelte';
	import { navLogModal, toggleNavLog } from '$lib/state/navLogModal.svelte';
	import { routeProfileModal, toggleRouteProfile } from '$lib/state/routeProfileModal.svelte';
	import { flightPrepModal, toggleFlightPrep } from '$lib/state/flightPrepModal.svelte';
	import { flightsModal, toggleFlights } from '$lib/state/flightsModal.svelte';
	import {
		downloadPlanFile,
		newPlan,
		openSavedPlan,
		pickPlanFile,
		saveAndAnswer,
	} from '$lib/state/planDocument.svelte';
	import { openAbout } from '$lib/state/aboutModal.svelte';
	import {
		offlineManagerAvailable,
		offlineModal,
		toggleOffline,
	} from '$lib/state/offlineModal.svelte';
	import { openShortcuts } from '$lib/state/shortcutsOverlay.svelte';
	import { navaidFreqLabel, type Navaid } from '$lib/data/navaids';
	import type { Airport } from '$lib/data/airports';
	import type { Notam } from '$lib/notam/types';
	import { dismissOnDown } from '$lib/ui/dismissOnDown';
	import { occurrenceKeys } from '$lib/data/dedup';

	/** Cap per group; the airports group closes with the hand-over row when
	 *  the ranking holds more. */
	const GROUP_CAP = 6;

	const EMPTY: Ranked<never> = { hits: [], total: 0 };

	/** Countries take the last rows, few of them. */
	const COUNTRY_CAP = 3;

	/** Ids for the combobox wiring below (aria-activedescendant needs one per
	 *  row); the palette is mounted once, but $props.id is the house rule. */
	const uid = $props.id();

	let query = $state('');
	let debounced = $state('');
	/** The highlighted row, by key: a dataset landing mid-query reshuffles
	 *  the rows, and the highlight stays on the row the pilot arrowed to (the
	 *  top one when it is gone). */
	let selKey = $state<string | null>(null);
	let inputEl = $state<HTMLInputElement | null>(null);
	let listEl = $state<HTMLElement | null>(null);

	// ~120 ms trailing debounce. The lookups are sync in-memory scans; the
	// debounce only spares them per keystroke. A fresh term re-arms the
	// highlight on the top row.
	$effect(() => {
		const q = query;
		const id = setTimeout(() => {
			debounced = q;
			selKey = null;
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
		selKey = null;
	});

	$effect(() => {
		if (searchPalette.open) {
			inputEl?.focus();
		}
	});

	// On a phone the system Back closes the palette, as it does every sheet
	// and page (the ConfirmDialog rule); the desktop keeps no history entry.
	$effect(() => {
		if (!searchPalette.open || !ui.isMobile) {
			return;
		}
		return registerBackClose(close);
	});

	/* ---- Group lookups: the one search engine (docs/search.md) ---- */

	const q = $derived(prepareQuery(debounced));
	// Distances from the aircraft in flight, else the map's centre, taken
	// once per query: a fix or a pan never reshuffles the rows being read.
	const ref = $derived.by(() => {
		void debounced;
		return untrack(searchReference);
	});

	// A typed position: one row, pinned first, beside every other result
	// (an FAA ident such as N12 stays an ident).
	const coordGroup = $derived(rankCoords(debounced));

	const airportGroup = $derived.by((): Ranked<Airport> => {
		const all = dataState.airportsLoaded ? getAirports() : null;
		return all ? rankAirports(all, q, { ref, cap: GROUP_CAP }) : EMPTY;
	});
	const moreAirports = $derived(airportGroup.total - airportGroup.hits.length);

	const navaidGroup = $derived.by((): Ranked<Navaid> => {
		const navaids = dataState.navaidsLoaded ? getNavaids() : null;
		if (!navaids) {
			return EMPTY;
		}
		const airports = dataState.airportsLoaded ? getAirports() : null;
		return rankNavaids(navaids, q, { ref, cap: GROUP_CAP, aero: vfrAerodromes(airports, navaids) });
	});

	// Airspaces and towns load on the session's first search, not the
	// palette's open: France's airspaces alone are a megabyte, for a pilot
	// who may only want an aerodrome.
	let firstSearchAsked = false;
	$effect(() => {
		if (firstSearchAsked || debounced.trim() === '') {
			return;
		}
		firstSearchAsked = true;
		void ensureAirspaces().catch(() => {});
		void ensurePlaces().catch(() => {});
	});

	// Towns: one tier under a feature's same match, nearer for being larger.
	const placeGroup = $derived.by((): Ranked<Place> => {
		const all = getPlaces();
		return all ? rankPlaces(all, q, { ref, cap: GROUP_CAP }) : EMPTY;
	});

	// By designator however it is written (LF-R45A, R 45 A), then by name.
	const airspaceGroup = $derived.by((): Ranked<Airspace> => {
		const all = dataState.airspacesLoaded ? getAirspaces() : null;
		return all ? rankAirspaces(all, q, { ref, cap: GROUP_CAP }) : EMPTY;
	});

	// Countries: a fly-to row, last whatever its match, named in both
	// languages from the platform's data; the index is built once per
	// aerodrome merge, and only once a query could name a country.
	let countryMemo: { airports: readonly Airport[]; rows: Country[] } | null = null;
	function countriesOf(airports: readonly Airport[]): Country[] {
		if (countryMemo?.airports !== airports) {
			countryMemo = {
				airports,
				rows: countryIndex(airports, (code, lang) => regionNames(lang).of(code)),
			};
		}
		return countryMemo.rows;
	}
	const countryGroup = $derived.by((): Ranked<Country> => {
		const all = dataState.airportsLoaded ? getAirports() : null;
		if (!all || q.words.replace(/ /g, '').length < 3) {
			return EMPTY;
		}
		return rankCountries(countriesOf(all), q, { ref, cap: COUNTRY_CAP });
	});

	// By id, then by an A) location (the notamsByIdent keys), one row per
	// source NOTAM (the AirportDetail rule).
	const notamGroup = $derived(rankNotams(visibleNotams(), q, GROUP_CAP));

	// The static registry + one toggle per available chart layer; labels are
	// read here (a $derived, so a locale switch rebuilds them), the chart
	// rows restate the stack membership live, and the surface rows restate
	// whether the surface is up, since their run() puts it away again. Only
	// the open state is worded: the French for a hidden / shown pair would
	// have to agree with each label's gender, and one invariable phrase
	// spares the registry that.
	const onScreen = (up: boolean): string => (up ? t.search.palette.surfaceOnScreen : '');
	const flightBtn = $derived(flightButtonState());
	const allActions = $derived.by(() => {
		const rows: PaletteAction[] = [
			// The flight gesture leads: the palette closes before run(), so
			// the flow's confirms surface cleanly over the map. Worded as the
			// toolbar button is, by what the tap would do.
			{
				id: 'flight',
				label:
					flightBtn === 'stop'
						? t.navigation.stopFlight
						: flightBtn === 'resume'
							? t.navigation.resumeFlight
							: t.navigation.start,
				state: nav.recording ? t.navigation.recording : '',
				run: startFlight,
			},
			// Absent where there is nothing to manage, the same gate the
			// Layers tab's row and the toolbar read.
			...(offlineManagerAvailable()
				? [
						{
							id: 'offline',
							label: t.offline.title,
							state: onScreen(offlineModal.open),
							run: (): void => toggleOffline(),
						},
					]
				: []),
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
			// The flight plan, the document: what its menu offers (PlanMenu).
			{ id: 'plan-save', label: t.plan.save, state: '', run: () => void saveAndAnswer() },
			{ id: 'plan-open', label: t.plan.openSaved, state: '', run: openSavedPlan },
			{ id: 'plan-file', label: t.plan.openFile, state: '', run: pickPlanFile },
			{ id: 'plan-new', label: t.plan.newPlan, state: '', run: () => void newPlan() },
			{ id: 'plan-download', label: t.plan.download, state: '', run: () => void downloadPlanFile() },
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

	// The label, and the state word beside it, so "chart" / "carte" finds the
	// layer toggles in both languages.
	const actionGroup = $derived(rankActions(allActions, q, GROUP_CAP));

	// The groups in the order their best rows deserve, so Enter takes the
	// best answer whatever kind it is.
	const groups = $derived(
		orderGroups([
			{ id: 'coords' as const, ranked: coordGroup, place: 'first' as const },
			{ id: 'airports' as const, ranked: airportGroup },
			{ id: 'navaids' as const, ranked: navaidGroup },
			{ id: 'airspaces' as const, ranked: airspaceGroup },
			{ id: 'places' as const, ranked: placeGroup },
			{ id: 'notams' as const, ranked: notamGroup },
			{ id: 'actions' as const, ranked: actionGroup },
			{ id: 'countries' as const, ranked: countryGroup, place: 'last' as const },
		]),
	);

	/* ---- One flat list across the groups for the keyboard ---- */

	type PaletteRow =
		| { kind: 'coord'; p: LatLon }
		| { kind: 'airport'; a: Airport }
		| { kind: 'more' }
		| { kind: 'navaid'; n: Navaid }
		| { kind: 'airspace'; s: Airspace }
		| { kind: 'place'; p: Place }
		| { kind: 'country'; c: Country }
		| { kind: 'notam'; item: IndexedNotam }
		| { kind: 'action'; act: PaletteAction }
		| { kind: 'all' };

	const flat = $derived.by(() => {
		const out: PaletteRow[] = [];
		for (const g of groups) {
			switch (g.id) {
				case 'coords':
					for (const h of coordGroup.hits) {
						out.push({ kind: 'coord', p: h.item });
					}
					break;
				case 'airports':
					for (const h of airportGroup.hits) {
						out.push({ kind: 'airport', a: h.item });
					}
					if (moreAirports > 0) {
						out.push({ kind: 'more' });
					}
					break;
				case 'navaids':
					for (const h of navaidGroup.hits) {
						out.push({ kind: 'navaid', n: h.item });
					}
					break;
				case 'airspaces':
					for (const h of airspaceGroup.hits) {
						out.push({ kind: 'airspace', s: h.item });
					}
					break;
				case 'places':
					for (const h of placeGroup.hits) {
						out.push({ kind: 'place', p: h.item });
					}
					break;
				case 'notams':
					for (const h of notamGroup.hits) {
						out.push({ kind: 'notam', item: h.item });
					}
					break;
				case 'actions':
					for (const h of actionGroup.hits) {
						out.push({ kind: 'action', act: h.item });
					}
					break;
				case 'countries':
					for (const h of countryGroup.hits) {
						out.push({ kind: 'country', c: h.item });
					}
					break;
			}
		}
		// Beyond the countries the search holds whole, the last row offers
		// them all (docs/data-coverage.md "Search all countries").
		if (debounced.trim() !== '' && searchAllState.phase !== 'on') {
			out.push({ kind: 'all' });
		}
		return out;
	});
	const noResults = $derived(flat.every((r) => r.kind === 'all'));

	const loadingAny = $derived(
		dataState.airportsLoading || dataState.navaidsLoading || dataState.airspacesLoading || placesState.loading,
	);

	type GroupId = 'coords' | 'airports' | 'navaids' | 'airspaces' | 'places' | 'notams' | 'actions' | 'countries' | 'all';

	function groupOf(row: PaletteRow): GroupId {
		switch (row.kind) {
			case 'coord':
				return 'coords';
			case 'airport':
			case 'more':
				return 'airports';
			case 'navaid':
				return 'navaids';
			case 'airspace':
				return 'airspaces';
			case 'place':
				return 'places';
			case 'notam':
				return 'notams';
			case 'action':
				return 'actions';
			case 'country':
				return 'countries';
			case 'all':
				return 'all';
		}
	}

	// Called from the template, so the t reads track the locale.
	function groupTitle(g: GroupId): string {
		switch (g) {
			case 'coords':
				return t.search.palette.position;
			case 'airports':
				return t.search.palette.airports;
			case 'navaids':
				return t.search.palette.navaids;
			case 'airspaces':
				return t.search.palette.airspaces;
			case 'places':
				return t.search.palette.towns;
			case 'notams':
				return t.search.palette.notams;
			case 'actions':
				return t.search.palette.actions;
			case 'countries':
				return t.search.palette.countries;
			case 'all':
				return '';
		}
	}

	// The rows' keys, by occurrence: an airport ident can repeat in the merged
	// data (16 FAA strips share MM), and a keyed each throws on a duplicate
	// key in production too.
	const rowKeys = $derived(occurrenceKeys(flat, rowKey));
	const selIndex = $derived(selKey === null ? 0 : Math.max(0, rowKeys.indexOf(selKey)));

	function rowKey(row: PaletteRow): string {
		switch (row.kind) {
			case 'coord':
				return `p:${row.p.lat},${row.p.lon}`;
			case 'airport':
				return `a:${row.a.ident}`;
			case 'more':
				return 'more';
			case 'navaid':
				return `n:${row.n.id}`;
			case 'airspace':
				return `s:${row.s.id}|${row.s.name}`;
			case 'place':
				return `w:${row.p.id}`;
			case 'notam':
				return `t:${row.item.index}`;
			case 'action':
				return `x:${row.act.id}`;
			case 'country':
				return `c:${row.c.code}`;
			case 'all':
				return 'all';
		}
	}

	/* ---- Row subtitles (template-called, t tracked) ---- */

	// The countries held whole, named in the interface's language.
	function scopeLine(): string {
		if (searchAllState.phase === 'on') {
			return t.search.palette.scopeAll;
		}
		const names = searchScope()
			.map((p) => {
				const code = publisherCountry(p);
				return code ? regionNames(i18n.locale).of(code) : undefined;
			})
			.filter((n): n is string => n !== undefined);
		return names.length > 0 ? t.search.palette.scopeSome(names.join(', ')) : t.search.palette.scopeNone;
	}

	function airportDesc(a: Airport): string {
		const place = [a.city, a.country].filter(Boolean).join(', ');
		// The grades close the line where there are any, so picking a fuel
		// stop from the palette does not need the panel opened first. The
		// dataset is loaded by whatever opened an airport panel or the fuel
		// plan; the palette shows what happens to be there and fetches
		// nothing of its own.
		const row = fuelForIdent(a.ident, a.source);
		const fuel = row ? civilGrades(row).map(gradeLabel).join(', ') : '';
		return [a.name, place, fuel].filter(Boolean).join(', ');
	}

	function navaidDesc(n: Navaid): string {
		const name = n.name && n.name !== n.ident ? n.name : '';
		if (n.type !== 'VFR_REPORTING_POINT') {
			return [t.data.navaidTypes[n.type], name, navaidFreqLabel(n)].filter(Boolean).join(', ');
		}
		// A reporting point: its landmark where the AIP states one, then its
		// aerodrome.
		const aero = vfrAerodromes(getAirports(), getNavaids())?.get(n.id);
		return [t.data.navaidTypes[n.type], vrpLandmark(n.rmk) || name, aero?.name || aero?.ident]
			.filter(Boolean)
			.join(', ');
	}

	// The type in words, the id a NOTAM cites, the vertical band.
	function airspaceDesc(a: Airspace): string {
		const type = (t.data.airspaceTypes as Record<string, string>)[a.type] ?? a.type;
		return [type, a.id, `${formatVLimit(a.vLower)} – ${formatVLimit(a.vUpper)}`].join(', ');
	}

	// A country in the interface's language; its other name and its count
	// beneath, so "Allemagne" and "Germany" read as one.
	function countryName(c: Country): string {
		return i18n.locale === 'fr' ? c.fr : c.en;
	}
	function countryDesc(c: Country): string {
		const other = i18n.locale === 'fr' ? c.en : c.fr;
		return [other, t.search.palette.countryAerodromes(fmtInt(c.count), c.count)].join(', ');
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
		revealMap();
	}

	function pick(row: PaletteRow): void {
		// The palette stays open with its query: the rows fill in as the
		// countries land.
		if (row.kind === 'all') {
			void searchAllCountries();
			inputEl?.focus();
			return;
		}
		close();
		switch (row.kind) {
			case 'coord': {
				const { lat, lon } = row.p;
				selectPlace(positionPlace(lat, lon));
				flyToVisible({ lat, lng: lon }, Math.max(mapState.map?.getZoom() ?? 11, 11));
				collapseForDetail();
				break;
			}
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
				showTab('airports');
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
			case 'airspace': {
				// A merge can move a row's key (a repeat takes "#N"): find the
				// row again in the current one.
				const cur =
					getAirspaces()?.find((a) => a.id === row.s.id && a.name === row.s.name && a.source === row.s.source) ??
					row.s;
				selectAirspace(cur.key);
				const m = mapState.map;
				if (m) {
					const b = cur.bbox;
					flyToBoundsVisible(m, [[b.minLat, b.minLon], [b.maxLat, b.maxLon]], 40, 12);
				}
				collapseForDetail();
				break;
			}
			case 'place': {
				const p = row.p;
				selectPlace(placeTarget(p));
				flyToVisible({ lat: p.lat, lng: p.lon }, Math.max(mapState.map?.getZoom() ?? 11, 11));
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
			case 'country': {
				const m = mapState.map;
				if (m) {
					const e = row.c.extent;
					flyToBoundsVisible(m, [[e.minLat, e.minLon], [e.maxLat, e.maxLon]], 40, 9);
				}
				collapseForDetail();
				break;
			}
		}
	}

	/* ---- Hover: flash the feature on the map, viewport-gated (the
	 * RouteTextField suggestion-menu rule), and move the highlight row. ---- */

	function onHoverRow(row: PaletteRow, i: number): void {
		selKey = rowKeys[i] ?? null;
		const m = mapState.map;
		if (!m) {
			return;
		}
		if (row.kind === 'airspace') {
			const b = row.s.bbox;
			if (m.getBounds().intersects([[b.minLat, b.minLon], [b.maxLat, b.maxLon]])) {
				hoverFeature('airspace', row.s.key);
			}
			return;
		}
		const pos =
			row.kind === 'airport'
				? { lat: row.a.lat, lon: row.a.lon }
				: row.kind === 'navaid'
					? { lat: row.n.lat, lon: row.n.lon }
					: row.kind === 'place'
						? { lat: row.p.lat, lon: row.p.lon }
						: null;
		if (!pos || !m.getBounds().contains([pos.lat, pos.lon])) {
			return;
		}
		if (row.kind === 'airport') {
			hoverFeature('airport', row.a.ident);
		} else if (row.kind === 'navaid') {
			hoverFeature('navaid', row.n.id);
		} else if (row.kind === 'place') {
			hoverPlace(pos);
		}
	}

	/* ---- Keyboard ---- */

	function onInputKeydown(e: KeyboardEvent): void {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (flat.length === 0) {
				return;
			}
			const next =
				e.key === 'ArrowDown'
					? (selIndex + 1) % flat.length
					: (selIndex - 1 + flat.length) % flat.length;
			selKey = rowKeys[next] ?? null;
			// Index addressing works pre-flush: the node set is unchanged,
			// only the active class moves (the RouteTextField idiom).
			listEl?.querySelectorAll('.row')[next]?.scrollIntoView({ block: 'nearest' });
			return;
		}
		if (e.key === 'Enter') {
			// A fast "LFPN" then Enter beats the debounce: rank the text as
			// typed, or Enter picks a row for the text before it.
			if (debounced !== query) {
				debounced = query;
				selKey = null;
			}
			const row = flat[Math.min(selIndex, flat.length - 1)];
			// "Search all countries" loads a megabyte: never Enter's
			// default, only the row arrowed to.
			if (row && !(row.kind === 'all' && selKey === null)) {
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
			onpointerdown={dismissOnDown(close)}
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
					{#each flat as row, i (rowKeys[i])}
						{#if (i === 0 || groupOf(flat[i - 1]) !== groupOf(row)) && groupTitle(groupOf(row))}
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
							{#if row.kind === 'coord'}
								<span class="row-text">
									<span class="row-id">{formatCoordShort(row.p.lat, row.p.lon)}</span>
									<span class="row-desc">{formatCoord(row.p.lat, row.p.lon).decimal}</span>
								</span>
							{:else if row.kind === 'airport'}
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
							{:else if row.kind === 'airspace'}
								<span class="swatch sq" style:background={`var(--airspace-${row.s.category})`}></span>
								<span class="row-text">
									<span class="row-id">
										{`${row.s.type} ${row.s.name}`.trim()}
										{#if row.s.airClass}
											<span class="cls">{row.s.airClass}</span>
										{/if}
									</span>
									<span class="row-desc">{airspaceDesc(row.s)}</span>
								</span>
							{:else if row.kind === 'place'}
								<span class="row-text">
									<span class="row-id">{row.p.name}</span>
									<span class="row-desc">{placeSubtitle(placeTarget(row.p))}</span>
								</span>
							{:else if row.kind === 'country'}
								<span class="row-text">
									<span class="row-id">{countryName(row.c)}</span>
									<span class="row-desc">{countryDesc(row.c)}</span>
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
							{:else if row.kind === 'all'}
								<span class="row-text">
									<span class="row-id act">
										{searchAllState.phase === 'loading'
											? t.search.palette.searchAllLoading
											: t.search.palette.searchAll}
									</span>
									<span class="row-desc">{t.search.palette.searchAllTip}</span>
								</span>
							{/if}
						</button>
					{/each}
					{#if noResults && !loadingAny}
						<p class="muted note">{t.search.palette.noMatches}</p>
					{/if}
					<p class="muted note scope">{scopeLine()}</p>
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

	/* An airspace's swatch is its category's square, the context menu's. */
	.swatch.sq {
		border-color: transparent;
		border-radius: 2px;
	}

	.cls {
		margin-left: 4px;
		padding: 0 4px;
		font-size: 10.5px;
		font-weight: 600;
		color: var(--text-muted);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
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
