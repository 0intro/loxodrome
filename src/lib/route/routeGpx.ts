/* The route as GPX 1.1: the format every mapping tool reads, and one of the
 * four SDVFR takes. The trace writer next door (nav/gpx.ts) writes a <trk> of
 * where the aircraft WENT; this one writes a <rte> of where it is PLANNED to
 * go, which is a different element with different children, hence a different
 * module over the same hand-rolled kit.
 *
 * Both a <wpt> list and the <rte> are written, as SDVFR's own export does: the
 * <rte> is the route proper, and the waypoint list is what a reader keyed on a
 * waypoint database picks the points out of. The cost is that a tool importing
 * top-level <wpt> elements as standalone points (BaseCamp does) gains one pin
 * per waypoint; the alternative cost is a route SDVFR might not see at all,
 * and SDVFR is the measured target (docs/route-files.md).
 *
 * Child order is GPX's own xsd:sequence and is not negotiable: <ele> before
 * <name> inside a point, <name> before the points inside <rte>, <metadata>
 * before <rte>.
 *
 * Tested by tests/routeFormats.spec.ts. */

import { M_PER_FT, round, xmlEscape } from '$lib/nav/gpx';
import { MIN_POINTS, type RoutePoint } from './routePoints';

export interface BuildRouteGpxOpts {
	/** Document and route name, the pilot's own caption. UTF-8, so accents
	 *  ride as they are. */
	title: string;
}

/** What a point is called: its published identifier ahead of its own name
 *  ("LFPL LOGNES EMERAINVILLE"), the convention SDVFR writes and the nav log
 *  reads, and the bare name for a point that has no identifier to state. */
export function pointName(p: RoutePoint): string {
	return p.code && p.code !== p.name ? `${p.code} ${p.name}` : p.name;
}

/** The body of one <wpt> / <rtept>, indented `depth` tabs in. */
function pointBody(p: RoutePoint, depth: string): string[] {
	const lines: string[] = [];
	// The planned level of the leg LEAVING this point, in the metres GPX
	// states elevations in. The arrival states none: it has no leg to fly, and
	// an <ele> is optional, which is the honest way to say so.
	if (p.altFt != null) {
		lines.push(`${depth}<ele>${round(p.altFt * M_PER_FT, 1)}</ele>`);
	}
	lines.push(`${depth}<name>${xmlEscape(pointName(p))}</name>`);
	return lines;
}

/** Serialise the route as a GPX 1.1 document, or '' when there is no route to
 *  write. */
export function buildRouteGpx(points: readonly RoutePoint[], opts: BuildRouteGpxOpts): string {
	if (points.length < MIN_POINTS) {
		return '';
	}
	// i18n-ignore-start: GPX markup, a wire format, never user-visible text
	const lines: string[] = [];
	lines.push('<?xml version="1.0" encoding="UTF-8"?>');
	lines.push('<gpx version="1.1" creator="Loxodrome" xmlns="http://www.topografix.com/GPX/1/1">');
	lines.push('\t<metadata>');
	lines.push(`\t\t<name>${xmlEscape(opts.title)}</name>`);
	lines.push('\t</metadata>');
	// One entry per PLACE: a there-and-back names its aerodrome once, the same
	// rule the Garmin waypoint table follows.
	const written = new Set<string>();
	for (const p of points) {
		if (written.has(p.ident)) {
			continue;
		}
		written.add(p.ident);
		lines.push(`\t<wpt lat="${round(p.lat, 6)}" lon="${round(p.lon, 6)}">`);
		lines.push(...pointBody(p, '\t\t'));
		lines.push('\t</wpt>');
	}
	lines.push('\t<rte>');
	lines.push(`\t\t<name>${xmlEscape(opts.title)}</name>`);
	for (const p of points) {
		lines.push(`\t\t<rtept lat="${round(p.lat, 6)}" lon="${round(p.lon, 6)}">`);
		lines.push(...pointBody(p, '\t\t\t'));
		lines.push('\t\t</rtept>');
	}
	lines.push('\t</rte>');
	lines.push('</gpx>');
	// i18n-ignore-end
	return lines.join('\n') + '\n';
}
