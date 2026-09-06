/* What each interchange file actually says (docs/route-files.md).
 *
 * The markup is asserted literally, and structure through the tiny grammar
 * reader below rather than through any parser of this repo's own: a writer
 * must not be able to pin its own bug (the tests/navIgc.spec.ts discipline).
 * The Garmin block additionally transcribes the restrictions of Garmin's
 * published schema and holds the output against them, since nothing in this
 * repo validates XML and the schema is the contract. */

import { describe, it, expect } from 'vitest';
import { buildRouteFpl } from '$lib/route/routeFpl';
import { buildRouteGpx } from '$lib/route/routeGpx';
import { buildRouteKml } from '$lib/route/routeKml';
import { buildRoutePln } from '$lib/route/routePln';
import { routeExportPoints } from '$lib/route/routePoints';
import type { Waypoint } from '$lib/state/route.svelte';

function wp(extra: Partial<Waypoint>): Waypoint {
	return { id: 't', lat: 0, lon: 0, kind: 'free', alt: 2000, altAuto: true, ...extra };
}

/* LFPL -> a free point -> LFPK, the leg altitudes 1500 then 2000. */
const LFPL = wp({
	kind: 'airport',
	ident: 'LFPL',
	label: 'Lognes Emerainville',
	lat: 48.821944,
	lon: 2.622778,
	alt: 1500,
});
const OBELISQUE = wp({ label: "L'obélisque", lat: 48.791601, lon: 2.869171, alt: 2000 });
const LFPK = wp({
	kind: 'airport',
	ident: 'LFPK',
	label: 'Coulommiers Voisins',
	lat: 48.8375,
	lon: 3.014444,
	alt: 3500,
});
const POINTS = routeExportPoints([LFPL, OBELISQUE, LFPK]);
const CIRCUIT = routeExportPoints([LFPL, OBELISQUE, LFPL]);
const SUBJECT = 'LFPL-LFPK';

/* --- a grammar reader, knowing nothing of these four formats ------------- */

/** Every `<tag>...</tag>` body, in document order. */
function elements(xml: string, tag: string): string[] {
	const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
	return [...xml.matchAll(re)].map((m) => m[1]);
}

/** One child's text, '' when the child is written empty (`<tag/>`). */
function text(xml: string, tag: string): string {
	const paired = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
	if (paired) {
		return paired[1].trim();
	}
	return new RegExp(`<${tag}\\s*/>`).test(xml) ? '' : '(absent)';
}

/** The child tags of one element, in the order they are written. */
function childTags(xml: string): string[] {
	return [...xml.matchAll(/<([A-Za-z][\w.-]*)(?:\s[^>]*?)?\s*\/?>/g)].map((m) => m[1]);
}

/** Every `<tag ...>` opening tag, in document order. */
function openTags(xml: string, tag: string): string[] {
	const re = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g');
	return [...xml.matchAll(re)].map((m) => m[0]);
}

/** An attribute's value. */
function attr(xml: string, name: string): string {
	return new RegExp(`\\b${name}="([^"]*)"`).exec(xml)?.[1] ?? '';
}

