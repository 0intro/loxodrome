/* The hover-preview highlight: a dashed slate line over a white casing
 * (or several, a multi-route plan) drawn while a Flights-surface row is
 * under the pointer, the transient-hover sink idiom of hoverSupaipZone
 * (supaipLayer.ts): one module map handle, one group cleared per call,
 * a single nullable setter, no reactive state and no state imports (the
 * one-way layer contract). Non-interactive, so it never intercepts
 * clicks. The casing is the busy-tile legibility trick every real line
 * here uses (routeLayer, navLayer): a bare muted stroke disappears over
 * the ICAO charts. Pane 462 sits ABOVE the route lines (455) and the
 * nav trace (460) on purpose: hovering the row of a plan or trace that
 * is ALREADY drawn overlays the emphasis on it, the app's
 * hover-highlight reading; the dash keeps it provisional, never a
 * route. The camera never moves: a preview off-screen simply shows
 * nothing (fit stays the click actions' job). */

import L from 'leaflet';
import { ensurePane } from './directDrawLayer';

const PANE = 'preview-ghost';
const PANE_Z = '462';
/** The preview ink: a slate darker than routeProgress' flown grey
 *  (#94a3b8), because this line must STAND OUT over chart tiles rather
 *  than fade behind the real ones. No CSS token (map lines hardcode
 *  their ink by charter). */
const PREVIEW_INK = '#475569';

let mapRef: L.Map | null = null;
let group: L.LayerGroup | null = null;

/** Idempotent; MapView calls it at mount beside the sibling builds. */
export function buildPreviewLayer(m: L.Map): void {
	ensurePane(m, PANE, PANE_Z);
	mapRef = m;
	if (!group) {
		group = L.layerGroup().addTo(m);
	}
}

export function clearPreviewLayer(): void {
	group?.remove();
	group = null;
	mapRef = null;
}

/** Draw the highlight (one casing + dashed line per line array), or
 *  clear it with null. */
export function showPreviewGhost(lines: readonly L.LatLngTuple[][] | null): void {
	if (!mapRef || !group) {
		return;
	}
	group.clearLayers();
	if (!lines) {
		return;
	}
	for (const line of lines) {
		if (line.length < 2) {
			continue;
		}
		L.polyline(line, {
			pane: PANE,
			interactive: false,
			color: '#ffffff',
			weight: 7,
			opacity: 0.9,
			lineCap: 'round',
			lineJoin: 'round',
		}).addTo(group);
		L.polyline(line, {
			pane: PANE,
			interactive: false,
			color: PREVIEW_INK,
			weight: 3.5,
			opacity: 1,
			dashArray: '7 6',
			lineCap: 'round',
			lineJoin: 'round',
		}).addTo(group);
	}
}
