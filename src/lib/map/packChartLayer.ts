/* A chart layer served from a downloaded offline pack: the same PMTiles
 * archive the worker reads, but local (docs/offline-maps.md). A GridLayer
 * subclass rather than a TileLayer: there is no URL, each tile is a
 * `getZxy` read off the OPFS File turned into a short-lived blob URL.
 * `maxNativeZoom` clamping happens in GridLayer itself (Leaflet clamps
 * `_tileZoom`, so `coords.z` arrives already native and overzoom scaling is
 * inherited), which keeps the on-screen behaviour identical to the network
 * layer built in chartOverlays.ts.
 *
 * The base-map packs ride the same layer (createPackLayer, through
 * map/packBaseLayer.ts), with one difference: a tile the archive does not
 * hold is loaded from the live service when `_miss` names its URL, so the
 * base map online reads exactly as the live layer would. A chart keeps the
 * empty tile, like the worker's 204. */

import L from 'leaflet';
import type { PMTiles } from 'pmtiles';
import type { ChartLayerDef } from './chartOverlays';
import { pmtilesFromFile } from '$lib/offline/filePmtiles';
import { TILES_WHILE_MOVING } from './tileMotion';

type PackGridLayer = L.GridLayer & {
	_pm: PMTiles;
	_miss?: ((coords: L.Coords) => string) | undefined;
};

const PackLayer = L.GridLayer.extend({
	createTile(this: PackGridLayer, coords: L.Coords, done: L.DoneCallback) {
		const img = document.createElement('img');
		img.alt = '';
		const load = (src: string, revoke: boolean) => {
			img.onload = () => {
				if (revoke) {
					URL.revokeObjectURL(src);
				}
				done(undefined, img);
			};
			img.onerror = () => {
				if (revoke) {
					URL.revokeObjectURL(src);
				}
				// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
				done(new Error('tile decode failed'), img);
			};
			img.src = src;
		};
		this._pm
			.getZxy(coords.z, coords.x, coords.y)
			.then((tile) => {
				if (!tile || tile.data.byteLength === 0) {
					if (this._miss) {
						// Not in the archive: the live service's own tile, which
						// online is what the live layer would have drawn (the world
						// beyond the pack, a 404 at sea) and offline fails quietly.
						load(this._miss(coords), false);
						return;
					}
					// Outside coverage / sea: an empty tile, like the worker's 204.
					done(undefined, img);
					return;
				}
				load(URL.createObjectURL(new Blob([tile.data])), true);
			})
			.catch((e: unknown) => {
				done(e instanceof Error ? e : new Error(String(e)), img);
			});
		return img;
	},
});

/** A pack-served GridLayer over any PMTiles archive. `miss` names the URL a
 *  tile the archive lacks is loaded from; without it that tile stays empty. */
export function createPackLayer(
	archive: File,
	key: string,
	options: L.GridLayerOptions,
	miss?: (coords: L.Coords) => string,
): L.GridLayer {
	const layer = new (PackLayer as unknown as new (options: L.GridLayerOptions) => PackGridLayer)({
		...TILES_WHILE_MOVING,
		...options,
	});
	layer._pm = pmtilesFromFile(archive, key);
	layer._miss = miss;
	return layer;
}

/** Build the offline (pack-served) Leaflet layer for a chart def, mirroring
 *  createChartLayer's options so swapping network/pack changes nothing on
 *  screen. */
export function createPackChartLayer(
	def: ChartLayerDef,
	pane: string,
	archive: File,
): L.GridLayer {
	return createPackLayer(archive, def.id, {
		pane,
		maxNativeZoom: def.maxNativeZoom,
		maxZoom: 19,
		bounds: def.bounds,
		attribution: def.attribution,
	});
}
