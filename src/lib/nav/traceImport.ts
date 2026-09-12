/* The trace import chokepoint, the mirror of traceExport.ts (contract:
 * docs/trace-files.md): the ONE place that maps a sniffed format to its
 * parser and states what the parsed altitudes are measured from. The three
 * import paths (the Navigation tab's picker, the openFile dispatcher for the
 * Android intents and ?file=, the flights batch importer) all come through
 * here, so a fourth format would touch no component.
 *
 * Pure (no Svelte, no storage). The datum is the whole reason this returns a
 * record rather than an array: GPX and KML state their reference in the
 * format itself, while an IGC file usually does not, and the difference is
 * ~45 m over France - straight into the airspace-alert floor tests, which is
 * why an unstated file asks the user rather than being guessed at. */

import type { AltDatum } from './altitudeDatum';
import { parseGpx } from './gpx';
import { parseIgc } from './igc';
import { parseKml } from './kml';
import type { TrackPoint } from './trace';
import type { TraceFormat } from './traceExport';

export interface ParsedTrace {
	points: TrackPoint[];
	/** What the altitudes are on; null when the FILE does not say and the
	 *  caller must ask (IGC alone). */
	datum: AltDatum | null;
}

/** Parse one trace file. Throws the parser's own message when the text holds
 *  no track, exactly as `parseGpx` always has. */
export function parseTraceFile(format: TraceFormat, text: string): ParsedTrace {
	switch (format) {
		case 'igc':
			return parseIgc(text);
		case 'kml':
			// KML's `absolute` altitude mode means "relative to sea level",
			// and every other mode yields no altitude at all, so what comes
			// back is MSL by construction.
			return { points: parseKml(text), datum: 'msl' };
		default:
			// A GPX <ele> is MSL by convention, which is what every other
			// tool writes and reads there.
			return { points: parseGpx(text), datum: 'msl' };
	}
}
