/* routeLayer.ts: the flight-route overlay, one coloured polyline per route plus
 * one draggable L.marker per waypoint on the ACTIVE route. Reverse-synced from
 * the routes $state via a keyed diff (per route). The diff, a suppressSync flag,
 * and writing state only on dragend keep the state-driven rebuild from fighting a
 * live drag (see syncRoutes / wireMarker).
 *
 * Only the active route carries draggable pins; an inactive route draws a
 * thinner, lower-opacity line (over the same white casing) and a click on it
 * activates the route. Markers only ever exist for the active route, so every
 * waypoint mutator
 * (selectWaypoint / moveWaypoint / setWaypointFromSnap) targets activeRoute()
 * unambiguously, no route id needed on the marker.
 *
 * snapLatLng finds the nearest existing waypoint (so a new point can anchor onto
 * one already placed) else the nearest airport / navaid, within a pixel tolerance
 * and ignoring layer-visibility gates (the ungated index queries in airport /
 * navaidLayer) so a waypoint snaps even with those layers off.
 *
 * One leg of the active route can be POINTED AT from either side (highlightLeg /
 * legAt over state/legHover.svelte.ts): the Route tab's leg row draws its segment
 * heavy here, and a segment under the pointer marks its row there.
 *
 * On a touch screen a finger's long press on a pin is the platform's
 * contextmenu, raised while the finger is still down: the pin lifts and the
 * map's menu waits for the release (map/touchPress.ts), so a long press that
 * goes on to drag opens nothing, and a drag that begins closes any menu open
 * by another path.
 *
 * A dragged pin shows where it will land. Within the snap tolerance of an
 * aerodrome, a navaid or a waypoint it sits ON the target, the two legs it
 * pulls with it (the magnet), and a tip above it names the landing
 * (state/pinDrag.svelte.ts, drawn by MapView): the finger hides the pin, and
 * the drop used to snap unseen. The drop commits exactly the landing the last
 * frame showed.
 *
 * A LEG of the active route is a drag target too: pulled, a new waypoint
 * comes off it under the pointer (a ghost pin with the same magnet, rubber
 * band and tip) and the drop inserts it into that leg (legCarry). The mouse
 * pulls at once, its hover over the line being the affordance (armLegDrag, a
 * grab cursor there); a finger has no hover, and a quick drag on the line
 * must still pan, so a finger long-presses first (map/touchPress.ts). Every
 * route drag, a pin's or a leg's, announces itself on the map
 * (map/routeDragEvents.ts) so follow mode holds the map still under it.
 *
 * In flight the route is LOCKED on the map (setRouteLock, the rule in
 * state/routeLock.svelte.ts): no pin and no leg takes a drag, save the one
 * pin the menu's Move waypoint arms for one drag, lifted. */

import L from 'leaflet';
import { navaidFreqLabel } from '$lib/data/navaids';
import { equirectangularDistanceM } from '$lib/notam/geometry';
import { routeColorMap } from '$lib/route/routeColors';
import { closeContextMenu } from '$lib/state/contextMenu.svelte';
import { mapState } from '$lib/state/map.svelte';
import { setPinLanding } from '$lib/state/pinDrag.svelte';
import { offerUndoFor } from '$lib/state/undoChip.svelte';
import {
	activeRoute,
	insertWaypointAfter,
	moveWaypoint,
	routes,
	selectWaypoint,
	setActiveRoute,
	setWaypointFromSnap,
	type Route,
	type Waypoint,
	type WaypointSnap,
} from '$lib/state/route.svelte';
import { nearestAirportUngated } from './airportLayer';
import { ensurePane } from './directDrawLayer';
import { nearestNavaidUngated } from './navaidLayer';
import { ROUTE_DRAG_END, ROUTE_DRAG_START } from './routeDragEvents';
import { routeLegInsertAt } from './routeHit';
import { waypointIcon } from './routeIcons';
import { pressHeld, type Carry } from './touchPress';

const SNAP_TOLERANCE_PX = 12;
/** How close the pointer must come to a leg for it to count as pointing at it.
 *  The coloured line is a 4 px stroke and its casing is non-interactive, so a
 *  polyline mouseover would be a target nobody can hold; this is the tolerance
 *  legAt applies instead, the snap tolerance's sibling. */
const LEG_HOVER_TOLERANCE_PX = 10;
/** The route hue of last resort, when routeColorMap has no entry for a route
 *  (it is keyed on the live list). */
const FALLBACK_ROUTE_COLOR = '#c2185b';
/** The pointed-at leg's own pane, just above the live progress overlay (456) and
 *  below the recorded trace (460). */
const LEG_PANE = 'route-leg';
const LEG_PANE_Z = '457';

interface RouteVisual {
	polyline: L.Polyline;
	// A wider white halo drawn under the coloured line (pane 'route-casing', below
	// 'route') so the route reads on any background. Non-interactive: clicks fall
	// through to the coloured line. Its geometry + dash mirror the polyline.
	casing: L.Polyline;
	// Leaflet marker objects keyed by waypoint id (a cache, not reactive state).
	markers: Map<string, L.Marker>;
}

