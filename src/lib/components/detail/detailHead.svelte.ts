/* The detail's presentation, shared by its two homes: the desktop's side
 * panel (DetailPanel.svelte) and the phone's pane (DetailSurface.svelte,
 * the `detail` workspace surface; docs/workspace-surfaces.md "Phones").
 * Plain functions over the selection state and the catalogs, tracked when
 * called inside a $derived / $effect, so the two components render one
 * definition of the title, the subtitle, the back link, the centring and
 * the NOTAM stepper rather than two that drift. */

import { t } from '$lib/state/i18n.svelte';
import { ui, goBack, selectNotam, type DetailTarget } from '$lib/state/ui.svelte';
import { notamState, selectedNotam } from '$lib/state/notam.svelte';
import { orderedVisibleNotams } from '$lib/state/notamOrder.svelte';
import {
	dataState,
	selectedAirport,
	selectedAirspace,
	selectedObstacle,
	selectedNavaid,
	selectedNature,
	selectedSupaip,
	navaidById,
	natureById,
	supaipById,
} from '$lib/state/data.svelte';
import { mapState } from '$lib/state/map.svelte';
import { isOpen, movePlacement, surfaceKeepsMapVisible } from '$lib/state/workspace.svelte';
import { flyToVisible, flyToBoundsVisible } from '$lib/map/focus';
import { focusNotam } from '$lib/map/notamLayer';
import { focusSupBbox } from '$lib/map/supaipLayer';
import { focusSigmet } from '$lib/map/sigmetLayer';
import { selectedSigmet, sigmetRings } from '$lib/state/sigmets.svelte';
import { selectedStation } from '$lib/state/metarStations.svelte';
import { sigmetLabel } from '$lib/weather/sigmet';

/** The resolved selection, one object per read (a plain snapshot, not a
 *  store): every field null but the one ui.detail names and the datasets
 *  hold. */
export function detailSelection() {
	return {
		notam: selectedNotam(),
		airport: selectedAirport(),
		airspace: selectedAirspace(),
		obstacle: selectedObstacle(),
		navaid: selectedNavaid(),
		nature: selectedNature(),
		supaip: selectedSupaip(),
		supaipZone: ui.detail?.kind === 'supaip' ? ui.detail.zone : undefined,
		sigmet: selectedSigmet(),
		station: selectedStation(),
	};
}

export type DetailSelection = ReturnType<typeof detailSelection>;

/** What a target that resolved to NOTHING is waiting on. The lazy kinds
 *  load their dataset on demand and fill in when it lands (the panel's
 *  documented behaviour), so an unresolved target is ordinarily a second of
 *  loading; when the fetch has answered and the row is still not there
 *  (offline, or a row a higher-priority dataset deduped away) it is not
 *  coming. Null while the selection resolves, which is almost always.
 *  The desktop panel simply does not open for this; the PHONE pane is
 *  opened from ui.detail by App's bridge and would otherwise stand with an
 *  empty head over the map, closable and nothing else. */
export function detailPending(s: DetailSelection = detailSelection()): 'loading' | 'unavailable' | null {
	const target = ui.detail;
	if (target === null || detailOpen(s)) {
		return null;
	}
	const answered = (loaded: boolean, error: string | null): 'loading' | 'unavailable' =>
		loaded || error !== null ? 'unavailable' : 'loading';
	switch (target.kind) {
		case 'airport':
			return answered(dataState.airportsLoaded, dataState.airportsError);
		case 'airspace':
			return answered(dataState.airspacesLoaded, dataState.airspacesError);
		case 'obstacle':
			return answered(dataState.obstaclesLoaded, dataState.obstaclesError);
		case 'navaid':
			return answered(dataState.navaidsLoaded, dataState.navaidsError);
		case 'nature':
			return answered(dataState.natureLoaded, dataState.natureError);
		case 'supaip':
			return answered(dataState.supaipLoaded, dataState.supaipError);
		default:
			// A NOTAM index, a SIGMET id and a station are held in memory or
			// not at all: there is no late fill to wait for.
			return 'unavailable';
	}
}

/** True while the selection resolves to something the panel can show. */
export function detailOpen(s: DetailSelection = detailSelection()): boolean {
	return (
		s.notam !== null ||
		s.airport !== null ||
		s.airspace !== null ||
		s.obstacle !== null ||
		s.navaid !== null ||
		s.nature !== null ||
		s.supaip !== null ||
		s.sigmet !== null ||
		s.station !== null
	);
}

