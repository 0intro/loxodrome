/* SUP AIP overlay: draws each supplement's named sub-zones (polygon,
 * multipolygon, or circle) on their own map pane, below the NOTAM features,
 * by state (state/supaip.svelte.ts supLayerZones): a zone active on its own
 * published period hatched whole; a zone that may be active as its outline
 * and a hatched band inside it, the chart's sign for a zone to check before
 * entering; a zone active later in the period as a dashed outline. A zone a
 * NOTAM or the pilot's note activates is the activation hatch's
 * (supaipActivationLayer.ts), drawn whatever the toggle, and an inactive
 * one is drawn by neither. The layer is re-synced whenever that
 * set or the selection changes, and a sync carrying the set already drawn
 * is skipped; the selected zone is drawn highlighted, and is drawn even when
 * the toggle is off so selecting a zone from a NOTAM panel still shows it. */

import L from 'leaflet';
import { pointInRing } from '$lib/data/airspaces';
import {
	exclusionSpan,
	type SupAipExclusion,
	type SupAipGeometry,
	type SupAipZone,
	type SupBbox,
} from '$lib/data/supaip';
import { destinationPoint } from '$lib/notam/geometry';
import type { DrawnSupZone, VisibleZone } from '$lib/state/supaip.svelte';
import { flyToBoundsVisible } from './focus';
import { bandWeight, clipBand, LATER_DASH } from './zoneBand';

const SUPAIP_PANE = 'supaip';

let group: L.LayerGroup | null = null;
let hoverGroup: L.LayerGroup | null = null;
let mapRef: L.Map | null = null;
// The bands drawn, restyled to the zoom, and the clip paths keeping their
// inner half (zoneBand.ts).
const bands: L.Path[] = [];
const clips: SVGClipPathElement[] = [];
// The set last drawn. visibleSupaipZones rides the minute tick (the
// evaluation window's default end is open), so syncSupaipLayer is called once
// a minute with an unchanged set; the ordered zone keys plus the selection
// identify the drawing, since geometry is immutable per dataset load.
let drawnSig: string | null = null;

function ensureSupaipPane(map: L.Map): void {
	if (!map.getPane(SUPAIP_PANE)) {
		// Above the airspace overlays (350-370), below the NOTAM areas (450).
		map.createPane(SUPAIP_PANE).style.zIndex = '360';
	}
}

function areaStyle(highlight: boolean): L.PathOptions {
	return {
		pane: SUPAIP_PANE,
		// Non-interactive so a click falls through to the map's manual
		// hit-test (interactions.ts), where airports / navaids / obstacles
		// above the SUP AIP pane resolve first and a SUP zone is selected only
		// when nothing higher is there. Mirrors the airspace overlay.
		interactive: false,
		// #c2185b mirrors the --supaip token (theme.css); Leaflet paths
		// can't read CSS variables, so the hex lives in both places.
		color: highlight ? '#7a0042' : '#c2185b',
		weight: highlight ? 3 : 1.5,
		opacity: 0.9,
		fillColor: '#c2185b',
		fillOpacity: highlight ? 0.3 : 0.12,
	};
}

/** Selection target: a supplement id, optionally narrowed to one zone. */
export interface SupaipSelection {
	id: string;
	zone?: number | undefined;
}

function bboxArea(b: SupBbox | null): number {
	return b ? (b.maxLat - b.minLat) * (b.maxLon - b.minLon) : 0;
}

/** Rebuild the SUP AIP overlay from the given zones, each by its state, a
 *  zone with none (the selection's other zones) as its outline, styling the
 *  selected supplement (or selected zone) as highlighted. */
export function syncSupaipLayer(
	map: L.Map,
	items: readonly (VisibleZone | DrawnSupZone)[],
	sel: SupaipSelection | null,
): void {
	ensureSupaipPane(map);
	const sig =
		items.map((it) => `${it.sup.id}#${it.zoneIndex}${'state' in it ? `:${it.state}` : ''}`).join(',') +
		'|' +
		(sel ? `${sel.id}#${sel.zone ?? '*'}` : '');
	// Only skippable on the map already holding the paths: a fresh map (or one
	// after clearSupaipLayer) has no group yet and must draw.
	if (group && mapRef === map && sig === drawnSig) {
		return;
	}
	if (mapRef !== map) {
		map.on('zoomend', () => fitBands(map));
	}
	mapRef = map;
	if (!group) {
		group = L.layerGroup().addTo(map);
	}
	drawnSig = sig;
	group.clearLayers();
	dropBands();
	// Largest first so Leaflet's per-layer click resolves to the smallest
	// containing zone (matching the NOTAM layer's ordering).
	const sorted = [...items].sort((a, b) => bboxArea(b.zone.bbox) - bboxArea(a.zone.bbox));
	for (const it of sorted) {
		const highlight =
			sel != null &&
			sel.id === it.sup.id &&
			(sel.zone === undefined || sel.zone === it.zoneIndex);
		addZone(it, highlight, map);
	}
}

