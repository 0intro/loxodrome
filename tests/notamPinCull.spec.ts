/* The NOTAM layer's viewport cull and keyed redraw (map/notamLayer.ts).
 *
 * Every NOTAM pin used to be a DivIcon attached to the map whatever the view,
 * and renderNotams tore everything down and rebuilt it on any change: a
 * 7,500-NOTAM briefing attached 3,450 pins, which Chromium composited as
 * 2,966 layers (13 s of blocking for two drags, 0.2 s once culled), and a
 * zoom-floor crossing rebuilt them all through Leaflet's O(n^2) marker add.
 *
 * The contracts this spec pins:
 *   - only the stacks inside the padded window are attached, and a pin is
 *     not even built before the window first reaches it;
 *   - a move re-culls: pins leaving the window detach, pins entering attach
 *     (and a pin that comes back is the same marker, not a rebuild);
 *   - a pin that attaches while its NOTAM is selected wears the selected
 *     class, and carries its accessible name;
 *   - a redraw diffs: a NOTAM leaving the set removes its own pin and paths
 *     only, a NOTAM joining builds its own only, and an unchanged set with a
 *     changed hide set touches the pins alone.
 *
 * Leaflet is mocked down to the calls the layer makes; the fake map is a
 * viewport (getSize / getBounds) and the group records what is attached.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type L from 'leaflet';
import type { Notam } from '$lib/notam/types';
import type { IndexedNotam } from '$lib/state/notam.svelte';

interface FakeEl {
	classes: Set<string>;
	attrs: Map<string, string>;
	setAttribute: (k: string, v: string) => void;
	classList: { toggle: (c: string, on?: boolean) => boolean; add: (c: string) => void; remove: (c: string) => void };
}

function makeEl(): FakeEl {
	const classes = new Set<string>();
	const attrs = new Map<string, string>();
	return {
		classes,
		attrs,
		setAttribute: (k, v) => void attrs.set(k, v),
		classList: {
			toggle: (c, on) => {
				const want = on ?? !classes.has(c);
				if (want) classes.add(c);
				else classes.delete(c);
				return want;
			},
			add: (c) => void classes.add(c),
			remove: (c) => void classes.delete(c),
		},
	};
}

interface FakeMarker {
	ll: [number, number];
	el: FakeEl | null;
	getElement: () => FakeEl | null;
	on: () => FakeMarker;
	addTo: (g: FakeGroup) => FakeMarker;
}
interface FakeGroup {
	layers: Set<unknown>;
	addLayer: (l: unknown) => void;
	removeLayer: (l: unknown) => void;
	clearLayers: () => void;
	addTo: () => FakeGroup;
}

let markers: FakeMarker[] = [];
let polygons = 0;
let group: FakeGroup | null = null;

vi.mock('leaflet', () => {
	const chain = <T>(extra: Partial<T> = {}): T => {
		const obj: Record<string, unknown> = {
			addTo: (g: FakeGroup) => {
				g?.addLayer?.(obj);
				return obj;
			},
			on: () => obj,
			off: () => obj,
			remove: () => obj,
			setStyle: () => obj,
			bringToFront: () => obj,
			getElement: () => null,
			...extra,
		};
		return obj as T;
	};
	const L = {
		layerGroup: () => {
			const g: FakeGroup = {
				layers: new Set(),
				// Attaching a marker gives it a fresh element, detaching drops it,
				// the way Leaflet's Marker onAdd / onRemove build and remove _icon.
				addLayer: (l: unknown) => {
					g.layers.add(l);
					const m = l as FakeMarker;
					if (m && 'll' in m) m.el = makeEl();
				},
				removeLayer: (l: unknown) => {
					g.layers.delete(l);
					const m = l as FakeMarker;
					if (m && 'll' in m) m.el = null;
				},
				clearLayers: () => g.layers.clear(),
				addTo: () => g,
			};
			group = g;
			return g;
		},
		circle: () => chain(),
		polygon: () => {
			polygons++;
			return chain();
		},
		marker: (ll: [number, number]) => {
			const m: FakeMarker = {
				ll,
				el: null,
				getElement: () => m.el,
				on: () => m,
				addTo: (g: FakeGroup) => {
					g.addLayer(m);
					return m;
				},
			};
			markers.push(m);
			return m;
		},
		divIcon: () => chain(),
		DomEvent: { stopPropagation: () => {} },
	};
	return { default: L };
});

import { clearNotamLayer, highlightNotam, renderNotams, updateNotamPinsViewport } from '$lib/map/notamLayer';

/** A fake map showing [south, west, north, east]; getBounds().pad(p) widens it
 *  like Leaflet's LatLngBounds.pad. */
function fakeMap(view: { s: number; w: number; n: number; e: number }): L.Map & { view: typeof view } {
	const bounds = (b: typeof view) => ({
		pad: (p: number) => {
			const dLat = (b.n - b.s) * p;
			const dLon = (b.e - b.w) * p;
			return bounds({ s: b.s - dLat, w: b.w - dLon, n: b.n + dLat, e: b.e + dLon });
		},
		getSouth: () => b.s,
		getWest: () => b.w,
		getNorth: () => b.n,
		getEast: () => b.e,
	});
	const m = {
		view,
		getPane: () => ({}) as HTMLElement,
		createPane: () => ({ style: {} }) as unknown as HTMLElement,
		getSize: () => ({ x: 800, y: 600 }),
		getBounds: () => bounds(m.view),
	};
	return m as unknown as L.Map & { view: typeof view };
}

