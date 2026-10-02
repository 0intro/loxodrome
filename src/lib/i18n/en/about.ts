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
	vacAtlasLabel: 'VAC atlas',
	vacAtlasLine: (p: { aerodromes: string; heliports: string }) => `${p.aerodromes} aerodromes, ${p.heliports} heliports`,
	offlineLabel: 'Offline',
	vacOfflinePack:
		'the atlas of the current and the next cycle, as a document pack in the Android application',
	supOfflinePacks:
		'the supplements in force, in French and in English, as document packs in the Android application',
	aircraftRefresh: 'manual, to be checked against the aircraft flight manual',
	airspacesCount: (n: string) => `${n} airspaces`,
	authorHeading: 'Author',
	backToAbout: 'Back to About',
	chartsHeading: 'Aeronautical chart layers',
	chartEditionYear: (year: string) => `${year} edition`,
	chartEditionUpdated: (date: string) => `updated ${date}`,
	chartEditionExcept: (p: { regions: string; edition: string }) => `${p.regions}: ${p.edition}`,
	siaSymbolsLabel: 'SIA chart symbols and activity pictograms',
	siaSymbolsEdition: 'the 1:500 000 legend (Légende 2026) and the 1:250 000 chart, 2026 editions',
	closeAbout: 'Close About',
	copyright: '© 2026 David du Colombier. Released under the',
	dataLabel: 'Data',
	// The credit sections, one per TYPE of data, in the order the modal
	// renders them: what a source IS files it, not who publishes it and not
	// how it reaches the device. How it reaches the device is a row on the
	// card itself (Fetched / Refresh), and which requests leave the device
	// is the Privacy section's job above.
	aipHeading: 'Aeronautical information (AIP)',
	adChartsHeading: 'Aerodrome charts',
	notamHeading: 'NOTAM',
	weatherHeading: 'Weather',
	aircraftHeading: 'Aircraft',
	terrainHeading: 'Terrain and elevation',
	magneticHeading: 'Magnetic model',
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
		' of the States flown over, which alone are authoritative. The datasets ship by AIRAC cycle or on each publisher\u2019s own schedule and may be stale or incomplete, NOTAM positions and the changes NOTAMs make are read from free text, and the aircraft figures are transcribed from the flight manual and the weighing report: every result computed here, the fuel plan, the mass and balance, the distances, the minimum altitudes and the airspace, terrain and obstacle alerts, is an aid to be checked against the aircraft manual and the official documents. Terrain and obstacle alerts are an aid to situational awareness only, not a certified terrain awareness and warning system (TAWS). Before beginning a flight the pilot in command becomes familiar with all available information appropriate to the intended operation, in the words of SERA.2010(b), and remains responsible for the conduct of the flight.',
	disclaimerHeading: 'Pilot-in-command responsibility',
	editionLabel: 'Edition',
	effectiveAside: (date: string) => `effective ${date}`,
	faaClass: 'Class B / C / D / E',
	faaDesignatorsRefresh: 'manual, per order edition',
	fetchedLabel: 'Fetched',
	facilitiesLabel: 'Aerodrome directory',
	heliportsAside: (n: string) => `${n} heliports`,
	fuelLabel: 'Fuel entries',
	fuelAside: (n: string) => `${n} with grades identified`,
	fuelAipCycle: (date: string) => `AIP ${date}`,
	firsUirs: 'FIRs / UIRs',
	chartsAside: (n: string) => `${n} aerodromes`,
	chartPages: (n: string) => `${n} aerodrome pages`,
	generated: 'Generated',
	generatedToday: 'today',
	headAdCharts: 'France: SIA eAIP aerodrome charts',
	// One card per publisher that indexes its own aerodrome charts, all in
	// the Aerodrome charts section: the chart index is chart data whoever
	// files it, so it does not ride the publisher's AIP card.
	headAtAdCharts: 'Austria: Austro Control aerodrome charts',
	headBeAdCharts: 'Belgium & Luxembourg: skeyes aerodrome charts',
	headEaipAdCharts: 'Europe: aerodrome charts in the national AIPs',
	eaipChartsLine: (p: { publisher: string; charts: string; nCharts: number; aerodromes: string; nAerodromes: number; vac: string }) =>
		`${p.publisher}: ${p.charts} ${p.nCharts === 1 ? 'chart' : 'charts'}, ${p.aerodromes} ${p.nAerodromes === 1 ? 'aerodrome' : 'aerodromes'}, ${p.vac} with a VAC`,
	licEaipAdCharts:
		'Links to each publisher’s own chart files, which stay theirs. Nothing is copied, so a State whose data awaits its consent is linked all the same.',
	headDeAdCharts: 'Germany: DFS aerodrome charts',
	headUkAdCharts: 'United Kingdom: NATS aerodrome charts',
	headUsAdCharts: 'United States: FAA aerodrome charts',
	headAircraft: 'Aircraft library (flight manuals and weighing reports)',
	headFaa: 'United States: FAA AIS',
	headFaaDesignators: 'Aircraft type designators: FAA JO 7360.1',
	headFrance: 'France: SIA AIXM 4.5',
	headFuel: 'France: SIA aerodrome fuel',
	headMetarStations: 'METAR stations: NOAA AWC',
	headNoaa: 'Live weather: NOAA Aviation Weather Center',
	headOpenMeteo: 'Winds aloft: Open-Meteo',
	headOpera: 'Precipitation radar: EUMETNET OPERA',
	headDwdFronts: 'Surface pressure charts: Deutscher Wetterdienst (DWD)',
	headOurAirports: 'Airports: OurAirports',
	headOurAirportsSuffix: '+ AIXM overlays',
	headSofia: 'TEMSI & WINTEM: Météo-France via SOFIA-Briefing',
	headBelgium: 'Belgium & Luxembourg: skeyes eAIP',
	headAustria: 'Austria: Austro Control KML + AIXM 5.1.1',
	headGermany: 'Germany: DFS AIXM 5.1.1',
	headSlovakia: 'Slovakia: LPS SR eAIP',
	headIreland: 'Ireland: AirNav Ireland eAIP and IAA obstacle registers',
	headSerbiaMontenegro: 'Serbia and Montenegro: SMATSA Serbia and Montenegro eAIP',
	headKosovo: 'Kosovo: KANS Kosovo eAIP',
	headIceland: 'Iceland: Avians eAIP',
	headSpain: 'Spain: ENAIRE AIXM 5.1',
	headSupAip: 'France: SIA SUP AIP',
	headUk: 'United Kingdom: NATS AIXM 5.1',
	headEgm96: 'Geoid: EGM96',
	headTerrain: 'Ground elevation: a mosaic built for this app',
	headVacGeo: 'France: SIA VAC charts on the map',
	headWmm: 'Magnetic declination: WMM2025',
	howToHeading: 'How to use',
	librariesHeading: 'Open-source libraries',
	mapDataHeading: 'Base maps',
	basemapOfflineCopy: (date: string) => `offline copy, IGN edition of ${date}`,
	licenseLabel: 'License',
	licenseMit: 'MIT License',
	// Shown in place of a licence text when its module could not be
	// fetched, so the page says what happened rather than looking empty.
	licenseTextUnavailable: 'The licence text could not be loaded.',
	licAustria: '© Austro Control GmbH, published with permission',
	licGermany: '© DFS Deutsche Flugsicherung GmbH, GeoNutzV (modified)',
	licNoaa: 'US Government public domain',
	licOpenMeteo: ', weather data by',
	licOpenMeteoAfter: '. Modified here: interpolated between the pressure levels and along the route.',
	// The licence line is split around one link: the deed's name leads it
	// in the markup, then this, then the publisher's document, then the
	// rest, so both languages keep their own word order.
	licOpera:
		', EUMETNET holding the property rights of the OPERA composites and distributing them under it, as its',
	licOperaDoc: 'Open Radar Data documentation',
	licOperaAfter:
		' states. Each frame carries the licence and its producer in its own metadata. Modified here: max-pooled to the map\u2019s resolution and coloured on the app\u2019s scale.',
	licDwdFronts:
		', the Deutscher Wetterdienst granting reuse of its web and open-data content under it, as its',
	licDwdFrontsDoc: 'legal notice',
	licDwdFrontsAfter: ' states. Modified here: the analyses are reduced to 3000 px wide for print.',
	licSofia: 'Météo-France aeronautical products, via the DGAC briefing portal',
	licEgm96: 'NGA / NASA, US Government public domain',
	licTerrain:
		'built from public elevation models, each redistributed under its own licence and credited in full below. No model whose terms forbid re-serving is used',
	terrainTiersLabel: 'Sources',
	// In place of the tiers when the mosaic's manifest, which carries each
	// model's notice, could not be read: the ground still draws from a
	// built-in range, so the page must not simply end where the credits go.
	terrainCreditsMissing: 'The credits of the elevation models could not be loaded.',
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
		'Public domain, OurAirports asking for credit without requiring it',
	// Not a third-party data set: the sheets are transcriptions, and the
	// manual each one is read from stays its publisher's.
	licAircraft:
		'Figures transcribed from each aircraft’s flight manual, its supplements and its weighing report, which remain their authors’',
	licUk: '© NATS Limited. NATS states its datasets are for aviation use only, which this is',
	licBelgium: 'skeyes states no re-use terms in its eAIP',
	licSpain: 'ENAIRE states no re-use terms with its AIP data sets, and the legal notice of its AIP site reserves its databases',
	// LPS SR's terms of use require this exact notice wherever the AIP is
	// used, and allow its use for informative or operational purposes.
	licSlovakia:
		'© LPS SR, š. p. Its terms of use allow any part of the AIP to be used for informative or operational purposes',
	licIreland:
		'AirNav Ireland and the Irish Aviation Authority state no re-use terms for the AIP or the obstacle registers',
	licSerbiaMontenegro:
		'Copyright reserved to SMATSA. The AIP states no re-use terms',
	licKosovo: 'KANS states no re-use terms in its AIP',
	licIceland: 'Avians restricts its AIP to non-commercial use, and Loxodrome is non-commercial',
	// The two NOTAM services, credited in the NOTAM section.
	headArNotam: 'NOTAM: EUROCONTROL EAD via autorouter',
	arNotamData: 'NOTAMs for the map view, a planned route or one aerodrome, fetched on request',
	licAutorouter: 'Aggregated by EUROCONTROL EAD, accessed via autorouter.aero',
	licNetherlands: 'CC BY 4.0, Air Traffic Control the Netherlands',
	licSweden: 'CC BY 4.0, LFV',
	licItaly:
		'OFMA General Users\u2019 License. Community-maintained by the open flightmaps association, not published by ENAV. Report a data error at',
	licSwitzerland:
		'Open use with attribution (opendata.swiss). Obstacles only: Swiss airspace is sold through skybriefing.',
	licFinland:
		'© Fintraffic ANS, free for further refining and research without a fee or an agreement, the publications themselves not to be resold. Obstacle register held by Traficom.',
	licRomania:
		'ROMATSA publishes the information on its site for general use and states no re-use terms in its AIP.',
	licGeorgia:
		'Published as a free public download. Sakaeronavigatsia states no re-use terms.',
	headGeorgia: 'Georgia: Sakaeronavigatsia AIP data set',
	headNetherlands: 'Netherlands: LVNL open data',
	headItaly: 'Italy: open flightmaps (community data)',
	headSwitzerland: 'Switzerland: FOCA obstacle register',
	headRomania: 'Romania: ROMATSA AIP and obstacle data set',
	headFinland: 'Finland: Fintraffic ANS eAIP and obstacle register',
	headSweden: 'Sweden: LFV Digital AIM',
	headSofiaNotam: 'NOTAM: French SIA via SOFIA-Briefing (DSNA)',
	sofiaNotamData: 'NOTAMs for the planned route or one aerodrome, fetched on request',
	licSofiaNotam: 'French national AIS (DGAC / DSNA / SIA), anonymous',
	loadingSources: 'Loading data sources…',
	metaUnavailable: (err: string) => `Data source metadata unavailable (${err}).`,
	navaidsAside: (waypoints: string) => `${waypoints} waypoints`,
	nextCycle: 'Next cycle',
	overlaysAside: (p: { count: string; publishers: string }) =>
		`+${p.count} from ${p.publishers} national overlays`,
	noaaData: 'METAR, TAF and SIGMET advisories (the global OPMET feed)',
	noaaFetched: 'live, per aerodrome or for the stations around it, the stations in the map view and the worldwide advisory set',
	noaaFetchedAside:
		'(airport and station panels, the flight-preparation pages and prints, the printed weather briefing, the METAR-station and SIGMET layers and the Weather tab, off with the Live weather toggle)',
	obstaclesAside: (p: { lit: string; windTurbines: string }) =>
		`${p.lit} lit, ${p.windTurbines} wind turbines`,
	omData:
		'forecasts at the pressure levels, wind, temperature, height and cloud cover, and at the surface, wind, gusts, temperature and mean-sea-level pressure, from the AROME and ARPEGE (Météo-France), UKMO (Met Office), ICON (DWD), GFS and HRRR (NOAA) and ECMWF IFS models, or Open-Meteo’s best match',
	omFetched: 'live, for the legs of every route with two waypoints as soon as it has them, and for the map view while the wind barbs are on',
	omFetchedAside: '(the navigation log, the fuel plan, the vertical profile and the in-flight readout, and the wind layers of the Weather and Layers tabs, off with the Live weather toggle or, for a route, with the Route tab’s Forecast winds)',
	operaData:
		'the CIRRUS maximum-reflectivity composite of more than 160 European ground radars (1 km grid, a frame every 5 min), produced by Météo-France, and the NIMBUS instantaneous rain-rate composite (2 km grid, a frame every 15 min), produced by GeoSphere Austria',
	operaFetched:
		'live from the Open Radar Data service’s 24-hour cache, the tiles of the map view for the loop’s last half hour, hour or two hours',
	operaFetchedAside:
		'(map layer and Weather tab, off with the Live weather toggle, supplementary situational awareness outside the regulated briefing)',
	dwdFrontsData:
		"surface pressure charts with the fronts drawn by DWD's forecasters: the North Atlantic-Europe analysis every six hours and the forecasts up to four days ahead",
	dwdFrontsFetched:
		"the list while the Weather tab is open and the charts at print time, the analyses from DWD's open-data server through the relay and the forecasts straight from www.dwd.de",
	dwdFrontsFetchedAside:
		'(Weather tab section and the printed weather annex, off with the Live weather toggle, nothing stored by the application)',
	// The optional account, in the position the reader meets it: after
	// what stays local, since the account is what moves some of it. The
	// hosted policy publishes this string too (gen-privacy.js).
	privacyAccount:
		'An account, if you create one, syncs your flight plans, flights, aircraft and pilot details (a name and the validity dates of your SEP rating and medical certificate) between your devices through api.loxodrome.fr, a third Cloudflare Worker run by the author. It stores your e-mail address, per-device session records (a device name and when it was last seen) and your documents as opaque content it never parses, in Cloudflare\u2019s European storage (the database in Western Europe, the trace files under EU jurisdiction). Sign-in codes reach your address through Cloudflare\u2019s e-mail service, the sign-in form loads Cloudflare Turnstile from challenges.cloudflare.com to keep bots out, and an address that asks for a code without ever becoming an account is kept only as a hash. Everything is self-serve behind the toolbar\u2019s account button, also reachable at loxodrome.fr/?account=: export a copy of your data, sign out, or delete the account, which erases the server copy after a 7-day grace, every device being signed out at once. A plan or a flight you delete leaves a deletion record, kept up to 90 days so your other devices learn of it. The database\u2019s own history, kept 30 days at Cloudflare for point-in-time restore, and the daily backups of the service, kept on the author\u2019s own computer for up to two months, hold the same data, so erased data leaves the last of them within two months. The steps are also set out at loxodrome.fr/account-deletion.html. Deleting the account never touches the copies on your devices. Each call to api.loxodrome.fr is kept for 7 days in Cloudflare\u2019s request log, which the author can read: the address called and the status of the answer, the request headers with your IP address among them (Cloudflare masks the session token), and the approximate location Cloudflare derives from that address. The request body is never logged, so neither your documents nor a sign-in code is, and the service\u2019s own log lines record only its failures and, by their internal identifier, the accounts it erases.',
	privacyAutorouter:
		'on request, the autorouter fetch sends a route, map-view or aerodrome query, through the relay below, to the public service',
	privacyHeading: 'Privacy',
	privacyIntro:
		'There is no tracking and no advertising, and the application sets no cookie of its own. The briefing you paste or open is parsed in your browser and is never uploaded. An account is entirely optional and everything works without one. The application does make the network requests below: the first two on their own while you use the map, the forecast winds as soon as a route has two waypoints, and the others when you open the surface that shows them, turn their layer on or ask for them.',
	// What never leaves the device, stated before the list of what does.
	// This string is published as well as shown: scripts/gen-privacy.js
	// generates the hosted policy the Play listing points at from this
	// section, so a permission it fails to name is a gap in a document a
	// store reviewer reads.
	privacyPosition:
		'Your position is read from the device’s location, its GPS where it has one, drawn on the map and written to the trace. No request carries it, except that an account, if you sign in to one, syncs your recorded flights with their traces (see below). On Android the recording continues in a foreground service, with the notification that goes with it, so the screen may go off. The application declares the internet, location, foreground-service, notification, wake-lock and vibration permissions, and no others. The requests below carry map, route, aerodrome or terrain-tile coordinates rather than your fix, but they can describe where you are: while the map follows the aircraft, and whenever a flight is recorded or replayed, since the terrain tiles under and ahead of the aircraft are then fetched, a few kilometres on a side, whatever the map shows, and on the web the data files of the countries around the aircraft are loaded too.',
	privacyStored:
		'What you build stays on this device: the routes, the aircraft, the flight preparation with your pilot details, the preferences, and the flights library with its traces. The Settings tab puts the preferences back to their defaults with "Restore default settings", erasing nothing else, and erases what is stored by group with "Reset application…". The downloaded chart, base-map and document packs, the terrain pinned for a plan and the cached tiles and data files survive it on purpose, each pack having its own delete in the offline data manager, opened from the Layers tab.',
	privacyTiles:
		'map tiles, fetched while the map is on screen: the base maps straight from their providers (OpenStreetMap, OpenTopoMap, IGN, Google or Microsoft, whichever is selected), the aeronautical chart layers from the chart server below, except the Swiss ICAO chart, which comes straight from the Swiss federal WMTS. A chart layer’s offline pack and the offline pack of the Plan IGN base map from the chart server are downloaded when you ask for one, and opening the Layers tab or the offline data manager asks the server whether a pack has a new edition',
	privacyTerrain:
		'ground elevation tiles, from the chart server below: as soon as a route has two waypoints, for its ground profile, its minimum altitudes and its cruising levels, whenever a trace profile, an altitude profile (opened from an airspace or NOTAM panel, or from the map right-click menu) or an airspace alert needs the height of the terrain under and around your trace or point, a corridor at a time when you pin a plan’s terrain for offline use, the tile under the pointer once it comes to rest on the map, and, while a flight is recorded or replayed, the tile under the aircraft for its height above the ground, the tiles of the map view for the Terrain layer and those along the path ahead for the terrain alerts',
	privacyProxy:
		'Two Cloudflare Workers run by the author answer the requests above that do not go straight to a provider. proxy.loxodrome.fr, the relay, forwards the NOTAM, weather, radar and DWD analysis requests and the VAC plates, because none of those services sends the CORS headers a browser needs to read the response, and charts.loxodrome.fr, the chart server, serves the chart tiles, the ground elevation tiles and the offline packs the author builds from the publishers’ own files. Each sees what it is asked, the route query, the aerodrome idents or the tile coordinates, together with your IP address. The relay applies a per-IP rate limit and keeps its answers in Cloudflare’s cache, a NOTAM or weather query for about a minute and a published file, a radar frame, a DWD analysis or a VAC plate, for a day to a year. The relay’s log records its own failures only, a failed request’s route, status and upstream error text or its cache misbehaving, never the request body and never the address it came from, and the chart server keeps no log at all. No account and no identifier is attached to any of it.',
	// The page load itself, which the request list above does not cover:
	// on the web it is a request to the host like any other, and in the
	// Android shell there is no such request at all.
	privacyHosting:
		'The application itself is served as static files from GitHub Pages through Cloudflare’s network, which both see, as any web host would, the page and the files it loads: its code, and the data files the map reads country by country for the area in view, the plan’s and the aircraft’s. Every loxodrome.fr address, the site, the relay, the chart server and the account service, asks browsers that implement Network Error Logging, Chromium-based ones among them, to report to Cloudflare a connection to it that fails. A link that opens a file in the application (?file=) makes your browser fetch that file from wherever the link points. The Android application carries its files with it and fetches none of them.',
	// The second NOTAM source, beside autorouter: it sends the planned route,
	// or the one aerodrome an airport panel asks about, to the French AIS
	// through the same relay, so it is its own line rather than a clause on
	// the autorouter one.
	privacySofiaNotam:
		'on request, the SOFIA briefing sends the planned route, or the aerodrome whose NOTAMs an airport panel asks for, through the relay below, to the French AIS',
	privacySofia:
		"opening the Weather tab or the flight-preparation print menu asks the French SOFIA-Briefing service, through the relay below, for its TEMSI and WINTEM catalog, again every five minutes while the tab stays open, and printing the weather annex asks for it once more and pulls the chart PDFs through the same relay. A chart opened from the tab comes straight from Météo-France's aviation.meteo.fr",
	// The DWD front charts: the analyses through the relay (opendata.dwd.de
	// sends no CORS header), the forecasts straight from the browser at
	// www.dwd.de, which serves them with an open CORS header.
	privacyFronts:
		"opening the Weather tab asks the relay below which DWD surface analyses are published, and asks www.dwd.de, straight from your browser and not through the relay, which forecast charts are, again every fifteen minutes while the tab stays open. Printing the weather annex fetches the analysis through the relay, which reads it from DWD's open-data server, and the forecast charts straight from www.dwd.de. None of these sends a position",
	privacyToggleOff:
		'The Settings tab\'s "Live weather" toggle stops the weather requests, which are the METAR and TAF, the SIGMET advisories, the winds aloft, the precipitation radar, the DWD surface pressure charts and the TEMSI / WINTEM catalog. It does not stop the requests that are not weather, the map tiles, the terrain, the VAC plates, the NOTAMs, the offline packs and the account, and "Restore default settings" or a reset of the settings turns it back on.',
	privacyWeather:
		"with live weather on, an aerodrome's panel asks the NOAA Aviation Weather Center, through the relay below, for its METAR and TAF, or for the stations around it when it has none. The flight-preparation pages, their prints and the printed weather briefing ask the same service about the aerodromes of the flight and the stations around them, the station layer, once on, about the observations in the map view, and the Weather tab, the SIGMET layer and a SIGMET panel for the worldwide SIGMET set, no position sent",
	privacyWindsAloft:
		'forecast winds, temperatures and clouds, with live weather on, from Open-Meteo, asked straight from your browser, not through the relay: for the legs of every route with two waypoints as soon as it has them, the Route tab’s Forecast winds being on, along those legs while the vertical profile draws its clouds or a dossier prints, and for the map view while the wind barbs are on. While any of these is in use, the browser also asks Open-Meteo every fifteen minutes which model runs it holds. The requests go to api.open-meteo.com, or to historical-forecast-api.open-meteo.com for a day more than 88 days past',
	// The VAC layer's plates: the one map layer read partly through the
	// NOTAM relay, which names the aerodromes in view.
	privacyVac:
		'turning the VAC charts layer on (France, Layers tab) reads the SIA VAC plate of each aerodrome in the map view: from a downloaded document pack when there is one, otherwise by ranged reads of the published pack from the chart server below, and failing that one plate at a time through the relay below, which fetches it from the SIA, so these requests name the aerodromes in view',
	privacyRadar:
		'while the precipitation radar is on (Weather or Layers tab), the relay below is asked for the composite frames covering the map view, a few tiles at a time, and the relay, fetching each frame once per Cloudflare location from the EUMETNET open-data cache, learns nothing of where you look beyond those tiles',
	refresh: 'Refresh',
	refreshManual: 'manual',
	refreshMonthly: 'monthly (1st)',
	refreshWeekly: 'weekly (Thursdays)',
	reportIssue: 'Report an issue',
	// What the tab list cannot say, because it belongs to no tab: the
	// conditions the map is read at, the toolbar's own doors, the map's
	// "what is here?" query, and the two keys that work everywhere.
	conditionsHint:
		'The period and the level band in the toolbar are the conditions the whole map is read at: NOTAMs, airspaces, SUP AIP zones and SIGMETs at once. The period also sets the hour the winds aloft are drawn at.',
	toolbarHint:
		'The toolbar opens what belongs to no tab, the navigation log, the vertical profile, the flight preparation and the flights library, and its Fly button starts the flight. On a phone, the bar at the foot of the screen leads to the tabs as pages, and the menu behind the logo to the settings and the account.',
	rightClickHint:
		'Right-click anywhere on the map, or press and hold on a touch screen, for everything under the cursor: NOTAMs, airspaces, SUP AIP zones, SIGMETs, aerodromes, navaids, obstacles, METAR stations, the radar echo and the aerodrome charts laid there. The same menu copies the coordinates, opens the altitude profile at that point and edits the route: add, insert or remove a waypoint, activate a leg, or fly direct to the point.',
	searchHint:
		'Ctrl+K searches the aerodromes, navaids, waypoints and NOTAMs from anywhere, and the actions themselves. The ? key lists every shortcut and gesture.',
	runwaysAside: (n: string) => `${n} runways`,
	sofiaData: 'significant-weather and wind/temperature chart PDFs',
	sofiaFetched: 'the catalog while the Weather tab or the print menu is open, the PDFs at print time',
	sofiaFetchedAside:
		'(Weather tab, the flight dossier and the printed weather briefing, off with the Live weather toggle. A chart opened from the tab downloads straight from aviation.meteo.fr, and a print relays the PDFs through the proxy, nothing cached)',
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
		' file or fetched for the map view or the route from the service you pick, then read, filter and print it.',
	tabAirportsDesc:
		': search an aerodrome by indicator, name or town, filter the French ones by the fuel they sell, and open its AIP entry, its charts, its weather and its NOTAMs.',
	tabRouteDesc:
		': build the routes, typed or on the map, set their cruising levels and planning options, and load, save, export or send them to SendFPL.',
	tabAircraftDesc:
		': pick the aircraft the preparation computes with, edit its data sheet, add or import one of your own, and export it.',
	tabWeatherDesc:
		': METAR, TAF and SIGMET, the winds aloft, the precipitation radar, the DWD surface pressure charts, the TEMSI and WINTEM charts, and the printed weather briefing.',
	tabNavigationDesc:
		': record the flight, set the airspace, terrain and obstacle alerts and the in-flight readout, and import or export the trace and the logbook.',
	tabLayersDesc:
		': the base map, the aeronautical chart layers, every overlay and the publishers behind them, and the offline data.',
	tabSettingsDesc:
		': NOTAM markers, languages, live data, position, appearance, the interface, and, at the foot of the tab, the restore of the default settings and the reset.',
	// The application in a few sentences: what it is, what it does, how it
	// runs. It is named after the course that crosses every meridian at a
	// constant angle (docs/brand.md), not after the NOTAM briefing it grew
	// out of, which is one of the phases below and not the frame the rest
	// hangs off.
	tagline:
		'Loxodrome is a flight-preparation and in-flight navigation application for general aviation, built on the national AIPs of Europe and the United States. It draws them as an aeronautical chart, plans the flight down to the fuel, the mass and balance and the takeoff and landing distances, briefs it, and follows it in the cockpit. It is free and open source, runs entirely on your device, in the browser or as an Android application, installs for offline use, and needs no account. An optional account can sync your flight plans, flights, aircraft and pilot details between your devices.',
	// The phases of the flight it serves, each naming what it actually
	// carries, then the optional account. This is the description; the tab
	// list below is the tour.
	vacGeoAside: (p: { aerodromes: string }) => `${p.aerodromes} aerodromes`,
	vacGeoLabel: 'Placed panels',
	whatItDoesHeading: 'What it does',
	doesChartLabel: 'Chart and AIP',
	doesChart:
		': the airspaces, aerodromes, navaids, obstacles, protected sites and AIP supplements each publisher files, drawn to the ICAO and SIA chart conventions and dated by the cycle each publisher states, over a worldwide aerodrome baseline. The official aeronautical charts stack on top, the French VAC charts can be laid in place on the map, and the Android application keeps the charts, the Plan IGN base map and the AIP documents for offline use. An aerodrome opens what its AIP publishes, its runways, frequencies, fuel, directory entry and charts, with its weather and its NOTAMs, and shows what those NOTAMs close or change.',
	doesPrepLabel: 'Flight preparation',
	doesPrep:
		': routes and their alternates, typed or drawn on the map, cruising levels set against the terrain and the transition altitude, forecast winds leg by leg, the navigation log and the vertical profile with its clouds, freezing level and NOTAM bands. Then the fuel plan and its refuelling stops, the mass and balance, and the takeoff and landing distances judged against the declared distances of each runway end, computed from the aircraft\u2019s flight manual and weighing report. It all prints as a flight dossier with its weather annex or as A5 kneeboard cards, and a route can be exported as a Garmin FPL, GPX, KML or PLN file, or handed to SendFPL.',
	doesBriefingLabel: 'Briefing',
	doesBriefing:
		': NOTAMs, pasted or fetched for the map view, the route corridor or one aerodrome, linked both ways with the aerodromes, airspaces, navaids, obstacles and AIP supplements they concern, hatching the zones they activate and marking the frequencies, fuel, runways, declared distances and aerodromes they change or close. METAR, TAF and SIGMET, winds and temperatures aloft, the precipitation radar, the Deutscher Wetterdienst\u2019s surface pressure charts with their fronts, and the TEMSI and WINTEM charts. A weather briefing prints on its own.',
	doesFlightLabel: 'In flight',
	doesFlight:
		': the map follows the GPS, the in-flight readout gives the frequency in force, the heading to steer and the times ahead, the navigation log stamps the times actually flown, and alerts warn by the action each airspace requires and of terrain and obstacles ahead, the ground shaded against the aircraft\u2019s altitude. Direct-To reroutes from the present position. Afterwards the replay on the map, the trace as GPX, IGC or KML, and the flights library with its logbook export.',
	doesAccountLabel: 'Optional account',
	doesAccount:
		': sign in with a code received by e-mail. Your flight plans, flights with their traces, aircraft sheets and pilot details follow you between your devices and the club computer. Entirely optional: everything works without an account, and none of it leaves the device until you sign in. Delete it at any time from the application.',
	terrainFetched:
		'on demand, from the same chart server as the chart tiles and the offline packs, cached for offline use and not covered by the Live weather toggle',
	terrainData:
		'ground elevation, and the highest and lowest ground around each point, sampled from elevation tiles (the readout under the cursor, the route ground profile, the trace profile, the ground under an altitude profile, minimum safe altitudes, height above ground for the airspace alerts, the terrain shading and terrain alerts in flight and in replay, and the printed dossier)',
	egm96Data:
		'EGM96 geoid undulation on a one-degree lattice, bundled (the separation that references a GNSS altitude to mean sea level)',
	wmmData:
		'World Magnetic Model 2025 coefficients, bundled (the magnetic tracks and headings of the route, the navigation log, the cruising levels and the in-flight readout, VOR radials and runway wind components), valid 2025.0 to 2030.0',
	wmmExpired:
		'Model validity ended 31 December 2029. Headings use the frozen 2030.0 declination until the WMM2030 coefficients ship.',
	wmmExpiredLabel: 'Validity',
};
