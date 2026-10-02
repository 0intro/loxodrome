/* minAltCorridorLayer.ts: a translucent amber band tracing the active route, shown
 * only while the minimum-altitude corridor field is focused, so the user can see
 * the terrain / obstacle swath (halfWidthNM each side of the polyline) that drives
 * each leg's minimum safe altitude. Distinct from the blue, route-coloured
 * NOTAM-fetch corridor (routeCorridorLayer.ts): a fixed amber colour, its own pane.
 *
 * Same draw mechanism as the NOTAM corridor: one thick rounded polyline whose round
 * cap / join give exactly halfWidthNM around the line, so the band is a uniform
 * shape with no overlap seams. The stroke weight is in pixels, recomputed from
 * halfWidthNM at the route's centre latitude and the current zoom (the band
 * transform-scales during a zoom animation and snaps on zoomend; the caller re-runs
 * on mapState.zoom). interactive:false so the wide band never steals a click. */

import L from 'leaflet';
import { NM_TO_METERS } from '$lib/notam/units';
import { ensureRouteAnalysisPane, ROUTE_ANALYSIS_PANE } from './routeAnalysisPane';

// Web Mercator equatorial circumference (Leaflet's default EPSG:3857, 256 px tiles):
// 2^(zoom+8) px span this many ground metres at the equator.
const EARTH_CIRCUMFERENCE_M = 40075016.686;

// Fixed amber, distinct from the route-coloured NOTAM corridor (map overlay colours
// are fixed hex, not theme tokens).
const CORRIDOR_COLOR = '#e08a00';

let group: L.LayerGroup | null = null;
let band: L.Polyline | null = null;

/** Ground metres per screen pixel at `lat` and `zoom` in Leaflet's default CRS. */
function metersPerPixel(lat: number, zoom: number): number {
	const cosLat = Math.cos((lat * Math.PI) / 180) || 1;
	return (EARTH_CIRCUMFERENCE_M * Math.abs(cosLat)) / Math.pow(2, zoom + 8);
}

/** Show / refresh the active route's MSA corridor band, or hide it (empties the
 *  polyline). Draws nothing for a route of fewer than 2 waypoints. */
export function syncMinAltCorridor(
	m: L.Map,
	waypoints: { lat: number; lon: number }[],
	halfWidthNM: number,
	show: boolean,
): void {
	if (!show || waypoints.length < 2 || halfWidthNM <= 0) {
		band?.setLatLngs([]);
		return;
	}
	// The shared route-analysis pane (z 444), same SVG as the NOTAM-fetch
	// corridor band: the two are tied to different fields' focus and never
	// show at once, and the min-alt danger canvas composites over both.
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
			color: CORRIDOR_COLOR,
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
	// halfWidthNM is each side of the track, so the band (a stroke centred on the
	// line) spans 2 * halfWidthNM across the ground.
	const weightPx = (2 * halfWidthNM * NM_TO_METERS) / metersPerPixel(centreLat, m.getZoom());
	band.setStyle({ weight: weightPx });
	band.setLatLngs(waypoints.map((w) => [w.lat, w.lon] as L.LatLngTuple));
}

/** Detach the corridor overlay and drop refs (HMR / unmount teardown). State is
 *  session-scoped and rebuilds via syncMinAltCorridor. */
export function clearMinAltCorridorLayer(m: L.Map): void {
	if (group && m.hasLayer(group)) {
		m.removeLayer(group);
	}
	band = null;
	group = null;
}
