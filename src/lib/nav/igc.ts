/* Hand-rolled IGC serialise / parse for a recorded track (the gliding / OLC
 * / club debriefing format; contract + the honesty decisions in
 * docs/trace-files.md). Pure (no Svelte, no DOM), both directions, the shape
 * gpx.ts already has.
 *
 * The format is the FAI/IGC "Technical Specification for GNSS Flight
 * Recorders", 2nd Edition with AL8 (2023), Appendix A. Four things this file
 * is deliberate about, because an IGC file is evidence and a pretty one that
 * lies is worse than an honest one that admits what it is not:
 *
 *   - The A record's manufacturer code starts with X (A2.5.6 note 2: "The use
 *     of the prefix X designates that the device is not IGC-approved"), so
 *     the very first line says this came from software, not from an approved
 *     flight recorder.
 *   - No G record. It is the recorder's cryptographic signature over the file
 *     and only approved hardware holds the key; a plausible-looking one would
 *     be forgery-shaped. Consequence: fine for OLC, SeeYou and a club
 *     debriefing, never valid for a badge or a record claim.
 *   - The pressure-altitude column is 00000 and the header says
 *     PRESSALTSENSOR:NONE. We have no barometer; copying the GNSS value there
 *     would assert a pressure altitude nobody measured, and it would silently
 *     become the scoring altitude.
 *   - The GNSS altitude column is metres above the WGS84 ELLIPSOID (A4.1.3),
 *     which is the inverse of every other export here (GPX and KML write
 *     MSL). The caller passes an ellipsoid-referenced callback for exactly
 *     that reason; see nav/altitudeDatum.ts's ellipsoidAltFt. XCSoar famously
 *     writes MSL in this column instead (XCSoar issue #1605); we do not.
 *
 * That last point is why READING one is not symmetric: a foreign file's GNSS
 * column may be on either datum and the file usually does not say, so
 * parseIgc reports what it FOUND (the specification's own firmware-line
 * wording when present) and leaves an unstated file's datum null for the
 * caller to ask about. Guessing would be a 45 m error over France, straight
 * into the airspace-alert floor tests.
 *
 * Tested by tests/navIgc.spec.ts. */

import type { AltDatum } from './altitudeDatum';
import { type TrackPoint } from './trace';

/** Metres in one foot. */
const M_PER_FT = 0.3048;

/** Line terminator: the specification requires CRLF (A2.3). */
const CRLF = '\r\n';

/** The A record's manufacturer + serial. X = not IGC-approved (A2.5.6 note
 *  2), LX identifies this application, 001 is the serial such a device has. */
const FR_ID = 'XLX001';

export interface BuildIgcOpts {
	/** Converts a fix's stored altitude to the WGS84 ELLIPSOID, the datum
	 *  the B record's GNSS altitude column is defined on. Omitted, the
	 *  stored value is written unchanged (the module stays pure: the datum
	 *  lives in the state, not here). */
	altEllipsoidFt?: ((p: TrackPoint) => number | null) | undefined;
	/** HFPLTPILOTINCHARGE. */
	pilot?: string | undefined;
	/** HFGTYGLIDERTYPE, the aircraft model. */
	aircraftType?: string | undefined;
	/** HFGIDGLIDERID, the registration. */
	aircraftId?: string | undefined;
	/** HFDTEDATE's NN, the flight's rank in its UTC day; 1 when unknown. */
	flightOfDay?: number | undefined;
	/** Written into HFRFW and HOSOF: the application version. */
	softwareVersion?: string | undefined;
}

/** Serialise the track to an IGC file. Fixes are collapsed to one B record
 *  per UTC second (the format's resolution; a scorer rejects a file whose
 *  times do not strictly increase) and the file states ONE UTC date, that of
 *  the first fix, with the B times wrapping past midnight as the format
 *  intends. A track with no fixes still yields a structurally valid
 *  header-only file, the buildGpx posture: the writers never throw. */
