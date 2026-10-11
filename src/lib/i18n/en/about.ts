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
	// duty that stays with the pilot. The quotation is SERA.2010(b) word for
	// word, the last clause SERA.2010(a)'s (Reg (EU) 923/2012, the EUR-Lex
	// consolidated text of 1 May 2025).
	disclaimer1:
		'Loxodrome is an independent application, not an aeronautical information service, and has no operational or airworthiness approval. It ',
	disclaimerStrong:
		'does not replace the AIP, the pre-flight information bulletin or the meteorological documentation',
	disclaimer2:
		' of the States flown over, which alone are authoritative. Its data can be out of date or incomplete. What a NOTAM affects is read from its text and can be misread. The aircraft figures are transcribed from flight manuals or entered by you. Check every result against the flight manual and the official documents. The terrain and obstacle alerts are an aid, not a certified TAWS. Under SERA.2010, before beginning a flight the pilot-in-command "shall become familiar with all available information appropriate to the intended operation", and is responsible for the operation of the aircraft.',
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
	licEaipAdCharts: 'Links to each publisher’s own chart files. Nothing is copied.',
	headDeAdCharts: 'Germany: DFS aerodrome charts',
	headUkAdCharts: 'United Kingdom: NATS aerodrome charts',
	headUsAdCharts: 'United States: FAA aerodrome charts',
	headAircraft: 'Aircraft library',
	headFaa: 'United States: FAA AIS',
	headFaaDesignators: 'Aircraft type designators: FAA JO 7360.1',
	headFrance: 'France: SIA AIXM 4.5',
	headFuel: 'France: SIA aerodrome fuel',
	headMetarStations: 'METAR stations: NOAA AWC',
	headNoaa: 'Live weather: NOAA Aviation Weather Center',
	headMeteoFrance: 'Forecast models: Météo-France AROME, AROME-OM and ARPEGE',
	headEcmwf: 'Forecast model: ECMWF IFS',
	headOpenMeteo: 'Forecast models: Open-Meteo',
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
	headSerbiaMontenegro: 'Serbia and Montenegro: SMATSA eAIP',
	headKosovo: 'Kosovo: KANS eAIP',
	headIceland: 'Iceland: Avians eAIP',
	headSpain: 'Spain: ENAIRE AIXM 5.1',
	headSupAip: 'France: SIA SUP AIP',
	headUk: 'United Kingdom: NATS AIXM 5.1',
	headEgm96: 'Geoid: EGM96',
	headTerrain: 'Ground elevation: a mosaic built for Loxodrome',
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
	// What the Licence Ouverte asks a reuser to state: the source, at least
	// the grantor's name, and the date of the most recent update, which for
	// a forecast is its model run. Split around the links to the packages.
	licMeteoFrance: ', Météo-France, original data from its open-data packages',
	licMeteoFranceArome: 'AROME 0.025°',
	licMeteoFranceSep: ',',
	licMeteoFranceAromeOm: 'AROME-OM 0.025°',
	licMeteoFranceAnd: 'and',
	licMeteoFranceArpege: 'ARPEGE 0.1°',
	licMeteoFranceAfter:
		', updated at every run, the run named beside each forecast. Modified here: quantised, and interpolated in time, between pressure levels and along the route.',
	// ECMWF's own statement for a service built on its data, its five parts
	// in its order (copyright, source, licence, disclaimer, modifications),
	// split around the two links.
	licEcmwf: 'This service is based on data and products of the European Centre for Medium-Range Weather Forecasts (ECMWF). Source:',
	licEcmwfMid: '. This ECMWF data is published under a Creative Commons Attribution 4.0 International (',
	licEcmwfAfter:
		'). ECMWF does not accept any liability whatsoever for any error or omission in the data, their availability, or for any loss or damage arising from their use. Modified here: quantised, interpolated in time, between pressure levels and along the route, with cloud cover derived from relative humidity.',
	// The licence line is split around one link: the deed's name leads it
	// in the markup, then this, then the publisher's document, then the
	// rest, so both languages keep their own word order.
	licOpera:
		', EUMETNET, which holds the rights to the OPERA composites and distributes them under it, as its',
	licOperaDoc: 'Open Radar Data documentation',
	licOperaAfter:
		' states. Each frame names its producer in its metadata. Modified here: reduced by maximum to the map’s resolution and coloured on the app’s scale.',
	licDwdFronts: ', Deutscher Wetterdienst, as its',
	licDwdFrontsDoc: 'legal notice',
	licDwdFrontsAfter:
		' grants. Modified here: the analyses are reduced to 3000 px wide for print.',
	licSofia: 'Météo-France aeronautical products, via the DGAC briefing portal',
	licEgm96: 'NGA / NASA, US Government public domain',
	licTerrain:
		'built from public elevation models, each redistributed under its own licence and credited below. Only models whose terms allow re-serving are used',
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
		'Figures transcribed from each club aircraft’s flight manual, its supplements and its weighing report, and for each generic type from its manufacturer’s flight manual alone, its sample weighing standing as the empty mass. Every source remains its author’s',
	licUk: '© NATS Limited, for aviation use only, which this is',
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
		'OFMA General Users’ License. Community data from the open flightmaps association, not published by ENAV. Report a data error at',
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
	noaaData: 'METAR, TAF and SIGMET',
	noaaFetched: 'live, through the relay',
	obstaclesAside: (p: { lit: string; windTurbines: string }) =>
		`${p.lit} lit, ${p.windTurbines} wind turbines`,
	mfData:
		'wind, temperature, height and cloud cover at sixteen pressure levels up to 300 hPa (twelve for AROME-OM), and at the surface wind, gusts, temperature, and sea-level and surface pressure. AROME on 0.025° over France and its neighbours to 51 h, AROME-OM on 0.025° over overseas France to 48 h, ARPEGE on 0.1° over Europe to 102 h.',
	mfFetched:
		'from the author’s forecast service, nwp.loxodrome.fr, which reads each run as Météo-France publishes it',
	ecmwfData:
		'wind, temperature, height and relative humidity at eight pressure levels up to 300 hPa, and at the surface wind, gusts, temperature, and sea-level and surface pressure, worldwide on 0.25° to 15 days',
	ecmwfFetched:
		'from the same service, where the Météo-France models do not reach: outside their domains, and past 102 h over Europe or 48 h overseas',
	omData:
		'the models picked in the Weather tab that the service does not carry, UKMO, ICON, GFS, HRRR or Open-Meteo’s best match, up to 500 hPa, and the Météo-France and ECMWF models when the service cannot answer',
	omFetched: 'live, straight from the browser, in those cases only',
	operaData:
		'the CIRRUS maximum-reflectivity composite of European ground radars (1 km, every 5 min), produced by Météo-France, and the NIMBUS rain-rate composite (2 km, every 15 min), produced by GeoSphere Austria',
	operaFetched:
		'live, through the relay, from the Open Radar Data 24-hour cache: the tiles in view for the loop’s last half hour, hour or two hours',
	dwdFrontsData:
		'surface pressure charts with fronts, drawn by DWD forecasters: the North Atlantic and Europe analysis every six hours, and forecasts up to four days ahead',
	dwdFrontsFetched:
		'analyses through the relay from DWD’s open-data server, forecasts straight from www.dwd.de',
	// The optional account, last, in three paragraphs: what it holds, how it
	// is deleted, what its request log keeps. The hosted policy publishes
	// them too (gen-privacy.js).
	privacyAccount:
		'The optional account syncs your flight plans, flights with their traces and imported trace files, aircraft and pilot details between your devices, through api.loxodrome.fr, a fourth Worker the author runs. The pilot details are a name and the validity dates of your SEP and MEP class ratings and medical certificate. It stores your e-mail address, a session record per device, with its name and when it was last seen, and your documents, which it never reads. They sit in Cloudflare’s European storage, the database in Western Europe and the trace files under EU jurisdiction. Cloudflare sends the sign-in codes, and checks the form’s Turnstile challenge, loaded from challenges.cloudflare.com, with your IP address. An address that asks for a code but never becomes an account is kept only as a hash.',
	privacyErase:
		'The Account screen, also at loxodrome.fr/?account=, exports your data, signs you out or deletes the account. Deleting signs every device out at once and erases the server copy after a 7-day grace. Your own devices keep their copies. A plan, a flight or an aircraft you delete leaves a deletion record, kept up to 90 days so your other devices learn of it. Deleted data stays up to 30 days at Cloudflare and up to two months in the author’s daily backups. loxodrome.fr/account-deletion.html sets out the steps.',
	privacyAccountLog:
		'Cloudflare logs each call to api.loxodrome.fr for 7 days, where the author can read it: the address called, the status, the request headers with your IP address, the session token masked, and the approximate location derived from it. Request bodies are never logged, so neither your documents nor a sign-in code is. The service’s own log records only its failures and, by internal identifier, the accounts it erases.',
	privacyHeading: 'Privacy',
	privacyNotam:
		'NOTAMs, when you fetch them, through the relay below: a map-view query goes to autorouter, a route or aerodrome query to the service you pick, autorouter or the French AIS’s SOFIA-Briefing.',
	privacyIntro:
		'Loxodrome has no tracking and no advertising, sets no cookie of its own and needs no account. A briefing you paste or open is read in the browser, never uploaded and never stored.',
	// What never leaves the device, stated before the list of what does.
	// This string is published as well as shown: scripts/gen-privacy.js
	// generates the hosted policy the Play listing points at from this
	// section, so a permission it fails to name is a gap in a document a
	// store reviewer reads.
	privacyPosition:
		'Your position, from the device’s location, is drawn on the map and written to the trace. No request carries it, except that the optional account syncs your recorded flights with their traces. On Android, recording continues in a foreground service, with its notification, when the screen is off. The Android application declares these Android permissions and no others: internet, location, foreground service, notifications, wake lock and vibration. The requests below never carry your fix, but they can show where you are. While the map follows the aircraft, and whenever a flight is recorded or replayed, the terrain tiles under and ahead of the aircraft are fetched whatever the map shows, each up to 10 km on a side. On the web, so are the data files of the countries around it.',
	privacyStored:
		'What you build stays on this device: routes, aircraft, the flight preparation with your pilot details, preferences, and the Flights library and its traces. The Android application keeps it out of Google Drive backups. Restore default settings, in the Settings tab, resets only the preferences, and Reset application… erases stored data by group. Downloaded chart, base-map and document packs, pinned terrain, and cached tiles and data files survive a reset, each pack with its own delete in Offline data.',
	privacyTiles:
		'Map tiles: the base map from its provider (OpenStreetMap, OpenTopoMap, IGN, Google or Microsoft), the chart layers from the chart server below, the Swiss ICAO chart from the Swiss federal WMTS. Offline packs of the charts and of the Plan IGN base map come from the chart server when you ask for one, and the Layers tab and Offline data ask it for new editions.',
	privacyTerrain:
		'Terrain: elevation tiles from the chart server, for routes, profiles, minimum altitudes and airspace alerts, for the readout under a resting pointer and for terrain you pin offline. While a flight is recorded or replayed, also the tile under the aircraft and those ahead of it and in view.',
	privacyProxy:
		'The relay (proxy.loxodrome.fr), the chart server (charts.loxodrome.fr) and the forecast service (nwp.loxodrome.fr) are Cloudflare Workers run by the author. The relay passes on the query, never your address. The forecast service reads the Météo-France and ECMWF runs from their open data on its own schedule, so they receive nothing from you. Each sees what it is asked and your IP address, which the relay and the forecast service hold for about a minute to limit request rates. The relay caches live answers for one to five minutes, published files for a day to a year. It logs only its own failures. The forecast service logs its failures and the model runs it publishes, never a request’s points or your address. The chart server keeps no log.',
	// The page load itself, which the request list above does not cover:
	// on the web it is a request to the host like any other, and in the
	// Android shell there is no such request at all.
	privacyHosting:
		'On the web, the application and its data files come from GitHub Pages through Cloudflare, which see each request. Every loxodrome.fr address asks browsers that support Network Error Logging to report failed connections to Cloudflare. A link that opens a file in the application (?file=) makes your browser fetch it from wherever the link points. The Android application carries its own files.',
	privacySofia:
		'TEMSI and WINTEM, from SOFIA-Briefing through the relay: the chart list when the Weather tab or the print menu opens and every five minutes while the tab is open, the PDFs when printed. A chart opened from the tab comes straight from aviation.meteo.fr.',
	// The DWD front charts: the analyses through the relay (opendata.dwd.de
	// sends no CORS header), the forecasts straight from the browser at
	// www.dwd.de, which serves them with an open CORS header.
	privacyFronts:
		'DWD surface pressure charts: analyses through the relay, forecasts straight from www.dwd.de, listed every fifteen minutes while the Weather tab is open and fetched when printed. A chart opened from the tab comes straight from DWD. None of these requests carries a position.',
	privacyToggleOff:
		'The Live weather switch, in the Settings tab, stops every weather request above and none of the others: map tiles, terrain, VAC plates, NOTAMs, offline packs and the account. Restore default settings and a reset of the settings turn it back on.',
	privacyWeather:
		'METAR, TAF and SIGMET, from the NOAA Aviation Weather Center through the relay: for the aerodromes you open or plan, or the stations around them, and for the stations in view while their layer is on. SIGMETs are fetched for the whole world, with no position.',
	privacyWindsAloft:
		'Forecasts, from the forecast service below: winds, temperatures and clouds along every route of two waypoints or more, over the map view while the wind barbs are on, and at the aerodromes of the performance page. While these are in use, the browser also asks every fifteen minutes which model runs the service holds. It asks Open-Meteo instead for a model, a point or a request the service does not serve, for a day more than a week past, and for ten minutes after the service failed to answer.',
	// The VAC layer's plates: the one map layer read partly through the
	// NOTAM relay, which names the aerodromes in view.
	privacyVac:
		'VAC charts, with their layer on: each plate in view comes from a downloaded pack, else from the chart server, else from the SIA through the relay. These requests name the aerodromes in view.',
	privacyRadar:
		'Precipitation radar, while it is on: the relay is asked for the tiles in view, and fetches whole frames from EUMETNET’s open-data cache, so EUMETNET never learns where you look.',
	refresh: 'Refresh',
	refreshManual: 'manual',
	refreshMonthly: 'monthly (1st)',
	refreshWeekly: 'weekly (Thursdays)',
	refreshFuel: 'weekly (Thursdays), the AIP entries by hand',
	reportIssue: 'Report an issue',
	// How to use: what no tab says. The conditions the map is read at, the
	// toolbar's doors, the map's "what is here?" menu, and the two keys that
	// work everywhere.
	conditionsHint:
		'The toolbar’s Period and Levels set when and at what levels the whole map is read: NOTAMs, airspaces, SUP AIP zones and SIGMETs. The period also sets the hour of the winds aloft.',
	toolbarHint:
		'The toolbar opens the navigation log, the vertical profile, the flight preparation and the Flights library, and its Fly button starts the flight. On a phone, the bar at the foot of the screen opens the pages, and the logo’s menu holds the rest.',
	rightClickHint:
		'Right-click anywhere on the map, or press and hold on a touch screen, for everything at that point. The same menu copies the coordinates, opens the altitude profile there and edits the route, Direct-To included.',
	searchHint:
		'Ctrl+K searches the aerodromes, navaids, waypoints, NOTAMs and actions from anywhere. The ? key lists every shortcut and gesture.',
	runwaysAside: (n: string) => `${n} runways`,
	sofiaData: 'the chart PDFs and their list',
	sofiaFetched:
		'the list while the Weather tab or the print menu is open, the PDFs when printed, through the relay',
	sourceLabel: 'Source:',
	stationCatalogLabel: 'Station catalog',
	stationsAside: (p: { taf: string; countries: string }) =>
		`${p.taf} with TAF, ${p.countries} countries`,
	stationsCount: (n: string) => `${n} stations`,
	supAside: (p: { active: string; withGeometry: string }) =>
		`${p.active} active, ${p.withGeometry} with geometry`,
	supplementsLabel: 'Supplements',
	// The application in a few sentences: what it is, what it does, how it
	// runs. It is named after the course that crosses every meridian at a
	// constant angle (docs/brand.md), not after the NOTAM briefing it grew
	// out of, which is one of the phases below and not the frame the rest
	// hangs off.
	tagline:
		'Loxodrome is a flight-preparation and in-flight navigation application for general aviation. It draws national AIP data from Europe and the United States as an aeronautical chart. On that chart it plans the flight, briefs it and follows it. It is free and open source, runs in a browser or on Android, and needs no account.',
	// The phases of the flight it serves, then the optional account.
	vacGeoAside: (p: { aerodromes: string }) => `${p.aerodromes} aerodromes`,
	vacGeoLabel: 'Placed panels',
	whatItDoesHeading: 'What it does',
	doesChartLabel: 'Chart and AIP',
	doesChart:
		': airspaces, aerodromes, navaids, obstacles, nature reserves, bird areas, sensitive sites and AIP supplements, as each publisher files them, drawn to the ICAO and SIA chart conventions. The official charts stack on top, and the French VAC can be laid in place. An aerodrome opens its runways, frequencies, fuel, charts, weather and NOTAMs, and shows what those NOTAMs close or change. The Android application keeps the charts, the Plan IGN base map and the AIP documents for offline use.',
	doesPrepLabel: 'Flight preparation',
	doesPrep:
		': routes and alternates, typed or drawn on the map, with minimum safe altitudes, cruising levels and forecast winds on every leg, the navigation log and the vertical profile. The fuel plan and its refuelling stops, mass and balance, and takeoff and landing distances against the declared distances of each runway end, from the aircraft’s flight manual figures. It all prints, from the flight preparation and the flight dossier to the weather briefing and A5 kneeboard cards. Routes export as Garmin FPL, GPX, KML or PLN files, or go to SendFPL.',
	doesBriefingLabel: 'Briefing',
	doesBriefing:
		': NOTAMs, pasted or fetched for the map view, the route or an aerodrome, each linked to what it concerns on the chart, with the zones it activates hatched and what it closes or changes marked. METAR, TAF and SIGMET, winds and temperatures aloft, the precipitation radar, DWD surface pressure charts, and TEMSI and WINTEM charts.',
	doesFlightLabel: 'In flight',
	doesFlight:
		': the map follows the aircraft. The in-flight readout gives the frequency in force, the heading to steer and the times ahead, and alerts warn of the airspace, terrain and obstacles ahead. Direct-To reroutes from the present position. The navigation log records the actual times, and the takeoff and landing are detected. Afterwards the trace replays on the map, exports as GPX, IGC or KML, and joins the Flights library and its logbook.',
	doesAccountLabel: 'Optional account',
	doesAccount:
		': sign in with a code sent by e-mail, and your flight plans, flights, aircraft and pilot details follow you between your devices, a shared computer included. Without an account they never leave the device. Delete it at any time from the application.',
	terrainFetched:
		'on demand from the chart server, cached for offline use. Live weather does not turn it off.',
	terrainData:
		'ground elevation and the highest and lowest ground around each point, for the cursor readout, the profiles, minimum safe altitudes, heights above ground, the terrain shading and the terrain alerts',
	egm96Data:
		'the geoid’s height above the WGS 84 ellipsoid on a one-degree grid, bundled. It turns a GNSS height into an altitude above mean sea level.',
	wmmData:
		'World Magnetic Model 2025 coefficients, bundled, for every magnetic track, heading and radial, valid 2025.0 to 2030.0',
	wmmExpired:
		'The model expired at the end of 2029. Headings use its 2030.0 declination until the WMM2030 coefficients ship.',
	wmmExpiredLabel: 'Validity',
};