let group: L.LayerGroup | null = null;
// Per-route polyline + markers, keyed by route id (a cache, not reactive state).
const visualsByRouteId = new Map<string, RouteVisual>();
// True while a drag mutates route state, so the state-driven syncRoutes skips
// its rebuild and never fights the live drag.
let suppressSync = false;
// performance.now() of the last waypoint dragend. Leaflet fires a synthetic map
// 'click' on drop and normally suppresses it, but repainting the dropped pin here
// (syncRoutes runs on the dragend state write) defeats that guard, so the click
// leaks to the map and onMapClick would select the feature under the drop.
// onMapClick ignores a click within this window after a drag (see isPostDragClick).
// Plain module var, intentionally not reactive.
let lastDragEndAt = -Infinity;
const POST_DRAG_CLICK_MS = 250;
// The waypoint a list is currently pointing at (highlightWaypoint), read by
// syncActiveMarkers so any route sync re-applies it. Plain module var, the
// highlightAirspace idiom, intentionally not reactive.
let highlightedWaypointId: string | null = null;
// The route locked on the map in flight (setRouteLock): no pin drags and no leg
// carries, but the one pin armed for one drag (movingId). Plain module vars:
// MapView's effect writes them from state/routeLock.svelte.ts, which this
// module does not import (it would load the recorder into every map spec).
let locked = false;
let movingId: string | null = null;
/** Ends the armed drag: MapView's hand into the lock state. */
let endMove: (() => void) | null = null;
/** Takes down the window listener ending the armed drag at another press. */
let armedPressOff: (() => void) | null = null;
// The pointed-at leg's two lines (see highlightLeg), added straight to the map
// like the progress overlay's rather than to the route group: they belong to no
// route's visual and are torn down by name.
let legCasing: L.Polyline | null = null;
let legLine: L.Polyline | null = null;
// The waypoint the drawn leg leaves, so a drag can pull that leg along.
let highlightedLegFromId: string | null = null;

/** True when a map click is the synthetic tail of a just-ended waypoint drag, so
 *  the map's click handler should ignore it (dragend already moved the pin). */
export function isPostDragClick(): boolean {
	return performance.now() - lastDragEndAt < POST_DRAG_CLICK_MS;
}

function ensureRoutePanes(m: L.Map): void {
	if (!m.getPane('route-casing')) {
		// The white halo, just below the coloured line so every casing renders
		// under every line (one route's halo never washes over another's colour).
		m.createPane('route-casing').style.zIndex = '454';
	}
	if (!m.getPane('route')) {
		// Above NOTAM areas (450), below the trigger overlay (470).
		m.createPane('route').style.zIndex = '455';
	}
	// The live progress overlay (z 456) is routeProgressLayer.ts's own pane.
	if (!m.getPane('route-markers')) {
		// Above NOTAM marker pins (markerPane 600) so waypoints stay grabbable.
		m.createPane('route-markers').style.zIndex = '655';
	}
}

/** Nearest existing waypoint within `radiusM` of (lat, lon) across every route,
 *  skipping `excludeId` (the waypoint being dragged, so a drop never snaps onto its
 *  own old spot). Linear over the workspace's handful of waypoints. */
function nearestWaypoint(
	lat: number,
	lon: number,
	radiusM: number,
	excludeId: string | undefined,
): Waypoint | null {
	let best: Waypoint | null = null;
	let bestD = Infinity;
	for (const r of routes.list) {
		for (const w of r.waypoints) {
			if (w.id === excludeId) {
				continue;
			}
			const d = equirectangularDistanceM(lat, lon, w.lat, w.lon);
			if (d <= radiusM && d < bestD) {
				best = w;
				bestD = d;
			}
		}
	}
	return best;
}

/** Nearest snap target within a ~12 px tolerance of (lat, lon): an existing route
 *  waypoint (any route, never `excludeId`) else the nearest airport / navaid, as a
 *  WaypointSnap, or null. An existing waypoint wins so a new point can anchor onto
 *  one the user already placed, a free custom point included (no feature snap
 *  reaches those); among features airport beats navaid (matches featureAt). The
 *  feature queries are ungated, so snapping works with those layers off. */
export function snapLatLng(lat: number, lon: number, excludeId?: string): WaypointSnap | null {
	const m = mapState.map;
	if (!m) {
		return null;
	}
	const center = m.latLngToLayerPoint([lat, lon]);
	const edge = m.layerPointToLatLng(center.add(L.point(SNAP_TOLERANCE_PX, 0)));
	const radiusM = equirectangularDistanceM(lat, lon, edge.lat, edge.lng);
	const wp = nearestWaypoint(lat, lon, radiusM, excludeId);
	if (wp) {
		return {
			lat: wp.lat,
			lon: wp.lon,
			kind: wp.kind,
			refId: wp.refId,
			ident: wp.ident,
			label: wp.label,
			freq: wp.freq,
		};
	}
	const ap = nearestAirportUngated(lat, lon, radiusM);
	const nv = nearestNavaidUngated(lat, lon, radiusM);
	if (ap && (!nv || ap.distM <= nv.distM)) {
		return {
			lat: ap.airport.lat,
			lon: ap.airport.lon,
			kind: 'airport',
			refId: ap.airport.ident.toUpperCase(),
			ident: ap.airport.ident,
			label: ap.airport.name || undefined,
		};
	}
	if (nv) {
		const freq = navaidFreqLabel(nv.navaid);
		return {
			lat: nv.navaid.lat,
			lon: nv.navaid.lon,
			kind: 'navaid',
			refId: nv.navaid.id,
			ident: nv.navaid.ident,
			label: nv.navaid.name || undefined,
			freq: freq || undefined,
		};
	}
	return null;
}

