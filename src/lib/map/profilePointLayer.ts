/* profilePointLayer.ts: the point the map altitude profile is taken over, as one
 * draggable crosshair. Created on the first sync, detached when the point goes
 * (syncNavAircraft's lifecycle), so the marker is up exactly while that surface
 * is. Dragging it re-targets the profile LIVE: every Leaflet 'drag' writes
 * setMapProfilePoint and the surface's own deriveds re-cut the airspace stack and
 * re-read the terrain from there. Fed imperatively from a MapView effect, like
 * every other layer; the drag write is the one direction back, the way routeLayer
 * commits a waypoint move.
 *
 * The marker is interactive because Leaflet builds MarkerDrag inside
 * _initInteraction, which returns early without it, and it listens for 'drag' and
 * 'click' ONLY: Map._findEventTargets resolves targets per event type, so a
 * right-click or a mousemove over the crosshair still reaches the map and the
 * ungated "what's here?" menu keeps working over it.
 *
 * No suppressSync latch, unlike routeLayer: this layer never rebuilds the icon,
 * and the point it reads back is the one the drag just read off the marker, so
 * the guarded setLatLng is a no-op for the whole gesture and never fights it.
 * That is also what keeps Leaflet's own post-drop click suppression (which looks
 * the icon element up) working. */

import L from 'leaflet';
import { setMapProfilePoint, type ProfilePoint } from '$lib/state/mapProfileModal.svelte';
import { ensurePane } from './directDrawLayer';

// i18n-ignore-start: SVG marker markup, not display text
/* Geometry once, stroked twice: a thick white casing under near-black ink, so the
 * glyph reads on every base layer and chart in every theme (theme tokens don't
 * reach Leaflet layers). A hollow ring with outward ticks cannot be read as chart
 * symbology, nor confused with a route waypoint's filled numbered disc or the
 * solid aircraft glyph. */
const CROSSHAIR = '<circle cx="14" cy="14" r="5.5"/><path d="M14 2.5V6M14 25.5V22M2.5 14H6M25.5 14H22"/>';
const CROSSHAIR_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28">' +
	`<g fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round">${CROSSHAIR}</g>` +
	`<g fill="none" stroke="#1b1b1b" stroke-width="1.9" stroke-linecap="round">${CROSSHAIR}</g>` +
	'<circle cx="14" cy="14" r="1.6" fill="#1b1b1b"/>' +
	'</svg>';
// i18n-ignore-end

// Non-reactive module state (Leaflet objects + the stamped tooltip).
let icon: L.DivIcon | null = null;
let marker: L.Marker | null = null;
let currentTitle = '';

function profilePointIcon(): L.DivIcon {
	if (!icon) {
		icon = L.divIcon({
			html: CROSSHAIR_SVG,
			className: 'profile-pin',
			iconSize: [28, 28],
			iconAnchor: [14, 14],
		});
	}
	return icon;
}

function wireMarker(mk: L.Marker): void {
	mk.on('drag', () => {
		const ll = mk.getLatLng();
		setMapProfilePoint(ll.lat, ll.lng);
	});
	mk.on('click', (e: L.LeafletMouseEvent) => {
		// Don't let the click reach the map, which in route edit mode would add a
		// waypoint under the crosshair. Leaflet suppresses the synthetic click a
		// drop leaves behind on its own here (the icon element is never replaced),
		// so this covers the plain click.
		L.DomEvent.stopPropagation(e);
	});
}

/** Stamp the tooltip on the live element: DivIcon bakes its options at creation,
 *  so a locale change has to reach the element that is already on the map. */
function setTitle(mk: L.Marker, title: string): void {
	if (title === currentTitle) {
		return;
	}
	currentTitle = title;
	mk.getElement()?.setAttribute('title', title);
}

/** Show the profiled point at `point` (null removes it), tooltipped `title`. */
export function syncProfilePoint(m: L.Map, point: ProfilePoint | null, title: string): void {
	if (!point) {
		clearProfilePoint(m);
		return;
	}
	if (!marker) {
		// Above the route waypoint pins (655), which are interactive and would take
		// the pointer from the one marker meant to be grabbed; below the trajectory
		// vector (658) and the aircraft (660), which stay on top because keeping the
		// pilot's own position in view is what docking a chart is for. Those are
		// non-interactive, so drawing over the crosshair costs it no grab.
		ensurePane(m, 'map-profile-point', '656');
		marker = L.marker([point.lat, point.lng], {
			pane: 'map-profile-point',
			icon: profilePointIcon(),
			draggable: true,
			autoPan: true,
			// No keyboard drag behind it, so keep the icon out of the tab order; the
			// surface header states the position instead.
			keyboard: false,
		});
		wireMarker(marker);
		marker.addTo(m);
		setTitle(marker, title);
		return;
	}
	// Guarded, and never a re-create: the drag is what wrote the point read back
	// here, so an unguarded setLatLng would re-position the marker under its own
	// pointer on every frame of the gesture.
	const ll = marker.getLatLng();
	if (ll.lat !== point.lat || ll.lng !== point.lng) {
		marker.setLatLng([point.lat, point.lng]);
	}
	setTitle(marker, title);
}

/** Detach the marker and drop the ref (close, HMR / unmount teardown). */
export function clearProfilePoint(m: L.Map): void {
	if (marker) {
		marker.off();
		if (m.hasLayer(marker)) {
			m.removeLayer(marker);
		}
		marker = null;
	}
	currentTitle = '';
}
