/* Pins the panel-aware centring math of map/focus.ts: with nothing
 * selected the helpers behave exactly like the bare Leaflet calls, a
 * mobile bottom sheet shifts the target down by half the height it hides OF
 * THE MAP (its fraction is of the whole workspace, so the phone's tab bar and
 * any bottom dock come off it; clamped at 70 % of the viewport), and the
 * fit/fly bounds variants
 * reserve the inset as extra bottom-right padding. The desktop branch
 * measures the panel's DOM box, out of reach of this node environment, so
 * it stays covered by the `typeof document` guard only (a minimal
 * document stub keeps the guard from short-circuiting the mobile math
 * under test). Leaflet and the state modules are mocked (leaflet touches
 * `window` at import). */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type L from 'leaflet';

// panelInset bails out entirely when `document` is undefined (SSR guard);
// the mobile branch never reads it, so an empty stub suffices.
(globalThis as { document?: unknown }).document = {
	querySelector: () => null,
};
afterAll(() => {
	delete (globalThis as { document?: unknown }).document;
});

vi.mock('leaflet', () => ({
	default: {
		latLng: (t: unknown) => t,
	},
}));
vi.mock('$lib/state/map.svelte', () => ({ mapState: { map: null } }));

const uiMock = vi.hoisted(() => ({
	ui: {
		detail: null as { kind: string } | null,
		isMobile: false,
		detailHeight: 0.45,
		sheetPeekPx: 0,
	},
}));
vi.mock('$lib/state/ui.svelte', () => uiMock);

import { fitBoundsVisible, panelAwareCenter } from '$lib/map/focus';

/** A map stub with an identity projection (x = lng, y = lat, zoom-free). */
function fakeMap(sizeX = 800, sizeY = 600) {
	const fitBounds = vi.fn();
	const map = {
		getSize: () => ({ x: sizeX, y: sizeY }),
		project: (ll: { lat: number; lng: number }) => ({
			x: ll.lng,
			y: ll.lat,
			add: function (this: { x: number; y: number }, d: [number, number]) {
				return { x: this.x + d[0], y: this.y + d[1] };
			},
		}),
		unproject: (p: { x: number; y: number }) => ({ lat: p.y, lng: p.x }),
		fitBounds,
	} as unknown as L.Map;
	return { map, fitBounds };
}

const TARGET = { lat: 100, lng: 200 };

beforeEach(() => {
	uiMock.ui.detail = null;
	uiMock.ui.isMobile = false;
	uiMock.ui.detailHeight = 0.45;
	uiMock.ui.sheetPeekPx = 0;
});

describe('panelAwareCenter', () => {
	it('is the bare target while nothing is selected', () => {
		const { map } = fakeMap();
		expect(panelAwareCenter(map, TARGET, 7)).toEqual(TARGET);
	});

	it('shifts the centre down by half the mobile sheet height', () => {
		uiMock.ui.detail = { kind: 'notam' };
		uiMock.ui.isMobile = true;
		uiMock.ui.detailHeight = 0.5;
		const { map } = fakeMap(800, 600);
		// Hidden height 600 * 0.5 = 300; the centre moves +150 in y so the
		// target lands centred in the visible strip.
		expect(panelAwareCenter(map, TARGET, 7)).toEqual({ lat: 250, lng: 200 });
	});

	it('counts only what the sheet hides of the map, not the bar below it', () => {
		// The fraction is of the workspace: with a 66px tab bar reserved under
		// the map, a half sheet is 333px tall and hides 267 of the map.
		uiMock.ui.detail = { kind: 'notam' };
		uiMock.ui.isMobile = true;
		uiMock.ui.detailHeight = 0.5;
		uiMock.ui.sheetPeekPx = 66;
		const { map } = fakeMap(800, 600);
		expect(panelAwareCenter(map, TARGET, 7)).toEqual({ lat: 100 + 267 / 2, lng: 200 });
	});

	it('clamps a very tall sheet at 70 % of the viewport', () => {
		uiMock.ui.detail = { kind: 'notam' };
		uiMock.ui.isMobile = true;
		uiMock.ui.detailHeight = 2;
		const { map } = fakeMap(800, 600);
		expect(panelAwareCenter(map, TARGET, 7)).toEqual({ lat: 100 + 210, lng: 200 });
	});
});

describe('fitBoundsVisible', () => {
	it('reserves the inset as extra bottom-right padding on top of base', () => {
		uiMock.ui.detail = { kind: 'notam' };
		uiMock.ui.isMobile = true;
		uiMock.ui.detailHeight = 0.5;
		const { map, fitBounds } = fakeMap(800, 600);
		const bounds = [
			[0, 0],
			[1, 1],
		] as unknown as L.LatLngBoundsExpression;
		fitBoundsVisible(map, bounds, 20, 11);
		expect(fitBounds).toHaveBeenCalledWith(bounds, {
			paddingTopLeft: [20, 20],
			paddingBottomRight: [20, 320],
			maxZoom: 11,
		});
	});

	it('degrades to plain base padding with nothing selected', () => {
		const { map, fitBounds } = fakeMap();
		fitBoundsVisible(map, [], 5);
		expect(fitBounds).toHaveBeenCalledWith([], {
			paddingTopLeft: [5, 5],
			paddingBottomRight: [5, 5],
			maxZoom: undefined,
		});
	});

	it('never reserves a whole axis, which would fit the world', () => {
		uiMock.ui.detail = { kind: 'notam' };
		uiMock.ui.isMobile = true;
		uiMock.ui.detailHeight = 0.9;
		// A short map: the sheet (clamped to 70 % = 280) plus 60 px top and
		// bottom would leave zero height to fit into, so the base shrinks to
		// keep a fifth of the axis for the target.
		const { map, fitBounds } = fakeMap(800, 400);
		fitBoundsVisible(map, [], 60);
		expect(fitBounds).toHaveBeenCalledWith([], {
			paddingTopLeft: [60, 20],
			paddingBottomRight: [60, 300],
			maxZoom: undefined,
		});
	});
});