function wireMarker(marker: L.Marker, id: string): void {
	// Where the drop lands, as the last drag frame found it: a snap target,
	// null for a free point, undefined before any frame. The drop commits
	// exactly this, the landing the pin and its tip showed: snapping again
	// from the target could pick a waypoint within tolerance of IT that the
	// pointer never came near, waypoints ranking first in snapLatLng.
	let landing: WaypointSnap | null | undefined;
	marker.on('dragstart', () => {
		landing = undefined;
		suppressSync = true;
		selectWaypoint(id);
		// A menu a finger's long press opened by any path touchPress.ts did
		// not hold back goes the moment the drag begins: it would stand over
		// the drag and outlive the drop, describing where the pin was.
		closeContextMenu();
		mapState.map?.fire(ROUTE_DRAG_START);
	});
	marker.on('drag', () => {
		// The magnet: MarkerDrag re-reads the icon's position on every move
		// (and autoPan's frames re-fire this), so each frame starts again from
		// the pointer, snaps from there, and a snap never sticks. setLatLng
		// only moves the icon and fires 'move'.
		const raw = marker.getLatLng();
		// Exclude this waypoint so the drop can't snap back onto its own old spot.
		landing = snapLatLng(raw.lat, raw.lng, id);
		if (landing) {
			marker.setLatLng([landing.lat, landing.lon]);
		}
		const at = marker.getLatLng();
		updatePolylineDuringDrag(id, at);
		publishLanding(id, at, landing);
	});
	marker.on('dragend', () => {
		setPinLanding(null);
		const ll = marker.getLatLng();
		const snap = landing !== undefined ? landing : snapLatLng(ll.lat, ll.lng, id);
		// Release before writing state so the resulting syncRoutes runs; the
		// marker is already where state will be, so the diff is a no-op (or a
		// single setLatLng when snapping relocates it onto a feature or waypoint).
		// The drop is one step, and the map offers it back (the undo chip): a
		// pin moved by a stray finger is the edit most in need of it.
		suppressSync = false;
		offerUndoFor('moved', () => {
			if (snap) {
				setWaypointFromSnap(id, snap);
			} else {
				moveWaypoint(id, ll.lat, ll.lng);
			}
		});
		// Stamp the drop so the trailing synthetic map click is ignored (see
		// lastDragEndAt): without this a drop would also select the feature
		// under it.
		lastDragEndAt = performance.now();
		mapState.map?.fire(ROUTE_DRAG_END);
		// The one drag the lock let through is done.
		if (id === movingId) {
			endMove?.();
		}
	});
	marker.on('click', (e: L.LeafletMouseEvent) => {
		// Don't let the click reach the map (which would select the feature
		// under the pin, and let this waypoint's selection go); just select
		// this one.
		L.DomEvent.stopPropagation(e);
		selectWaypoint(id);
	});
}

/** Rubber-band the active route's legs touching the dragged waypoint, without
 *  writing state (state is committed on dragend). */
function updatePolylineDuringDrag(id: string, live: L.LatLng): void {
	const visual = visualsByRouteId.get(routes.activeId);
	if (!visual) {
		return;
	}
	const wps = activeRoute().waypoints;
	if (wps.length < 2) {
		return;
	}
	const at = (w: Waypoint): L.LatLngTuple => (w.id === id ? [live.lat, live.lng] : [w.lat, w.lon]);
	setVisualLatLngs(visual, wps.map(at));
	// The pointed-at leg (highlightLeg) follows when it is one of the two the
	// drag pulls: a focused Route-tab row's emphasis would otherwise stay on
	// the old geometry through the whole drag.
	if (legLine && legCasing && highlightedLegFromId) {
		const i = wps.findIndex((w) => w.id === highlightedLegFromId);
		const from = wps[i];
		const to = wps[i + 1];
		if (from && to && (from.id === id || to.id === id)) {
			const latlngs = [at(from), at(to)];
			legCasing.setLatLngs(latlngs);
			legLine.setLatLngs(latlngs);
		}
	}
}

/** Tell the tip where the dragged pin will land (state/pinDrag.svelte.ts). */
function publishLanding(id: string, at: L.LatLng, snap: WaypointSnap | null): void {
	const m = mapState.map;
	if (!m) {
		return;
	}
	const p = m.latLngToContainerPoint(at);
	const wp = activeRoute().waypoints.find((w) => w.id === id);
	setPinLanding({
		x: p.x,
		y: p.y,
		lat: at.lat,
		lon: at.lng,
		snap,
		keptLabel: wp?.kind === 'free' ? wp.label : undefined,
		finger: pressHeld(),
	});
}

/** A click on a route line: activate an inactive route. A click on the active
 *  line is swallowed, as it always was: the line is an aimed target, and the
 *  map under it answers its own click beside the stroke. */
function onRoutePolylineClick(e: L.LeafletMouseEvent, routeId: string): void {
	L.DomEvent.stopPropagation(e);
	// Ignore the synthetic click a waypoint drag leaves behind (see
	// isPostDragClick), else dropping a pin onto another route's line would
	// activate that route under the drop.
	if (isPostDragClick()) {
		return;
	}
	if (routeId !== routes.activeId) {
		setActiveRoute(routeId);
	}
}

/** The leg of `wps` nearest the layer point `p`, as its index (the leg leaving
 *  waypoint i) and its pixel distance. Null on a route with no leg. */
function nearestLeg(
	m: L.Map,
	wps: Waypoint[],
	p: L.Point,
): { index: number; distPx: number } | null {
	if (wps.length < 2) {
		return null;
	}
	let bestSeg = 0;
	let bestD = Infinity;
	for (let i = 0; i + 1 < wps.length; i++) {
		const a = m.latLngToLayerPoint([wps[i].lat, wps[i].lon]);
		const b = m.latLngToLayerPoint([wps[i + 1].lat, wps[i + 1].lon]);
		const d = L.LineUtil.pointToSegmentDistance(p, a, b);
		if (d < bestD) {
			bestD = d;
			bestSeg = i;
		}
	}
	return { index: bestSeg, distPx: bestD };
}

/** The ACTIVE route's leg under (lat, lon) within LEG_HOVER_TOLERANCE_PX, named
 *  by the waypoint it leaves. The active route alone qualifies: it is the one
 *  the Route tab lists, so it is the only one with a row to mark. Null while a
 *  waypoint drag owns the geometry (the line is rubber-banded ahead of state,
 *  and the pointer is moving a leg, not pointing at one). */
