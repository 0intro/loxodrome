/* A dragged waypoint pin shows where it will land (map/routeLayer.ts), on
 * Leaflet's own markers and lines in Node (tests/helpers/leafletNode.ts).
 *
 * The drop has always snapped onto an aerodrome, a navaid or a waypoint within
 * 12 px, but unseen until the release, under a finger that hides the pin. Now
 * the pin and the two legs it pulls sit ON the target while the pointer is in
 * range (the magnet), a tip names the landing (state/pinDrag.svelte.ts), and
 * the drop commits exactly the landing the last frame showed.
 *
 * The pointer is driven the way MarkerDrag drives it: every move sets the
 * marker's position from the pointer and fires 'drag', so a spec that moves
 * the pointer out of range after a snap would see a snap that stuck.
 *
 * A LEG dragged out into a new waypoint (legCarry) runs the same magnet, rubber
 * band and tip on a ghost pin; the pointer drives it in viewport pixels, which
 * the shim's container places at the origin, so they are container points. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Waypoint } from '$lib/state/route.svelte';
import { installLeafletNode } from './helpers/leafletNode';

const mapView = readFileSync('src/lib/components/MapView.svelte', 'utf8');

const env = installLeafletNode();
const L = (await import('leaflet')).default;

// One aerodrome in the ungated index snapLatLng asks, and no navaid.
const feature = vi.hoisted(() => {
	const lfpn = { ident: 'LFPN', name: 'Toussus-le-Noble', lat: 48.7519, lon: 2.1061 };
	const distM = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
		const x = (bLon - aLon) * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180) * 111_320;
		const y = (bLat - aLat) * 111_320;
		return Math.hypot(x, y);
	};
	return { lfpn, distM };
});

vi.mock('$lib/map/airportLayer', () => ({
	nearestAirportUngated: (lat: number, lon: number, radiusM: number) => {
		const { lfpn, distM } = feature;
		const d = distM(lat, lon, lfpn.lat, lfpn.lon);
		return d <= radiusM ? { airport: { ...lfpn }, distM: d } : null;
	},
}));
vi.mock('$lib/map/navaidLayer', () => ({ nearestNavaidUngated: () => null }));

const {
	syncRoutes,
	clearRouteLayer,
	highlightLeg,
	highlightWaypoint,
	isPostDragClick,
	legAt,
	legCarry,
	legCarryAt,
	legGrabAt,
	legPressDown,
	setRouteLock,
} = await import('$lib/map/routeLayer');
const { ROUTE_DRAG_END, ROUTE_DRAG_START } = await import('$lib/map/routeDragEvents');
const { mapState } = await import('$lib/state/map.svelte');
const { pinDrag } = await import('$lib/state/pinDrag.svelte');
const { contextMenu, openContextMenu } = await import('$lib/state/contextMenu.svelte');
const undo = await import('$lib/state/undoChip.svelte');
const { landingLines } = await import('$lib/route/format');
const { formatGarminCoord } = await import('$lib/route/coordToken');
const route = await import('$lib/state/route.svelte');

let map: L.Map;

/** The route A, B, C, drawn; B is the pin the specs drag. */
function mount(): { a: string; b: string; c: string } {
	map = L.map(env.container(800, 600) as unknown as HTMLElement, {
		zoomControl: false,
		attributionControl: false,
		zoomAnimation: false,
		fadeAnimation: false,
		markerZoomAnimation: false,
		trackResize: false,
		// Node has no SVG: the route lines take a canvas instead.
		preferCanvas: true,
	}).setView([48.75, 2.2], 11);
	mapState.map = map;
	route.clearAllRoutes();
	const a = route.addWaypoint(48.8, 2.0).id;
	const b = route.addWaypoint(48.7, 2.3).id;
	const c = route.addWaypoint(48.85, 2.4).id;
	sync();
	return { a, b, c };
}

function sync(): void {
	syncRoutes(map, route.routes.list, route.routes.activeId);
}

function waypoint(id: string): Waypoint {
	const w = route.activeRoute().waypoints.find((x) => x.id === id);
	if (!w) {
		throw new Error(`no waypoint ${id}`);
	}
	return w;
}

/** The pin drawn for a waypoint. */
function pinOf(id: string): L.Marker {
	const w = waypoint(id);
	let found: L.Marker | null = null;
	map.eachLayer((layer) => {
		if (layer instanceof L.Marker) {
			const at = layer.getLatLng();
			if (at.lat === w.lat && at.lng === w.lon) {
				found = layer;
			}
		}
	});
	if (!found) {
		throw new Error(`no pin for ${id}`);
	}
	return found;
}

/** The point `dx`, `dy` pixels from a position, at the current view. */
function offset(lat: number, lon: number, dx: number, dy: number): L.LatLng {
	const p = map.latLngToContainerPoint([lat, lon]);
	return map.containerPointToLatLng([p.x + dx, p.y + dy]);
}

