/* Pins the zoom-animation transform math of canvasZoom.ts: at the draw
 * view the transform reduces exactly to setPosition(state.topLeft) with
 * scale 1 (no jump when an animation starts), and at another zoom the
 * canvas scales by the zoom ratio and translates by the pixel-origin
 * delta, mirroring Leaflet's Renderer._updateTransform. Leaflet itself
 * touches `window` at import, so it is mocked with a chainable point
 * stand-in and a recording DomUtil.setTransform. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type L from 'leaflet';

const recorded = vi.hoisted(() => ({
	calls: [] as { offset: { x: number; y: number }; scale: number }[],
}));

vi.mock('leaflet', () => ({
	default: {
		DomUtil: {
			setTransform: (_el: unknown, offset: { x: number; y: number }, scale: number) => {
				recorded.calls.push({ offset: { x: offset.x, y: offset.y }, scale });
			},
		},
	},
}));

import { canvasDrawState, canvasZoomEvents } from '$lib/map/canvasZoom';

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

/** A map whose projection is lng/lat * 2^zoom * 32 px (a web-mercator-free
 *  stand-in with the right zoom scaling), 800x600 px viewport. */
function fakeMap(zoom: number, center: { lat: number; lng: number }) {
	return {
		getZoom: () => zoom,
		getCenter: () => center,
		getPixelOrigin: () =>
			new Pt(center.lng * 2 ** zoom * 32, center.lat * 2 ** zoom * 32)
				.subtract(new Pt(400, 300))
				.round(),
		getSize: () => new Pt(800, 600),
		getZoomScale: (to: number, from: number) => 2 ** (to - from),
		project: (ll: { lat: number; lng: number }, z: number) =>
			new Pt(ll.lng * 2 ** z * 32, ll.lat * 2 ** z * 32),
	} as unknown as L.Map;
}

const CENTER = { lat: 40, lng: 30 };

beforeEach(() => {
	recorded.calls.length = 0;
});

describe('canvasDrawState', () => {
	it('snapshots zoom, pixel origin and the canvas position', () => {
		const map = fakeMap(5, CENTER);
		const s = canvasDrawState(map, new Pt(7, -3) as unknown as L.Point);
		expect(s.zoom).toBe(5);
		expect(s.origin.x).toBe(30 * 32 * 32 - 400);
		expect(s.topLeft.x).toBe(7);
		expect(s.topLeft.y).toBe(-3);
	});
});

describe('canvasZoomEvents transform', () => {
	function handlers(map: L.Map, topLeft: Pt) {
		const state = canvasDrawState(map, topLeft as unknown as L.Point);
		const canvas = {} as HTMLElement;
		return canvasZoomEvents(() => ({ map, canvas, state }));
	}

	it('reduces to the identity at the draw view (no jump on start)', () => {
		const map = fakeMap(5, CENTER);
		const on = handlers(map, new Pt(11, 22));
		on.zoomanim({ center: CENTER, zoom: 5 } as unknown as L.LeafletEvent);
		expect(recorded.calls).toEqual([{ offset: { x: 11, y: 22 }, scale: 1 }]);
	});

	it('scales by the zoom ratio about the origin delta one zoom in', () => {
		const map = fakeMap(5, CENTER);
		const on = handlers(map, new Pt(0, 0));
		on.zoomanim({ center: CENTER, zoom: 6 } as unknown as L.LeafletEvent);
		expect(recorded.calls).toHaveLength(1);
		const { offset, scale } = recorded.calls[0];
		expect(scale).toBe(2);
		// origin(z6) = 2 * project(center, z5) - (400, 300); the doubled draw
		// origin lands 400 / 300 px short of it, so the canvas shifts by the
		// viewport half-size, exactly like the tiles.
		expect(offset).toEqual({ x: -400, y: -300 });
	});

	it('reads the live view on per-frame zoom events and skips before the first paint', () => {
		const map = fakeMap(5, CENTER);
		const on = handlers(map, new Pt(0, 0));
		on.zoom({} as unknown as L.LeafletEvent);
		// The live view IS the draw view here: identity again.
		expect(recorded.calls).toEqual([{ offset: { x: 0, y: 0 }, scale: 1 }]);
		recorded.calls.length = 0;
		const idle = canvasZoomEvents(() => null);
		idle.zoom({} as unknown as L.LeafletEvent);
		idle.zoomanim({ center: CENTER, zoom: 6 } as unknown as L.LeafletEvent);
		expect(recorded.calls).toEqual([]);
	});
});
