/* About-modal copy: the freshness asides ($lib/format/about returns the
 * structured parts, these render the words), the prose sections, and the
 * data-source card labels. Locale-invariant (kept in the component or in
 * both catalogs verbatim): dataset / publisher / product names (SIA, NATS,
 * ENAIRE, FAA, OurAirports, EUROCONTROL, pruatlas, AIXM, AIRAC), licence
 * names (MIT, CC BY 4.0), URLs, and the MIT licence text (lang="en"). */

import { plural } from './plural';

export const about = {
	activeInDays: (days: number) =>
		`active in ${days} ${plural(days, 'day', 'days')}`,
	activeNow: 'active now',
	activeSoon: 'active in <1 day',
	adChartsAside: (p: { aerodromes: string }) => `${p.aerodromes} IFR aerodromes`,
	adChartsLabel: 'Chart links',
	aircraftRefresh: 'manual; verify against the aircraft flight manual',
	airspacesCount: (n: string) => `${n} airspaces`,
	authorHeading: 'Author',
	backToAbout: 'Back to About',
	chartsHeading: 'Aeronautical charts',
	closeAbout: 'Close About',
	copyright: '© 2026 David du Colombier. Released under the',
	dataLabel: 'Data',
	// The data-source cards come in three sections. A data set states a
	// cycle and counts its rows; a live service says what it carries and
	// when it is asked; a bundled model answers with no network at all.
	dataSetsHeading: 'Data sets',
	liveServicesHeading: 'Live services',
	bundledModelsHeading: 'Bundled models',
	daysAgo: (days: number) => `${days} ${plural(days, 'day', 'days')} ago`,
	designatorModelsAside: (n: string) => `${n} aircraft models`,
	designatorsLabel: 'Designators',
	// The status of the application, the limits of what it computes, and the
	// duty that stays with the pilot, in the regulation's own words
	// (SERA.2010 b, Reg (EU) 923/2012). It replaced a line reading "for
	// situational awareness only", which both undersold the application and
	// contradicted the description above it.
	disclaimer1:
		'Loxodrome is not an aeronautical information service and carries no operational or airworthiness approval. It ',
	disclaimerStrong:
		'does not replace the AIP, the pre-flight information bulletin or the meteorological documentation',
	disclaimer2:
		' of the States flown over, which alone are authoritative. The datasets ship by AIRAC cycle or on each publisher\u2019s own schedule and may be stale or incomplete, NOTAM positions are read from free text, and the aircraft figures are transcribed from the flight manual: every result computed here, the fuel plan, the mass and balance, the distances, the minimum altitudes and the airspace alerts, is an aid to be checked against the aircraft manual and the official documents. Before beginning a flight the pilot in command becomes familiar with all available information appropriate to the intended operation, in the words of SERA.2010(b), and remains responsible for the conduct of the flight.',
	disclaimerHeading: 'Pilot-in-command responsibility',
	editionLabel: 'Edition',
	effectiveAside: (date: string) => `effective ${date}`,
	faaClass: 'Class B / C / D / E',
	faaDesignatorsRefresh: 'manual, per order edition',
	fetchedLabel: 'Fetched',
	facilitiesLabel: 'Aerodrome directory',
	heliportsAside: (n: string) => `${n} heliports`,
	firsUirs: 'FIRs / UIRs',
	chartsAside: (n: string) => `${n} aerodromes`,
	chartPages: (n: string) => `${n} aerodrome pages`,
	generated: 'Generated',
	generatedToday: 'today',
	headAdCharts: 'France: SIA eAIP aerodrome charts',
	headAircraft: 'Aircraft library (flight-manual data)',
	headFaa: 'FAA: Boundary / Special-Use / Class Airspace',
	headFaaDesignators: 'Aircraft type designators: FAA JO 7360.1',
	headFrance: 'France: SIA AIXM 4.5',
	headMetarStations: 'METAR stations: NOAA AWC',
	headNoaa: 'Live weather: NOAA Aviation Weather Center',
	headOpenMeteo: 'Winds aloft: Open-Meteo',
	headOurAirports: 'Airports: OurAirports',
	headOurAirportsSuffix: '+ AIXM overlays',
	headSofia: 'TEMSI & WINTEM: Météo-France via SOFIA-Briefing',
	headBelgium: 'Belgium & Luxembourg: skeyes eAIP',
	headAustria: 'Austria: Austro Control KML + AIXM 5.1.1',
	headGermany: 'Germany: DFS AIXM 5.1.1',
	headSlovakia: 'Slovakia: LPS SR eAIP',
	headIreland: 'Ireland: AirNav Ireland eAIP',
	headSerbiaMontenegro: 'Serbia and Montenegro: SMATSA Serbia and Montenegro eAIP',
	headKosovo: 'Kosovo: KANS Kosovo eAIP',
	headSpain: 'Spain: ENAIRE AIXM 5.1',
	headSupAip: 'France: SIA SUP AIP',
	headUk: 'United Kingdom: NATS AIXM 5.1',
	headEgm96: 'Geoid: EGM96',
	headTerrain: 'Ground elevation: Terrain Tiles',
	headVacGeo: 'France: SIA VAC charts on the map',
	headWmm: 'Magnetic declination: WMM2025',
	howToHeading: 'How to use',
	librariesHeading: 'Open-source libraries',
	mapDataHeading: 'Map data',
	licenseLabel: 'License',
	licenseMit: 'MIT License',
	// Shown in place of a licence text when its module could not be
	// fetched, so the page says what happened rather than looking empty.
	licenseTextUnavailable: 'The licence text could not be loaded.',
	licAustria: '© Austro Control GmbH, published with permission',
	licGermany: '© DFS Deutsche Flugsicherung GmbH, GeoNutzV (modified)',
	licNoaa: 'US Government public domain',
	licOpenMeteo: 'weather data by',
	licSofia: 'Météo-France aeronautical products, via the DGAC briefing portal',
	licEgm96: 'NGA / NASA, US Government public domain',
	licTerrain:
		'AWS Open Data, aggregating the public elevation models of national agencies (SRTM, 3DEP, GMTED2010, ETOPO1, ArcticDEM, EU-DEM and others); attribution per the data set\u2019s own source list',
	licWmm: 'NOAA NCEI / BGS, US Government public domain',
	// Every licence string below was read at the publisher's own source,
	// with the URL and the date in docs/aip-sources.md. Where a publisher
	// grants nothing, the row says that rather than implying a permission
	// nobody gave; where one forbids re-serving, the data is not here at
	// all (cmd/eaip Consent, docs/eaip-states.md).
	// The card itself carries the attribution the Licence Ouverte asks
	// for: it names the SIA, links its site, and prints the cycle.
	licFrance: 'Licence Ouverte, crediting the SIA and the edition date',
	licPruatlas: 'GPL-2 or MIT, © EUROCONTROL',
	licOurAirports:
		'Public domain; OurAirports asks for credit but does not require it',
	// Not a third-party data set: the sheets are transcriptions, and the
	// manual each one is read from stays its publisher's.
	licAircraft:
		'Figures transcribed from each aircraft\u2019s flight manual, which remains its publisher\u2019s',
	licUk: '© NATS Limited; the UK AIS states no re-use terms',
	licBelgium: 'skeyes states no re-use terms in its eAIP',
	licSpain: 'ENAIRE states no re-use terms with its AIP data sets',
	licSlovakia:
		'LPS SR refers its copyright policy to Slovak and EU law and states no re-use terms',
	licIreland: 'AirNav Ireland states no re-use terms in its AIP',
	licSerbiaMontenegro:
		'Copyright reserved to SMATSA; the AIP states no re-use terms',
	licKosovo: 'KANS states no re-use terms in its AIP',
	// Route-NOTAM fetch sources, cited in the Data sources cards.
	headArNotam: 'Route NOTAMs via EUROCONTROL EAD (autorouter)',
	arNotamData: 'NOTAMs for the map view or a planned route, fetched on request',
	licAutorouter: 'Aggregated by EUROCONTROL EAD, accessed via autorouter.aero',
	licNetherlands: 'CC BY 4.0, Air Traffic Control the Netherlands',
	licItaly:
		'OFMA General Users\u2019 License. Community-maintained by the open flightmaps association, not published by ENAV. Report a data error at',
	licSwitzerland:
		'Open use with attribution (opendata.swiss). Obstacles only: Swiss airspace is sold through skybriefing.',
	licFinland:
		'© Fintraffic ANS, free for further refining and research. Obstacles only: the Finnish AIP is published as PDF. Obstacle register held by Traficom.',
	licGeorgia:
		'Published as a free public download; Sakaeronavigatsia states no re-use terms.',
	headGeorgia: 'Georgian AIP data set (Sakaeronavigatsia)',
	headNetherlands: 'LVNL open data (Netherlands)',
	headItaly: 'Italy from open flightmaps (community data)',
	headSwitzerland: 'Swiss obstacle register (FOCA)',
	headFinland: 'Finnish obstacle register (Fintraffic ANS)',
	headSofiaNotam: 'Route NOTAMs from the French SIA (DSNA)',
	sofiaNotamData: 'route NOTAMs for the planned route, fetched on request',
	licSofiaNotam: 'French national AIS (DGAC / DSNA / SIA), anonymous',
	loadingSources: 'Loading data sources…',
	metaUnavailable: (err: string) => `Data source metadata unavailable (${err}).`,
	navaidsAside: (waypoints: string) => `${waypoints} waypoints`,
	nextCycle: 'Next cycle',
	overlaysAside: (p: { count: string; publishers: string }) =>
		`+${p.count} from ${p.publishers} national overlays`,
	noaaData: 'METAR, TAF and SIGMET advisories (the global OPMET feed)',
	noaaFetched: 'live, per airport and as the worldwide advisory set',
	noaaFetchedAside:
		'(airport panel, flight-prep performance, Weather tab; off with the Live weather toggle)',
	obstaclesAside: (p: { lit: string; windTurbines: string }) =>
		`${p.lit} lit, ${p.windTurbines} wind turbines`,
	omData:
		'pressure-level wind and temperature forecasts (Météo-France AROME / ARPEGE, UKMO, ICON, GFS, ECMWF)',
	omFetched: 'live, for the map viewport and the route legs',
	omFetchedAside: '(Weather tab; off with the Live weather toggle)',
	privacyAutorouter:
		'on request, the autorouter fetch sends a route or map-view query, through the relay below, to the public service',
	privacyHeading: 'Privacy',
	privacyIntro:
		'There is no account, no tracking and no advertising, and the application sets no cookie of its own. The briefing you paste or open is parsed in your browser and is never uploaded. The application does make the network requests below: the first two on their own while you use the map, the others only when you ask for them.',
	// What never leaves the device, stated before the list of what does.
	// This string is published as well as shown: scripts/gen-privacy.js
	// generates the hosted policy the Play listing points at from this
	// section, so a permission it fails to name is a gap in a document a
	// store reviewer reads.
	privacyPosition:
		'Your position is read from the device GPS, drawn on the map and written to the trace, and is never transmitted. On Android the recording continues in a foreground service, with the notification that goes with it, so the screen may go off; the application declares the internet, location, foreground-service, notification and wake-lock permissions, and no others. The requests below carry map, route or aerodrome coordinates rather than your fix, but while the map follows the aircraft they do describe where you are.',
	privacyStored:
		'What you build stays in this browser: the routes, the aircraft, the preferences, and the flights library with its traces. The Settings tab erases them by group with "Reset application…"; the downloaded chart packs and the cached tiles survive it on purpose, each pack having its own delete in the Layers tab.',
	privacyTiles:
		'map tiles, fetched while the map is on screen: the base maps straight from their providers, the aeronautical chart layers and their offline packs from the chart relay below, except the Swiss ICAO chart, which comes straight from the Swiss federal WMTS',
	privacyTerrain:
		'ground elevation tiles, fetched whenever a route profile, a minimum-altitude corridor or an airspace alert needs the height of the terrain under a point, and a corridor at a time when you pin a plan\u2019s terrain for offline use, through the relay below; no preference suppresses these',
	privacyProxy:
		'Two Cloudflare Workers run by the author sit in front of those services, because none of them sends the CORS headers a browser needs to read the response: notam-proxy.alcyon.workers.dev relays the NOTAM, weather and terrain requests, and oaci-tiles.alcyon.workers.dev serves the chart tiles and offline packs. Each sees what the service itself would see, the route query, the aerodrome idents or the tile coordinates, together with your IP address. They apply a per-IP rate limit and cache responses briefly; their logs record the route, the status and the upstream error text of a failed request only, never the request body and never the address it came from. No account and no identifier is attached to any of it.',
	// The page load itself, which the request list above does not cover:
	// on the web it is a request to the host like any other, and in the
	// Android shell there is no such request at all.
	privacyHosting:
		'The application itself is served as static files from GitHub Pages, which sees the page request as any web host would; the Android application carries its files with it and fetches none of them.',
	// The second route-NOTAM source, beside autorouter: it sends the
	// planned route to the French AIS through the same relay, so it is its
	// own line rather than a clause on the autorouter one.
	privacySofiaNotam:
		'on request, the SOFIA route briefing sends the planned route, through the relay below, to the French AIS',
	privacySofia:
		"opening the Weather tab's TEMSI & WINTEM section asks the French SOFIA-Briefing service, through the relay below, for its chart catalog, and printing the weather annex pulls the chart PDFs through the same relay",
	privacyToggleOff:
		'The Settings tab\'s "Live weather" toggle stops the weather requests, which are the METAR and TAF, the SIGMET advisories, the winds aloft and the TEMSI / WINTEM catalog. It does not affect the map tiles or the terrain, which the map and the route profile need to work at all.',
	privacyWeather:
		"opening an airport panel or the flight-prep performance page with live weather on asks the NOAA Aviation Weather Center, through the relay below, for that aerodrome's METAR and TAF; the Weather tab asks the same service for the worldwide SIGMET set, no position sent, and, once you turn the station layer on, for the observations in the map view",
	privacyWindsAloft:
		'enabling winds aloft (Weather tab) sends map-view and route-leg coordinates straight from your browser, not through the relay, to',
	refresh: 'Refresh',
	refreshManual: 'manual',
	refreshMonthly: 'monthly (1st)',
	refreshWeekly: 'weekly (Thursdays)',
	reportIssue: 'Report an issue',
	// The three things the tab list cannot say, because they belong to no
	// tab: the conditions the map is read at, the map's own "what is here?"
	// query, and the two keys that work everywhere.
	conditionsHint:
		'The period and the level band in the toolbar are the conditions the whole map is read at: NOTAMs, airspaces, SUP AIP zones and SIGMETs at once.',
	rightClickHint:
		'Right-click anywhere on the map for everything under the cursor: NOTAMs, airspaces, SUP AIP zones, SIGMETs, aerodromes, navaids, obstacles and METAR stations, plus the altitude profile at that point.',
	searchHint:
		'Ctrl+K searches the aerodromes, navaids, waypoints and NOTAMs from anywhere, and the actions themselves; the ? key lists every shortcut and gesture.',
	runwaysAside: (n: string) => `${n} runways`,
	sofiaData: 'significant-weather and wind/temperature chart PDFs',
	sofiaFetched: 'catalog on demand',
	sofiaFetchedAside:
		'(Weather tab; the PDFs download directly from aviation.meteo.fr, and the printed flight dossier relays them through the proxy at print time, nothing cached)',
	sourceLabel: 'Source:',
	stationCatalogLabel: 'Station catalog',
	stationsAside: (p: { taf: string; countries: string }) =>
		`${p.taf} with TAF, ${p.countries} countries`,
	stationsCount: (n: string) => `${n} stations`,
	supAside: (p: { active: string; withGeometry: string }) =>
		`${p.active} active, ${p.withGeometry} with geometry`,
	supplementsLabel: 'Supplements',
	// One line per sidebar tab, in rail order, saying WHERE a thing lives.
	// What the application does is the does* block above; these are the
	// tour, so they stay to one clause each.
	tabNotamsDesc1: ': load a briefing, pasted, from a ',
	tabNotamsDesc2:
		' file or fetched for the map view or the route, then read, filter and print it.',
	tabAirportsDesc:
		': search an aerodrome by indicator, name or town, and open its AIP entry, its charts and its weather.',
	tabRouteDesc:
		': build the routes, set their cruising levels, and open the navigation log, the vertical profile and the flight preparation.',
	tabAircraftDesc:
		': pick the aircraft the preparation computes with; edit its data sheet or add one of your own.',
	tabWeatherDesc:
		': METAR, TAF and SIGMET, the winds aloft, and the TEMSI and WINTEM charts.',
	tabNavigationDesc:
		': record the flight, replay it, set the airspace alerts, and import or export the trace.',
	tabLayersDesc:
		': the base map, the aeronautical chart layers, every overlay and the publishers behind them.',
	tabSettingsDesc:
		': NOTAM markers, content languages, live data, position, appearance, and the reset.',
	// The application in three sentences: what it is, what it does, how it
	// runs. It is named after the course that crosses every meridian at a
	// constant angle (docs/brand.md), not after the NOTAM briefing it grew
	// out of, which is one of the four things below and not the frame the
	// rest hangs off.
	tagline:
		'Loxodrome is a flight-preparation and in-flight navigation application for general aviation, built on the national AIPs of Europe and the United States. It draws them as an aeronautical chart, plans the flight down to the fuel, the mass and balance and the takeoff and landing distances, briefs it, and follows it in the cockpit. It is free and open source, runs entirely in your browser, installs on the device for offline use, and needs no account.',
	// The four phases of the flight it serves, each naming what it actually
	// carries. This is the description; the tab list below is the tour.
	vacGeoAside: (p: { aerodromes: string }) => `${p.aerodromes} aerodromes`,
	vacGeoLabel: 'Placed panels',
	whatItDoesHeading: 'What it does',
	doesChartLabel: 'Chart and AIP',
	doesChart:
		': the airspaces, aerodromes, navaids, obstacles, protected sites and AIP supplements each publisher files, drawn to the ICAO and SIA chart conventions and dated by the cycle each publisher states, over a worldwide aerodrome baseline; the official VFR chart layers stack on top, and an aerodrome opens what its AIP publishes: runways, frequencies, the directory entry and the charts.',
	doesPrepLabel: 'Flight preparation',
	doesPrep:
		': routes and their alternates, cruising levels set against the terrain and the transition altitude, forecast winds leg by leg, the navigation log and the vertical profile; then the fuel plan, the mass and balance and the takeoff and landing distances, computed from the aircraft\u2019s own flight-manual figures and printed as a flight dossier or as A5 kneeboard cards.',
	doesBriefingLabel: 'Briefing',
	doesBriefing:
		': NOTAMs, pasted or fetched for the map view or the route corridor, linked both ways with the aerodromes, airspaces, navaids and obstacles they concern and hatching the zones they activate; METAR, TAF and SIGMET; winds and temperatures aloft; the TEMSI and WINTEM charts.',
	doesFlightLabel: 'In flight',
	doesFlight:
		': the map follows the GPS, the navigation log stamps the times actually flown, the contact chain gives the frequency in force, and airspace alerts warn by the action each zone requires; afterwards the replay, the trace as GPX, IGC or KML, and the flights library.',
	terrainFetched:
		'on demand, through the notam-proxy relay (the tile bucket sends no CORS header); cached offline, and not covered by the Live weather toggle',
	terrainData:
		'ground elevation sampled from terrain-RGB tiles (route ground profile, minimum safe altitudes, height above ground for the airspace alerts, and the printed dossier)',
	egm96Data:
		'EGM96 geoid undulation on a one-degree lattice, bundled (the separation that references a GNSS altitude to mean sea level)',
	wmmData:
		'World Magnetic Model 2025 coefficients, bundled (nav-log magnetic courses and headings); valid 2025.0 to 2030.0',
	wmmExpired:
		'Model validity ended 31 December 2029; headings use the frozen 2030.0 declination until the WMM2030 coefficients ship.',
	wmmExpiredLabel: 'Validity',
};