/** One move of the pointer, as MarkerDrag makes it. */
function moveTo(pin: L.Marker, at: L.LatLng): void {
	pin.setLatLng(at);
	pin.fire('drag');
}

/** The active route's coloured line: the one in pane 'route' through the three waypoints. */
function routeLine(): L.Polyline {
	let found: L.Polyline | null = null;
	map.eachLayer((layer) => {
		if (layer instanceof L.Polyline && layer.options.pane === 'route' && (layer.getLatLngs() as L.LatLng[]).length === 3) {
			found = layer;
		}
	});
	if (!found) {
		throw new Error('no route line');
	}
	return found;
}

/** The pointed-at leg's line (pane 'route-leg', the 6 px one over its casing). */
function lineIn(pane: string, weight: number): L.Polyline {
	let found: L.Polyline | null = null;
	map.eachLayer((layer) => {
		if (layer instanceof L.Polyline && layer.options.pane === pane && layer.options.weight === weight) {
			found = layer;
		}
	});
	if (!found) {
		throw new Error(`no line in ${pane}`);
	}
	return found;
}

const lfpn = feature.lfpn;

describe('a dragged waypoint pin', () => {
	beforeEach(() => {
		vi.spyOn(performance, 'now').mockReturnValue(1_000_000);
	});

	afterEach(() => {
		clearRouteLayer(map);
		map.remove();
		mapState.map = null;
		route.clearAllRoutes();
		vi.restoreAllMocks();
	});

	it('sits on an aerodrome in range, pulling its legs there, and follows the pointer out of range', () => {
		const { b } = mount();
		const pin = pinOf(b);
		pin.fire('dragstart');
		moveTo(pin, offset(lfpn.lat, lfpn.lon, 8, 0));
		expect(pin.getLatLng()).toEqual(L.latLng(lfpn.lat, lfpn.lon));
		const line = routeLine().getLatLngs() as L.LatLng[];
		expect(line[1]).toEqual(L.latLng(lfpn.lat, lfpn.lon));
		expect(pinDrag.landing?.snap?.ident).toBe('LFPN');
		// The tip stands on the landing, not on the pointer.
		const onTarget = map.latLngToContainerPoint([lfpn.lat, lfpn.lon]);
		expect([pinDrag.landing?.lat, pinDrag.landing?.lon]).toEqual([lfpn.lat, lfpn.lon]);
		expect([pinDrag.landing?.x, pinDrag.landing?.y]).toEqual([onTarget.x, onTarget.y]);
		// Out of range: the next move starts again from the pointer.
		const away = offset(lfpn.lat, lfpn.lon, 40, 0);
		moveTo(pin, away);
		expect(pin.getLatLng()).toEqual(away);
		expect(pinDrag.landing?.snap).toBeNull();
		expect(pinDrag.landing?.lat).toBe(away.lat);
	});

	it('drops where it showed, and the tip goes with the drop', () => {
		const { b } = mount();
		const pin = pinOf(b);
		pin.fire('dragstart');
		moveTo(pin, offset(lfpn.lat, lfpn.lon, -6, 5));
		pin.fire('dragend');
		const w = waypoint(b);
		expect([w.kind, w.refId, w.lat, w.lon]).toEqual(['airport', 'LFPN', lfpn.lat, lfpn.lon]);
		expect(pinDrag.landing).toBeNull();
		expect(isPostDragClick()).toBe(true);
	});

	it('commits the snap the tip showed, not a second guess from the target', () => {
		// A waypoint 10 px east of the aerodrome, the pointer 10 px west of
		// it: the pointer is in range of the aerodrome only, but the
		// aerodrome is in range of the waypoint, which snapLatLng ranks first.
		const { b } = mount();
		const w = offset(lfpn.lat, lfpn.lon, 10, 0);
		const d = route.addWaypoint(w.lat, w.lng).id;
		sync();
		const pin = pinOf(b);
		pin.fire('dragstart');
		moveTo(pin, offset(lfpn.lat, lfpn.lon, -10, 0));
		expect(pinDrag.landing?.snap?.ident).toBe('LFPN');
		pin.fire('dragend');
		expect(waypoint(b).refId).toBe('LFPN');
		expect(waypoint(d).kind).toBe('free');
	});

	it('snaps from where the marker stands when no drag frame ran', () => {
		const { b } = mount();
		const pin = pinOf(b);
		pin.fire('dragstart');
		pin.setLatLng(offset(lfpn.lat, lfpn.lon, 5, 5));
		pin.fire('dragend');
		expect(waypoint(b).refId).toBe('LFPN');
	});

	it('forgets the last drag\'s landing when a new one begins', () => {
		const { b } = mount();
		const pin = pinOf(b);
		pin.fire('dragstart');
		moveTo(pin, offset(lfpn.lat, lfpn.lon, 4, 0));
		pin.fire('dragend');
		expect(waypoint(b).refId).toBe('LFPN');
		// A second drag the platform ends before any frame: it lands where
		// the marker stands, never on the first drag's target.
		const away = offset(lfpn.lat, lfpn.lon, 250, 0);
		pin.fire('dragstart');
		pin.setLatLng(away);
		pin.fire('dragend');
		expect([waypoint(b).kind, waypoint(b).lat, waypoint(b).lon]).toEqual(['free', away.lat, away.lng]);
	});

	it('keeps a free point its own name, and says so while it moves', () => {
		const { b } = mount();
		route.setWaypointName(b, 'Château');
		const pin = pinOf(b);
		pin.fire('dragstart');
		const away = offset(lfpn.lat, lfpn.lon, 200, 120);
		moveTo(pin, away);
		expect(pinDrag.landing?.keptLabel).toBe('Château');
		expect(pinDrag.landing?.finger, 'a mouse, no finger held').toBe(false);
		pin.fire('dragend');
		const w = waypoint(b);
		expect([w.kind, w.label, w.lat, w.lon]).toEqual(['free', 'Château', away.lat, away.lng]);
	});

	it('drops an anchored waypoint\'s name with its anchor on free ground', () => {
		// moveWaypoint un-anchors it: the row then reads "Custom point", and
		// so must the tip.
		const { b } = mount();
		const pin = pinOf(b);
		pin.fire('dragstart');
		moveTo(pin, offset(lfpn.lat, lfpn.lon, 3, 3));
		pin.fire('dragend');
		expect(waypoint(b).label).toBe('Toussus-le-Noble');
		sync();
		const again = pinOf(b);
		again.fire('dragstart');
		moveTo(again, offset(lfpn.lat, lfpn.lon, 300, 200));
		expect(pinDrag.landing?.snap).toBeNull();
		expect(pinDrag.landing?.keptLabel).toBeUndefined();
		again.fire('dragend');
		expect([waypoint(b).kind, waypoint(b).label]).toEqual(['free', undefined]);
	});

	it('closes the map menu when the drag begins', () => {
		const { b } = mount();
		openContextMenu(
			{ notams: [], stations: [], radar: null, airports: [], navaids: [], airspaces: [], obstacles: [], supaips: [], sigmets: [], charts: [], waypoints: [], leg: null },
			48.7,
			2.3,
			0,
			0,
		);
		expect(contextMenu.open).toBe(true);
		pinOf(b).fire('dragstart');
		expect(contextMenu.open).toBe(false);
	});

	it('pulls the pointed-at leg along when it is one of its two', () => {
		const { a, b } = mount();
		highlightLeg(a);
		const pin = pinOf(b);
		pin.fire('dragstart');
		const away = offset(lfpn.lat, lfpn.lon, 150, -90);
		moveTo(pin, away);
		const leg = lineIn('route-leg', 6).getLatLngs() as L.LatLng[];
		expect(leg[0]).toEqual(L.latLng(waypoint(a).lat, waypoint(a).lon));
		expect(leg[1]).toEqual(away);
	});

	it('offers the drop back: the chip names it, and its Undo puts the waypoint where it was', () => {
		const { b } = mount();
		const before = { ...waypoint(b) };
		const pin = pinOf(b);
		pin.fire('dragstart');
		moveTo(pin, offset(lfpn.lat, lfpn.lon, 2, -3));
		pin.fire('dragend');
		expect(undo.undoChip.kind).toBe('moved');
		expect(undo.undoChipShown()).toBe(true);
		undo.takeUndo();
		const w = waypoint(b);
		expect([w.kind, w.lat, w.lon]).toEqual([before.kind, before.lat, before.lon]);
		expect(undo.undoChipShown()).toBe(false);
		undo.resetUndoChipForTest();
	});

	it('takes the tip down with the layer', () => {
		const { b } = mount();
		const pin = pinOf(b);
		pin.fire('dragstart');
		moveTo(pin, offset(lfpn.lat, lfpn.lon, 100, 100));
		expect(pinDrag.landing).not.toBeNull();
		clearRouteLayer(map);
		expect(pinDrag.landing).toBeNull();
	});
});

