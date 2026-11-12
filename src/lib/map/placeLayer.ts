/* placeLayer.ts: the mark on the place the detail panel shows (a town, a
 * position typed as coordinates; components/detail/PlaceDetail.svelte). A
 * place is no map feature, so its selection draws this ring instead of a
 * highlighted symbol, from the one selection switch (selectionHighlight.ts).
 *
 * One marker on a pane of its own (`place-mark`, z 652: over the NOTAM pins,
 * under the route's waypoint pins, so a town in the route shows its pin),
 * never a click target: whatever lies under the ring keeps its clicks. The
 * NOTAM Viewer never selects a place, so its map needs no mirror. */

import L from 'leaflet';
import type { LatLon } from '$lib/notam/types';
import { mapState } from '$lib/state/map.svelte';
import { ensurePane } from './directDrawLayer';

export const PLACE_PANE = 'place-mark';
const PLACE_PANE_Z = '652';

// i18n-ignore-start: SVG marker markup, not display text
/* A hollow ring and its centre dot, a white casing under near-black ink
 * (profilePointLayer's recipe), so it reads on every base layer and chart
 * and leaves the chart's own name for the place legible inside it. */
const RING = '<circle cx="16" cy="16" r="11"/>';
const RING_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">' +
	`<g fill="none" stroke="#ffffff" stroke-width="5">${RING}</g>` +
	`<g fill="none" stroke="#1b1b1b" stroke-width="2.2">${RING}</g>` +
	'<circle cx="16" cy="16" r="2.4" fill="#ffffff"/>' +
	'<circle cx="16" cy="16" r="1.5" fill="#1b1b1b"/>' +
	'</svg>';
// i18n-ignore-end

let icon: L.DivIcon | null = null;
let marker: L.Marker | null = null;
let markerMap: L.Map | null = null;

function placeIcon(): L.DivIcon {
	if (!icon) {
		icon = L.divIcon({ html: RING_SVG, className: 'place-mark', iconSize: [32, 32], iconAnchor: [16, 16] });
	}
	return icon;
}

/** Mark `p` on the map, or take the mark away with null. A map built anew
 *  since the last mark gets a marker of its own. */
export function markPlace(p: LatLon | null): void {
	const m = mapState.map;
	if (marker && (p === null || markerMap !== m)) {
		marker.remove();
		marker = null;
		markerMap = null;
	}
	if (!p || !m) {
		return;
	}
	if (marker) {
		marker.setLatLng([p.lat, p.lon]);
		return;
	}
	ensurePane(m, PLACE_PANE, PLACE_PANE_Z);
	marker = L.marker([p.lat, p.lon], {
		icon: placeIcon(),
		pane: PLACE_PANE,
		interactive: false,
		keyboard: false,
	}).addTo(m);
	markerMap = m;
}
