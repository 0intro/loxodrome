/* The point a search measures its distances from (docs/search.md
 * "Reference"): the aircraft while a flight is being recorded, the map's
 * centre otherwise. A caller reads it once per query (untracked), so a
 * moving aircraft never re-ranks a list under the pilot's finger. */

import type { LatLon } from '$lib/notam/types';
import { mapState } from './map.svelte';
import { currentPose, nav } from './navRecording.svelte';

export function searchReference(): LatLon {
	if (nav.recording) {
		const p = currentPose();
		if (p) {
			return { lat: p.lat, lon: p.lon };
		}
	}
	return { lat: mapState.center.lat, lon: mapState.center.lng };
}
