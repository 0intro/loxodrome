/* svgPadding.ts: how far the vector overlays draw beyond the screen.
 *
 * Leaflet's SVG renderers (the NOTAM areas, the SUP AIP zones and both
 * activation hatches, the route line and its casing, progress and leg, the
 * trace, the emphasis clones, the SIGMETs, the corridors) redraw only when
 * the view settles, over the viewport plus a tenth of it on each side: a drag
 * longer than that tenth showed an empty strip where the map had gone until
 * the finger let go. Half the viewport instead, for every SVG renderer the
 * app makes, the implicit one per pane Leaflet creates as the one a layer
 * names: a drag of half the screen, and a key pan's glide (it settles each
 * half viewport), show them whole. A longer drag still reaches the edge of
 * the heavy ones, which paint nothing while the map moves; the route's lines,
 * the trace and the aircraft's vector draw a whole screen beyond each side and
 * redraw as the view goes (svgMotion.ts, installed here).
 *
 * Measured (docs/performance-2026-09.md): Chromium 1.25, the strip's p95 at
 * 250 / 500 / 1000 / 2000 px/s 204 / 493 / 926 / 932 CSS px at a tenth,
 * 77 / 366 / 755 / 765 at a quarter, 0 / 155 / 470 / 477 at a half; the
 * Redmi after a two-minute pan tour with the SUP AIP on (833 paths), the
 * WebView's memory and the settles' long tasks as at a tenth. The canvas
 * renderers keep Leaflet's default: none draws in the app's panes. */

import L from 'leaflet';
import { followMovingView } from './svgMotion';

/** The share of the viewport every SVG renderer draws beyond each side, the
 *  route's aside (svgMotion.ts, a whole screen). */
export const SVG_PADDING = 0.5;

/** Give every SVG renderer made from now on that padding: Leaflet's own
 *  default for the class, so the renderer a pane gets implicitly takes it as
 *  one made explicitly does; and make the route's follow a moving view, over
 *  a padding of their own (svgMotion.ts). Called by each map view before its
 *  map. */
export function padSvgRenderers(): void {
	L.SVG.mergeOptions({ padding: SVG_PADDING });
	followMovingView();
}
