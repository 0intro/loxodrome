/* Pins the zoom-animation transform math of canvasZoom.ts against Leaflet's
 * own placement. A painting made for {zoom, origin, topLeft} is a tile level
 * whose origin is the canvas corner: under the animating view it must land
 * where GridLayer._setZoomTransform puts such a level, which is also where
 * Renderer._updateTransform puts a padded vector canvas. Both formulas take
 * the new pixel origin from Map._getNewPixelOrigin, which ADDS the map pane's
 * offset: a pan moves the pane and leaves the pixel origin alone until the
 * next view reset. The fake map therefore models a panned map for real (a
 * fixed pixel origin, a pane offset, the centre that follows from both); the
 * old one had no pane at all, which is how a transform that dropped the pane
 * passed here while every canvas on screen slid off by the pan times the zoom
 * scale. Leaflet itself touches `window` at import, so it is mocked with a
 * recording DomUtil.setTransform and a chainable point stand-in. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type L from 'leaflet';

const recorded = vi.hoisted(() => ({
	calls: [] as { offset: { x: number; y: number }; scale: number }[],
}));

vi.mock('leaflet', () => ({
	default: {
		point: (x: number, y: number) => ({ x, y }),
		DomUtil: {
			setTransform: (_el: unknown, offset: { x: number; y: number }, scale: number) => {
				recorded.calls.push({ offset: { x: offset.x, y: offset.y }, scale });
			},
		},
	},
}));

import { canvasZoomEvents, type CanvasDrawState } from '$lib/map/canvasZoom';

/** Chainable stand-in for L.Point (the exact methods transform() uses). */
class Pt {
	constructor(
		public x: number,
		public y: number,
	) {}
	multiplyBy(k: number): Pt {
		return new Pt(this.x * k, this.y * k);
	}
	subtract(p: Pt): Pt {
		return new Pt(this.x - p.x, this.y - p.y);
	}
	add(p: Pt): Pt {
		return new Pt(this.x + p.x, this.y + p.y);
	}
	divideBy(k: number): Pt {
		return new Pt(this.x / k, this.y / k);
	}
	round(): Pt {
		return new Pt(Math.round(this.x), Math.round(this.y));
	}
}

// A projection linear in lng/lat, 2^zoom * 32 px per degree: the zoom scaling
// is what the math depends on, and a power-of-two factor keeps the round trip
// through a centre exact.
const PX = (z: number): number => 2 ** z * 32;
const project = (ll: { lat: number; lng: number }, z: number): Pt => new Pt(ll.lng * PX(z), ll.lat * PX(z));
const unproject = (p: Pt, z: number): { lat: number; lng: number } => ({ lat: p.y / PX(z), lng: p.x / PX(z) });

interface View {
	zoom: number;
	/** the pixel origin of the last view reset (integer, like Leaflet's). */
	origin: Pt;
	/** the map pane's offset: what the pans since that reset added up to. */
	pane: Pt;
	size: Pt;
}

/** A map at `v`. Its centre is where the viewport's middle sits once the pane
 *  has moved: origin - pane + size / 2, projected back. */
function fakeMap(v: View): L.Map {
	return {
		getZoom: () => v.zoom,
		getCenter: () => unproject(v.origin.subtract(v.pane).add(v.size.divideBy(2)), v.zoom),
		getPixelOrigin: () => v.origin,
		getSize: () => v.size,
		getZoomScale: (to: number, from: number) => 2 ** (to - from),
		project,
		layerPointToContainerPoint: (p: [number, number]) => new Pt(p[0], p[1]).add(v.pane),
	} as unknown as L.Map;
}

/** The canvas corner a DirectDrawLayer paints at: the viewport's top-left in
 *  layer points (minus the pane) less the overscan margin. */
const topLeftFor = (pane: Pt, margin: number): Pt => new Pt(0 - pane.x - margin, 0 - pane.y - margin);

/** Where Leaflet puts a painting made for `state` under (center, zoom): the
 *  GridLayer form, with Map._getNewPixelOrigin written out. */
function gridLayerOffset(
	state: { zoom: number; origin: Pt; topLeft: Pt },
	pane: Pt,
	size: Pt,
	center: { lat: number; lng: number },
	zoom: number,
): Pt {
	const s = 2 ** (zoom - state.zoom);
	const newOrigin = project(center, zoom).subtract(size.divideBy(2)).add(pane).round();
	return state.origin.add(state.topLeft).multiplyBy(s).subtract(newOrigin);
}

/** The same placement in Renderer._updateTransform's terms: the draw view's
 *  centre projected at the new zoom, less the padded half-viewport scaled,
 *  less the new pixel origin. The margin plays the renderer's padding. */
function rendererOffset(draw: View, margin: number, center: { lat: number; lng: number }, zoom: number): Pt {
	const s = 2 ** (zoom - draw.zoom);
	const drawCentre = unproject(draw.origin.subtract(draw.pane).add(draw.size.divideBy(2)), draw.zoom);
	const newOrigin = project(center, zoom).subtract(draw.size.divideBy(2)).add(draw.pane).round();
	const halfPadded = draw.size.divideBy(2).add(new Pt(margin, margin));
	return project(drawCentre, zoom).subtract(halfPadded.multiplyBy(s)).subtract(newOrigin);
}

