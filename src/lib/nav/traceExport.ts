/* The trace export chokepoint (contract: docs/trace-files.md): the ONE
 * place that knows which formats exist, what each file is called, what MIME
 * it claims, and which vertical datum each writer wants. The three export
 * actions (the Navigation tab's trace, a filed outing's row, the flights
 * ZIP) all come through here, so adding a format never means touching a
 * component.
 *
 * Pure (no Svelte, no storage): the caller resolves the trace's AltDatum
 * (traceAltDatum() for the loaded trace, meta.datum frozen at archive time
 * for a filed outing) and this module turns it into the per-format altitude
 * callbacks. GPX and KML write MSL metres, IGC writes metres above the WGS84
 * ellipsoid; that inversion is the whole reason the conversion lives in one
 * function. Tested by tests/navTraceExport.spec.ts. */

import { fileName, fileStampUtc, fileStem } from '$lib/files/fileName';
import { ellipsoidAltFt, mslAltFt, type AltDatum } from './altitudeDatum';
import { buildGpx } from './gpx';
import { buildIgc } from './igc';
import { buildKml } from './kml';
import { hasAbsoluteTime, type TrackPoint } from './trace';

export type TraceFormat = 'gpx' | 'igc' | 'kml';

export const TRACE_FORMATS = ['gpx', 'igc', 'kml'] as const;

export function isTraceFormat(v: unknown): v is TraceFormat {
	return v === 'gpx' || v === 'igc' || v === 'kml';
}

/** The token shown in labels and written in file names. Locale-invariant
 *  (docs/i18n.md: format codes are never translated), so it lives here and
 *  not in a catalog. */
export const TRACE_FORMAT_LABEL: Record<TraceFormat, string> = {
	gpx: 'GPX',
	igc: 'IGC',
	kml: 'KML',
};

/** File extension and MIME per format, the single table. IGC has no
 *  registered IANA type, so text/plain is the honest claim; downloadBlob's
 *  native path types the file from its extension anyway (docs/android.md). */
const SPEC: Record<TraceFormat, { ext: string; mime: string }> = {
	gpx: { ext: 'gpx', mime: 'application/gpx+xml' },
	igc: { ext: 'igc', mime: 'text/plain' },
	kml: { ext: 'kml', mime: 'application/vnd.google-earth.kml+xml' },
};

/** The extension and MIME one format is written under. Exported for the
 *  PRISTINE path (state/traceFile.ts), which hands back an imported file's
 *  own bytes and so never builds a TraceExportFile to read them off. */
export function traceFileSpec(format: TraceFormat): { ext: string; mime: string } {
	return SPEC[format];
}

/** What will ACTUALLY be written. An IGC file states one UTC date in its
 *  header and carries only HHMMSS per fix, so a trace on the synthesised
 *  1 Hz clock (parseGpx's fallback for a GPX with no <time>) has no date to
 *  write and degrades to GPX rather than claiming 1 January 1970. The
 *  preference itself is never rewritten; the surfaces show the resolved
 *  answer, the resolveAltDatum idiom. */
export function resolveTraceFormat(
	format: TraceFormat,
	points: readonly TrackPoint[],
): TraceFormat {
	return format === 'igc' && !hasAbsoluteTime(points) ? 'gpx' : format;
}

export interface TraceExportInput {
	format: TraceFormat;
	/** What the STORED altitudes are on. */
	datum: AltDatum;
	/** Stamps the file name and dates the IGC header: the trace's start. */
	atMs: number;
	/** The flown aerodrome chain, ALREADY a filename field ("LFPN-LFOZ"):
	 *  the file's subject, and the track's name inside it. Empty or absent
	 *  when nothing the trace touched is known, and the grammar then omits
	 *  the field (files/fileName.ts, docs/file-names.md). */
	subject?: string | undefined;
	/** IGC header fields; absent values leave their record empty. */
	pilot?: string | undefined;
	aircraftType?: string | undefined;
	aircraftId?: string | undefined;
	/** The trace's rank in its UTC day (IGC's HFDTEDATE NN). */
	flightOfDay?: number | undefined;
	softwareVersion?: string | undefined;
}

export interface TraceExportFile {
	text: string;
	filename: string;
	mime: string;
	/** What was written, after resolveTraceFormat. */
	format: TraceFormat;
}

/** Serialise one trace for download. */
export function buildTraceExport(
	points: readonly TrackPoint[],
	input: TraceExportInput,
): TraceExportFile {
	const format = resolveTraceFormat(input.format, points);
	// The extension already says this is a track, so the grammar's kind field
	// is omitted and the name is subject + start: "LFPN-LFOZ_20260707T1432Z".
	// The GPX <trk> and KML <Document> take the SAME string, so a file and
	// the track inside it cannot be called different things in Google Earth;
	// what says where it came from is the GPX creator attribute and the IGC A
	// record, not the track's name (docs/trace-files.md).
	const fields = [input.subject, fileStampUtc(input.atMs)];
	const name = fileStem(fields);
	const msl = (p: TrackPoint): number | null => mslAltFt(p.altFt, p.lat, p.lon, input.datum);
	const ell = (p: TrackPoint): number | null =>
		ellipsoidAltFt(p.altFt, p.lat, p.lon, input.datum);
	const pts = [...points];
	let text: string;
	switch (format) {
		case 'igc':
			text = buildIgc(pts, {
				altEllipsoidFt: ell,
				pilot: input.pilot,
				aircraftType: input.aircraftType,
				aircraftId: input.aircraftId,
				flightOfDay: input.flightOfDay,
				softwareVersion: input.softwareVersion,
			});
			break;
		case 'kml':
			text = buildKml(pts, { name, altMslFt: msl });
			break;
		default:
			text = buildGpx(pts, { name, altMslFt: msl });
	}
	return {
		text,
		filename: fileName(fields, SPEC[format].ext),
		mime: SPEC[format].mime,
		format,
	};
}

/** The 1-based rank of `ms` among the instants sharing its UTC date, oldest
 *  first: IGC's "flight number on the day" (HFDTEDATE NN), which a filed
 *  outing can answer from the library's own ids. */
export function flightOfDay(ms: number, allMs: readonly number[]): number {
	const day = (v: number): string => new Date(v).toISOString().slice(0, 10);
	const d = day(ms);
	const sameDay = allMs.filter((v) => day(v) === d).sort((a, b) => a - b);
	const i = sameDay.indexOf(ms);
	return i < 0 ? 1 : i + 1;
}
