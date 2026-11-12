/* svgMotion.ts: the route's lines follow the view while the map moves.
 *
 * Leaflet's SVG renderer redraws when the view settles (a moveend, a zoom, a
 * view reset), over the viewport and the margin svgPadding.ts gives it, half
 * the viewport beyond each side; while the map moves it is only carried along.
 * A swipe past that margin, 196 px sideways or 341 up or down on the Redmi's
 * map, ran past the end of the route's line while its pins, markers Leaflet
 * never clips, went on showing, and after a flick the line came back only
 * when the glide ended: measured on the Redmi (docs/performance-2026-09.md),
 * the box ran out 97 / 240 / 269 / 291 CSS px short at 250 / 500 / 1000 /
 * 2000 px/s, and a flick's glide showed its pins bare for 1.7 s.
 *
 * The renderers of the panes named here draw a whole screen beyond each side
 * (FOLLOW_PADDING), and also redraw on a `move`, once the view has used
 * REDRAW_SHARE of that margin on a side. The redraw is Leaflet's
 * own settle redraw (SVG._update: its box, centre and zoom together, so a zoom
 * animation still places what it drew), run early, in the task that moved the
 * map pane: the frame that shows the view shows the lines around it. No
 * velocity and no timer. A handful of lines each: the route and its casing,
 * the pointed-at leg, the progress in flight, the trace and the aircraft's
 * vector, whose minute marks are markers too, the Flights preview. The trace
 * is the long one, every recorded fix; one redraw of a two-hour trace took
 * the Redmi 1.3 to 1.8 ms at rest.
 *
 * And only while a line runs past what was drawn: a renderer whose every line
 * lies inside its box shows them whole wherever the view goes, so a redraw
 * would change nothing. At Paris z9 the Etampes plan and its two-hour trace
 * lie inside the margin, and the redraws a drag made there before this rule
 * changed no pixel and cost the Redmi 1.2 to 2.8 ms each for the trace, in
 * the touch's own task.
 *
 * Only where the lines stand as they were projected: the map at the zoom and
 * pixel origin of the renderer's last redraw, which a pan leaves alone (it
 * moves the map pane), and never at a frame of a pinch or a flyTo, which a
 * line set meanwhile (a trace fix) was projected for and the renderer did not
 * draw. A zoom, its animation and a view reset redraw at their end, as
 * Leaflet always did.
 *
 * The heavy SVG overlays keep Leaflet's way: the NOTAM areas, the SUP AIP
 * zones and both hatches, the SIGMETs, the emphasis clones, hundreds of paths
 * a redraw. Installed for the class by padSvgRenderers, before either map view
 * makes its map, so the renderer Leaflet makes for a pane on its own follows as
 * one made explicitly would; one made before the install stays Leaflet's. */

import L from 'leaflet';
import { coversView } from './canvasPlacement';

/** The panes whose SVG renderer follows the view, as the modules drawing on
 *  them spell them (tests/svgMotion.spec.ts pins each still there): the route,
 *  its casing and the pointed-at leg (routeLayer.ts), the progress in flight
 *  (routeProgressLayer.ts), the trace and the aircraft's vector (navLayer.ts),
 *  the Flights preview (previewLayer.ts). */
export const FOLLOWING_PANES: readonly string[] = [
	'route-casing',
	'route',
	'route-progress',
	'route-leg',
	'nav-trace',
	'nav-vector',
	'preview-ghost',
];

/** The share of its margin, on a side, the view may use before a following
 *  renderer redraws: a drag redraws once per that much of the margin
 *  travelled. The redraw shows in the frame of the `move` that makes it, so
 *  the rest of the margin is no latency to cover: on the Redmi the box held
 *  the view through 250 to 4000 px/s at 0.5 and at 0.9 alike, over five
 *  rotated rounds (docs/performance-2026-09.md), 0.9 redrawing a drag 2 to 7
 *  times against 7 to 20, and its screen recordings show no line short of a
 *  pin. The tenth left keeps a stroke's half width off the box's edge. */
export const REDRAW_SHARE = 0.9;

/** How far a following renderer draws beyond each side, a share of the
 *  viewport, where the other SVG overlays draw half of it (svgPadding.ts): a
 *  whole screen, so an ordinary swipe stays inside what was drawn and only a
 *  long drag or a flick's glide comes to the margin's end. A redraw moves its
 *  renderer's layer, which the browser then paints again whole: at half a
 *  screen 24 drags at z11 on the Redmi redrew 100 times and missed twice the
 *  frames Leaflet's way did (80 against 43 over 20 ms), at a whole screen
 *  none, 42. Its lines are few, so the wider box costs the settle nothing
 *  measurable, nor the memory. */
export const FOLLOW_PADDING = 1;

