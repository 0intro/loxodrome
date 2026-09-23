/* Loxodrome's own answers to the questions state/planScope.svelte.ts asks.
 *
 * This is the one place the route workspace is handed to the NOTAM half and to
 * the airspace panel. Called once from src/main.ts, inside boot(), alongside
 * the dynamic App import: the state modules read their storage at module
 * evaluation, so anything static in main.ts would evaluate ahead of the
 * shared-mode boot sweep (docs/accounts-sync.md, Device modes).
 *
 * Registration is a single write per slot. planScope is `$state`, so a memo
 * that already read a null slot is invalidated rather than left stale.
 */

import { planScope } from './planScope.svelte';
import { hasStatedEtd } from './flightPrep.svelte';
import { routeCorridorNotamIds } from './notamCorridor.svelte';
import { routes, routeSettings } from './route.svelte';
import { hasFlyableRoute, plannedFlightWindow } from './timeWindow.svelte';

/** Map each route-aerodrome ICAO ident to its position along the routes: every
 *  route's airport-anchored waypoints, in order, all routes concatenated in tab
 *  order, the first occurrence winning. This is the aerodrome-block order SOFIA
 *  gives a bulletin (departure, overflown / alternates, destination), extended
 *  across all drawn routes. Reactive: reads routes.list and each waypoint. */
function routeAerodromeRank(): Map<string, number> {
	// A plain index handed to the pure sorter, not reactive state.
	const rank = new Map<string, number>();
	let n = 0;
	for (const route of routes.list) {
		for (const wp of route.waypoints) {
			if (wp.kind === 'airport' && wp.ident) {
				const ident = wp.ident.toUpperCase();
				if (!rank.has(ident)) {
					rank.set(ident, n++);
				}
			}
		}
	}
	return rank;
}

/** Hand the route workspace to every surface that reads a plan without
 *  importing one. Idempotent; call once at boot. */
export function installFlightScope(): void {
	planScope.flight = {
		window: plannedFlightWindow,
		flyable: hasFlyableRoute,
		etdStated: hasStatedEtd,
	};
	planScope.corridor = routeCorridorNotamIds;
	planScope.aerodromeRank = routeAerodromeRank;
	planScope.flightRules = () => (routeSettings.vfr ? 'vfr' : 'ifr');
}
