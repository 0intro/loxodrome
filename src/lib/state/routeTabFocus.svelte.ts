/* Requests for a Route tab control to take the focus, each a one-shot the
 * tab consumes, so a later mount of the tab never steals the focus: the
 * wind switch, from a page that states the plan's wind elsewhere (the
 * flight preparation's Overview), the Route tab coming up with its Flight
 * parameters unfolded; and the route field, a new alternate waiting for
 * its aerodrome. */

import { setFlightParamsOpen } from './route.svelte';
import { showTab } from './ui.svelte';

export const routeTabFocus = $state<{ wind: boolean; field: boolean }>({ wind: false, field: false });

/** Bring up the Route tab's wind switch: a gesture's handler calls it. */
export function requestRouteWindSwitch(): void {
	setFlightParamsOpen(true);
	showTab('route');
	routeTabFocus.wind = true;
}

/** Put the caret at the end of the route field, past a space. */
export function requestRouteField(): void {
	routeTabFocus.field = true;
}