describe('the tip\'s two lines', () => {
	const words = { customPoint: 'Custom point' };

	it('name an aerodrome or a navaid by ident over name, as the Route tab row does', () => {
		const snap = { lat: lfpn.lat, lon: lfpn.lon, kind: 'airport' as const, refId: 'LFPN', ident: 'LFPN', label: 'Toussus-le-Noble' };
		expect(landingLines({ lat: 0, lon: 0, snap }, words)).toEqual(['LFPN', 'Toussus-le-Noble']);
		const unnamed = { lat: 49, lon: 2, kind: 'navaid' as const, refId: 'PON', ident: 'PON' };
		expect(landingLines({ lat: 0, lon: 0, snap: unnamed }, words)).toEqual(['PON', null]);
	});

	it('name a free point by its name, else as a custom point, over its coordinates', () => {
		expect(landingLines({ lat: 48.7, lon: 2.3, snap: null }, words)).toEqual(['Custom point', formatGarminCoord(48.7, 2.3)]);
		expect(landingLines({ lat: 48.7, lon: 2.3, snap: null, keptLabel: 'Château' }, words)).toEqual([
			'Château',
			formatGarminCoord(48.7, 2.3),
		]);
		const onto = { lat: 48.9, lon: 2.1, kind: 'free' as const, label: 'Étang' };
		expect(landingLines({ lat: 0, lon: 0, snap: onto }, words)).toEqual(['Étang', formatGarminCoord(48.9, 2.1)]);
	});
});

