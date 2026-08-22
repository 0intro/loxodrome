/* windLayer.ts renders the winds-aloft lattice as station-model wind barbs
 * on a direct-draw canvas (pane 'weather', z 430: above the airport symbols,
 * below the route corridors and NOTAM areas), plus the optional 0 degC
 * isotherm polylines and the surface gust labels. A passive overlay: the
 * canvas is pointer-transparent (DirectDrawLayer default), there is no
 * hit-test and no highlight, so the natureLayer machinery shrinks to
 * build / setWindData / sync / clear. The prepared samples come from
 * $lib/state/windAloft.svelte.ts (windGridBarbs / windGridIsotherm); the
 * layer only draws them. Inks are fixed hex (map overlays never read CSS
 * variables); a light halo keeps the barbs readable on both base layers. */

import type L from 'leaflet';
import { DirectDrawLayer, ensurePane } from './directDrawLayer';
import { drawWindBarb } from '$lib/weather/windBarbs';
import type { MapBarb } from '$lib/state/windAloft.svelte';

const PANE = 'weather';
// 430 sits between the airport symbols (400) and the minalt corridor (444) /
// NOTAM areas (450): weather context under the operational features.
const PANE_Z = '430';

const BARB_SIZE_PX = 34;
const INK = '#233240';
const HALO = 'rgba(255, 255, 255, 0.85)';
/** Barbs whose level sits below the cell's ground (10 m wind shown). */
const FADED_ALPHA = 0.3;
const ISO_INK = '#1c5fbf';
const ISOBAR_INK = '#5f6f7e';
const GUST_FONT = 'bold 10px system-ui, sans-serif'; // i18n-ignore: CSS font shorthand, not display text

/** One MSLP isobar: its hPa value and its polyline chains ([lon, lat]). */
export interface IsobarLine {
	value: number;
	lines: [number, number][][];
}

/** The layer's whole prepared feed (one call per refresh from MapView). */
export interface WindLayerData {
	barbs: MapBarb[];
	/** Isotherm polylines as [lon, lat] chains (the lattice orientation). */
	isoLines: [number, number][][];
	/** Isotherm label ("0 °C", "-10 °C"). */
	isoLabel: string;
	/** MSLP isobars, drawn under the isotherm and the barbs. */
	isobars: IsobarLine[];
}

let layer: WindCanvasLayer | null = null;
let layerMap: L.Map | null = null;
let visible = false;
let barbs: MapBarb[] = [];
let isoLines: [number, number][][] = [];
let isoLabel = '0 °C';
let isobars: IsobarLine[] = [];

class WindCanvasLayer extends DirectDrawLayer {
	protected override readonly canvasClass = 'leaflet-wind-canvas';
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

		for (const iso of isobars) {
			for (const line of iso.lines) {
				if (line.length < 2) {
					continue;
				}
				ctx.beginPath();
				for (let i = 0; i < line.length; i++) {
					const pt = map.latLngToContainerPoint([line[i][1], line[i][0]]);
					if (i === 0) {
						ctx.moveTo(pt.x, pt.y);
					} else {
						ctx.lineTo(pt.x, pt.y);
					}
				}
				ctx.lineCap = 'round';
				ctx.setLineDash([]);
				ctx.strokeStyle = HALO;
				ctx.lineWidth = 3;
				ctx.stroke();
				ctx.strokeStyle = ISOBAR_INK;
				ctx.lineWidth = 1.2;
				ctx.stroke();
				// Label at the chain's midpoint (barbs overpaint the ends).
				const mid = map.latLngToContainerPoint([
					line[Math.floor(line.length / 2)][1],
					line[Math.floor(line.length / 2)][0],
				]);
				this.label(ctx, String(iso.value), mid.x + 3, mid.y - 3, ISOBAR_INK);
			}
		}

