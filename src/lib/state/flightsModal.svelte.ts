/* View state for the flights-library surface: the flights table and the plan
 * catalog behind one PageTabs switch (FlightsModal.svelte). Open-ness and
 * placement are the workspace slot; the flightPrepModal.svelte.ts shape.
 *
 * The launchers stay reachable beside a docked surface, so they toggle; a
 * PARAMETERISED request toggles only on a match, so asking for the other view
 * switches instead of dismissing (the toggleFlightPrep contract). A no-arg
 * open leaves the view alone on purpose: the component is mounted for the
 * whole session, so the view already survives close/reopen, and the file
 * importer's openFlights() counts on landing wherever the user last was. */

import { cancelWxPrint } from './wxPrint.svelte';
import { closeSurface, isOpen, openSurface, requestCloseSurface } from './workspace.svelte';

export type FlightsPage = 'flights' | 'plans';

const local = $state<{ view: FlightsPage }>({ view: 'flights' });

export const flightsModal = {
	get open(): boolean {
		return isOpen('flights');
	},
	get view(): FlightsPage {
		return local.view;
	},
	set view(view: FlightsPage) {
		local.view = view;
	},
};

/** Open the surface on the given view (or wherever it last was). Only once
 *  the open took: a refused eviction must not leave the view set from a
 *  request that never happened. */
export function openFlights(view?: FlightsPage): void {
	cancelWxPrint();
	const was = local.view;
	if (view) {
		local.view = view;
	}
	openSurface('flights');
	if (!isOpen('flights')) {
		local.view = was;
	}
}

/** The entry-point button: put the surface away when it is already showing
 *  what is being asked for, else open (or switch to) it. */
export function toggleFlights(view?: FlightsPage): void {
	if (isOpen('flights') && (view === undefined || view === local.view)) {
		requestCloseSurface('flights');
		return;
	}
	openFlights(view);
}

export function closeFlights(): void {
	closeSurface('flights');
}
