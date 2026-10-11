/* Flight-preparation wording: the FlightPrepModal chrome and its four pages
 * (Overview / Fuel plan / Mass & balance / Performance), the CG-envelope and
 * nomogram charts, and the print pack (PrintDoc). The dossier checklist
 * labels live here keyed by the DOSSIER_CHECKS ids ($lib/aircraft/dossier,
 * the saved-file contract); the clamp tokens mirror the canonical ids
 * $lib/aircraft/performanceChart emits. ICAO Doc 8400 abbreviations (ETA,
 * ETD, QNH, TORA, TODA, LDA, PA, ISA) and unit tokens stay invariant; the
 * tooltips spell them out. */

import type { DossierCheckId } from '$lib/aircraft/dossier';
import type { NomogramClampToken } from '$lib/aircraft/performanceChart';
import { plural } from './plural';

export const flightprep = {
	aboardNothing: (aboard: string) => `${aboard} L aboard, nothing to add`,
	aboardOnly: (aboard: string) => `${aboard} L aboard`,
	aboardUplift: (p: { aboard: string; uplift: string }) => `${p.aboard} L aboard + ${p.uplift} L uplift`,
	/** An estimate's litres in a table cell (the journey log's). */
	aboutLitres: (litres: string) => `≈ ${litres}`,
	accelerateStop: 'Accelerate-stop',
	accessNoHoursLower: 'no set fuel hours',
	accessOnRequestLower: 'on request',
	accessShortNoHours: 'No set hours (AIP)',
	accessShortOnRequest: 'On request (AIP)',
	addAerodrome: 'Add aerodrome',
	adjustLoading: 'Adjust the loading before flight.',
	aircraft: 'Aircraft',
	aircraftChipTip: (name: string) => `${name}. Change in the Aircraft tab`,
	airportDeparture: 'Departure aerodrome',
	airportN: (n: number) => `Airport ${n}`,
	altEtaTip:
		'Estimated time of arrival at the alternate: destination ETA + alternate time + its procedure + its wind allowance',
	altFt: 'Alt (ft)',
	altWindTip: 'Extra minutes to reach the alternate against the wind (never credited as a gain)',
	alternate: 'Alternate',
	alternateN: (n: number) => `Alternate ${n}`,
	alternateProcedure: 'Alternate procedure',
	alternateTime: 'Alternate time',
	alternateWindAllowance: 'Alternate wind allowance',
	alternates: 'Alternates',
	anchorsInterpTip: 'Interpolated between the anchors, clamped past the last',
	// A row header does not name an input sitting in a cell, so each editable
	// cell says which row and which column it belongs to.
	ariaFuelCell: (p: { row: string; trip: string }) => `${p.row}, ${p.trip}`,
	ariaPerfCell: (p: { row: string; icao: string }) => `${p.row}, ${p.icao}`,
	armM: 'Arm (m)',
	arrivalProcedure: 'Arrival procedure',
	asdRowTip: 'Flight manual accelerate-stop distance: accelerate to its speed, then stop (wind and surface applied, no safety margin)',
	burnOff: 'Burn-off',
	burnOffTip: 'What the trip burns: taxi, en route, arrival procedure, wind allowance and contingency',
	carriedOver: (litres: string) => `${litres} L carried over`,
	colL: 'L',
	colMin: 'min',
	compareAllPlans: (n: number) => `Compare all ${n} refuelling plans`,
	contingency: 'Contingency',
	contingencyTip:
		'Minutes for what the trip may meet on the way: performance, avoidance, weather, ATC, holding. Burnt with the trip',
	customLitresAria: (at: string) => `Litres at takeoff from ${at}`,
	ddFromNotam: (id: string) => `Declared distance restated by NOTAM ${id}`,
	ddContestedTip: (id: string) =>
		`NOTAM ${id} changes this aerodrome's declared distances in a form that could not be read. The figure shown is the AIP's and may be too long. Read the NOTAM.`,
	ddContestedShort: 'disputed',
	asdaFromToraTip: 'No ASDA published: the TORA is taken, the ASDA never being shorter',
	asdaTip: 'Accelerate-stop distance available (declared)',
	assumedDistanceTip: 'Declared distance unpublished; the physical runway length is assumed',
	assumedVerdictTip:
		'Verdict computed against an assumed declared distance (physical runway length)',
	axisDistanceM: 'distance (m)',
	axisMassKg: 'mass (kg)',
	axisTempC: 'temperature (°C)',
	axisWindKt: 'wind (kt, tail < 0 < head)',
	beyondChart: (list: string) => `Beyond the chart: ${list} (drawn clamped, values exact).`,
	burnNote: (p: { litres: string; kg: string }) => `Burn-off ${p.litres} L = ${p.kg} kg.`,
	burnOffRow: 'Burn-off (−)',
	cgEnvelope: 'CG envelope',
	cgNoFuelDry: (n: number) => `No fuel at takeoff: the tanks run dry on trip ${n}.`,
	cgNoFuelUnknown: 'Fuel at takeoff unknown: no loading to draw.',
	cgTripHeading: (p: { n: number; route: string }) => `CG envelope, trip ${p.n}, ${p.route}`,
	checkD15Lda: (p: { d: number; avail: number; pct: number }) =>
		`Landing distance +${p.pct}% ${p.d} m, not within the LDA (${p.avail} m)`,
	checkAsdAsda: (p: { d: number; avail: number; pct: number }) =>
		`Accelerate-stop distance +${p.pct}% ${p.d} m, not within the ASDA (${p.avail} m)`,
	checkD15Asda: (p: { d: number; avail: number; pct: number }) =>
		`Distance to 15 m +${p.pct}% ${p.d} m, not within the ASDA (${p.avail} m)`,
	checkD15Toda: (p: { d: number; avail: number; pct: number }) =>
		`Distance to 15 m +${p.pct}% ${p.d} m, not within the TODA (${p.avail} m)`,
	checkD15Tora: (p: { d: number; avail: number }) =>
		`Distance to 15 m (flight manual) ${p.d} m, not within the TORA (${p.avail} m)`,
	checkRollTora: (p: { d: number; avail: number; pct: number }) =>
		`Ground roll +${p.pct}% ${p.d} m, not within the TORA (${p.avail} m)`,
	chartAria: 'Chart',
	chartCredit: 'Source Météo-France, via SOFIA-Briefing (DGAC)',
	chartOnly: 'Chart only: no aerodrome / mass resolved yet, so there is no reading path.',
	chartValid: (when: string) => `Valid ${when}`,
	chartDownloadFailed: (p: { chart: string; valid: string }) =>
		`${p.chart} valid ${p.valid}: chart not retrieved.`,
	chartExtrapolated: (p: { next: string; at: string }) =>
		`Latest chart published: extrapolate the movement of fronts and pressure centres to the flight time. The ${p.next} chart is published around ${p.at}.`,
	chartsCatalogFailed: (p: { chart: string; cause: string }) =>
		`${p.chart}: catalog unavailable. ${p.cause}`,
	chartsChecking: 'Checking the TEMSI and WINTEM charts…',
	chartsLater: (p: { chart: string; valid: string; at: string | null }) =>
		`${p.chart} valid ${p.valid}, for the end of the flight: ${p.at ? `published around ${p.at}` : 'not published yet'}.`,
	chartsMissing: (p: { chart: string; valid: string; at: string | null }) =>
		`${p.chart} valid ${p.valid}: ${p.at ? `due around ${p.at}, not in the catalog yet` : 'not in the catalog'}.`,
	chartsNone: (chart: string) => `${chart}: SOFIA lists no chart.`,
	chartsNotYetPublished: (p: { chart: string; valid: string | null; at: string | null }) =>
		`${p.chart}${p.valid ? ` valid ${p.valid}` : ''}: ${p.at ? `published around ${p.at}` : 'not published yet'}.`,
	chartsPrintedNow: (list: string) => `Charts printed now: ${list}.`,
	chartsUndated: (chart: string) => `${chart}: chart dates unreadable, none selected.`,
	checks: {
		charts_complement: 'Aeronautical charts supplement',
		charts_current: 'Charts current (updates checked)',
		charts_regional: 'Regional charts (Paris area, Lyon, etc.)',
		charts_vac: 'VAC charts',
		doc_airworthiness: 'Certificate of airworthiness + ARC (CDN / CEN)',
		doc_flight_manual: 'Aircraft flight manual',
		doc_insurance: 'Insurance certificate',
		doc_journey_log: 'Journey log book',
		doc_mass_balance: 'Mass and balance',
		doc_noise: 'Noise certificate',
		doc_radio: 'Aircraft radio station licence (LSA)',
		doc_registration: 'Certificate of registration (CDI)',
		pax_recency: 'Passengers: 3 takeoffs and landings in the last 90 days (FCL.060)',
		r_feasible: 'Feasible',
		r_legal: 'Legal',
		r_reasonable: 'Reasonable',
		type_recency: 'Club: last flight on type < 3 months',
		wx_fronts: 'Surface analysis chart (fronts)',
		wx_metar_taf_sigmet: 'METAR / TAF / SIGMET',
		wx_temsi: 'TEMSI (SIGWX chart)',
		wx_winterm: 'WINTEM (upper wind and temperature)',
	} satisfies Record<DossierCheckId, string>,
	clampTokens: {
		mass: 'mass',
		'pressure altitude': 'pressure altitude',
		temperature: 'temperature',
		wind: 'wind',
	} satisfies Record<NomogramClampToken, string>,
	day: 'day',
	discretionaryMargin: 'Discretionary margin',
	declaredSufficient: 'Declared distances sufficient?',
	declaredSufficientFlaps: (flaps: number) => `Declared distances sufficient, flaps ${flaps}°?`,
	declaredSufficientLandingTip: (pct: number) =>
		`Yes when the landing distance from 15 m +${pct}% fits within the LDA. Equal is not enough.`,
	declaredSufficientTakeoffTip: (pct: number) =>
		`Yes when the flight manual distance to 15 m fits within the TORA, that distance +${pct}% within the TODA and the ASDA, and the ground roll +${pct}% within the TORA. Equal is not enough.`,
	discretionaryTip: 'Discretionary fuel at the pilot’s judgement',
	/** A duration in hours and minutes: "1 h 25 min", "45 min", "2 h". */
	durationHm: (p: { h: number; m: number }) =>
		p.h === 0 ? `${p.m} min` : p.m === 0 ? `${p.h} h` : `${p.h} h ${p.m} min`,
	distAway: (dist: string) => `, ${dist} away`,
	dryPavedNote: 'Dry paved figure. Surface factors and the +30% margin are table rows.',
	elevationFt: 'Elevation (ft)',
	enRoute: 'En route',
	enRouteTip: 'Still-air time from takeoff to landing at the cruise speed',
	enduranceLimit: 'Endurance limit (UTC)',
	enduranceLimitTip:
		'Latest landing time keeping the final reserve fuel intact (the ICAO flight-plan endurance, minus the final reserve)',
	etaHeader: 'ETA (UTC)',
	etaTip: 'Estimated time of arrival: the departure plus the trip’s burn-off minutes (taxi, en route, procedure, wind and contingency)',
	etdHeader: 'ETD (UTC)',
	etdTip: 'Estimated time of departure',
	expiresBeforeTip: 'Expires before the flight date',
	extrapolatedTip: (list: string) => `Extrapolated: ${list}. Treat with extra margin.`,
	finalReserve: 'Final reserve',
	finalReserveTip:
		'30 min for VFR by day, 45 min for VFR by night and IFR (AMC1 NCO.OP.125(b)). Empty = the derived day/night default',
	fittedRateLandingTip:
		'From the fitted per-knot rate of the landing reference figure (over 15 m), applied continuously. Ground roll uses its own rate.',
	fittedRateTakeoffTip:
		'From the fitted per-knot rate of the normal takeoff figure (over 15 m), applied continuously. Ground roll uses its own rate.',
	fixNone: 'No single change cures it: reduce the payload or add a stop.',
	fixOr: ', or ',
	fixRaise: (p: { at: string; litres: number }) => `take off from ${p.at} with at least ${p.litres} L`,
	fixRaiseThen: (p: { at: string; litres: number }) =>
		`take off from ${p.at} with at least ${p.litres} L, then refuel further on`,
	fixRefuelAt: (at: string) => `refuel at ${at}`,
	fixRefuelAtMax: (at: string) => `refuel at ${at} to the maximum within limits`,
	fixRefuelAtMinimum: (at: string) => `refuel at ${at} to the minimum`,
	fixThenFurther: ', then refuel further on',
	flagAltitude: 'below the first POH altitude',
	flagMass: 'mass outside the POH columns',
	flagTemp: 'temperature beyond ISA +/- 20',
	flaplessCorrection: (pct: number) => `Flapless landing: add ${pct}%.`,
	flaplessFeasible: 'Flapless feasible?',
	flaplessFeasibleTip: (factor: number) =>
		`Distance x ${factor} (flight manual figure, no safety margin) still within the LDA`,
	flightDate: 'Flight date (UTC)',
	flightDatePastTip: 'This date is already past: the forecast winds, the sun and the charts would be read for a flight already flown. Clearing it means today.',
	flightDateTip:
		'Drives the sunset times, the validity checks, the forecast winds and the flight period in the toolbar. Clearing it means today.',
	flightPast: (when: string) =>
		`The planned flight (${when}) is in the past: check the flight date and the ETD.`,
	foldStated: 'Holds minutes you typed',
	fromMetar: (p: { id: string; dist: string; age: string }) =>
		`from ${p.id} METAR${p.dist}, ${p.age}`,
	/** A field read off the forecast at its phase's instant: the instant,
	 *  then the runs (or the model and Open-Meteo) it came from. */
	fromForecast: (p: { valid: string; source: string }) => `from the forecast for ${p.valid} (${p.source})`,
	fuelAtTakeoff: 'Fuel at takeoff',
	fuelAtTakeoffFrom: (at: string) => `Fuel at takeoff from ${at}`,
	fuelBasisCruiseDefault: (kt: number) => `Cruise ${kt} kt by default, no aircraft selected.`,
	fuelBasisCruiseOwn: (p: { kt: number; lph: string | null }) =>
		`Cruise ${p.kt} kt${p.lph !== null ? `, ${p.lph} L/h` : ''}: the plan’s own figures.`,
	fuelBasisCruiseSheet: (p: { name: string | null; kt: number; lph: string | null; plane: string }) =>
		`Cruise ${p.name !== null ? `${p.name}, ` : ''}${p.kt} kt${p.lph !== null ? `, ${p.lph} L/h` : ''}, from the ${p.plane} sheet.`,
	fuelBasisForecast: (source: string | null) =>
		`Wind allowance from the forecast winds${source !== null ? ` (${source})` : ''}.`,
	fuelBasisForecastLess: (min: number) => `The forecast would take ${min} min less.`,
	fuelBasisForecastMore: (min: number) => `The forecast would take ${min} min more.`,
	fuelBasisForecastSame: 'The forecast would take about the same time.',
	fuelBasisManual: (wv: string) => `Wind allowance from a manual wind ${wv}, not the forecast.`,
	fuelBasisMissedManual: (p: { legs: number; wind: string }) =>
		`No forecast for ${p.legs} ${plural(p.legs, 'leg', 'legs')}: ${plural(p.legs, 'it flies', 'they fly')} the manual wind ${p.wind}.`,
	fuelBasisMissedStill: (legs: number) =>
		`No forecast for ${legs} ${plural(legs, 'leg', 'legs')}: still air there.`,
	fuelBasisNoWind: 'No wind known: the trips are planned in still air.',
	fuelBasisOwnLegs: (n: number) => (n === 1 ? '1 leg flies a wind of its own.' : `${n} legs fly a wind of their own.`),
	fuelDry: (n: number) => `NO, dry on trip ${n}`,
	fuelNoMargin: (litres: string) => `NO (${litres} L)`,
	fuelNote: (p: { litres: string; grade: string; density: number; kg: string }) =>
		`Fuel ${p.litres} L of ${p.grade} x ${p.density} kg/L = ${p.kg} kg.`,
	fuelRefusedTip: 'Fuelled where the AIP or a NOTAM says the fuel is not available to this aeroplane',
	fuelShortOne: (p: { start: string; need: string }) =>
		`INSUFFICIENT fuel: ${p.start} L at takeoff for ${p.need} L required.`,
	fuelSufficientOne: (p: { start: string; need: string }) =>
		`Fuel sufficient: ${p.start} L at takeoff for ${p.need} L required.`,
	fuelTableCaption: 'Fuel for each trip: what it burns, the reserve it must land with, the fuel at takeoff and what is left',
	fuelYesMargin: (litres: string) => `Yes (${litres} L)`,
	genericAircraft: 'Generic type',
	genericMbNote: 'Generic data sheet. The empty mass and arm are the flight manual’s example, not an aircraft’s weighing.',
	grass: 'Grass',
	grassAssumed: 'yes (assumed)',
	grassCorrection: (pct: number) => `Dry grass runway = +${pct}%.`,
	grassMixed: 'yes (mixed)',
	grassMixedTip: 'Mixed surface, part paved and part unpaved: the grass factor is applied',
	grassUnknownTip:
		'Surface unpublished or unreadable: the runway is assumed unpaved and the grass factor is applied',
	groundRoll: 'Ground roll',
	groundTime: 'Ground time',
	groundTimeTip:
		'Engine off, shifts the later ETDs and the endurance limit. Enter h:mm, or bare minutes.',
	headwindCalmTip: 'Headwind 0 kt, assuming calm (no live METAR).',
	headwindInfluenceAsd: 'Headwind influence, accelerate-stop',
	headwindInfluenceLanding: 'Headwind influence (landing)',
	headwindInfluenceTakeoff: 'Headwind influence (takeoff)',
	headwindKt: 'Headwind (kt)',
	headwindMetarTip: (p: { kt: number; prov: string }) => `Headwind ${p.kt} kt ${p.prov}.`,
	headwindRowTip: 'Headwind component along the runway',
	headwindZeroTip: 'Headwind 0 kt, since a tailwind is typed for this runway.',
	hhmmPlaceholder: 'hh:mm',
	landing: 'Landing',
	landingPerfHeading: 'Landing performance',
	ldaTip: 'Landing distance available (declared)',
	lineAboardAboveMax: (p: { at: string; aboard: string; max: string }) =>
		`${p.at}: about ${p.aboard} L already on board, above the ${p.max} L the limits allow there: defuel or lighten the load.`,
	lineAboardUnknown: (at: string) =>
		`${at}: no refuel, and the fuel on board is not known: the fuel at takeoff is unknown.`,
	lineAboveMax: (p: { who: string; kg: string; max: number }) =>
		`${p.who}: ${p.kg} kg, above the ${p.max} kg maximum.`,
	lineAboveUsable: (p: { at: string; asked: string; usable: number }) =>
		`${p.at}: ${p.asked} L asked, the ${p.usable} L usable loaded.`,
	lineAvgasPassengers: 'No AVGAS refuelling while passengers embark, are on board or disembark (NCO.OP.145).',
	lineCgOut: (p: { who: string; arm: string }) => `${p.who}: CG ${p.arm} m, outside the envelope.`,
	lineDry: (who: string) => `${who}: INSUFFICIENT fuel, the tanks run dry before landing.`,
	lineMaxWithin: (p: { at: string; litres: number }) => `Maximum within limits at ${p.at}: ${p.litres} L.`,
	lineNoConsumption: 'This aircraft states no fuel consumption: the fuel cannot be judged.',
	lineNoDefuel: (p: { at: string; onBoard: string; asked: string }) =>
		`${p.at}: ${p.onBoard} L already on board, more than the ${p.asked} L asked: nothing is drained.`,
	lineOnBoardImpossible: (at: string) =>
		`${at}: the journey log burns more fuel than it puts in the tanks, a refuel is missing from it: the fuel on board is unknown.`,
	lineOnBoardIncomplete: (at: string) => `${at}: the journey log reading is incomplete, the fuel on board is unknown.`,
	lineOnBoardLog: (p: { at: string; litres: string; day: string }) =>
		`${p.at}: about ${p.litres} L on board (journey log read on ${p.day}).`,
	lineOnBoardMeasured: (p: { at: string; litres: string; day: string }) =>
		`${p.at}: ${p.litres} L on board (measured on ${p.day}).`,
	lineOnBoardOther: (p: { at: string; reg: string }) =>
		`${p.at}: the fuel on board was read for ${p.reg}, not this aircraft, so it is unknown.`,
	lineOnBoardOverflow: (litres: string) => `The journey log adds ${litres} L more than the tanks hold.`,
	lineOnBoardStale: (flight: string) =>
		`Not read on the flight’s day (${flight}): the aircraft may have flown or been refuelled since.`,
	lineRefusedTick: (p: { at: string; reason: string }) =>
		`${p.at}: refuel set, but ${p.reason}. Arrange it before counting on it.`,
	lineShort: (p: { who: string; landing: string; reserve: string }) =>
		`${p.who}: INSUFFICIENT fuel, ${p.landing} L at landing for a ${p.reserve} L reserve.`,
	lineStationOver: (p: { station: string; kg: string; max: number }) =>
		`${p.station}: ${p.kg} kg, above its ${p.max} kg maximum.`,
	lineTouchdownOver: (p: { who: string; kg: string; max: number }) =>
		`${p.who}: ${p.kg} kg at touchdown, above the ${p.max} kg maximum landing mass.`,
	lineUnavailableMax: (at: string) => `${at}: fuel at takeoff unknown, no quantity keeps the limits.`,
	lineUnavailableMinimum: (at: string) => `${at}: fuel at takeoff unknown, the consumption is unknown.`,
	lineUnavailableTabs: (at: string) => `${at}: fuel at takeoff unknown, the sheet states no tabs quantity.`,
	lineZeroFuelOut: (p: { who: string; arm: string }) =>
		`${p.who}: CG ${p.arm} m, outside the envelope whatever the fuel.`,
	lineZeroFuelOver: (p: { who: string; kg: string; max: number }) =>
		`${p.who}: ${p.kg} kg, above the ${p.max} kg maximum zero-fuel mass.`,
	manualRowTip:
		'Flight manual figure: wind and surface applied, no safety margin (the regulation’s unfactored distance)',
	marginRowTip: (factor: number) =>
		`Distance required: the flight manual figure x${factor} (safety margin), what the verdict reads`,
	massKg: 'Mass (kg)',
	massRowTipMax: 'POH maximum, no loading yet',
	massTipAlternate: ', whose alternate this is',
	massTipHeaviestFrom: (at: string) => `, the heaviest from ${at}`,
	massTipHeaviestLanding: (n: number) => `Heaviest takeoff mass of the plan (trip ${n}): no trip lands here`,
	massTipHeaviestTakeoff: (n: number) => `Heaviest takeoff mass of the plan (trip ${n}): no trip takes off here`,
	massTipLanding: ', at which its landing is evaluated (conservative)',
	massTipTrip: (p: { n: number; route: string }) => `Takeoff mass of trip ${p.n} (${p.route})`,
	maxLandingLine: 'Max landing',
	maxLoad: 'Max load',
	maxLoadOf: (p: { load: string; usable: number }) =>
		`(max load ${p.load} L of ${p.usable} L usable).`,
	maxNoneCell: 'none',
	maxZeroFuelLine: 'Max zero fuel',
	medicalValidity: 'Medical validity',
	mepValidity: 'MEP validity',
	metarTaf: 'METAR and TAF',
	metarUnavailable: 'METAR unavailable',
	metricAria: 'Metric',
	minEndurance: (min: number) => `${min} min endurance`,
	minimumAtTakeoff: 'Minimum at takeoff',
	minimumAtTakeoffTip: 'The burn-off plus the reserve required: the least fuel to take off with for this trip alone',
	modeCustom: 'Custom',
	modeFull: (litres: number | string) => `Full tanks (${litres} L)`,
	modeMax: 'Maximum within limits',
	modeMaxL: (litres: number) => `Maximum within limits (${litres} L)`,
	modeMaxNone: 'Maximum within limits (none)',
	modeMinimumL: (litres: number) => `Minimum (${litres} L)`,
	modeNone: 'No refuel',
	modeTabs: (litres: number | string) => `To tabs (${litres} L)`,
	modeTabsTip: 'Each tank filled to the bottom of its filler neck indicator (tab)',
	momentKgM: 'Moment (kg.m)',
	night: 'night',
	no: 'No',
	noAircraft: 'No aircraft',
	noCaps: 'NO',
	noConsumption: (reg: string) => `${reg} has no consumption figure, so litres are hidden.`,
	noFeasible: (litres: number) => `No feasible strategy with this tank (${litres} L usable).`,
	noLower: 'no',
	noMbSheet: (reg: string) =>
		`${reg} has no mass-and-balance data sheet, import a complete aircraft YAML to use this page.`,
	noPerfSheet: (reg: string) =>
		`${reg} has no performance data sheet, import a complete aircraft YAML to use this page.`,
	noRefuelling: 'No refuelling',
	noRoutePlanned: 'No route planned',
	noTripBurnTip: 'No trip time yet (plan a route), all fuel assumed burnt',
	nomogramAria: 'Performance chart with the current reading path',
	none: 'none',
	notamNote1: 'NOTAM and SUP AIP are published the day before for the next day.',
	notamNote2: 'Consult them through SOFIA-Briefing, or fetch the route corridor (Route tab).',
	notamNote3: 'Add the SUP AIP and AZBA zones to the vertical profile.',
	oeiCheck1500: (pct: string) => `At 1500 ft: ${pct}%, under 0.75%`,
	oeiCheck400: (rate: number) => `At 400 ft: ${rate} ft/min, not above 0`,
	oeiClimbCellTip: (p: { rate: number; tas: number; pct: string }) =>
		`${p.rate} ft/min at ${p.tas} kt true airspeed, a ${p.pct}% gradient`,
	oeiClimbRow: 'One engine inoperative, 1500 ft (%)',
	oeiClimbRowTip: 'The gross climb gradient on one engine 1500 ft above the aerodrome, at the blue line speed (Vyse), from the flight manual’s one engine inoperative climb',
	oeiSufficient: 'One engine climb sufficient?',
	oeiSufficientLandingTip: 'CAT.POL.A.340: on one engine, at least 0.75% at 1500 ft above the landing surface. Below it, an engine failure is planned as in a single-engined aeroplane (CAT.POL.A.300(b)).',
	oeiSufficientTakeoffTip: 'CAT.POL.A.340: on one engine, a positive climb at 400 ft above the take-off surface and at least 0.75% at 1500 ft. Below it, an engine failure is planned as in a single-engined aeroplane (CAT.POL.A.300(b)).',
	openMbSheet: (p: { n: number; route: string }) => `Trip ${p.n}, ${p.route}, on the Mass & balance page`,
	/** The departure's fuel on board (aircraft/onBoard.ts): the fuel
	 *  control's button naming where the figure comes from, and its form. */
	onBoardAboveTank: (usable: number) => `A figure is above the ${usable} L the tanks hold: check it.`,
	onBoardAddFlight: 'Add a flight',
	onBoardAddedAria: (n: number) => `Flight ${n}, litres added before it`,
	onBoardAddedBefore: 'Added before',
	onBoardButton: 'Fuel on board…',
	onBoardCheck: 'Check the fuel in the tanks before flight.',
	onBoardClear: 'Clear',
	onBoardConsumption: 'Consumption',
	onBoardConsumptionTip:
		'The flight time is burnt at this consumption. Empty, the aircraft sheet’s, the one the fuel plan burns with',
	onBoardDone: 'Done',
	onBoardFlightTime: 'Flight time (block)',
	onBoardFlightTimeTip:
		'The flight time the journey log states, from the first movement for takeoff to the final stop (FCL.010), taxi included',
	onBoardFlights: 'Flights since',
	onBoardHoursAria: (n: number) => `Flight ${n}, hours`,
	onBoardLastFull: (litres: number) => `Full tanks (${litres} L)`,
	onBoardLastLitres: 'Quantity',
	onBoardLastLitresAria: 'Litres the last refuel left',
	onBoardLastRefuel: 'Last refuel',
	onBoardLastTabs: (litres: number | string) => `To tabs (${litres} L)`,
	onBoardLead: 'From the aircraft’s journey log since its last refuel, or measured at the aircraft.',
	onBoardMeasured: 'Measured at the aircraft (dipstick or gauges)',
	onBoardMeasuredAria: 'Litres measured on board',
	onBoardMeasuredNote: 'Replaces the journey log’s estimate.',
	onBoardMinutesAria: (n: number) => `Flight ${n}, minutes`,
	onBoardNoAnchor: 'State the last refuel the journey log shows.',
	onBoardNoConsumption: 'This aircraft states no fuel consumption: type one to burn the flight time with.',
	onBoardNoLitres: 'State the litres the last refuel left.',
	onBoardNoTabs: 'This aircraft’s sheet states no tabs quantity: state the litres instead.',
	onBoardOther: (p: { reg: string; current: string }) =>
		`This reading is for ${p.reg}, not ${p.current}: clear it to read this aircraft’s journey log.`,
	onBoardOverflow: (litres: string) =>
		`The journey log adds ${litres} L more than the tanks hold: counted full at that point.`,
	onBoardReadOn: (day: string) => `Read on ${day}`,
	onBoardRemoveFlight: (n: number) => `Remove flight ${n}`,
	onBoardResultEstimate: (p: { flown: string; n: number; burnt: string; lph: string; added: string | null; litres: string }) =>
		`${p.flown} in ${p.n} ${plural(p.n, 'flight', 'flights')}, about ${p.burnt} L at ${p.lph} L/h${p.added ? `, ${p.added} L added` : ''}: about ${p.litres} L on board.`,
	onBoardResultImpossible: (p: { flown: string; burnt: string; available: string }) =>
		`The journey log burns ${p.burnt} L in ${p.flown}, more than the ${p.available} L it puts in the tanks: a refuel is missing from it.`,
	onBoardResultMeasured: (litres: string) => `${litres} L measured on board.`,
	onBoardResultNoFlight: (p: { added: string | null; litres: string }) =>
		`No flight since${p.added ? `, ${p.added} L added` : ''}: ${p.litres} L on board.`,
	onBoardResultUnknown: 'State the last refuel and the flights since, or a quantity measured at the aircraft.',
	onBoardSourceImpossible: 'Journey log: a refuel is missing',
	onBoardSourceIncomplete: 'Journey log incomplete',
	onBoardSourceLog: (day: string) => `Journey log, ${day}`,
	onBoardSourceMeasured: (day: string) => `Measured, ${day}`,
	onBoardSourceOther: (reg: string) => `Read for ${reg}`,
	onBoardStale: (p: { read: string; flight: string }) =>
		`Read on ${p.read}, not on the flight’s day (${p.flight}): the aircraft may have flown or been refuelled since.`,
	onBoardTitle: 'Fuel on board before refuelling',
	onBoardTotal: (p: { flown: string; n: number }) => `Total ${p.flown}, ${p.n} ${plural(p.n, 'flight', 'flights')}`,
	orphansIgnored: (n: number) =>
		`${n} ${plural(n, 'alternate route', 'alternate routes')} without a preceding trip ${plural(n, 'is', 'are')} ignored. Order routes as trip, alternate, trip, ...`,
	over15m: 'Over 15 m (50 ft)',
	overReserve: 'Above the reserve',
	overReserveTip: 'The fuel at landing above the reserve required, in litres and in time at cruise consumption',
	overviewShortTrip: (who: string) => `${who}: INSUFFICIENT fuel. See the Fuel plan page.`,
	paAboveTip: 'Pressure altitude above the POH table',
	pageFuel: 'Fuel plan',
	pageMb: 'Mass & balance',
	pageOverview: 'Overview',
	pagePerf: 'Performance',
	pagesAria: 'Pages',
	pathAerodromeAria: 'Reading path aerodrome',
	pilot: 'Pilot',
	planNothingAdded: 'no uplift',
	planRouteFuel:
		'Plan a route with at least two waypoints and set a cruise speed (Route tab) to build the fuel plan. Flag diversion routes as alternates to include them in the reserves.',
	planRouteTimeline:
		'Plan a route with at least two waypoints and set a cruise speed (Route tab) to build the timeline.',
	planRoutesGrid: 'Plan routes with airport waypoints (or add an aerodrome below) to fill the grid.',
	pohAccelerateStop: 'Accelerate-stop (m)',
	pohCharts: (p: { type: string; lb: number }) => `POH charts (${p.type}, reference ${p.lb} lb)`,
	pohDistances: (p: { type: string; max: number; min: number }) =>
		`POH distances (${p.type}, ${p.max} / ${p.min} kg)`,
	pohOeiClimb: 'One engine inoperative climb (ft/min)',
	pointLanding: (kg: number) => `Landing ${kg} kg`,
	pointTakeoff: (kg: number) => `Takeoff ${kg} kg`,
	polarDay: 'polar day',
	polarNight: 'polar night',
	potentialTip:
		'Remaining flight time before the next scheduled maintenance check (the sheet’s Potentiel). Enter h:mm, or bare minutes.',
	precipReported: 'precipitation reported',
	pressureAltFt: 'Pressure altitude (ft)',
	printDossier: 'Print flight dossier',
	printDossierTip:
		'Print flight dossier (the four pages plus each route’s nav log, frequencies and vertical profile)',
	printPage: 'Print this page',
	printPrep: 'Print flight preparation',
	printPrepTip: 'Print flight preparation (all four pages, A4 landscape)',
	progressAria: 'Print preparation progress',
	progressCharts: 'Downloading TEMSI / WINTEM charts',
	progressDatasets: 'Loading reference data',
	progressIssueDatasets: 'Some reference data could not be loaded.',
	progressIssueMsa: 'Minimum safe altitudes unavailable for at least one route (blank MSA cells).',
	progressIssueTerrain: 'Terrain profile unavailable for at least one trip.',
	progressIssueWind: 'Forecast winds unavailable, the manual wind applies.',
	progressIssueWindBlank: 'Forecast winds unavailable and no manual wind set (blank MH and ETE/W cells).',
	progressIssuePerfForecast: (icao: string) =>
		`${icao}, no forecast for the planned take-off or landing time, the performance page uses an older METAR or estimates`,
	progressMsa: 'Computing minimum safe altitudes',
	progressPages: 'Laying out the sheets',
	progressPrintAnyway: 'Print anyway',
	progressRetry: 'Retry',
	progressReviewNote: 'Print anyway, or retry once the data is available.',
	progressReviewTitle: 'Some data is missing',
	progressTerrain: 'Loading the terrain profile',
	procCellTitle: (p: { icao: string; proc: string }) => `${p.icao}: ${p.proc}`,
	procFlapsOnly: (flaps: number) => `Flaps ${flaps}°`,
	procNone: 'None fits',
	procNoneShort: 'None',
	procNormal: (flaps: number | null) => (flaps == null ? 'Normal' : `Normal (flaps ${flaps}°)`),
	procShortField: (flaps: number | null) => (flaps == null ? 'Short field' : `Short field (flaps ${flaps}°)`),
	procShortFieldOnlyTip: (flaps: number | null) =>
		`The flight manual charts its short-field takeoff only. Fly it${flaps == null ? '' : `, flaps ${flaps}°`}, with its own lift-off and 15 m speeds and the checklist to match.`,
	procShortFieldTip: (flaps: number | null) =>
		`The normal takeoff does not fit the declared distances. Fly the flight manual short-field takeoff${flaps == null ? '' : `, flaps ${flaps}°`}, with its own lift-off and 15 m speeds and the checklist to match.`,
	progressTitleDossier: 'Preparing the flight dossier',
	progressTitlePrep: 'Preparing the print',
	progressTitleWx: 'Preparing the weather briefing',
	progressWind: 'Fetching forecast winds',
	progressWx: 'Downloading METAR and TAF',
	qnhDefaultTip: 'The QNH a column uses where neither a METAR nor a forecast gives one, also the transition level’s. A value typed in a column overrides it.',
	qnhDefaultLabel: 'QNH where nothing is observed',
	qnhDossierTip: (qnh: number) => `QNH ${qnh} hPa, the default where nothing is observed (no live METAR or forecast).`,
	qnhMetarTip: (p: { qnh: number; prov: string }) => `QNH ${p.qnh} hPa ${p.prov}.`,
	qnhStandardTip: (qnh: number) => `QNH ${qnh} hPa, standard (no live METAR or forecast).`,
	recommendationLead: 'Recommendation:',
	refreshAllTip: 'Refresh every METAR now',
	fuelNotServed: (p: { icao: string; grades: string }) =>
		`${p.icao} does not publish ${p.grades}`,
	fuelNotamNoneAt: (p: { icao: string; notam: string }) =>
		`NOTAM ${p.notam} withdraws all fuel at ${p.icao}`,
	fuelNotamGradeAt: (p: { icao: string; notam: string; grades: string }) =>
		`NOTAM ${p.notam} withdraws ${p.grades} at ${p.icao}`,
	alternateFuelNote:
		'The diversion is flown on fuel carried from the last stop, so the plan stands. An aeroplane that diverts lands on its final reserve, and these alternates could not refuel it on an unannounced arrival.',
	fuelNoneAt: (icao: string) => `${icao} publishes no fuel`,
	refuelDemotedAboard: (p: { at: string; aboard: string; max: number }) =>
		`about ${p.aboard} L are already on board at ${p.at}, above the ${p.max} L the limits allow: defuel or lighten the load.`,
	refuelDemotedLimits: (p: { from: string; maxL: number }) =>
		`at its loads a trip is out of the mass and CG limits (at most ${p.maxL} L from ${p.from}).`,
	refuelDemotedMassMax: (p: { at: string; kg: string; max: number; from: string; maxL: number }) =>
		`its takeoff from ${p.at} weighs ${p.kg} kg, above the ${p.max} kg maximum (at most ${p.maxL} L from ${p.from}).`,
	refuelGradeLead: 'Check the uplift:',
	fuelBasedAt: (icao: string) => `${icao} reserves its fuel for based aircraft`,
	fuelOnRequestAt: (icao: string) => `${icao} serves fuel on request`,
	fuelNoHoursAt: (icao: string) => `${icao} has no set fuel hours`,
	refuelCautionLead: 'Arrange beforehand:',
	refuelDemotedLead: 'Fewest refuels:',
	refuelDemotedJoin: ', but',
	refuelListLead: 'Refuelling:',
	refuelNoneServed:
		'No strategy refuels only where fuel is available. This plan is flown on fuel carried, or the stop is arranged beforehand.',
	refuelNoneWithinLimits:
		'No strategy keeps the mass and CG limits at its loads with this payload: reduce the payload.',
	refuelNoneWithinLimitsAboard: (p: { at: string; aboard: string; max: number }) =>
		`No strategy keeps the mass and CG limits: about ${p.aboard} L are already on board at ${p.at}, above the ${p.max} L the limits allow. Defuel or lighten the load.`,
	refuelPayloadOut: 'A limit no fuel quantity cures is broken: see the Mass & balance page.',
	refuelStrategyBlockedTip:
		'This strategy refuels where the fuel is not available to this aeroplane',
	refuelAt: (stops: string) => `Refuel at ${stops}`,
	/** The refuelling strategies' one head over the stops' columns, each
	 *  column then headed by its aerodrome alone. */
	refuelPlanHeading: 'Refuelling plan',
	refuelPlanNote:
		'Strict minimum to embark at each takeoff: enough at every upcoming landing to divert and keep the reserve, until the next refuelling.',
	refuelStrategyOverLimitsTip: 'At these loads a trip is out of the mass and CG limits',
	refusalShortBased: 'Based aircraft only (AIP)',
	refusalShortGrade: (grades: string) => `No ${grades} (AIP)`,
	refusalShortNone: 'No fuel (AIP)',
	refusalShortNotamAll: (notam: string) => `No fuel, NOTAM ${notam}`,
	refusalShortNotamGrade: (p: { grades: string; notam: string }) => `No ${p.grades}, NOTAM ${p.notam}`,
	removeAerodromeTip: 'Remove this aerodrome',
	removeIcaoAria: (icao: string) => `Remove ${icao}`,
	requiredAsdRow: (pct: number) => `Required (+${pct}%)`,
	reserveKept: (p: { min: number; dayNight: string }) =>
		`${p.min} min final reserve kept (${p.dayNight} flight).`,
	resetLiveWx: 'Reset to live weather',
	resetLiveWxTip:
		'Clear every typed QNH, temperature and wind back to the live-weather defaults',
	requiredD15Row: (pct: number) => `Required (+${pct}%)`,
	requiredRollRow: (pct: number) => `Required (+${pct}%)`,
	retrievedStamp: (time: string) => `Retrieved ${time}, check for updates before departure.`,
	rollMass: (massKg: number) => `Roll ${massKg}`,
	rowEmpty: 'Empty aircraft',
	rowEnduranceTip: 'The fuel at takeoff at cruise consumption: item 19 E/ of the ICAO flight plan',
	rowFuel: 'Fuel',
	rowFuelAtLanding: 'Fuel at landing',
	rowFuelAtTakeoff: 'Fuel at takeoff (L)',
	rowFuelSufficient: 'Fuel sufficient?',
	rowMaxWithin: 'Maximum within limits',
	rowMaxWithinTip:
		'The most fuel at this takeoff keeping every trip until the next refuel within the mass and CG limits, rounded down to the litre',
	rowMb: 'Mass and balance',
	rowMbTip: 'Within the limits at takeoff, landing and zero fuel. Opens the sheet of this trip on the Mass & balance page',
	rowNeeded: 'Needed until the next refuel',
	rowNeededTip:
		'The least fuel at this takeoff for every trip until the next refuel, each landing keeping its diversion and its reserve, rounded up to the litre',
	rowOnArrival: 'On board before refuelling',
	rowRefuel: 'Refuel before takeoff',
	rowRefuelTip:
		'The fuel set at this takeoff. No refuel takes off with what the tanks hold: at the departure as read from the journey log (the button under it), at a stop as the previous trip leaves it. No AVGAS refuelling while passengers embark, are on board or disembark (NCO.OP.145).',
	rowReserve: 'Reserve required',
	rowReserveTip:
		'What the trip must land with: the diversion to the alternate, its procedure and its wind allowance, the discretionary margin and the final reserve',
	rowTouchdownTip:
		'The landing mass plus the whole taxi allowance, burnt after touchdown, and the contingency, which the flight may not use: what the maximum landing mass limits',
	rowUplift: 'Uplift',
	rowUpliftTip:
		'The fuel added at this takeoff, in whole litres rounded for its target. What is on board is an estimate (the journey log at the departure, what the previous trip leaves at a stop): the fuel at takeoff is what the gauges must read',
	rowWithinLimits: 'Within limits?',
	runwayQfu: 'Runway (QFU)',
	/** A runway end a NOTAM has closed, in the performance picker. */
	runwayClosedOption: (id: string) => `${id} (closed)`,
	runwayClosedTitle: 'Closed by NOTAM',
	rwyAutoTip: 'auto: runway most into wind, pick to override',
	rwyPickLostTip: 'the runway picked is no longer published, runway most into wind instead, pick again to override',
	seaLevel: 'Sea level',
	secAdmin: 'A) Planned flight / administrative',
	secCharts: 'D) Charts',
	secNotam: 'C) NOTAM and SUP AIP',
	secWeather: 'B) Weather',
	selectAircraftNote: 'Select an aircraft (Aircraft tab).',
	selectAircraftTip: 'Select an aircraft in the Aircraft tab',
	selectForLitres:
		'Select an aircraft (Aircraft tab) to convert minutes to litres and check the tank.',
	selectForMb: 'Select an aircraft (Aircraft tab) to compute mass & balance.',
	selectForPerf: 'Select an aircraft (Aircraft tab) to compute runway performance.',
	sepValidity: 'SEP validity',
	setEtd: 'Set the ETD to compute the timeline and the endurance limit.',
	sheetMax: (litres: string) => `maximum within limits ${litres} L`,
	sheetMaxNone: 'no quantity keeps the limits',
	sheetNeeded: (litres: string) => `needed ${litres} L`,
	sheetsNavAria: 'Trips',
	stationCarriedTip: (kg: number) => `${kg} kg, carried over from the trip before`,
	stationMax: (kg: number) => `(max ${kg} kg)`,
	softFieldNote: (p: { flaps: number; icaos: string }) =>
		`Unpaved runway (${p.icaos}): the flight manual soft-field takeoff may call for flaps ${p.flaps}° whatever the length.`,
	stopModeFull: 'Full tanks',
	stopModeMax: 'Maximum',
	stopModeMinimum: 'Minimum',
	stopModeTabs: 'To tabs',
	stopN: (n: number) => `stop ${n}`,
	strategy: 'Strategy',
	subjLanding: (at: string) => `landing at ${at}`,
	subjTakeoff: (at: string) => `takeoff from ${at}`,
	subjTrip: (p: { n: number; what: string }) => `Trip ${p.n}, ${p.what}`,
	subjZeroFuel: 'zero fuel',
	sunrise: 'Sunrise (UTC)',
	sunriseTip: 'NOAA sunrise at the aerodrome on the flight date',
	sunset: 'Sunset (UTC)',
	sunsetTip: 'NOAA sunset at the aerodrome on the flight date',
	tailwindCalmTip: 'Tailwind 0 kt, assuming calm (no live METAR).',
	tailwindInfluence: (pct: number) => `Tailwind influence: add ${pct}% of distance per 2 kt.`,
	tailwindKt: 'Tailwind (kt)',
	tailwindMetarTip: (p: { kt: number; prov: string }) => `Tailwind ${p.kt} kt ${p.prov}.`,
	tailwindRowTip: 'Tailwind component along the runway',
	tailwindZeroTip: 'Tailwind 0 kt, since a headwind is typed for this runway.',
	takeLitresAt: (p: { litres: number; at: string }) => `Take ${p.litres} L at ${p.at}`,
	takeLitresAtTip: 'Sets this takeoff to the maximum within limits',
	takeoff: 'Takeoff',
	takeoffPerfHeading: 'Takeoff performance',
	takeoffProcedure: 'Takeoff procedure',
	takeoffProcedureTip: 'The normal takeoff whenever its distances suffice, else the short-field one',
	tankLitres: (litres: string) => `(${litres} L)`,
	tankOrderTip: 'The fuel fills the tanks in the order the data sheet lists them and is burnt in the reverse order.',
	taxi: 'Taxi',
	taxiTip: 'Default 10 min per trip: 5 at the departure + 5 at the destination',
	tempIsaTip: (temp: number) =>
		`Temperature ${temp} °C, ISA at the pressure altitude (no live METAR or forecast).`,
	tempMetarTip: (p: { temp: number; prov: string }) => `Temperature ${p.temp} °C ${p.prov}.`,
	temperatureC: 'Temperature (°C)',
	threeRs: 'Does the flight seem',
	timeToCheck: 'Time to next check (h:mm)',
	title: 'Flight preparation',
	todaTip: 'Takeoff distance available (declared)',
	toraTip: 'Takeoff run available (declared)',
	touchdownRow: 'Touchdown',
	tripBurnTip: (min: number) => `Burn-off: ${min} min at cruise consumption, wind and contingency included`,
	tripCaption: (p: { n: number; route: string }) => `Trip ${p.n}, ${p.route}`,
	tripChipAria: (p: { n: number; route: string; verdict: string }) =>
		`Trip ${p.n}, ${p.route}, within limits: ${p.verdict}`,
	tripN: (n: number) => `Trip ${n}`,
	trips: 'Trips',
	twinSpeeds: (p: { vmc: number; vyse: number }) =>
		`One engine inoperative: Vmc ${p.vmc} kt (red line), Vyse ${p.vyse} kt (blue line), calibrated airspeeds.`,
	type: 'Type',
	typeToOverrideHint: ' Type to override, clear to restore the automatic value.',
	unknownChipTip: (key: string) => `${key} is not in your fleet. Import it in the Aircraft tab`,
	unknownIdent: (icao: string) => `${icao}: unknown aerodrome ident`,
	unpavedTip: 'Applied unless the runway is known to be paved',
	upliftShort: (litres: string) => `+${litres} L`,
	useThisPlan: 'Use this plan',
	useThisPlanTip:
		'Refuels at these stops (at the Minimum where no refuel is set yet) and nowhere else. The departure keeps its fuel unless that breaks a mass or CG limit, then it takes the maximum within limits. A departure with no refuel takes the Minimum, which adds nothing when what is on board covers it.',
	verdictDotSr: 'A verdict on this page is NO.',
	vertProfile: 'Vertical profile',
	wet: 'Wet',
	wetCorrection: (pct: number) => `Wet runway = +${pct}%.`,
	windAllowance: 'Wind allowance',
	windMultiplyBy: (p: { kt: number; factor: string }) => `${p.kt} kt multiply by ${p.factor}`,
	windowAboveOnArrival: (p: { at: string; aboard: string; max: string }) =>
		`${p.at}: ${p.aboard} L arrive, above the ${p.max} L the limits allow there. Nothing to add.`,
	windowAtMost: (litres: string) => `at most ${litres} L`,
	windowBeyondTank: (p: { at: string; needed: string; usable: string }) =>
		`${p.at}: ${p.needed} L needed until the next refuel, more than the ${p.usable} L the tanks hold: refuel further on.`,
	windowEmpty: (p: { at: string; needed: string; max: string }) =>
		`${p.at}: ${p.needed} L needed until the next refuel, more than the ${p.max} L the limits allow: reduce the payload or refuel further on.`,
	windowLine: (p: { at: string; litres: string; plan: string }) => `${p.at}: take off with ${p.litres}. Your plan: ${p.plan}.`,
	windowLineUplift: (p: { at: string; litres: string; uplift: string; plan: string }) =>
		`${p.at}: take off with ${p.litres} (${p.uplift}). Your plan: ${p.plan}.`,
	windowLitres: (p: { lo: string; hi: string }) => `${p.lo} to ${p.hi} L`,
	windowLitresOne: (litres: string) => `${litres} L`,
	windowUplift: (p: { lo: string; hi: string; grade: string }) => `about +${p.lo} to +${p.hi} L ${p.grade}`,
	windowUpliftOne: (p: { n: string; grade: string }) => `about +${p.n} L ${p.grade}`,
	windowUpliftUpTo: (p: { hi: string; grade: string }) => `nothing to add, at most +${p.hi} L ${p.grade}`,
	withinEnvelope: 'Within the envelope at takeoff, landing and zero fuel.',
	withinUsable: 'Within usable fuel?',
	withoutRefuelling: (p: { litres: string; time: string; usable: number }) =>
		`Without refuelling: ${p.litres} L (${p.time}), more than the ${p.usable} L the tanks hold.`,
	wxAndLegs: (n: number) => `${n} ${plural(n, 'leg', 'legs')} with a manual wind`,
	wxBriefingOn: 'Weather briefing on',
	/** The strip's estimate group: what its columns fall back to. */
	wxChangeWind: 'Change',
	wxChangeWindTip: 'Set the plan’s wind in the Route tab (Flight parameters)',
	wxEstimatedHead: 'Estimated: default QNH, ISA temperature, calm wind',
	wxEstimatedNote: 'estimated: default QNH, ISA temperature, calm wind',
	wxFetching: (head: string) => `${head}, fetching METAR...`,
	/** The strip's forecast group: the day of its first line, and the runs
	 *  when every line shares them. */
	wxForecastHead: (p: { day: string; source: string | null }) =>
		p.source ? `Forecast for ${p.day} (${p.source})` : `Forecast for ${p.day}`,
	wxForecastPending: 'fetching the forecast...',
	/** The Overview's forecast temperatures over the plan: the ISA deviation
	 *  ("ISA +6"), then the lowest freezing level, `first` when it opens the
	 *  line (no deviation stated). */
	wxFreezingAtOrBelow: (p: { ft: string; first: boolean }) =>
		`${p.first ? 'Freezing' : 'freezing'} level at or below ${p.ft}`,
	wxFreezingDownTo: (p: { ft: string; first: boolean }) => `${p.first ? 'Freezing' : 'freezing'} level down to ${p.ft}`,
	wxIsa: (dev: string) => `ISA ${dev}`,
	/** The Overview's missed legs: one leg of a single trip named, more
	 *  counted, then what they fly (wxMissedManual / wxMissedStillAir). */
	wxLegWithout: (leg: number) => `Leg ${leg} without a forecast`,
	wxLegend:
		'Each field’s gray placeholder is the live-weather default: the METAR, or the forecast for a take-off or landing more than two hours from it (amber when neither is available). Type to override, clear to restore.',
	/** The levels behind the Overview's mean wind: one (" at 3500 ft") or
	 *  the range (", 2500 ft to FL 065"); `fl` when a level is a flight level,
	 *  which French contracts ("au FL 065"). */
	wxLevelAt: (p: { level: string; fl: boolean }) => ` at ${p.level}`,
	wxLevelRange: (p: { low: string; lowFl: boolean; high: string; highFl: boolean }) => `, ${p.low} to ${p.high}`,
	/** The Overview's mean forecast wind with its levels (wxLevelAt /
	 *  wxLevelRange), worded to fit its column on paper. */
	wxMean: (p: { wind: string; levels: string }) => `Mean forecast wind ${p.wind}${p.levels}`,
	wxMeanLight: (levels: string) => `Forecast wind light and variable${levels}`,
	wxMeanVaries: (levels: string) => `Forecast wind varies${levels}`,
	/** A strip line: its head, then the values its columns hold. */
	wxMissedManual: (wv: string) => `, manual wind ${wv}`,
	wxMissedStillAir: ', still air',
	wxNoWind: 'No wind known: still air',
	wxQnhDefault: 'default, no METAR or forecast',
	wxQnhForecast: (at: string) => `forecast for ${at}`,
	wxQnhHead: 'Departure QNH',
	wxQnhMetar: (p: { id: string; at: string }) => `${p.id} METAR ${p.at}`,
	wxQnhStandard: 'standard, no METAR or forecast',
	wxQnhTyped: 'typed on the performance page',
	wxLegsWithoutCount: (n: number) => `${n} ${plural(n, 'leg', 'legs')} without a forecast`,
	wxLine: (p: { head: string; values: string }) => `${p.head}: ${p.values}`,
	/** A strip line's head: the aerodrome, the phase where only one of its
	 *  columns reads the line, and the instant a forecast is read at. */
	wxLineHead: (p: { icao: string; phase: 'takeoff' | 'landing' | null; at: string | null }) =>
		[p.icao, p.phase === 'takeoff' ? 'takeoff' : p.phase === 'landing' ? 'landing' : null, p.at]
			.filter(Boolean)
			.join(' '),
	wxLiveOffNote: 'Live weather off: default QNH, ISA temperature, calm wind.',
	/** The strip's METAR group. */
	wxMetarHead: 'METAR',
	wxMetarTooOld: (p: { head: string; id: string; at: string; age: string }) =>
		`${p.head}, METAR ${p.id} too old (${p.at}, ${p.age})`,
	wxNoForecast: 'no forecast',
	/** The instants a METAR stands in for, one or both of its columns'. */
	wxNoForecastAt: (at: readonly string[]) => `no forecast for ${at.join(' and ')}`,
	wxNoStation: (head: string) => `${head}, no METAR station within 50 NM`,
	wxNote1: 'Summarise the key points and threats of the day.',
	wxNote2: 'Add the ceiling to the vertical profile.',
	wxRefreshFailedNote: 'refresh failed',
	/** The station a METAR line reads, where it is not the aerodrome's own. */
	wxStationAway: (p: { id: string; dist: string }) => `${p.id} ${p.dist} away`,
	wxTypedNote: 'typed values in use',
	/** `head`: a strip line's (wxLineHead), or the ICAO of a print issue. */
	wxUnavailable: (head: string) => `${head}, weather unavailable`,
	wxWindForecast: 'Forecast winds',
	wxWindHead: 'Wind the plan flies',
	wxUsedHeading: 'Weather used',
	yes: 'Yes',
	yesLower: 'yes',
	yourPlan: 'Your plan',
	yourPlanOverLimits: 'Your plan, out of the limits',
	yourPlanShort: 'Your plan, fuel short',
	zeroFuel: 'Zero fuel',
	zeroFuelTip: 'All fuel burnt, the lowest point of the CG travel line',
};