export function legAt(lat: number, lon: number): { routeId: string; fromId: string } | null {
	const m = mapState.map;
	if (!m || suppressSync) {
		return null;
	}
	const route = activeRoute();
	const near = nearestLeg(m, route.waypoints, m.latLngToLayerPoint([lat, lon]));
	if (!near || near.distPx > LEG_HOVER_TOLERANCE_PX) {
		return null;
	}
	return { routeId: route.id, fromId: route.waypoints[near.index].id };
}

/** Create (once) the casing + coloured polyline + marker cache for a route, bound
 *  to its id. The casing is added first (its own lower pane) and is
 *  non-interactive, so the coloured line keeps the click. */
function ensureVisual(g: L.LayerGroup, routeId: string): RouteVisual {
	let visual = visualsByRouteId.get(routeId);
	if (!visual) {
		const casing = L.polyline([], {
			pane: 'route-casing',
			interactive: false,
			color: '#ffffff',
			lineCap: 'round',
			lineJoin: 'round',
		});
		casing.addTo(g);
		const polyline = L.polyline([], { pane: 'route', weight: 3, opacity: 0.9 });
		polyline.on('click', (e: L.LeafletMouseEvent) => onRoutePolylineClick(e, routeId));
		polyline.addTo(g);
		visual = { polyline, casing, markers: new Map<string, L.Marker>() };
		visualsByRouteId.set(routeId, visual);
	}
	return visual;
}

/** Set the coloured line and its casing to the same geometry (the halo tracks the
 *  line during a drag and on every sync). */
function setVisualLatLngs(visual: RouteVisual, latlngs: L.LatLngTuple[]): void {
	visual.polyline.setLatLngs(latlngs);
	visual.casing.setLatLngs(latlngs);
}

/** Keyed-diff the active route's draggable pins to its waypoint list. */
function syncActiveMarkers(
	g: L.LayerGroup,
	visual: RouteVisual,
	waypoints: Waypoint[],
	selectedId: string | null,
): void {
	const markers = visual.markers;
	const wanted = new Set(waypoints.map((w) => w.id));
	for (const [id, marker] of markers) {
		if (!wanted.has(id)) {
			marker.off();
			g.removeLayer(marker);
			markers.delete(id);
		}
	}
	const total = waypoints.length;
	waypoints.forEach((wp, i) => {
		const icon = waypointIcon(wp, i, total, wp.id === selectedId, lifted(wp.id));
		const existing = markers.get(wp.id);
		if (!existing) {
			const marker = L.marker([wp.lat, wp.lon], {
				icon,
				draggable: pinDraggable(wp.id),
				autoPan: true,
				pane: 'route-markers',
			});
			wireMarker(marker, wp.id);
			marker.addTo(g);
			markers.set(wp.id, marker);
		} else {
			const ll = existing.getLatLng();
			if (ll.lat !== wp.lat || ll.lng !== wp.lon) {
				existing.setLatLng([wp.lat, wp.lon]);
			}
			existing.setIcon(icon);
		}
	});
}

/** Rebuild ONE marker's icon from the route's current state. Two of these per
 *  hover change beats re-running the whole keyed diff: running a list of pins
 *  rewrites every pin's innerHTML per row the pointer crosses. */
function reiconWaypoint(route: Route, visual: RouteVisual, id: string | null): void {
	if (!id) {
		return;
	}
	const i = route.waypoints.findIndex((w) => w.id === id);
	const wp = route.waypoints[i];
	if (!wp) {
		return;
	}
	visual.markers
		.get(id)
		?.setIcon(
			waypointIcon(
				wp,
				i,
				route.waypoints.length,
				wp.id === route.selectedWaypointId,
				lifted(wp.id),
			),
		);
}

/** Flash one waypoint's pin: a nav-log ident row or a Route-tab waypoint row is
 *  pointing at it. The PIN is what carries this, not the aerodrome / navaid it
 *  is anchored to: a snapped waypoint sits exactly on its feature symbol
 *  (routeIcons' centered anchor) and the pin is drawn 255 pane-points above it
 *  (route-markers 655 vs airports 400), same size or bigger, so a feature
 *  highlight there is invisible by construction. Markers exist only for the
 *  active route, which is the route both hovering surfaces list. */
export function highlightWaypoint(id: string | null): void {
	if (highlightedWaypointId === id) {
		return;
	}
	const prev = highlightedWaypointId;
	highlightedWaypointId = id;
	const route = activeRoute();
	const visual = visualsByRouteId.get(route.id);
	if (!visual) {
		return;
	}
	reiconWaypoint(route, visual, prev);
	reiconWaypoint(route, visual, id);
}

/** Flash one leg of the active route: a Route-tab leg row is pointing at it, or
 *  the pointer is resting on that segment of the map (state/legHover.svelte.ts).
 *  The segment redraws heavy in the route's OWN colour over its own white
 *  casing, the heavy-leg mark routeProgressLayer.ts defines to the pixel (6
 *  over 10, casing = colour + 4) and never the nav orange, which the recorded
 *  trace owns: the app says "this leg" one way, and one step over the route's
 *  own 4 over 8 is as loud as a pointer flash should be beside the row it
 *  lights. Sharing the in-flight leg's weight costs nothing, that overlay
 *  living where there is no pointer to hover with. Its own pane above the route
 *  line, non-interactive, so the line keeps every click and a waypoint drag is
 *  untouched.
 *
 *  `fromId` names the waypoint the leg LEAVES. One that is not on the active
 *  route (a row deleted under the pointer, a route switched, the last waypoint,
 *  which leaves no leg) draws nothing. Never a no-op on an unchanged id: the
 *  geometry it points at moves under it (a waypoint dragged, a row reordered),
 *  and the caller re-runs on exactly that. */
