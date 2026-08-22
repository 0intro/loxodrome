/* Settings tab: every preference, organized by section (NOTAM markers,
 * content languages, live data and position, appearance, the reset). The
 * FR / EN segment values are locale codes, kept inline. */

export const display = {
	affectedAirspaces: 'Show affected airspaces for the selected NOTAM',
	affectedAirspacesTip:
		'On: when a selected NOTAM names airspaces, highlight them on the map instead of its Q-line radius circle. The circle can still be shown per-NOTAM from the detail panel.',
	aipRemarkLang: 'AIP remark language',
	aipRemarkLangTip:
		'Language of the SIA AIP free-text remarks in the airspace and obstacle panels, when a remark is published in both English and French. Auto follows the app language. A single-language remark is shown as published.',
	cursorCoords: 'Show cursor coordinates on the map',
	gpsAltAuto: 'Auto',
	gpsAltDatum: 'GPS altitude datum',
	gpsAltDatumTip:
		'What this device measures its GNSS altitude from. Auto follows the platform: Apple devices report an altitude above mean sea level, everything else a height above the WGS84 ellipsoid, which the geoid separation then corrects (about 150 ft over France). Pin it if the shown altitude disagrees with the field elevation on the ground.',
	gpsAltEllipsoid: 'Ellipsoid',
	gpsAltEllipsoidTip: 'The device reports a height above the WGS84 ellipsoid (the W3C default).',
	gpsAltMsl: 'MSL',
	gpsAltMslTip: 'The device already reports an altitude above mean sea level (Apple platforms).',
	hideAirportNotamMarkers: 'Hide airport NOTAM markers',
	hideAirportNotamMarkersTip:
		'On: hides the blue Q-line (fallback) markers of airport NOTAMs; their red position markers, circles, and areas stay, and they remain reachable via the airport cue ring and detail panel. Applies when airports are shown (Layers tab).',
	langAuto: 'Auto',
	liveWeather: 'Live weather (METAR and TAF)',
	liveWeatherTip:
		"Fetch current METAR and TAF (NOAA Aviation Weather Center) for the airport panel's Weather section and the flight-prep performance defaults. Off disables every weather fetch and is remembered across sessions.",
	nightDim: 'Night dimming',
	nightDimTip:
		'Brightness of the map raster in the night theme; the symbology keeps full contrast. Recording past civil twilight switches to the night theme by itself, back at dawn or when the recording stops.',
	notamMarkersLegend: 'NOTAM markers',
	profileAllAirspaces: 'Vertical profiles show all airspaces',
	profileAllAirspacesTip: 'Off: plot only the airspaces currently shown on the map (Layers tab)',
	qlineMarkers: 'Show Q-line position markers',
	qlineRadius: 'Show radius circle on selected Q-line positions',
	reset: 'Reset application…',
	resetConfirm: 'Erase and reload',
	resetFinePrint:
		'Offline caches (map tiles, aeronautical datasets) are kept: maps already downloaded survive the reset.',
	resetGroupAircraft: 'My aircraft and pilot details',
	resetGroupBriefing: 'Briefing, routes and traces',
	resetGroupFlights: 'Recorded flights (the flights library)',
	resetGroupSettings: 'Settings and preferences',
	resetIntro: 'Erase the selected data stored on this device, then reload the application.',
	resetTitle: 'Reset the application',
	sectionAppearance: 'Appearance',
	sectionLanguages: 'Content languages',
	sectionPosition: 'Position',
	sectionLiveData: 'Live data',
	showInAirspaces: 'Show geometric "In airspaces" lists',
	showInAirspacesTip:
		'Location-based lists: the airspaces a NOTAM sits in (NOTAM panel) and the NOTAMs inside an airspace (airspace panel). The explicit named / designator / activation links are always shown.',
	sofiaLang: 'SOFIA NOTAM language',
	sofiaLangTip:
		'Language of the NOTAM text downloaded from SOFIA-Briefing, when both an English and a French form are provided. Auto follows the app language.',
	supaipLang: 'SUP AIP language',
	supaipLangTip:
		'Language of the SUP AIP subject text shown in the detail panel and NOTAM chips (when an English version exists). Auto follows the app language. The PDF is always linked in both languages.',
	title: 'Settings',
	traceExportFormat: 'Format for recorded traces',
	traceExportFormatTip:
		'Which file a trace RECORDED by this application is written as, from the Navigation tab, a flight row, or the whole archive at once.',
	traceExportImported: 'An imported trace is exported exactly as it arrived.',
	traceConvertImported: 'Convert imported traces to this format',
	traceConvertImportedTip:
		'Rewrite imported traces in the format above instead of handing back the file they came in. Off by default: this application does not record everything another logger wrote, so a rewritten file would not be the one that was imported.',
	traceExportGpxTip: 'Universal track format, read by every mapping and logbook tool.',
	traceExportIgcTip:
		'Gliding and OLC format. Written as a non-approved recorder, with no security record, so it suits a debriefing but never a badge or record claim.',
	traceExportKmlTip:
		'Google Earth: the flight replays along its time slider, with its altitude profile.',
	typeIcons: 'Obstacle-type icons on markers',
};
