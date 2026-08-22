/* NOTAM loader (the NOTAMs tab's empty-state launcher and head load
 * overlay): the three signposted rows, paste / upload actions, the
 * autorouter viewport fetch (coverage summary). Fetch error thunks live in
 * ./errors. SOFIA-Briefing and autorouter are product names, identical in
 * both catalogs. */

import { plural } from './plural';

export const input = {
	backToList: 'Back to the NOTAM list',
	autorouterLink: 'autorouter ↗',
	autorouterLinkTip: 'Open autorouter.aero in a new tab',
	clear: 'Clear',
	covEmpty: 'No airports or FIRs in view; pan to a populated region.',
	covFirOnly: 'FIR-only coverage; no CTRs / SUA / class polygons for this region.',
	covInView: (p: { a: number; f: number }) =>
		`${p.a} ${plural(p.a, 'airport', 'airports')} + ${p.f} ${plural(p.f, 'FIR', 'FIRs')} in view.`,
	covLoading: 'Loading datasets…',
	covOverCap: (max: number) =>
		`Only the closest ${max} airports will be queried (each can return multiple NOTAMs; FIRs are always included).`,
	covSkipped: (n: number) => `${n} ${plural(n, 'airport', 'airports')} skipped (no ICAO assigned).`,
	covViewportTooLarge: (max: number) => `Viewport too large; zoom in to ${max}° or less per side.`,
	displayOnMap: 'Display on map',
	fetchTipReady: 'Fetch NOTAMs for the airports and FIRs currently in view',
	fetched: (p: { n: number; time: string }) =>
		`${p.n} ${plural(p.n, 'NOTAM', 'NOTAMs')} fetched at ${p.time}.`,
	fetching: 'Fetching…',
	periodNotCovered: (p: { until: string }) => `This briefing only covers up to ${p.until}.`,
	periodNotCoveredTip:
		'A route briefing covers about 24 hours from the start of the period it was fetched for, while the period you are viewing runs past that. NOTAMs taking effect after this instant were never fetched. Fetch again with the period set to the later part to brief it.',
	launchFetch: 'Fetch this view',
	launchFetchDesc: 'Ask autorouter for the NOTAMs of the aerodromes and FIRs in view.',
	launchPaste: 'Paste or open a file',
	launchRoute: 'Route briefing',
	launchRouteDesc: 'Draw a route on the Route tab and fetch the NOTAMs along its corridor.',
	load: 'Load NOTAMs',
	paste: 'Paste',
	pastePlaceholder: 'Paste NOTAMs here, directly from SOFIA-Briefing or autorouter.',
	plotted: (n: number) => `${n} ${plural(n, 'NOTAM', 'NOTAMs')} plotted.`,
	sofiaLink: 'SOFIA-Briefing ↗',
	sofiaLinkTip: 'Open SOFIA-Briefing (French SIA) in a new tab; copy a briefing, then Paste here',
	upload: 'Upload',
};
