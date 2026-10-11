/* Holds the live Leaflet map instance and its viewport, shared across modules. */

import type { Map as LeafletMap } from 'leaflet';

export const mapState = $state<{
	map: LeafletMap | null;
	zoom: number;
	center: { lat: number; lng: number };
}>({
	map: null,
	zoom: 6,
	center: { lat: 48.8566, lng: 2.3522 },
});
