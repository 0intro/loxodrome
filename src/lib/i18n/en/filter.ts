/* Filters popover + active-filter chips: the NOTAM-only data filters (flight
 * rules, kind), opened from the funnel in the NOTAMs tab head. The period and
 * the level band govern the whole map and live in ./conditions. The validation
 * error thunks live in ./errors; the NOTAM search placeholder lives with the
 * list in ./notam. */

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
	noNotams: 'NOTAM-specific filters appear once NOTAMs are parsed.',
	open: 'Filters',
	outsidePeriod: (n: number) => `Outside the period (${n})`,
	outsidePeriodNote:
		'Kept in the list and readable; the map draws the period only.',
	scopeNote:
		'These filters apply to the NOTAM briefing only. The period and levels, in the toolbar, apply to the whole map.',
	setByRoute: 'Set by your route',
	showAll: 'Show all',
	showing: (p: { shown: number; total: number }) =>
		`Showing ${p.shown} of ${p.total} NOTAMs.`,
};
