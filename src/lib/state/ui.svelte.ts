/* Global UI layout state: sidebar, active tab, detail panel, viewport size. */

/** A viewport this narrow lays out as a phone: a phone held upright, a
 *  narrow desktop window. */
export const PHONE_WIDTH_MEDIA = '(max-width: 760px)';

/** The longest short side of a phone's screen, in CSS px. */
export const PHONE_SCREEN_PX = 500;

/** What the layout criterion reads, in CSS px. `layoutFacts` reads them
 *  from the window. */
export interface LayoutFacts {
	/** PHONE_WIDTH_MEDIA matches. */
	narrow: boolean;
	/** The primary pointer is coarse. */
	coarse: boolean;
	screenW: number;
	screenH: number;
	/** The viewport's width. */
	width: number;
}

/** THE mobile-layout criterion, defined once. A PHONE is a coarse pointer
 *  on a screen whose short side is at most PHONE_SCREEN_PX, laid out as a
 *  phone whichever way it is held, and turned sideways while the viewport
 *  is wider than that short side: the bar becomes a rail on the left and
 *  the pane a right dock. A narrow viewport lays out as a phone too.
 *  Landscape tablets and short desktop windows keep the desktop layout.
 *
 *  It reads widths and the screen, never the viewport's height, which the
 *  soft keyboard takes: in Chrome on the 393 x 873 Redmi it leaves 416 px
 *  upright and 102 px sideways. The short side is the same either way up,
 *  so a turn reads true whichever of its events comes first.
 *
 *  Each App runs it on `watchLayout`, drives `ui.isMobile` and
 *  `ui.isLandscapePhone` (the JS carriers) and stamps `mobile-ui` and
 *  `mobile-landscape` on <html> (the CSS carriers). Style rules key off
 *  those classes, never a media query of their own, so the two can't
 *  drift. */
export function phoneLayout(f: LayoutFacts): { mobile: boolean; landscape: boolean } {
	const short = Math.min(f.screenW, f.screenH);
	const phone = f.coarse && short <= PHONE_SCREEN_PX;
	return { mobile: f.narrow || phone, landscape: phone && f.width > short };
}

/** The facts as the window states them now. */
export function layoutFacts(): LayoutFacts {
	return {
		narrow: window.matchMedia(PHONE_WIDTH_MEDIA).matches,
		coarse: window.matchMedia('(pointer: coarse)').matches,
		screenW: screen.width,
		screenH: screen.height,
		width: document.documentElement.clientWidth,
	};
}

/** Call `fn` on every change that can move the layout: a resize, a turn
 *  being one, or a pointer of another kind. Returns the unwatch. */
export function watchLayout(fn: () => void): () => void {
	const coarse = window.matchMedia('(pointer: coarse)');
	window.addEventListener('resize', fn);
	coarse.addEventListener('change', fn);
	return () => {
		window.removeEventListener('resize', fn);
		coarse.removeEventListener('change', fn);
	};
}

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
			// Named, like every other: without a section the page comes up on
			// whichever one was last used. Its callers raise it for a trace
			// file (state/openFile), so the Trace section: the trace a
			// replace confirm is about, and the receipt of one that arrived.
			return { page: 'flight', section: 'trace' };
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
	| { kind: 'station'; id: string; lat: number; lon: number; name?: string | undefined }
	| PlaceTarget;

/** A place the search went to: a town, or a bare position typed as
 *  coordinates (no name). Its data rides in the target, as a station's
 *  does, so the panel needs no dataset to stand: `admin` is the
 *  département or region as published, `country` the ISO code, `commune`
 *  set for a French commune. The id is the place's own (`fr:91223`), or
 *  `pt:<lat>,<lon>` for a position. */
export interface PlaceTarget {
	kind: 'place';
	id: string;
	lat: number;
	lon: number;
	name?: string | undefined;
	admin?: string | undefined;
	country?: string | undefined;
	pop?: number | null | undefined;
	commune?: boolean | undefined;
}

/** How a detail panel gets back to whatever opened it, when that was a
 *  surface rather than another detail. The label is a thunk so a locale
 *  switch re-renders it (docs/i18n.md rule 7): the stamp happens at click
 *  time, and a captured string would freeze the language of that click. */
