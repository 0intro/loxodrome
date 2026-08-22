/* Pure (Leaflet type-only) hit-test for NOTAM areas; kept out of notamLayer.ts
 * so vitest can import it in Node without triggering Leaflet's `window`-using
 * module side effects. The single public API is notamAreasAt, used by
 * MapView.svelte's right-click handler. */

import type L from 'leaflet';
import { notamAreaSize, notamContainsPoint } from '$lib/notam/geometry';
import { visibleNotams, type IndexedNotam } from './notam.svelte';

/** Visible NOTAM areas (polygons + point-plus-radius circles) that contain
 *  the given lat/lon. Multi-area source NOTAMs collapse to one row per id;
 *  the user opens the source NOTAM, the detail panel groups its areas
 *  internally. Result is sorted smallest-area-first so the most specific
 *  feature appears at the top of the right-click context menu.
 *
 *  Bails at very low zoom (<= 3), like airspaceAt's zoom bail; at that scale
 *  every feature overlaps every click and the menu is useless. */
export function notamAreasAt(
	map: L.Map,
	lat: number,
	lon: number,
): IndexedNotam[] {
	if (map.getZoom() <= 3) {
		return [];
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const seen = new Set<string>();
	const buckets: { it: IndexedNotam; size: number }[] = [];
	for (const it of visibleNotams()) {
		if (seen.has(it.notam.id)) {
			continue;
		}
		if (!notamContainsPoint(it.notam, lat, lon)) {
			continue;
		}
		seen.add(it.notam.id);
		buckets.push({ it, size: notamAreaSize(it.notam) });
	}
	buckets.sort((a, b) => a.size - b.size);
	return buckets.map((b) => b.it);
}