let seq = 0;
function psn(lat: number, lon: number, index: number): IndexedNotam {
	const notam = {
		id: `A${String(++seq).padStart(4, '0')}/26`,
		isPolygon: false,
		coordinates: [{ lat, lon, type: 'psn' }],
		obstacleType: '',
		serviceStatus: '',
		qualifier: null,
	} as unknown as Notam;
	return { notam, index };
}
function area(lat: number, lon: number, index: number): IndexedNotam {
	const notam = {
		id: `W${String(++seq).padStart(4, '0')}/26`,
		isPolygon: true,
		coordinates: [
			{ lat, lon, type: 'psn' },
			{ lat: lat + 0.1, lon, type: 'psn' },
			{ lat: lat + 0.1, lon: lon + 0.1, type: 'psn' },
		],
		obstacleType: '',
		serviceStatus: '',
		qualifier: null,
	} as unknown as Notam;
	return { notam, index };
}

const attached = () => markers.filter((m) => group?.layers.has(m));

describe('NOTAM pins: viewport cull and keyed redraw', () => {
	beforeEach(() => {
		clearNotamLayer();
		markers = [];
		polygons = 0;
		group = null;
	});

	it('attaches only the pins inside the padded window, and builds no other', () => {
		const map = fakeMap({ s: 48, w: 2, n: 49, e: 3 });
		const items = [psn(48.5, 2.5, 0), psn(48.9, 3.2, 1), psn(45, 5, 2), psn(52, -1, 3)];
		renderNotams(map, items, false, true);
		// 48.9/3.2 is outside the view but inside a quarter-viewport pad.
		expect(attached().map((m) => m.ll)).toEqual([
			[48.5, 2.5],
			[48.9, 3.2],
		]);
		expect(markers.length).toBe(2);
	});

	it('re-culls on a move: leaving pins detach, entering pins attach, a returning pin is the same marker', () => {
		const map = fakeMap({ s: 48, w: 2, n: 49, e: 3 });
		const items = [psn(48.5, 2.5, 0), psn(45.5, 5.5, 1)];
		renderNotams(map, items, false, true);
		const paris = attached()[0];
		map.view = { s: 45, w: 5, n: 46, e: 6 };
		updateNotamPinsViewport(map);
		expect(attached().map((m) => m.ll)).toEqual([[45.5, 5.5]]);
		map.view = { s: 48, w: 2, n: 49, e: 3 };
		updateNotamPinsViewport(map);
		expect(attached()).toEqual([paris]);
		expect(markers.length).toBe(2);
	});

	it('names every attached pin and marks the selected one, also when it attaches later', () => {
		const map = fakeMap({ s: 48, w: 2, n: 49, e: 3 });
		const items = [psn(48.5, 2.5, 0), psn(45.5, 5.5, 1)];
		renderNotams(map, items, false, true);
		highlightNotam(1); // selected while off screen
		map.view = { s: 45, w: 5, n: 46, e: 6 };
		updateNotamPinsViewport(map);
		const [pin] = attached();
		expect(pin.el?.attrs.get('aria-label')).toBe(`NOTAM ${items[1].notam.id}`);
		expect(pin.el?.classes.has('notam-pin--selected')).toBe(true);
		highlightNotam(null);
		expect(pin.el?.classes.has('notam-pin--selected')).toBe(false);
	});

	it('a NOTAM leaving the set removes its own pin and paths only', () => {
		const map = fakeMap({ s: 40, w: -5, n: 55, e: 10 });
		const items = [psn(48.5, 2.5, 0), psn(47.5, 1.5, 1), area(46, 3, 2), area(45, 4, 3)];
		renderNotams(map, items, false, true);
		expect(markers.length).toBe(2);
		expect(polygons).toBe(2);
		const kept = attached()[0];
		const layersBefore = group!.layers.size;
		renderNotams(map, [items[0], items[2]], false, true);
		expect(markers.length).toBe(2); // nothing rebuilt
		expect(polygons).toBe(2);
		expect(attached()).toEqual([kept]);
		expect(group!.layers.size).toBe(layersBefore - 2);
	});

	it('a NOTAM joining the set builds its own pin and paths only', () => {
		const map = fakeMap({ s: 40, w: -5, n: 55, e: 10 });
		const items = [psn(48.5, 2.5, 0), area(46, 3, 1)];
		renderNotams(map, items, false, true);
		renderNotams(map, [...items, psn(47.5, 1.5, 2), area(45, 4, 3)], false, true);
		expect(markers.length).toBe(2);
		expect(polygons).toBe(2);
		expect(attached().length).toBe(2);
	});

	it('a changed hide set with the same NOTAMs touches the pins alone', () => {
		const map = fakeMap({ s: 40, w: -5, n: 55, e: 10 });
		const qline = {
			notam: {
				id: 'Q0001/26',
				isPolygon: false,
				coordinates: [{ lat: 48.7, lon: 2.4, type: 'qualifierLine' }],
				obstacleType: '',
				serviceStatus: '',
				qualifier: null,
			} as unknown as Notam,
			index: 1,
		};
		const items = [psn(48.5, 2.5, 0), qline, area(46, 3, 2)];
		renderNotams(map, items, false, true, new Set());
		expect(attached().length).toBe(2);
		renderNotams(map, items, false, true, new Set([1]));
		expect(attached().length).toBe(1);
		expect(polygons).toBe(1); // the area was not rebuilt
		renderNotams(map, items, false, true, new Set());
		expect(attached().length).toBe(2);
		expect(polygons).toBe(1);
	});

	it('a re-parse (new NOTAM objects, same indexes) rebuilds the pins it hands out', () => {
		const map = fakeMap({ s: 40, w: -5, n: 55, e: 10 });
		renderNotams(map, [psn(48.5, 2.5, 0)], false, true);
		renderNotams(map, [psn(48.5, 2.5, 0)], false, true);
		expect(markers.length).toBe(2);
		expect(attached().length).toBe(1);
	});
});
