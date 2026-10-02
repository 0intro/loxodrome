/* Page state for the flight-preparation surface (dossier, fuel plan, mass &
 * balance, performance). Open-ness and placement are the workspace slot; see
 * aboutModal.svelte.ts.
 *
 * It opens as a page filling the stage, which claims the overlay slot and so
 * displaces whatever else held it. Nothing here reaches into another surface
 * module to close it: the workspace arbitrates, which is also what lets a
 * docked profile stay up beside this one. */

import type { NomogramMetric } from '$lib/aircraft/performanceChart';
import { readItem, removeItem, writeItem } from './persist';
import { cancelWxPrint } from './wxPrint.svelte';
import { closeSurface, isOpen, openSurface, requestCloseSurface } from './workspace.svelte';

export type FlightPrepPage = 'dossier' | 'fuel' | 'mb' | 'perf';

/** The performance page's nomogram reading, a preference (docs/preferences.md):
 *  which curve the chart draws, the same on screen and on paper. The chart's
 *  flap configuration and aerodrome stay on the page, being indices into one
 *  aircraft's configurations and one plan's aerodromes. */
const NOMOGRAM_METRIC_KEY = 'loxodrome:perf-nomogram-metric';
const DEFAULT_NOMOGRAM_METRIC: NomogramMetric = 'distance15m';

const local = $state<{ page: FlightPrepPage; nomogramMetric: NomogramMetric }>({
	page: 'dossier',
	nomogramMetric:
		readItem(NOMOGRAM_METRIC_KEY) === 'groundRoll' ? 'groundRoll' : DEFAULT_NOMOGRAM_METRIC,
});

export const flightPrepModal = {
	get open(): boolean {
		return isOpen('flightPrep');
	},
	get page(): FlightPrepPage {
		return local.page;
	},
	set page(page: FlightPrepPage) {
		local.page = page;
	},
	get nomogramMetric(): NomogramMetric {
		return local.nomogramMetric;
	},
};

/** Draw the nomogram for a metric, and remember it (stored only away from
 *  the distance over 15 m). */
export function setNomogramMetric(metric: NomogramMetric): void {
	local.nomogramMetric = metric;
	if (metric === DEFAULT_NOMOGRAM_METRIC) {
		removeItem(NOMOGRAM_METRIC_KEY);
	} else {
		writeItem(NOMOGRAM_METRIC_KEY, metric);
	}
}

/** Open the surface, or put it away when it is already showing what is being
 *  asked for. The entry points stay reachable beside it (it opens as a page,
 *  which leaves the side panels live), so they toggle, the way clicking the
 *  active sidebar tab closes its panel. Asking for a DIFFERENT page switches
 *  to it instead, so a per-section link is never a dismiss. */
export function toggleFlightPrep(page?: FlightPrepPage): void {
	if (isOpen('flightPrep') && (page === undefined || page === local.page)) {
		requestCloseSurface('flightPrep');
		return;
	}
	cancelWxPrint();
	// Only once the open took: a refused eviction would otherwise leave the
	// page set from a request that never happened.
	const was = local.page;
	if (page) {
		local.page = page;
	}
	openSurface('flightPrep');
	if (!isOpen('flightPrep')) {
		local.page = was;
	}
}

export function closeFlightPrep(): void {
	closeSurface('flightPrep');
}

/** Put the nomogram reading back to its default (Restore default settings). */
export function restoreNomogramDefault(): void {
	setNomogramMetric(DEFAULT_NOMOGRAM_METRIC);
}
