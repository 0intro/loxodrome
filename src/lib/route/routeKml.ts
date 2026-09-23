/* The route as KML 2.2, the Google Earth format. Its sibling nav/kml.ts draws
 * a flown TRACE (a gx:Track carrying a clock); a planned route has no clock,
 * so it is a LineString for the course plus one Point placemark per waypoint,
 * which is also the shape SDVFR's own export takes.
 *
 * Tested by tests/routeFormats.spec.ts. */

import { M_PER_FT, round, xmlEscape } from '$lib/nav/gpx';
import { pointName } from './routeGpx';
import { ROUTE_COLORS } from './routeColors';
import { MIN_POINTS, levelsFlown, type RoutePoint } from './routePoints';

/** The route ink as KML's aabbggrr, from the app's own first route colour
 *  (#c2185b), so a plan opened in Google Earth is the colour it is drawn in
 *  here. Restated as a literal rather than converted at run time would hide
 *  the tie; the conversion is three slices of the shared constant. */
function kmlColor(hex: string): string {
	const rgb = hex.replace('#', '');
	return `ff${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`.toLowerCase();
}

export interface BuildRouteKmlOpts {
	/** Document, line and placemark caption, the pilot's own. */
	title: string;
}

/** "lon,lat,alt", KML's own axis order, altitude in metres above sea level.
 *  Under `absolute` a coordinate with no altitude means SEA LEVEL, which is
 *  why the arrival takes the level it arrives at (levelsFlown). */
function coord(p: RoutePoint, altFt: number | null): string {
	const lonLat = `${round(p.lon, 6)},${round(p.lat, 6)}`;
	return altFt == null ? lonLat : `${lonLat},${round(altFt * M_PER_FT, 1)}`;
}

/** Serialise the route as a KML 2.2 document, or '' when there is no route to
 *  write. */
export function buildRouteKml(points: readonly RoutePoint[], opts: BuildRouteKmlOpts): string {
	if (points.length < MIN_POINTS) {
		return '';
	}
	const alts = levelsFlown(points);
	const mode = alts.some((a) => a != null) ? 'absolute' : 'clampToGround';
	const title = xmlEscape(opts.title);

	// i18n-ignore-start: KML markup, a wire format, never user-visible text
	const lines: string[] = [];
	lines.push('<?xml version="1.0" encoding="UTF-8"?>');
	lines.push('<kml xmlns="http://www.opengis.net/kml/2.2">');
	lines.push('\t<Document>');
	lines.push(`\t\t<name>${title}</name>`);
	lines.push('\t\t<Style id="route">');
	lines.push('\t\t\t<LineStyle>');
	lines.push(`\t\t\t\t<color>${kmlColor(ROUTE_COLORS[0])}</color>`);
	lines.push('\t\t\t\t<width>3</width>');
	lines.push('\t\t\t</LineStyle>');
	lines.push('\t\t</Style>');
	lines.push('\t\t<Placemark>');
	lines.push(`\t\t\t<name>${title}</name>`);
	lines.push('\t\t\t<styleUrl>#route</styleUrl>');
	lines.push('\t\t\t<LineString>');
	lines.push(`\t\t\t\t<altitudeMode>${mode}</altitudeMode>`);
	lines.push('\t\t\t\t<coordinates>');
	points.forEach((p, i) => {
		lines.push(`\t\t\t\t\t${coord(p, alts[i])}`);
	});
	lines.push('\t\t\t\t</coordinates>');
	lines.push('\t\t\t</LineString>');
	lines.push('\t\t</Placemark>');
	// One placemark per PLACE, the waypoint-table rule: a there-and-back pins
	// its aerodrome once.
	const written = new Set<string>();
	points.forEach((p, i) => {
		if (written.has(p.ident)) {
			return;
		}
		written.add(p.ident);
		lines.push('\t\t<Placemark>');
		lines.push(`\t\t\t<name>${xmlEscape(pointName(p))}</name>`);
		lines.push('\t\t\t<Point>');
		lines.push(`\t\t\t\t<altitudeMode>${mode}</altitudeMode>`);
		lines.push(`\t\t\t\t<coordinates>${coord(p, alts[i])}</coordinates>`);
		lines.push('\t\t\t</Point>');
		lines.push('\t\t</Placemark>');
	});
	lines.push('\t</Document>');
	lines.push('</kml>');
	// i18n-ignore-end
	return lines.join('\n') + '\n';
}
