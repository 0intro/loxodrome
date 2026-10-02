/* Hand-rolled GPX 1.1 serialise / parse for a recorded track, one of the three
 * formats the app reads and writes (docs/trace-files.md). Pure (no Svelte,
 * no DOMParser, so it runs under the vitest node environment) and tolerant on
 * read: attribute order, namespace prefixes, CRLF, and missing <ele>/<time> are
 * all accepted. Only the yaml package is available in this repo; GPX is XML, so
 * both directions are done by hand. Tested by tests/navGpx.spec.ts. */

import { MS_PER_KT, type TrackPoint } from './trace';

/** Metres in one foot. Shared with kml.ts and the route writers, which all
 *  state altitudes in the metres these formats are defined in. */
export const M_PER_FT = 0.3048;

/** Round to `dp` decimals (drops trailing zeros via Number). Shared for the
 *  same reason as xmlEscape: one hand-rolled-XML kit, one rounding. */
export function round(n: number, dp: number): number {
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
/** The stated ground speed / course over ground, either the Garmin
 *  TrackPointExtension (any prefix) or GPX 1.0's own bare children. Both
 *  conventions are metres per second / degrees true. */
const SPEED_RE = /<(?:\w+:)?speed\b[^>]*>\s*([^<]+?)\s*<\/(?:\w+:)?speed>/i;
const COURSE_RE = /<(?:\w+:)?course\b[^>]*>\s*([^<]+?)\s*<\/(?:\w+:)?course>/i;

/** Parse a GPX document into track points. Elevations are read as MSL, the
 *  format's convention, and the caller tags the trace accordingly so they are
 *  never geoid-corrected a second time. A stated ground speed / course rides
 *  along (the model reads them where the file states them; each is optional
 *  per fix). Tolerant of missing elevation (altFt null).
 *
 *  The clock: a document whose points carry no time at all gets the
 *  synthetic 1 Hz clock replay needs (from epoch 0, which hasAbsoluteTime
 *  reads as "no wall clock"). A document that states times keeps them
 *  EXACTLY: a fix whose stamp does not advance the clock (a receiver's
 *  backward step at a segment boundary, a duplicate, a missing <time> amid
 *  real ones) is DROPPED rather than re-stamped, because a fabricated stamp
 *  poisons the whole tail: the +1 s fill this rule replaced overtook a real
 *  sub-second clock at the first glitch and never gave the timeline back,
 *  stretching the remainder and dividing every derived speed. The IGC
 *  reader treats its own clock the same way (first fix per second, small
 *  backward steps as jitter). Throws when no track points are found. */
export function parseGpx(text: string): TrackPoint[] {
	interface Raw {
		lat: number;
		lon: number;
		altFt: number | null;
		timeMs: number | null;
		speedKt: number | null;
		trackDeg: number | null;
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
		const speedM = SPEED_RE.exec(body);
		const speedMs = speedM ? parseFloat(speedM[1]) : NaN;
		const courseM = COURSE_RE.exec(body);
		const course = courseM ? parseFloat(courseM[1]) : NaN;
		raw.push({
			lat,
			lon,
			altFt,
			timeMs: Number.isFinite(parsed) ? parsed : null,
			speedKt: Number.isFinite(speedMs) && speedMs >= 0 ? speedMs / MS_PER_KT : null,
			// A receiver may state 360.00 for due north; the model's range is [0, 360).
			trackDeg: Number.isFinite(course) ? ((course % 360) + 360) % 360 : null,
		});
	}
	if (raw.length === 0) {
		throw new Error('Invalid GPX: no track points found');
	}
	// A stated speed channel that reads 0 on every fix states nothing: some
	// writers emit <speed>0</speed> whatever the receiver measured, and every
	// fold prefers a stated speed to the hop it would otherwise derive, so
	// the trace would never take off. Dropped whole; the hops speak.
	if (raw.some((r) => r.speedKt != null) && raw.every((r) => r.speedKt == null || r.speedKt === 0)) {
		for (const r of raw) {
			r.speedKt = null;
		}
	}
	return stampedTrack(raw, (r, timeMs) => ({
		lat: r.lat,
		lon: r.lon,
		altFt: r.altFt,
		timeMs,
		...(r.speedKt != null ? { speedKt: r.speedKt } : {}),
		...(r.trackDeg != null ? { trackDeg: r.trackDeg } : {}),
	}));
}

/** The imported-clock rule, shared by the GPX and KML readers: raw fixes
 *  whose document stated no time at all get the synthetic 1 Hz clock from
 *  zero (hasAbsoluteTime then reads "no wall clock" and replay still works);
 *  a document that states times keeps them EXACTLY, a fix whose stamp does
 *  not advance the clock being dropped rather than re-stamped (see the
 *  parseGpx doc comment for why a fabricated stamp is worse than a lost
 *  fix). The output timeline is strictly increasing by construction. */
export function stampedTrack<R extends { timeMs: number | null }>(
	raw: readonly R[],
	build: (r: R, timeMs: number) => TrackPoint,
): TrackPoint[] {
	const out: TrackPoint[] = [];
	if (!raw.some((r) => r.timeMs != null)) {
		raw.forEach((r, i) => out.push(build(r, i * 1000)));
		return out;
	}
	let lastMs: number | null = null;
	for (const r of raw) {
		if (r.timeMs == null || (lastMs != null && r.timeMs <= lastMs)) {
			continue;
		}
		lastMs = r.timeMs;
		out.push(build(r, r.timeMs));
	}
	// Stated times that cannot form a timeline at all (every point carrying
	// the export's one <time>, a file written in reverse) are no clock: the
	// synthetic one, as for a document stating none, rather than a one-fix
	// trace that imports "successfully" and replays nothing. Judged over
	// the fixes that STATE a time: one stated time beside time-less fixes
	// is a defective fix, not an unusable clock.
	if (out.length < 2 && raw.filter((r) => r.timeMs != null).length >= 2) {
		return raw.map((r, i) => build(r, i * 1000));
	}
	return out;
}
