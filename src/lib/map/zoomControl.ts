/* zoomControl.ts: the zoom control's titles, rewritten IN PLACE on a locale
 * change.
 *
 * Leaflet bakes a control's titles at creation, so the map used to remove the
 * zoom control and add a new one whenever the language changed. `addTo`
 * APPENDS to its corner, so the new zoom landed under the in-flight recentre
 * control (map/navLayer.ts), and a language switch swapped the two. The
 * titles are all that changes: they are written on the control's own two
 * links, title and aria-label as Leaflet set them, and in its options, which
 * Leaflet would rebuild them from. Map modules import no catalogs: the
 * caller hands the words in. */

import type L from 'leaflet';

export interface ZoomTitles {
	zoomInTitle: string;
	zoomOutTitle: string;
}

export function retitleZoom(ctl: L.Control.Zoom, titles: ZoomTitles): void {
	ctl.options.zoomInTitle = titles.zoomInTitle;
	ctl.options.zoomOutTitle = titles.zoomOutTitle;
	const box = ctl.getContainer();
	if (!box) {
		return;
	}
	const links: [string, string][] = [
		['.leaflet-control-zoom-in', titles.zoomInTitle],
		['.leaflet-control-zoom-out', titles.zoomOutTitle],
	];
	for (const [sel, title] of links) {
		const a = box.querySelector(sel);
		if (a) {
			a.setAttribute('title', title);
			a.setAttribute('aria-label', title);
		}
	}
}
