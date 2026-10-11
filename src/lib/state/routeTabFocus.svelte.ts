/* A request for the Route tab's wind switch, from a page that states the
 * plan's wind elsewhere (the flight preparation's Overview): the Route tab
 * comes up, its Flight parameters unfold, and the switch takes the focus
 * once laid out. A one-shot the tab consumes, so a later mount of the tab
 * never steals the focus. */

import { setFlightParamsOpen } from './route.svelte';
import { showTab } from './ui.svelte';

export const routeTabFocus = $state<{ wind: boolean }>({ wind: false });

/** Bring up the Route tab's wind switch: a gesture's handler calls it. */
export function requestRouteWindSwitch(): void {
	setFlightParamsOpen(true);
	showTab('route');
	routeTabFocus.wind = true;
}
