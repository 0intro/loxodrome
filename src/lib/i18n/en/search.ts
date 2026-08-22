/* Airport search tab, plus the Ctrl+K search palette. Row subtitles are
 * dataset passthrough (ident, IATA, type, place); the NOTAM-count badge
 * reuses map.notamCount. */

export const search = {
	hint: 'Search airports by ICAO, IATA, name, or city.',
	loadError: (err: string) => `Could not load airports: ${err}`,
	loading: 'Loading airports…',
	noMatches: 'No airport matches your search.',
	palette: {
		actions: 'Actions',
		airports: 'Airports',
		chartHidden: 'Chart hidden',
		chartShown: 'Chart shown',
		hint: 'Search for an aerodrome, a navaid, a NOTAM or an action.',
		loading: 'Loading aeronautical data…',
		moreAirports: (n: number) => `${n} more in the Airports tab…`,
		navaids: 'Navaids & waypoints',
		noMatches: 'No matches.',
		notams: 'NOTAMs',
		placeholder: 'ICAO, navaid, NOTAM or action…',
		surfaceOnScreen: 'On screen',
		title: 'Search',
	},
	placeholder: 'ICAO, IATA, name or city…',
	showingMatches: (p: { shown: number; total: number }) =>
		`Showing ${p.shown} of ${p.total} matches.`,
	title: 'Airport search',
};
