/* The band inside a temporary zone that may be active, the chart's sign for
 * a zone to check before entering (docs/zone-activity.md, "The map"): the
 * chart's hatch band in the zone's ink, drawn by the SUP AIP layer and the
 * NOTAM layer alike. The band is a stroke of twice the chart's band depth,
 * its inner half kept by a clip path holding a <use> of the zone's own
 * outline, so the clip follows every redraw Leaflet makes of that path. One
 * hidden svg in the document holds the clips. */

import type L from 'leaflet';
import { bandZoomFactor } from './airspaceSymbology';

const SVGNS = 'http://www.w3.org/2000/svg';
/** The chart's hatch band (airspaceSymbology.ts BAND_HATCH_PX, 13 px along a
 *  horizontal edge) as a depth: 9.2 px at zoom 10 and over. */
const BAND_DEPTH_PX = 13 / Math.SQRT2;
/** The thinnest band stroke, at the lowest zooms. */
const MIN_BAND_PX = 4;

/** The dash of a temporary zone's outline when it becomes active or may be
 *  active later in the viewing period. */
export const LATER_DASH = '6 4';

let defs: SVGDefsElement | null = null;
let seq = 0;

/** The band's stroke at `zoom`: twice the chart's band depth at the chart's
 *  band factor, never under MIN_BAND_PX. */
export function bandWeight(zoom: number): number {
	return Math.max(MIN_BAND_PX, 2 * BAND_DEPTH_PX * bandZoomFactor(zoom));
}

function host(): SVGDefsElement {
	if (!defs) {
		const svg = document.createElementNS(SVGNS, 'svg');
		svg.setAttribute('aria-hidden', 'true');
		svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none';
		defs = document.createElementNS(SVGNS, 'defs');
		svg.appendChild(defs);
		document.body.appendChild(svg);
	}
	return defs;
}

/** Keep the inner half of `band` inside `outline`, both on the map. Returns
 *  the clip path, which the caller removes with the band; null when either
 *  path has no element. */
export function clipBand(outline: L.Path, band: L.Path): SVGClipPathElement | null {
	const shape = outline.getElement() as SVGPathElement | null;
	const el = band.getElement() as SVGElement | null;
	if (!shape || !el) {
		return null;
	}
	const id = `zone-band-${seq++}`;
	shape.id = `${id}-shape`;
	const clip = document.createElementNS(SVGNS, 'clipPath');
	clip.id = id;
	clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
	const use = document.createElementNS(SVGNS, 'use');
	use.setAttribute('href', `#${shape.id}`);
	use.setAttribute('clip-rule', 'evenodd');
	clip.appendChild(use);
	host().appendChild(clip);
	el.setAttribute('clip-path', `url(#${id})`);
	return clip;
}