export function buildIgc(points: readonly TrackPoint[], opts: BuildIgcOpts = {}): string {
	const version = igcText(opts.softwareVersion ?? '');
	const first = points[0];
	const date = new Date(first ? first.timeMs : Date.now());
	const flightNo = clampInt(opts.flightOfDay ?? 1, 1, 99);
	// FXA (fix accuracy) is written only when the trace actually carries the
	// device's accuracy: an I record promising a column we cannot fill would
	// be worse than no column.
	const withFxa = points.some((p) => p.accuracyM != null && Number.isFinite(p.accuracyM));

	const lines: string[] = [];
	lines.push(`A${FR_ID}${igcText('Loxodrome')}`);
	lines.push(`HFDTEDATE:${dmy(date)},${pad(flightNo, 2)}`);
	lines.push(`HFPLTPILOTINCHARGE:${igcText(opts.pilot ?? '')}`);
	lines.push(`HFGTYGLIDERTYPE:${igcText(opts.aircraftType ?? '')}`);
	lines.push(`HFGIDGLIDERID:${igcText(opts.aircraftId ?? '')}`);
	lines.push('HFDTMGPSDATUM:WGS84');
	// The firmware line's wording is the specification's own (A3.2.4): it is
	// how a reader learns the GNSS altitude column is on the ellipsoid.
	// i18n-ignore: the IGC file's own wire text, quoted from A3.2.4
	lines.push(`HFRFWFIRMWAREVERSION:${version} with WGS84 Ellipsoid GPS altitude datum`);
	lines.push('HFRHWHARDWAREVERSION:WEB');
	lines.push('HFFTYFRTYPE:LOXODROME,WEB');
	lines.push('HFGPSRECEIVER:BROWSER,GEOLOCATION API');
	lines.push('HFPRSPRESSALTSENSOR:NONE');
	// HOSOF is the non-IGC recorder's download-software record (A3.2.7.5):
	// name, version, DDMMYYHHMM.
	lines.push(`HOSOFLOXODROME,${version},${dmy(date)}${hm(date)}`);
	if (withFxa) {
		lines.push('I013638FXA');
	}

	let lastSec = -1;
	for (const p of points) {
		const sec = Math.floor(p.timeMs / 1000);
		if (sec === lastSec) {
			continue; // one B record per second, the first fix of each
		}
		lastSec = sec;
		const altFt = opts.altEllipsoidFt ? opts.altEllipsoidFt(p) : p.altFt;
		const gnss = altFt == null ? null : Math.round(altFt * M_PER_FT);
		let line =
			`B${igcTime(p.timeMs)}${igcLat(p.lat)}${igcLon(p.lon)}` +
			// Validity: A for a 3D fix, V for a 2D one (no GNSS altitude), and
			// the column then reads 00000, which is that case's own meaning.
			`${gnss == null ? 'V' : 'A'}${igcAlt(0)}${igcAlt(gnss ?? 0)}`;
		if (withFxa) {
			// A fix with no accuracy writes the worst value, never 000: a
			// missing accuracy must not read as a perfect one.
			const fxa = p.accuracyM != null && Number.isFinite(p.accuracyM) ? Math.round(p.accuracyM) : 999;
			line += pad(clampInt(fxa, 0, 999), 3);
		}
		lines.push(line);
	}
	return lines.join(CRLF) + CRLF;
}

/** DDMMYY, UTC. */
function dmy(d: Date): string {
	return `${pad(d.getUTCDate(), 2)}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCFullYear() % 100, 2)}`;
}

/** HHMM, UTC (the HOSOF stamp's tail). */
function hm(d: Date): string {
	return `${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}`;
}

/** HHMMSS, UTC. */
function igcTime(ms: number): string {
	const d = new Date(ms);
	return `${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}`;
}

/** DDMMmmm + N/S. */
function igcLat(deg: number): string {
	const { d, m, mmm } = dms(deg, 90);
	return `${pad(d, 2)}${pad(m, 2)}${pad(mmm, 3)}${deg < 0 ? 'S' : 'N'}`;
}

/** DDDMMmmm + E/W. */
function igcLon(deg: number): string {
	const { d, m, mmm } = dms(deg, 180);
	return `${pad(d, 3)}${pad(m, 2)}${pad(mmm, 3)}${deg < 0 ? 'W' : 'E'}`;
}

/** Degrees, minutes and thousandths of a minute, rounded and CARRIED: a
 *  latitude of 48.99999999 must not print 4860000. */
