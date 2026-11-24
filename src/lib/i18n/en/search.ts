/* Airport search tab, plus the Ctrl+K search palette. Row subtitles are
 * dataset passthrough (ident, IATA, type, place); the NOTAM-count badge
 * reuses map.notamCount. */

import { plural } from './plural';

export const search = {
	hint: 'Search airports by ICAO, IATA, name, or town. The nearest come first.',
	/* The Airports page's Nearest section (nav/nearest.ts): the diversion
	   list read from the position. */
	nearest: 'Nearest aerodromes',
	nearestHint: (nm: number) =>
		`Aerodromes within ${nm} NM of the aircraft, nearest first, with the frequency to call and the longest runway.`,
	nearestNoPose: 'No position yet: start a flight, or replay a trace, to list the aerodromes around the aircraft.',
	nearestNone: (nm: number) => `No aerodrome within ${nm} NM.`,
	/* The Airports tab's group for a town the query names, the town a link
	   after it. */
	nearestTown: 'Nearest aerodromes:',
	loadError: (err: string) => `Could not load airports: ${err}`,
	loading: 'Loading airports…',
	noMatches: 'No airport matches your search.',
	otherMatches: 'Other matches',
	palette: {
		actions: 'Actions',
		airports: 'Airports',
		airspaces: 'Airspaces',
		chartHidden: 'Chart hidden',
		chartShown: 'Chart shown',
		countries: 'Countries',
		countryAerodromes: (count: string, n: number) => `${count} ${plural(n, 'aerodrome', 'aerodromes')}`,
		hint: 'Search for an aerodrome, a navaid, an airspace, a town, a position, a country, a NOTAM or an action.',
		loading: 'Loading aeronautical data…',
		moreAirports: (n: number) => `${n} more in the Airports tab…`,
		navaids: 'Navaids & waypoints',
		noMatches: 'No matches.',
		notams: 'NOTAMs',
		outsidePeriod: 'Outside the period',
		placeholder: 'ICAO, navaid, town, airspace, coordinates or NOTAM…',
		position: 'Position',
		scopeAll: 'Searched in full: every country with national data.',
		scopeNone: 'Aerodromes only, from the worldwide list.',
		scopeSome: (names: string) => `Searched in full: ${names}. Elsewhere, aerodromes only.`,
		searchAll: 'Search all countries',
		searchAllLoading: 'Loading every country…',
		searchAllTip: 'Loads every country’s navaids, aerodromes and towns, about three megabytes',
		surfaceOnScreen: 'On screen',
		towns: 'Towns',
		title: 'Search',
	},
	fuelFilter: 'Fuel',
	fuelFilterTip:
		'Show only aerodromes that publish this grade. France only, the one AIP that states it.',
	placeholder: 'ICAO, IATA, name or town…',
	showingMatches: (p: { shown: number; total: number }) =>
		`Showing ${p.shown} of ${p.total} matches.`,
	title: 'Airport search',
};
