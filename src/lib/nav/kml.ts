/* Hand-rolled KML 2.2 serialise / parse for a recorded track (the Google
 * Earth debrief format; contract in docs/trace-files.md). Pure (no Svelte,
 * no DOM serializer, so it runs under the vitest node environment), both
 * directions, the shape gpx.ts already has.
 *
 * The geometry is a <gx:Track>, the Google extension that carries a TIME per
 * position, so Earth gives the flight its time slider and altitude profile;
 * a plain <LineString> is a static line and is used only for a track whose
 * fixes carry no absolute clock (a GPX imported without <time>, where
 * parseGpx synthesises a 1 Hz clock from zero: writing 1970 timestamps would
 * be worse than writing none). */

import { M_PER_FT, round, stampedTrack, xmlEscape } from './gpx';
import { hasAbsoluteTime, type TrackPoint } from './trace';

/** The trace ink as KML's aabbggrr, the twin of map/navLayer.ts's
 *  TRACE_COLOR '#e8590c'. A pure nav/ module must not import map/, so the
 *  value is restated here rather than shared. */
const TRACE_KML_COLOR = 'ff0c59e8';

export interface BuildKmlOpts {
	/** Document and placemark name. */
	name?: string | undefined;
	/** Converts a fix's stored altitude to MSL, which is what KML's
	 *  `absolute` altitude mode means ("relative to sea level"). Omitted,
	 *  the stored value is written unchanged (the module stays pure: the
	 *  datum lives in the state, not here). */
	altMslFt?: ((p: TrackPoint) => number | null) | undefined;
}

/** Serialise the track to a KML 2.2 document. Coordinates are lon/lat in
 *  degrees and altitude in metres above sea level; a track where NO fix has
 *  an altitude is clamped to the ground instead of buried at sea level. */
export function buildKml(points: readonly TrackPoint[], opts: BuildKmlOpts = {}): string {
	const altOf = (p: TrackPoint): number | null => (opts.altMslFt ? opts.altMslFt(p) : p.altFt);
	const anyAlt = points.some((p) => altOf(p) != null);
	const mode = anyAlt ? 'absolute' : 'clampToGround';
	const timed = hasAbsoluteTime(points);
	const name = opts.name ?? '';

	// i18n-ignore-start: KML markup, a wire format, never user-visible text
	const lines: string[] = [];
	lines.push('<?xml version="1.0" encoding="UTF-8"?>');
	lines.push(
		'<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">',
	);
	lines.push('\t<Document>');
	if (name) {
		lines.push(`\t\t<name>${xmlEscape(name)}</name>`);
	}
	lines.push('\t\t<Style id="trace">');
	lines.push('\t\t\t<LineStyle>');
	lines.push(`\t\t\t\t<color>${TRACE_KML_COLOR}</color>`);
	lines.push('\t\t\t\t<width>3</width>');
	lines.push('\t\t\t</LineStyle>');
	lines.push('\t\t</Style>');
	lines.push('\t\t<Placemark>');
	if (name) {
		lines.push(`\t\t\t<name>${xmlEscape(name)}</name>`);
	}
	lines.push('\t\t\t<styleUrl>#trace</styleUrl>');
	if (timed) {
		lines.push('\t\t\t<gx:Track>');
		lines.push(`\t\t\t\t<altitudeMode>${mode}</altitudeMode>`);
		for (const p of points) {
			lines.push(`\t\t\t\t<when>${new Date(p.timeMs).toISOString()}</when>`);
			lines.push(`\t\t\t\t<gx:coord>${coord(p, altOf(p))}</gx:coord>`);
		}
		lines.push('\t\t\t</gx:Track>');
	} else {
		lines.push('\t\t\t<LineString>');
		lines.push(`\t\t\t\t<altitudeMode>${mode}</altitudeMode>`);
		lines.push('\t\t\t\t<coordinates>');
		for (const p of points) {
			lines.push(`\t\t\t\t\t${coord(p, altOf(p)).replace(/ /g, ',')}`);
		}
		lines.push('\t\t\t\t</coordinates>');
		lines.push('\t\t\t</LineString>');
	}
	lines.push('\t\t</Placemark>');
	lines.push('\t</Document>');
	lines.push('</kml>');
	// i18n-ignore-end
	return lines.join('\n') + '\n';
}

/** "lon lat alt", KML's own axis order, altitude in metres. The altitude
 *  component is OPTIONAL in the grammar, so a fix that carries none writes
 *  two components rather than a zero: sea level is a height, and a file must
 *  not assert one nobody measured (it is also what lets a reader give the
 *  same fix back with no altitude). */
function coord(p: TrackPoint, altFt: number | null): string {
	const lonLat = `${round(p.lon, 6)} ${round(p.lat, 6)}`;
	return altFt == null ? lonLat : `${lonLat} ${round(altFt * M_PER_FT, 1)}`;
}

// --- Reading ---------------------------------------------------------------

/* Element scans, prefix-tolerant: "gx" is the conventional binding of the
 * extension namespace, not a required one, and a document may bind it to any
 * prefix or none. Every scan is SCOPED to a geometry element's own body:
 * an unscoped <coordinates> hunt would read an airspace dataset's rings (the
 * Austrian Luftraumstruktur KMZ holds 98 000 LinearRings and no track at all)
 * as one gigantic "trace". */
