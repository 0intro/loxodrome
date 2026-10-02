/* The map's last settled view, remembered for a boot whose URL carries none
 * (docs/preferences.md: working state, class `view`, kept by Restore default
 * settings, erased by Reset's Settings group).
 *
 * The URL hash is the view's first home and wins whenever present, a shared
 * link or a reload alike (map/viewHash.ts). But an Android cold start, the
 * installed app's launch and a bookmark carry no hash, and each opened on the
 * Paris default: the OS ends the session (docs/preferences.md), so a pilot
 * planning in Brittany came back to Paris at a moment nobody chose. MapView
 * writes this beside each throttled hash restamp and reads it only when the
 * hash has no view. The grammar is the hash's own `map=` value, zoom/lat/lon,
 * read through its parser, so the two cannot disagree on what a view is. */

import { parseViewHash } from '$lib/map/viewHash';
import { readItem, writeItem } from './persist';

const KEY = 'loxodrome:map-view';

/** The remembered view, or null: nothing stored, or anything the hash's own
 *  parser refuses (a layer or a chart in it included: this holds a position,
 *  never the choices the layers document keeps). */
export function rememberedMapView(): { center: [number, number]; zoom: number } | null {
	const raw = readItem(KEY);
	if (raw === null || !/^[^&=#]+$/.test(raw)) {
		return null;
	}
	const view = parseViewHash(`#map=${raw}`);
	return view === null ? null : { center: view.center, zoom: view.zoom };
}

/** Remember a settled view, in the hash's own precision. */
export function rememberMapView(zoom: number, lat: number, lng: number): void {
	if (Number.isFinite(zoom) && Number.isFinite(lat) && Number.isFinite(lng)) {
		writeItem(KEY, `${Math.round(zoom)}/${lat.toFixed(5)}/${lng.toFixed(5)}`);
	}
}
