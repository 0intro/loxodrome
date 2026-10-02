/* The phone's chrome state beside ui.page: the bar's home action, the map
 * fit, and the section tables the pages render. Kept out of ui.svelte.ts
 * because goHome needs the workspace and the map (ui must import neither). */

import type { Messages } from '$lib/i18n/en';
import { closeDetail, closePage, type PhonePage, ui } from './ui.svelte';
import { isOpen, movePlacement, placementOf, requestCloseSurface, workspace } from './workspace.svelte';
import { nav, traceReplayable } from './navRecording.svelte';
import { mapState } from './map.svelte';
import { rearmFollow, recenterNav } from '$lib/map/navLayer';
import { activeRoute } from './route.svelte';
import { visibleNotams } from './notam.svelte';
import { fitRoute } from '$lib/components/tabs/route/fitRoute';
import { fitToNotams } from '$lib/map/notamLayer';

/** A page's sections: the Segmented sub-header, in order, the first the
 *  default. The `key` names the label in t.tabs. */
export interface PageSection {
	id: string;
	key: keyof Messages['tabs'];
	/** Offered only while this holds, and absent otherwise, never disabled:
	 *  a launcher with nothing to launch. Reads reactive state. */
	offered?: () => boolean;
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
	// No Replay launcher: a replay rides the map whenever a trace is loaded
	// (state/replayStrip.svelte.ts), and the Map destination is the way back
	// to it, one door per destination.
	flight: [
		{ id: 'flight', key: 'flightSection' },
		{ id: 'alerts', key: 'alerts' },
		{ id: 'trace', key: 'trace' },
	],
	layers: [],
	settings: [],
};

/** The sections a page offers now, in order. Reads reactive state. */
export function offeredSections(page: PhonePage): PageSection[] {
	return PAGE_SECTIONS[page].filter((s) => s.offered?.() ?? true);
}

/** The section a page is on: the one it was left on, else its first. */
export function pageSection(page: PhonePage): string | null {
	return ui.pageSection[page] ?? PAGE_SECTIONS[page][0]?.id ?? null;
}

/** The replay on the map, on a phone: the strip is up on the loaded trace
 *  already (state/replayStrip.svelte.ts), so this makes room to read it. A
 *  pane maximised over the map steps down to a dock so there is a map to
 *  replay on, and follow, when on, comes back to the aircraft.
 *  `traceChanged`: a trace was loaded in this very tick, whose pose the map
 *  has not drawn yet (navLayer's lastPose still holds the old one), so
 *  follow is only re-armed and the aircraft effect centres it; else the
 *  recentre control's own action. Nothing on the desktop, where the
 *  workspace never covers the whole map. */
export function showReplayOnMap(traceChanged: boolean): void {
	if (!ui.isMobile || !traceReplayable()) {
		return;
	}
	const over = workspace.overlay;
	if (over !== null && placementOf(over) === 'page') {
		movePlacement(over, 'dock-bottom');
	}
	if (!nav.follow) {
		return;
	}
	if (traceChanged) {
		rearmFollow();
	} else if (mapState.map) {
		recenterNav(mapState.map);
	}
}

/** Put the replay on the map from wherever the pilot is, on a phone: a
 *  full-screen surface over it goes first (the flights library, a workbook;
 *  one that refuses, the aircraft editor's unsaved edits, stops it here),
 *  then the page, then showReplayOnMap. */
export function revealReplay(traceChanged: boolean): void {
	if (!ui.isMobile || !traceReplayable()) {
		return;
	}
	if (clearFullSurface() === 'refused') {
		return;
	}
	closePage();
	showReplayOnMap(traceChanged);
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
 *  About) to go, since the bar stays visible under it. `refused` is the
 *  aircraft editor's unsaved-edits confirm, and the tap then does nothing
 *  else; `closed` is a tap SPENT revealing what the surface covered, so the
 *  caller must not also toggle the destination underneath. The pane at its
 *  page detent is not one of these: a page covers it and Back brings it
 *  back. */
export function clearFullSurface(): 'none' | 'closed' | 'refused' {
	const overlay = workspace.overlay;
	if (overlay === null || overlay === 'detail') {
		return 'none';
	}
	const placement = placementOf(overlay);
	if (placement !== 'full' && placement !== 'dialog') {
		return 'none';
	}
	requestCloseSurface(overlay);
	return isOpen(overlay) ? 'refused' : 'closed';
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