const FOLLOWING: ReadonlySet<string> = new Set(FOLLOWING_PANES);

/** A rectangle in layer points, as Leaflet's Bounds holds one. */
interface Box {
	min: L.Point;
	max: L.Point;
}

/** What of Leaflet's SVG renderer this module reads and calls: internals
 *  @types/leaflet leaves out, `_map` there being protected. */
interface SvgRenderer {
	options: { pane?: string | undefined; padding?: number | undefined };
	_map: L.Map | null | undefined;
	/** What the last redraw drew, in layer points (Renderer._update). */
	_bounds?: Box | undefined;
	/** Its lines, each with how far it reaches, stroke included, in layer
	 *  points (Path._pxBounds; none for a line never given a point). */
	_layers: Record<string, { _pxBounds?: Box | undefined }>;
	getEvents: RendererEvents;
	on(type: 'update', fn: (this: SvgRenderer) => void): unknown;
	_update(): void;
}

type RendererEvents = (this: SvgRenderer) => Record<string, L.LeafletEventHandlerFn>;

/** Leaflet's own events for a renderer (Renderer.getEvents): the settles'
 *  redraws and the zoom's transforms. */
const leafletEvents = (L.Renderer.prototype as unknown as { getEvents: RendererEvents }).getEvents;

/** The view each following renderer last drew for: the map's zoom and pixel
 *  origin at its `update`, which the redraw that sets its box fires last, and
 *  which a redraw held back by a zoom animation does not fire. */
const drawnFor = new WeakMap<SvgRenderer, { zoom: number; origin: L.Point }>();

function noteDrawn(this: SvgRenderer): void {
	const map = this._map;
	if (map) {
		drawnFor.set(this, { zoom: map.getZoom(), origin: map.getPixelOrigin() });
	}
}

/** Whether every line a renderer holds lies inside what it drew, so the
 *  drawing shows them whole wherever the view goes and a redraw would change
 *  nothing: a plan or a trace at a zoom that holds it in the margin. One
 *  holding no line is not such a case: it follows, the redraw of nothing
 *  being cheap, so a line given it mid-drag is clipped to a box around the
 *  view. */
function holdsEveryLine(r: SvgRenderer, box: Box): boolean {
	let lines = 0;
	for (const id in r._layers) {
		const b = r._layers[id]._pxBounds;
		if (!b) {
			continue;
		}
		if (b.min.x < box.min.x || b.min.y < box.min.y || b.max.x > box.max.x || b.max.y > box.max.y) {
			return false;
		}
		lines++;
	}
	return lines > 0;
}

/** A following renderer's events: Leaflet's, and `move`. */
function followingEvents(this: SvgRenderer): Record<string, L.LeafletEventHandlerFn> {
	return { ...leafletEvents.call(this), move: followView };
}

/** One `move`: redraw now if the view has used its share of the margin and
 *  a line runs past what was drawn. No DOM read: the map's size, zoom, origin
 *  and pane position are its own fields, and the lines' reach their own. */
function followView(this: SvgRenderer, e: L.LeafletEvent): void {
	const map = this._map;
	const box = this._bounds;
	const seen = drawnFor.get(this);
	const step = e as L.LeafletEvent & { pinch?: true; flyTo?: true };
	if (!map || !box || !seen || step.pinch || step.flyTo) {
		return;
	}
	if (seen.zoom !== map.getZoom() || !seen.origin.equals(map.getPixelOrigin())) {
		return;
	}
	const size = map.getSize();
	const keep = (this.options.padding ?? 0) * (1 - REDRAW_SHARE);
	const kx = size.x * keep;
	const ky = size.y * keep;
	const at = map.containerPointToLayerPoint([0, 0]);
	const drawn = { x: box.min.x, y: box.min.y, w: box.max.x - box.min.x, h: box.max.y - box.min.y };
	if (coversView(drawn, { x: at.x - kx, y: at.y - ky, w: size.x + 2 * kx, h: size.y + 2 * ky }) || holdsEveryLine(this, box)) {
		return;
	}
	this._update();
}

/** Leaflet's init hook on every SVG renderer: one on a following pane draws
 *  a whole screen beyond each side, notes each view it draws for, and
 *  answers `move` too. */
function takeUp(this: SvgRenderer): void {
	if (!FOLLOWING.has(this.options.pane ?? '')) {
		return;
	}
	this.options.padding = FOLLOW_PADDING;
	this.on('update', noteDrawn);
	this.getEvents = followingEvents;
}

let installed = false;

/** Make every SVG renderer made from now on for one of FOLLOWING_PANES follow
 *  a moving view. Once, however often called; padSvgRenderers calls it. */
export function followMovingView(): void {
	if (installed) {
		return;
	}
	installed = true;
	L.SVG.addInitHook(takeUp);
}
