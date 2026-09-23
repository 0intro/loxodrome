/* metarLayer.ts renders the METAR stations as flight-category-coloured
 * station dots with their OBSERVED wind barbs on a direct-draw canvas
 * (pane 'metar-stations', z 415: above the airport symbols so the dot
 * rings the aerodrome, below the forecast barbs at 430). The windLayer
 * clone, state-import-free: prepared MapStation records arrive via
 * setMetarData; stationNear() serves both the hover badge (loose
 * tolerance) and the featureAt click probe (tight tolerance, resolved to
 * the airport in interactions.ts). Colours are the NWS flight-category
 * palette as fixed hex (map overlays never read CSS variables). VRB with
 * speed draws the dot plus a "VRB" label, NEVER the calm circle (that is
 * the WMO calm symbol); true calm keeps the circle via drawWindBarb. */

import type L from 'leaflet';
import { DirectDrawLayer, ensurePane } from './directDrawLayer';
import { drawWindBarb, gustLabel } from '$lib/weather/windBarbs';
import type { MapStation } from '$lib/state/metarStations.svelte';
import type { FlightCategory } from '$lib/weather/metar';

const PANE = 'metar-stations';
// 415: airport symbols (400) below so the category dot rings the aerodrome;
// the winds-aloft barbs (430) stay the top weather layer.
const PANE_Z = '415';

const BARB_SIZE_PX = 26;
const DOT_R = 4.5;
const HALO_R = 6.5;
/** Below this zoom only the category dots draw (station spacing at a
 *  country zoom is 10-20 px; barbs would shred into clutter). */
const BARBS_MIN_ZOOM = 7;
const INK = '#1f2733';
const HALO = 'rgba(255, 255, 255, 0.85)';
const LABEL_FONT = 'bold 9px system-ui, sans-serif'; // i18n-ignore: CSS font shorthand, not display text

/** The NWS flight-category palette (shared with the Weather tab legend). */
export const STATION_CAT_COLORS: Record<FlightCategory, string> = {
	VFR: '#1f8f4d',
	MVFR: '#1c5fbf',
	IFR: '#cb2026',
	LIFR: '#a21caf',
};
export const STATION_NO_CAT_COLOR = '#8a97a3';

/** Freshness follows metarFreshness's tri-state, matching the panel's
 *  amber/red semantics: ok full, aging faded, expired heavily faded. */
const FRESHNESS_ALPHA = { ok: 1, aging: 0.7, expired: 0.35 } as const;

let layer: MetarCanvasLayer | null = null;
let layerMap: L.Map | null = null;
let visible = false;
let stations: MapStation[] = [];

class MetarCanvasLayer extends DirectDrawLayer {
	protected override readonly canvasClass = 'leaflet-metar-canvas';
	protected override readonly paneName = PANE;

