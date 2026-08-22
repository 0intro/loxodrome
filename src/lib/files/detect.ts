/* What kind of file did we just receive?
 *
 * The app hands out route / workspace YAML, aircraft data sheet YAML, a trace
 * in any of three formats (GPX, IGC, KML), NOTAM briefing text and a logbook
 * CSV, and takes all of them back. When a
 * file arrives from outside (an Android VIEW / SEND intent, the ?file= boot
 * parameter) nothing states which one it is: two of them share the .yaml
 * extension, and Android's display name is often absent or an opaque document
 * id. So the NAME is only a hint and the CONTENT decides. A KMZ never reaches
 * here: it is a ZIP container the caller unwraps first (files/kmz.ts), so this
 * module stays text-only.
 *
 * Pure and locale-free: the callers apply the kind, the tests pin it.
 */

import { looksLikeIgc } from '$lib/nav/igc';
import { looksLikeKml } from '$lib/nav/kml';

export type FileKind = 'routes' | 'aircraft' | 'gpx' | 'igc' | 'kml' | 'notams' | 'logbook';

/** The AMC logbook CSV's opening columns (nav/logbook.ts LOGBOOK_HEADER;
 *  kept literal here so the sniffer stays import-free). */
const LOGBOOK_CSV_PREFIX = 'date,departure_place,departure_time';

/** How much of the text the cheap structural probes read. A route or aircraft
 *  sheet declares itself in its first lines; a briefing carries its markers
 *  throughout, so only that last test reads the whole text. */
const HEAD_CHARS = 4096;

/** The saved-route grammar's one required top-level key (route/yaml.ts). */
const ROUTES_KEY = /^routes:/m;
/** The aircraft data sheet's (aircraft/schema.ts). */
const AIRCRAFT_KEY = /^aircraft:/m;
/** Any YAML document of ours opens with the format version. */
const VERSION_KEY = /^version:\s*\d/m;
const GPX_ROOT = /<gpx[\s>]/i;

/** ICAO NOTAM markers: the Q line of a full NOTAM, a series id (A0031/26), or
 *  the word itself (every briefing format we read says NOTAM somewhere: the
 *  raw ICAO text, the SOFIA PIB in either language, the autorouter dump). */
const NOTAM_MARKERS = [/^[ \t]*Q\)/m, /\b[A-Z]\d{4}\/\d{2}\b/, /\bNOTAM/i];

export function detectFileKind(name: string, text: string): FileKind | null {
	const head = text.slice(0, HEAD_CHARS);
	// A binary file that slipped through a generic MIME claim: nothing to read.
	if (head.includes('\0')) {
		return null;
	}
	if (GPX_ROOT.test(head) || (isExt(name, '.gpx') && head.trimStart().startsWith('<?xml'))) {
		return 'gpx';
	}
	// Both trace formats have to be decided BEFORE the briefing markers at the
	// foot, and the reason outlives the rename: every trace exported under the
	// old name opens "AXNV001NOTAM Viewer" or names itself "NOTAM Viewer
	// <stamp>" in a KML <name>, so those files would read as a briefing. Such
	// files are on disks now and stay readable. The probes are structural (a
	// real B record, a kml root), never the word, so the order is what carries
	// it.
	if (looksLikeKml(head)) {
		return 'kml';
	}
	if (looksLikeIgc(head)) {
		return 'igc';
	}
	if (head.replace(/^\uFEFF/, '').startsWith(LOGBOOK_CSV_PREFIX)) {
		return 'logbook';
	}
	if (ROUTES_KEY.test(head)) {
		return 'routes';
	}
	if (AIRCRAFT_KEY.test(head)) {
		return 'aircraft';
	}
	// A YAML document of ours that names neither: a corrupt or future file, NOT
	// a briefing. This test has to come first, because a route or aircraft file
	// saved under the old name carries "NOTAM Viewer" in its header comment and
	// would otherwise read as a briefing.
	if (VERSION_KEY.test(head) || isExt(name, '.yaml') || isExt(name, '.yml')) {
		return null;
	}
	if (NOTAM_MARKERS.some((re) => re.test(text))) {
		return 'notams';
	}
	return null;
}

function isExt(name: string, ext: string): boolean {
	return name.toLowerCase().endsWith(ext);
}