describe('MapView draws the tip', () => {
	it('from the datum, with the Route tab\'s own word for a free point', () => {
		expect(mapView).toContain('lines: landingLines(landing, { customPoint: t.route.customPoint }),');
		expect(mapView).toMatch(/\{#if dragTip\}[\s\S]*class="drag-tip no-print"/);
	});

	it('higher for a finger, which hides the pin', () => {
		expect(mapView).toContain('const lift = landing.finger ? DRAG_TIP_LIFT_FINGER_PX : DRAG_TIP_LIFT_PX;');
		expect(mapView).toContain('style:--lift={`');
	});

	it('beside the pin once the room above runs under the in-flight band', () => {
		expect(mapView).toContain("mapWrap?.style.getPropertyValue('--nav-strip-h')");
		// The element the band publishes its height on (the foot's own height
		// rides the same element, as a style directive beside the binding).
		expect(mapView).toContain('<div class="map-wrap" bind:this={mapWrap}');
	});

	it('with grab over a leg a press would carry, over the pointer a click would take', () => {
		expect(mapView).toContain("const cursor = legGrabAt(lat, lng) ? 'grab' : clickable ? 'pointer' : '';");
	});

	it('alone: the wind tip stands down while a pin is dragged, and a zoom takes the tip down', () => {
		expect(mapView).toContain('const windTipLines = $derived(windTip && !pinDrag.landing ? tipLines(windTip) : []);');
		expect(mapView).toContain("map.on('zoomstart', onDragTipZoom);");
		expect(mapView).toContain("map?.off('zoomstart', onDragTipZoom);");
	});
});

/** The active route's coloured line, however many points it has now. */
function activeLine(): L.LatLng[] {
	let found: L.LatLng[] | null = null;
	map.eachLayer((layer) => {
		if (layer instanceof L.Polyline && layer.options.pane === 'route' && layer.options.weight === 4) {
			found = layer.getLatLngs() as L.LatLng[];
		}
	});
	if (!found) {
		throw new Error('no active route line');
	}
	return found;
}

/** The ghost pin a carried leg shows: the one marker nobody can press. */
function ghostPin(): L.Marker | null {
	let found: L.Marker | null = null;
	map.eachLayer((layer) => {
		if (layer instanceof L.Marker && layer.options.pane === 'route-markers' && layer.options.interactive === false) {
			found = layer;
		}
	});
	return found;
}

/** The number a pin's disc shows. */
function labelOf(marker: L.Marker): string {
	const html = (marker.options.icon as L.DivIcon).options.html;
	return typeof html === 'string' ? (/">(\d+)<\/text>/.exec(html)?.[1] ?? '') : '';
}

/** A waypoint's pin in container pixels. */
function at(id: string): L.Point {
	const w = waypoint(id);
	return map.latLngToContainerPoint([w.lat, w.lon]);
}

/** The middle of the leg between two waypoints, in container pixels. */
function mid(from: string, to: string): L.Point {
	const p = at(from);
	const q = at(to);
	return L.point((p.x + q.x) / 2, (p.y + q.y) / 2);
}

function bodyDragging(): boolean {
	return L.DomUtil.hasClass(document.body, 'leaflet-dragging');
}

/** A mouse's pointer press, as armLegDrag hands it over. */
function mouse(p: L.Point, over: Partial<Parameters<typeof legPressDown>[0]> = {}): Parameters<typeof legPressDown>[0] {
	return {
		pointerType: 'mouse',
		button: 0,
		shiftKey: false,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		clientX: p.x,
		clientY: p.y,
		target: null,
		...over,
	};
}

describe('a leg dragged out into a new waypoint', () => {
	beforeEach(() => {
		vi.spyOn(performance, 'now').mockReturnValue(2_000_000);
	});

	afterEach(() => {
		clearRouteLayer(map);
		map.remove();
		mapState.map = null;
		route.clearAllRoutes();
		undo.resetUndoChipForTest();
		vi.restoreAllMocks();
	});

	it('lifts a ghost where the press is, pulls the line to the aerodrome in range, and drops it there', () => {
		const { a, b, c } = mount();
		const m = mid(a, b);
		const carry = legCarryAt(m.x, m.y);
		expect(carry).not.toBeNull();
		expect(carry!.prime(m.x, m.y)).toBe(true);
		const ghost = ghostPin();
		expect(ghost?.getLatLng()).toEqual(map.containerPointToLatLng(m));
		expect(labelOf(ghost!), 'numbered for the place it takes').toBe('2');
		expect((ghost!.options.icon as L.DivIcon).options.className, 'lifted').toContain('route-pin--hl');
		expect(routeLine().getLatLngs(), 'the line waits for the first move').toHaveLength(3);
		const onto = map.latLngToContainerPoint([lfpn.lat, lfpn.lon]);
		carry!.move(onto.x + 5, onto.y - 4);
		expect(ghost?.getLatLng()).toEqual(L.latLng(lfpn.lat, lfpn.lon));
		const line = activeLine();
		expect(line).toHaveLength(4);
		expect(line[1]).toEqual(L.latLng(lfpn.lat, lfpn.lon));
		expect(pinDrag.landing?.snap?.ident).toBe('LFPN');
		expect(pinDrag.landing?.finger, 'a finger\'s carry').toBe(true);
		expect([labelOf(pinOf(b)), labelOf(pinOf(c))], 'the pins after it renumbered').toEqual(['3', '4']);
		expect(bodyDragging()).toBe(true);
		carry!.commit();
		const wps = route.activeRoute().waypoints;
		expect(wps.map((w) => w.refId ?? w.id)).toEqual([waypoint(a).refId ?? a, 'LFPN', b, c]);
		expect(route.activeRoute().selectedWaypointId).toBe(wps[1].id);
		expect(undo.undoChip.kind).toBe('inserted');
		expect(undo.undoChipShown()).toBe(true);
		expect(isPostDragClick()).toBe(true);
		expect(ghostPin()).toBeNull();
		expect(pinDrag.landing).toBeNull();
		expect(bodyDragging()).toBe(false);
		expect(legAt(lfpn.lat, lfpn.lon + 0.0001), 'the line is the state\'s again').not.toBeNull();
	});

	it('leaves the magnet with the pointer, and inserts a free point where it showed', () => {
		const { a, b } = mount();
		const m = mid(a, b);
		const carry = legCarry(0, false)!;
		carry.prime(m.x, m.y);
		const onto = map.latLngToContainerPoint([lfpn.lat, lfpn.lon]);
		carry.move(onto.x + 3, onto.y);
		carry.move(m.x, m.y + 90);
		const free = map.containerPointToLatLng([m.x, m.y + 90]);
		expect(pinDrag.landing?.snap).toBeNull();
		expect(pinDrag.landing?.finger, 'a mouse\'s carry').toBe(false);
		carry.commit();
		const w = route.activeRoute().waypoints[1];
		expect([w.kind, w.lat, w.lon]).toEqual(['free', free.lat, free.lng]);
	});

	it('puts the line, the numbers and the leg emphasis back on a cancel', () => {
		const { a, b, c } = mount();
		highlightLeg(a);
		const m = mid(a, b);
		const carry = legCarry(0, false)!;
		carry.prime(m.x, m.y);
		carry.move(m.x + 40, m.y + 60);
		expect(lineIn('route-leg', 6).getLatLngs(), 'the straight leg is not shown under the bend').toEqual([]);
		carry.cancel();
		expect(route.activeRoute().waypoints).toHaveLength(3);
		expect(routeLine().getLatLngs()).toHaveLength(3);
		expect([labelOf(pinOf(b)), labelOf(pinOf(c))]).toEqual(['2', '3']);
		expect((lineIn('route-leg', 6).getLatLngs() as L.LatLng[]).map((p) => [p.lat, p.lng])).toEqual([
			[waypoint(a).lat, waypoint(a).lon],
			[waypoint(b).lat, waypoint(b).lon],
		]);
		expect([ghostPin(), pinDrag.landing, bodyDragging(), undo.undoChip.kind]).toEqual([null, null, false, null]);
	});

	it('inserts nothing when released before it moved', () => {
		const { a, b } = mount();
		const m = mid(a, b);
		const carry = legCarry(0, true)!;
		carry.prime(m.x, m.y);
		carry.commit();
		expect(route.activeRoute().waypoints).toHaveLength(3);
		expect(ghostPin()).toBeNull();
		expect(undo.undoChip.kind).toBeNull();
	});

	it('announces itself on the map for follow mode, as a pin drag does', () => {
		const { a, b } = mount();
		const heard: string[] = [];
		map.on(ROUTE_DRAG_START, () => heard.push('start'));
		map.on(ROUTE_DRAG_END, () => heard.push('end'));
		const m = mid(a, b);
		const carry = legCarry(0, false)!;
		carry.prime(m.x, m.y);
		expect(heard, 'a held press is no drag yet').toEqual([]);
		carry.move(m.x + 30, m.y + 30);
		carry.move(m.x + 40, m.y + 30);
		carry.commit();
		expect(heard).toEqual(['start', 'end']);
		const pin = pinOf(b);
		pin.fire('dragstart');
		moveTo(pin, offset(lfpn.lat, lfpn.lon, 200, 100));
		pin.fire('dragend');
		expect(heard).toEqual(['start', 'end', 'start', 'end']);
	});

	it('is one at a time, never off a pin, and never while a pin drag owns the line', () => {
		const { a, b } = mount();
		const m = mid(a, b);
		expect(legCarryAt(at(a).x + 3, at(a).y), 'on a pin').toBeNull();
		expect(legCarryAt(m.x, m.y + 120), 'off the legs').toBeNull();
		const pin = pinOf(b);
		pin.fire('dragstart');
		expect(legCarryAt(m.x, m.y), 'under a pin drag').toBeNull();
		pin.fire('dragend');
		const first = legCarryAt(m.x, m.y)!;
		const early = legCarryAt(m.x, m.y)!;
		expect(first.prime(m.x, m.y)).toBe(true);
		expect(legCarryAt(m.x, m.y), 'a second carry').toBeNull();
		expect(early.prime(m.x, m.y), 'one asked for before the first primed').toBe(false);
		first.cancel();
		expect(legCarryAt(m.x, m.y)).not.toBeNull();
	});

	it('reaches 12 px for a finger (the menu\'s Insert), 10 for the mouse (the hover)', () => {
		const { a, b } = mount();
		const p = at(a);
		const q = at(b);
		const m = mid(a, b);
		// 11 px off the leg, square to it.
		const len = Math.hypot(q.x - p.x, q.y - p.y);
		const off = L.point(m.x - ((q.y - p.y) / len) * 11, m.y + ((q.x - p.x) / len) * 11);
		const ll = map.containerPointToLatLng(off);
		expect(legCarryAt(off.x, off.y), 'a finger').not.toBeNull();
		expect(legGrabAt(ll.lat, ll.lng), 'the mouse').toBe(false);
		expect(legPressDown(mouse(off))).toBeNull();
	});

	it('gives the prime up when the leg has gone', () => {
		const { a, b } = mount();
		const m = mid(a, b);
		const carry = legCarry(0, true)!;
		route.removeWaypoint(b);
		expect(carry.prime(m.x, m.y)).toBe(false);
		expect(ghostPin()).toBeNull();
	});

	it('pans the map from the band along its edge, the ghost staying under the pointer', () => {
		const { a, b } = mount();
		const m = mid(a, b);
		const carry = legCarry(0, false)!;
		carry.prime(m.x, m.y);
		carry.move(795, m.y);
		const before = map.getCenter();
		env.runFrame();
		const after = map.getCenter();
		expect(after.lng, 'panned east').toBeGreaterThan(before.lng);
		expect(ghostPin()?.getLatLng()).toEqual(map.containerPointToLatLng([795, m.y]));
		carry.move(m.x, m.y);
		env.runFrame();
		expect(map.getCenter()).toEqual(after);
		carry.cancel();
	});

	it('goes with the layer', () => {
		const { a, b } = mount();
		const m = mid(a, b);
		const carry = legCarry(0, false)!;
		carry.prime(m.x, m.y);
		carry.move(m.x + 30, m.y + 30);
		clearRouteLayer(map);
		expect([ghostPin(), bodyDragging(), pinDrag.landing]).toEqual([null, false, null]);
	});
});

describe('a mouse press on a leg', () => {
	beforeEach(() => {
		vi.spyOn(performance, 'now').mockReturnValue(3_000_000);
	});

	afterEach(() => {
		clearRouteLayer(map);
		map.remove();
		mapState.map = null;
		route.clearAllRoutes();
		undo.resetUndoChipForTest();
		vi.restoreAllMocks();
	});

	it('never pans, and a click that wobbles changes nothing', () => {
		const { a, b } = mount();
		const m = mid(a, b);
		const press = legPressDown(mouse(m))!;
		expect(press).not.toBeNull();
		expect(map.dragging.enabled()).toBe(false);
		press.move(m.x + 2, m.y + 2);
		expect(ghostPin()).toBeNull();
		press.up();
		expect(map.dragging.enabled()).toBe(true);
		expect(route.activeRoute().waypoints).toHaveLength(3);
	});

	it('carries the leg once past 4 px, and the release inserts the landing', () => {
		const { a, b, c } = mount();
		const m = mid(a, b);
		const press = legPressDown(mouse(m))!;
		const onto = map.latLngToContainerPoint([lfpn.lat, lfpn.lon]);
		press.move(onto.x - 4, onto.y + 3);
		expect(ghostPin()?.getLatLng()).toEqual(L.latLng(lfpn.lat, lfpn.lon));
		expect(pinDrag.landing?.finger).toBe(false);
		press.up();
		expect(route.activeRoute().waypoints.map((w) => w.refId ?? w.id)).toEqual([waypoint(a).refId ?? a, 'LFPN', b, c]);
		expect(map.dragging.enabled()).toBe(true);
	});

	it('is cancelled whole (Escape), the map free to pan again', () => {
		const { a, b } = mount();
		const m = mid(a, b);
		const press = legPressDown(mouse(m))!;
		press.move(m.x + 50, m.y + 50);
		press.cancel();
		expect(route.activeRoute().waypoints).toHaveLength(3);
		expect([ghostPin(), map.dragging.enabled()]).toEqual([null, true]);
	});

	it('is the map\'s for anything but the left button of a mouse on a leg, clear of pins and controls', () => {
		const { a, b } = mount();
		const m = mid(a, b);
		const onMarker = { closest: (sel: string) => (sel.includes('.leaflet-marker-icon') ? {} : null) } as unknown as EventTarget;
		expect(legPressDown(mouse(m, { button: 2 })), 'right button').toBeNull();
		expect(legPressDown(mouse(m, { shiftKey: true })), 'a box zoom').toBeNull();
		expect(legPressDown(mouse(m, { ctrlKey: true })), 'a modifier').toBeNull();
		expect(legPressDown(mouse(m, { pointerType: 'touch' })), 'a finger').toBeNull();
		expect(legPressDown(mouse(m, { pointerType: 'pen' })), 'a pen').toBeNull();
		expect(legPressDown(mouse(m, { target: onMarker })), 'on a marker').toBeNull();
		expect(legPressDown(mouse(L.point(m.x, m.y + 60))), 'off the leg').toBeNull();
		expect(legPressDown(mouse(L.point(at(a).x + 2, at(a).y))), 'on a pin').toBeNull();
		expect(map.dragging.enabled()).toBe(true);
	});

	it('shows grab where it would carry', () => {
		const { a, b } = mount();
		const m = map.containerPointToLatLng(mid(a, b));
		expect(legGrabAt(m.lat, m.lng)).toBe(true);
		expect(legGrabAt(waypoint(a).lat, waypoint(a).lon), 'on a pin').toBe(false);
		const off = map.containerPointToLatLng(mid(a, b).add([0, 60]));
		expect(legGrabAt(off.lat, off.lng)).toBe(false);
		const carry = legCarry(0, false)!;
		carry.prime(0, 0);
		carry.move(10, 10);
		expect(legGrabAt(m.lat, m.lng), 'under a drag').toBe(false);
		carry.cancel();
	});
});

describe('follow mode under a route drag', () => {
	afterEach(() => {
		vi.useRealTimers();
		clearRouteLayer(map);
		map.remove();
		mapState.map = null;
		route.clearAllRoutes();
		undo.resetUndoChipForTest();
		vi.restoreAllMocks();
	});

	it('holds the map still while a pin or a leg is dragged, and re-arms after it as after a pan', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const nav = await import('$lib/map/navLayer');
		const { a, b } = mount();
		const fix = (lat: number, lon: number) => ({ lat, lon, altFt: 2000, trackDeg: 90, speedKt: 100 });
		const follow = (lon: number): void =>
			nav.syncNavAircraft(map, fix(48.75, lon), 'plane', true, 'good', 'Recentre');
		// Each fix jumps 0.6 degrees, wider than the 800 px map at zoom 11, so
		// Leaflet resets the view at once rather than animating over frames.
		const lng = (): string => map.getCenter().lng.toFixed(4);
		nav.setFollowAutoRearm(15_000);
		follow(2.2);
		follow(2.8);
		expect(lng(), 'follow pans').toBe('2.8000');
		// A leg carried: the next fix pans nothing.
		const m = mid(a, b);
		const carry = legCarry(0, false)!;
		carry.prime(m.x, m.y);
		carry.move(m.x + 30, m.y + 30);
		follow(3.4);
		expect(lng()).toBe('2.8000');
		carry.commit();
		follow(3.4);
		expect(lng(), 'still suspended until the re-arm').toBe('2.8000');
		vi.advanceTimersByTime(15_000);
		follow(3.4);
		expect(lng()).toBe('3.4000');
		// A pin dragged: the same.
		const pin = [...route.activeRoute().waypoints].map((w) => w.id).includes(b) ? pinOf(b) : null;
		expect(pin).not.toBeNull();
		pin!.fire('dragstart');
		follow(4.0);
		expect(lng()).toBe('3.4000');
		pin!.fire('dragend');
		vi.advanceTimersByTime(15_000);
		follow(4.0);
		expect(lng()).toBe('4.0000');
		nav.setFollowAutoRearm(0);
		nav.clearNavLayer(map);
	});
});

describe('the route locked on the map in flight', () => {
	const none = (): void => {};
	const draggable = (id: string): boolean | undefined => pinOf(id).dragging?.enabled();
	const liftedPin = (id: string): boolean =>
		String((pinOf(id).options.icon as L.DivIcon).options.className).includes('route-pin--hl');

	afterEach(() => {
		setRouteLock(false, null, none);
		clearRouteLayer(map);
		map.remove();
		mapState.map = null;
		route.clearAllRoutes();
		undo.resetUndoChipForTest();
		vi.restoreAllMocks();
	});

	it('takes every pin\'s drag, which a setIcon does not give back', () => {
		const { a, b, c } = mount();
		setRouteLock(true, null, none);
		for (const id of [a, b, c]) {
			expect(draggable(id), id).toBe(false);
			expect(L.DomUtil.hasClass(pinOf(id).getElement()!, 'leaflet-marker-draggable'), id).toBe(false);
		}
		highlightWaypoint(b);
		expect(draggable(b), 'after a setIcon').toBe(false);
		highlightWaypoint(null);
		sync();
		expect(draggable(b), 'after a sync').toBe(false);
	});

	it('draws a pin added in flight locked too', () => {
		mount();
		setRouteLock(true, null, none);
		const d = route.addWaypoint(48.9, 2.5).id;
		sync();
		expect(draggable(d)).toBe(false);
	});

	it('carries no leg and grabs nothing: a press on the line is the map\'s', () => {
		const { a, b } = mount();
		setRouteLock(true, null, none);
		const m = mid(a, b);
		const ll = map.containerPointToLatLng(m);
		expect(legCarryAt(m.x, m.y)).toBeNull();
		expect(legCarry(0, true)).toBeNull();
		expect(legGrabAt(ll.lat, ll.lng)).toBe(false);
		expect(legPressDown(mouse(m))).toBeNull();
		expect(map.dragging.enabled()).toBe(true);
	});

	it('lets no carry asked for before the lock prime after it', () => {
		const { a, b } = mount();
		const m = mid(a, b);
		const carry = legCarry(0, true)!;
		setRouteLock(true, null, none);
		expect(carry.prime(m.x, m.y)).toBe(false);
	});

	it('frees the armed pin alone, lifted, for one drag, whose drop ends the arm', () => {
		const { a, b, c } = mount();
		const end = vi.fn();
		setRouteLock(true, b, end);
		expect([draggable(a), draggable(b), draggable(c)]).toEqual([false, true, false]);
		expect([liftedPin(a), liftedPin(b)]).toEqual([false, true]);
		const pin = pinOf(b);
		pin.fire('dragstart');
		moveTo(pin, offset(lfpn.lat, lfpn.lon, 150, 60));
		pin.fire('dragend');
		expect(end).toHaveBeenCalledOnce();
		expect(undo.undoChip.kind, 'the move is offered back').toBe('moved');
		// The state has let the arm go: the pin locks again, unlifted.
		setRouteLock(true, null, end);
		expect([draggable(b), liftedPin(b)]).toEqual([false, false]);
	});

	it('ends the arm at a press anywhere but the armed pin', () => {
		const win = window as unknown as {
			addEventListener: (type: string, fn: (e: unknown) => void) => void;
			removeEventListener: (type: string, fn: (e: unknown) => void) => void;
		};
		const listeners = new Map<string, (e: unknown) => void>();
		const add = win.addEventListener;
		const remove = win.removeEventListener;
		win.addEventListener = (type, fn) => listeners.set(type, fn);
		win.removeEventListener = (type, fn) => {
			if (listeners.get(type) === fn) {
				listeners.delete(type);
			}
		};
		try {
			const { a, b } = mount();
			const end = vi.fn();
			setRouteLock(true, b, end);
			const onPress = listeners.get('pointerdown');
			expect(onPress).toBeDefined();
			const icon = pinOf(b).getElement()!;
			onPress!({ target: icon });
			onPress!({ target: { parentNode: icon } });
			expect(end, 'a press on the armed pin is its drag').not.toHaveBeenCalled();
			onPress!({ target: pinOf(a).getElement() });
			expect(end).toHaveBeenCalledOnce();
			onPress!({ target: map.getContainer() });
			expect(end).toHaveBeenCalledTimes(2);
			setRouteLock(true, null, end);
			expect(listeners.has('pointerdown'), 'no arm, no listener').toBe(false);
		} finally {
			win.addEventListener = add;
			win.removeEventListener = remove;
		}
	});

	it('gives every pin its drag back when the lock goes, and the arm goes with it', () => {
		const { a, b } = mount();
		setRouteLock(true, a, none);
		setRouteLock(false, a, none);
		expect([draggable(a), draggable(b)]).toEqual([true, true]);
		expect(liftedPin(a), 'no arm without the lock').toBe(false);
	});

	it('starts afresh with the layer', () => {
		const { a } = mount();
		setRouteLock(true, null, none);
		clearRouteLayer(map);
		sync();
		expect(draggable(a)).toBe(true);
	});
});

