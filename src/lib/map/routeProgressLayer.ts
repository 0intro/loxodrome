/* routeProgressLayer.ts: live progress over the planned route(s), split out
 * of routeLayer.ts (which keeps the interactive planning overlay: lines,
 * casings, draggable pins).
 *
 * The SkyDemon reading of the route line: what has been flown fades to grey,
 * the leg being flown is drawn heavy in the route's own colour, and the plan
 * ahead keeps that colour at its normal weight. The nav identity orange is
 * deliberately NOT used here: the recorded trace owns it, and the two lines
 * run side by side. Non-interactive lines on their own pane above the route,
 * so clicks and waypoint drags are untouched. The heavy leg brings its OWN
 * white casing at the route's proportion (colour + 4): the route's casing is
 * only 4 px wider than a 4 px line, so a 7 px leg drawn over it left half a
 * pixel of white, which rasterises as a sliver down one side. */

import L from 'leaflet';
import { ensurePane } from './directDrawLayer';
import type { RouteSplit } from '$lib/nav/steering';

const PANE = 'route-progress';
// The live progress overlay, just above the coloured route line (455) so the
// flown dimming and the active leg read on top of the route's own colour.
const PANE_Z = '456';
/** The de-emphasised line grey (no CSS token: map lines hardcode their
 *  ink by charter). */
export const FLOWN_GREY = '#94a3b8';

let flownLine: L.Polyline | null = null;
let activeCasing: L.Polyline | null = null;
let activeLegLine: L.Polyline | null = null;

/** What the progress overlay draws: every route the flight has already
 *  completed, drawn wholly flown, plus the one being flown cut at the
 *  aircraft. A plan of consecutive routes is one flight, so the whole of it
 *  reads at a glance rather than only the route in hand. */
export interface RouteProgressDraw {
	/** Completed routes' full polylines. */
	completed: [number, number][][];
	/** The route being flown, and its own hue for the heavy leg. */
	current: { split: RouteSplit; color: string } | null;
}

/** Draw the flown / active-leg overlay, or clear it with a null draw (no
 *  trace, no position, arrived, navigation off). */
export function syncRouteProgress(m: L.Map, draw: RouteProgressDraw | null): void {
	if (!draw || (draw.completed.length === 0 && !draw.current)) {
		flownLine?.remove();
		activeCasing?.remove();
		activeLegLine?.remove();
		flownLine = null;
		activeCasing = null;
		activeLegLine = null;
		return;
	}
	ensurePane(m, PANE, PANE_Z);
	// Created in paint order: the flown line, then the active leg's casing, then
	// the leg itself (one pane, so the SVG renderer stacks them as added).
	if (!flownLine) {
		flownLine = L.polyline([], {
			pane: PANE,
			interactive: false,
			color: FLOWN_GREY,
			weight: 4,
			opacity: 0.75,
			lineCap: 'round',
			lineJoin: 'round',
		}).addTo(m);
	}
	if (!activeCasing) {
		activeCasing = L.polyline([], {
			pane: PANE,
			interactive: false,
			color: '#ffffff',
			weight: 10,
			opacity: 0.9,
			lineCap: 'round',
			lineJoin: 'round',
		}).addTo(m);
	}
	if (!activeLegLine) {
		activeLegLine = L.polyline([], {
			pane: PANE,
			interactive: false,
			weight: 6,
			opacity: 1,
			lineCap: 'round',
			lineJoin: 'round',
		}).addTo(m);
	}
	// The flown ink is one multi-polyline: every completed route whole, then
	// the current one's prefix. Leaflet takes nested arrays as several lines.
	const flown = [...draw.completed];
	if (draw.current) {
		flown.push(draw.current.split.flown);
	}
	flownLine.setLatLngs(flown);
	// The route being flown carries its OWN hue, so the heavy leg reads as
	// part of the plan rather than as the trace.
	activeLegLine.setStyle({ color: draw.current?.color ?? '#c2185b' });
	activeCasing.setLatLngs(draw.current?.split.activeLeg ?? []);
	activeLegLine.setLatLngs(draw.current?.split.activeLeg ?? []);
}

/** Drop the overlay's lines and refs (HMR / unmount teardown). State is
 *  session-scoped and rebuilds via syncRouteProgress on remount. */
export function clearRouteProgress(m: L.Map): void {
	syncRouteProgress(m, null);
}
