/* The airspace decoration layer's teardown (map/airspaceDecoLayer.ts,
 * clearAirspaceDecoLayer), run on Leaflet itself in Node
 * (tests/helpers/leafletNode.ts).
 *
 * The layer is a module singleton that buildAirspaceDecoLayer creates once.
 * Nothing took it down, so a view mounted a second time (a remount, a hot
 * reload) found it already built on the DEAD map and built nothing: the new
 * map had no decorations at all, and the boundary layer's repaint listener
 * still pointed at the old canvas. What this pins: built on map A, cleared,
 * built on map B, the canvas is on B alone and a change of emphasis repaints
 * B's canvas and never A's. */

import { describe, expect, it } from 'vitest';
import type { Map as LeafletMap } from 'leaflet';
import { FakeCanvas, FakeElement, installLeafletNode } from './helpers/leafletNode';

const env = installLeafletNode();
const L = (await import('leaflet')).default;
const { buildAirspaceLayer, clearAirspaceLayer, highlightAirspace } = await import('$lib/map/airspaceLayer');
const { buildAirspaceDecoLayer, clearAirspaceDecoLayer } = await import('$lib/map/airspaceDecoLayer');

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
};

/** A map over Paris at z9 with the airspace layer (no rows) and its
 *  decoration built on it, the order both views build them in. */
function mount(): LeafletMap {
	const map = L.map(env.container(800, 600) as unknown as HTMLElement, MAP_OPTIONS).setView([48.8, 2.3], 9);
	buildAirspaceLayer(map, []);
	buildAirspaceDecoLayer(map);
	return map;
}

/** Both views' teardown, before map.remove(). */
function unmount(map: LeafletMap): void {
	clearAirspaceLayer();
	clearAirspaceDecoLayer();
	map.remove();
}

/** The decoration canvases in the map's decoration pane. */
function decoCanvases(map: LeafletMap): FakeCanvas[] {
	const pane = map.getPane('airspaces-deco') as unknown as FakeElement | undefined;
	return (pane?.childNodes ?? []).filter((c): c is FakeCanvas => c instanceof FakeCanvas);
}

/** Let the layer's coalesced paint (a microtask) run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('clearAirspaceDecoLayer', () => {
	it('lets a second map get its own decoration layer, which alone repaints', async () => {
		const a = mount();
		expect(decoCanvases(a)).toHaveLength(1);
		const [canvasA] = decoCanvases(a);
		await settle();
		unmount(a);
		expect(decoCanvases(a)).toEqual([]);

		const b = mount();
		expect(decoCanvases(b)).toHaveLength(1);
		const [canvasB] = decoCanvases(b);
		expect(canvasB).not.toBe(canvasA);
		await settle();
		const paintsA = canvasA.ctx.clears.length;
		const paintsB = canvasB.ctx.clears.length;
		// A change of emphasis reaches the live layer through the boundary
		// layer's repaint listener, and only the live layer.
		highlightAirspace('LFR45');
		await settle();
		expect(canvasB.ctx.clears.length).toBe(paintsB + 1);
		expect(canvasA.ctx.clears.length).toBe(paintsA);
		unmount(b);
	});

	it('leaves nothing listening once the views are torn down', async () => {
		const a = mount();
		await settle();
		const [canvasA] = decoCanvases(a);
		unmount(a);
		const paints = canvasA.ctx.clears.length;
		highlightAirspace('LFR46');
		await settle();
		expect(canvasA.ctx.clears.length).toBe(paints);
	});
});
