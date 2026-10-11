/* Trip / alternate pairing over the drawn routes: each non-alternate route
 * is a trip; an alternate route attaches to the nearest preceding trip that
 * doesn't have one yet (the interleave convention trip 1, alternate 1,
 * trip 2, ...). Pure and generic over the route shape so the YAML layer and
 * the state layer both use it. */

import { occurrenceKeys } from '$lib/data/dedup';

export interface RouteLike {
	alternate?: boolean | undefined;
}

export interface Trip<R> {
	/** Trip number, 0-based (the fuel plan's column order). */
	index: number;
	route: R;
	alternate: R | null;
}

/** The trips in list order, each with its attached alternate (if any). */
export function orderedTrips<R extends RouteLike>(list: readonly R[]): Trip<R>[] {
	const trips: Trip<R>[] = [];
	for (const r of list) {
		if (!r.alternate) {
			trips.push({ index: trips.length, route: r, alternate: null });
		} else if (trips.length > 0 && trips[trips.length - 1].alternate === null) {
			trips[trips.length - 1].alternate = r;
		}
	}
	return trips;
}

/** Alternates that attach to nothing: leading ones (no preceding trip) and
 *  extras (the preceding trip already has an alternate). For UI hints. */
export function orphanAlternates<R extends RouteLike>(list: readonly R[]): R[] {
	const orphans: R[] = [];
	let lastTripHasAlternate: boolean | null = null; // null = no trip seen yet
	for (const r of list) {
		if (!r.alternate) {
			lastTripHasAlternate = false;
		} else if (lastTripHasAlternate === false) {
			lastTripHasAlternate = true;
		} else {
			orphans.push(r);
		}
	}
	return orphans;
}

/** The waypoint slice a stop key reads (Route.waypoints fits). */
export interface StopWaypoint {
	kind: string;
	ident?: string | undefined;
	lat: number;
	lon: number;
}

/** A stop's identity before any occurrence suffix: the aerodrome's ident,
 *  upper-cased, else the point's position to the file's 4 decimals (a
 *  private strip planned as a free point). */
export function stopBaseKey(w: StopWaypoint): string {
	return w.kind === 'airport' && w.ident
		? w.ident.toUpperCase()
		: `${w.lat.toFixed(4)},${w.lon.toFixed(4)}`;
}

/**
 * The stop before each trip but the first, by its trip index (`Trip.index`):
 * what a refuel tick or a payload change at that stop is stored under.
 *
 * A stop is named by its AERODROME, never by the trip's position: inserting a
 * trip elsewhere then cannot carry a refuel to another field, and a stop that
 * changes aerodrome comes back unticked. It is the previous flyable trip's
 * LAST waypoint, the point the refuelling plan already uplifts at
 * (`refuelPoints`), so the key and the AIP's answer about that aerodrome
 * cannot disagree; a field visited twice takes `#2` (`occurrenceKeys`, the
 * runway-end and station-key idiom).
 *
 * Over the FLYABLE trips (two waypoints or more), on geometry alone: the same
 * set the fuel plan computes whenever a cruise speed exists, and a file saved
 * without one keeps its stops.
 */
export function tripStopKeys<R extends RouteLike & { waypoints: readonly StopWaypoint[] }>(
	trips: readonly Trip<R>[],
): Map<number, string> {
	const flyable = trips.filter((t) => t.route.waypoints.length >= 2);
	const stops = flyable.slice(1).map((t, i) => {
		const wps = flyable[i].route.waypoints;
		return { trip: t.index, base: stopBaseKey(wps[wps.length - 1]) };
	});
	const keys = occurrenceKeys(stops, (s) => s.base);
	return new Map(stops.map((s, i) => [s.trip, keys[i]]));
}
