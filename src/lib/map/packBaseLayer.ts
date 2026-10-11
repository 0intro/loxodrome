/* A base layer served from its offline pack (docs/offline-maps.md,
 * "Base-map packs"): the pack layer UNDER the live layer, one composite.
 *
 * The pack draws every zoom up to the archive's last (13 for Plan IGN), its
 * tiles enlarged beyond it by GridLayer's own overzoom; the live layer draws
 * only above that zoom (`minZoom` = the archive's max + 1), on top. So the
 * pack's zooms never touch the network, and above them the live tiles
 * replace the enlarged ones when there is a connection and leave them
 * showing when there is none: a failed tile is never marked loaded, and
 * Leaflet keeps an unloaded tile hidden. A tile the archive lacks loads the
 * live URL (createPackLayer's `miss`), so online the base map reads exactly
 * as the live layer alone would.
 *
 * The composite adds the pack BEFORE the live layer and removes the live
 * layer FIRST. Each GridLayer's minZoom counts toward the map's own zoom
 * limits, and a live layer alone on the map with minZoom 14 makes Leaflet
 * jump the map to zoom 14; MapView also pins the map's minZoom to 0, which
 * covers map.remove()'s own order.
 *
 * Imported on first use (MapView's base-layer sync): it pulls pmtiles in,
 * which nobody needs before a pack is held, and it must never reach the
 * NOTAM Viewer's bundle (tests/thirdPartyLicenses.spec.ts). */

import L from 'leaflet';
import { createPackLayer } from './packChartLayer';
import { archiveInfo } from '$lib/offline/filePmtiles';

type PackBase = L.Layer & { _pack: L.GridLayer; _live: L.TileLayer };

const PackBaseLayer = L.Layer.extend({
	initialize(this: PackBase, pack: L.GridLayer, live: L.TileLayer) {
		this._pack = pack;
		this._live = live;
	},
	onAdd(this: PackBase, map: L.Map) {
		map.addLayer(this._pack);
		map.addLayer(this._live);
		return this;
	},
	onRemove(this: PackBase, map: L.Map) {
		map.removeLayer(this._live);
		map.removeLayer(this._pack);
		return this;
	},
});

/** The live layer's URL for a tile at its own zoom. TileLayer.getTileUrl
 *  would read the zoom off the live layer's current tile zoom, which below
 *  its minZoom is undefined. */
function liveUrl(live: L.TileLayer, coords: L.Coords): string {
	const url = (live as unknown as { _url: string })._url;
	return L.Util.template(url, { ...live.options, s: 'a', r: '', x: coords.x, y: coords.y, z: coords.z });
}

/** The composite for `live` over the archive. Reads the archive's header for
 *  its zooms, so the pack defines its own depth. */
export async function createPackBaseLayer(live: L.TileLayer, archive: File, key: string): Promise<L.Layer> {
	const { maxZoom } = await archiveInfo(archive, key);
	const pack = createPackLayer(
		archive,
		key,
		{
			maxNativeZoom: maxZoom,
			maxZoom: live.options.maxZoom ?? 19,
			zIndex: 1,
			// The live layer's own credit: identical text, which the attribution
			// control counts once.
			attribution: live.getAttribution?.() ?? undefined,
		},
		(coords) => liveUrl(live, coords),
	);
	live.options.minZoom = maxZoom + 1;
	live.setZIndex(2);
	return new (PackBaseLayer as unknown as new (pack: L.GridLayer, live: L.TileLayer) => L.Layer)(pack, live);
}
