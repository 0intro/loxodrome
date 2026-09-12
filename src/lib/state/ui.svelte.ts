/* Global UI layout state: sidebar, active tab, detail panel, viewport size. */

/** THE mobile-layout criterion, defined once: narrow viewports (phones in
 *  portrait), plus touch devices whose viewport is short (phones in
 *  landscape, which are wider than any width breakpoint); landscape tablets
 *  and short desktop windows stay on the desktop layout. App.svelte watches
 *  it, drives `ui.isMobile` (the JS carrier) and stamps `mobile-ui` on
 *  <html> (the CSS carrier); style rules key off `:root.mobile-ui`, never
 *  their own media query, so the two can't drift. */
export const MOBILE_UI_MEDIA = '(max-width: 760px), ((pointer: coarse) and (max-height: 500px))';

export type SidebarTab =
	| 'notams'
	| 'airports'
	| 'route'
	| 'aircraft'
	| 'navigation'
	| 'weather'
	| 'layers'
	| 'settings';

/** What the right-side detail panel is showing. The airspace target carries
 *  a `key` (id|name) rather than a bare `id` so parent / exclusion sub-rings
 *  that share a designation each address their own panel row; see
 *  Airspace.key in src/lib/data/airspaces.ts. */
export type DetailTarget =
	| { kind: 'notam'; index: number; fromList?: boolean | undefined }
	| { kind: 'airport'; id: string }
	| { kind: 'airspace'; key: string }
	| { kind: 'obstacle'; id: string }
	| { kind: 'navaid'; id: string }
	| { kind: 'nature'; id: string }
	| { kind: 'supaip'; id: string; zone?: number | undefined }
	| { kind: 'sigmet'; id: string }
	| { kind: 'station'; id: string; lat: number; lon: number; name?: string | undefined };

export const ui = $state<{
	sidebarCollapsed: boolean;
	activeTab: SidebarTab;
	/** Mobile bottom-sheet open height, as a fraction of the workspace
	 *  (0..1; 1 == full screen over the map). The map-first "peek" state is
	 *  sidebarCollapsed:true; this is the height when open. Ignored on desktop. */
	sheetHeight: number;
	/** Mobile detail-sheet height, same convention as sheetHeight (the detail
	 *  panel is the second bottom sheet on phones; it opens at this height and
	 *  remembers the last rested drag). Ignored on desktop. */
	detailHeight: number;
	detail: DetailTarget | null;
	/** Previous detail target when navigating between linked panels (e.g.
	 *  airport → NOTAM). Drives the back arrow at the top of the panel. */
	detailBack: DetailTarget | null;
	/** Set while the current detail was opened FROM a vertical-profile modal
	 *  ('route' = the route profile, 'trace' = the navigation trace profile):
	 *  the panel's back arrow then reopens that modal (whose saved window
	 *  restores) instead of a previous detail. One-shot; every fresh
	 *  selection or linked navigation clears it. Deliberately not a
	 *  DetailTarget: a profile is a modal, never assignable to ui.detail. */
	detailFromProfile: 'route' | 'trace' | null;
	/** Index of the NOTAM whose Q-line radius circle is drawn on the map,
	 *  toggled from its detail panel (null = none). */
	qRadiusIndex: number | null;
	isMobile: boolean;
	/** Height (px) of the phone's bottom bar, i.e. the sidebar sheet at rest:
	 *  the grip over the tab rail. The workspace reserves it, so the stage
	 *  (and with it a bottom dock) ends above the bar rather than taking the
	 *  screen edge from it. Measured and published by Sidebar.svelte, as the
	 *  JS carrier of the --sheet-peek custom property; 0 on desktop. */
	sheetPeekPx: number;
}>({
	sidebarCollapsed: false,
	activeTab: 'route',
	sheetHeight: 0.5,
	detailHeight: 0.5,
	detail: null,
	detailBack: null,
	detailFromProfile: null,
	qRadiusIndex: null,
	isMobile: false,
	sheetPeekPx: 0,
});

/**
 * Select a sidebar tab. Clicking the already-active tab toggles the panel
 * closed; clicking any other tab opens the panel on that tab.
 */
export function selectTab(tab: SidebarTab): void {
	if (!ui.sidebarCollapsed && ui.activeTab === tab) {
		ui.sidebarCollapsed = true;
		return;
	}
	ui.activeTab = tab;
	ui.sidebarCollapsed = false;
}

/**
 * Show a sidebar tab, without selectTab's toggle: a result arriving from
 * elsewhere (a file opened from the system, state/openFile.svelte.ts) has to
 * put its tab up, and the tab it wants is often the one already active, where
 * the toggle would close the panel over the answer.
 */
export function showTab(tab: SidebarTab): void {
	ui.activeTab = tab;
	ui.sidebarCollapsed = false;
}

