/* containerProjection.ts: Leaflet's latLngToContainerPoint on its spherical
 * Mercator CRS (L.CRS.EPSG3857, the map's), reproduced bit for bit as a pure
 * function of the zoom, the pixel origin and the map pane's offset.
 *
 * The decoration paint projects every vertex of every zone it draws: through
 * the map that is a LatLng and three Points allocated per vertex, and in a
 * worker there is no map at all. Bit for bit, because the decorations are
 * drawn against the boundaries Leaflet itself draws, and a band half a pixel
 * off its line is a seam. The projection is separable, x from the longitude
 * and y from the latitude alone, and each follows Leaflet 1.9.4's own
 * operations in its own order (SphericalMercator.project, the EPSG3857
 * transformation at 256 * 2^zoom, the round, the pixel origin, the pane), which
 * tests/containerProjection.spec.ts pins against Leaflet itself.
 *
 * Leaflet-free at run time (types only), so a worker can import it. */

import type L from 'leaflet';

/** What a projection reads off the map: the zoom, the pixel origin of the last
 *  view reset, and the map pane's offset since (the pan). */
export interface ProjectionView {
	zoom: number;
	originX: number;
	originY: number;
	paneX: number;
	paneY: number;
}

/** A view's projection: container x of a longitude, container y of a latitude. */
export interface ContainerProjector {
	x(lng: number): number;
	y(lat: number): number;
}

// SphericalMercator's constants and EPSG3857's transformation, as Leaflet
// computes them.
const R = 6378137;
const MAX_LATITUDE = 85.0511287798;
const D = Math.PI / 180;
const A = 0.5 / (Math.PI * R);
const C = -A;

/** The map's current view, as latLngToContainerPoint would read it. */
export function projectionView(map: L.Map): ProjectionView {
	const origin = map.getPixelOrigin();
	const pane = map.layerPointToContainerPoint([0, 0]);
	return { zoom: map.getZoom(), originX: origin.x, originY: origin.y, paneX: pane.x, paneY: pane.y };
}

/** The CRS scale at `zoom`: world pixels across. */
export function zoomScale(zoom: number): number {
	return 256 * Math.pow(2, zoom);
}

/** map.project(latlng, zoom).x: a longitude's world pixel, unrounded. */
export function mercatorX(lng: number, scale: number): number {
	const px = R * lng * D;
	return scale * (A * px + 0.5);
}

/** map.project(latlng, zoom).y: a latitude's world pixel, unrounded, the
 *  latitude clamped where Mercator stops. */
export function mercatorY(lat: number, scale: number): number {
	const clamped = Math.max(Math.min(MAX_LATITUDE, lat), -MAX_LATITUDE);
	const sin = Math.sin(clamped * D);
	const py = (R * Math.log((1 + sin) / (1 - sin))) / 2;
	return scale * (C * py + 0.5);
}

/** The projection for `view`. Each call answers exactly what
 *  map.latLngToContainerPoint would for a map at that view: the world pixel
 *  rounded, less the pixel origin, plus the pane. */
export function containerProjector(view: ProjectionView): ContainerProjector {
	const scale = zoomScale(view.zoom);
	const { originX, originY, paneX, paneY } = view;
	return {
		x: (lng) => Math.round(mercatorX(lng, scale)) - originX + paneX,
		y: (lat) => Math.round(mercatorY(lat, scale)) - originY + paneY,
	};
}

/** The rectangle of the map a view shows between two container points, as
 *  latitudes and longitudes: the inverse of the projection above
 *  (SphericalMercator.unproject), without the pixel rounding, which a caller
 *  pads for. Never wrapped, as Leaflet draws vectors at their raw longitude:
 *  a view a world past the seam reads longitudes past 180. */
export function containerBounds(
	view: ProjectionView,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): { minLat: number; minLon: number; maxLat: number; maxLon: number } {
	const scale = zoomScale(view.zoom);
	const lng = (x: number) => ((x - view.paneX + view.originX) / scale - 0.5) * 360;
	const lat = (y: number) => {
		const py = (0.5 - (y - view.paneY + view.originY) / scale) / A;
		return (2 * Math.atan(Math.exp(py / R)) - Math.PI / 2) / D;
	};
	return { minLat: lat(y1), minLon: lng(x0), maxLat: lat(y0), maxLon: lng(x1) };
}
