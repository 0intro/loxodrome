/* The airspace layer's viewport cull (map/airspaceLayer.ts).
 *
 * Ten thousand rows used to be built as Leaflet polygons at load and left
 * attached, and Leaflet re-projects every attached path on each view reset:
 * a wheel zoom blocked the main thread for 400-650 ms on a phone-speed CPU
 * with three categories on. Only the rows in the padded viewport are attached
 * now, and their polygons are materialised on first attach.
 *
 * The contracts that had to survive that, and which this spec pins:
 *
 *   - the decoration set IS the attached set, so a band can never draw
 *     without its boundary: lockstep by identity, not by two computations
 *     agreeing;
 *   - the hit-test asks the FILTERS and the category toggle, never where the
 *     map happens to be pointing, so "left-click stays visibility-gated"
 *     keeps its meaning;
 *   - a selected row that pans out and back comes back HIGHLIGHTED. The clone
 *     covers it while it is away, and the re-attach has to wear the emphasis
 *     or refreshHighlightOverlay drops the clone as redundant and the
 *     highlight is gone for good (highlightAirspaces early-returns on an
 *     unchanged key set).
 *
 * Vitest runs in `environment: 'node'`, so Leaflet is mocked down to the
 * handful of calls the layer makes; the fake map is a viewport plus the set
 * of groups currently on it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Airspace } from '$lib/data/airspaces';

interface FakePoly {
	ring: [number, number][];
	styles: Record<string, unknown>[];
	fronted: number;
}

let polys: FakePoly[] = [];

vi.mock('leaflet', () => {
	const chain = <T>(extra: Partial<T> = {}): T => {
		const obj: Record<string, unknown> = {
			addTo: () => obj,
			on: () => obj,
			off: () => obj,
			remove: () => obj,
			setStyle: () => obj,
			bringToFront: () => obj,
			...extra,
		};
		return obj as T;
	};
	// A real class, because emphasisClones tests `instanceof L.Path` before
	// re-fronting a clone.
	class Path {
		fake: FakePoly;
		constructor(ring: [number, number][]) {
			this.fake = { ring, styles: [], fronted: 0 };
			polys.push(this.fake);
		}
		addTo(): this {
			return this;
		}
		on(): this {
			return this;
		}
		off(): this {
			return this;
		}
		remove(): this {
			return this;
		}
		setStyle(s: Record<string, unknown>): this {
			this.fake.styles.push(s);
			return this;
		}
		bringToFront(): this {
			this.fake.fronted++;
			return this;
		}
	}
	const L = {
		// emphasisClones pulls in directDrawLayer, which subclasses L.Layer at
		// module scope; the cull never instantiates one.
		Layer: class {},
		Path,
		canvas: () => chain(),
		svg: () => chain(),
		// addTo / remove have to reach the map, since "category on" is exactly
		// map.hasLayer(group) throughout the layer.
		layerGroup: () => {
			const members = new Set<unknown>();
			let host: { addLayer(l: unknown): void; removeLayer(l: unknown): void } | null = null;
			const group = {
				addTo(m: typeof host) {
					host = m;
					m?.addLayer(group);
					return group;
				},
				remove() {
					host?.removeLayer(group);
					host = null;
					return group;
				},
				addLayer: (l: unknown) => void members.add(l),
				removeLayer: (l: unknown) => void members.delete(l),
				hasLayer: (l: unknown) => members.has(l),
				on: () => group,
				off: () => group,
			};
			return group;
		},
		polygon: (ring: [number, number][]) => new Path(ring),
	};
	return { default: L, ...L };
});

vi.mock('$lib/map/activationLayer', () => ({ isActivationDrawn: () => false }));
vi.mock('$lib/map/navContactLayer', () => ({ navContactKeys: () => new Set<string>() }));
vi.mock('$lib/map/navAlertLayer', () => ({ navAlertKeys: () => new Set<string>() }));

const {
	buildAirspaceLayer,
	clearAirspaceLayer,
	setAirspaceCategory,
	setAirspacePublisher,
	updateAirspaceViewport,
	visibleDecoratedAirspaces,
	airspaceAt,
	highlightAirspace,
} = await import('$lib/map/airspaceLayer');

/** A square zone of `size` degrees centred on (lat, lon). */
function zone(id: string, lat: number, lon: number, size = 0.2): Airspace {
	const h = size / 2;
	const ring: [number, number][] = [
		[lat - h, lon - h],
		[lat - h, lon + h],
		[lat + h, lon + h],
		[lat + h, lon - h],
	];
	return {
		id,
		key: id,
		name: id,
		type: 'CTR',
		class: 'D',
		category: 'controlled',
		source: 'fr',
		ring,
		bbox: { minLat: lat - h, maxLat: lat + h, minLon: lon - h, maxLon: lon + h },
		area: size * size,
		vLower: null,
		vUpper: null,
	} as unknown as Airspace;
}