function dms(deg: number, limit: number): { d: number; m: number; mmm: number } {
	const a = Math.min(Math.abs(deg), limit);
	let d = Math.floor(a);
	let mmm = Math.round((a - d) * 60_000);
	if (mmm >= 60_000) {
		mmm -= 60_000;
		d += 1;
	}
	return { d, m: Math.floor(mmm / 1000), mmm: mmm % 1000 };
}

/** Five characters of metres; a negative value carries its sign INSTEAD of
 *  the leading zero (A4.1.4), so the column stays five bytes wide. */
function igcAlt(m: number): string {
	const v = clampInt(m, -9999, 99_999);
	return v < 0 ? `-${pad(-v, 4)}` : pad(v, 5);
}

/** Header text reduced to what the format admits: the specification's
 *  character set is ASCII 0x20 to 0x7E, so accents fold to their base letter
 *  (a French pilot name or an accented type) and anything left outside is
 *  dropped rather than emitted raw. Lines cap at 76 characters (A2.3). */
function igcText(s: string): string {
	return s
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		 
		.replace(/[^\x20-\x7e]/g, '')
		.trim()
		.slice(0, 76);
}

function pad(n: number, width: number): string {
	return String(Math.trunc(n)).padStart(width, '0');
}

function clampInt(n: number, lo: number, hi: number): number {
	if (!Number.isFinite(n)) {
		return lo;
	}
	return Math.min(hi, Math.max(lo, Math.round(n)));
}

// --- Reading ---------------------------------------------------------------

/** The fixed part of a B record, per A4.1.3: B + HHMMSS + DDMMmmmN +
 *  DDDMMmmmE + validity + PPPPP + GGGGG. Anything past it is I-record
 *  extension data (FXA / SIU / ENL), which this parser ignores: the fixed
 *  table is the whole contract. */
const B_FIXED = 35;

/** A genuine fix line, used both to parse and (in files/detect.ts) to
 *  recognise the format. */
const B_RECORD = /^B\d{6}\d{7}[NS]\d{8}[EW][AV]/;

/** The date header, either era: the modern HFDTEDATE:DDMMYY,NN (A3.2.4) and
 *  the legacy HFDTEDDMMYY that older loggers still write. The flight number
 *  after the comma is not needed to place the file in time. */
const DATE_HEADER = /^H[FO]DTE(?:DATE)?:?\s*(\d{2})(\d{2})(\d{2})/i;

/** The specification's own wording for a recorder whose GNSS altitude column
 *  is on the ellipsoid (A3.2.4, the firmware line). Files that carry it -
 *  this app's own exports among them - need no question. */
const ELLIPSOID_MARKER = /ellipsoid\s+gps\s+altitude\s+datum/i;

/** More than half a day backwards is the midnight roll, not jitter: a
 *  duplicated or slightly out-of-order fix must not add 24 hours. */
const WRAP_THRESHOLD_S = 12 * 3600;

export interface ParsedIgc {
	points: TrackPoint[];
	/** What the FILE says its GNSS altitudes are measured from: 'ellipsoid'
	 *  when it states the specification's wording, null when it says nothing
	 *  and some fix carries an altitude (the caller asks). A file whose
	 *  fixes carry no altitude at all answers 'ellipsoid' rather than posing
	 *  a question about nothing. */
	datum: AltDatum | null;
}

/** Parse an IGC file into track points. Altitudes come from the GNSS column
 *  ALONE, never the pressure column, which is referenced to 1013.25 hPa and
 *  is not an altitude above sea level; a 2D fix ('V') and a zero GNSS
 *  altitude both read as no altitude rather than as sea level. Times are
 *  rebuilt from the file's single UTC date, rolling forward past midnight;
 *  a file with no date header lands on the 1970 epoch, which the app already
 *  treats as a trace with no wall clock. Throws when no fix parses. */