export function detailTitle(s: DetailSelection = detailSelection()): string {
	return (
		s.notam?.id ??
		s.airport?.ident ??
		s.airspace?.id ??
		s.obstacle?.name ??
		s.navaid?.ident ??
		s.nature?.name ??
		s.supaip?.title ??
		s.station?.id ??
		(s.sigmet ? sigmetLabel(s.sigmet, t.weather.sigmet) : '') ??
		''
	);
}

export function detailSubtitle(s: DetailSelection = detailSelection()): string {
	if (s.notam) {
		return t.detail.notamSubtitle;
	}
	if (s.airport) {
		return t.detail.airport;
	}
	if (s.airspace) {
		return t.detail.airspace;
	}
	if (s.obstacle) {
		return t.data.obstacleTypes[s.obstacle.type];
	}
	if (s.navaid) {
		return t.data.navaidTypes[s.navaid.type];
	}
	if (s.nature) {
		return s.nature.type === 'SENSITIVE' ? t.detail.sensitiveSite : t.detail.natureReserve;
	}
	if (s.supaip) {
		return t.detail.supAip;
	}
	if (s.sigmet) {
		// i18n-ignore: SIGMET is an ICAO abbreviation, locale-invariant
		return 'SIGMET';
	}
	if (s.station) {
		return t.detail.metarStation;
	}
	return '';
}

/** Greys out the crosshair when the selection has no usable geometry: a
 *  text-only NOTAM, or a SUP AIP whose PDF yielded no coordinates. */
export function detailCanCenter(s: DetailSelection = detailSelection()): boolean {
	return (
		s.airport != null ||
		s.airspace != null ||
		s.navaid != null ||
		s.nature != null ||
		s.obstacle != null ||
		(s.notam != null && s.notam.coordinates.length > 0) ||
		(s.supaip != null &&
			(s.supaipZone != null
				? (s.supaip.zones[s.supaipZone]?.bbox ?? s.supaip.bbox) != null
				: s.supaip.bbox != null)) ||
		(s.sigmet != null && sigmetRings(s.sigmet).length > 0) ||
		s.station != null
	);
}

/** The header crosshair centres the map on the selected item, reusing each
 *  kind's existing focus helper. Everything with an extent (NOTAM,
 *  airspace, SUP AIP, SIGMET) flies to its bbox by the same recipe, the
 *  zoom cap differing only by how large that kind of feature typically
 *  is; point features pan at the current zoom. No-op without a live map. */
export function centerSelected(s: DetailSelection = detailSelection()): void {
	const map = mapState.map;
	if (!map) {
		return;
	}
	// The flight has to land where the pilot can see it. On a phone the detail
	// can be up as a PAGE, which takes the whole stage, and the map would then
	// fly behind it with nothing on screen changing; give it its strip back
	// first. This is the half-height drop the bottom sheet did before the pane
	// replaced it. A dock keeps the map beside it and stands, and on desktop
	// the detail is a panel that owns no slot, so the test is false there.
	if (isOpen('detail') && !surfaceKeepsMapVisible('detail')) {
		movePlacement('detail', 'dock-bottom');
	}
	if (s.notam) {
		focusNotam(map, s.notam);
	} else if (s.airport) {
		flyToVisible({ lat: s.airport.lat, lng: s.airport.lon });
	} else if (s.airspace) {
		const b = s.airspace.bbox;
		flyToBoundsVisible(
			map,
			[
				[b.minLat, b.minLon],
				[b.maxLat, b.maxLon],
			],
			40,
			12,
		);
	} else if (s.obstacle) {
		flyToVisible({ lat: s.obstacle.lat, lng: s.obstacle.lon });
	} else if (s.navaid) {
		flyToVisible({ lat: s.navaid.lat, lng: s.navaid.lon });
	} else if (s.nature) {
		flyToVisible({ lat: s.nature.lat, lng: s.nature.lon });
	} else if (s.supaip) {
		const bbox =
			s.supaipZone != null
				? (s.supaip.zones[s.supaipZone]?.bbox ?? s.supaip.bbox)
				: s.supaip.bbox;
		focusSupBbox(map, bbox);
	} else if (s.sigmet) {
		focusSigmet(map, { sigmet: s.sigmet, rings: sigmetRings(s.sigmet) });
	} else if (s.station) {
		flyToVisible({ lat: s.station.lat, lng: s.station.lon });
	}
}

/** Whole sentences per kind (t.detail.backTo*), so French prepositions
 *  contract correctly ("Retour au NOTAM", "Retour à l'aérodrome"). A detail
 *  opened from a SURFACE carries the one-shot ui.detailReturn instead of a
 *  back target (the two are mutually exclusive) and brings its own sentence:
 *  which surfaces exist is the app's business, not this module's. */
