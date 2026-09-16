/* The phone's chrome state beside ui.page: the bar's home action, the map
 * fit, and the section tables the pages render. Kept out of ui.svelte.ts
 * because goHome needs the workspace and the map (ui must import neither). */

import type { Messages } from '$lib/i18n/en';
import { closeDetail, closePage, type PhonePage, ui } from './ui.svelte';
import { isOpen, placementOf, requestCloseSurface, workspace } from './workspace.svelte';
import { nav } from './navRecording.svelte';
import { mapState } from './map.svelte';
import { recenterNav } from '$lib/map/navLayer';
import { activeRoute } from './route.svelte';
import { visibleNotams } from './notam.svelte';
import { fitRoute } from '$lib/components/tabs/route/fitRoute';
import { fitToNotams } from '$lib/map/notamLayer';

/** A page's sections: the Segmented sub-header, in order, the first the
 *  default. The `key` names the label in t.tabs. */
export interface PageSection {
	id: string;
	key: keyof Messages['tabs'];
}

export const PAGE_SECTIONS: Record<PhonePage, PageSection[]> = {
	airports: [
		{ id: 'nearest', key: 'nearest' },
		{ id: 'search', key: 'search' },
	],
	brief: [
		{ id: 'notams', key: 'notams' },
		{ id: 'weather', key: 'weather' },
		{ id: 'supaip', key: 'supaip' },
	],
	plan: [
		{ id: 'route', key: 'route' },
		{ id: 'aircraft', key: 'aircraft' },
		{ id: 'prep', key: 'preparation' },
		{ id: 'log', key: 'log' },
		{ id: 'profile', key: 'profile' },
	],
	flight: [
		{ id: 'flight', key: 'flightSection' },
		{ id: 'alerts', key: 'alerts' },
		{ id: 'replay', key: 'replay' },
	],
	layers: [],
	settings: [],
};

/** The section a page is on: the one it was left on, else its first. */
export function pageSection(page: PhonePage): string | null {
	return ui.pageSection[page] ?? PAGE_SECTIONS[page][0]?.id ?? null;
}

/** The bar's Map destination: home. The page goes, the pane goes, the
 *  selection goes, and in flight the map comes back to the aircraft (the
 *  Fly gesture's own landing). */
export function goHome(): void {
	closePage();
	for (const id of [workspace.dockBottom, workspace.dockRight]) {
		if (id !== null) {
			requestCloseSurface(id);
		}
	}
	const overlay = workspace.overlay;
	if (overlay !== null && placementOf(overlay) === 'page') {
		requestCloseSurface(overlay);
	}
	closeDetail();
	if (nav.recording && mapState.map) {
		recenterNav(mapState.map);
	}
}

/** A bar tap first asks a full-screen surface (flights, the workbooks,
 *  About) to go, since the bar stays visible under it; false when the
 *  surface refused (the aircraft editor's unsaved edits), in which case the
 *  tap does nothing else. The pane at its page detent is not one of these:
 *  a page covers it and Back brings it back. */
export function clearFullSurface(): boolean {
	const overlay = workspace.overlay;
	if (overlay === null || overlay === 'detail') {
		return true;
	}
	const placement = placementOf(overlay);
	if (placement !== 'full' && placement !== 'dialog') {
		return true;
	}
	requestCloseSurface(overlay);
	return !isOpen(overlay);
}

/** The phone's one fit button: the route when there is one to fit, else
 *  the NOTAMs (the desktop toolbar's fit). */
export function fitMap(): void {
	const map = mapState.map;
	if (!map) {
		return;
	}
	if (activeRoute().waypoints.length >= 2) {
		fitRoute();
		return;
	}
	fitToNotams(map, visibleNotams());
}
