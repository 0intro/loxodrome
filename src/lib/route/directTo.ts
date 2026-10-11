/* Direct-To, the Garmin rule for a waypoint that is not in the plan: the
 * plan "is no longer active but remains available". Here that is an
 * ALTERNATE route appended to the plan, from the present position to the
 * point, never a rewrite of the route being flown (docs/nav-live.md: the
 * plog's plan is what the ATOs and the delta are read against). Pure: the
 * list arithmetic, so the state module's directTo is one undo step over it.
 * Pinned by tests/routeDirectTo.spec.ts. */

import type { RouteLike } from '$lib/aircraft/trips';

/** Insert the direct-to route right AFTER the flown route, so orderedTrips
 *  attaches it to that trip (an alternate attaches to the nearest preceding
 *  trip without one): a bare append would attach it to the plan's LAST trip,
 *  or leave it an orphan behind an existing alternate, and the fold could
 *  never hand over to it on evidence. An existing alternate of that trip
 *  becomes the orphan instead: the live diversion outranks the planned one.
 *  A flown route the list does not hold (never, in practice) appends. */
export function insertDirectTo<R extends RouteLike & { id: string }>(
	list: readonly R[],
	flownId: string,
	route: R,
): R[] {
	const at = list.findIndex((r) => r.id === flownId);
	if (at === -1) {
		return [...list, route];
	}
	// The flown route may itself be an alternate being flown: insert after
	// it all the same, the fold pins the direct-to explicitly.
	return [...list.slice(0, at + 1), route, ...list.slice(at + 1)];
}
