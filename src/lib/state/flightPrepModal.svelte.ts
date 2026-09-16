/* Page state for the flight-preparation surface (dossier, fuel plan, mass &
 * balance, performance). Open-ness and placement are the workspace slot; see
 * aboutModal.svelte.ts.
 *
 * It opens as a page filling the stage, which claims the overlay slot and so
 * displaces whatever else held it. Nothing here reaches into another surface
 * module to close it: the workspace arbitrates, which is also what lets a
 * docked profile stay up beside this one. */

import { cancelWxPrint } from './wxPrint.svelte';
import { closeSurface, isOpen, openSurface, requestCloseSurface } from './workspace.svelte';

export type FlightPrepPage = 'dossier' | 'fuel' | 'mb' | 'perf';

const local = $state<{ page: FlightPrepPage }>({ page: 'dossier' });

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
};

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
