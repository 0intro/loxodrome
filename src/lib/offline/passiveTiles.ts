/* The Leaflet face of the passive tile cache (docs/offline-maps.md): a
 * TileLayer whose tiles fetch through passiveStore, so on the Android shell
 * what you have viewed keeps rendering offline. Reach: the CORS-readable
 * base maps and the network chart layers; providers without CORS headers
 * (Google, Bing) keep the direct <img> loader and stay uncached (a
 * cache-front fetch would only double their traffic). */

import L from 'leaflet';
import { isNativeApp } from '$lib/native/platform';
import { cacheGet, cachePut } from './passiveStore';

const CachedTileLayer = L.TileLayer.extend({
	createTile(this: L.TileLayer, coords: L.Coords, done: L.DoneCallback) {
		const img = document.createElement('img');
		img.alt = '';
		const url = this.getTileUrl(coords);
		void (async () => {
			let blob: Blob | null = null;
			let networkFailed = false;
			try {
				const res = await fetch(url);
				if (res.ok) {
					blob = await res.blob();
					void cachePut(url, blob);
				}
			} catch {
				networkFailed = true;
				blob = await cacheGet(url);
			}
			if (blob) {
				const obj = URL.createObjectURL(blob);
				img.onload = () => {
					URL.revokeObjectURL(obj);
					done(undefined, img);
				};
				img.onerror = () => {
					URL.revokeObjectURL(obj);
					// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
					done(new Error('tile decode failed'), img);
				};
				img.src = obj;
				return;
			}
			if (networkFailed) {
				// fetch() may have failed on CORS rather than connectivity: let
				// the browser's own loader try, which keeps such providers
				// working online, just uncached.
				img.onload = () => done(undefined, img);
				// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
				img.onerror = () => done(new Error('tile load failed'), img);
				img.src = url;
				return;
			}
			// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
			done(new Error('tile unavailable'), img);
		})();
		return img;
	},
});

/** L.tileLayer with the passive cache in front on the Android shell; the
 *  plain layer on the web (the service worker covers it there). */
export function cachedTileLayer(url: string, options: L.TileLayerOptions): L.TileLayer {
	if (!isNativeApp()) {
		return L.tileLayer(url, options);
	}
	return new (CachedTileLayer as unknown as new (
		u: string,
		o: L.TileLayerOptions,
	) => L.TileLayer)(url, options);
}
