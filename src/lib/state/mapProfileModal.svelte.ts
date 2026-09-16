/* State for the map's right-click "Altitude profile here" action: the
 * geographic click point. The singleton surface (MapProfileModal, mounted once
 * in App.svelte) derives the airspace stack from the point and the global
 * "all vs on-map" profile setting, so it stays in sync with the toggle while
 * open. Open-ness is the workspace slot; see aboutModal.svelte.ts.
 *
 * The detail panel's own altitude profile is the separate `airspaceProfile`
 * surface (components/detail/AltitudeProfile.svelte): same chart, different
 * question, so each is addressable on its own. */

import { closeSurface, isOpen, openSurface } from './workspace.svelte';

/** The geographic point a profile is taken over. */
export interface ProfilePoint {
	lat: number;
	lng: number;
}

const local = $state<{ point: ProfilePoint | null }>({ point: null });

export const mapProfileModal = {
	get open(): boolean {
		return isOpen('mapProfile');
	},
	/** The profiled point, null while the surface is not up, so the marker on
	 *  the map goes when the surface does. Gated on open-ness rather than
	 *  cleared by closeMapProfile: an eviction landing before SurfaceShell has
	 *  registered its handler, and reflowSurfaces' non-interactive close on a
	 *  viewport flip, both go through closeSurface directly. */
	get point(): ProfilePoint | null {
		return isOpen('mapProfile') ? local.point : null;
	},
};

/** Open the altitude profile for a geographic point. The surface derives the
 *  airspace stack itself (the full dataset at the point, then the global
 *  profile filter), so it needn't be pre-computed or pre-sorted here. */
export function openMapProfile(lat: number, lng: number): void {
	local.point = { lat, lng };
	openSurface('mapProfile');
}

/** Re-target an already open profile: the map marker's drag. Deliberately not
 *  openMapProfile, whose openSurface runs place(), which vacates and re-claims
 *  the slot and re-derives the dock size from localStorage on every call. Inert
 *  while closed, so a late dragend leaves no phantom point for the next open to
 *  render (openMapProfile writes the point before it claims the slot). */
export function setMapProfilePoint(lat: number, lng: number): void {
	if (!isOpen('mapProfile')) {
		return;
	}
	// A fresh object per move: one invalidation, and never a half-updated point.
	local.point = { lat, lng };
}

export function closeMapProfile(): void {
	closeSurface('mapProfile');
}