/** A map that is only a viewport, a zoom and a set of groups on it. */
function fakeMap(lat: number, lon: number, zoom = 9, span = 1) {
	const onMap = new Set<unknown>();
	const panes: Record<string, { style: Record<string, string> }> = {};
	const bounds = (la: number, lo: number, sp: number) => ({
		pad: (f: number) => bounds(la, lo, sp * (1 + 2 * f)),
		getSouth: () => la - sp / 2,
		getNorth: () => la + sp / 2,
		getWest: () => lo - sp / 2,
		getEast: () => lo + sp / 2,
	});
	const map = {
		lat,
		lon,
		zoom,
		span,
		getZoom: () => map.zoom,
		getBounds: () => bounds(map.lat, map.lon, map.span),
		getPane: (n: string) => (panes[n] ??= { style: {} }),
		createPane: (n: string) => (panes[n] ??= { style: {} }),
		hasLayer: (l: unknown) => onMap.has(l),
		addLayer: (l: unknown) => void onMap.add(l),
		removeLayer: (l: unknown) => void onMap.delete(l),
		on: () => map,
		off: () => map,
	};
	return map as unknown as L.Map & { lat: number; lon: number; zoom: number; span: number };
}

// Paris, and a zone far enough east that a z9 viewport never sees both.
const NEAR = zone('LFPARIS', 48.8, 2.3);
const FAR = zone('LFSTRAS', 48.6, 7.8);
const ALL = [NEAR, FAR];

