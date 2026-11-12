/* The position reading at the pose (nav/positionRef.ts), for the band's
 * target cell: with a route and without, in replay alike, and exempt from
 * the plan-only muting, since it IS the position (docs/nav-live.md "The
 * position reference"). Recomputed when the pose has moved a tenth of a
 * mile (the nearest list's quantum) or a dataset published; the index of
 * references is rebuilt only for the latter. */

import { untrack } from 'svelte';
import { buildRefIndex, aerodromeRefs, navaidRefs, positionRef, townRefs, type PositionRef, type RefIndex } from '$lib/nav/positionRef';
import type { Airport } from '$lib/data/airports';
import type { Navaid } from '$lib/data/navaids';
import type { Place } from '$lib/data/places';
import { getAirports, getNavaids } from './data.svelte';
import { currentPose } from './navRecording.svelte';
import { getPlaces } from './places.svelte';

let memo: {
	airports: readonly Airport[] | null;
	navaids: readonly Navaid[] | null;
	places: readonly Place[] | null;
	index: RefIndex;
} | null = null;

/** The references over the loaded datasets, rebuilt when one publishes;
 *  tracked, so a reader re-runs as they land. */
export function refIndex(): RefIndex {
	const airports = getAirports();
	const navaids = getNavaids();
	const places = getPlaces();
	if (memo && memo.airports === airports && memo.navaids === navaids && memo.places === places) {
		return memo.index;
	}
	const index = buildRefIndex([
		...(airports ? aerodromeRefs(airports) : []),
		...(navaids ? navaidRefs(navaids) : []),
		...(places ? townRefs(places) : []),
	]);
	memo = { airports, navaids, places, index };
	return index;
}

// The pose to a tenth of a mile: a fix a second recomputes nothing the
// reading would show differently.
const poseStep = $derived.by(() => {
	const p = currentPose();
	return p ? `${Math.round(p.lat * 600)}|${Math.round(p.lon * 600)}` : '';
});

const reading = $derived.by((): PositionRef | null => {
	if (poseStep === '') {
		return null;
	}
	const index = refIndex();
	const p = untrack(currentPose);
	return p ? positionRef(index, p.lat, p.lon) : null;
});

/** The reading at the pose, or null without one or near nothing. */
export function positionRefNow(): PositionRef | null {
	return reading;
}
