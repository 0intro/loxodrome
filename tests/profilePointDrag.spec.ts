/* The map profile's crosshair holds follow mode while it is dragged, as a
 * route pin does (map/routeDragEvents.ts). Follow pans the map whenever the
 * aircraft drifts 12 px, and Leaflet places a dragged icon by the pointer's
 * travel in layer space, so a pan under the drag moved the crosshair off
 * the finger and re-cut the profile at a point nobody pointed at. Driven on
 * Leaflet's own marker in Node (tests/helpers/leafletNode.ts). */

import { describe, expect, it } from 'vitest';
import { installLeafletNode } from './helpers/leafletNode';

const env = installLeafletNode();
const L = (await import('leaflet')).default;
const { syncProfilePoint, clearProfilePoint } = await import('$lib/map/profilePointLayer');
const { ROUTE_DRAG_END, ROUTE_DRAG_START } = await import('$lib/map/routeDragEvents');

function crosshairOf(map: L.Map): L.Marker {
	let found: L.Marker | null = null;
	map.eachLayer((layer) => {
		if (layer instanceof L.Marker) {
			found = layer;
		}
	});
	if (!found) {
		throw new Error('no crosshair on the map');
	}
	return found;
}

describe("the map profile's crosshair", () => {
	it('announces its drag on the map, as a route pin does', () => {
		const map = L.map(env.container(800, 600) as unknown as HTMLElement, {
			zoomControl: false,
			attributionControl: false,
			zoomAnimation: false,
			fadeAnimation: false,
			markerZoomAnimation: false,
			trackResize: false,
		}).setView([48.75, 2.2], 10);
		const heard: string[] = [];
		map.on(ROUTE_DRAG_START, () => heard.push('start'));
		map.on(ROUTE_DRAG_END, () => heard.push('end'));
		syncProfilePoint(map, { lat: 48.75, lng: 2.2 }, 'Altitude profile');
		const crosshair = crosshairOf(map);
		crosshair.fire('dragstart');
		expect(heard).toEqual(['start']);
		crosshair.fire('dragend');
		expect(heard).toEqual(['start', 'end']);
		clearProfilePoint(map);
	});
});