export function parseIgc(text: string): ParsedIgc {
	// The specification requires readers to tolerate CRLF, CR or LF alike
	// (Appendix D), and a BOM survives many a copy.
	const lines = text.replace(/^\ufeff/, '').split(/\r\n|\r|\n/);
	let dayMs: number | null = null;
	let stated: AltDatum | null = null;
	const points: TrackPoint[] = [];
	let prevSec = -1;
	let dayOffset = 0;
	let lastSec = -1;
	for (const raw of lines) {
		const line = raw.trimEnd();
		if (dayMs == null) {
			const d = DATE_HEADER.exec(line);
			if (d) {
				dayMs = utcDay(Number(d[1]), Number(d[2]), Number(d[3]));
				continue;
			}
		}
		if (stated == null && line.startsWith('H') && ELLIPSOID_MARKER.test(line)) {
			stated = 'ellipsoid';
			continue;
		}
		if (line.length < B_FIXED || !B_RECORD.test(line)) {
			continue;
		}
		const sec = seconds(line);
		if (sec == null) {
			continue;
		}
		if (prevSec >= 0 && prevSec - sec > WRAP_THRESHOLD_S) {
			dayOffset += 86_400;
		}
		prevSec = sec;
		const abs = sec + dayOffset;
		if (abs <= lastSec) {
			// One fix per second, the first of each: the format's own
			// resolution, and every consumer here assumes a strictly
			// increasing clock. A stamp that steps BACK (under the midnight
			// threshold) drops its fix too, the rule the GPX and KML readers
			// apply (nav/gpx.ts stampedTrack): pushed out of order it would
			// survive the importers' sort as an equal adjacent stamp, a
			// zero-time hop reading as 0 kt inside a takeoff roll.
			continue;
		}
		const lat = degrees(line.slice(7, 14), 2, line[14] === 'S');
		const lon = degrees(line.slice(15, 23), 3, line[23] === 'W');
		if (lat == null || lon == null) {
			continue;
		}
		lastSec = abs;
		points.push({
			lat,
			lon,
			altFt: gnssAltFt(line),
			timeMs: (dayMs ?? 0) + abs * 1000,
		});
	}
	if (points.length === 0) {
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new Error('Invalid IGC: no fix records found');
	}
	const anyAlt = points.some((p) => p.altFt != null);
	return { points, datum: stated ?? (anyAlt ? null : 'ellipsoid') };
}

/** Whether a text looks like an IGC file: a real fix line is the only
 *  evidence that cannot be mistaken for prose. */
export function looksLikeIgc(text: string): boolean {
	for (const line of text.split(/\r\n|\r|\n/, 400)) {
		if (B_RECORD.test(line.trimEnd())) {
			return true;
		}
	}
	return false;
}

/** Midnight UTC of a DDMMYY date. The century window is FIXED rather than
 *  relative to today, so a file reads the same in ten years' time: 80-99 is
 *  the twentieth century, everything else the twenty-first. */
function utcDay(dd: number, mm: number, yy: number): number | null {
	const year = yy >= 80 ? 1900 + yy : 2000 + yy;
	if (mm < 1 || mm > 12 || dd < 1 || dd > 31) {
		return null;
	}
	return Date.UTC(year, mm - 1, dd);
}

/** Seconds of the UTC day from HHMMSS. */
function seconds(line: string): number | null {
	const h = Number(line.slice(1, 3));
	const m = Number(line.slice(3, 5));
	const s = Number(line.slice(5, 7));
	if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) {
		return null;
	}
	if (h > 23 || m > 59 || s > 60) {
		return null;
	}
	return h * 3600 + m * 60 + s;
}

/** DDMMmmm (or DDDMMmmm) to signed degrees. */
function degrees(field: string, degDigits: number, negative: boolean): number | null {
	const d = Number(field.slice(0, degDigits));
	const min = Number(field.slice(degDigits, degDigits + 2));
	const thousandths = Number(field.slice(degDigits + 2, degDigits + 5));
	if (!Number.isFinite(d) || !Number.isFinite(min) || !Number.isFinite(thousandths)) {
		return null;
	}
	const value = d + (min + thousandths / 1000) / 60;
	if (value > 180) {
		return null;
	}
	return negative ? -value : value;
}

/** The GNSS column in feet, or null. A 'V' fix has no GNSS altitude by
 *  definition (A4.1.4), and an exact zero is the same statement in numbers:
 *  no receiver in flight reports the ellipsoid surface, and reading it as
 *  sea level would put a whole trace 148 ft low over France, into the
 *  airspace-alert floor tests. */
function gnssAltFt(line: string): number | null {
	if (line[24] !== 'A') {
		return null;
	}
	const metres = Number(line.slice(30, 35).trim());
	if (!Number.isFinite(metres) || metres === 0) {
		return null;
	}
	return metres / M_PER_FT;
}