function handlers(map: L.Map, topLeft: Pt) {
	// What DirectDrawLayer._apply records for a canvas placed at topLeft.
	const state: CanvasDrawState = {
		zoom: map.getZoom(),
		origin: map.getPixelOrigin(),
		topLeft: topLeft as unknown as L.Point,
	};
	const canvas = {} as HTMLElement;
	return { on: canvasZoomEvents(() => ({ map, canvas, state })), state };
}

const SIZE = new Pt(800, 600);
const ORIGIN = new Pt(30_000, -12_000);
const PANES = [new Pt(0, 0), new Pt(300, 0), new Pt(-200, 150), new Pt(517, -311)];
const MARGINS = [0, 96];

beforeEach(() => {
	recorded.calls.length = 0;
});

describe('canvasZoomEvents transform', () => {
	it('starts every animation where the canvas already is, however far the map was panned', () => {
		for (const pane of PANES) {
			for (const margin of MARGINS) {
				recorded.calls.length = 0;
				const v: View = { zoom: 9, origin: ORIGIN, pane, size: SIZE };
				const map = fakeMap(v);
				const topLeft = topLeftFor(pane, margin);
				const { on } = handlers(map, topLeft);
				on.zoomanim({ center: map.getCenter(), zoom: 9 } as unknown as L.LeafletEvent);
				on.zoom({} as unknown as L.LeafletEvent);
				expect(recorded.calls, `pane ${pane.x},${pane.y} margin ${margin}`).toEqual([
					{ offset: { x: topLeft.x, y: topLeft.y }, scale: 1 },
					{ offset: { x: topLeft.x, y: topLeft.y }, scale: 1 },
				]);
			}
		}
	});

	it("lands where Leaflet's tile levels and vector renderer land, zooming in, out and by halves", () => {
		const offCentre = (m: L.Map, dx: number, dy: number) =>
			unproject(project(m.getCenter(), 9).add(new Pt(dx, dy)), 9);
		for (const pane of PANES) {
			for (const margin of MARGINS) {
				const v: View = { zoom: 9, origin: ORIGIN, pane, size: SIZE };
				const map = fakeMap(v);
				const topLeft = topLeftFor(pane, margin);
				for (const dz of [1, -1, 0.5]) {
					for (const target of [map.getCenter(), offCentre(map, 137, -64)]) {
						recorded.calls.length = 0;
						const { on, state } = handlers(map, topLeft);
						on.zoomanim({ center: target, zoom: 9 + dz } as unknown as L.LeafletEvent);
						const [{ offset, scale }] = recorded.calls;
						expect(scale).toBe(2 ** dz);
						const grid = gridLayerOffset(state as unknown as { zoom: number; origin: Pt; topLeft: Pt }, pane, SIZE, target, 9 + dz);
						const renderer = rendererOffset(v, margin, target, 9 + dz);
						expect(offset.x).toBeCloseTo(grid.x, 9);
						expect(offset.y).toBeCloseTo(grid.y, 9);
						expect(offset.x).toBeCloseTo(renderer.x, 9);
						expect(offset.y).toBeCloseTo(renderer.y, 9);
					}
				}
			}
		}
	});

	it('reproduces the measured case: a 300 px pan, one zoom in, a 938 px wide map', () => {
		// Chromium, Paris z9: before the fix the canvas went to x = -169 where
		// Leaflet's own math wanted -769 (the pan times the zoom scale off).
		const pane = new Pt(300, 0);
		const map = fakeMap({ zoom: 9, origin: ORIGIN, pane, size: new Pt(938, 700) });
		const { on } = handlers(map, topLeftFor(pane, 0));
		on.zoomanim({ center: map.getCenter(), zoom: 10 } as unknown as L.LeafletEvent);
		expect(recorded.calls[0].offset.x).toBe(-769);
		expect(recorded.calls[0].scale).toBe(2);
	});

	it('holds a painting a skipped overscan pan left behind, since the pane moved and not the origin', () => {
		// Painted with the pane at P0; a follow re-centre inside the margin then
		// moved the pane to P1 without a repaint: the canvas still sits at the
		// painting's own corner, and an animation must start from there.
		const margin = 96;
		const painted = topLeftFor(new Pt(40, -25), margin);
		const map = fakeMap({ zoom: 11, origin: ORIGIN, pane: new Pt(95, -60), size: SIZE });
		const { on } = handlers(map, painted);
		on.zoomanim({ center: map.getCenter(), zoom: 11 } as unknown as L.LeafletEvent);
		expect(recorded.calls).toEqual([{ offset: { x: painted.x, y: painted.y }, scale: 1 }]);
	});

	it('reads the live view on per-frame zoom events and skips before the first paint', () => {
		const pane = new Pt(-120, 45);
		const map = fakeMap({ zoom: 5, origin: ORIGIN, pane, size: SIZE });
		const topLeft = topLeftFor(pane, 0);
		const { on } = handlers(map, topLeft);
		on.zoom({} as unknown as L.LeafletEvent);
		// The live view IS the draw view here: the canvas stays put.
		expect(recorded.calls).toEqual([{ offset: { x: topLeft.x, y: topLeft.y }, scale: 1 }]);
		recorded.calls.length = 0;
		const idle = canvasZoomEvents(() => null);
		idle.zoom({} as unknown as L.LeafletEvent);
		idle.zoomanim({ center: map.getCenter(), zoom: 6 } as unknown as L.LeafletEvent);
		expect(recorded.calls).toEqual([]);
	});
});