export function detailBackLabel(): string {
	const ret = ui.detailReturn;
	if (ret) {
		return ret.label();
	}
	const b = ui.detailBack;
	if (!b) {
		return '';
	}
	if (b.kind === 'notam') {
		const n = notamState.notams[b.index];
		return n ? t.detail.backToNotam(n.id) : '';
	}
	if (b.kind === 'airport') {
		return t.detail.backToAirport(b.id);
	}
	if (b.kind === 'obstacle') {
		return t.detail.backToObstacle(b.id);
	}
	if (b.kind === 'navaid') {
		// Navaid ids ("DME:1527279") aren't user-facing; show the ident.
		return t.detail.backToNavaid(navaidById(b.id)?.ident ?? '').trimEnd();
	}
	if (b.kind === 'nature') {
		return t.detail.backToNature(natureById(b.id)?.name ?? '').trimEnd();
	}
	if (b.kind === 'supaip') {
		// SUP AIP ids ("metropole-2026-012") aren't user-facing; show title.
		return t.detail.backToSupaip(supaipById(b.id)?.title ?? '').trimEnd();
	}
	if (b.kind === 'sigmet') {
		return t.detail.backToSigmet;
	}
	if (b.kind === 'station') {
		return t.detail.backToStation(b.id);
	}
	// b.key is "id|name"; show the user-facing id, not the synthetic key.
	return t.detail.backToAirspace(b.key.split('|', 1)[0]);
}

/** Back to the surface that opened this detail reopens it over the panel (a
 *  profile's saved window restores the exact view left behind); the marker is
 *  consumed so a later close falls back to normal behavior. */
export function detailBack(): void {
	const ret = ui.detailReturn;
	if (ret) {
		ui.detailReturn = null;
		ret.reopen();
		return;
	}
	goBack();
}

export interface NotamStepper {
	pos: number;
	total: number;
	prev: number | null;
	next: number | null;
}

/** Prev/Next stepper, shown only for a NOTAM panel opened from the NOTAMs
 *  tab (the selection carries `fromList`). It walks orderedVisibleNotams()
 *  (the canonical SOFIA-Briefing PIB order), the SAME sequence the NOTAMs
 *  tab renders, so the position and the steps match the list exactly and
 *  reading it here tracks every filter; null (no stepper) for map /
 *  cross-link selections, a single visible entry, or a current NOTAM the
 *  filters have since removed from the list. */
export function notamStepper(): NotamStepper | null {
	const d = ui.detail;
	if (d?.kind !== 'notam' || !d.fromList) {
		return null;
	}
	const list = orderedVisibleNotams();
	if (list.length <= 1) {
		return null;
	}
	const pos = list.findIndex((it) => it.index === d.index);
	if (pos === -1) {
		return null;
	}
	return {
		pos,
		total: list.length,
		prev: pos > 0 ? list[pos - 1].index : null,
		next: pos < list.length - 1 ? list[pos + 1].index : null,
	};
}

/** Step to another list entry, mirroring NotamsTab.onSelect (select +
 *  recentre the map). Keeps fromList=true so the stepper persists. */
export function stepToNotam(index: number): void {
	selectNotam(index, true);
	const n = notamState.notams[index];
	if (mapState.map && n) {
		focusNotam(mapState.map, n);
	}
}

/** Left/Right arrow keys step the list while a list-opened NOTAM is shown.
 *  Inert otherwise; skip when typing in a field, when a resize handle has
 *  focus (it nudges width with arrows) or the map is focused (Leaflet pans
 *  with arrows), and ignore modifier combos. */
export function detailKeydown(e: KeyboardEvent, nav: NotamStepper | null): void {
	if (!nav || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) {
		return;
	}
	const target = e.target;
	if (
		target instanceof HTMLElement &&
		(target.tagName === 'INPUT' ||
			target.tagName === 'TEXTAREA' ||
			target.tagName === 'SELECT' ||
			target.isContentEditable ||
			target.closest('.resize-handle') ||
			target.closest('.dock-grip') ||
			target.closest('.leaflet-container'))
	) {
		return;
	}
	if (e.key === 'ArrowLeft' && nav.prev !== null) {
		e.preventDefault();
		stepToNotam(nav.prev);
	} else if (e.key === 'ArrowRight' && nav.next !== null) {
		e.preventDefault();
		stepToNotam(nav.next);
	}
}

/** The per-target scroll-memory key both homes use. */
export function detailScrollKey(target: DetailTarget): string {
	if (target.kind === 'notam') {
		return `notam:${target.index}`;
	}
	if (target.kind === 'airspace') {
		return `airspace:${target.key}`;
	}
	return `${target.kind}:${target.id}`;
}
