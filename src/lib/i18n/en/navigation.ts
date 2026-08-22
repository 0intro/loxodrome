/* The Navigation tab: live GPS recording, on-map replay, GPX import/export,
 * and the trace vertical profile. */

export const navigation = {
	intro:
		'Share your position to record a trace, then replay it on the map and in the vertical profile.',
	position: 'Flight',
	aircraft: 'Aircraft',
	trace: 'Trace',
	replay: 'Replay',
	/* The flight framing (the toolbar flight button + the tab's primary
	   action): pilots start a FLIGHT; the trace vocabulary stays on the
	   artifact operations (continue / restart / export). */
	start: 'Start flight',
	/* The toolbar pill's short label; start / stopFlight above carry the
	   full wording in the title and aria. */
	fly: 'Fly',
	stop: 'Stop',
	stopFlight: 'Stop the flight',
	stopConfirm: 'Stop the flight?',
	continue: 'Continue',
	continueTip: 'Resume recording and keep the current trace.',
	restart: 'Restart',
	restartTip: 'Discard the current trace and start a new recording.',
	/* The startup line under Start: a finished flight is not redrawn on
	   the map, it is a row in the flights library. */
	lastFlightFiled: (when: string) => `Last flight ${when}, in the flights library.`,
	recording: 'Recording',
	/* The automatic stop after landing (docs/nav-live.md): the countdown on
	   the strip and the tab, its escape, the preference and the post-fire
	   note. */
	autoStopEnable: 'Stop the recording automatically after landing',
	autoStopTip: (min: string) =>
		`After landing, once the aircraft has been stationary for ${min} min, the recording stops by itself and the trace is kept. A countdown shows first, with a button to keep recording; moving again postpones it, and taking off again cancels it. Nothing arms before a landing, so a wait at the holding point never ends a recording.`,
	autoStopLabel: 'Automatic stop countdown',
	autoStopCountdown: (time: string) => `Recording stops in ${time}`,
	autoStopKeep: 'Keep recording',
	autoStopKeepTip: 'Cancel the automatic stop for this landing. A later takeoff and landing arm it again.',
	autoStopNote: (time: string) => `Recording stopped automatically at ${time}Z.`,
	/* The native background recording (the Android app; docs/android.md):
	   the foreground-service notification handed to the shell at the
	   recording start, the tab's reassurance line, the location disclosure
	   that precedes the first permission prompt, and the
	   battery-optimisation offer. */
	bgNotifTitle: 'Flight recording',
	bgNotifText: 'Recording the GPS trace.',
	bgNote: 'Recording continues with the app in the background or closed; stop it here or from the notification.',
	/* Its web counterpart: the same question answered the other way, and the
	   answer a pilot cannot see for themselves (the trace simply gains a gap). */
	fgNote:
		'Recording needs this page in the foreground: switching apps or locking the device pauses the fixes until you come back. The screen is kept awake meanwhile.',
	/* The disclosure Google Play asks for before the runtime location prompt:
	   why the application needs the position, what it reads, and what becomes
	   of it. Shown once, on the first flight start. */
	locationDisclosure:
		'Loxodrome reads your precise position to record the flight trace, follow the route and warn you about the airspace ahead. The recording continues with the screen off or the application in the background, and its notification stays up for as long as it runs. Your position is written to the trace on this device and is never transmitted.',
	locationAgree: 'Agree',
	/* The battery-optimisation offer sends the pilot to the system settings
	   list: the one-tap exemption dialog needs a permission Play reserves for
	   applications a foreground service cannot serve, which this one is not. */
	bgBatteryAsk:
		'Some phones interrupt the GPS recording when the screen is off or the application is in the background. Open the system battery settings to lift the restriction for Loxodrome?',
	bgBatteryAction: 'Open settings',
	bgBatteryHint: 'Battery optimisation may interrupt background recording.',
	bgBatteryFix: 'Open battery settings',
	aircraftSymbol: 'Aircraft symbol',
	plane: 'Aeroplane',
	helicopter: 'Helicopter',
	glider: 'Glider',
	showTrace: 'Show trace on map',
	follow: 'Follow aircraft',
	followTip:
		'Keeps the aircraft centred on the map. Panning the map pauses it; the on-map button resumes it.',
	recenter: 'Recentre on the aircraft',
	vector: 'Trajectory vector',
	vectorTip: 'Projected position at 2, 3, 5 and 10 min at the current ground speed.',
	groundSpeed: 'Ground speed',
	track: 'Track',
	trackTip: 'Magnetic track over the ground.',
	altitude: 'GPS altitude',
	altitudeTip: (datum: string, sep: string) =>
		`GNSS altitude above mean sea level. The device reports ${datum}, so ${sep}. It is not an altimeter reading and must not be flown as one.`,
	/** What the device is reporting, named in the tooltip. */
	altDatumSource: {
		ellipsoid: 'height above the WGS84 ellipsoid',
		msl: 'an altitude already above mean sea level',
	},
	/** What was done about it, completing the sentence above. */
	altDatumCorrection: {
		applied: (ft: string) => `the geoid separation of ${ft} ft is applied`,
		none: 'no correction is applied',
	},
	/** How the profile caption names the datum in force. */
	altDatumApplied: {
		ellipsoid: 'geoid-corrected from the WGS84 ellipsoid',
		msl: 'as reported by the device',
	},
	profileDatum: (datum: string) =>
		`Altitude: GNSS above mean sea level (${datum}); not an altimeter reading.`,
	/* The screen form of the same statement. The full sentence wraps to a
	   paragraph in a docked header and swallowed the chart on a phone, so
	   screen keeps the two things that matter (GNSS, referenced to MSL, and
	   not an altimeter reading) on one line, with the provenance on the
	   tooltip; paper prints the sentence in full, where the profile is a
	   record and there is room for it. */
	profileDatumShort: 'GNSS altitude (MSL), not an altimeter reading',
	elapsed: 'Elapsed',
	timeOfDay: 'Time',
	unlock: 'Unlock',
	accuracy: 'Accuracy',
	waitingFix: 'Waiting for a GPS fix',
	/** The in-flight strip over the map (NavStrip). */
	stripLabel: 'In-flight readout',
	stripCollapse: 'Collapse the in-flight readout',
	stripExpand: 'Expand the in-flight readout',
	stripHide: 'Hide the in-flight readout',
	stripShow: 'Show the in-flight readout',
	copyFreq: (unit: string) => `Copy the ${unit} frequency`,
	gpsDegraded: 'Position degraded',
	gpsDegradedTip:
		'The last fix is several seconds old, or its accuracy is poor. Every live value is frozen at that fix.',
	gpsLost: 'Position lost',
	gpsLostTip:
		'No position received for over 15 seconds. The aircraft symbol and every live value are frozen at the last fix, and the trajectory vector is not drawn.',
	play: 'Play',
	toStart: 'Back to the start',
	toEnd: 'Jump to the end',
	pause: 'Pause',
	prevEvent: 'Previous event',
	nextEvent: 'Next event',
	eventJumpTip:
		'Jump between recorded flight events: takeoff, landing, waypoint passages, airspace boundaries.',
	replaySlider: 'Replay position',
	speed: 'Speed',
	traceStart: 'Trace start',
	duration: 'Duration',
	distance: 'Distance',
	points: 'Fixes',
	exportIgcNoTime: 'This trace carries no UTC time, which IGC states: it exports as GPX.',
	exportTrace: (format: string): string => `Export ${format}`,
	exportTraceOwn: 'Export the trace',
	igcDatumEllipsoid: 'Height above the WGS84 ellipsoid',
	igcDatumEllipsoidHint: 'What the IGC specification defines, and what approved recorders write.',
	igcDatumMsl: 'Altitude above mean sea level',
	igcDatumMslHint: 'What XCSoar and other software loggers write instead.',
	igcDatumQuestion:
		'This IGC file does not state what its altitudes are measured from. The two readings differ by about 150 ft over France.',
	igcDatumTitle: 'Altitude reference',
	importFailed: 'Could not read that trace file.',
	importTrace: 'Import trace',
	importTraceTip: 'Read a trace back in: GPX, IGC, KML or KMZ.',
	replaceConfirm: 'Replace the current trace?',
	replaceConfirmAction: 'Replace',
	clear: 'Clear',
	clearConfirm: 'Discard the current trace?',
	clearConfirmAction: 'Discard',
	/* One wording for the surface, the tab button that opens it and the
	   detail panel's back arrow (t.detail.backToTraceProfile). */
	profileTitle: 'Trace vertical profile',
	/* The header hop between the two profile windows (labels reuse
	   t.tabs.route / trace above; this is the switch's aria). */
	profileSwitchAria: 'Route or trace profile',
	noTrace: 'No trace recorded yet.',
	contactMap: 'Highlight the current and next airspace to contact on the map',
	/* Both name the frequency, not a bare "current / next": the band sets them
	   beside the next WAYPOINT, and an unqualified "Next" there is the one label
	   that does not say what it is the next of. */
	contactCurrent: 'Current frequency',
	contactNext: 'Next frequency',
	/** The phone band's transient handover line, where the full label costs
	 *  the width the lead figure needs. */
	contactNextShort: 'Next',
	contactBoundary: 'Next change',
	contactBoundaryTip: 'Distance, time and clock to the next contact change: an airspace boundary, or the field you are landing at.',
	contactNone: 'No unit to contact along this route.',
	contactNoFix: 'Waiting for a position.',
	/* The overflown aerodrome: the strip's one position-resolved cell
	   (state/navOverflight), and the Navigation-tab checkbox gating it. */
	contactOverflight: 'Overflown aerodrome',
	overflightFreq: 'Show the frequency of the aerodrome flown over',
	overflightFreqTip: (nm: string) =>
		`Adds to the in-flight readout the nearest aerodrome with a published frequency within ${nm} NM of the aircraft, resolved from the GPS position rather than from the planned route. The departure and destination of the route being flown are not repeated.`,
	navlog: 'Navigation log',
	navlogTip:
		'Stamps the actual time over each waypoint from takeoff, revises the estimates at the live ground speed, and follows the nav-log radio schedule, all at the position projected onto the planned route.',
	bearing: 'Bearing',
	bearingTip: 'Magnetic bearing from the aircraft to the active waypoint.',
	xtk: 'Cross-track',
	xtkTip: 'Distance off the planned track and the side the aircraft is on; the correction is the other way.',
	xtkLeft: 'L',
	xtkRight: 'R',
	onCourse: 'on course',
	/* The turn itself, which the bearing and the track only imply. The side
	   letters are the cross-track's, the same two words. */
	steer: 'Steer',
	steerTip:
		'The turn onto the bearing to the active waypoint: that bearing less the track being flown, both magnetic. Left or right is the way to turn.',
	steerLeft: (deg: string) => `L ${deg}°`,
	steerRight: (deg: string) => `R ${deg}°`,
	steerNone: '0°',
	navlogTakeoff: 'Takeoff',
	navlogLanding: 'Landing',
	navlogAirborne: 'Airborne',
	navlogAirborneTip: 'Takeoff to landing: the time in the air.',
	navlogFlightTime: 'Flight time (block)',
	navlogFlightTimeTip:
		'First movement for the purpose of taking off until final rest (ICAO Annex 1, FCL.010). This is the flight time a logbook records; the airborne time is not.',
	blockOff: 'Block off',
	blockOffTip: 'First movement of the outing (GPS-detected).',
	blockOn: 'Block on',
	blockOnTip: 'Final rest at the end of the outing (GPS-detected).',
	landingsCount: 'Landings',
	landingsCountTip:
		'Full stops, stop-and-gos and, once the recording ends, detected touch-and-goes (a sustained slow, low pass over a known aerodrome). GNSS-derived and advisory: a balked landing can count in excess and a field absent from the data counts short, so verify before your logbook.',
	landingsNight: (n: string) => `${n} night`,
	nightTime: 'Night time',
	nightTimeTip:
		'Flight time in aeronautical night: sunset +30 min to sunrise -30 min (15 min at latitudes at or below 30 degrees), civil twilight above 60 degrees.',
	maxAltitude: 'Max altitude',
	maxAltitudeTip:
		'Highest GNSS altitude of the trace, on mean sea level. Not an altimeter reading.',
	exportCsv: 'Export logbook (CSV)',
	exportCsvTip:
		'One row per flight, AMC1 FCL.050 columns (English headers, UTC times, Part-FCL aeroplane format). Pre-filled from the trace; review and amend before entering it in your logbook.',
	legProgress: 'Progress along the leg being flown',
	navlogNext: 'Next waypoint',
	navlogEta: 'Destination ETA',
	navlogArrived: 'Arrived',
	/* Against the plan, in words: a signed number would need a convention
	   taught in a tooltip, and a tooltip is what a mounted touch device never
	   shows. */
	planEarly: (min: string) => `${min} min early`,
	planLate: (min: string) => `${min} min late`,
	planOnTime: 'on plan',
	planDeltaTip:
		'Time gained or lost against the plan since departure: the arrival the log is holding, against the planned time for the whole route. A late departure is not counted in it.',
	/* "Route", not "leg": a leg is one waypoint to the next everywhere else in
	   the application, and these are whole routes of a plan that lands. */
	flownRoute: 'Route being flown',
	flownRouteTip:
		'A plan of several consecutive routes is flown one at a time. The route is detected from the trace and handed over on arrival; pin one to fly it whatever the trace says.',
	routeFlying: 'being flown',
	routeFlown: 'flown',
	routeNotFlown: 'not flown',
	routePinned: 'pinned',
	routePin: 'Fly this route whatever the trace says',
	routeRelease: 'Detect the route from the trace again',
	/* One level down: which SEGMENT of that route the projection reads. "Leg"
	   in the label, "segment" in French, the route-tab vocabulary. */
	flownLeg: 'Segment being flown',
	flownLegTip:
		'The log projects the aircraft onto the planned route to say where it is. Where it reads the wrong segment (a turn back to an earlier waypoint, a corridor the route shares with itself), press the segment being flown: the projection re-anchors there from now on, and sequences on by itself again. Times already stamped are kept.',
	legPin: 'Read the log on this segment from now on',
	legRelease: 'Undo this correction',
	legByHand: 'set by hand',
	/* The aerodrome's other frequencies. They rode the frequency button's
	   tooltip, which never appears on touch, and touch is what a pilot mounts;
	   this is the way to reach them there. */
	freqAll: (field: string) => `All frequencies at ${field}`,
	freqShow: 'Show every frequency at this aerodrome',
	freqHide: 'Hide the frequencies',
	freqWas: (freq: string) => `Replaces ${freq}, per a NOTAM in force`,
	contactClosedBy: (p: { unit: string; id: string }) =>
		`${p.unit} closed by NOTAM ${p.id}; the published service below answers instead.`,
	freqFlagged: 'A frequency change could not be matched to a published service',
	planOnly: 'plan, not position',
	planOnlyTip: (nm: string) =>
		`The aircraft is more than ${nm} NM off this route, or is not flying it at all. The units, the countdown and the schedule answer for the nearest point of the plan, not for where the aircraft is.`,
	/* The airspace-alert banner (docs/nav-alerts.md). Statements of fact and
	   of the published requirement, never manoeuvre instructions: the
	   evaluation is advisory, and "entry prohibited" reads as the zone's
	   status whether it lies ahead or the aircraft is already inside. */
	alertInside: (name: string) => `In ${name}`,
	alertAhead: (name: string, min: string) => `${name} in ${min} min`,
	alertAbeam: (name: string, nm: string) => `${name} ${nm} NM abeam`,
	/** The announced form of the two leads that carry a live figure. */
	alertNear: (name: string) => `${name} nearby`,
	alertJustBelow: (name: string) => `Just below ${name}`,
	alertJustAbove: (name: string) => `Just above ${name}`,
	alertClimbingInto: (name: string) => `Climbing into ${name}`,
	alertDescendingInto: (name: string) => `Descending into ${name}`,
	alertDoNotEnter: 'entry prohibited',
	alertCoveredForbidden: (zone: string) => `entry prohibited (${zone})`,
	alertClearance: 'clearance required',
	alertContact: (unit: string, freq: string) => `contact ${unit} ${freq}`,
	alertRadio: 'radio mandatory',
	alertRadioXpdr: 'radio and transponder mandatory',
	alertTransponder: 'transponder mandatory',
	alertCaution: 'caution',
	alertPlanned: (unit: string, freq: string) =>
		`planned: call ${unit} ${freq} before entry`,
	alertWindow: (from: string, to: string) => `active ${from}-${to}Z`,
	alertAltUnknown: '(altitude unknown)',
	alertExtentUnknown: '(vertical extent unknown)',
	alertAckTip: 'Acknowledge this alert. A worsening re-alerts.',
	alertAckedTip: 'Acknowledged',
	alertAckLabel: 'Acknowledge',
	alertOpenTip: 'Open in the detail panel',
	/* The channel chip and the alert panel (the record half of the alert
	   surface). Chip labels put the number LAST so neither language needs
	   agreement ("Airspace alerts: 3, acknowledged: 2"). */
	alertPanelOpenTip: 'Open the airspace-alert panel',
	alertChipActive: (n: string) => `Airspace alerts: ${n}`,
	alertChipAcked: (n: string) => `acknowledged: ${n}`,
	alertChipAllAcked: 'All airspace alerts acknowledged',
	alertChipSuspended: 'Airspace alerts suspended',
	alertAckedSection: (n: string) => `Acknowledged (${n})`,
	alertAckedNote: 'Re-alerts if it worsens; clears 5 min after the condition ends.',
	alertLifecycleNote: 'An alert stays while its condition holds and leaves when it clears.',
	alertPanelEmpty: 'No current alerts.',
	/* The explicit suspension states: the surface must never go silently
	   blank while a recording runs (docs/nav-alerts.md). */
	alertSuspendedLost: 'Airspace alerts suspended: position lost',
	alertSuspendedLostTip:
		'No position for over 15 seconds: a frozen position must not be graded against airspace. Evaluation resumes with the next fix.',
	alertSuspendedNoFix: 'Airspace alerts waiting for a position',
	alertSuspendedNoFixTip:
		'The recording has no GPS fix yet, so nothing is being graded. Evaluation starts with the first fix.',
	alertAirspacesLoading: 'Loading airspace data',
	alertAirspacesLoadingTip: 'Alerts start evaluating as soon as the dataset has loaded.',
	alertNoAirspaces: 'Airspace data unavailable: no alerts are being evaluated',
	alertNoAirspacesTip:
		'The airspace dataset did not load, so the position is not being graded against any zone. An empty alert band does not mean clear airspace.',
	alertNoBriefing: 'No NOTAM briefing: the actual activity of zones activated by NOTAM is unknown',
	alertNoBriefingTip:
		'Without a briefing the app cannot tell an inactive zone from an unlisted one, so every zone activated by NOTAM (the RTBA network above all) is graded as a caution rather than passed over in silence. The temporary zones a NOTAM creates on its own (ZRT, ZIT, ZDT) are not evaluated at all. Load a briefing in the NOTAMs tab to resolve them.',
	alertsSection: 'Airspace alerts',
	alertsTip:
		'Grades the airspace around the aircraft from the GNSS position: forbidden zones, clearance boundaries, equipment zones and hazards, with activation read over the projected path.',
	alertsEnable: 'Evaluate airspace around the aircraft',
	alertTierAvoid: 'Prohibited and active restricted areas',
	alertTierClearance: 'Controlled airspace (clearance required)',
	alertTierEquipment: 'Radio and transponder zones (RMZ / TMZ)',
	alertTierCaution: 'Danger and activity areas',
	alertBuffer: 'Vertical buffer',
	alertBufferTip:
		'Widens each zone’s vertical limits. Level flight within the margin shows a quiet "just below / just above" note with no chime; a climb or descent closing the gap within 2 minutes alerts.',
	alertLookahead: 'Look ahead',
	alertAudio: 'Audio alerts',
	alertAudioTip:
		'Arming plays the warning chime once: the browser unlocks audio on this tap, and you hear what a warning sounds like. Silent during replay.',
	alertAudioCaution: 'Chime for cautions too',
	alertTest: 'Play the warning chime',
	alertAdvisory:
		'Advisory only: the evaluation reads the GNSS position against the published data. It is no substitute for preparation, the chart and lookout.',
	errors: {
		denied:
			'Location access was denied. Allow it in your browser or system settings, then start again.',
		unavailable: 'Position is unavailable on this device.',
		timeout: 'Getting a position is taking longer than usual.',
		insecure: 'Location needs a secure (HTTPS) connection.',
	},
};
