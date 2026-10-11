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

/** The fuel plan's two requirement groups (FuelTable.svelte), the burn-off's
 *  parts and the reserve's: which are unfolded on screen, a preference
 *  (docs/preferences.md). Both fold by default, their totals standing for
 *  them; a group holding a typed minute says so while folded, and paper
 *  always prints both whole. */
export type FuelGroup = 'burnOff' | 'reserve';
const FUEL_GROUPS: readonly FuelGroup[] = ['burnOff', 'reserve'];
const FUEL_OPEN_KEY = 'loxodrome:fuel-plan-open';

/** The stored groups, in their own order; anything else reads as folded. */
function readFuelOpen(): FuelGroup[] {
	const ids = (readItem(FUEL_OPEN_KEY) ?? '').split(',');
	return FUEL_GROUPS.filter((g) => ids.includes(g));
}

const local = $state<{
	page: FlightPrepPage;
	nomogramMetric: NomogramMetric;
	mbSheet: number | null;
	fuelOpen: FuelGroup[];
}>({
	page: 'dossier',
	nomogramMetric:
		readItem(NOMOGRAM_METRIC_KEY) === 'groundRoll' ? 'groundRoll' : DEFAULT_NOMOGRAM_METRIC,
	mbSheet: null,
	fuelOpen: readFuelOpen(),
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
	/** A trip's loading sheet asked for (its chain index), until the M&B
	 *  page has brought it into view. */
	get mbSheet(): number | null {
		return local.mbSheet;
	},
	/** The fuel plan's groups unfolded on screen. */
	get fuelOpen(): readonly FuelGroup[] {
		return local.fuelOpen;
	},
};

/** Show trip k's loading sheet: the M&B page comes up and brings the sheet
 *  into view (the fuel plan page's Mass & balance row). */
export function showMbSheet(k: number): void {
	local.mbSheet = k;
	local.page = 'mb';
}

/** The sheet asked for is in view (the M&B page, once it has scrolled). */
export function clearMbSheet(): void {
	local.mbSheet = null;
}

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

/** Unfold or fold one of the fuel plan's groups, and remember it (stored only
 *  while one is unfolded). */
export function setFuelGroupOpen(group: FuelGroup, open: boolean): void {
	const next = FUEL_GROUPS.filter((g) => (g === group ? open : local.fuelOpen.includes(g)));
	local.fuelOpen = next;
	if (next.length === 0) {
		removeItem(FUEL_OPEN_KEY);
	} else {
		writeItem(FUEL_OPEN_KEY, next.join(','));
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

/** Fold the fuel plan's groups again (Restore default settings). */
export function restoreFuelGroupsDefault(): void {
	local.fuelOpen = [];
	removeItem(FUEL_OPEN_KEY);
}
