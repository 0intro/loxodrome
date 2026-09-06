/* vacPanelLayer.ts draws the French VAC panels over the map: the SIA's own
 * approach and landing charts, in place, under the app's symbology.
 *
 * A canvas layer rather than an L.ImageOverlay per panel. Three reasons, in
 * order of weight: the panels are clipped rectangles that must be drawn in
 * a decided order where they overlap (the landing sheet over the approach
 * one), a canvas gets the zoom-animation handling every other direct-draw
 * layer here already has, and an image overlay per aerodrome would put a
 * DOM node's lifetime on the same clock as a pan.
 *
 * The pane sits at 300: above the stacked chart tiles (250 plus the stack
 * position, so 266 at the most with every chart checked) and below the
 * airspaces at 350. A VAC panel details the chart under it and is detailed
 * in turn by the airspace, NOTAM, weather and route symbology over it,
 * which is the whole point of putting it here rather than on top.
 *
 * No catalogs (docs/i18n.md rule 8): a canvas repaints on pan and zoom, so
 * baked translated text goes stale. This layer draws no text of its own;
 * every word on it is the SIA's, engraved in the plate. */

import L from 'leaflet';

import { panelAt, panelContains, type VacPanel } from '$lib/data/vacgeo';
import { DirectDrawLayer, ensurePane } from './directDrawLayer';
import { mergeFades, stepFades, type FadeEntry } from './panelFade';

const PANE = 'vac-panels';
const PANE_Z = '300';

/** Where the panels overlap, the closer-in sheet wins. */
/** A hairline round the panel, so the eye can see where the chart stops.
 *  Several plates draw no neatline of their own, and a chart that fades
 *  into the map with no edge reads as part of it. */
const EDGE = 'rgba(0, 0, 0, 0.35)';

/** The same ink for a pinned chart, drawn heavier. */
const EDGE_PINNED = 'rgba(0, 0, 0, 0.75)';
const EDGE_PINNED_PX = 2.5;

/** What the layer needs to paint one panel: where it goes and, when it is
 *  drawn, what it looks like. Supplied by the caller so this module stays
 *  free of the render queue and its pdf.js import. */
export interface VacPanelDraw {
	panel: VacPanel;
	canvas: HTMLCanvasElement | null;
	/** Asked for by name, and drawn with a heavier edge to say so: without
	 *  it the pin is invisible and the gesture has no answer beyond a
	 *  reorder the reader may not have been watching for. */
	pinned?: boolean;
}

let layer: VacPanelLayer | null = null;
let layerMap: L.Map | null = null;
let visible = false;
let fades: FadeEntry<VacPanelDraw>[] = [];
let fadeRaf = 0;
let fadeLast = 0;

/** How long a panel takes to arrive or to go. Long enough to read as a
 *  transition, short enough not to be waited on. */
const FADE_MS = 180;

/** Motion is a preference. The map itself already asks (MapView passes
 *  zoomAnimation and fadeAnimation the same way), and a reader who has said
 *  no gets the swap outright. */
function fadeMs(): number {
	try {
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : FADE_MS;
	} catch {
		return FADE_MS;
	}
}

/** What identifies a panel across passes: which rectangle of which page. Not
 *  the bitmap, which changes scale under it as the view zooms. */
function fadeKey(d: VacPanelDraw): string {
	return `${d.panel.ident}|${d.panel.section}|${d.panel.page}|${d.panel.kind}`;
}

function stopFadeLoop(): void {
	if (fadeRaf) {
		cancelAnimationFrame(fadeRaf);
		fadeRaf = 0;
	}
}

function runFadeLoop(): void {
	if (fadeRaf) {
		return;
	}
	fadeLast = performance.now();
	const tick = (): void => {
		fadeRaf = 0;
		const now = performance.now();
		const dt = now - fadeLast;
		fadeLast = now;
		const stepped = stepFades(fades, dt, fadeMs());
		fades = stepped.entries;
		redrawVacPanels();
		if (stepped.moving) {
			fadeRaf = requestAnimationFrame(tick);
		}
	};
	fadeRaf = requestAnimationFrame(tick);
}

class VacPanelLayer extends DirectDrawLayer {
	protected readonly canvasClass = 'leaflet-vac-canvas';
	protected readonly paneName = PANE;

