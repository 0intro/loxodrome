/* Cross-cutting UI strings: app chrome (toolbar, banner, panel controls),
 * shared atoms (modal close, sliders), and the language preference itself.
 * Keys are alphabetized; the French mirror is ../fr/common.ts. */

export const common = {
	aboutApp: 'About this app',
	airacSwitch: 'A new AIRAC cycle is now effective. Reload to load it.',
	// The BETA badge itself is invariant (it renders as a literal beside the
	// wordmark); only what it means is translated.
	betaTip: (version: string) =>
		`Loxodrome ${version}, beta release: the application is still under development.`,
	cancel: 'Cancel',
	ok: 'OK',
	understood: 'Understood',
	centerMap: 'Center the map on this item',
	centerMapAria: 'Center map on selected item',
	close: 'Close',
	closeDetail: 'Close detail panel',
	// The build's datasets are a whole AIRAC cycle behind their newest slot
	// (AiracBanner, src/lib/data/airacValidity.ts). The date is the ISO day.
	dataExpired: (p: { date: string }) =>
		`The aeronautical data in this version expired on ${p.date}. Update the application for the AIRAC cycle in force.`,
	// A dataset whose read failed and is being read again
	// (state/dataRetry.svelte.ts). `what` is the groups below, each followed
	// by its missing publishers in brackets (format/dataRetry.ts).
	dataRetry: (p: { what: string }) => `Some aeronautical data did not load: ${p.what}. Retrying.`,
	dataRetryGroups: {
		airports: 'airports',
		airspaces: 'airspaces',
		obstacles: 'obstacles',
		navaids: 'navaids',
		nature: 'parks and nature reserves',
		supaip: 'SUP AIP',
		charts: 'aerodrome charts',
		facilities: 'aerodrome data',
		fuel: 'aerodrome fuel',
		vacgeo: 'VAC panels',
		metarStations: 'METAR stations',
		designators: 'aircraft type designators',
		aircraft: 'aircraft library',
	},
	discardChanges: 'Discard unsaved changes?',
	discardChangesAction: 'Discard',
	dismiss: 'Dismiss',
	dismissMenu: 'Dismiss menu',
	dockBottom: 'Dock below the map',
	dockRight: 'Dock beside the map',
	enterFullScreen: 'Enter full screen',
	exitFullScreen: 'Exit full screen',
	exportPdf: 'Export map to PDF',
	fitMap: 'Fit map to NOTAMs',
	flightMenu: 'Flight',
	fullScreen: 'Full screen',
	langEnglish: 'English',
	langFrench: 'Français',
	langStatus: 'Language: English',
	langSwitch: 'Switch language to français',
	lowerBound: 'Lower bound',
	months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
	more: 'More options',
	next: 'Next',
	nextNotam: 'Next NOTAM',
	openFileFailed: (name: string) => `Could not open ${name}.`,
	openFileUnknownName: 'this file',
	openFileUnsupported: (name: string) => `Loxodrome cannot read ${name}.`,
	/* A trace file arriving while a flight is recorded (state/openFile): it
	   would replace the trace being recorded, so the pilot stops first. */
	openFileWhileRecording: (name: string) => `Stop the flight before opening ${name}.`,
	pagePlacement: 'Fill the map area',
	panWindow: 'Pan the window',
	placement: 'Panel placement',
	prev: 'Prev',
	prevNotam: 'Previous NOTAM',
	reload: 'Reload',
	retryNow: 'Retry now',
	resizeDetail: 'Resize detail panel',
	resizePanel: 'Resize panel',
	paneDetent: 'Pane size',
	appMenu: 'Menu',
	back: 'Back',
	navBar: 'Main navigation',
	paneDetentTip: 'Tap for half or full height, drag to resize',
	/* Landscape: the same handle cycles the two WIDTHS, the pane being a
	   side dock there. */
	paneDetentTipWide: 'Tap for a narrow or wide pane, drag to resize',
	resizePanelTip: 'Drag to resize, double-click to reset',
	resizeSidebar: 'Resize sidebar',
	sidebarTabs: 'Sidebar tabs',
	stepThroughList: 'Step through NOTAM list',
	themeToDay: 'Switch to day theme',
	themeToNight: 'Switch to night theme',
	themeToggle: 'Toggle day / night theme',
	toggleSidebar: 'Toggle sidebar',
	updateApp: 'Update',
	updateReady: 'A new version is available.',
	upperBound: 'Upper bound',
};
