/* The route export chokepoint (docs/route-files.md): which formats exist,
 * what each file is called, what it claims to be, and what a caller gets when
 * there is no route to write. */

import { describe, it, expect } from 'vitest';
import {
	ROUTE_FORMATS,
	ROUTE_FORMAT_LABEL,
	ROUTE_POINT_CAP,
	buildRouteExport,
	isRouteFormat,
	routeFileSpec,
	type RouteFormat,
} from '$lib/route/routeExport';
import { routeExportPoints } from '$lib/route/routePoints';
import type { Waypoint } from '$lib/state/route.svelte';

function wp(extra: Partial<Waypoint>): Waypoint {
	return { id: 't', lat: 0, lon: 0, kind: 'free', alt: 2000, altAuto: true, ...extra };
}

const POINTS = routeExportPoints([
	wp({ kind: 'airport', ident: 'LFPL', label: 'Lognes', lat: 48.821944, lon: 2.622778, alt: 1500 }),
	wp({ kind: 'airport', ident: 'LFPK', label: 'Coulommiers', lat: 48.8375, lon: 3.014444 }),
]);

const file = (format: RouteFormat): NonNullable<ReturnType<typeof buildRouteExport>> => {
	const out = buildRouteExport(POINTS, { format, subject: 'LFPL-LFPK', vfr: true });
	if (!out) {
		throw new Error('no file');
	}
	return out;
};

describe('routeFileSpec', () => {
	it('names an extension and a type for every format', () => {
		for (const format of ROUTE_FORMATS) {
			const spec = routeFileSpec(format);
			expect(spec.ext).toBe(format);
			expect(spec.mime).toMatch(/^application\//);
			expect(ROUTE_FORMAT_LABEL[format]).toBe(format.toUpperCase());
		}
	});

	it('claims the Garmin type for the FPL, which is what an Android chooser resolves', () => {
		expect(routeFileSpec('fpl').mime).toBe('application/vnd.garmin.flightplan');
	});

	it('recognises its own formats and nothing else', () => {
		expect(ROUTE_FORMATS.every(isRouteFormat)).toBe(true);
		expect(isRouteFormat('yaml')).toBe(false);
		expect(isRouteFormat(undefined)).toBe(false);
	});
});

describe('buildRouteExport', () => {
	it('names the file by subject and kind, the plan grammar', () => {
		expect(file('fpl').filename).toBe('LFPL-LFPK_plan.fpl');
		// The kind token stays on .gpx and .kml, where a trace omits it: the
		// extension no longer states which of the two the file holds.
		expect(file('gpx').filename).toBe('LFPL-LFPK_plan.gpx');
		expect(file('kml').filename).toBe('LFPL-LFPK_plan.kml');
		expect(file('pln').filename).toBe('LFPL-LFPK_plan.pln');
	});

	it('hands each format to its own writer', () => {
		expect(file('fpl').text).toContain('<flight-plan');
		expect(file('gpx').text).toContain('<gpx');
		expect(file('kml').text).toContain('<kml');
		expect(file('pln').text).toContain('<SimBase.Document');
	});

	it('reports what it wrote, so a caller can weigh it against the cap', () => {
		expect(file('fpl').points).toBe(2);
		expect(file('fpl').format).toBe('fpl');
		expect(file('fpl').mime).toBe(routeFileSpec('fpl').mime);
		expect(ROUTE_POINT_CAP).toBe(300);
	});

	it('falls back to the subject when the caller has no caption', () => {
		expect(file('gpx').text).toContain('<name>LFPL-LFPK</name>');
		const titled = buildRouteExport(POINTS, {
			format: 'gpx',
			subject: 'LFPL-LFPK',
			title: 'Châteaux',
			vfr: true,
		});
		expect(titled?.text).toContain('<name>Châteaux</name>');
	});

	it('refuses a route without a departure and an arrival', () => {
		for (const format of ROUTE_FORMATS) {
			expect(buildRouteExport([], { format, subject: 'x', vfr: true })).toBeNull();
			expect(
				buildRouteExport(POINTS.slice(0, 1), { format, subject: 'x', vfr: true }),
			).toBeNull();
		}
	});
});
