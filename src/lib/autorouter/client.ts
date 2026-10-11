/**
 * Reconstruct ICAO NOTAM text from autorouter's structured JSON, so the
 * existing `parseNotams()` can handle autorouter-sourced NOTAMs exactly
 * the same way it handles paste/upload input. The parser's E-section
 * PSN extraction, the qualifier-line fallback, the polygon area
 * detection, the radius parsing; all of it applies uniformly. There is
 * no separate adapter for autorouter; only this text reconstructor.
 *
 * Field names match the autorouter wiki at the time of writing
 * (https://www.autorouter.aero/wiki/api/notams/). Anything we don't see
 * in a row is dropped from the reconstructed text; `parseNotams` then
 * handles the missing section with the same defaults it uses for
 * malformed paste input.
 */

/** One row from `GET /v1.0/notam`. Every field is optional; autorouter
 *  rows aren't always complete. */
export interface AutorouterRow {
	series?: string;
	number?: string | number;
	year?: string | number;
	notam?: string; // some payloads return the assembled id directly

	code23?: string;
	code45?: string;

	// Item A can be an array of location codes (the API's actual shape) or a
	// single string in some payloads. Same for `fir` below.
	itema?: string | string[];
	itemd?: string;
	iteme?: string;
	itemf?: string;
	itemg?: string;

	startvalidity?: number;
	endvalidity?: number;
	permanent?: boolean;
	estimated?: boolean;

	fir?: string | string[];
	traffic?: string;
	purpose?: string;
	scope?: string;
	lower?: number;
	upper?: number;
	lat?: number;
	lon?: number;
	radius?: number;

	swlat?: number;
	swlon?: number;
	nelat?: number;
	nelon?: number;
}

// Garmin int32 → decimal degrees. The autorouter API encodes lat/lon and
// bbox corners as int32 with full int32 range mapped to ±180°
// (lat is naturally half-range). Conversion factor is 90 / 2^30; the wiki
// example shows lat=580814790 → 48.679°, lon=109959116 → 9.218° (Stuttgart).
const GARMIN_SCALE = 90 / 0x40000000;

/** Reconstruct one autorouter row as an ICAO-format NOTAM block ready to
 *  feed to `parseNotams()`. Returns the empty string for rows that lack
 *  enough information to make a valid block (no id and no Q-line). */
export function rowToIcaoText(row: AutorouterRow): string {
	const lines: string[] = [];
	const id = formatNotamId(row);
	if (id) {
		lines.push(id);
	}
	const qLine = buildQLineText(row);
	if (qLine) {
		lines.push(qLine);
	}
	const itema = itemaString(row.itema);
	if (itema) {
		lines.push('A) ' + itema);
	}
	const bc = formatValidityLine(row);
	if (bc) {
		lines.push(bc);
	}
	if (row.itemd) {
		lines.push('D) ' + row.itemd);
	}
	if (row.iteme) {
		lines.push('E) ' + row.iteme);
	}
	if (row.itemf) {
		lines.push('F) ' + row.itemf);
	}
	if (row.itemg) {
		lines.push('G) ' + row.itemg);
	}
	return lines.join('\n');
}

function garminToDeg(v: number | undefined): number | null {
	if (v == null || !Number.isFinite(v)) {
		return null;
	}
	return v * GARMIN_SCALE;
}

function formatNotamId(row: AutorouterRow): string {
	if (row.notam) {
		return row.notam;
	}
	const series = row.series ?? '';
	const number = row.number != null ? String(row.number).padStart(4, '0') : '';
	const yearRaw = row.year != null ? String(row.year) : '';
	const year = yearRaw.length === 4 ? yearRaw.slice(-2) : yearRaw;
	if (series || number || year) {
		return `${series}${number}/${year}`;
	}
	return '';
}

function firString(v: string | string[] | undefined): string {
	if (typeof v === 'string') return v;
	if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0];
	return '';
}

