/* The route export chokepoint (contract: docs/route-files.md): the ONE place
 * that knows which interchange formats exist, what each file is called and
 * what MIME it claims, so adding a fifth never means touching a component.
 * The trace side has the same shape in nav/traceExport.ts.
 *
 * Pure: the caller resolves the points once (route/routePoints.ts) and passes
 * them here, so the four writers see the same identifiers and the same
 * altitudes and a plan cannot say one thing in one file and another in the
 * next. Tested by tests/routeExport.spec.ts. */

import { fileName } from '$lib/files/fileName';
import { buildRouteFpl } from './routeFpl';
import { buildRouteGpx } from './routeGpx';
import { buildRouteKml } from './routeKml';
import { buildRoutePln } from './routePln';
import { MAX_POINTS, MIN_POINTS, type RoutePoint } from './routePoints';

export type RouteFormat = 'fpl' | 'gpx' | 'kml' | 'pln';

export const ROUTE_FORMATS = ['fpl', 'gpx', 'kml', 'pln'] as const;

export function isRouteFormat(v: unknown): v is RouteFormat {
	return v === 'fpl' || v === 'gpx' || v === 'kml' || v === 'pln';
}

/** The token shown in labels and written in file names. Locale-invariant
 *  (docs/i18n.md: format codes are never translated), so it lives here and
 *  not in a catalog. */
export const ROUTE_FORMAT_LABEL: Record<RouteFormat, string> = {
	fpl: 'FPL',
	gpx: 'GPX',
	kml: 'KML',
	pln: 'PLN',
};

/** File extension and MIME per format, the single table.
 *
 *  The Garmin type is the one Android resolves an "open with" intent by, and
 *  the type SDVFR's own manifest lists, so it is what the hand-off claims;
 *  AceXML has no registered type at all and application/xml is the honest
 *  claim (the IGC precedent next door). A downloaded file is typed from its
 *  extension by every platform anyway. */
const SPEC: Record<RouteFormat, { ext: string; mime: string }> = {
	fpl: { ext: 'fpl', mime: 'application/vnd.garmin.flightplan' },
	gpx: { ext: 'gpx', mime: 'application/gpx+xml' },
	kml: { ext: 'kml', mime: 'application/vnd.google-earth.kml+xml' },
	pln: { ext: 'pln', mime: 'application/xml' },
};

/** The extension and MIME one format is written under. */
export function routeFileSpec(format: RouteFormat): { ext: string; mime: string } {
	return SPEC[format];
}

/** Garmin's cap on the route-points of ONE FlightPlan v1 route, stated beside
 *  the minimum in route/routePoints.ts. Never enforced by truncation on the
 *  way OUT: a navigator handed a plan that stops short of its destination is
 *  worse than one it refuses whole, so the file is written entire and the
 *  caller is told how many points it holds. */
export const ROUTE_POINT_CAP = MAX_POINTS;

export interface RouteExportInput {
	format: RouteFormat;
	/** The file's subject field, ASCII: the aerodrome chain or the plan's own
	 *  name, as files/fileName.ts folds it. Names the file, and rides inside
	 *  the FPL and the PLN, whose text fields are pattern-restricted. */
	subject: string;
	/** The caption a human reads, accents and all: the GPX metadata name and
	 *  the KML document name. The subject when the caller has nothing better. */
	title?: string | undefined;
	/** The flight rules the plan is drawn under, which only the PLN states. */
	vfr: boolean;
}

export interface RouteExportFile {
	text: string;
	filename: string;
	mime: string;
	format: RouteFormat;
	/** Route points written. Never above ROUTE_POINT_CAP: past it there is no
	 *  file, the reader refusing a document that long. */
	points: number;
}

/** Serialise one route (or a whole plan's points) for download, or null when
 *  there is no route to write: every format wants a departure and an arrival. */
export function buildRouteExport(
	points: readonly RoutePoint[],
	input: RouteExportInput,
): RouteExportFile | null {
	// Both bounds, so the app never writes a file it cannot read back: the
	// reader refuses past the cap because a track CONVERTED to a route is a
	// legal file of thousands of points (routeImport.ts), and a writer that
	// ignored the same cap would produce exports of its own that the Load row
	// then refuses with no way in.
	if (points.length < MIN_POINTS || points.length > MAX_POINTS) {
		return null;
	}
	const title = input.title ?? input.subject;
	let text: string;
	switch (input.format) {
		case 'fpl':
			text = buildRouteFpl(points, { subject: input.subject, title: input.title });
			break;
		case 'kml':
			text = buildRouteKml(points, { title });
			break;
		case 'pln':
			text = buildRoutePln(points, { subject: input.subject, title: input.title, vfr: input.vfr });
			break;
		default:
			text = buildRouteGpx(points, { title });
	}
	// The kind token stays on all four, .gpx and .kml included, although a
	// trace file omits it: the extension only states "track" while a track is
	// the only thing the app writes in it, and it no longer is
	// (docs/file-names.md).
	return {
		text,
		filename: fileName([input.subject, 'plan'], SPEC[input.format].ext),
		mime: SPEC[input.format].mime,
		format: input.format,
		points: points.length,
	};
}
