/* Navigation-log wording: the NavLogModal / NavLogSheet / NavLogSchedule
 * chrome, the header tooltips spelling out the invariant ICAO Doc 8400
 * abbreviations (Alt / MSA, MC / MH, Dist / Rem, ETE / ETE/W, ETO, ATO,
 * Cum), and the per-leg wind provenance built at render time in
 * state/routeWind.svelte.ts (windTip* / windSummary*). The wind-summary
 * words feed the locale-free windSummaryNote in $lib/route/legWind
 * (docs/i18n.md rule 6). */

import { plural } from './plural';

export const navlog = {
	addWaypoints: 'Add at least two waypoints to build a nav log.',
	airportFreqs: 'Airport frequencies',
	airportFreqsTip:
		"List each airport waypoint's published COM frequencies (TWR, GND, ATIS, A/A, …) under its report banner in the nav log, with any active frequency-change NOTAM applied.",
	airspace: 'Airspace',
	airspacesUnavailable: 'Airspaces unavailable (the dataset failed to load).',
	atoTip: 'Actual time over the waypoint',
	columnsAria: 'Nav log content',
	columnsTip: 'Optional nav-log content: airport / enroute frequencies, VOR radials',
	classATip: 'Upper Class A floor (stay below in VFR)',
	cumTip: 'Cumulative distance from departure (NM)',
	enrouteFreqs: 'Enroute frequencies',
	enrouteFreqsTip:
		"List each leg's controlling and FIS frequencies (Class A IFR, B, C, D, Class E IFR, SIV, RMZ) under its waypoint in the nav log, below the airport frequencies, and save them in the route file.",
	enter: 'Enter',
	etoLiveTip: 'Estimate at the live ground speed, re-anchored at each passed waypoint',
	etoTip: 'Estimated time over the waypoint',
	forecastFallback: 'forecast',
	freqEditAria: 'Edit the waypoint frequencies',
	freqEditTip:
		'Edit the frequencies (a blank line draws the dotted separator, clearing the text restores the automatic list)',
	freqClosedTip: (id: string) => `Withdrawn by NOTAM ${id}`,
	freqManualTip: 'Manual frequencies for this waypoint',
	freqResetAria: 'Reset to the automatic frequencies',
	freqResetTip: 'Reset to the automatic frequencies',
	freqTextAria: 'Waypoint frequencies',
	frequency: 'Frequency',
	hdrAltTip: 'Planned cruise altitude (ft), a flight level above the transition altitude',
	hdrDistTip: 'Leg distance (NM)',
	hdrEteTip: 'Estimated time en route, still air (this leg)',
	hdrEteWTip: 'Estimated time en route, wind corrected (this leg)',
	hdrMcTip: 'Magnetic course (track)',
	hdrMhTip: 'Magnetic heading',
	hdrMsaTip: 'Minimum safe altitude (ft)',
	hdrRemTip: 'Distance remaining to destination (NM)',
	leave: 'Leave',
	levelWarnTip: 'Not a semicircular cruising level for this magnetic track',
	loadingAirspaces: 'Loading airspaces…',
	noAirspaceCrossed: 'No controlled airspace, SIV, or zone crossed at the planned altitudes.',
	notes: 'Notes',
	printAllAria: 'Print all routes (A5 kneeboard)',
	printAllTip: 'Print all routes, two A5 cards per A4 landscape',
	printRouteAria: 'Print this route',
	printRouteTip: 'Print this route (A4 portrait)',
	radialFoot:
		'Radials are magnetic (WMM); published values may differ by about a degree (station calibration epoch).',
	radialTip: 'VOR tuning and magnetic radial',
	scheduleEteTip: 'Estimated time en route, wind corrected where a wind resolves (still air otherwise)',
	scheduleHeading: 'Radio & airspace schedule',
	showOnMap: (label: string) => `Show ${label} on the map`,
	total: 'Total',
	totalEteTip: 'Total estimated time en route',
	vorRadials: 'VOR radials',
	vorRadialsTip:
		"Show the VOR radial banner in each waypoint's notes: the tuned station (ident and frequency) and the QDR or QDM magnetic radial of the leg leaving it.",
	waypoint: 'Waypoint',
	waypointNotesAria: 'Waypoint notes',
	windAvgHead: (kt: number) => `avg ${kt} kt headwind`,
	windAvgTail: (kt: number) => `avg ${kt} kt tailwind`,
	windDelta: (signedMin: string) => `wind ${signedMin} min`,
	windSummaryBeyond: (p: { legs: number; reach: string }) =>
		`Forecast reaches ${p.reach}, ${p.legs} ${plural(p.legs, 'leg', 'legs')} beyond`,
	windSummaryBeyondNoReach: (legs: number) =>
		`${legs} ${plural(legs, 'leg', 'legs')} beyond the forecast horizon`,
	windSummaryForecast: (p: { model: string; run: string | null; from: string; to: string | null }) =>
		`Winds ${p.model}${p.run ? `, run ${p.run}` : ''}, valid ${p.from}${p.to ? ` to ${p.to}` : ''}`,
	windSummaryManual: (wv: string) => `Wind ${wv} manual`,
	windSummaryOutOfRange: (days: number) => `Departure beyond the ${days}-day forecast range`,
	windSummaryOverridden: (n: number) => `, ${n} ${plural(n, 'leg', 'legs')} overridden`,
	windSummaryPerLeg: 'Per-leg manual winds',
	windSummaryQuota: 'Forecast quota spent',
	windSummaryRateLimited: 'Rate limit reached, retrying',
	windSummaryTip: 'Wind source used for the MH and ETE/W columns',
	windSummaryUnavailable: 'Forecast unavailable',
	windTip: (wv: string) => `Wind ${wv}`,
	windTipAboveTop: ' (above the forecast ladder, topmost-level wind shown)',
	windTipBelowGround: ' (10 m wind, level below terrain)',
	windTipForecast: (model: string) => `Forecast ${model}`,
	windTipLevel: (ft: number) => `${ft} ft AMSL`,
	windTipLevelTemp: (p: { tempC: number; isaDev: string }) => `, ${p.tempC} °C (ISA ${p.isaDev})`,
	windTipManual: 'Global manual wind',
	windTipManualBeyondHorizon: 'Global manual wind, the forecast horizon does not reach this leg',
	windTipManualUnavailable: 'Global manual wind, forecast unavailable',
	windTipOverride: 'Manual override for this leg',
	windTipRunValid: (p: { run: string; valid: string }) => `Run ${p.run}, valid ${p.valid}`,
	windTipShear: (kt: number) => `Vertical shear ${kt} kt per 1000 ft`,
	windTipTas: (kt: number) => `TAS ${kt} kt, temperature corrected`,
	windTipValid: (valid: string) => `Valid ${valid}`,
	wmmExpiredTip:
		'WMM2025 validity ended 31 December 2029; magnetic values use the frozen 2030.0 declination.',
};
