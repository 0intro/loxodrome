/* The app-wide viewing conditions: the period and the level band the WHOLE map
 * is read at (NOTAMs, SUP AIP zones, airspace activation, SIGMETs, cue rings).
 * The two toolbar chips and the popover they open. The NOTAM-only filters
 * (flight rules, kind) stay in ./filter. Keys are alphabetized; the French
 * mirror is ../fr/conditions.ts. */

export const conditions = {
	allLevels: 'All levels',
	ceiling: 'Ceiling',
	ceilingAria: 'Band ceiling',
	chipTitle: (p: { axis: string; value: string }) =>
		`${p.axis}: ${p.value}\nSet the period and levels the map is read at`,
	custom: 'Custom',
	flight: 'Flight',
	flightNeedsRoute: 'Plan a route to use the flight period.',
	flightNoEtd: 'No departure time set; the next full hour is used.',
	flightWindow: (window: string) => `Your flight: ${window}.`,
	floor: 'Floor',
	floorAria: 'Band floor',
	from: 'From',
	fromDateAria: 'From date',
	fromTimeAria: 'From time (defaults to 00:00)',
	horizonAll: 'All',
	horizonHours: (h: number) => `${h} h`,
	horizonLegend: 'Look ahead',
	levels: 'Levels',
	levelsLegend: 'Levels',
	levelsNote:
		'Applies to NOTAMs (their F/G limits, else the Q-line band), airspaces, SUP AIP zones and SIGMETs.',
	limitToBand: 'Limit to a level band',
	next: (h: number) => `Next ${h} h`,
	now: 'Now',
	nowNote: 'The map shows what is in force now and what comes within the look-ahead.',
	period: 'Period',
	periodInvalid: 'Period not set',
	periodLegend: 'Period (UTC)',
	title: 'Period and levels',
	to: 'To',
	toDateAria: 'To date',
	toTimeAria: 'To time (defaults to 00:00)',
};