export interface DetailReturn {
	label: () => string;
	reopen: () => void;
}

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
	/** Set while the current detail was opened FROM a surface the back arrow
	 *  should REOPEN, rather than from a previous detail: the two are mutually
	 *  exclusive. One-shot; every fresh selection or linked navigation clears
	 *  it. Deliberately not a DetailTarget, and deliberately a closure: which
	 *  surfaces exist is the app's business, not the panel's. */
	detailReturn: DetailReturn | null;
	/** Index of the NOTAM whose Q-line radius circle is drawn on the map,
	 *  toggled from its detail panel (null = none). */
	qRadiusIndex: number | null;
	isMobile: boolean;
	/** A phone held sideways (`phoneLayout`): the bar becomes a rail on the
	 *  left and the pane a right dock. Stamped by each App beside isMobile,
	 *  and false on the desktop layout. */
	isLandscapePhone: boolean;
	/** The :root.touch-ui class's JS carrier, stamped by each App beside the
	 *  class from the same criterion (Loxodrome: a coarse pointer or a
	 *  recording; the NOTAM Viewer: a coarse pointer), for the one rule CSS
	 *  cannot hold: a chart's column width, which is computed. */
	touchUi: boolean;
}>({
	sidebarCollapsed: false,
	activeTab: 'route',
	page: null,
	pageSection: {},
	detail: null,
	detailBack: null,
	detailReturn: null,
	qRadiusIndex: null,
	isMobile: false,
	isLandscapePhone: false,
	touchUi: false,
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
	ui.detailReturn = null;
}

export function selectAirport(id: string): void {
	ui.detail = { kind: 'airport', id };
	ui.detailBack = null;
	ui.detailReturn = null;
}

export function selectAirspace(key: string): void {
	ui.detail = { kind: 'airspace', key };
	ui.detailBack = null;
	ui.detailReturn = null;
}

export function selectObstacle(id: string): void {
	ui.detail = { kind: 'obstacle', id };
	ui.detailBack = null;
	ui.detailReturn = null;
}

export function selectNavaid(id: string): void {
	ui.detail = { kind: 'navaid', id };
	ui.detailBack = null;
	ui.detailReturn = null;
}

export function selectNature(id: string): void {
	ui.detail = { kind: 'nature', id };
	ui.detailBack = null;
	ui.detailReturn = null;
}

export function selectSupaip(id: string, zone?: number): void {
	ui.detail = { kind: 'supaip', id, zone };
	ui.detailBack = null;
	ui.detailReturn = null;
}

export function selectSigmet(id: string): void {
	ui.detail = { kind: 'sigmet', id };
	ui.detailBack = null;
	ui.detailReturn = null;
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
	ui.detailReturn = null;
}

/** A place (PlaceTarget): a fresh selection like a station's, with nothing
 *  to load. */
export function selectPlace(p: Omit<PlaceTarget, 'kind'>): void {
	ui.detail = { kind: 'place', ...p };
	ui.detailBack = null;
	ui.detailReturn = null;
}

/** A position typed as coordinates, as a place: its id says where. */
export function positionPlace(lat: number, lon: number): Omit<PlaceTarget, 'kind'> {
	return { id: `pt:${lat.toFixed(5)},${lon.toFixed(5)}`, lat, lon };
}

export function selectedPlace(): PlaceTarget | null {
	return ui.detail?.kind === 'place' ? ui.detail : null;
}

/* Navigation between linked panels; remembers the current detail as the back
 * target so the panel can show a "Back to …" arrow. */

export function navigateToNotam(index: number): void {
	const back = ui.detail;
	ui.detail = { kind: 'notam', index };
	ui.detailBack = back;
	ui.detailReturn = null;
}

export function navigateToAirport(id: string): void {
	const back = ui.detail;
	ui.detail = { kind: 'airport', id };
	ui.detailBack = back;
	ui.detailReturn = null;
}

export function navigateToAirspace(key: string): void {
	const back = ui.detail;
	ui.detail = { kind: 'airspace', key };
	ui.detailBack = back;
	ui.detailReturn = null;
}

export function navigateToObstacle(id: string): void {
	const back = ui.detail;
	ui.detail = { kind: 'obstacle', id };
	ui.detailBack = back;
	ui.detailReturn = null;
}

export function navigateToNavaid(id: string): void {
	const back = ui.detail;
	ui.detail = { kind: 'navaid', id };
	ui.detailBack = back;
	ui.detailReturn = null;
}

export function navigateToNature(id: string): void {
	const back = ui.detail;
	ui.detail = { kind: 'nature', id };
	ui.detailBack = back;
	ui.detailReturn = null;
}

export function navigateToSupaip(id: string, zone?: number): void {
	const back = ui.detail;
	ui.detail = { kind: 'supaip', id, zone };
	ui.detailBack = back;
	ui.detailReturn = null;
}

export function navigateToSigmet(id: string): void {
	const back = ui.detail;
	ui.detail = { kind: 'sigmet', id };
	ui.detailBack = back;
	ui.detailReturn = null;
}

export function goBack(): void {
	if (!ui.detailBack) {
		return;
	}
	ui.detail = ui.detailBack;
	ui.detailBack = null;
	ui.detailReturn = null;
}

/** Stamp the CURRENT detail as opened from a surface, which supplies its own
 *  back label and its own way of reopening itself. Called by that surface
 *  right after its navigateTo* + close. Drops any detail history: from a
 *  surface, the user's stack is surface → feature, not whatever panel lay
 *  under it. */
export function markDetailReturn(to: DetailReturn): void {
	ui.detailBack = null;
	ui.detailReturn = to;
}

export function closeDetail(): void {
	ui.detail = null;
	ui.detailBack = null;
	ui.detailReturn = null;
}

/** Toggle the on-map Q-line radius circle for one NOTAM (by index). The
 *  circle is drawn while that NOTAM is the open detail; see MapView. */
export function toggleNotamQRadius(index: number): void {
	ui.qRadiusIndex = ui.qRadiusIndex === index ? null : index;
}
