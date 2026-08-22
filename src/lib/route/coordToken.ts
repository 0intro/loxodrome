/* The coordinate literals the route field accepts for a free point, and the one
 * it prints back. Three notations, mutually unambiguous by shape:
 *   packed         "N48492E002372", "48492N002372E"   hemisphere first or last
 *   Garmin Pilot   "N48,8200/E2,62000"  hemisphere prefix, comma decimal, slash
 *   decimal        "48.82,2.62"         signed, period decimal, comma separator
 * All three name the same point above. The Garmin form is the one serializeRoute
 * and the waypoint rows emit, so a route built on the map can be pasted straight
 * into Garmin Pilot. A token carries no space, the field splitting on whitespace.
 * Pure, tested. */

// [NS]<deg>[,.<frac>] / [EW]<deg>[,.<frac>] ; comma or dot decimal, one separator.
const GARMIN_RE = /^([NS])(\d+(?:[.,]\d+)?)\/([EW])(\d+(?:[.,]\d+)?)$/i;
// A "lat,lon" free-point token (no spaces); idents never look like this.
const DECIMAL_RE = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;
// The packed sexagesimal pair, hemisphere first (EFBs, GPS user waypoints) or last
// (ICAO Doc 4444 field 15, NOTAM text, our own latLonToSofiaToken). One capture per
// axis; packedAxis reads the digit counts, which is where the grammar lives.
const PACKED_PREFIX_RE = /^([NS])(\d{4,7}(?:[.,]\d+)?)([EW])(\d{5,8}(?:[.,]\d+)?)$/i;
const PACKED_SUFFIX_RE = /^(\d{4,7}(?:[.,]\d+)?)([NS])(\d{5,8}(?:[.,]\d+)?)([EW])$/i;

/** Parse a free-point coordinate token in any accepted notation, or null when it
 *  is none of them (so a bad token falls through to "unresolved" rather than
 *  placing a wrong point). The notations differ by shape, so the order below is
 *  readability, not precedence. */
export function parseCoordToken(tok: string): { lat: number; lon: number } | null {
	return parseGarminCoord(tok) ?? parsePackedCoord(tok) ?? parseDecimalCoord(tok);
}

/** Parse a packed token to decimal degrees, or null when it isn't one. Both
 *  hemisphere orders, latitude carrying 2 degree digits and longitude 3:
 *    N4849E00237        DDMM        48 deg 49 min
 *    N48492E002372      DDMM.m      48 deg 49.2 min
 *    N484912E0023712    DDMMSS      48 deg 49 min 12 s
 *    N4849123E00237123  DDMMSS.s    tenths of a second
 *  A 6-digit latitude therefore reads as DDMMSS, per ICAO Doc 4444 and like
 *  notam/coordinates.ts, so a coordinate copied out of a NOTAM means the same
 *  thing in both halves of the app; write the mark ("N4849.20E00237.20") for
 *  hundredths of a minute. */
export function parsePackedCoord(tok: string): { lat: number; lon: number } | null {
	const t = tok.trim();
	const p = PACKED_PREFIX_RE.exec(t);
	const m = p ?? PACKED_SUFFIX_RE.exec(t);
	if (!m) {
		return null;
	}
	const ns = p ? m[1] : m[2];
	const ew = p ? m[3] : m[4];
	const la = splitAxis(p ? m[2] : m[1]);
	const lo = splitAxis(p ? m[4] : m[3]);
	// The longitude carries exactly ONE more degree digit than the latitude. That
	// is what makes each axis readable at all (6 digits are DDDMM.m under a 5-digit
	// latitude and DDMMSS under a 4-digit one, the ambiguity parseDMSCoordinate
	// spends its heuristics on), and it rejects a dropped digit as a side effect.
	if (lo.digits.length !== la.digits.length + 1) {
		return null;
	}
	const lat = packedAxis(la.digits, la.frac, 2);
	const lon = packedAxis(lo.digits, lo.frac, 3);
	if (lat === null || lon === null || lat > 90 || lon > 180) {
		return null;
	}
	return {
		lat: ns.toUpperCase() === 'S' ? -lat : lat,
		lon: ew.toUpperCase() === 'W' ? -lon : lon,
	};
}

