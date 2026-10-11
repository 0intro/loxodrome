/* Route tab: the route tab strip, waypoint list, leg cues, flight
 * parameters, the minimum-safe-altitude group and the route NOTAM fetch
 * (the route-corridor map filters live in layers.ts, the nav-log content
 * toggles in navlog.ts). Locale-invariant:
 * ICAO Doc 8400 abbreviations (ETE, TAS, W/V, FL, QDR, QDM), VFR / IFR,
 * unit tokens (ft, NM, kt, ° true), fmtLevel / fmtAlt / fmtTrack output,
 * idents and product names (Open-Meteo, SOFIA-Briefing, autorouter, YAML). */

import { andList, plural } from './plural';

/** "leg 3", "legs 3 and 4", "legs 2, 3 and 5": the legs a forecast misses. */
function legsList(legs: readonly number[]): string {
	return `${plural(legs.length, 'leg', 'legs')} ${andList(legs)}`;
}

export const route = {
	actionsMenu: 'Route actions',
	actionsMenuUnstored: 'Route actions, unstored flight plan changes',
	activeWord: 'ACTIVE',
	addFieldPlaceholder: 'Idents or coords, e.g. LFPL N48,8200/E2,62000 LFQB',
	addRoute: 'Add route',
	airspacesOnRouteOnly: 'Show only route airspaces',
	airspacesOnRouteOnlyTip:
		'Show only the airspaces any route flies through at its planned altitude, hiding all others and overriding the airspace category toggles.',
	alternateRoute: 'Alternate route',
	alternateRouteTip:
		"Mark this route as the alternate (diversion) of the preceding trip route; the fuel plan counts it in that trip's reserves (order routes as trip, alternate, trip, ...).",
	applyAll: 'Apply all',
	bandActivatedBy: 'Activated by NOTAM',
	clearAllRoutes: 'Clear all routes',
	clearAllRoutesConfirm: 'Remove every route? One empty route is left, and undo restores them.',
	clearAllRoutesAction: 'Clear all',
	clearAllRoutesTip: 'Remove every route and start again from one empty route',
	clearRoute: 'Clear active route',
	clearRouteTip: 'Remove all waypoints from the active route',
	clearWindAria: 'Clear the wind override',
	clearWindTip: 'Clear the override (back to the forecast or global wind)',
	closeRoute: 'Close route',
	clouds: 'Clouds',
	/** A Clouds row or section over a clear column. */
	cloudsNone: 'None forecast',
	cloudsTip:
		"Show the forecast cloud cover as grey layers along the route (FEW to OVC): the model's cloud fraction on its pressure levels, AROME's, AROME-OM's and ARPEGE's own, derived from the relative humidity for IFS and every model Open-Meteo serves",
	corridor: 'Corridor',
	corridorTip:
		'Corridor half-width (NM each side) used both to fetch route NOTAMs below and by the Show only route NOTAMs filter.',
	couldNotFind: (list: string) => `Could not find: ${list}`,
	coverageWithin: (p: { a: number; f: number; nm: number }) =>
		`${p.a} ${plural(p.a, 'airport', 'airports')} + ${p.f} ${plural(p.f, 'FIR', 'FIRs')} within ${p.nm} NM of the active route.`,
	crossesForbidden: 'Route crosses prohibited or active airspace',
	/* The strip's folded NO-GO pill; the full sentence above rides its
	   title and a screen-reader span. */
	crossesForbiddenShort: 'Entry prohibited',
	crossesLabel: 'Crosses',
	crossingsCount: (n: number): string => (n === 1 ? '1 crossing' : `${n} crossings`),
	crossingsOpenAria: 'Open the list of crossed airspaces',
	cruise: 'Cruise',
	cruiseCustom: 'Custom: your own figures',
	cruiseFromSheet: (plane: string) => `${plane} sheet`,
	cruiseLphAria: 'Fuel flow (L/h)',
	cruiseNoAircraft: 'Default, no aircraft selected',
	cruiseSettingAria: 'Cruise setting',
	cruiseSettingLost: (name: string) => `${name} is not on this aircraft’s sheet: its default setting flies.`,
	cruiseSettingOption: (p: { name: string; kt: number; lph: string | null }) =>
		`${p.name}, ${p.kt} kt${p.lph !== null ? `, ${p.lph} L/h` : ''}`,
	cruiseSettingTip: 'The aircraft’s cruise settings from its flight manual, each a speed with its fuel flow. Type in the boxes below to plan your own.',
	cruiseSheetDefault: 'Sheet cruise',
	cruiseSpeedAria: 'Cruise speed (kt)',
	cruiseTip:
		"The speed and fuel flow this flight plan flies with. In grey, those of the aircraft's setting (100 kt without an aircraft): type to plan your own, empty a box to return to it. The aircraft's settings are set in the Aircraft tab.",
	cruisingLevelAdvisory: 'Cruising level advisory',
	ctxAirspaces: (n: number) => `Airspaces (${n})`,
	// i18n note: "Classe G" is the invariant SIA class token (the "Classe A"
	// nav-log precedent); only the qualifier translates.
	ctxClassG: 'Classe G (uncharted)',
	ctxNoAirspace: 'No airspace here',
	ctxNotams: (n: number) => `NOTAMs (${n})`,
	customPoint: 'Custom point',
	datasetsLoading: 'Datasets still loading…',
	defaultAlt: 'Default alt',
	exportFpl: 'FPL, Garmin flight plan',
	exportFplTip: 'Read by ForeFlight, Garmin Pilot and panel-mount Garmin navigators',
	exportGpx: 'GPX, route and waypoints',
	exportGpxTip: 'Read by most navigation and mapping software',
	exportKml: 'KML, Google Earth',
	exportKmlTip: 'The route drawn in space, for Google Earth',
	exportPlan: 'Export the whole plan\u2026',
	exportPlanTip: 'Write every trip, chained as one route, as a file for another application',
	exportPlanTitle: 'Export plan',
	exportPln: 'PLN, flight simulator',
	exportPlnTip: 'Read by Flight Simulator and Prepar3D',
	exportRoute: 'Export route\u2026',
	exportRouteTip: 'Write the active route as a file for another application',
	exportRouteTitle: 'Export route',
	extentUnknownShort: 'extent unstated',
	fasterLevels: (min: number) =>
		`Faster levels available, -${min} min total (cruise time only).`,
	fetchCoversAll: (n: number) => `The fetch covers all ${n} routes.`,
	fetchTipReady: 'Fetch airport + enroute NOTAMs within every route corridor',
	fetching: 'Fetching…',
	fetchingProgress: (p: { done: number; total: number }) =>
		`Fetching ${p.done} of ${p.total}…`,
	fitAria: 'Fit',
	fitTip: 'Fit to window',
	flightParams: 'Flight parameters',
	flightPreparation: 'Flight preparation',
	flightRules: 'Flight rules',
	forecastInstead: (p: { dur: string; note: string | null }) =>
		`Forecast instead: ${p.dur}${p.note ? `, ${p.note}` : ''}`,
	freezingLevel: 'Freezing level',
	freezingLevelTip: 'Show the forecast freezing level as a dashed 0 °C line across the profile',
	getNotamsMany: 'Get NOTAMs for routes',
	getNotamsOne: 'Get NOTAMs for route',
	hintStart:
		'Type idents or coordinates above (e.g. N48492E002372 or N48,8200/E2,62000), or right-click the map (long press on a touch screen) and add a waypoint. Then drag a waypoint to move it, or a leg to insert one.',
	kindAirport: 'Airport',
	kindNavaid: 'Navaid',
	legAltAria: (n: number) => `Leg ${n} altitude`,
	legAltTip:
		'Leg altitude (ft). In grey, the automatic altitude: type to set your own, empty the box to return to it.',
	legFlTip:
		'Leg flight level. In grey, the automatic level: type to set your own, empty the box to return to it.',
	legWindAria: 'Leg wind',
	/** The W/V chip's name: the leg and the wind it plans (fmtWind output), or none. */
	legWindChipAria: (p: { n: number; wind: string | null }) =>
		p.wind ? `Leg ${p.n} wind, ${p.wind}` : `Leg ${p.n} wind, none planned`,
	liveWeatherOffNote:
		'Forecast winds and temperature-corrected TAS need Live weather. Turn it on in the Settings tab.',
	loadRoutes: 'Load routes',
	loadTip: 'Load a plan from a YAML, FPL, GPX, KML or PLN file',
	loadedFirstN: (n: number) => `Only the first ${n} routes were loaded.`,
	loadingDatasets: 'Loading datasets…',
	magneticTrackTip: 'Magnetic track',
	minAlt: 'Min-alt corridor',
	minAltAria: 'Minimum-altitude corridor half-width (NM each side)',
	minAltDanger: 'Highlight terrain above route',
	minAltDangerTip:
		"Highlight the patches of the minimum-altitude corridor (width above) where the terrain or obstacle minimum safe altitude, plus the flight-rules margin (500 ft VFR, 1000 ft IFR, 2000 ft IFR over mountainous terrain), is higher than the active route's planned leg altitude: exactly where flying the planned level busts the clearance floor.",
	minAltTip:
		"How far from the track (NM) terrain and obstacles are counted for each leg's minimum safe altitude: either side of it, and around each waypoint",
	moveDown: 'Move down',
	moveUp: 'Move up',
	msaTip:
		"Per-leg minimum safe altitude: highest ground or obstacle within the min-alt corridor plus the flight-rules margin (500 ft VFR, 1000 ft IFR, 2000 ft IFR over mountainous terrain), rounded up to the next 100 ft (the nav log's MSA column)",
	navigationLog: 'Navigation log',
	newRoute: 'New route',
	nextRoute: 'Next route',
	noCorridorYet: 'The active route has no corridor yet.',
	noFasterLevel: 'No faster level',
	noMatch: (q: string) => `No airport or navaid matches “${q}”.`,
	noWindPlanned: 'No wind planned',
	notams: 'NOTAMs',
	notamsForRoute: 'NOTAMs for route',
	notamsOnRouteOnly: 'Show only route NOTAMs',
	notamsOnRouteOnlyTip:
		"Show only the NOTAMs within any route's corridor (the corridor width above): areas, positions and radii are tested against the track, FIR-wide NOTAMs kept for crossed FIRs. Applies to the map and every list, on any loaded briefing, fetched or pasted.",
	notamsTip:
		'Draw the NOTAM areas the route track crosses as hatched orange bands (restrictions, warnings, obstacles) between their published limits, and hatch the airspace bands activated by NOTAM in the evaluation window',
	obstacles: 'Obstacles',
	obstaclesTip:
		"Show the obstacles within the min-alt corridor (the nav log's minimum-altitude width) at their charted top altitude",
	oeiAirForecast: (dev: string) => `forecast ISA ${dev}`,
	oeiAirIsa: 'ISA, no forecast temperature',
	oeiCeilingLayer: 'One engine ceiling',
	oeiCeilingLayerTip:
		'The one engine inoperative net ceiling over each leg, at the trip’s take-off mass in the forecast’s air (ISA without it), to read against the MSA',
	oeiMassMax: (kg: number) => `the maximum take-off mass, ${kg} kg, the trip’s being unknown`,
	oeiMassTrip: (kg: number) => `the trip’s take-off mass, ${kg} kg`,
	oeiOpenProfile: 'Click to open the profile.',
	onBoardDropped: (date: string) =>
		`The fuel on board read on ${date} was left out: read the journey log again for this flight.`,
	onlyClosest: (max: number) => `Only the closest ${max} airports will be queried.`,
	openPlans: 'Stored plans',
	pastFlightDateDropped: (date: string) =>
		`The plan's flight date, ${date}, was already past: the dossier now plans for today.`,
	paramCruise: (p: { kt: number; from: string }) => `Cruise ${p.kt} kt (${p.from})`,
	paramCruiseLost: (name: string) => `setting ${name} not on the sheet`,
	paramCruiseDefault: (kt: number) => `Cruise ${kt} kt (default)`,
	paramCruiseManual: (p: { kt: number; lph: string | null }) =>
		`Cruise ${p.kt} kt${p.lph !== null ? `, ${p.lph} L/h` : ''} (manual)`,
	paramCruiseSetting: (p: { setting: string; kt: number; from: string }) => `Cruise ${p.setting}, ${p.kt} kt (${p.from})`,
	paramLegWinds: (n: number) => `${n} ${plural(n, 'leg', 'legs')} with a manual wind`,
	paramSemicircularOff: 'semicircular levels off',
	paramSemicircularOn: 'semicircular levels',
	paramTa: (ft: string) => `TA ${ft} ft`,
	paramTaManual: (ft: string) => `TA ${ft} ft (manual)`,
	paramTempTas: 'TAS corrected for temperature',
	paramWindForecast: 'forecast winds',
	paramWindManual: (wv: string) => `manual wind ${wv}`,
	paramWindMissed: (legs: readonly number[]) => `no forecast for ${legsList(legs)}`,
	paramWindNone: 'no wind',
	paramsFoldTip: 'What the plan flies with. Unfold to change it.',
	placedApprox: (list: string) => `Placed approximately: ${list}.`,
	planningOptions: 'Planning options',
	prevRoute: 'Previous route',
	print: 'Print',
	profileAddWaypoints: 'Add at least two waypoints to draw a vertical profile.',
	profileEteTip: 'Total estimated time en route, wind corrected where winds resolve',
	readoutGround: 'Ground',
	readoutHint: 'Right-click or long-press: airspaces',
	/** The hint while the cloud curtain is drawn, the menu listing the
	 *  clouds too. */
	readoutHintClouds: 'Right-click or long-press: airspaces and clouds',
	readoutLevel: 'Level',
	redo: 'Redo',
	redoTip: 'Redo (Ctrl+Y)',
	remove: 'Remove',
	renameAria: 'Route name',
	restoreFailed: 'Your saved flight plan could not be restored: the airport and navaid data did not load.',
	restoreLossy: 'Your saved flight plan came back incomplete: some waypoints could not be resolved yet.',
	restoreParse: 'Your saved flight plan could not be read.',
	restoreRescued: 'Your previous flight plan was kept in the flight plan catalog, in the Flights surface.',
	restoreRetry: 'Restore it',
	restoreRetryTip: 'Try restoring the saved flight plan again',
	restoreSheltered: 'Your previous flight plan is set aside. It will be kept in the flight plan catalog at the next start.',
	routeProfileAria: 'Route vertical profile',
	routesAria: 'Routes',
	saveRoutes: 'Save routes',
	saveTip: 'Download all routes as a YAML file',
	saving: 'Saving…',
	storePlan: 'Store flight plan',
	storePlanTip:
		'Write the active flight plan back over its entry in the flight plan catalog (the Flights surface, Plans view). Greyed when nothing has changed since the plan was activated, and when the workspace is not a catalog plan at all: activate one there, or use Store as new.',
	storePlanAs: 'Store as new flight plan',
	storePlanAsTip: 'Add the active flight plan to the flight plan catalog under its aerodrome-chain name',
	storedNotice: 'Flight plan stored in the catalog.',
	storedAsNotice: 'Stored as a new flight plan in the catalog.',
	storeConflictConfirm:
		'The stored plan changed in the catalog since you activated it. Replace it with the active flight plan?',
	storeConflictAction: 'Replace',
	storeLossyConfirm:
		'This copy lost waypoints when it was activated (the data has changed). Store it anyway, replacing the fuller original?',
	storeLossyAction: 'Store',
	scrollLeft: 'Scroll routes left',
	scrollRight: 'Scroll routes right',
	semicircular: 'Semicircular cruising levels',
	semicircularTip:
		"Snap auto leg altitudes to the semicircular cruising levels for each leg's magnetic track, above 3000 ft over the surface in VFR, from the lowest usable level in IFR (SERA Appendix 3). Manually set legs are flagged, never rewritten.",
	sendFpl: 'Send this route to SendFPL',
	sendFplCopied: 'Route copied to the clipboard, ready to paste into SendFPL.',
	sendFplCopy: 'Copy this route for SendFPL',
	sendFplCopyTip:
		'Copy the route to the clipboard, ready to paste into the SendFPL route box',
	sendFplFailed: 'Could not hand the route over.',
	sendFplPlan: 'Send the whole plan to SendFPL',
	sendFplPlanCopy: 'Copy the whole plan for SendFPL',
	sendFplPlanCopyTip:
		'Copy every trip chained into one route, alternates excluded, ready to paste into the SendFPL route box',
	sendFplPlanTip:
		'Open SendFPL with every trip chained into one route, alternates excluded, to upload it to the navigator',
	sendFplTip: 'Open SendFPL with the active route, to upload it to the navigator',
	sizing: 'Sizing…',
	skippedMore: (n: number) => `and ${n} more`,
	skippedUnresolved: (list: string) => `Skipped unresolved: ${list}.`,
	sliderAltBottomAria: 'Bottom of the altitude window (ft)',
	sliderAltTopAria: 'Top of the altitude window (ft)',
	sliderDistEndAria: 'End of the distance window (NM)',
	sliderDistStartAria: 'Start of the distance window (NM)',
	sofiaCorridor: (p: { nm: number }) =>
		`SOFIA-Briefing scans ${p.nm} NM each side of the route.`,
	sofiaFetchTip: 'Fetch route NOTAMs directly from SOFIA-Briefing, the French SIA service (no account needed)',
	sofiaFetchedAt: (p: { n: number; time: string }) =>
		`${p.n} ${plural(p.n, 'NOTAM', 'NOTAMs')} fetched from SOFIA at ${p.time}.`,
	sourceAria: 'NOTAM source',
	stopFetch: 'Stop',
	stopFetchTip: 'Stop the briefing; the routes already fetched are kept',
	sourceAutorouter: 'autorouter',
	sourceAutorouterHint: 'Eurocontrol EAD',
	sourceSofia: 'SOFIA',
	sourceSofiaHint: 'French SIA (DSNA)',
	suggestionApplyAria: (p: { level: string; min: number }) =>
		`Set the leg to ${p.level}, saving ${p.min} minutes`,
	suggestionTip: (p: { bestEte: number; bestLevel: string; curEte: number; curLevel: string }) =>
		`Fastest level for this leg by forecast wind, cruise time only (climb not counted): ETE ${p.bestEte} min at ${p.bestLevel} instead of ${p.curEte} min at ${p.curLevel}.\nClick to apply (the leg then keeps this level until reset).`,
	summaryCruise: (p: { dur: string; kt: number }) => `${p.dur} at ${p.kt} kt`,
	summaryTotal: (nm: string) => `Total ${nm} NM`,
	switchRoute: 'Switch route',
	taTipAip: (ident: string) =>
		`Automatic, the lowest AIP transition altitude among the route aerodromes (${ident}).`,
	taTipBase:
		'Transition altitude (ft), leg altitudes above it are shown and edited as flight levels.',
	taTipBlanket: (region: string) => `Automatic, the ${region} blanket transition altitude.`,
	taTipDefault:
		'Automatic, the default 5000 ft (no aerodrome transition altitude on the routes).',
	taTipManual: 'Manual override, clear the field to use the AIP value.',
	tabTip: 'Double-click to rename, drag to reorder, middle-click to close',
	tempTas: 'Temperature-corrected TAS',
	tempTasTip:
		"Correct the cruise TAS for the forecast temperature at each leg's level (about 2 percent per 10 °C of ISA deviation). Off keeps the entered cruise speed on every leg.",
	terrainLoading: 'Loading terrain…',
	terrainTint: 'Terrain proximity',
	terrainTintTip: 'Terrain in red where the clearance is below 500 ft AGL',
	terrainUnavailable: 'Terrain unavailable',
	transition: 'Transition',
	twoWaypointsHint: 'Add at least two waypoints.',
	undo: 'Undo',
	undoTip: 'Undo (Ctrl+Z)',
	unknownAircraft: (key: string) =>
		`Aircraft ${key} is not in your fleet; import it in the Aircraft tab.`,
	verticalProfile: 'Vertical profile',
	vfrTip:
		"VFR/IFR flight rules. Also drives the NOTAM Flight-rules filter (VFR hides IFR-only NOTAMs, IFR hides VFR-only); override it in the NOTAMs tab's filters.",
	warnNoLevelFits: 'No semicircular cruising level fits this leg',
	warnNotSemicircular: (p: { track: string; fix: string }) =>
		`Not a semicircular cruising level for a magnetic track of ${p.track}, click to set ${p.fix}`,
	warnOei: (p: { ceiling: string; msa: string; basis: string }) =>
		`One engine inoperative, the net ceiling is ${p.ceiling} ft, under this leg’s MSA of ${p.msa} ft (${p.basis}).`,
	warnOeiNoClimb: (p: { msa: string; basis: string }) =>
		`One engine inoperative, no net climb even at sea level, under this leg’s MSA of ${p.msa} ft (${p.basis}).`,
	warnOeiTableTop: (p: { ceiling: string; msa: string; basis: string }) =>
		`One engine inoperative, the climb table ends at ${p.ceiling} ft, under this leg’s MSA of ${p.msa} ft (${p.basis}).`,
	warnTransitionLayer: (p: { ta: string; tl: string }) =>
		`Within the transition layer, between the transition altitude ${p.ta} ft and the transition level ${p.tl}`,
	waypointNameAria: 'Waypoint name',
	weatherDropped:
		'The weather typed for the flight this plan was stored for (its winds, the performance page’s QNH, temperatures and winds) was left out: it flies today’s forecast.',
	wind: 'Wind',
	windBrief: (p: { source: string; mean: string }) => `${p.source}, ${p.mean}`,
	windBriefLight: 'wind light and variable',
	windBriefMean: (wv: string) => `mean wind ${wv}`,
	windBriefVaries: 'wind varies along the route',
	windBarbs: 'Wind barbs',
	windBarbsTip: "Show each leg's wind as a station-model barb (plan-view orientation, north up)",
	windChipTip:
		'Click to set a manual wind for this leg. In the editor, the wind in force shows in grey: empty both boxes to return to it.',
	windDegTrue: '°T',
	windDirAria: 'Leg wind direction (degrees true)',
	windDirGlobalAria: 'Wind direction (degrees true)',
	windFetching: 'Fetching the forecast...',
	windManualNone: 'No wind typed: the legs are planned in still air.',
	windMissedDirAria: 'Wind direction where there is no forecast (degrees true)',
	windMissedNote: (legs: readonly number[]) => `No forecast for ${legsList(legs)}. They fly this wind:`,
	windMissedSpeedAria: 'Wind speed where there is no forecast (knots)',
	windMissedTip: 'The wind the legs without a forecast fly (° true, kt). Empty, they are planned in still air.',
	windUnusedNote: 'For the legs without a forecast, none now:',
	windSource: 'Wind source',
	windSourceForecast: 'Forecast',
	windSourceForecastTip: 'Each leg flies the forecast wind at its own altitude and time (Weather tab). A leg’s W/V chip overrides it.',
	windSourceManual: 'Manual',
	windSourceManualTip: 'Every leg flies the wind typed here (° true, kt). A leg’s W/V chip still overrides it.',
	windSpeedAria: 'Leg wind speed (knots)',
	windSpeedGlobalAria: 'Wind speed (knots)',
	wpNumTip: 'Drag to reorder, click to center on the map',
};
