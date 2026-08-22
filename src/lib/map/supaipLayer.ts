/* SUP AIP overlay: draws each supplement's named sub-zones (polygon,
 * multipolygon, or circle) on their own map pane, below the NOTAM features.
 * Each zone is an independent interactive area: a click opens that zone's
 * detail. The layer is re-synced whenever the visible set (in force in the
 * evaluation window, altitude filtered) or the selection changes, and a sync
 * carrying the set already drawn is skipped; the selected zone is drawn
 * highlighted, and is drawn even when the toggle is off so selecting a zone
 * from a NOTAM panel still shows it. */

import L from 'leaflet';
import type { SupAipGeometry, SupBbox } from '$lib/data/supaip';
import type { VisibleZone } from '$lib/state/supaip.svelte';
import { flyToBoundsVisible } from './focus';

const SUPAIP_PANE = 'supaip';

let group: L.LayerGroup | null = null;
let hoverGroup: L.LayerGroup | null = null;
let mapRef: L.Map | null = null;
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

/** Rebuild the SUP AIP overlay from the given visible zones, styling the
 *  selected supplement (or selected zone) as highlighted. */
export function syncSupaipLayer(
	map: L.Map,
	items: VisibleZone[],
	sel: SupaipSelection | null,
): void {
	ensureSupaipPane(map);
	const sig =
		items.map((it) => `${it.sup.id}#${it.zoneIndex}`).join(',') +
		'|' +
		(sel ? `${sel.id}#${sel.zone ?? '*'}` : '');
	// Only skippable on the map already holding the paths: a fresh map (or one
	// after clearSupaipLayer) has no group yet and must draw.
	if (group && mapRef === map && sig === drawnSig) {
		return;
	}
	mapRef = map;
	if (!group) {
		group = L.layerGroup().addTo(map);
	}
	drawnSig = sig;
	group.clearLayers();
	// Largest first so Leaflet's per-layer click resolves to the smallest
	// containing zone (matching the NOTAM layer's ordering).
	const sorted = [...items].sort((a, b) => bboxArea(b.zone.bbox) - bboxArea(a.zone.bbox));
	for (const it of sorted) {
		const highlight =
			sel != null &&
			sel.id === it.sup.id &&
			(sel.zone === undefined || sel.zone === it.zoneIndex);
		addZone(it, highlight);
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

function addZone(it: VisibleZone, highlight: boolean): void {
	if (!group || !it.zone.geometry) {
		return;
	}
	makeSupGeometryLayer(it.zone.geometry, areaStyle(highlight)).addTo(group);
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
