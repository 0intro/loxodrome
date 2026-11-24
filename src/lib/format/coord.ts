/* Map-coordinate formatting shared by the cursor-position badge and the
 * right-click "Copy coordinates" action, so both render a point identically. */

import { formatDMS } from '$lib/notam/format';

/** Normalise a raw Leaflet longitude to [-180, 180]. Leaflet returns
 *  out-of-range longitudes when the user pans past the antimeridian at low
 *  zoom (e.g. 540 for the second world copy). */
export function wrapLon(lng: number): number {
	return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** Clamp a latitude to [-90, 90] for safety. */
export function clampLat(lat: number): number {
	return Math.max(-90, Math.min(90, lat));
}

/** One axis at whole-second precision, no decimals. */
function dmsWhole(value: number, degDigits: number, pos: string, neg: string): string {
	const hemi = value >= 0 ? pos : neg;
	// Round the total first, so 59.6" carries into the next minute rather than
	// printing 60".
	let total = Math.round(Math.abs(value) * 3600);
	const deg = Math.floor(total / 3600);
	total -= deg * 3600;
	const min = Math.floor(total / 60);
	const sec = total - min * 60;
	return (
		`${String(deg).padStart(degDigits, '0')}°` +
		`${String(min).padStart(2, '0')}'${String(sec).padStart(2, '0')}"${hemi}`
	);
}

/** The same point at chart-header precision: whole seconds (about 30 m), and no
 *  separator slash. A profile header states WHERE it is taken in the space a
 *  title bar can spare; the full-precision forms below belong where a
 *  coordinate is read for navigation or copied out. */
export function formatCoordShort(lat: number, lng: number): string {
	return `${dmsWhole(clampLat(lat), 2, 'N', 'S')} ${dmsWhole(wrapLon(lng), 3, 'E', 'W')}`;
}

/** Format a lat/lng (after wrap/clamp) as both a DMS string and a 5-decimal
 *  string. The decimal form is what the copy action writes to the clipboard. */
export function formatCoord(
	lat: number,
	lng: number,
): { dms: string; decimal: string } {
	const la = clampLat(lat);
	const lo = wrapLon(lng);
	return {
		dms: formatDMS(la, lo),
		decimal: `${la.toFixed(5)}, ${lo.toFixed(5)}`,
	};
}
