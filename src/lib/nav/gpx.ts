/* Hand-rolled GPX 1.1 serialise / parse for a recorded track, one of the three
 * formats the app reads and writes (docs/trace-files.md). Pure (no Svelte,
 * no DOMParser, so it runs under the vitest node environment) and tolerant on
 * read: attribute order, namespace prefixes, CRLF, and missing <ele>/<time> are
 * all accepted. Only the yaml package is available in this repo; GPX is XML, so
 * both directions are done by hand. Tested by tests/navGpx.spec.ts. */

import type { TrackPoint } from './trace';

/** Metres in one foot. */
const M_PER_FT = 0.3048;

/** Round to `dp` decimals (drops trailing zeros via Number). */
function round(n: number, dp: number): number {
	const f = 10 ** dp;
	return Math.round(n * f) / f;
}

/** XML-escape text content / attribute values. Shared with kml.ts, the only
 *  other hand-rolled XML writer here. */
export function xmlEscape(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

export interface BuildGpxOpts {
	/** Track name, written as <trk><name>. */
	name?: string | undefined;
	/** Converts a fix's stored altitude to MSL, which is what <ele> means by
	 *  convention and what every other tool will read it as. Omitted, the
	 *  stored value is written unchanged (the module stays pure: the datum
	 *  lives in the state, not here). */
	altMslFt?: ((p: TrackPoint) => number | null) | undefined;
}

/** Serialise the track to a GPX 1.1 document. Elevation is written in metres
 *  (GPX's unit) above mean sea level, omitted when the fix has no altitude;
 *  time as ISO-8601 Z. */
export function buildGpx(points: TrackPoint[], opts: BuildGpxOpts = {}): string {
	const lines: string[] = [];
	lines.push('<?xml version="1.0" encoding="UTF-8"?>');
	lines.push(
		'<gpx version="1.1" creator="Loxodrome" xmlns="http://www.topografix.com/GPX/1/1">',
	);
	lines.push('\t<trk>');
	if (opts.name) {
		lines.push(`\t\t<name>${xmlEscape(opts.name)}</name>`);
	}
	lines.push('\t\t<trkseg>');
	for (const p of points) {
		lines.push(`\t\t\t<trkpt lat="${round(p.lat, 6)}" lon="${round(p.lon, 6)}">`);
		const ele = opts.altMslFt ? opts.altMslFt(p) : p.altFt;
		if (ele != null) {
			lines.push(`\t\t\t\t<ele>${round(ele * M_PER_FT, 1)}</ele>`);
		}
		lines.push(`\t\t\t\t<time>${new Date(p.timeMs).toISOString()}</time>`);
		lines.push('\t\t\t</trkpt>');
	}
	lines.push('\t\t</trkseg>');
	lines.push('\t</trk>');
	lines.push('</gpx>');
	return lines.join('\n') + '\n';
}

/** trkpt, either self-closing or with a body; tag may carry a namespace prefix. */
const TRKPT_RE = /<(?:\w+:)?trkpt\b([^>]*?)\/>|<(?:\w+:)?trkpt\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?trkpt>/gi;
const LAT_RE = /\blat\s*=\s*["']([^"']+)["']/i;
const LON_RE = /\blon\s*=\s*["']([^"']+)["']/i;
const ELE_RE = /<(?:\w+:)?ele\b[^>]*>\s*([^<]+?)\s*<\/(?:\w+:)?ele>/i;
const TIME_RE = /<(?:\w+:)?time\b[^>]*>\s*([^<]+?)\s*<\/(?:\w+:)?time>/i;

/** Parse a GPX document into track points. Elevations are read as MSL, the
 *  format's convention, and the caller tags the trace accordingly so they are
 *  never geoid-corrected a second time. Tolerant of missing elevation (altFt
 *  null) and missing/unparseable time (a monotonic 1 Hz clock is synthesised
 *  so replay still works). Throws when no track points are found. */
export function parseGpx(text: string): TrackPoint[] {
	interface Raw {
		lat: number;
		lon: number;
		altFt: number | null;
		timeMs: number | null;
	}
	const raw: Raw[] = [];
	let m: RegExpExecArray | null;
	TRKPT_RE.lastIndex = 0;
	while ((m = TRKPT_RE.exec(text)) !== null) {
		const attrs = m[1] ?? m[2] ?? '';
		const body = m[3] ?? '';
		const latM = LAT_RE.exec(attrs);
		const lonM = LON_RE.exec(attrs);
		const lat = latM ? parseFloat(latM[1]) : NaN;
		const lon = lonM ? parseFloat(lonM[1]) : NaN;
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			continue;
		}
		const eleM = ELE_RE.exec(body);
		const eleMeters = eleM ? parseFloat(eleM[1]) : NaN;
		const altFt = Number.isFinite(eleMeters) ? eleMeters / M_PER_FT : null;
		const timeM = TIME_RE.exec(body);
		const parsed = timeM ? Date.parse(timeM[1]) : NaN;
		raw.push({ lat, lon, altFt, timeMs: Number.isFinite(parsed) ? parsed : null });
	}
	if (raw.length === 0) {
		throw new Error('Invalid GPX: no track points found');
	}
	// Fill missing times with a monotonic 1 Hz clock so the replay timeline is
	// always strictly increasing.
	const out: TrackPoint[] = [];
	let lastMs: number | null = null;
	for (const r of raw) {
		let timeMs: number;
		if (r.timeMs != null && (lastMs == null || r.timeMs > lastMs)) {
			timeMs = r.timeMs;
		} else {
			timeMs = lastMs == null ? 0 : lastMs + 1000;
		}
		lastMs = timeMs;
		out.push({ lat: r.lat, lon: r.lon, altFt: r.altFt, timeMs });
	}
	return out;
}
