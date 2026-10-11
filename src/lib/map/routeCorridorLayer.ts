/* routeCorridorLayer.ts: a translucent band tracing the active route, shown only
 * while the corridor-width field is focused, so the user can see how far the
 * NOTAM-fetch corridor (radiusNM each side of the polyline) reaches.
 *
 * Drawn as a single thick rounded polyline: Leaflet's default round line cap and
 * join give exactly the radius around the line's ends and corners, so the band is
 * one uniform-opacity shape with no overlap seams (a true geographic buffer would
 * need a polygon union). The stroke weight is in pixels, so it is recomputed from
 * radiusNM at the route's centre latitude and the current zoom; during a zoom
 * animation Leaflet transform-scales the vector pane, so the band scales smoothly
 * and snaps to the exact width on zoomend (the caller re-runs on mapState.zoom).
 * interactive:false so the wide band never steals a map or route-line click. */

import L from 'leaflet';
import { NM_TO_METERS } from '$lib/notam/units';
import { ensureRouteAnalysisPane, ROUTE_ANALYSIS_PANE } from './routeAnalysisPane';

// Web Mercator equatorial circumference (Leaflet's default EPSG:3857, 256 px tiles):
// 2^(zoom+8) px span this many ground metres at the equator.
const EARTH_CIRCUMFERENCE_M = 40075016.686;

let group: L.LayerGroup | null = null;
let band: L.Polyline | null = null;

/** Ground metres per screen pixel at `lat` and `zoom` in Leaflet's default CRS. */
function metersPerPixel(lat: number, zoom: number): number {
	const cosLat = Math.cos((lat * Math.PI) / 180) || 1;
	return (EARTH_CIRCUMFERENCE_M * Math.abs(cosLat)) / Math.pow(2, zoom + 8);
}

/** Show / refresh the active route's corridor band, or hide it (empties the
 *  polyline). Draws nothing for a route of fewer than 2 waypoints (no corridor,
 *  matching routeCorridorBbox). */
export function syncCorridor(
	m: L.Map,
	waypoints: { lat: number; lon: number }[],
	radiusNM: number,
	color: string,
	show: boolean,
): void {
	if (!show || waypoints.length < 2 || radiusNM <= 0) {
		band?.setLatLngs([]);
		return;
	}
	// The shared route-analysis pane (z 444): the band draws into its
	// corridor SVG, under the min-alt danger canvas, above the reference
	// overlays (z <= 400) and below the NOTAM areas (450) / route (455).
	const renderer = ensureRouteAnalysisPane(m);
	if (!group) {
		group = L.layerGroup().addTo(m);
	}
	if (!band) {
		band = L.polyline([], {
			pane: ROUTE_ANALYSIS_PANE,
			renderer,
			interactive: false,
			fill: false,
			opacity: 0.18,
			lineCap: 'round',
			lineJoin: 'round',
		});
		band.addTo(group);
	}
	let minLat = Infinity;
	let maxLat = -Infinity;
	for (const w of waypoints) {
		if (w.lat < minLat) minLat = w.lat;
		if (w.lat > maxLat) maxLat = w.lat;
	}
	const centreLat = (minLat + maxLat) / 2;
	// radiusNM is the half-width, so the band (a stroke centred on the line) spans
	// 2 * radiusNM across the ground.
	const weightPx = (2 * radiusNM * NM_TO_METERS) / metersPerPixel(centreLat, m.getZoom());
	band.setStyle({ color, weight: weightPx });
	band.setLatLngs(waypoints.map((w) => [w.lat, w.lon] as L.LatLngTuple));
}

/** Detach the corridor overlay and drop refs (HMR / unmount teardown). State is
 *  session-scoped and rebuilds via syncCorridor. */
export function clearCorridorLayer(m: L.Map): void {
	if (group && m.hasLayer(group)) {
		m.removeLayer(group);
	}
	band = null;
	group = null;
}
