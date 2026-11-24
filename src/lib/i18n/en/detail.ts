/* Detail-panel chrome: header subtitles, the back-navigation labels
 * (whole sentences per kind, so French prepositions contract correctly:
 * "Retour au NOTAM", "Retour à l'aérodrome"), and the feature panels'
 * shared rows, section headings and tooltips (airport / airspace /
 * obstacle / navaid / nature / SUP AIP). Sections only the NOTAM panel
 * shows live in ./notam.ts. ICAO Doc 8400 abbreviations (LDA, TORA,
 * TODA, ASDA, Mnm, Max, RAI, ARP) stay invariant; the tooltips spell
 * them out. */

import { plural } from './plural';

export const detail = {
	accessCapTip: 'Open to public air traffic',
	accessRestrictedTip: 'Restricted use',
	activatedBy: 'Activated by',
	/** On a NOTAM activating it in the toolbar's period, which runs from now
	 *  on by default: a NOTAM activating it next week included. */
	activatesAirspaceInPeriodTip: 'This NOTAM activates this airspace in the period',
	activatesSupInPeriodTip: 'This NOTAM activates this supplement in the period',
	activationWindowTip: 'Activation window',
	activationWindowZoneTip: 'Activation window for this zone',
	activeAltitudeFilter: 'Active altitude filter',
	// The airport panel's own NOTAM fetch: the NOTAMs FILED UNDER the
	// aerodrome (Item A), put into the loaded briefing in place of what the
	// answer speaks for (state/aerodromeNotams.ts).
	adNotamsBusyTip: 'A NOTAM fetch is already running',
	adNotamsCovering: (span: string) => `Covering ${span}.`,
	adNotamsFetched: (p: { n: number; ident: string; source: string; time: string }) =>
		p.n === 0
			? `Fetched from ${p.source} at ${p.time}: no NOTAM filed under ${p.ident}.`
			: `Fetched from ${p.source} at ${p.time}: ${p.n} ${plural(p.n, 'NOTAM', 'NOTAMs')} filed under ${p.ident}.`,
	adNotamsFetching: (p: { ident: string; source: string }) =>
		`Fetching the NOTAMs filed under ${p.ident} from ${p.source}…`,
	adNotamsGet: 'Get NOTAMs',
	adNotamsKept: (n: number) => `${n} from the earlier briefing kept, not covered by this fetch.`,
	adNotamsKeptTip: (ids: string) =>
		`Outside the period this fetch covered, or not in force during it: ${ids}`,
	adNotamsRefresh: 'Refresh',
	adNotamsStopTip: 'Stop the fetch. The loaded NOTAMs stay as they are.',
	adNotamsTip: (p: { ident: string; source: string }) =>
		`Fetch the NOTAMs filed under ${p.ident} from ${p.source} and replace them in the loaded briefing`,
	adNotamsUnchanged: 'The loaded NOTAMs are unchanged.',
	adNotamsUnconfirmed: (p: { n: number; source: string }) =>
		`${p.n} from the earlier briefing kept, not confirmed by ${p.source}.`,
	adNotamsUnconfirmedTip: (ids: string) =>
		`Missing from this answer yet not taken as withdrawn, being another source's, pasted, or met with an empty answer: ${ids}`,
	adNotamsWithdrawn: (n: number) => `${n} withdrawn since the earlier briefing.`,
	adNotamsWithdrawnTip: (ids: string) => `Cancelled or replaced since: ${ids}`,
	aerodromeInfo: 'Aerodrome information',
	aerodromes: 'Aerodromes',
	affectingNotamsAirport: 'Affecting NOTAMs',
	affectingNotamsAirspace: 'Affecting NOTAMs',
	affectingNotamsNavaid: 'Affecting NOTAMs',
	affectingNotamsObstacle: 'Affecting NOTAMs',
	aglTip: 'Above ground level',
	airacSupTip: 'AIRAC-cycle supplement',
	airport: 'Airport',
	airspace: 'Airspace',
	airspaceAboveFree: (p: { ft: string; zone: string }) => `${p.ft} ft free below ${p.zone}`,
	airspaceAboveHidden: 'the airspace above is one the chart is not drawing',
	airspaceAboveLabel: 'Airspace above:',
	airspaceAboveNone: 'no controlled or restricted airspace above',
	airspaceAboveTip:
		'The base of the lowest controlled or restricted airspace above the ground at this point, and the free height below it. Transit areas, RMZ / TMZ, FIS sectors and activity zones are drawn but not counted: their limits are conditional, not a ceiling.',
	airspaceCount: (n: number) => `${n} ${plural(n, 'airspace', 'airspaces')}`,
	airspacesOverhead: 'Airspaces overhead',
	altitudeProfile: 'Altitude profile',
	amslTip: 'Above mean sea level',
	asdaTip: 'Accelerate-stop distance available (metres; one value per runway end, ordered as the Runway column)',
	backToAirport: (id: string) => `Back to airport ${id}`,
	backToAirspace: (id: string) => `Back to airspace ${id}`,
	backToAltitudeProfile: 'Back to altitude profile',
	backToNature: (name: string) => `Back to zone ${name}`,
	backToNavaid: (ident: string) => `Back to navaid ${ident}`,
	backToNotam: (id: string) => `Back to NOTAM ${id}`,
	backToObstacle: (id: string) => `Back to obstacle ${id}`,
	backToPlace: (name: string) => `Back to ${name}`,
	backToPosition: 'Back to the position',
	backToSigmet: 'Back to SIGMET',
	backToStation: (id: string) => `Back to station ${id}`,
	backToSupaip: (title: string) => `Back to SUP AIP ${title}`,
	backToTraceProfile: 'Back to trace vertical profile',
	backToVerticalProfile: 'Back to vertical profile',
	centerPositionTip: 'Center the map on this position',
	/* Direct-To on the aerodrome sheet (route/directTo.ts). */
	directTo: (ident: string) => `Direct to ${ident}`,
	directToTip:
		'Fly direct from the present position: an alternate route to this aerodrome is appended to the plan and flown from now on. The plan itself is untouched.',
	directToPointTip:
		'Fly direct from the present position: an alternate route to this point is appended to the plan and flown from now on. The plan itself is untouched.',
	directToFull: (n: number) =>
		`The plan already holds its ${n} routes: remove one before adding a direct-to.`,
	directToPosition: 'Direct to this position',
	channel: 'Channel',
	coordsCopied: 'Coordinates copied',
	chartAd: 'Aerodrome charts',
	chartAdDe: 'German VFR eAIP',
	chartAdDeTip: 'Opens the DFS German VFR eAIP; search for the aerodrome',
	chartAdDePageTip: 'Opens the aerodrome page of the DFS VFR eAIP (current edition)',
	chartAdEsTip: 'Open the aerodrome charts list, visual and instrument, in the ENAIRE AIP viewer',
	chartAdUkTip: 'Open the UK AIP AD 2 aerodrome page with its visual and instrument charts (NATS, current AIRAC)',
	chartAdUsTip: 'Opens the FAA airport diagram (current d-TPP cycle); the list below has all terminal procedures',
	chartAdAtTip: 'Opens the aerodrome section of the Austro Control eAIP (AD 2 / AD 3, current edition)',
	chartAdAipTip: (publisher: string) => `Opens the aerodrome page as ${publisher} publishes it (edition in force)`,
	chartAdBeTip: 'Open the AIP Belgium and Luxembourg aerodrome page with its visual and instrument charts (skeyes, current cycle)',
	// Chart-family names, keyed by the stored chart-family code (the grouped
	// list in the airport panel): ICAO Annex 4 titles where one exists, the
	// SIA products' own bilingual PDF titles otherwise (AMG / AMSR / MVA /
	// DEP / ENV, verified against the published sheets). Official titles use
	// a dash before "instrument"; rendered as a hyphen (repo rule: no
	// em-dashes). Codes without a label here (MIA, ATS) fall back to the
	// raw code header.
	chartFamilies: {
		IAC: 'Instrument approach chart',
		SID: 'Standard departure chart - instrument (SID)',
		STAR: 'Standard arrival chart - instrument (STAR)',
		DEP: 'Omnidirectional departures',
		ARC: 'Area chart',
		VAC: 'Visual approach chart',
		ENV: 'Visual approach environment',
		ADC: 'Aerodrome chart',
		GMC: 'Aerodrome ground movement chart',
		APDC: 'Aircraft parking / docking chart',
		AOC: 'Aerodrome obstacle chart',
		PATC: 'Precision approach terrain chart',
		AMG: 'Minimum radar vectoring altitudes',
		AMSR: 'Minimum vectoring altitudes',
		MVA: 'Minimum vectoring altitudes',
		ATCSMAC: 'ATC surveillance minimum altitude chart',
		COM: 'Communications chart',
		DATA: 'Coding tables',
		TEXT: 'Text pages',
		MISC: 'Miscellaneous charts',
	},
	chartIfr: 'IFR charts',
	chartIfrTip: 'Open the aerodrome page of the SIA eAIP at its instrument charts (IAC, SID, STAR; current AIRAC)',
	chartOther: 'Other charts',
	chartVac: 'VAC chart',
	chartVacTip: 'Open the SIA Carte VAC PDF (current AIRAC)',
	chartVacHel: 'Helicopter VAC',
	chartVacHelTip: 'Open the SIA Carte VAC PDF for helicopters at this aerodrome (current AIRAC)',
	chartsAll: (n: number) => `All charts (${n})`,
	approachLighting: 'Approach lighting',
	charts: 'Charts',
	contact: 'Contact',
	checklists: 'Checklists',
	class: 'Class',
	// A control zone, terminal or control area, or traffic zone whose data
	// carries no class: some sources publish none (the Swiss geodata, the
	// Austrian and Dutch layers), and a class varying with the level is left
	// blank rather than claimed as one.
	classUnknown: 'unknown',
	classUnknownTip: 'The source states no single class for this airspace. See the AIP.',
	// The status tag of a closed / abandoned aerodrome, on the airport panel
	// and on the rows a field is picked from. The full word, not the Doc 8400
	// CLSD: in a NOTAM viewer that abbreviation reads as a temporary closure,
	// and this is the permanent state the AIP publishes.
	closedTag: 'CLOSED',
	closedTip: 'Aerodrome closed or abandoned',
	coordination: 'Coordination',
	country: 'Country',
	datumUnknownTip: 'Vertical reference (AMSL / ASFC) not published by the source',
	docOffline: 'Stored offline',
	docStale: (cycle: string) => `AIRAC ${cycle}, superseded`,
	document: 'Document',
	elevation: 'Elevation',
	firBriefing: 'FIR briefing',
	freqChangedByTip: 'Frequency changed by this NOTAM',
	freqClosedByTip: 'Frequency withdrawn by this NOTAM',
	freqClosedContact: (subs: string) => `Contact ${subs}`,
	freqFlagChange: 'frequency change',
	pendingTitleLoading: 'Loading…',
	pendingTitle: 'Unavailable',
	pendingLoading: 'Reading the data for this item…',
	pendingUnavailable:
		'This item could not be read. Its data set is not on the device, or the item is no longer in it.',
	freqFlagClosure: 'service may be unavailable',
	freqFlagClosureValue: (freq: string) => `${freq} may be unavailable`,
	freqFlagLabelled: (p: { label: string; freq: string }) => `${p.label}: ${p.freq}`,
	freqFlagValue: (freq: string) => `frequency: ${freq}`,
	freqFlagsHeading: 'Frequency change (NOTAM):',
	fuelHeading: 'Fuel',
	fuelNotePartial: 'A NOTAM restricts part of the fuel service',
	fuelNotePartialGrades: (grades: string) => `A NOTAM restricts part of the ${grades} service`,
	fuelNoteUnmatched: (grades: string) => `A NOTAM withdraws ${grades}, which the AIP does not list here`,
	fuelNoteSchedule: 'A NOTAM withdraws fuel on a schedule that could not be read',
	fuelNotesHeading: 'Fuel (NOTAM):',
	ddFromNotam: (id: string) => `Declared distances restated by NOTAM ${id}`,
	ddContestedTip: (id: string) =>
		`NOTAM ${id} changes these declared distances in a form that could not be read. The figures shown are the AIP's and may be too long. Read the NOTAM.`,
	adClosedTag: 'CLOSED BY NOTAM',
	adClosedTip: (id: string) => `Aerodrome closed by NOTAM ${id}`,
	/** A Nearest row's tags for a field the loaded briefing leaves out, or
	 *  carries few of the NOTAMs filed under. */
	adNotBriefedTag: 'NOT BRIEFED',
	adPartlyBriefedTag: 'PARTLY BRIEFED',
	adNotesHeading: 'Aerodrome (NOTAM):',
	adNotePartial: 'A NOTAM restricts the use of the aerodrome without closing it',
	adNoteSchedule: 'A NOTAM closes the aerodrome on a schedule that could not be read',
	fuelNotamNone: 'No fuel available',
	fuelNotamNoneTip: 'A NOTAM withdraws the whole fuel service; the AIP entry below still stands',
	fuelWithdrawnTip: 'Withdrawn by this NOTAM',
	fuelNone: 'No fuel',
	fuelNoneTip: 'The AIP states that no fuel is available on this aerodrome',
	fuelMilTip: 'Published for military traffic only',
	fuelMatchTip: (name: string) => `A grade ${name} takes`,
	fuelBasedOnly: 'Based aircraft',
	fuelBasedTip: 'Reserved for aircraft based on the aerodrome',
	fuelH24Tip: 'Available round the clock, normally at a card-operated pump',
	fuelOrTip: 'On request or with prior notice',
	fuelHxTip: 'No specific working hours',
	frequencies: 'Frequencies',
	frequency: 'Frequency',
	group: 'Group',
	groupNote: 'One of several at this site.',
	hazard: 'Hazard',
	height: 'Height',
	hours: 'Hours',
	ident: 'Ident',
	identifiers: 'Identifiers',
	ifrTip: 'IFR allowed',
	inThisAirspace: 'In this airspace (geometric)',
	jointTip: 'Joint civil / military aerodrome',
	ldaTip: 'Landing distance available (metres; one value per runway end, ordered as the Runway column)',
	levels: 'Levels',
	lighting: 'Lighting',
	limitMax: 'Max',
	limitMnm: 'Mnm',
	limits: 'Limits',
	lit: 'Lit',
	litShort: 'lit',
	localType: 'Local type',
	flightPlanBuffer:
		'For flight planning purposes only. An IFR flight plan keeps clear of it while its zone is active.',
	zsmSubtitle: 'Zone of major sensitivity, raptors',
	zsmActiveUntil: (from: string, to: string) => `Active since ${from}, until ${to} at the latest.`,
	zsmActiveSince: (from: string) => `Active since ${from}.`,
	zsmInactive: 'Inactive at this time.',
	zsmSpecies: 'Species',
	zsmOverfly: 'Overfly above',
	zsmOverflyValue: (ft: string, m: string) => `${ft} ft (${m} m)`,
	zsmTop: 'Highest point',
	zsmTopValue: (m: string) => `${m} m`,
	zsmSource: 'Source',
	zsmEdition: (date: string) => `STAC, edition of ${date}`,
	zsmRecommendation:
		'AIP France ENR 5.6-1: an active zone is to be avoided as far as possible. Where that is impossible, it is recommended to overfly it 1,000 m above its highest point (powered flights and gliders).',
	location: 'Location',
	manager: 'Manager',
	metarStation: 'METAR station',
	militaryTip: 'Military aerodrome',
	minOverflight: 'Min overflight',
	moving: 'Moving',
	movingLine: (p: { dir: string; kt: number }) => `${p.dir}° at ${p.kt} kt`,
	name: 'Name',
	natureNote:
		'The zone boundary is not published in the SIA data; the symbol marks a representative point.',
	natureReserve: 'Nature reserve',
	noArea: 'no area',
	// The airport panel's empty states: "none" is only said of a briefing that
	// is loaded, and only of what it holds.
	noBriefingLoaded: 'No NOTAM briefing loaded.',
	noFirNotams: 'No NOTAMs filed under this FIR ident.',
	noLink: '(no link)',
	noLinkTip: 'IFR-series SUP; SIA URL pattern unverified',
	noNotamsAirspace: 'No NOTAMs affecting this airspace.',
	noneFiledUnder: (ident: string) => `No NOTAM filed under ${ident} in the loaded briefing.`,
	/** The field lies off every corridor and box the briefing was fetched for. */
	outsideBriefing: (ident: string) => `${ident} lies outside the area the loaded briefing covers.`,
	/** The field lies inside a SOFIA corridor, between the route's ends. */
	thinlyBriefed:
		"SOFIA briefs in full only a route's first and last aerodrome. Only some NOTAMs filed under this one are in the briefing.",
	noSupGeometry: 'No area geometry parsed from the supplement PDF.',
	notamSubtitle: 'NOTAM detail',
	openAirportTip: 'Open aerodrome detail',
	openAltitudeProfile: 'Open the altitude profile',
	openNotamTip: 'Open NOTAM detail',
	ownerAerodrome: 'Aerodrome',
	ownerEnRoute: 'En-route, filed under this location',
	parseNotes: (notes: string) => `Parse notes: ${notes}`,
	passengerFacilities: 'Passenger facilities',
	/* The place panel (PlaceDetail.svelte): a town, or a position typed as
	 * coordinates. */
	placeAddToRoute: 'Add to route',
	placeAddToRouteTip:
		'Insert this place in the active route, on the leg it lengthens least, or append it to a route of fewer than two points',
	placeAerodromes: (nm: number) => `Aerodromes within ${nm} NM`,
	placeCommune: 'Commune',
	placePopulation: 'Population',
	placePosition: 'Position',
	placeReportingPoints: (nm: number) => `VFR reporting points within ${nm} NM`,
	placeTown: 'Town',
	position: 'Position',
	profileHiddenBand: (n: number) => `${n} outside the level band`,
	profileHiddenRows: (n: number) => `${n} hidden by the airspace filter`,
	profileHiddenScope: (n: number) => `${n} not drawn on the map`,
	profileHiddenTip:
		'Airspaces over this point the chart is not drawing, and what is doing it. Three controls decide: the airspace filter and the all-or-on-map scope in the chart\'s own header, and the level band beside the period in the toolbar.',
	profileScopeAll: 'All',
	profileScopeAria: 'Airspaces plotted',
	profileScopeMap: 'On map',
	profileScopeTip:
		'Which airspaces the vertical profiles plot: every relevant one, or only those the map is drawing (Layers tab). Remembered across sessions.',
	profileWindowAbove: (p: { top: string; n: number }) => `+${p.n} above ${p.top}`,
	profileWindowBelow: (p: { bottom: string; n: number }) => `+${p.n} below ${p.bottom}`,
	profileWindowTip:
		'Airspaces lying entirely outside the plotted altitude window, so they are not drawn. Zoom the window out, drag the slider, or press Home to fit; they also stay listed on the panel and in the map right-click menu. A column that merely continues past an edge IS drawn, with that edge perforated.',
	radio: 'Radio',
	raiTip:
		'Auto-info frequency (RAI) the chart cites for this airspace; the only one the nav-log and schedule use',
	rawBulletin: 'Raw bulletin',
	realActivityKnownTo: 'Activity known on',
	phonesBefore: 'Before the activity',
	phonesDuring: 'During the activity',
	phonesContact: 'To contact',
	phonesTip: 'The telephone numbers the supplement prints, kept while it is in force',
	telTip: (n: string) => `Call ${n}`,
	entryConditions: (rules: string) => `Entry conditions (${rules})`,
	entryConditionsTip:
		'The condition AIP publishes for your flight rules, as the alerts and the route profile read it. The published text is under Remarks.',
	entryForbidden: 'avoidance mandatory',
	entryClearance: 'authorization required',
	entryRadio: 'radio contact required',
	entryRadioAts: 'listening watch required, except on an ATS frequency',
	entryNone: 'none',
	realActivityTip: 'Units that hold a zone’s real-time activation status',
	userInformation: 'User information',
	userInformationTip: 'Units the supplement lists for users’ information',
	heliportInfo: 'Heliport information',
	heliportData: 'Landing area',
	directoryData: 'Details',
	referencePoint: 'Reference point',
	referencedBy: 'Referenced by',
	referencedByPosition: 'Referenced by position',
	remarks: 'Remarks',
	reporting: 'Reporting',
	rffsCategory: 'RFFS category',
	runway: 'Runway',
	runwayLit: 'Lit',
	runwayNotamsTip: (ids: string) => `Affecting NOTAMs: ${ids}`,
	/** A runway end a NOTAM has closed for the period being viewed. */
	runwayClosed: 'CLOSED',
	runwayClosedTip: (id: string) => `Closed by NOTAM ${id}`,
	/* A runway closure the table could not strike: its schedule was
	   unreadable, or it names an end this aerodrome does not publish. */
	rwyNotesHeading: 'Runway (NOTAM):',
	rwyNoteSchedule: (ends: string) =>
		`A NOTAM closes RWY ${ends} on a schedule that could not be read`,
	rwyNoteUnmatched: (ends: string) =>
		`A NOTAM closes RWY ${ends}, which this aerodrome does not publish`,
	runways: 'Runways',
	sensitiveSite: 'Sensitive site',
	sigmetActiveNow: 'Active now',
	sigmetAttribution:
		'SIGMET data by the NOAA Aviation Weather Center, shown as decoded upstream. The raw bulletin is authoritative.',
	sigmetExpired: 'Expired',
	sigmetNoBoundary:
		'This advisory carries no boundary of its own; the map shows its whole FIR when that FIR is in the loaded airspace data.',
	sigmetUpcoming: 'Upcoming',
	size: 'Size',
	sourceTips: {
		at: 'Source: Austro Control Austria (KML / AIXM 5.1.1)',
		be: 'Source: skeyes Belgium & Luxembourg (eAIP)',
		de: 'Source: DFS Germany (AIXM 5.1.1)',
		es: 'Source: ENAIRE Spain (AIXM 5.1)',
		fr: 'Source: SIA France (AIXM 4.5)',
		uk: 'Source: NATS UK (AIXM 5.1)',
	},
	supAip: 'SUP AIP',
	/** A SUP AIP activation's weekdays: a run, and a list of runs and days. */
	supDaysList: (items: string[]) =>
		items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`,
	supDaysRun: (from: string, to: string) => `${from} to ${to}`,
	/** A clock bound beside a SUP AIP hour the sun sets ("SR - SS"). */
	supTimeEarliest: (time: string) => `${time} at the earliest`,
	supTimeLatest: (time: string) => `${time} at the latest`,
	/** The public holidays and their eves a SUP AIP activation skips. */
	supExceptDays: (holidays: boolean, eves: boolean): string =>
		holidays && eves
			? 'except public holidays and the days before them'
			: holidays
				? 'except public holidays'
				: eves
					? 'except the days before public holidays'
					: '',
	supPdfEnTip: 'Open the AIP SUP (English)',
	supPdfLocalTip: 'Open the AIP SUP in its own language',
	supPenetration: {
		circumvent: 'Circumvent',
		conditional: 'On request',
		forbidden: 'Forbidden',
		other: 'See rule',
	},
	// Under the tag when cmd/supaip found the rule and would not publish it:
	// set in columns, split over several zones it cannot attribute, or cut
	// open. The tag still stands, graded on the strictest line, and this says
	// the rest is in the document. "Entry conditions" is the SIA's own English
	// heading for CONDITIONS DE PÉNÉTRATION.
	supPenetrationRefused:
		'The entry conditions are set out in a way the app cannot read reliably. See the supplement.',
	supRegions: {
		be: 'Belgium & Luxembourg',
		'car-sam-nam': 'Caribbean / South America (CAR/SAM/NAM)',
		es: 'Spain',
		metropole: 'Metropolitan France',
		'pac-n': 'Pacific North',
		'pac-p': 'French Polynesia',
		run: 'Réunion / Indian Ocean',
	},
	services: 'Services',
	situation: 'Situation',
	surface: 'Surface',
	tierActivates: 'ACTIVATES',
	tierActivatesTip: 'Activation NOTAM for this airspace (outside the current evaluation window)',
	tierMentions: 'MENTIONS',
	tierMentionsTip: 'Cites this airspace designator in its text',
	tierNamed: 'NAMED',
	tierNamedTip: 'Names this airspace in its text',
	timesUtcTip: 'Times are UTC',
	supModeActivable: 'may be activated',
	supModeNotam: 'activated by NOTAM',
	supModeNotamNotice: (notice: string) => `activated by NOTAM, ${notice} notice`,
	supModeUnread: 'hours read in part',
	supStanding: (line: string) => `Throughout the validity: ${line}`,
	supStandingH24: 'H24',
	supSummerEarlier: '(summer: 1 h earlier)',
	supLineInForceTip: 'In force at the time the map shows (times are UTC)',
	todaTip: 'Take-off distance available (metres; one value per runway end, ordered as the Runway column)',
	toraTip: 'Take-off run available (metres; one value per runway end, ordered as the Runway column)',
	transitionAltitude: 'Transition altitude',
	type: 'Type',
	unknownLimit: 'unknown',
	unlit: 'Unlit',
	unlitShort: 'unlit',
	unserviceableTag: 'UNSERVICEABLE',
	unserviceableTip: 'An active NOTAM marks this navaid unserviceable',
	valid: 'Valid',
	vfrTip: 'VFR allowed',
	viewAerodrome: (id: string) => `View aerodrome ${id}`,
	/* The aerodrome a VFR reporting point belongs to, on its sheet. */
	vrpAerodrome: 'Aerodrome',
	viewAltitudeProfile: 'View the altitude profile',
	workingHours: 'Working hours',
	zoneActiveInPeriodTip: 'Activated by a NOTAM in the period',
	zoneN: (n: number) => `Zone ${n}`,
	zoneSameAs: (d: string) => `Lateral limits: those of ${d}`,
	/** A sector a SUP AIP zone takes out of its volume, with its band and
	 *  its hours. */
	zoneExcept: (name: string, what: string) => (what ? `Except ${name}: ${what}` : `Except ${name}`),
	/** The words around the airspaces a SUP AIP zone's lateral limits take
	 *  out of it: "Except LF-P 47", and of n taken out only while active,
	 *  "Except LF-R 15 A, LF-R 15 B while active". */
	zoneExceptLead: 'Except',
	zoneExceptWhileActive: (_n: number) => 'while active',
	zones: 'Zones',
	zonesLine: (names: string) => `Zones: ${names}`,
};