export function highlightLeg(fromId: string | null): void {
	const route = activeRoute();
	const i = fromId ? route.waypoints.findIndex((w) => w.id === fromId) : -1;
	const from = i >= 0 ? route.waypoints[i] : null;
	const to = from ? (route.waypoints[i + 1] ?? null) : null;
	const m = mapState.map;
	if (!m || !from || !to) {
		legCasing?.remove();
		legLine?.remove();
		legCasing = null;
		legLine = null;
		highlightedLegFromId = null;
		return;
	}
	highlightedLegFromId = from.id;
	ensurePane(m, LEG_PANE, LEG_PANE_Z);
	// Created in paint order: the casing, then the leg over it (one pane, so the
	// SVG renderer stacks them as added).
	if (!legCasing) {
		legCasing = L.polyline([], {
			pane: LEG_PANE,
			interactive: false,
			color: '#ffffff',
			weight: 10,
			opacity: 0.9,
			lineCap: 'round',
			lineJoin: 'round',
		}).addTo(m);
	}
	if (!legLine) {
		legLine = L.polyline([], {
			pane: LEG_PANE,
			interactive: false,
			weight: 6,
			opacity: 1,
			lineCap: 'round',
			lineJoin: 'round',
		}).addTo(m);
	}
	const latlngs: L.LatLngTuple[] = [
		[from.lat, from.lon],
		[to.lat, to.lon],
	];
	// An alternate's line is dashed, so its emphasis is too: the heavy segment
	// must read as that same line, not as a second one drawn over it.
	const dash = route.alternate ? '9 6' : undefined;
	legCasing.setStyle({ dashArray: dash });
	legCasing.setLatLngs(latlngs);
	legLine.setStyle({
		color: routeColorMap(routes.list).get(route.id) ?? FALLBACK_ROUTE_COLOR,
		dashArray: dash,
	});
	legLine.setLatLngs(latlngs);
}

/** Drop every marker for a route (an inactive route carries none). */
function dropMarkers(g: L.LayerGroup, visual: RouteVisual): void {
	for (const marker of visual.markers.values()) {
		marker.off();
		g.removeLayer(marker);
	}
	visual.markers.clear();
}

function removeVisual(g: L.LayerGroup, visual: RouteVisual): void {
	visual.polyline.off();
	g.removeLayer(visual.polyline);
	g.removeLayer(visual.casing);
	dropMarkers(g, visual);
}

/** Reconcile every route's polyline + the active route's markers to the routes
 *  list. A keyed diff (never a teardown / rebuild) so an unrelated state write
 *  doesn't recreate a marker under the cursor; bails while a drag owns the DOM.
 *  Every route draws a coloured line over a white casing; the active route is
 *  thickest / full-opacity with draggable numbered pins, the others a step down
 *  and no pins (a click activates them). Alternates draw dashed in their parent
 *  trip's hue. */
export function syncRoutes(m: L.Map, list: Route[], activeId: string): void {
	if (suppressSync) {
		return;
	}
	ensureRoutePanes(m);
	if (!group) {
		group = L.layerGroup().addTo(m);
	}
	const g = group;
	const wanted = new Set(list.map((r) => r.id));
	for (const [id, visual] of visualsByRouteId) {
		if (!wanted.has(id)) {
			removeVisual(g, visual);
			visualsByRouteId.delete(id);
		}
	}
	// An alternate shares its parent trip's hue; alternates draw dashed (see
	// routeColorMap). The active route draws thickest / full-opacity with a strong
	// halo; the others draw brighter than before but a step down, no pins.
	const colors = routeColorMap(list);
	list.forEach((route) => {
		const active = route.id === activeId;
		const visual = ensureVisual(g, route.id);
		const color = colors.get(route.id) ?? FALLBACK_ROUTE_COLOR;
		const weight = active ? 4 : 3;
		const dash = route.alternate ? '9 6' : undefined;
		visual.casing.setStyle({
			weight: weight + 4,
			opacity: active ? 0.9 : 0.7,
			dashArray: dash,
		});
		visual.polyline.setStyle({
			color,
			weight,
			opacity: active ? 1 : 0.8,
			dashArray: dash,
		});
		setVisualLatLngs(
			visual,
			route.waypoints.length >= 2
				? route.waypoints.map((w) => [w.lat, w.lon] as L.LatLngTuple)
				: [],
		);
		if (active) {
			syncActiveMarkers(g, visual, route.waypoints, route.selectedWaypointId);
		} else if (visual.markers.size > 0) {
			dropMarkers(g, visual);
		}
	});
}

/* ---- The route locked on the map in flight --------------------------------- */

/** A pin takes a drag: always on the ground, in flight only the one armed. */
function pinDraggable(id: string): boolean {
	return !locked || id === movingId;
}

/** A pin drawn lifted: pointed at by a list, or armed for its one drag. */
function lifted(id: string): boolean {
	return id === highlightedWaypointId || id === movingId;
}

/** Whether `node` is `root` or inside it (duck-typed, for the specs' DOM). */
function within(node: unknown, root: unknown): boolean {
	for (let n = node as { parentNode?: unknown } | null; n; n = (n.parentNode ?? null) as typeof n) {
		if (n === root) {
			return true;
		}
	}
	return false;
}

/** Lock the route on the map (`on`), or free it; `moveId` names the one pin
 *  armed for one drag while locked, and `end` is how this layer says that
 *  drag is over (at its drop, or at a press anywhere else). MarkerDrag's own
 *  switch does it (`marker.dragging`), which a setIcon keeps; a locked pin
 *  loses `leaflet-marker-draggable`, so touchPress.ts lifts nothing under a
 *  finger's long press there and the menu opens at once. */
