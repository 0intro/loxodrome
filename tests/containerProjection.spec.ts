/* The decoration paint's projection (map/containerProjection.ts) against
 * Leaflet's own latLngToContainerPoint, run in Node on Leaflet itself
 * (tests/helpers/leafletNode.ts): the same number, bit for bit (Object.is),
 * at integer and fractional zooms, after pans (whole pixels, and the
 * fractions an inertia glide passes through), over a grid that crosses the
 * Mercator latitude clamp, the antimeridian and both zeros, and a scatter of
 * random points. A difference in the last bit would be a band drawn a pixel
 * off its boundary, since both sides round; zoom 34, far past the map's
 * range, magnifies a difference in the projected metres into whole pixels.
 * The inverse over a rectangle, containerBounds, is held to the map's own
 * containerPointToLatLng: unwrapped past the seam, as the map reads it. */

import { describe, expect, it } from 'vitest';
import type { Map as LeafletMap } from 'leaflet';
import { installLeafletNode } from './helpers/leafletNode';

// 3D claimed, or Leaflet snaps every zoom whole whatever zoomSnap says.
const env = installLeafletNode({ any3d: true });
const L = (await import('leaflet')).default;
const { containerBounds, containerProjector, mercatorX, mercatorY, projectionView, zoomScale } = await import('$lib/map/containerProjection');

const MAP_OPTIONS = {
	zoomControl: false,
	attributionControl: false,
	boxZoom: false,
	doubleClickZoom: false,
	dragging: false,
	keyboard: false,
	scrollWheelZoom: false,
	touchZoom: false,
	trackResize: false,
	fadeAnimation: false,
	zoomAnimation: false,
	markerZoomAnimation: false,
	// Fractional zooms are what a flyTo or a pinch passes through.
	zoomSnap: 0,
};

function mapAt(lat: number, lng: number, zoom: number): LeafletMap {
	const map = L.map(env.container(1367, 700) as unknown as HTMLElement, MAP_OPTIONS).setView([lat, lng], zoom);
	expect(map.getZoom()).toBe(zoom);
	return map;
}

/** A seeded generator in [0, 1), so a failure names the same point every
 *  run, with all 53 bits of a double: a value with empty low bits would add
 *  exactly whatever the order, and hide an order that rounds differently. */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	const next = (): number => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s;
	};
	return () => ((next() >>> 6) * 2 ** 27 + (next() >>> 5)) / 2 ** 53;
}

const LATS = [-90, -85.06, -85.0511287798, -60, -45.5, -0, 0, 1e-12, 12.5, 48.8566, 70, 85.0511287798, 85.06, 90];
const LNGS = [-200, -180, -179.9999, -2.35, -0, 0, 1e-9, 2.3522, 7.8, 172.6, 180, 200];

function points(): [number, number][] {
	const out: [number, number][] = [];
	for (const lat of LATS) {
		for (const lng of LNGS) {
			out.push([lat, lng]);
		}
	}
	const rnd = lcg(20260926);
	for (let i = 0; i < 1500; i++) {
		out.push([rnd() * 180 - 90, rnd() * 400 - 200]);
	}
	return out;
}

/** The container points, and the world pixels before the round, where a
 *  last-bit difference shows whether or not it crosses a rounding boundary. */
function expectSame(map: LeafletMap, what: string): void {
	const pr = containerProjector(projectionView(map));
	const scale = zoomScale(map.getZoom());
	let checked = 0;
	for (const [lat, lng] of points()) {
		const p = map.latLngToContainerPoint([lat, lng]);
		const w = map.project([lat, lng], map.getZoom());
		const x = pr.x(lng);
		const y = pr.y(lat);
		const wx = mercatorX(lng, scale);
		const wy = mercatorY(lat, scale);
		if (!Object.is(x, p.x) || !Object.is(y, p.y) || !Object.is(wx, w.x) || !Object.is(wy, w.y)) {
			expect({ what, lat, lng, x, y, wx, wy }).toEqual({ what, lat, lng, x: p.x, y: p.y, wx: w.x, wy: w.y });
		}
		checked++;
	}
	expect(checked).toBeGreaterThan(1600);
}

describe('containerProjector', () => {
	it('answers what Leaflet answers, bit for bit, at integer and fractional zooms', () => {
		for (const [lat, lng] of [
			[48.8, 2.3],
			[-43.5, 172.6],
			[64.1, -21.9],
			[0, 0],
		] as const) {
			for (const zoom of [0, 3, 7.5, 9, 9.37, 12, 16.25, 18, 34]) {
				expectSame(mapAt(lat, lng, zoom), `${lat},${lng} z${zoom}`);
			}
		}
	});

	it('follows the pane after pans, which move it and not the pixel origin', () => {
		const map = mapAt(48.8, 2.3, 9);
		const origin = map.getPixelOrigin();
		for (const [dx, dy] of [
			[137, -64],
			[-900, 300],
			[5, 5],
		] as const) {
			map.panBy([dx, dy], { animate: false });
			expect(map.getPixelOrigin()).toEqual(origin);
			expectSame(map, `pan ${dx},${dy}`);
		}
	});

	it('follows a pane left at a fraction of a pixel, as an inertia glide leaves it', () => {
		const map = mapAt(48.8, 2.3, 9);
		const pane = map.getPane('mapPane');
		if (!pane) {
			throw new Error('no map pane');
		}
		const rnd = lcg(34);
		for (let i = 0; i < 12; i++) {
			L.DomUtil.setPosition(pane, L.point(rnd() * 2000 - 1000, rnd() * 1400 - 700));
			expectSame(map, `pane ${i}`);
		}
	});

	it('reads the view the way the map reports it', () => {
		const map = mapAt(45.6, 6.4, 10);
		map.panBy([-321, 77], { animate: false });
		const v = projectionView(map);
		expect(v.zoom).toBe(10);
		expect([v.originX, v.originY]).toEqual([map.getPixelOrigin().x, map.getPixelOrigin().y]);
		const pane = map.layerPointToContainerPoint([0, 0]);
		expect([v.paneX, v.paneY]).toEqual([pane.x, pane.y]);
		expect([v.paneX, v.paneY]).toEqual([321, -77]);
	});

	it('reads a rectangle of the view back as the map reads its corners, unwrapped', () => {
		const rnd = lcg(55);
		for (const [lat, lng, zoom] of [[48.8, 2.3, 9], [-43.5, 179.9, 7], [70.2, -20.5, 11.5], [0, 0, 3]] as const) {
			const map = mapAt(lat, lng, zoom);
			const pane = map.getPane('mapPane');
			if (!pane) {
				throw new Error('no map pane');
			}
			L.DomUtil.setPosition(pane, L.point(rnd() * 900 - 450, rnd() * 600 - 300));
			const [x0, y0, x1, y1] = [-80 - rnd() * 100, -40, 1367 + rnd() * 100, 700 + 60];
			const got = containerBounds(projectionView(map), x0, y0, x1, y1);
			const nw = map.containerPointToLatLng([x0, y0]);
			const se = map.containerPointToLatLng([x1, y1]);
			expect(got.minLon, `${lat},${lng}`).toBeCloseTo(nw.lng, 9);
			expect(got.maxLon).toBeCloseTo(se.lng, 9);
			expect(got.maxLat).toBeCloseTo(nw.lat, 9);
			expect(got.minLat).toBeCloseTo(se.lat, 9);
		}
		// A view past the seam reads longitudes past 180, as the map does.
		const east = mapAt(-43.5, 179.9 + 360, 8);
		expect(containerBounds(projectionView(east), 0, 0, 1367, 700).maxLon).toBeGreaterThan(360);
	});
});
