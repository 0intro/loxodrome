/* The Garmin FlightPlan v1 file (.fpl): the interchange a panel-mount Garmin,
 * Garmin Pilot and ForeFlight read. SDVFR advertises it and cannot currently
 * load one, its own exports included, as it cannot load any of the four
 * (docs/route-files.md, "What SDVFR actually imports"). Written by hand like the trace
 * formats, and to Garmin's own published schema
 * (http://www8.garmin.com/xmlschemas/FlightPlanv1.xsd), whose restrictions are
 * NOT decorative and are the reason for most of what follows:
 *
 *   identifier            [A-Z0-9]{1,12}
 *   type                  USER WAYPOINT | AIRPORT | NDB | VOR | INT | INT-VRP
 *   country-code          ([A-Z0-9]{2})|      (empty for a user waypoint)
 *   comment, route-name   ([A-Z0-9 /]{1,25})|
 *   lat / lon             decimal, |lat| <= 90, |lon| <= 180
 *   flight-plan-index     1 to 98
 *   waypoint-table        xsd:key on (identifier, type, country-code), and
 *                         every route-point is a keyref into it
 *
 * That key is why the table holds each identifier ONCE and the route
 * references it: a there-and-back writes LFPL once and points at it twice.
 * SDVFR's own exports repeat the row instead and do not validate.
 *
 * Only an aerodrome is typed as more than a user waypoint (docs/route-files.md):
 * a beacon identifier is not unique (MLN is Melun and Melilla), and a reader
 * that trusts the type over the coordinates would move the point. Everything
 * carries lat/lon regardless, so no reader can lose one.
 *
 * Tested by tests/routeFormats.spec.ts. */

import { round, xmlEscape } from '$lib/nav/gpx';
import { MIN_POINTS, type RoutePoint } from './routePoints';

/** Longest comment / route name the schema takes. */
const TEXT_LEN = 25;

/** Accents folded to their base letter, and anything still outside ASCII
 *  dropped: the whole document stays inside 7 bits, which is what a
 *  panel-mount navigator reading a card can be relied on to parse. Case and
 *  punctuation survive, unlike in fplText below. */
export function asciiFold(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^\x20-\x7e]/g, '');
}

/** Text as `Comment_t` and `RouteName_t` allow it: upper-case ASCII
 *  alphanumerics, spaces and slashes, at most 25 characters. Accents fold to
 *  their base letter rather than punching a hole in the word, the fold
 *  files/fileName.ts and nav/igc.ts already apply; everything else becomes a
 *  space, so "L'obélisque" reads "L OBELISQUE" and not "LOBELISQUE". */
export function fplText(text: string): string {
	return asciiFold(text)
		.toUpperCase()
		.replace(/[^A-Z0-9 /]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, TEXT_LEN)
		.trim();
}

export interface BuildFplOpts {
	/** The file's own subject: an ASCII filename field (files/fileName.ts),
	 *  and what the description falls back to. */
	subject: string;
	/** The plan's caption where it has one, which is what a navigator lists
	 *  it under and what a reader gives back (docs/route-files.md). Folded
	 *  here: the description takes ASCII and the route name is stricter
	 *  still. */
	title?: string | undefined;
}

/** The waypoint type a point is written under. */
function typeOf(p: RoutePoint): string {
	return p.aerodrome ? 'AIRPORT' : 'USER WAYPOINT';
}

/** Serialise the route as a Garmin FlightPlan v1 document, or '' when there is
 *  no route to write. */
export function buildRouteFpl(points: readonly RoutePoint[], opts: BuildFplOpts): string {
	if (points.length < MIN_POINTS) {
		return '';
	}
	// i18n-ignore-start: FlightPlan v1 markup, a wire format, never user-visible
	const lines: string[] = [];
	lines.push('<?xml version="1.0" encoding="UTF-8"?>');
	lines.push('<flight-plan xmlns="http://www8.garmin.com/xmlschemas/FlightPlan/v1">');
	const caption = opts.title?.trim() || opts.subject;
	if (caption) {
		// Unrestricted, unlike route-name below: the caption rides folded to
		// ASCII and no further.
		lines.push(`\t<file-description>${xmlEscape(asciiFold(caption))}</file-description>`);
	}
	lines.push('\t<waypoint-table>');
	const written = new Set<string>();
	for (const p of points) {
		if (written.has(p.ident)) {
			continue;
		}
		written.add(p.ident);
		const comment = fplText(p.name);
		lines.push('\t\t<waypoint>');
		lines.push(`\t\t\t<identifier>${p.ident}</identifier>`);
		lines.push(`\t\t\t<type>${typeOf(p)}</type>`);
		// EMPTY on purpose, for an aerodrome as much as a user waypoint: this is
		// Garmin's own two-character region code (LF, EG, K1) and the airports
		// dataset states an ISO country ("FR"), which is a different thing that
		// happens to fit the pattern. The schema itself asks for empty here.
		lines.push('\t\t\t<country-code/>');
		lines.push(`\t\t\t<lat>${round(p.lat, 6)}</lat>`);
		lines.push(`\t\t\t<lon>${round(p.lon, 6)}</lon>`);
		lines.push(comment ? `\t\t\t<comment>${comment}</comment>` : '\t\t\t<comment/>');
		// What the comment's own alphabet lost: its case, its punctuation, and
		// anything past 25 characters. "For reference only and ignored by the
		// device", so it costs a reader nothing and keeps the pilot's own name
		// for the point in the file. Written only when it says more than the
		// comment already does, which its case alone is not.
		const described = asciiFold(p.name);
		if (described.toUpperCase() !== comment) {
			lines.push(`\t\t\t<waypoint-description>${xmlEscape(described)}</waypoint-description>`);
		}
		lines.push('\t\t</waypoint>');
	}
	lines.push('\t</waypoint-table>');
	lines.push('\t<route>');
	lines.push(`\t\t<route-name>${fplText(caption)}</route-name>`);
	// Where the navigator files the route in its own catalogue. 1 is the
	// schema's stated default.
	lines.push('\t\t<flight-plan-index>1</flight-plan-index>');
	for (const p of points) {
		lines.push('\t\t<route-point>');
		lines.push(`\t\t\t<waypoint-identifier>${p.ident}</waypoint-identifier>`);
		lines.push(`\t\t\t<waypoint-type>${typeOf(p)}</waypoint-type>`);
		lines.push('\t\t\t<waypoint-country-code/>');
		lines.push('\t\t</route-point>');
	}
	lines.push('\t</route>');
	lines.push('</flight-plan>');
	// i18n-ignore-end
	return lines.join('\n') + '\n';
}