const TRACK_EL = /<(?:\w+:)?Track\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Track>/gi;
const LINESTRING_EL = /<(?:\w+:)?LineString\b[^>]*>([\s\S]*?)<\/(?:\w+:)?LineString>/gi;
const WHEN_EL = /<(?:\w+:)?when\b[^>]*>([\s\S]*?)<\/(?:\w+:)?when>/gi;
const COORD_EL = /<(?:\w+:)?coord\b[^>]*>([\s\S]*?)<\/(?:\w+:)?coord>/gi;
const COORDINATES_EL = /<(?:\w+:)?coordinates\b[^>]*>([\s\S]*?)<\/(?:\w+:)?coordinates>/i;
/** Both namespaces: the gx one owns the sea-floor modes. */
const ALT_MODE_EL = /<(?:\w+:)?altitudeMode\b[^>]*>\s*([\s\S]*?)\s*<\/(?:\w+:)?altitudeMode>/i;

/** Parse a KML document into track points. Altitudes are metres above sea
 *  level, which is what `absolute` means; every other altitudeMode measures
 *  from the terrain or the sea floor and yields no altitude at all. With NO
 *  mode stated a gx:Track keeps its heights (a timed recording states its
 *  own altitudes) and a plain LineString drops them (a drawn line's third
 *  value is the ground under it, as in Google Earth's own exports). Times
 *  come from the paired <when> elements; a LineString has none, so the
 *  parseGpx 1 Hz fallback applies and the app treats the result as a trace
 *  with no wall clock. Throws when the document holds no track or line. */
export function parseKml(text: string): TrackPoint[] {
	const tracks = [...text.matchAll(TRACK_EL)].map((m) => m[1]);
	if (tracks.length > 0) {
		// A gx:MultiTrack is just a container: its children come out of the
		// same scan, in document order. The clock rule applies to the
		// concatenation (the stampedTrack contract): a <when> that does not
		// advance the clock drops its fix, and a track with no <when> at all
		// keeps the synthetic 1 Hz clock.
		const raw: { point: TrackPoint; timeMs: number | null }[] = [];
		for (const body of tracks) {
			raw.push(...trackPoints(body));
		}
		const points = stampedTrack(raw, (r, timeMs) => ({ ...r.point, timeMs }));
		if (points.length > 0) {
			return points;
		}
	}
	// No track: the longest line wins. Concatenating unrelated drawn paths
	// would fabricate a leg between them.
	let best: TrackPoint[] = [];
	for (const m of text.matchAll(LINESTRING_EL)) {
		const points = linePoints(m[1]);
		if (points.length > best.length) {
			best = points;
		}
	}
	if (best.length === 0) {
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		throw new Error('Invalid KML: no track or line found');
	}
	return best;
}

/** Whether a text looks like a KML document (files/detect.ts's probe). */
export function looksLikeKml(text: string): boolean {
	return /<(?:\w+:)?kml[\s>]/i.test(text) || text.includes('opengis.net/kml');
}

/** One gx:Track: <when> and <gx:coord> are paired BY INDEX, which is what
 *  the format specifies; some writers emit every time first and every
 *  position after, so adjacency proves nothing. The caller applies the
 *  clock rule (stampedTrack), so a fix rides out with its stated stamp or
 *  null. */
function trackPoints(body: string): { point: TrackPoint; timeMs: number | null }[] {
	const keepAlt = altitudesKept(body, true);
	const whens = [...body.matchAll(WHEN_EL)].map((m) => m[1].trim());
	const coords = [...body.matchAll(COORD_EL)].map((m) => m[1].trim());
	const out: { point: TrackPoint; timeMs: number | null }[] = [];
	for (let i = 0; i < coords.length; i++) {
		// "lon lat alt", space-separated (a LineString's commas are a
		// different grammar and must not share this splitter).
		const parts = coords[i].split(/\s+/).map(Number);
		const point = fix(parts, keepAlt);
		if (!point) {
			continue;
		}
		const stamp = whens[i] ? Date.parse(whens[i]) : Number.NaN;
		out.push({ point, timeMs: Number.isFinite(stamp) ? stamp : null });
	}
	return out;
}

/** One LineString: comma-separated lon,lat[,alt] triples, whitespace
 *  between them. Files in the wild also put spaces AFTER the commas, which
 *  would shatter a naive split. */
function linePoints(body: string): TrackPoint[] {
	const raw = COORDINATES_EL.exec(body)?.[1] ?? '';
	const keepAlt = altitudesKept(body, false);
	const out: TrackPoint[] = [];
	for (const tuple of raw.replace(/\s*,\s*/g, ',').trim().split(/\s+/)) {
		if (tuple === '') {
			continue;
		}
		const point = fix(tuple.split(',').map(Number), keepAlt);
		if (point) {
			// No times in this grammar: the monotonic 1 Hz clock parseGpx
			// synthesises, so replay still works and hasAbsoluteTime stays
			// false.
			point.timeMs = out.length * 1000;
			out.push(point);
		}
	}
	return out;
}

/** Whether this geometry's third coordinate is an altitude above sea level. */
function altitudesKept(body: string, timed: boolean): boolean {
	const mode = ALT_MODE_EL.exec(body)?.[1]?.trim().toLowerCase();
	if (mode == null) {
		return timed;
	}
	return mode === 'absolute';
}

/** One [lon, lat, alt?] triple as a point, or null when it is not a
 *  position. Altitude is metres in KML. */
function fix(parts: number[], keepAlt: boolean): TrackPoint | null {
	const [lon, lat, alt] = parts;
	if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) {
		return null;
	}
	return {
		lat,
		lon,
		altFt: keepAlt && Number.isFinite(alt) ? alt / M_PER_FT : null,
		timeMs: 0,
	};
}
