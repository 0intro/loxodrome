/* routeAnalysisPane.ts: the ONE pane (z 444) shared by the three
 * route-analysis overlays that used to sit on neighbouring panes: the amber
 * minimum-altitude corridor band (minAltCorridorLayer), the route-coloured
 * NOTAM-fetch corridor band (routeCorridorLayer) and the red min-alt danger
 * tint (minAltDangerLayer). None of them is hit-tested (all
 * interactive:false), so one pane suffices; the in-pane order preserves the
 * old 444 < 445 < 446 stacking:
 *
 *  - both corridor bands draw into the SHARED SVG renderer below (their
 *    relative order is moot: each shows only while its own width field is
 *    focused, never both at once);
 *  - the danger tint composites over the bands via an explicit canvas
 *    z-index: leaflet.css orders a pane's children `canvas` (100) under
 *    `svg` (200), so the danger layer lifts its canvas above the corridor
 *    SVG itself (minAltDangerLayer.onAdd); DOM order alone would lose. */

import L from 'leaflet';
import { ensurePane } from './directDrawLayer';

export const ROUTE_ANALYSIS_PANE = 'route-analysis';
const PANE_Z = '444';

let renderer: L.SVG | null = null;

/** Create the pane (once) and the shared corridor SVG renderer (once;
 *  Leaflet adds its container to the map when the first band using it is
 *  added). Every route-analysis sync goes through here before drawing. */
export function ensureRouteAnalysisPane(m: L.Map): L.SVG {
	ensurePane(m, ROUTE_ANALYSIS_PANE, PANE_Z);
	renderer ??= L.svg({ pane: ROUTE_ANALYSIS_PANE });
	return renderer;
}

/** Drop the shared renderer (HMR / unmount teardown, beside the three
 *  overlays' own clears). */
export function clearRouteAnalysisPane(m: L.Map): void {
	if (renderer && m.hasLayer(renderer)) {
		m.removeLayer(renderer);
	}
	renderer = null;
}
