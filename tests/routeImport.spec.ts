/* Reading a plan back out of an interchange file (docs/route-files.md).
 *
 * The four readers are pinned against SDVFR's OWN exports, trimmed to four
 * waypoints and otherwise verbatim: a foreign writer's bytes are the only
 * evidence that cannot be wrong in the same direction as ours. Every
 * assertion is a literal value read from those files by hand, never a
 * round trip through the matching writer.
 *
 * The quirks those fixtures carry, and which this file exists to hold:
 * SDVFR's KML writes every coordinate tuple comma-joined with NO whitespace
 * and closes each Point's own tuple with a trailing comma; its PLN writes the
 * departure and the arrival TWICE and states an invalid 60th second; its FPL
 * names every point by a mangled five-character identifier and leaves the
 * comment empty; and its style blocks push the first placemark past the 4096
 * characters files/detect.ts reads of a head. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MAX_POINTS } from '$lib/route/routePoints';
import {
	identCandidates,
	looksLikeFpl,
	looksLikePln,
	looksLikeRouteGpx,
	looksLikeRouteKml,
	parseWorldPosition,
	readRouteFile,
	routeFileFormat,
	type ImportedPoint,
} from '$lib/route/routeImport';
import { buildGpx } from '$lib/nav/gpx';
import { buildKml } from '$lib/nav/kml';

function sdvfr(ext: string): string {
	return readFileSync(new URL(`./fixtures/sdvfr/route.${ext}`, import.meta.url), 'utf-8');
}

/** A recorded track, for the probes to refuse. */
const TRACE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Loxodrome" xmlns="http://www.topografix.com/GPX/1/1">
	<trk><name>x</name><trkseg>
		<trkpt lat="48.6" lon="2.68"><ele>360</ele><time>2026-02-17T10:41:00.000Z</time></trkpt>
		<trkpt lat="48.7" lon="2.7"><ele>730</ele><time>2026-02-17T10:42:00.000Z</time></trkpt>
	</trkseg></trk>