	protected override _draw(): void {
		const canvas = this._canvas;
		const ctx = this._ctx;
		const map = this._map;
		if (!canvas || !ctx || !map) {
			return;
		}
		const dpr = window.devicePixelRatio || 1;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.scale(dpr, dpr);
		const size = map.getSize();
		const pad = BARB_SIZE_PX * 2;
		const barbs = map.getZoom() >= BARBS_MIN_ZOOM;

		for (const st of stations) {
			const m = st.metar;
			const pt = map.latLngToContainerPoint([m.lat, m.lon]);
			if (pt.x < -pad || pt.y < -pad || pt.x > size.x + pad || pt.y > size.y + pad) {
				continue;
			}
			ctx.globalAlpha = FRESHNESS_ALPHA[st.freshness];
			// The observed wind first, so the category dot stays on top of the
			// barb's own small station dot. drawWindBarb also covers true calm
			// (the WMO circle); VRB (or unknown direction with wind) gets a
			// label instead, never the calm circle. A MISSING speed (wspd
			// null, e.g. a failed sensor's "/////") draws no barb at all: the
			// calm circle asserts an OBSERVED calm, which an unreported wind
			// is not, and the panel formatter likewise shows no wind line.
			const vrb = (m.wdir === 'VRB' || m.wdir == null) && (m.wspd ?? 0) > 0;
			if (
				barbs &&
				typeof m.wspd === 'number' &&
				(typeof m.wdir === 'number' || m.wspd === 0)
			) {
				drawWindBarb(
					ctx,
					pt.x,
					pt.y,
					typeof m.wdir === 'number' ? m.wdir : 0,
					m.wspd,
					BARB_SIZE_PX,
					{ stroke: INK, halo: HALO },
				);
			}
			const gust = gustLabel(m.wspd ?? 0, m.wgst ?? null);
			if (barbs && (vrb || gust)) {
				this.label(ctx, [vrb ? 'VRB' : null, gust].filter(Boolean).join(' '), pt.x + 6, pt.y + 13);
			}
			// Category dot over everything: halo disc then the coloured fill.
			ctx.beginPath();
			ctx.arc(pt.x, pt.y, HALO_R, 0, 2 * Math.PI);
			ctx.fillStyle = HALO;
			ctx.fill();
			ctx.beginPath();
			ctx.arc(pt.x, pt.y, DOT_R, 0, 2 * Math.PI);
			ctx.fillStyle = st.cat ? STATION_CAT_COLORS[st.cat] : STATION_NO_CAT_COLOR;
			ctx.fill();
			ctx.globalAlpha = 1;
		}
	}

	private label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
		ctx.font = LABEL_FONT;
		ctx.textBaseline = 'alphabetic';
		ctx.lineWidth = 3;
		ctx.strokeStyle = HALO;
		ctx.strokeText(text, x, y);
		ctx.fillStyle = INK;
		ctx.fillText(text, x, y);
	}
}

/** Build the layer once (idempotent); attached by syncMetarLayer. */
export function buildMetarLayer(map: L.Map): void {
	if (layer) {
		return;
	}
	layerMap = map;
	ensurePane(map, PANE, PANE_Z);
	layer = new MetarCanvasLayer();
}

/** Hand the layer its prepared stations and repaint. */
export function setMetarData(list: MapStation[]): void {
	stations = list;
	if (layerMap) {
		syncNow(layerMap);
	}
}

/** Reconcile attachment with the show-on-map toggle and redraw. */
export function syncMetarLayer(map: L.Map, on: boolean): void {
	visible = on;
	syncNow(map);
}

function syncNow(map: L.Map): void {
	if (!layer) {
		return;
	}
	const has = map.hasLayer(layer);
	if (visible && !has) {
		layer.addTo(map);
	} else if (!visible && has) {
		map.removeLayer(layer);
	} else if (has) {
		layer.redraw();
	}
}

/** The station whose dot sits within tolPx of (lat, lng); null while the
 *  layer is hidden. Tight tolerance for the click probe (the dot itself),
 *  loose for the hover badge; a linear scan over at most a few hundred
 *  stations. */
export function stationNear(map: L.Map, lat: number, lng: number, tolPx = 22): MapStation | null {
	if (!layer || !visible) {
		return null;
	}
	const pt = map.latLngToContainerPoint([lat, lng]);
	let best: MapStation | null = null;
	let bestD = tolPx * tolPx;
	for (const st of stations) {
		const p = map.latLngToContainerPoint([st.metar.lat, st.metar.lon]);
		const dx = p.x - pt.x;
		const dy = p.y - pt.y;
		const d2 = dx * dx + dy * dy;
		if (d2 <= bestD) {
			bestD = d2;
			best = st;
		}
	}
	return best;
}

/** Detach and drop the layer; buildMetarLayer must rebuild (HMR teardown). */
export function clearMetarLayer(map: L.Map): void {
	if (layer && map.hasLayer(layer)) {
		map.removeLayer(layer);
	}
	layer = null;
	layerMap = null;
	visible = false;
	stations = [];
}
