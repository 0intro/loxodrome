/* routeLayer.ts: the flight-route overlay, one coloured polyline per route plus
 * one draggable L.marker per waypoint on the ACTIVE route. Reverse-synced from
 * the routes $state via a keyed diff (per route). The diff, a suppressSync flag,
 * and writing state only on dragend keep the state-driven rebuild from fighting a
 * live drag (see syncRoutes / wireMarker).
 *
 * Only the active route carries draggable pins and accepts leg-inserts; an
 * inactive route draws a thinner, lower-opacity line (over the same white casing)
 * and a click on it activates the route. Markers only ever exist for the active
 * route, so every waypoint mutator
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
 * heavy here, and a segment under the pointer marks its row there. */

import L from 'leaflet';
import { navaidFreqLabel } from '$lib/data/navaids';
import { equirectangularDistanceM } from '$lib/notam/geometry';
import { routeColorMap } from '$lib/route/routeColors';
import { mapState } from '$lib/state/map.svelte';
import {
	activeRoute,
	insertWaypointAfter,
	moveWaypoint,
	routes,
	routeSettings,
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
import { waypointIcon } from './routeIcons';

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
// leaks to the map and onMapClick would append a waypoint on the drop target.
// onMapClick ignores a click within this window after a drag (see isPostDragClick).
// Plain module var, intentionally not reactive.
let lastDragEndAt = -Infinity;
const POST_DRAG_CLICK_MS = 250;
// The waypoint a list is currently pointing at (highlightWaypoint), read by
// syncActiveMarkers so any route sync re-applies it. Plain module var, the
// highlightAirspace idiom, intentionally not reactive.
let highlightedWaypointId: string | null = null;
// The pointed-at leg's two lines (see highlightLeg), added straight to the map
// like the progress overlay's rather than to the route group: they belong to no
// route's visual and are torn down by name.
let legCasing: L.Polyline | null = null;
let legLine: L.Polyline | null = null;

/** True when a map click is the synthetic tail of a just-ended waypoint drag, so
 *  the add-waypoint handler should ignore it (dragend already moved the pin). */
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
	marker.on('dragstart', () => {
		suppressSync = true;
		selectWaypoint(id);
	});
	marker.on('drag', () => {
		updatePolylineDuringDrag(id, marker.getLatLng());
	});
	marker.on('dragend', () => {
		const ll = marker.getLatLng();
		// Exclude this waypoint so the drop can't snap back onto its own old spot.
		const snap = snapLatLng(ll.lat, ll.lng, id);
		// Release before writing state so the resulting syncRoutes runs; the
		// marker is already where state will be, so the diff is a no-op (or a
		// single setLatLng when snapping relocates it onto a feature or waypoint).
		suppressSync = false;
		if (snap) {
			setWaypointFromSnap(id, snap);
		} else {
			moveWaypoint(id, ll.lat, ll.lng);
		}
		// Stamp the drop so the trailing synthetic map click is ignored (see
		// lastDragEndAt): without this a drag onto another pin both moves this
		// waypoint and adds a coincident one.
		lastDragEndAt = performance.now();
	});
	marker.on('click', (e: L.LeafletMouseEvent) => {
		// Don't let the click reach the map (which, in edit mode, would add a
		// new waypoint); just select this one.
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
	setVisualLatLngs(
		visual,
		wps.map(
			(w) => (w.id === id ? [live.lat, live.lng] : [w.lat, w.lon]) as L.LatLngTuple,
		),
	);
}

/** A click on a route line: activate an inactive route, else (active route, edit
 *  mode) insert a waypoint on the nearest leg. */
function onRoutePolylineClick(e: L.LeafletMouseEvent, routeId: string): void {
	// Ignore the synthetic click a waypoint drag leaves behind (see
	// isPostDragClick), else dropping a pin onto the route line would insert one.
	if (isPostDragClick()) {
		return;
	}
	if (routeId !== routes.activeId) {
		L.DomEvent.stopPropagation(e);
		setActiveRoute(routeId);
		return;
	}
	onLegClick(e);
}

/** The leg of `wps` nearest the layer point `p`, as its index (the leg leaving
 *  waypoint i) and its pixel distance. Null on a route with no leg. Shared by
 *  the click that inserts a waypoint and the hover that points at a leg, so the
 *  two can never disagree about which segment the pointer is on. */
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

/** Insert a waypoint on the clicked leg of the active route (edit mode only). */
function onLegClick(e: L.LeafletMouseEvent): void {
	L.DomEvent.stopPropagation(e);
	const m = mapState.map;
	if (!routeSettings.editMode || !m) {
		return;
	}
	const near = nearestLeg(m, activeRoute().waypoints, m.latLngToLayerPoint(e.latlng));
	if (!near) {
		return;
	}
	const snap = snapLatLng(e.latlng.lat, e.latlng.lng);
	const wp = insertWaypointAfter(
		near.index,
		snap ?? { lat: e.latlng.lat, lon: e.latlng.lng, kind: 'free' },
	);
	selectWaypoint(wp.id);
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
		const icon = waypointIcon(wp, i, total, wp.id === selectedId, wp.id === highlightedWaypointId);
		const existing = markers.get(wp.id);
		if (!existing) {
			const marker = L.marker([wp.lat, wp.lon], {
				icon,
				draggable: true,
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
				wp.id === highlightedWaypointId,
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
		return;
	}
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

/* The live progress overlay (flown grey / heavy active leg) lives in
   routeProgressLayer.ts on its own pane (z 456). */

/** Detach the route overlay and drop refs (HMR / unmount teardown). State is
 *  session-scoped and rebuilds via syncRoutes on remount. */
export function clearRouteLayer(m: L.Map): void {
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
}