</gpx>
`;

describe('the format probes', () => {
	it('tells a planned route from a flown track', () => {
		expect(looksLikeRouteGpx(sdvfr('gpx'))).toBe(true);
		expect(looksLikeRouteGpx(TRACE_GPX)).toBe(false);
		expect(looksLikeRouteKml(sdvfr('kml'))).toBe(true);
		expect(routeFileFormat(TRACE_GPX)).toBeNull();
	});

	it('refuses a GPX that carries a track as well, whatever else it holds', () => {
		// A recording is the artefact the app cannot re-derive.
		const both = TRACE_GPX.replace('</gpx>', '<rte><rtept lat="48.6" lon="2.6"/></rte></gpx>');
		expect(looksLikeRouteGpx(both)).toBe(false);
	});

	it('reads a route that flies the same fields over and over', () => {
		// Five circuits between two fields: many more vertices than pins, which
		// a counting rule reads as a trace. Every vertex stands ON a pin, and
		// that is what says it is a route.
		const legs = Array.from({ length: 5 }, () => '2.62,48.82,457 2.86,48.79,457').join(' ');
		const pin = (n: string, c: string): string =>
			`<Placemark><name>${n}</name><Point><coordinates>${c}</coordinates></Point></Placemark>`;
		const kml =
			'<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Tours</name>' +
			`<Placemark><LineString><coordinates>${legs}</coordinates></LineString></Placemark>` +
			pin('LFPL', '2.62,48.82,457') +
			pin('A', '2.86,48.79,457') +
			'</Document></kml>';
		expect(looksLikeRouteKml(kml)).toBe(true);
		expect(readRouteFile(kml).routes[0].points).toHaveLength(10);
	});

	it('refuses a trace KML with a pin at each end', () => {
		// Two placemarks over a line of many vertices is a drawn track, not a
		// four-point plan: a route's line has one vertex per waypoint.
		const vertices = Array.from({ length: 40 }, (_, i) => `2.6${i},48.8${i},300`).join(' ');
		const pin = (n: string, c: string): string =>
			`<Placemark><name>${n}</name><Point><coordinates>${c}</coordinates></Point></Placemark>`;
		const kml =
			'<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
			`<Placemark><LineString><coordinates>${vertices}</coordinates></LineString></Placemark>` +
			pin('Start', '2.60,48.80,300') +
			pin('End', '2.69,48.89,300') +
			'</Document></kml>';
		expect(looksLikeRouteKml(kml)).toBe(false);
	});

	it('refuses an airspace dataset, which is rings and no route', () => {
		const kml =
			'<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
			'<Placemark><name>LF R 45</name><Point><coordinates>2.6,48.8</coordinates></Point></Placemark>' +
			'<Placemark><name>LF R 46</name><Point><coordinates>2.7,48.9</coordinates></Point></Placemark>' +
			'<Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>2.6,48.8 2.7,48.9 2.6,48.8' +
			'</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>';
		expect(looksLikeRouteKml(kml)).toBe(false);
	});

	it('refuses an FPL that is a waypoint library rather than a route', () => {
		// A table and no route is how user waypoints are uploaded to a
		// panel-mount navigator; it states places, not an order to fly them.
		const table = sdvfr('fpl').replace(/<route>[\s\S]*<\/route>/, '');
		expect(looksLikeFpl(table)).toBe(false);
		expect(routeFileFormat(table)).toBeNull();
	});

	it('knows the two formats that are never a trace', () => {
		expect(looksLikeFpl(sdvfr('fpl'))).toBe(true);
		expect(looksLikePln(sdvfr('pln'))).toBe(true);
		expect(routeFileFormat(sdvfr('fpl'))).toBe('fpl');
		expect(routeFileFormat(sdvfr('pln'))).toBe('pln');
		expect(routeFileFormat('shopping list\nmilk\n')).toBeNull();
	});

	it('reads the whole document, not a head', () => {
		// SDVFR writes 4.8 KB of <Style> first: a head-sized look would call
		// every one of its route KMLs a trace.
		expect(sdvfr('kml').indexOf('<Point>')).toBeGreaterThan(4096);
	});
});

describe('readRouteFile: GPX', () => {
	const plan = readRouteFile(sdvfr('gpx'));

	it('reads the route, its caption and its points in order', () => {
		expect(plan.format).toBe('gpx');
		expect(plan.title).toBe('Châteaux de Picardie');
		expect(plan.routes[0].points.map((p) => p.name)).toEqual([
			'LFPL LOGNES EMERAINVILLE',
			"L'obélisque",
			'CLM COULOMMIERS',
			'LFPL LOGNES EMERAINVILLE',
		]);
		expect(plan.routes[0].points[1].lat).toBeCloseTo(48.791600627042, 9);
		expect(plan.routes[0].points[1].lon).toBeCloseTo(2.8691714914193, 9);
	});

	it('reads the stated levels in feet, and none at the arrival', () => {
		// 457.2 m and 609.6 m are exactly 1500 ft and 2000 ft; the file's own
		// <ele>0</ele> tail is what an arrival must NOT come back with.
		expect(plan.routes[0].points.map((p) => p.altFt)).toEqual([1500, 2000, 1500, null]);
	});

	it('offers the leading token of a name as an identifier to confirm', () => {
		expect(identCandidates(plan.routes[0].points[0])).toEqual(['LFPL']);
		expect(identCandidates(plan.routes[0].points[2])).toEqual(['CLM']);
		expect(identCandidates(plan.routes[0].points[1])).toEqual([]);
	});
});

describe('readRouteFile: KML', () => {
	const plan = readRouteFile(sdvfr('kml'));

	it('reads the point placemarks, not the line', () => {
		expect(plan.format).toBe('kml');
		expect(plan.title).toBe('Châteaux de Picardie');
		expect(plan.routes[0].points.map((p) => p.name)).toEqual([
			'LFPL LOGNES EMERAINVILLE',
			"L'obélisque",
			'CLM COULOMMIERS',
			'LFPL LOGNES EMERAINVILLE',
		]);
	});

	it("survives SDVFR's trailing comma rather than reading a sea-level fix", () => {
		// "2.622778,48.821944,457.2," : an empty field is not a zero.
		expect(plan.routes[0].points[0].lat).toBeCloseTo(48.821944, 6);
		expect(plan.routes[0].points[0].lon).toBeCloseTo(2.622778, 6);
		expect(plan.routes[0].points.map((p) => p.altFt)).toEqual([1500, 2000, 1500, null]);
	});
});

describe('readRouteFile: FPL', () => {
	const plan = readRouteFile(sdvfr('fpl'));

	it('follows the route through the waypoint table', () => {
		expect(plan.format).toBe('fpl');
		expect(plan.title).toBe('CHATEAUXDEPICARDIE');
		expect(plan.routes[0].points.map((p) => p.ident)).toEqual(['LFPLL', 'LOBEL1', 'CLMCO2', 'LFPLL']);
		expect(plan.routes[0].points[0].lat).toBeCloseTo(48.821944, 6);
	});

	it('states no altitude, the format having none', () => {
		expect(plan.routes[0].points.every((p) => p.altFt === null)).toBe(true);
	});

	it('names a point after its identifier when the file kept no name', () => {
		// SDVFR writes <comment/> empty, so the mangled identifier is the only
		// name its file holds.
		expect(plan.routes[0].points.map((p) => p.name)).toEqual(['LFPLL', 'LOBEL1', 'CLMCO2', 'LFPLL']);
	});

	it('offers the ICAO-shaped head of a mangled identifier', () => {
		expect(identCandidates(plan.routes[0].points[0])).toEqual(['LFPLL', 'LFPL']);
	});
});

describe('readRouteFile: PLN', () => {
	const plan = readRouteFile(sdvfr('pln'));

	it('reads the plan, its rules and its identifiers', () => {
		expect(plan.format).toBe('pln');
		expect(plan.title).toBe('ChateauxdePicardie');
		expect(plan.vfr).toBe(true);
		expect(plan.routes[0].points.map((p) => p.ident)).toEqual(['LFPL', null, 'LFPL']);
		expect(plan.routes[0].points[0].aerodrome).toBe(true);
	});

	it('collapses the endpoints SDVFR writes twice', () => {
		// An Airport and a User waypoint at one position, at each end: two
		// zero-length legs. The survivor is the one that states an identifier.
		expect(plan.routes[0].points).toHaveLength(3);
		expect(plan.routes[0].points[0].ident).toBe('LFPL');
	});

	it('reads the position out of the simulator degrees, minutes and seconds', () => {
		// Read back through the arithmetic, never against the writer's text.
		expect(plan.routes[0].points[1].lat).toBeCloseTo(48.7916, 4);
		expect(plan.routes[0].points[1].lon).toBeCloseTo(2.86917, 4);
		expect(plan.routes[0].points.map((p) => p.altFt)).toEqual([1500, 2000, null]);
	});
});

describe('parseWorldPosition', () => {
	it('reads each hemisphere', () => {
		const p = parseWorldPosition('S48° 49\' 19.00",W002° 37\' 22.00",-000500.00');
		expect(p?.lat).toBeCloseTo(-48.821944, 6);
		expect(p?.lon).toBeCloseTo(-2.622778, 6);
		expect(p?.altFt).toBe(-500);
	});

	it("carries SDVFR's invalid sixtieth second rather than refusing it", () => {
		// Their writer rounds the seconds in isolation and prints 8' 60.00";
		// 49° 8' 60" IS 49° 9' 0", so the arithmetic simply carries.
		const p = parseWorldPosition('N49° 8\' 60.00",E002° 41\' 11.00",+001500.00');
		expect(p?.lat).toBeCloseTo(49.15, 6);
	});

	it('refuses what is not a position', () => {
		expect(parseWorldPosition('N48 49 19')).toBeNull();
		expect(parseWorldPosition(null)).toBeNull();
	});
});

describe('what a reader refuses', () => {
	it('needs a departure and an arrival', () => {
		const one =
			'<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1"><rte>' +
			'<rtept lat="48.8" lon="2.6"><name>A</name></rtept></rte></gpx>';
		expect(() => readRouteFile(one)).toThrow(/no route found/);
	});

	it('says so when the text is no plan at all', () => {
		expect(() => readRouteFile('shopping list')).toThrow(/Not a flight plan/);
		expect(() => readRouteFile(TRACE_GPX)).toThrow(/Not a flight plan/);
	});

	it('leaves this app\'s own trace writers alone', () => {
		const points = [
			{ timeMs: 1_770_000_000_000, lat: 48.6, lon: 2.68, altFt: 1200 },
			{ timeMs: 1_770_000_060_000, lat: 48.7, lon: 2.7, altFt: 2400 },
		];
		expect(routeFileFormat(buildGpx(points, { name: 'x' }))).toBeNull();
		expect(routeFileFormat(buildKml(points, { name: 'x' }))).toBeNull();
	});
});

describe('identCandidates', () => {
	const point = (extra: Partial<ImportedPoint>): ImportedPoint => ({
		ident: null,
		aerodrome: false,
		name: null,
		lat: 48.8,
		lon: 2.6,
		altFt: null,
		...extra,
	});

	it('takes what the file states before what a name suggests', () => {
		expect(identCandidates(point({ ident: 'LFPK', name: 'LFPL LOGNES' }))).toEqual([
			'LFPK',
			'LFPL',
		]);
	});

	it('offers nothing from a name that is only a name', () => {
		expect(identCandidates(point({ name: "L'obélisque" }))).toEqual([]);
		expect(identCandidates(point({ name: 'Abbaye de Chaalis' }))).toEqual([]);
	});

	it('recovers an ICAO code a long machine-written name buries', () => {
		// SDVFR's PLN puts the whole name in the ATCWaypoint id, ten characters
		// of it: Compiegne arrived as LFADCOMPIE and came back a nameless free
		// point beside its own aerodrome, with no runways, frequencies or
		// weather. A name a HUMAN wrote is left alone, however ICAO-shaped its
		// first four characters look.
		expect(identCandidates(point({ name: 'LFADCOMPIE' }))).toEqual(['LFAD']);
		expect(identCandidates(point({ name: 'LFPLLOGNES' }))).toEqual(['LFPL']);
		expect(identCandidates(point({ name: 'Abbaye de Chaalis' }))).toEqual([]);
		expect(identCandidates(point({ name: 'Pontoise nord' }))).toEqual([]);
	});

	it('never repeats a candidate', () => {
		expect(identCandidates(point({ ident: 'CLM', name: 'CLM COULOMMIERS' }))).toEqual(['CLM']);
	});
});

describe('the grammars a foreign writer may use', () => {
	const kml = (coords: string, pins: string, mode = ''): string =>
		'<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
		'<name>T</name><Placemark><LineString>' +
		(mode === '' ? '' : `<altitudeMode>${mode}</altitudeMode>`) +
		`<coordinates>${coords}</coordinates></LineString></Placemark>` +
		pins +
		'</Document></kml>';
	const pin = (n: string, c: string): string =>
		`<Placemark><name>${n}</name><Point><coordinates>${c}</coordinates></Point></Placemark>`;

	it('reads a KML whose tuples state no altitude', () => {
		// Two components per tuple is legal KML and common. Read as a flat run
		// of threes it puts the second point at 3.01, 48.79: a LONGITUDE read
		// as a latitude, which draws the route somewhere else entirely.
		const doc = kml(
			'2.622778,48.821944 2.869171,48.791601 3.014444,48.8375',
			pin('A', '2.622778,48.821944') + pin('B', '2.869171,48.791601') + pin('C', '3.014444,48.8375'),
		);
		const points = readRouteFile(doc).routes[0].points;
		expect(points.map((p) => [p.lat, p.lon])).toEqual([
			[48.821944, 2.622778],
			[48.791601, 2.869171],
			[48.8375, 3.014444],
		]);
		expect(points.every((p) => p.altFt === null)).toBe(true);
	});

	it('reads a KML whose tuples carry altitudes, whitespace-separated', () => {
		const doc = kml(
			'2.622778,48.821944,457.2 2.869171,48.791601,609.6',
			pin('A', '2.622778,48.821944,457.2') + pin('B', '2.869171,48.791601,609.6'),
			'absolute',
		);
		expect(readRouteFile(doc).routes[0].points.map((p) => p.altFt)).toEqual([1500, null]);
	});

	it('reads a PLN position that states no seconds', () => {
		const pln =
			'<?xml version="1.0"?><SimBase.Document Type="AceXML" version="1,0">' +
			'<Descr>AceXML Document</Descr><FlightPlan.FlightPlan><Title>T</Title>' +
			'<ATCWaypoint id="A"><ATCWaypointType>User</ATCWaypointType>' +
			'<WorldPosition>N48° 49\' 19.00",E002° 37\' 22.00",+001500.00</WorldPosition></ATCWaypoint>' +
			'<ATCWaypoint id="B"><ATCWaypointType>User</ATCWaypointType>' +
			'<WorldPosition>N49° 8\',E002° 47\',+002000.00</WorldPosition></ATCWaypoint>' +
			'</FlightPlan.FlightPlan></SimBase.Document>';
		const points = readRouteFile(pln).routes[0].points;
		expect(points).toHaveLength(2);
		expect(points[1].lat).toBeCloseTo(49 + 8 / 60, 6);
	});

	it('reads every route a GPX states, not only the first', () => {
		// The workspace has room for six, and dropping the rest in silence is
		// the one thing a reader may not do.
		const rte = (n: string, lat: number): string =>
			`<rte><name>${n}</name>` +
			`<rtept lat="${lat}" lon="2.6"><name>A</name></rtept>` +
			`<rtept lat="${lat + 0.2}" lon="2.7"><name>B</name></rtept></rte>`;
		const doc =
			'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">' +
			`<metadata><name>Two legs</name></metadata>${rte('one', 48.6)}${rte('two', 49.1)}</gpx>`;
		const plan = readRouteFile(doc);
		expect(plan.routes).toHaveLength(2);
		expect(plan.title).toBe('Two legs');
		expect(plan.routes[1].points[0].lat).toBeCloseTo(49.1, 6);
	});

	it('drops a route too short to fly, keeping the ones that are not', () => {
		const doc =
			'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">' +
			'<rte><rtept lat="48.6" lon="2.6"><name>lone</name></rtept></rte>' +
			'<rte><rtept lat="48.6" lon="2.6"/><rtept lat="49.1" lon="2.7"/></rte></gpx>';
		expect(readRouteFile(doc).routes).toHaveLength(1);
	});

	it('gives a collapsed pair the level flown OUT of the place', () => {
		// A PLN writes its departure twice, and it is the second row that
		// states the leg leaving it.
		const pln =
			'<?xml version="1.0"?><SimBase.Document Type="AceXML" version="1,0">' +
			'<Descr>AceXML Document</Descr><FlightPlan.FlightPlan><Title>T</Title>' +
			'<ATCWaypoint id="LFPL"><ATCWaypointType>Airport</ATCWaypointType><ICAO><ICAOIdent>LFPL</ICAOIdent></ICAO>' +
			'<WorldPosition>N48° 49\' 19.00",E002° 37\' 22.00",+000000.00</WorldPosition></ATCWaypoint>' +
			'<ATCWaypoint id="LFPLLOGNES"><ATCWaypointType>User</ATCWaypointType>' +
			'<WorldPosition>N48° 49\' 19.00",E002° 37\' 22.00",+002500.00</WorldPosition></ATCWaypoint>' +
			'<ATCWaypoint id="B"><ATCWaypointType>User</ATCWaypointType>' +
			'<WorldPosition>N49° 8\' 24.00",E002° 47\' 29.00",+000000.00</WorldPosition></ATCWaypoint>' +
			'</FlightPlan.FlightPlan></SimBase.Document>';
		const points = readRouteFile(pln).routes[0].points;
		expect(points).toHaveLength(2);
		expect(points[0].ident).toBe('LFPL');
		expect(points[0].altFt).toBe(2500);
	});
});

describe('what the schema says a waypoint table is keyed on', () => {
	/* Garmin's xsd:key is the TRIPLE (identifier, type, country-code), and
	 * every route-point states all three. One identifier may therefore appear
	 * twice under two types, and reading the table by identifier alone hands
	 * the route whichever row was written last: not a missing point, a point
	 * in the wrong place. */
	const wp = (ident: string, type: string, lat: number, lon: number, name: string): string =>
		`<waypoint><identifier>${ident}</identifier><type>${type}</type><country-code/>` +
		`<lat>${lat}</lat><lon>${lon}</lon><comment/>` +
		`<waypoint-description>${name}</waypoint-description></waypoint>`;
	const rp = (ident: string, type: string): string =>
		`<route-point><waypoint-identifier>${ident}</waypoint-identifier>` +
		`<waypoint-type>${type}</waypoint-type><waypoint-country-code/></route-point>`;
	const doc = (table: string, route: string): string =>
		'<?xml version="1.0" encoding="UTF-8"?>' +
		'<flight-plan xmlns="http://www8.garmin.com/xmlschemas/FlightPlan/v1">' +
		`<file-description>X</file-description><waypoint-table>${table}</waypoint-table>` +
		`<route><route-name>X</route-name><flight-plan-index>1</flight-plan-index>${route}</route>` +
		'</flight-plan>';

	it('tells two rows sharing an identifier apart by their type', () => {
		const text = doc(
			wp('LFPL', 'AIRPORT', 48.821944, 2.622778, 'LOGNES') +
				wp('LFPL', 'USER WAYPOINT', 49.5, 3.9, 'MY FIX') +
				wp('LFPK', 'AIRPORT', 48.8375, 3.014444, 'COULOMMIERS'),
			rp('LFPL', 'AIRPORT') + rp('LFPK', 'AIRPORT'),
		);
		const points = readRouteFile(text).routes[0].points;
		expect(points[0].lat).toBeCloseTo(48.821944, 6);
		expect(points[0].name).toBe('LOGNES');
		expect(points[0].aerodrome).toBe(true);
	});

	it('still resolves a route-point that states only its identifier', () => {
		// Looser than the schema, and files in the wild are: the first row
		// under that identifier answers.
		const text = doc(
			wp('LFPL', 'AIRPORT', 48.821944, 2.622778, 'LOGNES') +
				wp('LFPK', 'AIRPORT', 48.8375, 3.014444, 'COULOMMIERS'),
			'<route-point><waypoint-identifier>LFPL</waypoint-identifier></route-point>' +
				'<route-point><waypoint-identifier>LFPK</waypoint-identifier></route-point>',
		);
		expect(readRouteFile(text).routes[0].points).toHaveLength(2);
	});

	it('names a route-point that no table row answers', () => {
		const text = doc(
			wp('LFPL', 'AIRPORT', 48.821944, 2.622778, 'LOGNES') +
				wp('LFPK', 'AIRPORT', 48.8375, 3.014444, 'COULOMMIERS'),
			rp('LFPL', 'AIRPORT') + rp('GHOST', 'USER WAYPOINT') + rp('LFPK', 'AIRPORT'),
		);
		const plan = readRouteFile(text);
		expect(plan.routes[0].points).toHaveLength(2);
		expect(plan.skipped).toEqual(['GHOST']);
	});
});

describe('the caption is the document\'s own, not its first waypoint\'s', () => {
	it('does not caption a GPX after its first point', () => {
		const gpx =
			'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><rte>' +
			'<rtept lat="48.82" lon="2.62"><name>LFPL LOGNES</name></rtept>' +
			'<rtept lat="48.84" lon="3.01"><name>LFPK</name></rtept></rte></gpx>';
		expect(readRouteFile(gpx).title).toBeNull();
	});

	it('does not caption a GPX after the tool that wrote it', () => {
		const gpx =
			'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">' +
			'<metadata><author><name>SomePlanner</name></author></metadata><rte>' +
			'<rtept lat="48.82" lon="2.62"><name>A</name></rtept>' +
			'<rtept lat="48.84" lon="3.01"><name>B</name></rtept></rte></gpx>';
		expect(readRouteFile(gpx).title).toBeNull();
	});

	it('does not caption a KML after its first placemark', () => {
		const pin = (n: string, c: string): string =>
			`<Placemark><name>${n}</name><Point><coordinates>${c}</coordinates></Point></Placemark>`;
		const kml =
			'<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
			pin('LFPL LOGNES', '2.62,48.82') +
			pin('LFPK', '3.01,48.84') +
			'</Document></kml>';
		expect(readRouteFile(kml).title).toBeNull();
	});

	it('does not caption a KML after the author who wrote it', () => {
		const pin = (n: string, c: string): string =>
			`<Placemark><name>${n}</name><Point><coordinates>${c}</coordinates></Point></Placemark>`;
		const kml =
			'<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2" ' +
			'xmlns:atom="http://www.w3.org/2005/Atom"><Document>' +
			'<atom:author><atom:name>SomePlanner</atom:name></atom:author>' +
			pin('LFPL', '2.62,48.82') +
			pin('LFPK', '3.01,48.84') +
			'</Document></kml>';
		expect(readRouteFile(kml).title).toBeNull();
	});

	it('still reads the caption a document does state', () => {
		expect(readRouteFile(sdvfr('gpx')).title).toBe('Châteaux de Picardie');
		expect(readRouteFile(sdvfr('kml')).title).toBe('Châteaux de Picardie');
		expect(readRouteFile(sdvfr('pln')).title).toBe('ChateauxdePicardie');
		expect(readRouteFile(sdvfr('fpl')).title).toBe('CHATEAUXDEPICARDIE');
	});
});

describe('a point the reader cannot take is named, never dropped in silence', () => {
	it('names a GPX point that states no position', () => {
		const gpx =
			'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><rte>' +
			'<rtept lat="48.82" lon="2.62"><name>A</name></rtept>' +
			'<rtept lon="3.01"><name>Broken</name></rtept>' +
			'<rtept lat="48.84" lon="3.01"><name>B</name></rtept></rte></gpx>';
		const plan = readRouteFile(gpx);
		expect(plan.routes[0].points).toHaveLength(2);
		expect(plan.skipped).toEqual(['Broken']);
	});

	it('names a KML pin it cannot place, when the pins ARE the route', () => {
		// A document with no line: its placemarks are the route in document
		// order, so one that cannot be placed is a waypoint the pilot planned
		// and this app is about to fly without.
		const pin = (n: string, c: string): string =>
			`<Placemark><name>${n}</name><Point><coordinates>${c}</coordinates></Point></Placemark>`;
		const kml =
			'<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>T</name>' +
			pin('LFPL', '2.62,48.82,457') +
			pin('Broken', 'not a position') +
			pin('LFPK', '3.01,48.84,457') +
			'</Document></kml>';
		const plan = readRouteFile(kml);
		expect(plan.routes[0].points).toHaveLength(2);
		expect(plan.skipped).toEqual(['Broken']);
	});

	it('says nothing of the pins when the line is what holds the route', () => {
		// There a pin costs a NAME and no waypoint, and reporting it would
		// call a whole route short.
		expect(readRouteFile(sdvfr('kml')).skipped).toEqual([]);
	});

	it('names a PLN position written in a punctuation it does not read', () => {
		const pln =
			'<?xml version="1.0"?><SimBase.Document Type="AceXML" version="1,0">' +
			'<Descr>AceXML Document</Descr><FlightPlan.FlightPlan><Title>T</Title>' +
			'<ATCWaypoint id="A"><ATCWaypointType>User</ATCWaypointType>' +
			'<WorldPosition>N48° 49\' 19.00",E002° 37\' 22.00",+001500.00</WorldPosition></ATCWaypoint>' +
			'<ATCWaypoint id="ODD"><ATCWaypointType>User</ATCWaypointType>' +
			'<WorldPosition>48.79N 2.86E 2000</WorldPosition></ATCWaypoint>' +
			'<ATCWaypoint id="B"><ATCWaypointType>User</ATCWaypointType>' +
			'<WorldPosition>N49° 8\' 24.00",E002° 47\' 29.00",+000000.00</WorldPosition></ATCWaypoint>' +
			'</FlightPlan.FlightPlan></SimBase.Document>';
		const plan = readRouteFile(pln);
		expect(plan.routes[0].points).toHaveLength(2);
		expect(plan.skipped).toEqual(['ODD']);
	});
});

describe('how long a route may be', () => {
	const gpxOf = (n: number): string =>
		'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><rte>' +
		Array.from(
			{ length: n },
			(_, i) => `<rtept lat="${(48 + i / 10000).toFixed(6)}" lon="2.6"><name>P${i}</name></rtept>`,
		).join('') +
		'</rte></gpx>';

	it('refuses a track converted to a route', () => {
		// Every GPS tool offers that conversion and it yields a legal route
		// file of thousands of points. The app cannot draw one as a plan, and
		// half of it is not half a plan, so the count says why.
		expect(() => readRouteFile(gpxOf(MAX_POINTS + 1))).toThrow(/more than a route may state/);
	});

	it('takes a plan of a size a pilot flies', () => {
		expect(readRouteFile(gpxOf(60)).routes[0].points).toHaveLength(60);
		expect(readRouteFile(gpxOf(MAX_POINTS)).routes[0].points).toHaveLength(MAX_POINTS);
	});

	it('counts what it refused too, so a broken file cannot flood the notice', () => {
		const broken = Array.from(
			{ length: MAX_POINTS + 1 },
			(_, i) => `<rtept lon="2.0"><name>P${i}</name></rtept>`,
		).join('');
		const doc =
			'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><rte>' +
			`<rtept lat="48.6" lon="2.6"><name>A</name></rtept>${broken}` +
			'<rtept lat="49.1" lon="2.7"><name>B</name></rtept></rte></gpx>';
		expect(() => readRouteFile(doc)).toThrow(/more than a route may state/);
	});
});

describe('documents that arrive broken', () => {
	/* These readers parse whatever a file manager, an Android intent or a
	 * ?file= URL hands them, and some of that is truncated: a write that
	 * stopped halfway, a download that did. Read with one non-greedy pattern
	 * per element, every unclosed tag re-scans to the end of the file, and a
	 * 1.2 MB document holding 20 000 of them took TEN SECONDS inside
	 * detectFileKind, on the thread that draws. The walk stops at the first
	 * open with no close beyond it instead.
	 *
	 * The timing assertions carry a 100x margin over what the fix measures
	 * (single-digit milliseconds) and a 5x margin under what the bug did, so
	 * only a return of the quadratic can trip them. */
	const budgetMs = 1000;

	it('classifies a truncated KML instead of hanging on it', () => {
		const kml =
			'<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
			'<Placemark><Point><coordinates>2.6,48.8</coordinates></Point>'.repeat(20000);
		const started = Date.now();
		// No placemark ever closes, so none is read: it is not a route, and it
		// goes back to being whatever the trace reader makes of it.
		expect(looksLikeRouteKml(kml)).toBe(false);
		expect(Date.now() - started).toBeLessThan(budgetMs);
	});

	it('reads a truncated GPX instead of hanging on it', () => {
		const gpx =
			'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><rte>' +
			'<rtept lat="48.6" lon="2.6"><name>P</name>'.repeat(20000) +
			'</rte></gpx>';
		const started = Date.now();
		expect(() => readRouteFile(gpx)).toThrow(/no route found/);
		expect(Date.now() - started).toBeLessThan(budgetMs);
	});

	it('reads a truncated PLN instead of hanging on it', () => {
		const pln =
			'<?xml version="1.0"?><SimBase.Document Type="AceXML" version="1,0">' +
			'<Descr>AceXML Document</Descr><FlightPlan.FlightPlan><Title>T</Title>' +
			'<ATCWaypoint id="A"><ATCWaypointType>User</ATCWaypointType>'.repeat(20000) +
			'</FlightPlan.FlightPlan></SimBase.Document>';
		const started = Date.now();
		expect(() => readRouteFile(pln)).toThrow(/no route found/);
		expect(Date.now() - started).toBeLessThan(budgetMs);
	});

	it('refuses a truncated document rather than loading half a plan', () => {
		// The first two points are whole and the third is where the file stops,
		// but the route element never closes, so nothing is read from it. That
		// is the refusal this app already makes on the way out: a plan that
		// stops short of its destination is worse than one that is refused,
		// and here nothing could even tell the pilot how much was missing.
		const gpx =
			'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><rte>' +
			'<rtept lat="48.6" lon="2.6"><name>A</name></rtept>' +
			'<rtept lat="49.1" lon="2.7"><name>B</name></rtept>' +
			'<rtept lat="49.3" lon="2.8"><name>C';
		expect(() => readRouteFile(gpx)).toThrow(/no route found/);
	});

	it('states no value for an element that states none', () => {
		// <comment/> and <name></name> are how a writer says "nothing here",
		// and the FPL reader falls through them to the identifier.
		const fpl =
			'<?xml version="1.0"?><flight-plan xmlns="http://www8.garmin.com/xmlschemas/FlightPlan/v1">' +
			'<waypoint-table>' +
			'<waypoint><identifier>LFPL</identifier><type>AIRPORT</type><country-code/>' +
			'<lat>48.82</lat><lon>2.62</lon><comment/><waypoint-description></waypoint-description></waypoint>' +
			'<waypoint><identifier>LFPK</identifier><type>AIRPORT</type><country-code/>' +
			'<lat>48.83</lat><lon>3.01</lon><comment/></waypoint></waypoint-table>' +
			'<route><route-name>X</route-name><flight-plan-index>1</flight-plan-index>' +
			'<route-point><waypoint-identifier>LFPL</waypoint-identifier><waypoint-type>AIRPORT</waypoint-type><waypoint-country-code/></route-point>' +
			'<route-point><waypoint-identifier>LFPK</waypoint-identifier><waypoint-type>AIRPORT</waypoint-type><waypoint-country-code/></route-point>' +
			'</route></flight-plan>';
		expect(readRouteFile(fpl).routes[0].points.map((p) => p.name)).toEqual(['LFPL', 'LFPK']);
	});
});


describe('a position the file states badly', () => {
	const gpx = (pts: string): string =>
		'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">' +
		`<rte><name>R</name>${pts}</rte></gpx>`;

	it('refuses an empty coordinate instead of planting the point at 0N 0E', () => {
		// Number('') is 0 and 0 is finite, so an empty attribute used to read
		// as the Gulf of Guinea, 5300 km off, with nothing in the notice.
		const plan = readRouteFile(
			gpx(
				'<rtept lat="" lon=""><name>PONTOISE</name></rtept>' +
					'<rtept lat="48.8" lon="2.6"><name>A</name></rtept>' +
					'<rtept lat="49.1" lon="2.7"><name>B</name></rtept>',
			),
		);
		expect(plan.routes[0].points.map((p) => p.name)).toEqual(['A', 'B']);
		expect(plan.skipped).toEqual(['PONTOISE']);
	});

	it('refuses a position outside the world', () => {
		// Leaflet's projection is non-finite from |lat| >= 90, so a transposed
		// field reaches the route line and every terrain pass as NaN geometry.
		const plan = readRouteFile(
			gpx(
				'<rtept lat="1000" lon="9999"><name>X</name></rtept>' +
					'<rtept lat="48.8" lon="2.6"><name>A</name></rtept>' +
					'<rtept lat="49.1" lon="2.7"><name>B</name></rtept>',
			),
		);
		expect(plan.routes[0].points.map((p) => p.name)).toEqual(['A', 'B']);
		expect(plan.skipped).toEqual(['X']);
	});

	it('refuses a PLN position outside the world', () => {
		expect(parseWorldPosition('N91° 0\' 0.00",E002° 0\' 0.00",+001500.00')).toBeNull();
		expect(parseWorldPosition('N48° 0\' 0.00",E200° 0\' 0.00",+001500.00')).toBeNull();
	});

	it('reads a coordinates run whose commas carry spaces', () => {
		// Files in the wild put spaces AFTER the commas. Splitting on
		// whitespace first shattered every tuple into halves that read as
		// nothing, so the pins never matched, the probe failed, and the
		// pilot's flight plan opened as a recorded TRACE.
		const doc =
			'<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>T</name>' +
			'<Placemark><LineString><coordinates>2.6, 48.8 2.7, 48.9</coordinates></LineString></Placemark>' +
			'<Placemark><name>A</name><Point><coordinates>2.6, 48.8</coordinates></Point></Placemark>' +
			'<Placemark><name>B</name><Point><coordinates>2.7, 48.9</coordinates></Point></Placemark>' +
			'</Document></kml>';
		expect(routeFileFormat(doc)).toBe('kml');
		expect(readRouteFile(doc).routes[0].points.map((p) => [p.lat, p.lon])).toEqual([
			[48.8, 2.6],
			[48.9, 2.7],
		]);
	});

	it('lets the pins settle an ambiguous comma-run', () => {
		// Six numbers with no whitespace read as two three-component tuples or
		// three two-component ones, and both are positions. Preferring three
		// blindly put this route's waypoints at 2.8N 48.9E, in Somalia, with
		// their real names attached.
		const doc =
			'<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>T</name>' +
			'<Placemark><LineString><coordinates>2.6,48.9,2.7,48.8,2.8,48.9</coordinates>' +
			'</LineString></Placemark>' +
			'<Placemark><name>ALPHA</name><Point><coordinates>2.6,48.9</coordinates></Point></Placemark>' +
			'<Placemark><name>BRAVO</name><Point><coordinates>2.7,48.8</coordinates></Point></Placemark>' +
			'<Placemark><name>CHARLI</name><Point><coordinates>2.8,48.9</coordinates></Point></Placemark>' +
			'</Document></kml>';
		expect(readRouteFile(doc).routes[0].points.map((p) => [p.lat, p.lon, p.name])).toEqual([
			[48.9, 2.6, 'ALPHA'],
			[48.8, 2.7, 'BRAVO'],
			[48.9, 2.8, 'CHARLI'],
		]);
	});

	it('names the vertex it could not read', () => {
		// A vertex of the drawn line IS a waypoint, so losing one silently is
		// a plan one point short with a clean notice: the failure nobody sees.
		const doc =
			'<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>T</name>' +
			'<Placemark><LineString><coordinates>2.6,48.8 48.9,300.0 2.8,48.7</coordinates>' +
			'</LineString></Placemark>' +
			'<Placemark><name>A</name><Point><coordinates>2.6,48.8</coordinates></Point></Placemark>' +
			'<Placemark><name>C</name><Point><coordinates>2.8,48.7</coordinates></Point></Placemark>' +
			'</Document></kml>';
		const plan = readRouteFile(doc);
		expect(plan.routes[0].points).toHaveLength(2);
		expect(plan.skipped).toEqual(['point 2']);
	});
});

describe('what a KML altitude means', () => {
	const doc = (mode: string, third: string): string =>
		'<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>T</name>' +
		`<Placemark><LineString>${mode === '' ? '' : `<altitudeMode>${mode}</altitudeMode>`}` +
		`<coordinates>2.6,48.8${third} 2.7,48.9${third} 2.8,48.7${third}</coordinates>` +
		'</LineString></Placemark>' +
		'<Placemark><name>A</name><Point><coordinates>2.6,48.8</coordinates></Point></Placemark>' +
		'<Placemark><name>B</name><Point><coordinates>2.7,48.9</coordinates></Point></Placemark>' +
		'<Placemark><name>C</name><Point><coordinates>2.8,48.7</coordinates></Point></Placemark>' +
		'</Document></kml>';

	it('states no level under a ground clamp', () => {
		// KML's DEFAULT is clampToGround, which is what Google Earth's own
		// "Save Place As" writes under the conventional ,0 third component.
		for (const mode of ['', 'clampToGround', 'relativeToGround']) {
			const points = readRouteFile(doc(mode, ',457.2')).routes[0].points;
			expect(points.every((p) => p.altFt === null)).toBe(true);
		}
	});

	it('states a level under an absolute mode', () => {
		expect(readRouteFile(doc('absolute', ',457.2')).routes[0].points.map((p) => p.altFt)).toEqual([
			1500, 1500, null,
		]);
	});

	it('reads a zero altitude as no level at all', () => {
		// Pinning a leg MANUAL at sea level locks out every re-levelling the
		// app does, draws the profile underground and computes the fuel plan
		// at 0 ft. Every writer that cannot omit an altitude puts a zero there.
		expect(readRouteFile(doc('absolute', ',0')).routes[0].points.every((p) => p.altFt === null)).toBe(
			true,
		);
		const gpx =
			'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><rte>' +
			'<rtept lat="48.8" lon="2.6"><ele>0</ele><name>A</name></rtept>' +
			'<rtept lat="48.9" lon="2.7"><ele>0</ele><name>B</name></rtept></rte></gpx>';
		expect(readRouteFile(gpx).routes[0].points.every((p) => p.altFt === null)).toBe(true);
	});
});

describe('which place an identifier names', () => {
	const fpl = (table: string, route: string): string =>
		'<?xml version="1.0"?><flight-plan xmlns="http://www8.garmin.com/xmlschemas/FlightPlan/v1">' +
		`<waypoint-table>${table}</waypoint-table><route><route-name>R</route-name>${route}</route>` +
		'</flight-plan>';
	const row = (ident: string, type: string, country: string, lat: number, lon: number): string =>
		`<waypoint><identifier>${ident}</identifier><type>${type}</type>` +
		`<country-code>${country}</country-code><lat>${lat}</lat><lon>${lon}</lon></waypoint>`;
	const bare = (ident: string): string =>
		`<route-point><waypoint-identifier>${ident}</waypoint-identifier></route-point>`;

	it('refuses an ambiguous identifier the route-point does not qualify', () => {
		// MLN is Melilla's aerodrome and Melun's VOR-DME, 1200 km apart, which
		// is why Garmin's schema keys the table on the TRIPLE. Answering with
		// whichever row came first is a waypoint in the wrong country and a
		// clean notice.
		const plan = readRouteFile(
			fpl(
				row('MLN', 'AIRPORT', 'GE', 35.2798, -2.9563) +
					row('MLN', 'VOR', 'LF', 48.6094, 2.6803) +
					row('LFPL', 'AIRPORT', 'LF', 48.82, 2.62) +
					row('LFPK', 'AIRPORT', 'LF', 48.83, 3.01),
				bare('LFPL') + bare('MLN') + bare('LFPK'),
			),
		);
		expect(plan.routes[0].points.map((p) => p.ident)).toEqual(['LFPL', 'LFPK']);
		expect(plan.skipped).toEqual(['MLN']);
	});

	it('still resolves an identifier the table files at one place twice', () => {
		// The fallback earns its place on files looser than the schema: a
		// route-point stating no type at all still resolves while the name is
		// unambiguous, and a row repeated at one position is one place.
		const plan = readRouteFile(
			fpl(
				row('LFPL', 'AIRPORT', 'LF', 48.82, 2.62) +
					row('LFPL', 'USER WAYPOINT', '', 48.82, 2.62) +
					row('LFPK', 'AIRPORT', 'LF', 48.83, 3.01),
				bare('LFPL') + bare('LFPK'),
			),
		);
		expect(plan.routes[0].points.map((p) => p.ident)).toEqual(['LFPL', 'LFPK']);
		expect(plan.skipped).toEqual([]);
	});
});

describe('the name a point keeps', () => {
	const gpx = (name: string): string =>
		'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><rte>' +
		`<rtept lat="48.8" lon="2.6"><name>${name}</name></rtept>` +
		'<rtept lat="49.1" lon="2.7"><name>B</name></rtept></rte></gpx>';
	const first = (name: string): ImportedPoint => readRouteFile(gpx(name)).routes[0].points[0];

	it('keeps a name that merely looks like a token', () => {
		// 648 rows of airports.json carry a slash in their name, and this
		// app's own GPX writer puts that name in <name>. Nulling it costs the
		// point its label AND its only identifier candidate, so it comes back
		// an unnamed free point with no frequencies and no nav-log label.
		for (const name of ['EGAC BELFAST/CITY', 'N4', 'N104', 'LF05 BUXEUIL ST REMY / CREUSE']) {
			expect(first(name).name).toBe(name);
		}
		expect(identCandidates(first('EGAC BELFAST/CITY'))).toContain('EGAC');
	});

	it('drops a name that is only a position', () => {
		// What every writer here prints for a point with no name of its own.
		for (const name of ['48.821, 2.623', '48.821,2.623', 'N48,8200/E2,62000', 'N48492E002372']) {
			expect(first(name).name).toBeNull();
		}
	});
});

describe('what a document is called', () => {
	it('takes no caption from a nested feature', () => {
		// Naming the containers to skip was a deny-list, and KML gives seven
		// feature types a name of their own: this document was captioned
		// "SkyDemon logo", which then became the plan's IDENTITY, the subject
		// of every file and print it produced afterwards.
		const doc =
			'<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
			'<ScreenOverlay><name>SkyDemon logo</name></ScreenOverlay>' +
			'<GroundOverlay><name>VAC LFPL</name></GroundOverlay>' +
			'<Placemark><LineString><coordinates>2.6,48.8 2.7,48.9</coordinates></LineString></Placemark>' +
			'<Placemark><name>A</name><Point><coordinates>2.6,48.8</coordinates></Point></Placemark>' +
			'<Placemark><name>B</name><Point><coordinates>2.7,48.9</coordinates></Point></Placemark>' +
			'</Document></kml>';
		expect(readRouteFile(doc).title).toBeNull();
	});

	it('takes no caption from a comment or a CDATA section', () => {
		const doc =
			'<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
			'<description><![CDATA[<name>not a caption</name>]]></description>' +
			'<!-- <name>nor this</name> -->' +
			'<name>Sortie du dimanche</name>' +
			'<Placemark><LineString><coordinates>2.6,48.8 2.7,48.9</coordinates></LineString></Placemark>' +
			'<Placemark><name>A</name><Point><coordinates>2.6,48.8</coordinates></Point></Placemark>' +
			'<Placemark><name>B</name><Point><coordinates>2.7,48.9</coordinates></Point></Placemark>' +
			'</Document></kml>';
		expect(readRouteFile(doc).title).toBe('Sortie du dimanche');
	});

	it('names every route a GPX names', () => {
		// GPX is the one format that holds several, and it names each of them.
		const doc =
			'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">' +
			'<rte><name>Aller</name><rtept lat="48.8" lon="2.6"><name>A</name></rtept>' +
			'<rtept lat="49.1" lon="2.7"><name>B</name></rtept></rte>' +
			'<rte><name>Retour</name><rtept lat="49.1" lon="2.7"><name>B</name></rtept>' +
			'<rtept lat="48.8" lon="2.6"><name>A</name></rtept></rte></gpx>';
		expect(readRouteFile(doc).routes.map((r) => r.name)).toEqual(['Aller', 'Retour']);
	});

	it('does not throw on a character reference that names no character', () => {
		// String.fromCodePoint THROWS past U+10FFFF, and the throw escaped
		// detectFileKind, which three call sites take for total: an Android
		// "Open with" ended as an unhandled rejection showing nothing at all.
		const doc =
			'<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
			'<name>T&#1114112;</name>' +
			'<Placemark><LineString><coordinates>2.6,48.8 2.7,48.9</coordinates></LineString></Placemark>' +
			'<Placemark><name>A&#x110000;</name><Point><coordinates>2.6,48.8</coordinates></Point></Placemark>' +
			'<Placemark><name>B</name><Point><coordinates>2.7,48.9</coordinates></Point></Placemark>' +
			'</Document></kml>';
		expect(looksLikeRouteKml(doc)).toBe(true);
		expect(readRouteFile(doc).title).toBe('T&#1114112;');
	});
});

describe('a route the file states but the app cannot fly', () => {
	it('names the point of a route too short to keep', () => {
		const doc =
			'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">' +
			'<rte><name>Aller</name><rtept lat="48.8" lon="2.6"><name>A</name></rtept>' +
			'<rtept lat="49.1" lon="2.7"><name>B</name></rtept></rte>' +
			'<rte><name>Point</name><rtept lat="49.4" lon="2.9"><name>SOLO</name></rtept></rte></gpx>';
		const plan = readRouteFile(doc);
		expect(plan.routes).toHaveLength(1);
		expect(plan.skipped).toEqual(['SOLO']);
	});

	it('counts the points it kept apart from the ones it could not read', () => {
		// One cap refuses a converted TRACK; the other refuses a file whose
		// points are mostly unreadable. Counting them together refused a good
		// two-point route under a message naming three hundred others.
		const table = Array.from(
			{ length: 4 },
			(_, i) =>
				`<waypoint><identifier>P${i}</identifier><type>USER WAYPOINT</type><country-code/>` +
				`<lat>${48 + i / 100}</lat><lon>2.6</lon></waypoint>`,
		).join('');
		const points = Array.from(
			{ length: MAX_POINTS + 50 },
			(_, i) =>
				`<route-point><waypoint-identifier>${i < 2 ? `P${i}` : `Q${i}`}</waypoint-identifier>` +
				'<waypoint-type>USER WAYPOINT</waypoint-type><waypoint-country-code/></route-point>',
		).join('');
		expect(() =>
			readRouteFile(
				'<?xml version="1.0"?><flight-plan xmlns="http://www8.garmin.com/xmlschemas/FlightPlan/v1">' +
					`<waypoint-table>${table}</waypoint-table><route><route-name>R</route-name>${points}</route></flight-plan>`,
			),
		).toThrow(/could not be read/);
	});
});
