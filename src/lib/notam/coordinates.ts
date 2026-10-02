import type { LatLon } from './types';

/**
 * Parse a DMS numeric string with the given number of degree digits into
 * decimal degrees. Handles both integer-tenths (e.g. 7 digits for latitude)
 * and explicit decimals (e.g. "4024.5").
 */
export function parseDMSComponent(str: string, degDigits: number): number {
	const deg = parseInt(str.substring(0, degDigits), 10);
	const min = parseInt(str.substring(degDigits, degDigits + 2), 10);
	const secStr = str.substring(degDigits + 2);
	const sec =
		secStr.length > 2 && !secStr.includes('.')
			? parseFloat(secStr.substring(0, 2) + '.' + secStr.substring(2))
			: parseFloat(secStr);
	return deg + min / 60 + sec / 3600;
}

/** Parse a DMS coordinate string to decimal degrees, or null if unrecognised. */
export function parseDMSCoordinate(coordStr: string): LatLon | null {
	// French NOTAMs use a comma as the decimal separator inside coords
	// ("483916,433N"); normalise to a dot. A comma *between* lat and lon has
	// already been consumed as a separator by the caller's coord regex.
	coordStr = coordStr.trim().replace(/,/g, '.');

	// Try the format with a space first ("484024N 0030441E"), then without
	// ("161514N0611540W"). Latitude: 6-7 digits + N/S (7th digit = tenths of
	// seconds). Longitude: 6-8 digits + E/W.
	let match = coordStr.match(
		/(\d{6,7}(?:\.\d+)?)\s*([NS])?\s+(\d{6,8}(?:\.\d+)?)\s*([EW])?/i,
	);
	if (!match) {
		match = coordStr.match(
			/(\d{6,7}(?:\.\d+)?)([NS])?(\d{7,8}(?:\.\d+)?)([EW])?/i,
		);
	}
	if (!match) {
		// DDMM precision (4-digit latitude + 5-digit longitude, optional
		// decimal minutes, both hemisphere letters required): "4900N 11000W",
		// "PSN 5338N 00304E". Tried last and anchored so a DDMMSS string can
		// never be re-read as minutes.
		const m = coordStr.match(
			/^(\d{2})(\d{2}(?:\.\d+)?)([NS])\s*(\d{3})(\d{2}(?:\.\d+)?)([EW])/i,
		);
		if (!m) {
			return null;
		}
		const lat = parseInt(m[1], 10) + parseFloat(m[2]) / 60;
		const lon = parseInt(m[4], 10) + parseFloat(m[5]) / 60;
		return {
			lat: m[3].toUpperCase() === 'S' ? -lat : lat,
			lon: m[6].toUpperCase() === 'W' ? -lon : lon,
		};
	}

	const latStr = match[1];
	const latDir = (match[2] || 'N').toUpperCase();
	let lonStr = match[3];
	const lonDir = (match[4] || 'E').toUpperCase();

	// Count digits before the decimal point (or all digits if there is none).
	const lonIntDigits = lonStr.includes('.') ? lonStr.indexOf('.') : lonStr.length;

	// 6-digit longitudes (DDMMSS): pad to DDDMMSS.
	if (lonIntDigits === 6) {
		lonStr = '0' + lonStr;
	}

	// 7-digit longitudes are ambiguous between DDDMMSS and DDMMSSs.
	if (lonIntDigits === 7 && !lonStr.includes('.')) {
		if (lonStr[0] === '0') {
			// Starts with 0: standard DDDMMSS, append 0 tenths (0022140 -> 00221400).
			lonStr = lonStr + '0';
		} else if (latStr.length === 6 || latStr.includes('.')) {
			// 6-digit (DDMMSS) or decimal-second latitude implies standard
			// DDDMMSS longitude: 1211510 -> 12115100.
			lonStr = lonStr + '0';
		} else {
			// 7-digit latitude (DDMMSSs) implies a DDMMSSs longitude with a
			// missing leading zero: 1420211 -> 01420211.
			lonStr = '0' + lonStr;
		}
	}

	// 8-digit longitudes with an extra leading zero (00161448 -> 0161448):
	// when DDDMMSSs gives invalid minutes (MM > 59), strip the leading '0'.
	if (lonStr.length === 8 && lonStr[0] === '0' && !lonStr.includes('.')) {
		const mm = parseInt(lonStr.substring(3, 5), 10);
		if (mm > 59) {
			lonStr = lonStr.substring(1);
		}
	}

	let lat = parseDMSComponent(latStr, 2);
	let lon = parseDMSComponent(lonStr, 3);

	if (latDir === 'S') {
		lat = -lat;
	}
	if (lonDir === 'W') {
		lon = -lon;
	}

	return { lat, lon };
}