export function setRouteLock(on: boolean, moveId: string | null, end: () => void): void {
	endMove = end;
	const nextMoving = on ? moveId : null;
	if (on === locked && nextMoving === movingId) {
		return;
	}
	const wasMoving = movingId;
	locked = on;
	movingId = nextMoving;
	const route = activeRoute();
	const visual = visualsByRouteId.get(route.id);
	if (visual) {
		for (const [id, marker] of visual.markers) {
			const want = pinDraggable(id);
			if (marker.dragging && marker.dragging.enabled() !== want) {
				if (want) {
					marker.dragging.enable();
				} else {
					marker.dragging.disable();
				}
			}
		}
		reiconWaypoint(route, visual, wasMoving);
		reiconWaypoint(route, visual, movingId);
	}
	armedPressOff?.();
	armedPressOff = null;
	if (movingId !== null && typeof window !== 'undefined') {
		// A press anywhere but the armed pin ends the arm: the arm is for the
		// next gesture, and a pan, a tap on the band or on the chip is not it.
		const armed = movingId;
		const capture = { capture: true };
		const onPress = (e: PointerEvent): void => {
			const pin = visualsByRouteId.get(routes.activeId)?.markers.get(armed)?.getElement();
			if (!pin || !within(e.target, pin)) {
				endMove?.();
			}
		};
		window.addEventListener('pointerdown', onPress, capture);
		armedPressOff = () => window.removeEventListener('pointerdown', onPress, capture);
	}
}

/* ---- A leg dragged out into a new waypoint -------------------------------
 * The route line is the drag target for an insert, as Google Maps' and
 * SkyDemon's are. Which leg is the right-click menu's own rule
 * (map/routeHit.ts routeLegInsertAt: the nearest leg, never on a pin), so a
 * leg the menu would insert into is exactly one a drag can carry. */

/** Pixels a mouse press on a leg travels before it carries: one past
 *  Leaflet's own drag threshold, so a click that wobbles stays a click. */
const MOUSE_CARRY_PX = 4;
/** MarkerDrag's autoPanPadding and autoPanSpeed, the pin drag's: the band
 *  along the map's edge where a carry pans the map, and the most pixels it
 *  pans a frame (proportional to how deep into the band the pointer is). */
const CARRY_PAN_PAD_PX = 50;
const CARRY_PAN_SPEED_PX = 10;
/** Leaflet's own mark of a drag in progress, on <body>: MapView's hover
 *  stands down for it and touchPress.ts reads it as "a drag, no menu". */
const DRAGGING_CLASS = 'leaflet-dragging';

/** The carry in progress, at most one: its abort, for a teardown. */
let carryAbort: (() => void) | null = null;

/** Pull a new waypoint off leg `index` of the active route (the leg leaving
 *  waypoint `index`), as a carry the pointer drives in viewport pixels:
 *  `prime` puts the ghost pin down, lifted, where the pointer is; the first
 *  `move` takes the line (the rubber band, the later pins renumbered, the tip)
 *  and every move places the ghost with the pin drag's magnet; `commit`
 *  inserts the landing the last move showed, one step offered back by the
 *  undo chip; `cancel` puts everything back. `finger` lifts the tip clear of
 *  a finger. Null while a drag already owns the line or the leg is gone. */
