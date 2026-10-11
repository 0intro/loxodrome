/* Filters popover + active-filter chips: the NOTAM-only data filters (flight
 * rules, the route corridor, kind), opened from the funnel in the NOTAMs tab
 * head, and the list's empty states. The period and the level band
 * govern the whole map and live in ./conditions. The validation error thunks
 * live in ./errors; the NOTAM search placeholder lives with the list in
 * ./notam. */

import { plural } from './plural';

export const filter = {
	chipClearAria: (name: string) => `Clear filter: ${name}`,
	chipEditTip: 'Adjust this filter',
	flightRulesLegend: 'Flight rules',
	flightRulesNote:
		'VFR hides IFR-only NOTAMs, IFR hides VFR-only. Keys on the Q-line traffic qualifier. NOTAMs relevant to both (IV) and unclassified NOTAMs always show.',
	hiddenByFilters: (n: number) =>
		`${n} ${plural(n, 'NOTAM', 'NOTAMs')} hidden by filters.`,
	kindAreas: 'Areas',
	kindLegend: 'Kind',
	kindPositions: 'Positions',
	kindQline: 'Q-line positions',
	modeAll: 'All',
	modeRoute: 'Route',
	modeRouteTip: 'Follow the flight rules of your route. Picking All, VFR or IFR pins them.',
	noNotams: 'NOTAM-specific filters appear once NOTAMs are parsed.',
	noneInPeriod: (n: number) => `No NOTAMs in the period. ${n} outside it.`,
	open: 'Filters',
	outsideFetch: (n: number) =>
		`${n} ${plural(n, 'NOTAM', 'NOTAMs')} outside the region that was fetched.`,
	outsidePeriod: (n: number) => `Outside the period (${n})`,
	outsidePeriodNote:
		'Kept in the list and readable; the map draws the period only.',
	routeChipTip:
		'Only the NOTAMs within your routes’ corridor. Set here or in the Route tab.',
	routeLegend: 'Route corridor',
	routeOnlyTip:
		'Keep only the NOTAMs within any route’s corridor, at the width set in the Route tab: areas, positions and radii are tested against the track, FIR-wide NOTAMs kept for the FIRs crossed. The Route tab carries the same switch.',
	scopeNote:
		'These filters apply to the NOTAM briefing only. The period and levels, in the toolbar, apply to the whole map.',
	setByRoute: 'Set by your route',
	showAll: 'Show all',
	showAllTip:
		'Clears every filter hiding NOTAMs from the list and the map, the level band included. The period stays as it is.',
	showOutside: (n: number) => plural(n, 'Show it', 'Show them'),
	showing: (p: { shown: number; total: number }) =>
		`Showing ${p.shown} of ${p.total} NOTAMs.`,
};
