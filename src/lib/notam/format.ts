import type { RadiusUnit } from './types';

/** Decompose |degrees| into DMS with the seconds pre-rounded to two
 *  decimals: rounding happens on the TOTAL (in hundredths of a second)
 *  before the split, so a value just under a minute boundary carries into
 *  the minutes (and degrees) instead of rendering an invalid 60.00" (49.15
 *  gives 49° 9' 0.00"; SDVFR's own .pln files carry that invalid second).
 *  Exported for route/routePln.ts, which writes the same decomposition in
 *  the simulator's own punctuation. */
export function dmsParts(abs: number): { deg: number; min: number; sec: string } {
	let centiSec = Math.round(abs * 360000);
	const deg = Math.floor(centiSec / 360000);
	centiSec -= deg * 360000;
	const min = Math.floor(centiSec / 6000);
	centiSec -= min * 6000;
	return { deg, min, sec: (centiSec / 100).toFixed(2) };
}

/**
 * Format decimal degrees to DMS (degrees, minutes, seconds).
 * Example: formatDMS(46.6468611, 14.3392) -> `46°38'48.70"N / 014°20'21.12"E`
 *
 * Seconds are rendered with two decimals (~30 cm precision) to match
 * the aeronautical convention used elsewhere in the app and in
 * published AIP fixtures.
 */
export function formatDMS(lat: number, lon: number): string {
	const la = dmsParts(Math.abs(lat));
	const lo = dmsParts(Math.abs(lon));
	const latDir = lat >= 0 ? 'N' : 'S';
	const lonDir = lon >= 0 ? 'E' : 'W';

	return (
		`${la.deg}°${String(la.min).padStart(2, '0')}'${la.sec.padStart(5, '0')}"${latDir}` +
		` / ${String(lo.deg).padStart(3, '0')}°${String(lo.min).padStart(2, '0')}'${lo.sec.padStart(5, '0')}"${lonDir}`
	);
}

/**
 * Format one axis of decimal degrees as a DMS string, e.g.
 * formatDMSAxis(46.6468611, 'N', 'S', 2) -> `46°38'48.70"N`.
 *
 * The degrees are zero-padded to `degDigits` (2 for latitude, 3 for
 * longitude) and seconds carry two decimals. The navaid and obstacle
 * detail panels use this to print latitude and longitude on separate
 * lines; formatDMS renders the combined `lat / lon` form.
 */
export function formatDMSAxis(
	value: number,
	hemiPositive: string,
	hemiNegative: string,
	degDigits: number,
): string {
	const { deg, min, sec } = dmsParts(Math.abs(value));
	const hemi = value >= 0 ? hemiPositive : hemiNegative;
	return `${String(deg).padStart(degDigits, '0')}°${String(min).padStart(2, '0')}'${sec.padStart(5, '0')}"${hemi}`;
}

/** Display casing per radius unit (SI lower-case, aviation NM upper-case). */
export const radiusUnitDisplay: Record<RadiusUnit, string> = {
	NM: 'NM',
	KM: 'km',
	M: 'm',
};
