/* Centre the map on a target while keeping clear of the detail surface.
 *
 * The desktop's detail panel (DetailPanel.svelte) covers part of the map
 * while open: pinned to the workspace's right edge, it hides its own width.
 * A plain flyTo / fitBounds centres the target in the *full* container, so
 * it lands under the panel rather than in the part the user can actually
 * see. These helpers shift the target by half the covered width so it ends
 * up centred in the visible strip. When nothing is selected the inset is 0
 * and they behave exactly like the bare Leaflet calls. On a phone the pane
 * (the nav log, a profile, the detail) is a dock, and the inset is the strip
 * the map has not yet handed over in the tick of the open (panelInset). */

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
 *  selected: on desktop the right-side panel hides its own width (x); on
 *  phones the pane's dock hides the strip the map has not yet given up (see
 *  the mobile branch). Open-ness is read from ui.detail (set synchronously
 *  by a selection, so a freshly-selected target counts before the slide-in
 *  transition has run); the desktop width comes from the panel's laid-out
 *  box (offsetWidth is the panel width regardless of the transform).
 *  Clamped so a very large panel can't shove the target off the visible
 *  strip entirely. */
function panelInset(map: LeafletMap): { x: number; y: number } {
	if (typeof document === 'undefined') {
		return { x: 0, y: 0 };
	}
	if (ui.isMobile) {
		/* The phone's pane is a DOCK, reserved space rather than an overlay,
		 * so in the steady state it hides nothing: the map container has
		 * already given the strip up. What it hides is only what the
		 * container has not yet given up in THIS tick: a fly called in the
		 * same tick as the open (a row tap that opens the pane and flies to
		 * its subject) still sees the map at its old size, and the difference
		 * between that and the strip the stage leaves beside the dock is
		 * exactly the band about to disappear under the pane. Read for every
		 * pane occupant (the nav log's rows fly the map too), not only a
		 * detail. */
		const size = map.getSize();
		const { w: stageW, h: stageH } = workspace.stage;
		const y =
			workspace.dockBottom !== null && stageH > 0
				? Math.max(0, size.y - (stageH - workspace.dockPx.bottom))
				: 0;
		const x =
			workspace.dockRight !== null && stageW > 0
				? Math.max(0, size.x - (stageW - workspace.dockPx.right))
				: 0;
		return { x: Math.min(x, size.x * 0.7), y: Math.min(y, size.y * 0.7) };
	}
	if (!ui.detail) {
		return { x: 0, y: 0 };
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

/** How much of the map its own chrome covers, CSS px: the band over its top
 *  (NavStrip) and the foot (MapView's .map-foot: the replay and radar strips,
 *  or the chips they fold into). Read off the laid-out boxes rather than the
 *  height the foot publishes, which a binding writes a frame later: a fit
 *  made in the flush that brought them up sees them. Both layouts: the
 *  replay strip rides the desktop map too. */
function chromeInsets(map: LeafletMap): { top: number; bottom: number } {
	if (typeof document === 'undefined') {
		return { top: 0, bottom: 0 };
	}
	const container = map.getContainer();
	const wrap = container.parentElement;
	if (!wrap) {
		return { top: 0, bottom: 0 };
	}
	const box = container.getBoundingClientRect();
	let top = 0;
	let bottom = 0;
	for (const el of wrap.querySelectorAll('.nav-strip')) {
		top = Math.max(top, el.getBoundingClientRect().bottom - box.top);
	}
	// The foot's children, not the foot: an empty foot is a zero-height box
	// sitting at its own offset, which would read as chrome.
	for (const el of wrap.querySelectorAll('.map-foot > *')) {
		bottom = Math.max(bottom, box.bottom - el.getBoundingClientRect().top);
	}
	return { top: Math.max(0, top), bottom: Math.max(0, bottom) };
}

/** fitBoundsVisible that also keeps clear of the map's own chrome
 *  (chromeInsets): a trace fitted for its replay lands whole in the map the
 *  pilot can see, between the band and the replay strip. The chrome gives
 *  way in proportion before the padding would take more than
 *  MAX_PADDING_SHARE of the height (its reason: the fit to the whole world). */
export function fitBoundsClear(map: LeafletMap, bounds: LatLngBoundsExpression, base = 0): void {
	const { paddingTopLeft, paddingBottomRight } = boundsPadding(map, base);
	const chrome = chromeInsets(map);
	const top = paddingTopLeft[1] + chrome.top;
	const bottom = paddingBottomRight[1] + chrome.bottom;
	const budget = map.getSize().y * MAX_PADDING_SHARE;
	const k = top + bottom > budget ? budget / (top + bottom) : 1;
	map.fitBounds(bounds, {
		paddingTopLeft: [paddingTopLeft[0], top * k],
		paddingBottomRight: [paddingBottomRight[0], bottom * k],
	});
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