		for (const line of isoLines) {
			if (line.length < 2) {
				continue;
			}
			ctx.beginPath();
			for (let i = 0; i < line.length; i++) {
				const pt = map.latLngToContainerPoint([line[i][1], line[i][0]]);
				if (i === 0) {
					ctx.moveTo(pt.x, pt.y);
				} else {
					ctx.lineTo(pt.x, pt.y);
				}
			}
			ctx.lineCap = 'round';
			ctx.setLineDash([]);
			ctx.strokeStyle = HALO;
			ctx.lineWidth = 4;
			ctx.stroke();
			ctx.setLineDash([7, 5]);
			ctx.strokeStyle = ISO_INK;
			ctx.lineWidth = 1.8;
			ctx.stroke();
			ctx.setLineDash([]);
			// Label the chain's first point.
			const p0 = map.latLngToContainerPoint([line[0][1], line[0][0]]);
			this.label(ctx, isoLabel, p0.x + 4, p0.y - 5, ISO_INK);
		}

		for (const b of barbs) {
			const pt = map.latLngToContainerPoint([b.lat, b.lon]);
			if (pt.x < -pad || pt.y < -pad || pt.x > size.x + pad || pt.y > size.y + pad) {
				continue;
			}
			ctx.globalAlpha = b.faded ? FADED_ALPHA : 1;
			drawWindBarb(ctx, pt.x, pt.y, b.dirTrueDeg, b.speedKt, BARB_SIZE_PX, { stroke: INK, halo: HALO });
			if (b.gust) {
				this.label(ctx, b.gust, pt.x + 6, pt.y + 13, INK);
			}
			ctx.globalAlpha = 1;
		}
	}

	private label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, ink: string): void {
		ctx.font = GUST_FONT;
		ctx.textBaseline = 'alphabetic';
		ctx.lineWidth = 3;
		ctx.strokeStyle = HALO;
		ctx.strokeText(text, x, y);
		ctx.fillStyle = ink;
		ctx.fillText(text, x, y);
	}
}

/** Build the layer once (idempotent); attached by syncWindLayer. */
export function buildWindLayer(map: L.Map): void {
	if (layer) {
		return;
	}
	layerMap = map;
	ensurePane(map, PANE, PANE_Z);
	layer = new WindCanvasLayer();
}

/** Hand the layer its prepared feed (barbs, isotherm, isobars) and repaint. */
export function setWindData(data: WindLayerData): void {
	barbs = data.barbs;
	isoLines = data.isoLines;
	isoLabel = data.isoLabel;
	isobars = data.isobars;
	if (layerMap) {
		syncNow(layerMap);
	}
}

/** Reconcile attachment with the show-on-map toggle and redraw. */
export function syncWindLayer(map: L.Map, on: boolean): void {
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

/** The barb whose station point sits within tolPx of (lat, lng), for the
 *  hover readout; null while the layer is hidden. A linear scan: the
 *  lattice caps at ~126 points. */
export function windBarbNear(map: L.Map, lat: number, lng: number, tolPx = 22): MapBarb | null {
	if (!layer || !visible) {
		return null;
	}
	const pt = map.latLngToContainerPoint([lat, lng]);
	let best: MapBarb | null = null;
	let bestD = tolPx * tolPx;
	for (const b of barbs) {
		const p = map.latLngToContainerPoint([b.lat, b.lon]);
		const dx = p.x - pt.x;
		const dy = p.y - pt.y;
		const d2 = dx * dx + dy * dy;
		if (d2 <= bestD) {
			bestD = d2;
			best = b;
		}
	}
	return best;
}

/** Detach and drop the layer; buildWindLayer must rebuild (HMR teardown). */
export function clearWindLayer(map: L.Map): void {
	if (layer && map.hasLayer(layer)) {
		map.removeLayer(layer);
	}
	layer = null;
	layerMap = null;
	visible = false;
	barbs = [];
	isoLines = [];
	isoLabel = '0 °C';
	isobars = [];
}
