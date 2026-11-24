/* fitRoute frames the active route clear of what covers the map: the open
 * desktop detail panel on the right, and the foot's strips (the replay, the
 * radar) at the bottom, as every other fit does (map/focus.ts
 * fitBoundsClear). It fitted the route to the whole container with a flat
 * 40 px, its east end under the panel and its south end under the replay
 * strip FlightsModal shows beside it. The panel and the foot are stand-ins
 * here: a document whose `.detail` and `.map-foot > *` boxes a case sets,
 * the map a stub recording its fit. */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type L from 'leaflet';

class FakeElement {
	offsetWidth = 0;
	top = 0;
	getBoundingClientRect(): { top: number; bottom: number } {
		return { top: this.top, bottom: this.top };
	}
}
(globalThis as { HTMLElement?: unknown }).HTMLElement = FakeElement;
const panel = new FakeElement();
const footStrip = new FakeElement();
const page = { panelOpen: false, footOpen: false };
(globalThis as { document?: unknown }).document = {
	querySelector: (sel: string) => (sel === '.detail' && page.panelOpen ? panel : null),
};
afterAll(() => {
	delete (globalThis as { document?: unknown }).document;
	delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
});

vi.mock('leaflet', () => ({ default: { latLng: (t: unknown) => t } }));
const mapMock = vi.hoisted(() => ({ mapState: { map: null as L.Map | null } }));
vi.mock('$lib/state/map.svelte', () => mapMock);
const uiMock = vi.hoisted(() => ({ ui: { detail: null as { kind: string } | null, isMobile: false } }));
vi.mock('$lib/state/ui.svelte', () => uiMock);
vi.mock('$lib/state/workspace.svelte', () => ({
	workspace: { dockBottom: null, dockRight: null, dockPx: { bottom: 0, right: 0 }, stage: { w: 800, h: 600 } },
}));
const routeMock = vi.hoisted(() => ({ waypoints: [] as { lat: number; lon: number }[] }));
vi.mock('$lib/state/route.svelte', () => ({ activeRoute: () => ({ waypoints: routeMock.waypoints }) }));

import { fitRoute } from '$lib/components/tabs/route/fitRoute';

/** An 800 by 600 map whose container stands at the page origin, inside a
 *  wrap holding the foot's strips while they are up. */
function fakeMap(): { fitBounds: ReturnType<typeof vi.fn> } {
	const fitBounds = vi.fn();
	const wrap = { querySelectorAll: (sel: string) => (sel === '.map-foot > *' && page.footOpen ? [footStrip] : []) };
	mapMock.mapState.map = {
		getSize: () => ({ x: 800, y: 600 }),
		getZoom: () => 9,
		getContainer: () => ({ parentElement: wrap, getBoundingClientRect: () => ({ top: 0, bottom: 600 }) }),
		fitBounds,
	} as unknown as L.Map;
	return { fitBounds };
}

beforeEach(() => {
	page.panelOpen = false;
	page.footOpen = false;
	uiMock.ui.detail = null;
	routeMock.waypoints = [
		{ lat: 48.75, lon: 2.11 },
		{ lat: 49.45, lon: 2.11 },
	];
});

describe('fitRoute', () => {
	it('keeps 40 px on every side of a map with nothing over it', () => {
		const { fitBounds } = fakeMap();
		fitRoute();
		expect(fitBounds).toHaveBeenCalledWith(
			[
				[48.75, 2.11],
				[49.45, 2.11],
			],
			{ paddingTopLeft: [40, 40], paddingBottomRight: [40, 40] },
		);
	});

	it('frames the route clear of the open detail panel and the replay strip', () => {
		const { fitBounds } = fakeMap();
		uiMock.ui.detail = { kind: 'airport' };
		page.panelOpen = true;
		panel.offsetWidth = 300;
		page.footOpen = true;
		footStrip.top = 540;
		fitRoute();
		expect(fitBounds.mock.calls[0][1]).toEqual({ paddingTopLeft: [40, 40], paddingBottomRight: [340, 100] });
	});
});