describe('buildRouteFpl', () => {
	const fpl = buildRouteFpl(POINTS, { subject: SUBJECT });

	it('declares the Garmin FlightPlan v1 namespace and ends with a newline', () => {
		expect(fpl.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
		expect(fpl).toContain('<flight-plan xmlns="http://www8.garmin.com/xmlschemas/FlightPlan/v1">');
		expect(fpl.endsWith('</flight-plan>\n')).toBe(true);
	});

	it('writes the waypoint children in the order the schema sequences them', () => {
		const [first, second] = elements(fpl, 'waypoint');
		expect(childTags(first)).toEqual([
			'identifier',
			'type',
			'country-code',
			'lat',
			'lon',
			'comment',
		]);
		// The optional description sits after the comment, where the sequence
		// puts it (elevation, which we never write, would come between).
		expect(childTags(second)).toEqual([
			'identifier',
			'type',
			'country-code',
			'lat',
			'lon',
			'comment',
			'waypoint-description',
		]);
	});

	it('types a known aerodrome AIRPORT and everything else USER WAYPOINT', () => {
		const table = elements(fpl, 'waypoint');
		expect(table.map((w) => text(w, 'identifier'))).toEqual(['LFPL', 'LOBELI', 'LFPK']);
		expect(table.map((w) => text(w, 'type'))).toEqual(['AIRPORT', 'USER WAYPOINT', 'AIRPORT']);
	});

	it('carries every position, whatever the type says', () => {
		const table = elements(fpl, 'waypoint');
		expect(table.map((w) => text(w, 'lat'))).toEqual(['48.821944', '48.791601', '48.8375']);
		expect(table.map((w) => text(w, 'lon'))).toEqual(['2.622778', '2.869171', '3.014444']);
	});

	it('leaves the country code empty, ours being an ISO code and not a region', () => {
		expect(elements(fpl, 'waypoint').map((w) => text(w, 'country-code'))).toEqual(['', '', '']);
	});

	it("keeps the point's name in the alphabet each field allows", () => {
		const [lfpl, obelisque] = elements(fpl, 'waypoint');
		expect(text(lfpl, 'comment')).toBe('LOGNES EMERAINVILLE');
		expect(text(lfpl, 'waypoint-description')).toBe('(absent)');
		expect(text(obelisque, 'comment')).toBe('L OBELISQUE');
		// The apostrophe rides escaped, the shared xmlEscape's doing.
		expect(text(obelisque, 'waypoint-description')).toBe('L&apos;obelisque');
	});

	it('references the table from the route, in flown order', () => {
		const [route] = elements(fpl, 'route');
		expect(text(route, 'route-name')).toBe('LFPL LFPK');
		expect(text(route, 'flight-plan-index')).toBe('1');
		const points = elements(route, 'route-point');
		expect(points.map((p) => text(p, 'waypoint-identifier'))).toEqual([
			'LFPL',
			'LOBELI',
			'LFPK',
		]);
		expect(childTags(points[0])).toEqual([
			'waypoint-identifier',
			'waypoint-type',
			'waypoint-country-code',
		]);
	});

	it('writes a place visited twice once in the table and twice in the route', () => {
		const circuit = buildRouteFpl(CIRCUIT, { subject: 'LFPL-LFPL' });
		expect(elements(circuit, 'waypoint').map((w) => text(w, 'identifier'))).toEqual([
			'LFPL',
			'LOBELI',
		]);
		expect(
			elements(elements(circuit, 'route')[0], 'route-point').map((p) =>
				text(p, 'waypoint-identifier'),
			),
		).toEqual(['LFPL', 'LOBELI', 'LFPL']);
	});

	it('obeys every restriction the published schema states', () => {
		// Transcribed from http://www8.garmin.com/xmlschemas/FlightPlanv1.xsd.
		const IDENTIFIER = /^[A-Z0-9]{1,12}$/;
		const TEXT = /^([A-Z0-9 /]{1,25})?$/;
		const COUNTRY = /^([A-Z0-9]{2})?$/;
		const TYPES = ['USER WAYPOINT', 'AIRPORT', 'NDB', 'VOR', 'INT', 'INT-VRP'];
		const table = elements(fpl, 'waypoint');
		const keys = new Set<string>();
		for (const w of table) {
			expect(text(w, 'identifier')).toMatch(IDENTIFIER);
			expect(TYPES).toContain(text(w, 'type'));
			expect(text(w, 'country-code')).toMatch(COUNTRY);
			expect(text(w, 'comment')).toMatch(TEXT);
			expect(Math.abs(Number(text(w, 'lat')))).toBeLessThanOrEqual(90);
			expect(Math.abs(Number(text(w, 'lon')))).toBeLessThanOrEqual(180);
			// xsd:key WaypointIdKey, on the three fields together.
			keys.add(`${text(w, 'identifier')}|${text(w, 'type')}|${text(w, 'country-code')}`);
		}
		expect(keys.size).toBe(table.length);
		// xsd:keyref: every route-point names a table entry.
		const [route] = elements(fpl, 'route');
		expect(text(route, 'route-name')).toMatch(TEXT);
		expect(Number(text(route, 'flight-plan-index'))).toBeGreaterThanOrEqual(1);
		expect(Number(text(route, 'flight-plan-index'))).toBeLessThan(99);
		for (const p of elements(route, 'route-point')) {
			expect(
				keys.has(
					`${text(p, 'waypoint-identifier')}|${text(p, 'waypoint-type')}|${text(p, 'waypoint-country-code')}`,
				),
			).toBe(true);
		}
	});

	it('stays inside 7 bits, whatever the pilot called the point', () => {
		// A panel-mount navigator reading a card is the one consumer that
		// cannot be assumed to decode UTF-8.
		// eslint-disable-next-line no-control-regex -- the point is the range
		expect(fpl).toMatch(/^[\x00-\x7f]*$/);
	});

	it('writes nothing for a route without a departure and an arrival', () => {
		expect(buildRouteFpl(routeExportPoints([LFPL]), { subject: SUBJECT })).toBe('');
	});
});

describe('buildRouteGpx', () => {
	const gpx = buildRouteGpx(POINTS, { title: 'Châteaux de Picardie' });

	it('writes a route, and the waypoint list a reader picks its points from', () => {
		expect(gpx).toContain('<gpx version="1.1" creator="Loxodrome"');
		expect(elements(gpx, 'wpt').length).toBe(3);
		expect(elements(gpx, 'rtept').length).toBe(3);
		expect(gpx.indexOf('<wpt')).toBeLessThan(gpx.indexOf('<rte>'));
	});

	it('names the document and the route with the caption, accents and all', () => {
		expect(text(elements(gpx, 'metadata')[0], 'name')).toBe('Châteaux de Picardie');
		expect(elements(gpx, 'rte')[0]).toContain('<name>Châteaux de Picardie</name>');
	});

	it('states the leaving leg altitude in metres, and none at the arrival', () => {
		const legs = elements(gpx, 'rtept');
		expect(legs.map((p) => text(p, 'ele'))).toEqual(['457.2', '609.6', '(absent)']);
	});

	it('puts the identifier ahead of the name where a point has one', () => {
		const legs = elements(gpx, 'rtept');
		expect(legs.map((p) => text(p, 'name'))).toEqual([
			'LFPL Lognes Emerainville',
			'L&apos;obélisque',
			'LFPK Coulommiers Voisins',
		]);
	});

	it('sequences the point children as the GPX schema does, position on the tag', () => {
		expect(childTags(elements(gpx, 'rtept')[0])).toEqual(['ele', 'name']);
		const tags = openTags(gpx, 'rtept');
		expect(tags.map((t) => attr(t, 'lat'))).toEqual(['48.821944', '48.791601', '48.8375']);
		expect(tags.map((t) => attr(t, 'lon'))).toEqual(['2.622778', '2.869171', '3.014444']);
	});

	it('lists a place visited twice once in the waypoint list', () => {
		const circuit = buildRouteGpx(CIRCUIT, { title: 'circuit' });
		expect(elements(circuit, 'wpt').length).toBe(2);
		expect(elements(circuit, 'rtept').length).toBe(3);
	});
});

describe('buildRouteKml', () => {
	const kml = buildRouteKml(POINTS, { title: 'Châteaux de Picardie' });

	it('draws the course as one line and each point as a placemark', () => {
		expect(kml).toContain('<kml xmlns="http://www.opengis.net/kml/2.2">');
		expect(elements(kml, 'LineString').length).toBe(1);
		expect(elements(kml, 'Point').length).toBe(3);
	});

	it('states altitudes above sea level, the arrival at the level it arrives on', () => {
		const line = elements(kml, 'LineString')[0];
		expect(text(line, 'altitudeMode')).toBe('absolute');
		expect(text(line, 'coordinates').split(/\s+/)).toEqual([
			'2.622778,48.821944,457.2',
			'2.869171,48.791601,609.6',
			'3.014444,48.8375,609.6',
		]);
	});

	it('paints the line in the route ink', () => {
		expect(text(elements(kml, 'LineStyle')[0], 'color')).toBe('ff5b18c2');
	});

	it('pins a place visited twice once', () => {
		expect(elements(buildRouteKml(CIRCUIT, { title: 'circuit' }), 'Point').length).toBe(2);
	});
});

describe('buildRoutePln', () => {
	const pln = buildRoutePln(POINTS, { subject: SUBJECT, vfr: true });

	it('writes the AceXML header the simulators read', () => {
		expect(pln).toContain('<SimBase.Document Type="AceXML" version="1,0">');
		expect(text(pln, 'Descr')).toBe('AceXML Document');
		const version = elements(pln, 'AppVersion')[0];
		expect(text(version, 'AppVersionMajor')).toBe('10');
		expect(text(version, 'AppVersionBuild')).toBe('61637');
	});

	it('states the flight rules, the cruise and both ends', () => {
		const plan = elements(pln, 'FlightPlan.FlightPlan')[0];
		expect(text(plan, 'Title')).toBe('LFPL-LFPK');
		expect(text(plan, 'FPType')).toBe('VFR');
		expect(text(plan, 'CruisingAlt')).toBe('2000');
		expect(text(plan, 'DepartureID')).toBe('LFPL');
		expect(text(plan, 'DestinationID')).toBe('LFPK');
		expect(text(plan, 'DepartureName')).toBe('Lognes Emerainville');
		expect(text(plan, 'DestinationName')).toBe('Coulommiers Voisins');
	});

	it('writes positions in the simulator degrees, minutes and seconds', () => {
		const wps = elements(pln, 'ATCWaypoint');
		expect(text(wps[0], 'WorldPosition')).toBe('N48° 49\' 19.00",E002° 37\' 22.00",+001500.00');
		// Read back through the arithmetic, never against the writer's own text.
		const [lat, lon] = text(wps[1], 'WorldPosition').split(',');
		const dms = (s: string): number => {
			const m = /^([NSEW])(\d+)° (\d+)' ([\d.]+)"$/.exec(s);
			if (!m) {
				throw new Error(`not a position: ${s}`);
			}
			const v = Number(m[2]) + Number(m[3]) / 60 + Number(m[4]) / 3600;
			return m[1] === 'S' || m[1] === 'W' ? -v : v;
		};
		expect(dms(lat)).toBeCloseTo(48.791601, 5);
		expect(dms(lon)).toBeCloseTo(2.869171, 5);
	});

	it('carries the rounding into the minutes rather than writing a sixtieth second', () => {
		const abbey = wp({ label: 'Abbaye de Chaalis', lat: 49.15, lon: 2.686389, alt: 2500 });
		const text49 = buildRoutePln(routeExportPoints([LFPL, abbey, LFPK]), {
			subject: SUBJECT,
			vfr: true,
		});
		expect(text49).toContain('N49° 9\' 0.00"');
		expect(text49).not.toContain('60.00"');
	});

	it('types a known aerodrome Airport, with its ICAO ident, and the rest User', () => {
		const wps = elements(pln, 'ATCWaypoint');
		expect(wps.map((w) => text(w, 'ATCWaypointType'))).toEqual(['Airport', 'User', 'Airport']);
		expect(text(wps[0], 'ICAOIdent')).toBe('LFPL');
		expect(text(wps[1], 'ICAOIdent')).toBe('(absent)');
		expect(wps.length).toBe(3);
	});

	it('says IFR when the plan is drawn under instrument rules', () => {
		expect(text(buildRoutePln(POINTS, { subject: SUBJECT, vfr: false }), 'FPType')).toBe('IFR');
	});
});
