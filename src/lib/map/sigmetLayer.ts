/* SIGMET hazard overlay: active advisories as translucent polygons in
 * their own pane, above the weather canvas and below the route corridors
 * and NOTAM areas. Non-interactive (the supaipLayer convention): clicks
 * fall through to the map's manual hit-test, where sigmetAt resolves
 * after the point features and SUP AIP but before the huge airspaces.
 * The selected advisory always draws (even with the toggle off) so a
 * panel link shows its area; hazard colours are the fixed hex palette in
 * $lib/weather/sigmet.ts (Leaflet paths cannot read CSS variables). */

import L from 'leaflet';
import { HAZARD_STYLES, ringAreaDeg2, type Sigmet } from '$lib/weather/sigmet';
import { flyToBoundsVisible } from './focus';

const SIGMET_PANE = 'sigmets';

let group: L.LayerGroup | null = null;
let hoverGroup: L.LayerGroup | null = null;
let mapRef: L.Map | null = null;

function ensureSigmetPane(map: L.Map): void {
	if (!map.getPane(SIGMET_PANE)) {
		// Above the weather canvas (430), below the route corridors (444+)
		// and the NOTAM areas (450).
		map.createPane(SIGMET_PANE).style.zIndex = '435';
	}
}

function hazardStyle(s: Sigmet, highlight: boolean): L.PathOptions {
	const { color } = HAZARD_STYLES[s.hazard];
	return {
		pane: SIGMET_PANE,
		interactive: false,
		color,
		weight: highlight ? 3 : 2,
		opacity: highlight ? 1 : 0.85,
		// Dashed: a transient advisory, distinct from the chart airspaces.
		dashArray: '6 4',
		fillColor: color,
		fillOpacity: highlight ? 0.25 : 0.1,
	};
}

/** One drawable advisory: the sigmet plus its resolved rings (its own, or
 *  the FIR fallback rings the state layer supplies). */
export interface SigmetDrawItem {
	sigmet: Sigmet;
	rings: [number, number][][];
}

function itemArea(it: SigmetDrawItem): number {
	return it.rings.reduce((sum, r) => sum + ringAreaDeg2(r), 0);
}

/** Rebuild the overlay: the visible advisories, plus the selected one
 *  unconditionally (drawn highlighted). Largest first, so overlapping
 *  advisories keep the smallest visually on top. */
export function syncSigmetLayer(
	map: L.Map,
	items: SigmetDrawItem[],
	selectedId: string | null,
): void {
	ensureSigmetPane(map);
	mapRef = map;
	if (!group) {
		group = L.layerGroup().addTo(map);
	}
	group.clearLayers();
	const sorted = [...items].sort((a, b) => itemArea(b) - itemArea(a));
	for (const it of sorted) {
		if (it.rings.length === 0) {
			continue;
		}
		L.polygon(
			it.rings.map((r) => [r]),
			hazardStyle(it.sigmet, it.sigmet.id === selectedId),
		).addTo(group);
	}
}

/** Drop the module-level Leaflet handles so a rebuilt map starts clean:
 *  without this, an HMR / test remount leaves `group` attached to the
 *  destroyed map and syncSigmetLayer keeps feeding it, so the new map shows
 *  no SIGMET polygons. Called from MapView's teardown. */
export function clearSigmetLayer(): void {
	group = null;
	hoverGroup = null;
	mapRef = null;
}

/** Transient highlight clone for hovering a Weather-tab / context-menu
 *  row; drawn even when the layer is off, cleared with null. */
export function hoverSigmet(it: SigmetDrawItem | null): void {
	if (!mapRef) {
		return;
	}
	ensureSigmetPane(mapRef);
	if (!hoverGroup) {
		hoverGroup = L.layerGroup().addTo(mapRef);
	}
	hoverGroup.clearLayers();
	if (!it || it.rings.length === 0) {
		return;
	}
	const style: L.PathOptions = {
		...hazardStyle(it.sigmet, true),
		weight: 4,
		fillOpacity: 0.3,
	};
	L.polygon(it.rings.map((r) => [r]), style).addTo(hoverGroup);
}

/** Fit the map to an advisory's rings, kept clear of the detail panel;
 *  capped at a regional zoom (the focusSupBbox convention). */
export function focusSigmet(map: L.Map, it: SigmetDrawItem): void {
	let minLat = Infinity;
	let minLon = Infinity;
	let maxLat = -Infinity;
	let maxLon = -Infinity;
	for (const ring of it.rings) {
		for (const [lat, lon] of ring) {
			minLat = Math.min(minLat, lat);
			minLon = Math.min(minLon, lon);
			maxLat = Math.max(maxLat, lat);
			maxLon = Math.max(maxLon, lon);
		}
	}
	if (!(maxLat >= minLat)) {
		return;
	}
	flyToBoundsVisible(
		map,
		[
			[minLat, minLon],
			[maxLat, maxLon],
		],
		40,
		9,
	);
}
