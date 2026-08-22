/* Reactive accessor for the national cruising-level regime.
 *
 * Bridges the pure derivation (route/airspaces.ts cruisingRegimeForRoutes)
 * into the display surfaces without an import cycle, exactly like
 * transitionAlt.svelte.ts: this module reads the route + dataset state;
 * RouteTab, NavLogSheet, RouteProfileModal and the level advisor call the
 * accessor inside their $derived contexts. Memoised per the
 * state/memoSelector.ts contract, so the FIR point tests rerun only when an
 * input actually changed. */

import { cruisingRegimeForRoutes } from '$lib/route/airspaces';
import type { CruisingRegime } from '$lib/route/cruisingLevels';
import { dataState, getAirspaces } from './data.svelte';
import { memoised } from './memoSelector';
import { routes } from './route.svelte';

const memo = memoised(
	() => {
		getAirspaces();
		return (
			`${dataState.airspacesLoaded}|` +
			routes.list.map((r) => r.waypoints.map((w) => `${w.lat},${w.lon}`).join(';')).join('#')
		);
	},
	() =>
		cruisingRegimeForRoutes(
			routes.list.map((r) => r.waypoints),
			getAirspaces(),
		),
);

/** The cruising-level regime (VFR ceiling + UTA parity floor) in force for the
 *  routes: `US_REGIME` when any waypoint lies inside a US (K-prefix) FIR, else
 *  `EU_REGIME`. Read-only; it never triggers a dataset load, only sharpens
 *  once the airspaces land (until then the EU default applies). */
export function cruisingRegime(): CruisingRegime {
	return memo();
}