export function legCarry(index: number, finger: boolean): Carry | null {
	const m = mapState.map;
	const route = activeRoute();
	const fromId = route.waypoints[index]?.id;
	const toId = route.waypoints[index + 1]?.id;
	if (!m || fromId === undefined || toId === undefined || locked || suppressSync || carryAbort) {
		return null;
	}
	const map = m;
	const routeId = route.id;
	let ghost: L.Marker | null = null;
	let started = false;
	let ended = false;
	let landing: WaypointSnap | null = null;
	let at: L.LatLng | null = null;
	let last: { x: number; y: number } | null = null;
	let panFrame = 0;

	/** Where the carried leg is now, found by its two waypoints; -1 once it
	 *  has gone (an undo under the drag, another route activated). */
	const legIndex = (): number => {
		if (routes.activeId !== routeId) {
			return -1;
		}
		const wps = activeRoute().waypoints;
		const i = wps.findIndex((w) => w.id === fromId);
		return i >= 0 && wps[i + 1]?.id === toId ? i : -1;
	};
	const latLngAt = (x: number, y: number): L.LatLng =>
		map.containerPointToLatLng(map.mouseEventToContainerPoint({ clientX: x, clientY: y } as MouseEvent));
	/** The ghost's disc: numbered for the place it will take, lifted, and
	 *  ringed like an anchored waypoint's while it lands on a feature. */
	const ghostIcon = (): L.DivIcon => {
		const wp: Waypoint = { id: '', lat: 0, lon: 0, kind: landing?.kind ?? 'free', alt: 0, altAuto: true };
		return waypointIcon(wp, legIndex() + 1, activeRoute().waypoints.length + 1, false, true);
	};

	function start(): void {
		started = true;
		suppressSync = true;
		L.DomUtil.addClass(document.body, DRAGGING_CLASS);
		map.getContainer().style.cursor = 'grabbing';
		// The pins after the new one take their new numbers now, as the drop
		// will give them.
		const visual = visualsByRouteId.get(routeId);
		const wps = activeRoute().waypoints;
		const i = legIndex();
		wps.forEach((wp, j) => {
			if (j > i) {
				const sel = wp.id === activeRoute().selectedWaypointId;
				const hl = wp.id === highlightedWaypointId;
				visual?.markers.get(wp.id)?.setIcon(waypointIcon(wp, j + 1, wps.length + 1, sel, hl));
			}
		});
		// The pointed-at leg's emphasis would stand on the straight leg the
		// drag is bending.
		if (highlightedLegFromId === fromId) {
			legCasing?.setLatLngs([]);
			legLine?.setLatLngs([]);
		}
		closeContextMenu();
		map.fire(ROUTE_DRAG_START);
	}

	/** The ghost, the rubber band and the tip where the pointer (x, y) lands. */
	function place(x: number, y: number): void {
		const i = legIndex();
		const visual = visualsByRouteId.get(routeId);
		if (!ghost || i < 0 || !visual) {
			return;
		}
		last = { x, y };
		const raw = latLngAt(x, y);
		const was = landing?.kind ?? 'free';
		landing = snapLatLng(raw.lat, raw.lng);
		at = landing ? L.latLng(landing.lat, landing.lon) : raw;
		if ((landing?.kind ?? 'free') !== was) {
			ghost.setIcon(ghostIcon());
		}
		ghost.setLatLng(at);
		const line = activeRoute().waypoints.map((w) => [w.lat, w.lon] as L.LatLngTuple);
		line.splice(i + 1, 0, [at.lat, at.lng]);
		setVisualLatLngs(visual, line);
		const p = map.latLngToContainerPoint(at);
		setPinLanding({ x: p.x, y: p.y, lat: at.lat, lon: at.lng, snap: landing, finger });
	}

	/** Pan while the pointer rests in the band along the map's edge, placing
	 *  the ghost again each frame: the ground moves under a still pointer. */
	function edgePan(): void {
		if (panFrame || ended || !last) {
			return;
		}
		const push = (v: number, size: number): number => {
			const d = v < CARRY_PAN_PAD_PX ? v - CARRY_PAN_PAD_PX : v > size - CARRY_PAN_PAD_PX ? v - (size - CARRY_PAN_PAD_PX) : 0;
			const f = Math.max(-1, Math.min(1, d / CARRY_PAN_PAD_PX));
			return f === 0 ? 0 : Math.sign(f) * Math.max(1, Math.round(Math.abs(f) * CARRY_PAN_SPEED_PX));
		};
		const step = (): void => {
			panFrame = 0;
			if (ended || !last) {
				return;
			}
			const p = map.mouseEventToContainerPoint({ clientX: last.x, clientY: last.y } as MouseEvent);
			const size = map.getSize();
			const dx = push(p.x, size.x);
			const dy = push(p.y, size.y);
			if (dx === 0 && dy === 0) {
				return;
			}
			map.panBy([dx, dy], { animate: false });
			place(last.x, last.y);
			panFrame = L.Util.requestAnimFrame(step);
		};
		panFrame = L.Util.requestAnimFrame(step);
	}

	function teardown(): void {
		ended = true;
		carryAbort = null;
		if (panFrame) {
			L.Util.cancelAnimFrame(panFrame);
			panFrame = 0;
		}
		ghost?.remove();
		ghost = null;
		if (!started) {
			return;
		}
		// Released before any state write, so the sync that write asks for runs.
		suppressSync = false;
		L.DomUtil.removeClass(document.body, DRAGGING_CLASS);
		map.getContainer().style.cursor = '';
		setPinLanding(null);
		map.fire(ROUTE_DRAG_END);
	}

	/** The line, the pins and the pointed-at leg back from the state. */
	function resync(): void {
		syncRoutes(map, routes.list, routes.activeId);
		if (highlightedLegFromId) {
			highlightLeg(highlightedLegFromId);
		}
	}

	const carry: Carry = {
		prime(x, y) {
			if (ended || ghost || carryAbort || locked || suppressSync || legIndex() < 0) {
				return false;
			}
			ghost = L.marker(latLngAt(x, y), {
				icon: ghostIcon(),
				interactive: false,
				keyboard: false,
				pane: 'route-markers',
			}).addTo(map);
			carryAbort = () => carry.cancel();
			return true;
		},
		move(x, y) {
			if (ended || !ghost) {
				return;
			}
			if (!started) {
				start();
			}
			place(x, y);
			edgePan();
		},
		commit() {
			if (ended) {
				return;
			}
			const i = legIndex();
			const land = landing;
			const pos = at;
			const moved = started;
			teardown();
			if (i < 0 || !pos) {
				// Released before it moved, or the leg went under the drag:
				// nothing to put down, and the line back to the state's.
				if (moved) {
					resync();
				}
				return;
			}
			const wp = offerUndoFor('inserted', () =>
				insertWaypointAfter(i, land ?? { lat: pos.lat, lon: pos.lng, kind: 'free' }),
			);
			selectWaypoint(wp.id);
			// The drop's trailing click must not select the feature under it
			// (see lastDragEndAt).
			lastDragEndAt = performance.now();
			if (highlightedLegFromId) {
				highlightLeg(highlightedLegFromId);
			}
		},
		cancel() {
			if (ended) {
				return;
			}
			const moved = started;
			teardown();
			if (moved) {
				resync();
			}
		},
	};
	return carry;
}

/** The leg a finger's long press at (clientX, clientY) would carry out into
 *  a waypoint, as touchPress.ts asks at the press; null for none. */
export function legCarryAt(clientX: number, clientY: number): Carry | null {
	const m = mapState.map;
	if (!m || locked || suppressSync) {
		return null;
	}
	const ll = m.containerPointToLatLng(m.mouseEventToContainerPoint({ clientX, clientY } as MouseEvent));
	const index = routeLegInsertAt(m, ll.lat, ll.lng);
	return index === null ? null : legCarry(index, true);
}

/** A mouse press at (lat, lon) would drag a leg out: the grab cursor over
 *  the line (MapView's hover), the press's own test. */
export function legGrabAt(lat: number, lon: number): boolean {
	const m = mapState.map;
	return m !== null && !locked && !suppressSync && routeLegInsertAt(m, lat, lon, LEG_HOVER_TOLERANCE_PX) !== null;
}

/** What a pointer press tells armLegDrag, a PointerEvent's fields. */
export interface LegPointer {
	pointerType: string;
	button: number;
	shiftKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	clientX: number;
	clientY: number;
	target: EventTarget | null;
}