function itemaString(v: string | string[] | undefined): string {
	if (typeof v === 'string') return v;
	if (Array.isArray(v)) return v.filter((s) => typeof s === 'string').join(' ');
	return '';
}

// autorouter timestamps may be epoch seconds or milliseconds depending on
// the field; pick whichever makes a sane date.
function epochToDate(v: number | undefined): Date | null {
	if (v == null || !Number.isFinite(v)) {
		return null;
	}
	const ms = v < 1e11 ? v * 1000 : v;
	const d = new Date(ms);
	return Number.isNaN(d.getTime()) ? null : d;
}

/** Build the Q-line ICAO text for a row. Returns '' if there isn't enough
 *  data to make a valid line (parseQualifierLine requires 8 slash-separated
 *  fields and a coord in the 8th). */
function buildQLineText(row: AutorouterRow): string {
	const fir = firString(row.fir);
	const lat = garminToDeg(row.lat);
	const lon = garminToDeg(row.lon);
	if (!fir || lat == null || lon == null) {
		return '';
	}
	// Q-code: autorouter splits the canonical 5-char Q-code into code23
	// (2 chars after the leading Q) + code45 (2 chars). We prepend the Q
	// back so the parser's qCode + decodeQCode() see the format they
	// expect (e.g. row code23="OB" + code45="CE" -> "QOBCE").
	const code =
		'Q' + (row.code23 ?? '').trim() + (row.code45 ?? '').trim();
	const traffic = (row.traffic ?? '').trim();
	const purpose = (row.purpose ?? '').trim();
	const scope = (row.scope ?? '').trim();
	// Absent API limits fall back to the ICAO defaults 000/999, which read
	// as "unbounded" downstream (notamBandFt), exactly what an absent limit
	// means; the operational values, when published, travel in the verbatim
	// F)/G) items re-emitted above.
	const lower = row.lower != null ? String(row.lower).padStart(3, '0') : '000';
	const upper = row.upper != null ? String(row.upper).padStart(3, '0') : '999';
	const latStr = formatDmsCompact(lat, 2, 'NS');
	const lonStr = formatDmsCompact(lon, 3, 'EW');
	const radius =
		row.radius != null && row.radius > 0
			? String(Math.round(row.radius)).padStart(3, '0')
			: '005';
	return `Q) ${fir}/${code}/${traffic}/${purpose}/${scope}/${lower}/${upper}/${latStr}${lonStr}${radius}`;
}

function formatDmsCompact(deg: number, padDeg: number, hemis: string): string {
	const negative = deg < 0;
	const abs = Math.abs(deg);
	const d = Math.floor(abs);
	const m = Math.round((abs - d) * 60);
	// Round-up edge case: 59.999 -> 60' -> bump the degree.
	const dd = m === 60 ? d + 1 : d;
	const mm = m === 60 ? 0 : m;
	return (
		String(dd).padStart(padDeg, '0') +
		String(mm).padStart(2, '0') +
		hemis[negative ? 1 : 0]
	);
}

function formatValidityLine(row: AutorouterRow): string {
	const b = formatValidity(row.startvalidity);
	let c = formatValidity(row.endvalidity);
	if (row.permanent) {
		c = 'PERM';
	}
	if (!b && !c) {
		return '';
	}
	let s = '';
	if (b) {
		s += 'B) ' + b;
	}
	if (c) {
		s += (s ? ' ' : '') + 'C) ' + c;
	}
	if (row.estimated) {
		s += ' EST';
	}
	return s;
}

function formatValidity(epoch: number | undefined): string {
	const d = epochToDate(epoch);
	if (!d) {
		return '';
	}
	return (
		String(d.getUTCFullYear() % 100).padStart(2, '0') +
		String(d.getUTCMonth() + 1).padStart(2, '0') +
		String(d.getUTCDate()).padStart(2, '0') +
		String(d.getUTCHours()).padStart(2, '0') +
		String(d.getUTCMinutes()).padStart(2, '0')
	);
}
