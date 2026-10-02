/* Pins the panel-aware centring math of map/focus.ts: with nothing
 * selected the helpers behave exactly like the bare Leaflet calls, the
 * phone's pane (a DOCK) shifts the target by half of what the map has not
 * yet given up to it in the tick of the open (nothing once the container
 * has shrunk; clamped at 70 % of the viewport), and the fit/fly bounds
 * variants reserve the inset as extra bottom-right padding. The desktop branch
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
	},
}));
vi.mock('$lib/state/ui.svelte', () => uiMock);

const wsMock = vi.hoisted(() => ({
	workspace: {
		dockBottom: null as string | null,
		dockRight: null as string | null,
		dockPx: { bottom: 0, right: 0 },
		stage: { w: 800, h: 600 },
	},
}));
vi.mock('$lib/state/workspace.svelte', () => wsMock);

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
	wsMock.workspace.dockBottom = null;
	wsMock.workspace.dockRight = null;
	wsMock.workspace.dockPx = { bottom: 0, right: 0 };
	wsMock.workspace.stage = { w: 800, h: 600 };
});

describe('panelAwareCenter', () => {
	it('is the bare target while nothing is selected', () => {
		const { map } = fakeMap();
		expect(panelAwareCenter(map, TARGET, 7)).toEqual(TARGET);
	});

	it('shifts the centre down by half of what the pane is about to take', () => {
		// The pane opened at 270 px in the same tick: the map still measures
		// the whole 600 px stage, so 270 of it are about to go under the pane
		// and the centre moves +135 in y.
		uiMock.ui.isMobile = true;
		wsMock.workspace.dockBottom = 'detail';
		wsMock.workspace.dockPx = { bottom: 270, right: 0 };
		const { map } = fakeMap(800, 600);
		expect(panelAwareCenter(map, TARGET, 7)).toEqual({ lat: 235, lng: 200 });
	});

	it('hides nothing once the container has given the strip up', () => {
		uiMock.ui.detail = { kind: 'notam' };
		uiMock.ui.isMobile = true;
		wsMock.workspace.dockBottom = 'detail';
		wsMock.workspace.dockPx = { bottom: 270, right: 0 };
		const { map } = fakeMap(800, 330);
		expect(panelAwareCenter(map, TARGET, 7)).toEqual(TARGET);
	});

	it('reads the pane whatever it holds, not only a detail', () => {
		uiMock.ui.isMobile = true;
		wsMock.workspace.dockBottom = 'navlog';
		wsMock.workspace.dockPx = { bottom: 200, right: 0 };
		const { map } = fakeMap(800, 600);
		expect(panelAwareCenter(map, TARGET, 7)).toEqual({ lat: 200, lng: 200 });
	});

	it('is the bare target on a phone with no pane', () => {
		uiMock.ui.detail = { kind: 'notam' };
		uiMock.ui.isMobile = true;
		const { map } = fakeMap(800, 600);
		expect(panelAwareCenter(map, TARGET, 7)).toEqual(TARGET);
	});

	it('shifts sideways for the landscape pane on the right', () => {
		uiMock.ui.isMobile = true;
		wsMock.workspace.dockRight = 'detail';
		wsMock.workspace.dockPx = { bottom: 0, right: 320 };
		const { map } = fakeMap(800, 380);
		expect(panelAwareCenter(map, TARGET, 7)).toEqual({ lat: 100, lng: 360 });
	});

	it('clamps a pane the stage has not measured yet, and a huge one, at 70 %', () => {
		uiMock.ui.isMobile = true;
		wsMock.workspace.dockBottom = 'detail';
		wsMock.workspace.dockPx = { bottom: 590, right: 0 };
		const { map } = fakeMap(800, 600);
		expect(panelAwareCenter(map, TARGET, 7)).toEqual({ lat: 100 + 210, lng: 200 });
		wsMock.workspace.stage = { w: 0, h: 0 };
		expect(panelAwareCenter(map, TARGET, 7)).toEqual(TARGET);
	});
});

describe('fitBoundsVisible', () => {
	it('reserves the inset as extra bottom-right padding on top of base', () => {
		uiMock.ui.detail = { kind: 'notam' };
		uiMock.ui.isMobile = true;
		wsMock.workspace.dockBottom = 'detail';
		wsMock.workspace.dockPx = { bottom: 300, right: 0 };
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
		wsMock.workspace.dockBottom = 'detail';
		wsMock.workspace.dockPx = { bottom: 590, right: 0 };
		// A short map: the pane (clamped to 70 % = 280) plus 60 px top and
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
