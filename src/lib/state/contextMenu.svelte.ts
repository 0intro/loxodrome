/* State for the right-click context menu: the features gathered at the click
 * (a ContextFeatures, the same set contextFeaturesAt returns) plus the click
 * position. The menu always opens on a map right-click (at minimum to copy the
 * coordinate), so every feature list may be empty and leg null. lat/lng are the
 * geographic click point (for "Copy coordinates"); x/y are screen-space
 * (clientX / clientY) so the component can position itself directly. */

import type { ContextFeatures } from '$lib/map/interactions';

export const contextMenu = $state<
	ContextFeatures & {
		open: boolean;
		lat: number;
		lng: number;
		x: number;
		y: number;
	}
>({
	open: false,
	notams: [],
	stations: [],
	airports: [],
	navaids: [],
	airspaces: [],
	obstacles: [],
	supaips: [],
	sigmets: [],
	waypoints: [],
	leg: null,
	lat: 0,
	lng: 0,
	x: 0,
	y: 0,
});

/** Populate the menu from the features gathered at the click (contextFeaturesAt)
 *  plus the geographic (lat/lng) and screen-space (x/y) click position. New
 *  ContextFeatures fields flow in automatically via the copy. */
export function openContextMenu(
	features: ContextFeatures,
	lat: number,
	lng: number,
	x: number,
	y: number,
): void {
	Object.assign(contextMenu, features);
	contextMenu.lat = lat;
	contextMenu.lng = lng;
	contextMenu.x = x;
	contextMenu.y = y;
	contextMenu.open = true;
}

export function closeContextMenu(): void {
	contextMenu.open = false;
	contextMenu.notams = [];
	contextMenu.stations = [];
	contextMenu.airports = [];
	contextMenu.navaids = [];
	contextMenu.airspaces = [];
	contextMenu.obstacles = [];
	contextMenu.supaips = [];
	contextMenu.sigmets = [];
	contextMenu.waypoints = [];
	contextMenu.leg = null;
}
