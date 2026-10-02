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
		'A NOTAM briefing on an aeronautical chart. Paste one, open a file, or fetch one for a list of aerodromes, add an aerodrome’s own from its panel, and see every NOTAM against the airspaces, aerodromes and AIP supplements it concerns.',
	// The two sources that are not a national AIS and must not read as one.
	aboutBaselineBody:
		'The worldwide aerodrome baseline underneath them is OurAirports: public domain, and OurAirports asks for credit without requiring it. FIR boundaries where a national AIP publishes none come from EUROCONTROL\u2019s pruatlas, under GPL-2 or MIT.',
	aboutSourceHeading: 'Open source',
	aboutSourceBody:
		'Free and open source under the MIT licence, built from the same source as Loxodrome. It runs entirely in your browser: there is no account, nothing is uploaded, and no briefing you load leaves the device except as the request that fetched it. Reached at loxodrome.fr/notam, the page and its data files come from GitHub Pages through Cloudflare\u2019s network, which see each request as any web host would. Reached at notam-viewer.net, the page comes through a Cloudflare Worker run by the author, and each request to it is kept for 7 days in Cloudflare\u2019s request log, which the author can read: the address requested, the request headers with your IP address among them, and the approximate location Cloudflare derives from that address. Both addresses ask browsers that implement Network Error Logging, Chromium-based ones among them, to report to Cloudflare a connection that fails.',
	// The national services only: Italy's data is open flightmaps community
	// data, and its row in the list under this sentence says so.
	aboutAipBody: (p: { publishers: string }) =>
		`Airspaces, aerodromes and AIP supplements are published by the national aeronautical information services of ${p.publishers}, and are redrawn here to the ICAO and SIA chart conventions under the terms each source states, listed below. The activity pictograms and obstacle symbols are the SIA\u2019s own, traced from its 1:500 000 legend (Légende 2026) and its 1:250 000 chart under the Licence Ouverte. Each dataset carries the AIRAC cycle its publisher stated.`,
	aboutAdChartsBody:
		'The aerodrome panel links each field to its charts at their own publisher, through the catalogs below: they keep only where each publisher files its charts, which open on the publisher\u2019s site.',
	aboutNotamBody:
		'NOTAMs come from SOFIA-Briefing, the French AIS, or from autorouter, which aggregates EUROCONTROL’s EAD, whichever you pick, for a list of aerodromes or for one aerodrome from its panel. A pasted or opened briefing comes from wherever you got it. The requests go through proxy.loxodrome.fr, a relay run by the author that adds nothing to the NOTAMs: it sees the aerodrome idents or the route asked for and your IP address, applies a per-IP rate limit and logs only its own failures, never the request body and never the address it came from.',
	// The two sources this app fetches beyond its own datasets and its
	// briefing service. Both were measured rather than remembered: an
	// aerodrome click makes two /wx calls and a terrain read, from an app
	// that credited neither (src/notam/datasets.ts VIEWER_LIVE_SOURCES).
	aboutWeatherBody:
		'The aerodrome panel shows the field\u2019s own METAR and TAF, or the METARs of the stations around it when it has none, from the NOAA Aviation Weather Center through the same relay as the briefings. US Government public domain. The Settings panel turns it off. The base map and the elevation mosaic below are fetched as they are drawn, and that switch does not cover them.',
	aboutTerrainBody:
		'The altitude profile draws the ground under the point it is taken at, read from an elevation mosaic built for Loxodrome out of the public models below. Each is redistributed under its own licence, quoted here as that licence requires. No model whose terms forbid re-serving is used.',
	aboutBaseMapHeading: 'Base map',
	aboutBaseMapBody:
		'The map under the NOTAMs is drawn from one of these tile services, whichever the Layers popover is set to. Each is fetched directly by your browser and carries its own terms.',
	aboutLibrariesBody: 'Tap one to read its notice.',
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
		'This viewer is the NOTAM half of Loxodrome, the flight-preparation and in-flight navigation application it is built from. The same chart and the same briefing, plus routes and navigation logs, the fuel plan, mass and balance, takeoff and landing distances, the weather, and a map that follows the GPS in the cockpit. Free and open source, it runs in the browser and needs no account.',
	siblingLink: 'Open Loxodrome',
	unknownIdents: (p: { words: string }) =>
		`Not ICAO aerodrome idents, so they were left out: ${p.words}.`,
};
