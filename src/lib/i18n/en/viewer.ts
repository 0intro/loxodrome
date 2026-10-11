/* The NOTAM Viewer's own chrome (loxodrome.fr/notam): the aerodrome briefing
 * box and the shell's controls. Everything the app shares with Loxodrome, the
 * list, the panels, the filters and the viewing conditions, reads the catalogs
 * those already have; only what this app alone says lives here.
 *
 * SOFIA-Briefing and autorouter are product names, identical in both
 * catalogs, and so is Loxodrome, the sibling application this one is built
 * from and points at. */

export const viewer = {
	aerodromes: 'Aerodromes',
	fetchBriefing: 'Fetch briefing',
	pasteRefused:
		'The browser would not let the page read the clipboard. Paste into the box instead: long press it, then Paste.',
	fetchBriefingTip: 'Ask the briefing service for the NOTAMs of these aerodromes',
	// The About surface. Short by design: this app ships the NOTAM half's data
	// and nothing else, and crediting what it does not carry would be untrue
	// rather than generous (src/notam/AboutSurface.svelte).
	aboutWhat:
		'NOTAM Viewer draws a NOTAM briefing on an aeronautical chart. Paste one, open a file or fetch one for a list of aerodromes, and each NOTAM shows against the airspaces, aerodromes and AIP supplements it concerns.',
	// The two sources that are not a national AIS and must not read as one.
	aboutBaselineBody:
		'The worldwide aerodrome baseline underneath is OurAirports, public domain, which asks for credit without requiring it. FIRs that no national AIP publishes come from EUROCONTROL’s pruatlas, under GPL-2 or MIT.',
	aboutSourceHeading: 'Open source',
	aboutSourceBody:
		'NOTAM Viewer is free and open source, under the MIT licence. It runs in your browser, keeps its settings there and has no account. A briefing you paste or open never leaves the device. At loxodrome.fr/notam the page and its data come from GitHub Pages through Cloudflare, which see each request. At notam-viewer.net they come through a Cloudflare Worker run by the author. Cloudflare keeps each request to it for 7 days, where the author can read it: the address, the request headers with your IP address, and the approximate location derived from it. Both addresses ask browsers that support Network Error Logging to report failed connections to Cloudflare.',
	// The national services only: Italy's data is open flightmaps community
	// data, and its row in the list under this sentence says so.
	aboutAipBody: (p: { publishers: string }) =>
		`Airspaces, aerodromes and AIP supplements come from the national aeronautical information services of ${p.publishers}. They are redrawn to the ICAO and SIA chart conventions, under the terms each source states below. The activity pictograms are the SIA\u2019s own, traced from its 1:500 000 legend (Légende 2026) and its 1:250 000 chart, under the Licence Ouverte.`,
	aboutAdChartsBody:
		'The aerodrome panel links each aerodrome to its charts on the publisher’s own site, through the catalogs below. Nothing is copied.',
	aboutNotamBody:
		'NOTAMs come from SOFIA-Briefing, the French AIS, or autorouter, which reads EUROCONTROL’s EAD, as you choose, for a list of aerodromes or one aerodrome from its panel. They pass through proxy.loxodrome.fr, the author’s relay. It sees the aerodromes asked for and your IP address, limits requests per address, passes on the query alone and logs only its failures.',
	// The two sources this app fetches beyond its own datasets and its
	// briefing service. Both were measured rather than remembered: an
	// aerodrome click makes two /wx calls and a terrain read, from an app
	// that credited neither (src/notam/datasets.ts VIEWER_LIVE_SOURCES).
	aboutWeatherBody:
		'The aerodrome panel shows METAR and TAF, the field’s or those of nearby stations, from the NOAA Aviation Weather Center through the same relay. US Government public domain. Live weather, in Settings, turns it off, but not the base map or the terrain below.',
	aboutTerrainBody:
		'The altitude profile draws the ground from an elevation mosaic built for Loxodrome out of the public models below, each quoted as its licence requires. Its tiles come from charts.loxodrome.fr, the author’s chart server, which keeps no log. Only models that allow re-serving are used.',
	aboutBaseMapHeading: 'Base map',
	aboutBaseMapBody:
		'The map is drawn from one of these tile services, chosen in Map layers and fetched directly by your browser, under its own terms.',
	aboutLibrariesBody: 'Each line opens its licence notice.',
	aboutLicenseMissing: 'This notice could not be loaded.',
	sourceLegend: 'Briefing source',
	// The night-dim slider's tip. The slider means what Loxodrome's does, and
	// its label stays the shared t.display one, but the shared TIP also says
	// that recording past civil twilight turns the night theme on, and this
	// app records nothing.
	nightDimTip:
		'Brightness of the map raster in the night theme. The symbology keeps full contrast.',
	// The phone bar's third destination. SHORT: three labels share a 392 px
	// bar, and the full "Load NOTAMs" the head button uses does not fit. It is
	// a destination of its own there because the head's icon is not a door a
	// reader who came for a paste box will find, which is the whole audience
	// this app is for.
	barLoad: 'Load',
	restoreConfirm:
		'Restore this viewer’s settings to their defaults? The languages and the theme, the map layers, the NOTAM markers and filters, the look-ahead and the level band, the briefing source, live weather, the vertical profiles, night dimming and the panel layout go back to their defaults. The loaded briefing is kept.',
	// Shown on loxodrome.fr/notam only, where the two apps share their
	// storage. The map layers are the one exception: this app never writes
	// Loxodrome's layers document.
	restoreShared:
		'Loxodrome, on the same site, reads these settings too, the map layers excepted: they are restored there as well.',
	// The one cross-reference to the sibling application, and the only one that
	// outlives a loaded briefing. The bar states the DESTINATION and nothing
	// else; what the relationship is lives in the loader's card, one screen
	// down, where there is room to say it properly. Identical in both
	// catalogs, being a product name and the arrow this app already spells
	// "opens in a new tab" (input.ts's SOFIA / autorouter links).
	siblingBadge: 'Loxodrome \u2197',
	siblingBadgeTip:
		'Loxodrome, flight preparation and in-flight navigation. Opens in a new tab.',
	siblingBody:
		'This viewer is the NOTAM half of Loxodrome, the flight-preparation and in-flight navigation application built from the same source. Loxodrome adds routes, navigation logs, the fuel plan, mass and balance, takeoff and landing distances, the weather and a map that follows the aircraft, in a browser or on Android.',
	siblingLink: 'Open Loxodrome',
	unknownIdents: (p: { words: string }) =>
		`Not ICAO aerodrome idents, so they were left out: ${p.words}.`,
};
