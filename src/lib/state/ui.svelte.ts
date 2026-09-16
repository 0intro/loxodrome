/* Global UI layout state: sidebar, active tab, detail panel, viewport size. */

/** THE mobile-layout criterion, defined once: narrow viewports (phones in
 *  portrait), plus touch devices whose viewport is short (phones in
 *  landscape, which are wider than any width breakpoint); landscape tablets
 *  and short desktop windows stay on the desktop layout. App.svelte watches
 *  it, drives `ui.isMobile` (the JS carrier) and stamps `mobile-ui` on
 *  <html> (the CSS carrier); style rules key off `:root.mobile-ui`, never
 *  their own media query, so the two can't drift. */
export const MOBILE_UI_MEDIA = '(max-width: 760px), ((pointer: coarse) and (max-height: 500px))';

/** The second clause alone: a phone held sideways, which keeps the mobile
 *  layout but turns its bar into a rail and its pane into a right dock. Named
 *  once so the two media queries cannot drift apart. */
export const PHONE_LANDSCAPE_MEDIA = '(pointer: coarse) and (max-height: 500px)';

export type SidebarTab =
	| 'notams'
	| 'airports'
	| 'route'
	| 'aircraft'
	| 'navigation'
	| 'weather'
	| 'layers'
	| 'settings';

/** The phone's full-screen PAGES (docs/workspace-surfaces.md "Phones"):
 *  everything that is not read against the map. The bar's four content
 *  destinations, plus the two the layers button and the app menu reach. A
 *  page is a fixed container over the stage with the bar still visible;
 *  the pane (the workspace's dock slot) lives on under it and comes back
 *  on Back. Not a workspace surface on purpose: a surface `page` evicts the
 *  docks, and a phone page must not. */
export type PhonePage = 'airports' | 'brief' | 'plan' | 'flight' | 'layers' | 'settings';

/** The page and section a desktop tab maps onto: the one branch the
 *  select* entry points take on a phone, so every caller of showTab /
 *  selectTab (a file import raising its tab, a loader linking to the route)
 *  lands on the right page without knowing the layout. */
export function pageOf(tab: SidebarTab): { page: PhonePage; section?: string } {
	switch (tab) {
		case 'notams':
			return { page: 'brief', section: 'notams' };
		case 'weather':
			return { page: 'brief', section: 'weather' };
		case 'route':
			return { page: 'plan', section: 'route' };
		case 'aircraft':
			return { page: 'plan', section: 'aircraft' };
		case 'navigation':
			return { page: 'flight' };
		case 'airports':
			return { page: 'airports', section: 'search' };
		case 'layers':
			return { page: 'layers' };
		case 'settings':
			return { page: 'settings' };
	}
}

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
	/** Desktop: the sidebar panel folded to its rail. Ignored on phones. */
	sidebarCollapsed: boolean;
	/** Desktop: the sidebar tab. On phones the pages carry the content and
	 *  this only remembers the last desktop choice. */
	activeTab: SidebarTab;
	/** The phone page up, null on the map. Ignored on desktop. */
	page: PhonePage | null;
	/** The section each page was left on (its Segmented sub-header), so a
	 *  page comes back where it was (EASA AMC1 SPA.EFB.100(b)(2): a view
	 *  returns in the state it was left). */
	pageSection: Partial<Record<PhonePage, string>>;
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
	/** A phone held sideways (PHONE_LANDSCAPE_MEDIA): the bar becomes a
	 *  rail on the left and the pane a right dock. Stamped by App.svelte
	 *  beside isMobile; always false on desktop. */
	isLandscapePhone: boolean;
}>({
	sidebarCollapsed: false,
	activeTab: 'route',
	page: null,
	pageSection: {},
	detail: null,
	detailBack: null,
	detailFromProfile: null,
	qRadiusIndex: null,
	isMobile: false,
	isLandscapePhone: false,
});

/** Open a phone page, on a section when one is named (else the section it
 *  was left on, else its first). */
export function openPage(page: PhonePage, section?: string): void {
	ui.page = page;
	if (section !== undefined) {
		ui.pageSection[page] = section;
	}
}

/** Back to the map (the pane, if one is up, is still there underneath). */
export function closePage(): void {
	ui.page = null;
}

/** What a row tap that flies the map wants: the map in view. On a phone
 *  that is the page out of the way (the pane stays: the row's own subject
 *  is about to open in it); the desktop's panel already sits beside the
 *  map, so nothing moves there. */
export function revealMap(): void {
	if (ui.isMobile) {
		closePage();
	}
}

/**
 * Select a sidebar tab. Clicking the already-active tab toggles the panel
 * closed; clicking any other tab opens the panel on that tab. On a phone
 * the tab is a page (pageOf), with the same toggle on its bar destination.
 */
export function selectTab(tab: SidebarTab): void {
	if (ui.isMobile) {
		const { page, section } = pageOf(tab);
		if (ui.page === page && (section === undefined || ui.pageSection[page] === section)) {
			closePage();
		} else {
			openPage(page, section);
		}
		return;
	}
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
	if (ui.isMobile) {
		const { page, section } = pageOf(tab);
		openPage(page, section);
		return;
	}
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