/** Drop the module-level Leaflet handles so a rebuilt map starts clean:
 *  without this, an HMR / test remount leaves `group` attached to the
 *  destroyed map and syncSupaipLayer keeps feeding it, so the new map shows
 *  no SUP AIP zones. Called from MapView's teardown. */
export function clearSupaipLayer(): void {
	group = null;
	hoverGroup = null;
	mapRef = null;
	drawnSig = null;
	dropBands();
}

/** Build the Leaflet path for a SUP AIP zone geometry (polygon, multipolygon,
 *  or circle) with the given style. Shared with supaipActivationLayer.ts so the
 *  base overlay and the NOTAM-activation hatch draw identical shapes. */
export function makeSupGeometryLayer(g: SupAipGeometry, style: L.PathOptions): L.Path {
	if (g.type === 'polygon') {
		return L.polygon(g.ring, style);
	}
	if (g.type === 'multipolygon') {
		// Wrap each ring as its own polygon ([[ring], ...]) so Leaflet draws
		// separate areas rather than treating later rings as holes.
		return L.polygon(g.rings.map((r) => [r]), style);
	}
	return L.circle(g.center, { ...style, radius: g.radiusM });
}

/** Build the Leaflet path for a SUP AIP zone: its geometry, cut where a
 *  sector goes through its whole band (exclusionSpan), each of its rings
 *  holding the sectors centred inside it and a circle set as a ring. Shared
 *  with supaipActivationLayer.ts, so the hatch has the zone's holes. */
export function makeSupZoneLayer(z: SupAipZone, style: L.PathOptions): L.Path | null {
	const g = z.geometry;
	if (!g) {
		return null;
	}
	const through = z.exclusions.filter((e) => exclusionSpan(z, e) === 'through');
	if (through.length === 0) {
		return makeSupGeometryLayer(g, style);
	}
	const shapes = outline(g).map((ring) => [
		ring,
		...through.filter((e) => pointInRing(...centreOf(e), ring)).flatMap((e) => outline(e.geometry)),
	]);
	return L.polygon(shapes, style);
}

/** A sector's centre: its circle's, else its box's, else its first vertex. */
function centreOf(e: SupAipExclusion): [number, number] {
	const g = e.geometry;
	if (g.type === 'circle') {
		return g.center;
	}
	if (e.bbox) {
		return [(e.bbox.minLat + e.bbox.maxLat) / 2, (e.bbox.minLon + e.bbox.maxLon) / 2];
	}
	return g.type === 'polygon' ? g.ring[0] : g.rings[0][0];
}

/** A geometry's rings, a circle's set as 64 points. */
function outline(g: SupAipGeometry): [number, number][][] {
	if (g.type === 'polygon') {
		return [g.ring];
	}
	if (g.type === 'multipolygon') {
		return g.rings;
	}
	const ring: [number, number][] = [];
	for (let i = 0; i < 64; i++) {
		const p = destinationPoint(g.center[0], g.center[1], (i * 360) / 64, g.radiusM);
		ring.push([p.lat, p.lon]);
	}
	return [ring];
}

/** A sector over its zone: a dashed outline in the zone's ink. */
function sectorStyle(highlight: boolean): L.PathOptions {
	return {
		pane: SUPAIP_PANE,
		interactive: false,
		color: highlight ? '#7a0042' : '#c2185b',
		weight: highlight ? 2 : 1.25,
		opacity: 0.9,
		dashArray: '5 4',
		fill: false,
	};
}

function fitBands(map: L.Map): void {
	const weight = bandWeight(map.getZoom());
	for (const b of bands) {
		b.setStyle({ weight });
	}
}

function dropBands(): void {
	bands.length = 0;
	for (const c of clips.splice(0)) {
		c.remove();
	}
}

/** A zone's outline, alone or dashed. */
/** The selection's outline over a zone's own look: the highlight's dark ink
 *  and weight, no fill, dashed for a later zone. */
function emphasisStyle(dash?: string): L.PathOptions {
	return { ...areaStyle(true), interactive: false, fill: false, ...(dash ? { dashArray: dash } : {}) };
}

