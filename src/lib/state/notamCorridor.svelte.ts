/* Reactive wrapper for the route-corridor NOTAM filter.
 *
 * Bridges the pure geometry (route/notamCorridor.ts) into the
 * visibleNotams() chokepoint without an import cycle: this module reads the
 * route and dataset state, visibleNotams() passes the NOTAM set in.
 * Memoised per the state/memoSelector.ts contract, so the heavy scan
 * reruns only when an input actually changed (waypoint drags mutate
 * lat/lon in place many times a second; the signature catches each move,
 * same cadence as the airspace route filter's MapView effect). */

import type { Notam } from '$lib/notam/types';
import {
	corridorNotamIds,
	type FirWideRule,
} from '$lib/route/notamCorridor';
import { airportLookup, dataState, getAirspaces } from './data.svelte';
import { memoised } from './memoSelector';
import { routes, routeSettings, type Route } from './route.svelte';

/** How FIR-wide NOTAMs (Q) radius 999 / no radius) behave under the filter:
 *  kept iff the corridor crosses one of the NOTAM's own FIRs, failing open
 *  on unknown FIRs. The one-line switch for the other variants. */
const FIR_WIDE_RULE: FirWideRule = 'fir-cross';

const memo = memoised(
	// Reading every waypoint's lat/lon both tracks the drag mutations and
	// keys the memo; airportLookup's index is non-reactive, so the load
	// flags stand in for the datasets (getAirspaces tracks its own).
	(_notams: Notam[], parsedAt: number, radius: number, routed: Route[]) =>
		`${parsedAt}|${radius}|${dataState.airspacesLoaded}|${dataState.airportsLoaded}|` +
		routed
			.map((r) => r.waypoints.map((w) => `${w.lat},${w.lon}`).join(';'))
			.join('#'),
	(notams, _parsedAt, radius, routed) =>
		corridorNotamIds(
			notams,
			routed.map((r) => r.waypoints),
			{
				halfWidthNM: radius,
				firWideRule: FIR_WIDE_RULE,
				airspaces: getAirspaces(),
				lookupAirport: dataState.airportsLoaded ? airportLookup : null,
			},
		),
);

/** Ids of the NOTAMs relevant to any route's corridor, or null when the
 *  filter is inactive (toggle off, or no route with >= 2 waypoints), in
 *  which case visibleNotams() skips the clause entirely. The NOTAM set and
 *  its parse stamp come from the caller (notamState) so this module never
 *  imports notam.svelte. */
export function routeCorridorNotamIds(
	notams: Notam[],
	parsedAt: number,
): ReadonlySet<string> | null {
	if (!routeSettings.notamsOnRouteOnly) {
		return null;
	}
	const routed = routes.list.filter((r) => r.waypoints.length >= 2);
	if (routed.length === 0) {
		return null;
	}
	return memo(notams, parsedAt, routeSettings.corridorRadiusNM, routed);
}