/** A mouse press on a leg, from the press to its release. */
export interface LegPress {
	move(clientX: number, clientY: number): void;
	/** Released: an insert if the press carried, nothing if it did not. */
	up(): void;
	cancel(): void;
}

/** A press on a marker or a map control is theirs. Duck-typed, so the specs
 *  can hand a stand-in. */
function onMarkerOrControl(target: EventTarget | null): boolean {
	const t = target as unknown as { closest?: (selector: string) => Element | null } | null;
	return typeof t?.closest === 'function' && t.closest('.leaflet-marker-icon, .leaflet-control') !== null;
}

/** A pointer press on the map: a leg's carry for the left button of a MOUSE
 *  on a leg of the active route (the hover's reach, within 10 px), else null
 *  and the press is the map's. Such a press never pans: the map's Draggable
 *  listens for the mousedown this pointerdown comes before, and a listener
 *  removed now is not called for it. Past MOUSE_CARRY_PX the carry takes the
 *  line; released before, it was a click and changes nothing. */
export function legPressDown(e: LegPointer): LegPress | null {
	const m = mapState.map;
	if (
		!m ||
		e.pointerType !== 'mouse' ||
		e.button !== 0 ||
		e.shiftKey ||
		e.ctrlKey ||
		e.metaKey ||
		e.altKey ||
		locked ||
		suppressSync ||
		onMarkerOrControl(e.target)
	) {
		return null;
	}
	const ll = m.containerPointToLatLng(m.mouseEventToContainerPoint(e as unknown as MouseEvent));
	const index = routeLegInsertAt(m, ll.lat, ll.lng, LEG_HOVER_TOLERANCE_PX);
	const carry = index === null ? null : legCarry(index, false);
	if (!carry) {
		return null;
	}
	const map = m;
	const panning = map.dragging.enabled();
	if (panning) {
		map.dragging.disable();
	}
	L.DomUtil.disableTextSelection();
	L.DomUtil.disableImageDrag();
	const x0 = e.clientX;
	const y0 = e.clientY;
	let primed = false;
	let over = false;
	const finish = (): void => {
		over = true;
		if (panning) {
			map.dragging.enable();
		}
		L.DomUtil.enableTextSelection();
		L.DomUtil.enableImageDrag();
	};
	return {
		move(x, y) {
			if (over) {
				return;
			}
			if (!primed) {
				if (Math.hypot(x - x0, y - y0) < MOUSE_CARRY_PX) {
					return;
				}
				primed = carry.prime(x0, y0);
				if (!primed) {
					return;
				}
			}
			carry.move(x, y);
		},
		up() {
			if (over) {
				return;
			}
			finish();
			if (primed) {
				carry.commit();
			} else {
				carry.cancel();
			}
		},
		cancel() {
			if (over) {
				return;
			}
			finish();
			carry.cancel();
		},
	};
}

/** Arm the mouse's leg drag on the map, right after L.map() (the touch half
 *  rides map/touchPress.ts). The press is watched on the container, its
 *  moves, its release and Escape (which cancels it) on the window. Returns
 *  the disarm. */
export function armLegDrag(m: L.Map): () => void {
	const container = m.getContainer();
	const capture = { capture: true };
	let press: LegPress | null = null;
	const unlisten = (): void => {
		window.removeEventListener('pointermove', onMove, capture);
		window.removeEventListener('pointerup', onEnd, capture);
		window.removeEventListener('pointercancel', onEnd, capture);
		window.removeEventListener('keydown', onKey, capture);
	};
	const takePress = (): LegPress | null => {
		const p = press;
		press = null;
		unlisten();
		return p;
	};
	const onMove = (e: PointerEvent): void => {
		press?.move(e.clientX, e.clientY);
	};
	const onEnd = (e: PointerEvent): void => {
		const p = takePress();
		if (e.type === 'pointerup') {
			p?.up();
		} else {
			p?.cancel();
		}
	};
	const onKey = (e: KeyboardEvent): void => {
		if (e.key !== 'Escape' || !press) {
			return;
		}
		// The drag's own: no surface or menu closes on this Escape.
		e.stopPropagation();
		e.preventDefault();
		takePress()?.cancel();
	};
	const onDown = (e: PointerEvent): void => {
		takePress()?.cancel();
		press = legPressDown(e);
		if (press) {
			window.addEventListener('pointermove', onMove, capture);
			window.addEventListener('pointerup', onEnd, capture);
			window.addEventListener('pointercancel', onEnd, capture);
			window.addEventListener('keydown', onKey, capture);
		}
	};
	container.addEventListener('pointerdown', onDown, capture);
	return () => {
		container.removeEventListener('pointerdown', onDown, capture);
		takePress()?.cancel();
	};
}

/* The live progress overlay (flown grey / heavy active leg) lives in
   routeProgressLayer.ts on its own pane (z 456). */

/** Detach the route overlay and drop refs (HMR / unmount teardown). State is
 *  session-scoped and rebuilds via syncRoutes on remount. */
export function clearRouteLayer(m: L.Map): void {
	carryAbort?.();
	// The next view applies the lock afresh (MapView's effect).
	armedPressOff?.();
	armedPressOff = null;
	locked = false;
	movingId = null;
	if (group && m.hasLayer(group)) {
		m.removeLayer(group);
	}
	for (const visual of visualsByRouteId.values()) {
		visual.polyline.off();
		for (const marker of visual.markers.values()) {
			marker.off();
		}
	}
	visualsByRouteId.clear();
	group = null;
	suppressSync = false;
	highlightedWaypointId = null;
	legCasing?.remove();
	legLine?.remove();
	legCasing = null;
	legLine = null;
	highlightedLegFromId = null;
	setPinLanding(null);
}
