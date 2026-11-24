/* The raptor zones (ZSM) on the map, in the look of AIP France ENR 5.6-2's
 * sector maps: an opaque fill and a solid edge in one crimson, overlapping
 * zones one tone. Each zone active over the viewed time is drawn, the
 * others hidden; from zoom 10 each carries its overflight height, feet as
 * the altimeter reads and metres as the AIP states it, the labels pushed
 * apart where they would overlap. Non-interactive: featureAt resolves a
 * click through zsmAreaAt (map.md, "A filled area never takes the click").
 * The selected zone draws its edge heavy whatever the toggle. */

import L from 'leaflet';
import { zsmLabel, type Zsm } from '$lib/data/zsm';
import { ensurePane } from './directDrawLayer';
import { LABEL_HALO, ZSM_FILL, ZSM_INK } from './palette';
import { pointInRing } from '$lib/data/airspaces';

const PANE = 'zsm';
const PANE_Z = '345';
const LABEL_PANE = 'zsm-labels';
const LABEL_PANE_Z = '396';
export const ZSM_LABEL_MIN_ZOOM = 10;
/** The label's font, which its width is measured in. */
// i18n-ignore: a CSS font, no text
const LABEL_FONT = '600 11px system-ui, sans-serif';
const LABEL_LINE_PX = 13;

let layerMap: L.Map | null = null;
let drawn: readonly Zsm[] = [];
let visible = false;
let selected: Zsm | null = null;
const fills = L.layerGroup();
const labels = L.layerGroup();
const emphasis = L.layerGroup();
const hover = L.layerGroup();

/** Draw the zones active over the viewed time (the caller's choice). */
export function setZsmZones(map: L.Map, zones: readonly Zsm[]): void {
	ensurePane(map, PANE, PANE_Z);
	ensurePane(map, LABEL_PANE, LABEL_PANE_Z);
	const pane = map.getPane(LABEL_PANE);
	if (pane) {
		pane.style.pointerEvents = 'none';
	}
	if (layerMap !== map) {
		layerMap?.off('zoomend', placeLabels);
		layerMap = map;
		map.on('zoomend', placeLabels);
	}
	drawn = zones;
	fills.clearLayers();
	for (const z of zones) {
		L.polygon(z.ring, {
			pane: PANE,
			color: ZSM_INK,
			weight: 1,
			fillColor: ZSM_FILL,
			fillOpacity: 1,
			interactive: false,
		}).addTo(fills);
	}
	sync();
	highlightZsm(selected);
}

export function setZsmVisible(on: boolean): void {
	visible = on;
	sync();
}

/** Emphasise the selected zone (null to clear), drawn whatever the toggle:
 *  a selection always highlights (links-and-toggles.md). */
export function highlightZsm(z: Zsm | null): void {
	selected = z;
	emphasis.clearLayers();
	if (z && layerMap) {
		ensurePane(layerMap, PANE, PANE_Z);
		L.polygon(z.ring, { pane: PANE, color: ZSM_INK, weight: 3, fillColor: ZSM_FILL, fillOpacity: visible ? 1 : 0.35, interactive: false }).addTo(emphasis);
	}
	if (layerMap && !layerMap.hasLayer(emphasis)) {
		emphasis.addTo(layerMap);
	}
}

/** Outline a zone a list row points at (null to clear), whatever the
 *  toggle: a hovered row always highlights (links-and-toggles.md). */
export function hoverZsm(z: Zsm | null): void {
	hover.clearLayers();
	if (z && layerMap) {
		ensurePane(layerMap, PANE, PANE_Z);
		L.polygon(z.ring, { pane: PANE, color: ZSM_INK, weight: 3, fill: false, interactive: false }).addTo(hover);
		if (!layerMap.hasLayer(hover)) {
			hover.addTo(layerMap);
		}
	}
}

export function clearZsm(map: L.Map): void {
	map.off('zoomend', placeLabels);
	fills.remove();
	labels.remove();
	emphasis.remove();
	hover.remove();
	layerMap = null;
	drawn = [];
}

function sync(): void {
	if (!layerMap) {
		return;
	}
	if (visible) {
		fills.addTo(layerMap);
		labels.addTo(layerMap);
	} else {
		fills.remove();
		labels.remove();
	}
	placeLabels();
}

let measure: CanvasRenderingContext2D | null = null;

function textWidth(s: string): number {
	measure ??= document.createElement('canvas').getContext('2d');
	if (!measure) {
		return s.length * 6;
	}
	measure.font = LABEL_FONT;
	return measure.measureText(s).width;
}

/** One label per drawn zone at its centre, each pushed down by a line
 *  where it would overlap one placed above it (the vertical pass of the
 *  route profile's band labels). Positions are layer points, so a pan
 *  moves them with the map and only a zoom places them again. */
function placeLabels(): void {
	labels.clearLayers();
	if (!layerMap || !visible || layerMap.getZoom() < ZSM_LABEL_MIN_ZOOM) {
		return;
	}
	const items = drawn
		.map((z) => {
			const text = zsmLabel(z.overflyM);
			const p = layerMap!.latLngToLayerPoint(centre(z.ring));
			const w = textWidth(text);
			return { text, x: p.x - w / 2, y: p.y - LABEL_LINE_PX / 2, w, at: centre(z.ring) };
		})
		.sort((a, b) => a.y - b.y || a.x - b.x);
	const placed: { x: number; y: number; w: number }[] = [];
	for (const it of items) {
		let y = it.y;
		for (;;) {
			const hit = placed.find((q) => it.x < q.x + q.w && q.x < it.x + it.w && y < q.y + LABEL_LINE_PX && q.y < y + LABEL_LINE_PX);
			if (!hit) {
				break;
			}
			y = hit.y + LABEL_LINE_PX;
		}
		placed.push({ x: it.x, y, w: it.w });
		L.marker(it.at, {
			pane: LABEL_PANE,
			interactive: false,
			keyboard: false,
			icon: L.divIcon({
				className: 'zsm-label',
				// i18n-ignore: markup around a height label, its units ICAO's in both languages
				html: `<span style="font:${LABEL_FONT};white-space:nowrap;color:${ZSM_INK};text-shadow:0 0 2px ${LABEL_HALO},0 0 3px ${LABEL_HALO}">${it.text}</span>`,
				iconSize: [Math.ceil(it.w), LABEL_LINE_PX],
				iconAnchor: [Math.ceil(it.w / 2), Math.round(LABEL_LINE_PX / 2 - (y - it.y))],
			}),
		}).addTo(labels);
	}
}

function centre(ring: readonly [number, number][]): L.LatLng {
	let lat = 0;
	let lon = 0;
	for (const [a, b] of ring) {
		lat += a;
		lon += b;
	}
	return L.latLng(lat / ring.length, lon / ring.length);
}

/** The smallest drawn zone under a point, and its area: the area tier of
 *  featureAt. Null with the layer off: the left click hits what is drawn. */
export function zsmAreaAt(lat: number, lon: number): { zone: Zsm; areaM2: number } | null {
	if (!visible) {
		return null;
	}
	let best: Zsm | null = null;
	for (const z of drawn) {
		if (lat < z.bbox.minLat || lat > z.bbox.maxLat || lon < z.bbox.minLon || lon > z.bbox.maxLon) {
			continue;
		}
		if (pointInRing(lat, lon, z.ring) && (!best || z.areaM2 < best.areaM2)) {
			best = z;
		}
	}
	return best ? { zone: best, areaM2: best.areaM2 } : null;
}
