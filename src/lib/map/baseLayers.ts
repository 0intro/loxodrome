import L from 'leaflet';
import type { BaseLayerId } from '$lib/state/layers.svelte';
import { cachedTileLayer } from '$lib/offline/passiveTiles';
import { TILES_WHILE_MOVING } from './tileMotion';

/** Bing's tile addressing uses a quadkey derived from the x/y/z tile coords. */
function toQuadKey(x: number, y: number, z: number): string {
	let key = '';
	for (let i = z; i > 0; i--) {
		let digit = 0;
		const mask = 1 << (i - 1);
		if ((x & mask) !== 0) digit += 1;
		if ((y & mask) !== 0) digit += 2;
		key += digit;
	}
	return key;
}

const BingTileLayer = L.TileLayer.extend({
	getTileUrl(coords: L.Coords): string {
		const quadkey = toQuadKey(coords.x, coords.y, coords.z);
		return `https://ecn.t${coords.x % 4}.tiles.virtualearth.net/tiles/a${quadkey}.jpeg?g=14028`;
	},
}) as unknown as typeof L.TileLayer;

export interface BaseLayerDef {
	id: BaseLayerId;
	label: string;
	create: () => L.TileLayer;
}

// i18n-ignore-start: base-layer product names and tile attributions, locale-invariant (docs/i18n.md rule 10)
// The CORS-readable providers (OSM, OpenTopoMap, both IGN layers) build
// through cachedTileLayer, which is the Android shell's passive offline cache
// and a plain L.tileLayer on the web. Google and Bing send no CORS headers, so
// a cache-front fetch would only double their tile traffic; they keep the
// direct <img> loader and stay online-only natively (the web's service
// worker still caches them as opaque responses).

/** Both IGN layers are under the Licence Ouverte 2.0 (IGN's catalogue records
 *  IGNF_PLAN-IGN and IGNF_BD-ORTHO), which asks for the source to be named. */
const IGN_ATTR = '&copy; <a href="https://cartes.gouv.fr/">IGN</a>, Licence Ouverte';

/** IGN's WMTS, keyless. Plan IGN's matrix set is the PM_0_19 its capabilities
 *  advertise; the bare PM the Ortho row uses answers the same bytes today, but
 *  is not listed for this layer. The same request, tile for tile, is what
 *  cmd/planign harvests into the offline pack. */
const PLAN_IGN_URL =
	'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILEMATRIXSET=PM_0_19&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';

export const BASE_LAYERS: BaseLayerDef[] = [
	{
		id: 'osm',
		label: 'OpenStreetMap',
		create: () =>
			cachedTileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
				...TILES_WHILE_MOVING,
				attribution:
					'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
				maxZoom: 19,
			}),
	},
	{
		id: 'topo',
		label: 'OpenTopoMap',
		create: () =>
			cachedTileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
				...TILES_WHILE_MOVING,
				attribution:
					'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="http://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
				maxZoom: 17,
			}),
	},
	{
		// IGN's map. France and its overseas territories only (not Polynesia,
		// New Caledonia or Wallis-et-Futuna): elsewhere the service answers 404
		// from zoom 8 to 11 up, and the map is blank there, as under the Ortho. src/lib/offline/basemapPacks.ts holds its
		// offline pack, which MapView serves under this layer once downloaded.
		id: 'planign',
		label: 'Plan IGN',
		create: () =>
			cachedTileLayer(PLAN_IGN_URL, {
				...TILES_WHILE_MOVING,
				attribution: IGN_ATTR,
				maxZoom: 19,
			}),
	},
	{
		id: 'ign',
		label: 'IGN Ortho',
		create: () =>
			cachedTileLayer(
				'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
				{
					...TILES_WHILE_MOVING,
					attribution: IGN_ATTR,
					maxZoom: 19,
				},
			),
	},
	{
		id: 'google',
		label: 'Google Satellite',
		create: () =>
			L.tileLayer('https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
				...TILES_WHILE_MOVING,
				attribution: '&copy; Google',
				subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
				maxZoom: 20,
			}),
	},
	{
		id: 'bing',
		label: 'Bing Aerial',
		create: () =>
			new BingTileLayer('', {
				...TILES_WHILE_MOVING,
				attribution: '&copy; Microsoft Bing',
				maxZoom: 19,
			}),
	},
];
// i18n-ignore-end

export function baseLayerDef(id: BaseLayerId): BaseLayerDef {
	return BASE_LAYERS.find((b) => b.id === id) ?? BASE_LAYERS[0];
}