describe('the airspace viewport cull', () => {
	let map: ReturnType<typeof fakeMap>;

	beforeEach(() => {
		clearAirspaceLayer();
		polys = [];
		map = fakeMap(48.8, 2.3);
		buildAirspaceLayer(map, ALL);
		setAirspaceCategory(map, 'controlled', true);
	});

	it('materialises a polygon only for what the viewport reaches', () => {
		expect(polys).toHaveLength(1);
		expect(visibleDecoratedAirspaces(map).map((a) => a.id)).toEqual(['LFPARIS']);
	});

	it('attaches a row on the pan that brings it into view, once', () => {
		map.lon = 7.8;
		map.lat = 48.6;
		updateAirspaceViewport(map);
		expect(visibleDecoratedAirspaces(map).map((a) => a.id)).toEqual(['LFSTRAS']);
		expect(polys).toHaveLength(2);
		// Panning back and forth reuses the polygon rather than rebuilding it:
		// re-projection is the cost worth paying, re-converting the ring is not.
		map.lon = 2.3;
		map.lat = 48.8;
		updateAirspaceViewport(map);
		map.lon = 7.8;
		map.lat = 48.6;
		updateAirspaceViewport(map);
		expect(polys).toHaveLength(2);
	});

	it('attaches nothing at the pane’s zoom floor', () => {
		map.zoom = 4;
		updateAirspaceViewport(map);
		expect(visibleDecoratedAirspaces(map)).toEqual([]);
		map.zoom = 9;
		updateAirspaceViewport(map);
		expect(visibleDecoratedAirspaces(map).map((a) => a.id)).toEqual(['LFPARIS']);
	});

	it('empties the decoration set when the category goes off, and refills it', () => {
		setAirspaceCategory(map, 'controlled', false);
		expect(visibleDecoratedAirspaces(map)).toEqual([]);
		setAirspaceCategory(map, 'controlled', true);
		expect(visibleDecoratedAirspaces(map).map((a) => a.id)).toEqual(['LFPARIS']);
	});

	it('drops a row whose publisher is switched off', () => {
		setAirspacePublisher(map, 'fr', false);
		expect(visibleDecoratedAirspaces(map)).toEqual([]);
		setAirspacePublisher(map, 'fr', true);
		expect(visibleDecoratedAirspaces(map).map((a) => a.id)).toEqual(['LFPARIS']);
	});

	it('hit-tests a row the filters and the toggle allow, wherever the map is', () => {
		// In view: found. This is the WYSIWYG left-click path.
		expect(airspaceAt(map, 48.8, 2.3)?.id).toBe('LFPARIS');
		// Category off: not found, even though it is still in the viewport.
		setAirspaceCategory(map, 'controlled', false);
		expect(airspaceAt(map, 48.8, 2.3)).toBeNull();
	});

	it('keeps a selected row highlighted across a pan out and back', () => {
		highlightAirspace('LFPARIS');
		const p = polys[0];
		const styledHighlight = (fp: FakePoly): boolean =>
			fp.styles.length > 0 && fp.styles[fp.styles.length - 1].fill === true;
		expect(styledHighlight(p)).toBe(true);
		// Out of the cull window: detached, and the clone carries the emphasis.
		map.lon = 7.8;
		map.lat = 48.6;
		updateAirspaceViewport(map);
		expect(visibleDecoratedAirspaces(map).map((a) => a.id)).toEqual(['LFSTRAS']);
		// Back again: the re-attach must restore the emphasis itself, or the
		// highlight is lost for good.
		map.lon = 2.3;
		map.lat = 48.8;
		updateAirspaceViewport(map);
		expect(visibleDecoratedAirspaces(map).map((a) => a.id)).toEqual(['LFPARIS']);
		expect(styledHighlight(p)).toBe(true);
	});

	it('queries the unwrapped bounds, since that is where Leaflet draws vectors', () => {
		// A viewport panned a world past the seam (centre at 172.6 + 360)
		// shows wrapped TILES of New Zealand, but SphericalMercator projects
		// a polygon at its raw longitude and never onto a world copy: the
		// zone would attach and paint 360 degrees off screen. Nothing to
		// attach, then; the same viewport at its own longitude attaches it.
		const dateline = zone('NZZCH', -43.5, 172.6, 0.4);
		clearAirspaceLayer();
		polys = [];
		const far = fakeMap(-43.5, 172.6 + 360, 9);
		buildAirspaceLayer(far, [dateline]);
		setAirspaceCategory(far, 'controlled', true);
		expect(visibleDecoratedAirspaces(far)).toEqual([]);
		far.lon = 172.6;
		updateAirspaceViewport(far);
		expect(visibleDecoratedAirspaces(far).map((a) => a.id)).toEqual(['NZZCH']);
	});

	it('re-indexes when the dataset array is republished (a late country)', () => {
		// The coverage gate merges a new publisher's rows into a NEW array;
		// handed to the built layer it must reach the boundary, the hit-test
		// and the selection lookup, not stay bound to the first array.
		const newcomer = zone('LFNEW', 48.8, 2.35, 0.1);
		const before = polys.length;
		buildAirspaceLayer(map, [...ALL, newcomer]);
		expect(visibleDecoratedAirspaces(map).map((a) => a.id)).toEqual(['LFPARIS', 'LFNEW']);
		expect(airspaceAt(map, 48.8, 2.35)?.id).toBe('LFNEW');
		// The surviving row kept its polygon (same object, same key): only
		// the newcomer materialised.
		expect(polys.length).toBe(before + 1);
		// The same array again is a no-op.
		const again = polys.length;
		buildAirspaceLayer(map, [...ALL, newcomer]);
		expect(polys.length).toBe(again + 0);
	});

	it('restacks when a category comes back on the map without a pan', () => {
		const p = polys[0];
		const frontedBefore = p.fronted;
		setAirspaceCategory(map, 'controlled', false);
		// Leaflet re-adds the group's members in their own order, so the
		// toggle must restack even though the viewport did not move.
		setAirspaceCategory(map, 'controlled', true);
		expect(p.fronted).toBeGreaterThan(frontedBefore);
	});
});
