/* Trip / alternate pairing over the drawn routes: each non-alternate route
 * is a trip; an alternate route attaches to the nearest preceding trip that
 * doesn't have one yet (the interleave convention trip 1, alternate 1,
 * trip 2, ...). Pure and generic over the route shape so the YAML layer and
 * the state layer both use it. */

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