	protected _draw(): void {
		const ctx = this._ctx;
		const map = this._map;
		if (!ctx || !map || !this._canvas) {
			return;
		}
		const dpr = window.devicePixelRatio || 1;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		if (!visible) {
			return;
		}
		for (const fade of fades) {
			const it = fade.item;
			if (!it.canvas || fade.alpha <= 0) {
				continue;
			}
			// The panel is placed by its own three corners rather than by a
			// north-up box: a ground-movement chart is rotated, often
			// heavily, and an axis-aligned blit would draw it square to the
			// map with its runway pointing the wrong way.
			const p = it.panel;
			const [x0, y0, x1, y1] = p.clip;
			const topLeft = corner(map, p, x0, y1);
			const topRight = corner(map, p, x1, y1);
			const bottomLeft = corner(map, p, x0, y0);
			const w = it.canvas.width;
			const h = it.canvas.height;
			if (w <= 0 || h <= 0) {
				continue;
			}
			ctx.save();
			ctx.globalAlpha = Math.min(1, fade.alpha);
			ctx.transform(
				(topRight.x - topLeft.x) / w,
				(topRight.y - topLeft.y) / w,
				(bottomLeft.x - topLeft.x) / h,
				(bottomLeft.y - topLeft.y) / h,
				topLeft.x,
				topLeft.y,
			);
			ctx.drawImage(it.canvas, 0, 0);
			ctx.restore();
			ctx.save();
			ctx.globalAlpha = Math.min(1, fade.alpha);
			ctx.strokeStyle = it.pinned ? EDGE_PINNED : EDGE;
			ctx.lineWidth = it.pinned ? EDGE_PINNED_PX : 1;
			ctx.beginPath();
			const bottomRight = corner(map, p, x1, y0);
			ctx.moveTo(topLeft.x, topLeft.y);
			ctx.lineTo(topRight.x, topRight.y);
			ctx.lineTo(bottomRight.x, bottomRight.y);
			ctx.lineTo(bottomLeft.x, bottomLeft.y);
			ctx.closePath();
			ctx.stroke();
			ctx.restore();
		}
	}
}

/** One page point as a container point, through the panel's own affine. */
function corner(map: L.Map, p: VacPanel, x: number, y: number): L.Point {
	const [lat, lon] = panelAt(p, x, y);
	return map.latLngToContainerPoint([lat, lon]);
}

/** The chart drawn at this position, or null.
 *
 *  Walked from the TOP of the stack, and only over panels actually painted:
 *  the hit-test has to agree with what the reader can see, which is why it
 *  lives here rather than in interactions.ts, the same reason airspaceAt
 *  lives with the airspace layer. `fades` is in paint order, back to front,
 *  so the topmost is the last of it. */
export function vacPanelAt(lat: number, lon: number): VacPanel | null {
	for (let i = fades.length - 1; i >= 0; i--) {
		const f = fades[i];
		if (!f.item.canvas || f.alpha < 0.5) {
			continue;
		}
		if (panelContains(f.item.panel, lat, lon)) {
			return f.item.panel;
		}
	}
	return null;
}

/** Create the layer once. Idempotent. */
export function buildVacPanelLayer(map: L.Map): void {
	if (layer) {
		return;
	}
	ensurePane(map, PANE, PANE_Z);
	layer = new VacPanelLayer();
	layerMap = map;
}

/** Hand the layer the panels, MOST RELEVANT FIRST.
 *
 *  They are painted back to front, so the first is the last drawn and ends
 *  on top. Where two charts cover the same ground both are drawn and the
 *  more relevant one covers the other; the seam is that chart's own
 *  neatline, a real edge of a real document, and a mosaic of overlapping
 *  sheets is how paper charts read on a table. Hiding the lower one instead
 *  made charts vanish from the middle of the screen while panning, since
 *  which one was hidden depended on where the view was centred. */
export function setVacPanelData(draws: VacPanelDraw[]): void {
	const wanted = [...draws].reverse().map((d) => ({ key: fadeKey(d), item: d }));
	fades = mergeFades(fades, wanted, fadeMs() === 0);
	if (fades.some((f) => f.alpha !== f.target)) {
		runFadeLoop();
	}
}

/** Attach or detach the layer and repaint, the three-branch reconcile every
 *  canvas layer here uses. */
export function syncVacPanelLayer(map: L.Map, on: boolean): void {
	visible = on;
	if (!layer) {
		return;
	}
	// Any entry holding a bitmap, including the ones on their way out: an
	// arriving panel is still at alpha 0 when this runs, and requiring it to
	// be visible here would keep the layer off the map for ever.
	const should = on && fades.some((f) => f.item.canvas);
	const has = map.hasLayer(layer);
	if (should && !has) {
		layer.addTo(map);
	} else if (!should && has) {
		map.removeLayer(layer);
	} else if (has) {
		layer.redraw();
	}
}

/** Repaint without changing what is on the map, for a render that landed. */
export function redrawVacPanels(): void {
	if (layer && layerMap?.hasLayer(layer)) {
		layer.redraw();
	}
}

/** Detach and forget; buildVacPanelLayer must rebuild (HMR teardown). */
export function clearVacPanels(map: L.Map): void {
	if (layer && map.hasLayer(layer)) {
		map.removeLayer(layer);
	}
	stopFadeLoop();
	layer = null;
	layerMap = null;
	fades = [];
	visible = false;
}
