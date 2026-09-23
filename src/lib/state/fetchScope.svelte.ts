/* What region a fetched briefing actually covers, and the test that gate is.
 *
 * A fetch that returns exactly what was asked for needs no gate. Two of them
 * do not: the viewport and the corridor fetches both derive a list of
 * aerodromes and FIRs from a REGION and then ask autorouter for those FIRs
 * WHOLE, so each answers with NOTAMs spread across several hundred NM of
 * territory the pilot never asked about. The gate is what puts the answer back
 * inside the question.
 *
 * The region has two shapes, and the important one is not a box:
 *
 *  - a VIEWPORT is a rectangle, so a rectangle is the exact test;
 *  - a CORRIDOR is a capsule, the swept disc of route/minAltitude.ts and the
 *    shape SOFIA briefs server-side, and a rectangle is NOT the exact test for
 *    one. The route fetch's own comment used to say so: "axis-aligned, so a
 *    long diagonal route can still show NOTAMs in the box corners beyond the
 *    radius; the airport selection above used the true point-to-polyline
 *    corridor distance." The SELECTION was exact and the DISPLAY was not, so
 *    the two disagreed about the same corridor, and the wider one won.
 *
 * So the corridor scope runs route/notamCorridor.ts's own test, the one behind
 * "Show only route NOTAMs": polygons by exact corridor-vs-ring decomposition,
 * positions and circles by distance <= halfWidth + the NOTAM's own radius, and
 * FIR-wide entries by whether the corridor crosses one of their FIRs, failing
 * open on an unknown one. That circle test IS what SOFIA applies to select a
 * narrow-route PIB (docs/notam-source-comparison.md), which is why the two
 * sources can now be compared at all: they answer the same question.
 *
 * Per source id, so every entry of a multi-area NOTAM passes together and the
 * panels (which dedupe by id) agree with the map.
 *
 * Kept out of notam.svelte.ts because the corridor test reads the airspace and
 * airport datasets, and that module is imported by data.svelte.ts. */

import { corridorNotamIds, type FirWideRule } from '$lib/route/notamCorridor';
import type { Bbox } from '$lib/notam/geometry';
import type { LatLon, Notam } from '$lib/notam/types';
import { airportLookup, dataState, getAirspaces } from './data.svelte';
import { memoised } from './memoSelector';

/** The region a fetched briefing covers, stamped by the fetch that made it.
 *  Null on this app's other briefings and not a degraded case: a paste, a file
 *  and a SOFIA PIB are each exactly what was asked for, and a gate over one
 *  could only hide. */
export type FetchScope =
	| { kind: 'bbox'; bbox: Bbox }
	| {
			kind: 'corridor';
			/** One track per route briefed; a briefing covers their union. */
			tracks: LatLon[][];
			/** NM either side of each track, the width that selected the
			 *  aerodromes and FIRs asked for. */
			halfWidthNM: number;
	  };

/** How FIR-wide NOTAMs (Q) radius 999 / no radius) behave: kept iff the
 *  corridor crosses one of the NOTAM's own FIRs, failing open on an unknown
 *  one. The same rule the route filter applies, and deliberately so: a
 *  corridor fetch ASKS for the FIRs it crosses, so their FIR-wide entries are
 *  answers to the question and not noise around it. */
const FIR_WIDE_RULE: FirWideRule = 'fir-cross';

const corridorMemo = memoised(
	// The scope is frozen at commit time, so its identity keys it; the
	// datasets are not, and an entry the airspace rows rescue must recompute
	// when they land. airportLookup's index is non-reactive, so the load flags
	// stand in for it (getAirspaces tracks its own).
	(
		notams: Notam[],
		parsedAt: number,
		tracks: LatLon[][],
		halfWidthNM: number
	) =>
		`${parsedAt}|${notams.length}|${halfWidthNM}|` +
		`${dataState.airspacesLoaded}|${dataState.airportsLoaded}|` +
		tracks
			.map((wps) => wps.map((w) => `${w.lat},${w.lon}`).join(';'))
			.join('#'),
	(notams, _parsedAt, tracks, halfWidthNM) =>
		corridorNotamIds(notams, tracks, {
			halfWidthNM,
			firWideRule: FIR_WIDE_RULE,
			airspaces: getAirspaces(),
			lookupAirport: dataState.airportsLoaded ? airportLookup : null,
		})
);

/** The source ids a CORRIDOR scope keeps, or null when the briefing has no
 *  scope or its scope is a box (which is tested per NOTAM instead, needing no
 *  index). The NOTAM set and its parse stamp come from the caller so this
 *  module never imports notam.svelte. */
export function fetchScopeNotamIds(
	notams: Notam[],
	parsedAt: number,
	scope: FetchScope | null
): ReadonlySet<string> | null {
	if (scope?.kind !== 'corridor') {
		return null;
	}
	const tracks = scope.tracks.filter((wps) => wps.length >= 2);
	if (tracks.length === 0) {
		return null;
	}
	return corridorMemo(notams, parsedAt, tracks, scope.halfWidthNM);
}