export function toggleSidebar(): void {
	ui.sidebarCollapsed = !ui.sidebarCollapsed;
}

/* Fresh selections (from the map or a list) clear any back history. */

export function selectNotam(index: number, fromList = false): void {
	ui.detail = { kind: 'notam', index, fromList };
	ui.detailBack = null;
	ui.detailFromProfile = null;
}

export function selectAirport(id: string): void {
	ui.detail = { kind: 'airport', id };
	ui.detailBack = null;
	ui.detailFromProfile = null;
}

export function selectAirspace(key: string): void {
	ui.detail = { kind: 'airspace', key };
	ui.detailBack = null;
	ui.detailFromProfile = null;
}

export function selectObstacle(id: string): void {
	ui.detail = { kind: 'obstacle', id };
	ui.detailBack = null;
	ui.detailFromProfile = null;
}

export function selectNavaid(id: string): void {
	ui.detail = { kind: 'navaid', id };
	ui.detailBack = null;
	ui.detailFromProfile = null;
}

export function selectNature(id: string): void {
	ui.detail = { kind: 'nature', id };
	ui.detailBack = null;
	ui.detailFromProfile = null;
}

export function selectSupaip(id: string, zone?: number): void {
	ui.detail = { kind: 'supaip', id, zone };
	ui.detailBack = null;
	ui.detailFromProfile = null;
}

export function selectSigmet(id: string): void {
	ui.detail = { kind: 'sigmet', id };
	ui.detailBack = null;
	ui.detailFromProfile = null;
}

/** A METAR station (ident + geometry). Carrying lat/lon/name keeps the panel
 *  able to centre the map and show coordinates even after the viewport tile
 *  cache evicts the station on a pan; the panel resolves the live METAR / TAF
 *  by ident. */
export function selectStation(s: {
	id: string;
	lat: number;
	lon: number;
	name?: string | undefined;
}): void {
	ui.detail = { kind: 'station', ...s };
	ui.detailBack = null;
	ui.detailFromProfile = null;
}

/* Navigation between linked panels; remembers the current detail as the back
 * target so the panel can show a "Back to …" arrow. */

export function navigateToNotam(index: number): void {
	const back = ui.detail;
	ui.detail = { kind: 'notam', index };
	ui.detailBack = back;
	ui.detailFromProfile = null;
}

export function navigateToAirport(id: string): void {
	const back = ui.detail;
	ui.detail = { kind: 'airport', id };
	ui.detailBack = back;
	ui.detailFromProfile = null;
}

export function navigateToAirspace(key: string): void {
	const back = ui.detail;
	ui.detail = { kind: 'airspace', key };
	ui.detailBack = back;
	ui.detailFromProfile = null;
}

export function navigateToObstacle(id: string): void {
	const back = ui.detail;
	ui.detail = { kind: 'obstacle', id };
	ui.detailBack = back;
	ui.detailFromProfile = null;
}

export function navigateToNavaid(id: string): void {
	const back = ui.detail;
	ui.detail = { kind: 'navaid', id };
	ui.detailBack = back;
	ui.detailFromProfile = null;
}

export function navigateToNature(id: string): void {
	const back = ui.detail;
	ui.detail = { kind: 'nature', id };
	ui.detailBack = back;
	ui.detailFromProfile = null;
}

export function navigateToSupaip(id: string, zone?: number): void {
	const back = ui.detail;
	ui.detail = { kind: 'supaip', id, zone };
	ui.detailBack = back;
	ui.detailFromProfile = null;
}

export function navigateToSigmet(id: string): void {
	const back = ui.detail;
	ui.detail = { kind: 'sigmet', id };
	ui.detailBack = back;
	ui.detailFromProfile = null;
}

export function goBack(): void {
	if (!ui.detailBack) {
		return;
	}
	ui.detail = ui.detailBack;
	ui.detailBack = null;
	ui.detailFromProfile = null;
}

/** Stamp the CURRENT detail as opened from a vertical-profile modal
 *  ('route' or 'trace'). Called by that modal right after its navigateTo* +
 *  close, so the panel's back arrow reopens the right modal. Drops any
 *  detail history: from a profile, the user's stack is profile → feature,
 *  not whatever panel lay under the modal. */
export function markDetailFromProfile(origin: 'route' | 'trace'): void {
	ui.detailBack = null;
	ui.detailFromProfile = origin;
}

export function closeDetail(): void {
	ui.detail = null;
	ui.detailBack = null;
	ui.detailFromProfile = null;
}

/** Toggle the on-map Q-line radius circle for one NOTAM (by index). The
 *  circle is drawn while that NOTAM is the open detail; see MapView. */
export function toggleNotamQRadius(index: number): void {
	ui.qRadiusIndex = ui.qRadiusIndex === index ? null : index;
}
