/* A chart layer served from a downloaded offline pack: the same PMTiles
 * archive the worker reads, but local (docs/offline-maps.md). A GridLayer
 * subclass rather than a TileLayer: there is no URL, each tile is a
 * `getZxy` read off the OPFS File turned into a short-lived blob URL.
 * `maxNativeZoom` clamping happens in GridLayer itself (Leaflet clamps
 * `_tileZoom`, so `coords.z` arrives already native and overzoom scaling is
 * inherited), which keeps the on-screen behaviour identical to the network
 * layer built in chartOverlays.ts. */

import L from 'leaflet';
import type { PMTiles } from 'pmtiles';
import type { ChartLayerDef } from './chartOverlays';
import { pmtilesFromFile } from '$lib/offline/filePmtiles';

const PackLayer = L.GridLayer.extend({
	createTile(this: L.GridLayer & { _pm: PMTiles }, coords: L.Coords, done: L.DoneCallback) {
		const img = document.createElement('img');
		img.alt = '';
		this._pm
			.getZxy(coords.z, coords.x, coords.y)
			.then((tile) => {
				if (!tile || tile.data.byteLength === 0) {
					// Outside coverage / sea: an empty tile, like the worker's 204.
					done(undefined, img);
					return;
				}
				const url = URL.createObjectURL(new Blob([tile.data]));
				img.onload = () => {
					URL.revokeObjectURL(url);
					done(undefined, img);
				};
				img.onerror = () => {
					URL.revokeObjectURL(url);
					// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
					done(new Error('tile decode failed'), img);
				};
				img.src = url;
			})
			.catch((e: unknown) => {
				done(e instanceof Error ? e : new Error(String(e)), img);
			});
		return img;
	},
});

/** Build the offline (pack-served) Leaflet layer for a chart def, mirroring
 *  createChartLayer's options so swapping network/pack changes nothing on
 *  screen. */
export function createPackChartLayer(
	def: ChartLayerDef,
	pane: string,
	archive: File,
): L.GridLayer {
	const layer = new (PackLayer as unknown as new (options: L.GridLayerOptions) => L.GridLayer &
		Record<'_pm', PMTiles>)({
		pane,
		maxNativeZoom: def.maxNativeZoom,
		maxZoom: 19,
		bounds: def.bounds,
		attribution: def.attribution,
	});
	layer._pm = pmtilesFromFile(archive, def.id);
	return layer;
}
