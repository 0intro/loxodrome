/* Centre the map on a target while keeping clear of the detail surface.
 *
 * The detail panel (DetailPanel.svelte) covers part of the map while open:
 * on desktop it is pinned to the workspace's right edge and hides its own
 * width; on phones it is a bottom sheet and hides its own height. A plain
 * flyTo / fitBounds centres the target in the *full* container, so it lands
 * under the panel rather than in the part the user can actually see. These
 * helpers shift the target by half the covered width / height so it ends
 * up centred in the visible strip. When nothing is selected the inset is 0
 * and they behave exactly like the bare Leaflet calls. */

import L from 'leaflet';
import type {
	LatLng,
	LatLngBoundsExpression,
	LatLngExpression,
	Map as LeafletMap,
} from 'leaflet';
import { mapState } from '$lib/state/map.svelte';
import { ui } from '$lib/state/ui.svelte';
import { workspace } from '$lib/state/workspace.svelte';

/** Map area in px currently hidden by the detail surface, 0 when nothing is
 *  selected: on desktop the right-side panel hides its own width (x), on
 *  phones the bottom detail sheet hides its own height (y). Open-ness is
 *  read from ui.detail (set synchronously by a selection, so a
 *  freshly-selected target counts before the slide-in transition has run);
 *  the desktop width comes from the panel's laid-out box (offsetWidth is the
 *  panel width regardless of the transform).
 *
 *  The mobile height is ui.detailHeight of the WORKSPACE, which is how the
 *  sheet itself is sized, and what it hides of the map is that height less
 *  everything reserved below the map: the phone's tab bar and any bottom
 *  dock. Taking the fraction of the map alone counted those twice and left
 *  "centred" targets behind the sheet. Clamped so a very large panel can't
 *  shove the target off the visible strip entirely. */
function panelInset(map: LeafletMap): { x: number; y: number } {
	if (!ui.detail || typeof document === 'undefined') {
		return { x: 0, y: 0 };
	}
	if (ui.isMobile) {
		const size = map.getSize().y;
		const below = workspace.dockPx.bottom + ui.sheetPeekPx;
		const sheet = (size + below) * ui.detailHeight - below;
		return { x: 0, y: Math.min(Math.max(0, sheet), size * 0.7) };
	}
	const el = document.querySelector('.detail');
	if (!(el instanceof HTMLElement)) {
		return { x: 0, y: 0 };
	}
	return { x: Math.min(el.offsetWidth, map.getSize().x * 0.7), y: 0 };
}

/** Shift `target` so that, at `zoom`, it sits at the centre of the map area
 *  the detail panel does not cover. */
export function panelAwareCenter(
	map: LeafletMap,
	target: LatLngExpression,
	zoom: number,
): LatLng {
	const inset = panelInset(map);
	if (inset.x === 0 && inset.y === 0) {
		return L.latLng(target);
	}
	// Move the centre right / down by half the hidden width / height: the
	// content then shifts the other way by the same amount, bringing the
	// target to the visible strip's centre.
	const point = map.project(target, zoom).add([inset.x / 2, inset.y / 2]);
	return map.unproject(point, zoom);
}

/** flyTo, centred clear of the detail panel. No-op without a live map. */
export function flyToVisible(target: LatLngExpression, zoom?: number): void {
	const map = mapState.map;
	if (!map) {
		return;
	}
	const z = zoom ?? map.getZoom();
	map.flyTo(panelAwareCenter(map, target, z), z);
}

/** Share of an axis the padding may reserve. Leaflet fits into what is left
 *  of the map size after the padding, and an axis reserved whole scales to
 *  log(0), which clamps to the map's MINIMUM zoom: the fit flies to the
 *  whole world. A short map (landscape phone, or the strip a bottom dock
 *  leaves) plus a tall detail sheet reaches that, so the target keeps a
 *  fifth of each axis whatever is asked for. */
const MAX_PADDING_SHARE = 0.8;

/** Leaflet padding options that keep the detail surface clear: `base` px on
 *  every side plus the surface's own width / height bottom-right, each axis
 *  clamped to MAX_PADDING_SHARE with the inset served first (the panel is
 *  what must stay clear; panelInset already caps it at 70 %). */
function boundsPadding(
	map: LeafletMap,
	base: number,
): { paddingTopLeft: [number, number]; paddingBottomRight: [number, number] } {
	const inset = panelInset(map);
	const size = map.getSize();
	const axis = (budget: number, insetPx: number): [number, number] => {
		const kept = Math.min(insetPx, budget);
		return [Math.max(0, Math.min(base, (budget - kept) / 2)), kept];
	};
	const [baseX, insetX] = axis(size.x * MAX_PADDING_SHARE, inset.x);
	const [baseY, insetY] = axis(size.y * MAX_PADDING_SHARE, inset.y);
	return {
		paddingTopLeft: [baseX, baseY],
		paddingBottomRight: [baseX + insetX, baseY + insetY],
	};
}

/** fitBounds, kept clear of the detail surface by reserving its width /
 *  height as extra right / bottom padding (on top of `base` px on every
 *  side). `maxZoom` caps how far a small bbox zooms in (undefined = no cap,
 *  the Leaflet default). */
export function fitBoundsVisible(
	map: LeafletMap,
	bounds: LatLngBoundsExpression,
	base = 0,
	maxZoom?: number,
): void {
	map.fitBounds(bounds, { ...boundsPadding(map, base), maxZoom });
}

/** flyToBounds, kept clear of the detail surface (see fitBoundsVisible). */
export function flyToBoundsVisible(
	map: LeafletMap,
	bounds: LatLngBoundsExpression,
	base = 0,
	maxZoom?: number,
): void {
	map.flyToBounds(bounds, { ...boundsPadding(map, base), maxZoom });
}