/** One packed axis split at its decimal mark: the integer digits, and the fraction
 *  the mark carried (empty when it carried none). */
function splitAxis(raw: string): { digits: string; frac: string } {
	const i = raw.search(/[.,]/);
	return i < 0 ? { digits: raw, frac: '' } : { digits: raw.slice(0, i), frac: raw.slice(i + 1) };
}

/** One packed axis to degrees, `degDigits` being 2 for latitude and 3 for
 *  longitude, or null when its digit count, its minutes or its seconds fall
 *  outside the grammar. */
function packedAxis(digits: string, frac: string, degDigits: number): number | null {
	const rest = digits.length - degDigits; // 2 = MM, 3 = MMm, 4 = MMSS, 5 = MMSSs
	// An explicit mark is a fraction of the last WHOLE field, so it follows minutes
	// (DDMM.m) or seconds (DDMMSS.s) and nothing else.
	if (rest < 2 || rest > 5 || (frac !== '' && rest !== 2 && rest !== 4)) {
		return null;
	}
	const tail = digits.slice(degDigits);
	const min = Number(
		tail.slice(0, 2) + (rest === 3 ? `.${tail[2]}` : rest === 2 && frac ? `.${frac}` : ''),
	);
	const sec =
		rest < 4 ? 0 : Number(tail.slice(2, 4) + (rest === 5 ? `.${tail[4]}` : frac ? `.${frac}` : ''));
	if (min >= 60 || sec >= 60) {
		return null;
	}
	return Number(digits.slice(0, degDigits)) + min / 60 + sec / 3600;
}

/** Parse a Garmin Pilot token "N48,8200/E2,62000" to decimal degrees, or null when
 *  it isn't one or is out of range. Any decimal precision is accepted. */
function parseGarminCoord(tok: string): { lat: number; lon: number } | null {
	const m = GARMIN_RE.exec(tok.trim());
	if (!m) {
		return null;
	}
	const lat = parseFloat(m[2].replace(',', '.'));
	const lon = parseFloat(m[4].replace(',', '.'));
	if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat > 90 || lon > 180) {
		return null;
	}
	return {
		lat: m[1].toUpperCase() === 'S' ? -lat : lat,
		lon: m[3].toUpperCase() === 'W' ? -lon : lon,
	};
}

/** Parse a signed decimal "48.82,2.62" token to decimal degrees, or null. */
function parseDecimalCoord(tok: string): { lat: number; lon: number } | null {
	const m = DECIMAL_RE.exec(tok.trim());
	if (!m) {
		return null;
	}
	const lat = parseFloat(m[1]);
	const lon = parseFloat(m[2]);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
		return null;
	}
	return { lat, lon };
}

/** Format decimal degrees as a Garmin token, 6 significant figures per axis with a
 *  comma decimal: 48.82, 2.62 -> "N48,8200/E2,62000" (matches Garmin Pilot's output). */
export function formatGarminCoord(lat: number, lon: number): string {
	return `${axis(lat, 'N', 'S')}/${axis(lon, 'E', 'W')}`;
}

function axis(v: number, pos: string, neg: string): string {
	const a = Math.abs(v);
	// 6 significant figures = 6 total digits, so the decimal count shrinks as the
	// integer part grows (2-digit lat -> 4 dp, 3-digit lon -> 3 dp).
	const dec = Math.max(0, 6 - Math.max(1, Math.trunc(a).toString().length));
	return (v < 0 ? neg : pos) + a.toFixed(dec).replace('.', ',');
}

/** Cheap "the caret token is (becoming) a coordinate" test, used only to mute the
 *  ident autocomplete while a coordinate is typed. Covers the hemisphere prefix,
 *  the slash, and four leading digits for the hemisphere-last packed order: the
 *  longest ident in the datasets is 9 characters and none carries more than three
 *  leading digits (the German 001AB navaids), so that branch reaches no ident. */
export function looksLikeCoordToken(tok: string): boolean {
	return /^[ns]\d/i.test(tok) || /^\d{4}/.test(tok) || tok.includes('/');
}
