/* What kind of file did we just receive?
 *
 * The app hands out route / workspace YAML, a plan in any of four interchange
 * formats (FPL, GPX, KML, PLN), aircraft data sheet YAML, a trace in any of
 * three formats (GPX, IGC, KML), NOTAM briefing text and a logbook CSV, and
 * takes all of them back. GPX and KML name two of those at once, a flown
 * TRACK and a planned ROUTE, so those two branches ask the route probes which
 * one they are holding (route/routeImport.ts). When a
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
import {
	looksLikeFpl,
	looksLikePln,
	looksLikeRouteGpx,
	looksLikeRouteKml,
} from '$lib/route/routeImport';

export type FileKind =
	| 'routes'
	| 'plan'
	| 'aircraft'
	| 'gpx'
	| 'igc'
	| 'kml'
	| 'notams'
	| 'logbook';

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
	// A GPX or a KML holds either a flown track or a planned route, and the
	// four route probes read the WHOLE text rather than the head: SDVFR writes
	// 4.8 KB of <Style> before its first <Placemark>, so its first <Point> sits
	// at character 7080 and a head-sized look would call every SDVFR route KML
	// a trace (docs/route-files.md).
	if (GPX_ROOT.test(head) || (isExt(name, '.gpx') && head.trimStart().startsWith('<?xml'))) {
		return looksLikeRouteGpx(text) ? 'plan' : 'gpx';
	}
	// Both trace formats have to be decided BEFORE the briefing markers at the
	// foot, and the reason outlives the rename: every trace exported under the
	// old name opens "AXNV001NOTAM Viewer" or names itself "NOTAM Viewer
	// <stamp>" in a KML <name>, so those files would read as a briefing. Such
	// files are on disks now and stay readable. The probes are structural (a
	// real B record, a kml root), never the word, so the order is what carries
	// it.
	if (looksLikeKml(head)) {
		return looksLikeRouteKml(text) ? 'plan' : 'kml';
	}
	// Neither format is a trace in any shape, so neither needs a branch of its
	// own above; both would otherwise fall through to the briefing markers.
	//
	// The WHOLE text again, and this one is measured: an FPL states its route
	// AFTER its waypoint table, and this app's own 22-point plan puts the
	// first route-point at character 4048. A head-sized look would refuse a
	// plan of 23 points as unreadable.
	if (looksLikeFpl(text) || looksLikePln(text)) {
		return 'plan';
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
