/* THE one answer to "what file is this outing?" (docs/trace-files.md).
 *
 * Two cases, and the whole point of the module is that every export surface
 * gets the same one: the row action, the traces ZIP and the flights bundle.
 *
 *  - An IMPORTED trace hands back its own bytes, byte for byte, under its own
 *    name. The app models neither an IGC's security record, pressure altitude
 *    and ENL, nor a GPX's extensions, so re-synthesising a third-party file
 *    would return a different document under the same claim. What the library
 *    stores of it (state/flightsDb.ts TraceSource) is the one thing in there
 *    that cannot be regenerated, and this is where it is spent.
 *  - A RECORDED trace has no such file, so it is synthesised from the points
 *    in the format the Settings tab names (`display.traceExportFormat`).
 *
 * `display.convertImportedTraces` is the deliberate override: on, everything
 * is synthesised in that one format, which is what a user asking to convert
 * their library means. Off (the default) the format selector governs only
 * what the application itself records, which is what its label says.
 *
 * Reads state; the pure serialisers stay in nav/traceExport.ts. */

import { fileName, fileStampUtc, fileToken } from '$lib/files/fileName';
import { summarizeFlights, type FlightSummary } from '$lib/nav/logbook';
import { buildTraceExport, flightOfDay, traceFileSpec } from '$lib/nav/traceExport';
import type { TraceFormat } from '$lib/nav/traceExport';
import { aircraftByKey } from './aircraft.svelte';
import { display } from './display.svelte';
import { getTraceSource, type OutingMeta } from './flightsDb';
import { flightLibrary, outingPoints, summaryDeps } from './flightLibrary.svelte';
import { flightPrep } from './flightPrep.svelte';
import { flownChainIdents } from './flightRows';
import { traceMotion } from './navMotion';
import { nav, traceAltDatum } from './navRecording.svelte';

export interface TraceFile {
	filename: string;
	/** Bytes for a pristine file (they must not pass through a string), a
	 *  string for one this application synthesised. */
	data: string | Uint8Array;
	mime: string;
	/** What the file actually is, so a caller can label the row it came
	 *  from rather than the setting. */
	format: TraceFormat;
	/** Whether these are the bytes the trace arrived as. */
	pristine: boolean;
}

/** The SUBJECT field of anything made from these flights: the aerodrome
 *  chain their wheels actually visited (docs/file-names.md).
 *
 *  The trace's own evidence, never a linked plan's. It survives a diversion,
 *  it answers with no plan catalog loaded, and it does not move when a plan
 *  is stored or deleted. Empty when nothing it touched is in the airport
 *  dataset, and the grammar then omits the field. */
export function traceSubjectOf(flights: readonly FlightSummary[]): string {
	return fileToken(flownChainIdents(flights).join('-'));
}

/** What names one FILED outing's file, straight off its archived
 *  summaries. */
export function outingFileSubject(meta: OutingMeta): string {
	return traceSubjectOf(meta.flights);
}

/** The same answer for the trace currently LOADED, so the Navigation tab's
 *  button, its printed profile and the flights row all hand back one trace
 *  under one name. Folded on demand rather than kept as a derived: the fold
 *  walks the whole trace and the callers are a click and a print claim, not
 *  every fix ingested while recording. */
export function loadedTraceSubject(): string {
	const points = nav.points;
	if (points.length === 0) {
		return '';
	}
	return traceSubjectOf(
		summarizeFlights(points, traceMotion(points), summaryDeps(traceAltDatum())),
	);
}

/** The export input one filed outing answers when it must be SYNTHESISED:
 *  its datum is the one FROZEN at archive time (never the live one), and the
 *  IGC header fields come from the row's own aircraft plus the dossier
 *  pilot. */
function exportInputFor(meta: OutingMeta): Parameters<typeof buildTraceExport>[1] {
	const plane = meta.aircraftKey ? aircraftByKey(meta.aircraftKey) : null;
	return {
		format: display.traceExportFormat,
		datum: meta.datum,
		atMs: meta.id,
		subject: outingFileSubject(meta),
		pilot: flightPrep.dossier.pilot.name,
		aircraftType: plane?.identity.type,
		aircraftId: plane?.identity.registration ?? meta.aircraftKey ?? undefined,
		flightOfDay: flightOfDay(
			meta.id,
			flightLibrary.rows.filter((r) => r.source === 'trace').map((r) => r.id),
		),
		softwareVersion: __APP_VERSION__,
	};
}

/** The file for one outing, or null when there is nothing to write (a
 *  logbook row holds no points, and a trace whose points have been evicted
 *  cannot be rebuilt). */
export async function traceFileFor(meta: OutingMeta): Promise<TraceFile | null> {
	if (meta.source === 'logbook') {
		return null;
	}
	if (!display.convertImportedTraces) {
		const src = await getTraceSource(meta.id);
		if (src) {
			const spec = traceFileSpec(src.format);
			return {
				// A provider that published no name still gets one, generated
				// exactly as buildTraceExport names a synthesised file: a ZIP
				// member must be named, and the two should not differ in style.
				filename:
					src.name || fileName([outingFileSubject(meta), fileStampUtc(meta.id)], spec.ext),
				data: src.bytes,
				mime: spec.mime,
				format: src.format,
				pristine: true,
			};
		}
	}
	const points = await outingPoints(meta.id);
	if (!points) {
		return null;
	}
	const built = buildTraceExport(points, exportInputFor(meta));
	return { ...built, data: built.text, pristine: false };
}
