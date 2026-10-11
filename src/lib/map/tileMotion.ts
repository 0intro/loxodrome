/* tileMotion.ts: how every tile layer on the map loads while the map moves.
 *
 * Leaflet loads a tile layer's new tiles during a pan only on the desktop:
 * `updateWhenIdle` defaults to `Browser.mobile`, so on a phone (the WebView
 * says "Mobile") a drag showed grey where the map moved to until the finger
 * lifted and the view settled. Stated here for every layer instead: the base
 * maps (baseLayers.ts), the chart layers from the network (chartOverlays.ts)
 * and from a downloaded pack (packChartLayer.ts).
 *
 * The tiles asked for are still only those in view: OpenStreetMap's tile
 * policy counts "any pre-emptive fetching of tiles other than those a user is
 * actively viewing" as bulk downloading, so no margin is loaded ahead of the
 * pan. What is left to choose is how often the view is looked at while it
 * moves, Leaflet's throttle, 200 ms by default. Measured on the Redmi over
 * adb (warm cache, drags at constant speed, the frames after 400 ms with a
 * grey band of 32 px or more at the leading edge): at 500 px/s 63 of 149
 * idle-only, 11 of 146 at 200 ms, 9 of 148 at 100 ms; at 1000 px/s 38 of
 * 38, 25 of 43 and 9 of 40. */

import type L from 'leaflet';

export const TILES_WHILE_MOVING: Pick<L.GridLayerOptions, 'updateWhenIdle' | 'updateInterval'> = {
	updateWhenIdle: false,
	updateInterval: 100,
};