function outlineStyle(dash?: string): L.PathOptions {
	return {
		pane: SUPAIP_PANE,
		interactive: false,
		color: '#c2185b',
		weight: 1.5,
		opacity: 0.9,
		fill: false,
		...(dash ? { dashArray: dash } : {}),
	};
}

/** A zone active on its own published period: hatched whole in its ink, as
 *  the activation hatch draws one a NOTAM activates. */
function addHatchedZone(z: SupAipZone): void {
	if (!group) {
		return;
	}
	const layer = makeSupZoneLayer(z, { pane: SUPAIP_PANE, interactive: false, color: '#c2185b', weight: 2, fillOpacity: 1 });
	if (!layer) {
		return;
	}
	layer.addTo(group);
	(layer.getElement() as SVGElement | null)?.setAttribute('fill', 'url(#hatch-supaip)');
}

/** A zone that may be active: its outline, and inside it the chart's band
 *  in the zone's ink, a stroke of the band's twice depth clipped to the
 *  outline's own shape. */
function addBandedZone(map: L.Map, z: SupAipZone): void {
	if (!group) {
		return;
	}
	const outline = makeSupZoneLayer(z, outlineStyle());
	if (!outline) {
		return;
	}
	outline.addTo(group);
	const band = makeSupZoneLayer(z, {
		pane: SUPAIP_PANE,
		interactive: false,
		fill: false,
		color: 'url(#hatch-supaip-band)',
		weight: bandWeight(map.getZoom()),
		opacity: 1,
		lineJoin: 'round',
	});
	if (!band) {
		return;
	}
	band.addTo(group);
	const clip = clipBand(outline, band);
	if (clip) {
		clips.push(clip);
	}
	bands.push(band);
	outline.bringToFront();
}

function addZone(it: VisibleZone | DrawnSupZone, highlight: boolean, map: L.Map): void {
	if (!group) {
		return;
	}
	// A selected zone keeps its state's look under the emphasis: the hatch
	// or the band with the dark outline over it, a later one's dash drawn
	// bolder, and the selection's tint for a zone in none of them.
	const state = 'state' in it ? it.state : null;
	if (state === 'later') {
		makeSupZoneLayer(it.zone, highlight ? emphasisStyle(LATER_DASH) : outlineStyle(LATER_DASH))?.addTo(group);
		return;
	}
	if (state === 'active' || state === 'may') {
		if (state === 'active') {
			addHatchedZone(it.zone);
		} else {
			addBandedZone(map, it.zone);
		}
		if (highlight) {
			makeSupZoneLayer(it.zone, emphasisStyle())?.addTo(group);
		}
	} else {
		makeSupZoneLayer(it.zone, highlight ? areaStyle(true) : outlineStyle())?.addTo(group);
	}
	// A sector the zone goes on over is dashed; one going through the whole
	// band is the zone's hole, its edge the zone's own.
	for (const e of it.zone.exclusions) {
		if (exclusionSpan(it.zone, e) === 'within') {
			makeSupGeometryLayer(e.geometry, sectorStyle(highlight)).addTo(group);
		}
	}
}

/** Draw a transient highlight clone of one zone (or clear it with null), for
 *  hovering a SUP AIP entry in the right-click menu or a zone row in the detail
 *  panel. Non-interactive, so it never intercepts clicks; drawn even when the
 *  layer is off, and the persistent selection highlight is unaffected. */
export function hoverSupaipZone(g: SupAipGeometry | null): void {
	if (!mapRef) {
		return;
	}
	ensureSupaipPane(mapRef);
	if (!hoverGroup) {
		hoverGroup = L.layerGroup().addTo(mapRef);
	}
	hoverGroup.clearLayers();
	if (!g) {
		return;
	}
	const style: L.PathOptions = {
		...areaStyle(true),
		weight: 4,
		fillOpacity: 0.35,
		interactive: false,
	};
	makeSupGeometryLayer(g, style).addTo(hoverGroup);
}

/** Fit the map to a bounding box (the "show area on map" action), kept clear
 *  of the detail panel. Capped at a regional zoom so a small zone frames with
 *  surrounding context rather than filling the map. */
export function focusSupBbox(map: L.Map, bbox: SupBbox | null): void {
	if (!bbox) {
		return;
	}
	flyToBoundsVisible(
		map,
		[
			[bbox.minLat, bbox.minLon],
			[bbox.maxLat, bbox.maxLon],
		],
		40,
		11,
	);
}
