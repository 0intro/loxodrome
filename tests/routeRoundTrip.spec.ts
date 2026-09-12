/* A plan written out and read straight back in (docs/route-files.md).
 *
 * This is the only place the writers feed the readers, and it asserts the
 * ENUMERATED invariants rather than equality: what a format cannot carry is
 * documented, not smuggled through a test. Everything else about the readers
 * is pinned against a foreign writer's bytes in tests/routeImport.spec.ts,
 * because a reader and a writer of one house can agree on a mistake. */

import { describe, it, expect } from 'vitest';
import { buildRouteExport, ROUTE_FORMATS, type RouteFormat } from '$lib/route/routeExport';
import { identCandidates, readRouteFile } from '$lib/route/routeImport';
import { routeExportPoints } from '$lib/route/routePoints';
import type { Waypoint } from '$lib/state/route.svelte';

function wp(extra: Partial<Waypoint>): Waypoint {
	return { id: 't', lat: 0, lon: 0, kind: 'free', alt: 2000, altAuto: true, ...extra };
}

/* An aerodrome, a named free point with an accent, a navaid, and back to the
 * aerodrome: one route that exercises every identity a file can state. */
const WAYPOINTS = [
	wp({ kind: 'airport', ident: 'LFPL', label: 'Lognes Emerainville', lat: 48.821944, lon: 2.622778, alt: 1500 }),
	wp({ label: "L'obélisque", lat: 48.791601, lon: 2.869171, alt: 2000 }),
	wp({ kind: 'navaid', ident: 'CLM', label: 'Coulommiers', lat: 48.860556, lon: 3.005833, alt: 2500 }),
	wp({ kind: 'airport', ident: 'LFPL', label: 'Lognes Emerainville', lat: 48.821944, lon: 2.622778, alt: 3500 }),
];
const POINTS = routeExportPoints(WAYPOINTS);

function roundTrip(format: RouteFormat): ReturnType<typeof readRouteFile> {
	const file = buildRouteExport(POINTS, { format, subject: 'LFPL-LFPL', title: 'Sortie', vfr: true });
	if (!file) {
		throw new Error('no file');
	}
	return readRouteFile(file.text);
}

describe.each(ROUTE_FORMATS)('a plan written as %s and read back', (format) => {
	const plan = roundTrip(format);

	it('keeps every point, in order', () => {
		expect(plan.format).toBe(format);
		expect(plan.routes[0].points).toHaveLength(POINTS.length);
	});

	it('keeps every position', () => {
		// The PLN states degrees, minutes and hundredths of a second, so its
		// own grammar is the tolerance: a tenth of a second of arc is 3 m.
		const dp = format === 'pln' ? 5 : 6;
		plan.routes[0].points.forEach((p, i) => {
			expect(p.lat).toBeCloseTo(POINTS[i].lat, dp);
			expect(p.lon).toBeCloseTo(POINTS[i].lon, dp);
		});
	});

	it('offers every identifier back for confirmation', () => {
		// Not as an ident on the point (only the loader, which has the data,
		// may decide that), but recoverable: an aerodrome and a navaid must
		// both survive a round trip through every format.
		expect(identCandidates(plan.routes[0].points[0])).toContain('LFPL');
		expect(identCandidates(plan.routes[0].points[2])).toContain('CLM');
	});
});

describe('what each format does and does not carry', () => {
	it('GPX and KML keep the names and the levels whole', () => {
		for (const format of ['gpx', 'kml'] as const) {
			const plan = roundTrip(format);
			expect(plan.routes[0].points[1].name).toBe("L'obélisque");
			// The leg levels, and none at the arrival: the writers restate the
			// inbound level there only because KML cannot omit it.
			expect(plan.routes[0].points.map((p) => p.altFt)).toEqual([1500, 2000, 2500, null]);
		}
	});

	it('the FPL folds a name to ASCII and states no level at all', () => {
		const plan = roundTrip('fpl');
		// Its own schema restricts both fields; the accent is the documented
		// loss, and it is stable from the second pass on.
		expect(plan.routes[0].points[1].name).toBe("L'obelisque");
		expect(plan.routes[0].points.every((p) => p.altFt === null)).toBe(true);
	});

	it('the PLN keeps the levels and the flight rules but only identifiers for names', () => {
		const plan = roundTrip('pln');
		expect(plan.vfr).toBe(true);
		expect(plan.routes[0].points.map((p) => p.altFt)).toEqual([1500, 2000, 2500, null]);
		// ATCWaypoint has an id and no name field: the identifier is the name.
		expect(plan.routes[0].points[1].name).toBe('LOBELI');
	});

	it('carries the caption, so a named plan keeps its name', () => {
		for (const format of ROUTE_FORMATS) {
			expect(roundTrip(format).title).toBeTruthy();
		}
	});

	it('reads its own second pass identically', () => {
		// The one property that matters for a file edited elsewhere and
		// brought back: import, export, import must be a fixed point.
		for (const format of ROUTE_FORMATS) {
			const first = roundTrip(format);
			const again = buildRouteExport(
				first.routes[0].points.map((p, i) => ({
					// The identifiers a real second pass would have: the loader
					// resolves them, and two places never share one.
					ident: p.ident ?? `WP${i + 1}`,
					code: null,
					aerodrome: p.aerodrome,
					name: p.name ?? '',
					lat: p.lat,
					lon: p.lon,
					altFt: p.altFt,
				})),
				{ format, subject: 'LFPL-LFPL', title: first.title ?? '', vfr: first.vfr ?? true },
			);
			const second = readRouteFile(again!.text);
			expect(second.routes[0].points.map((p) => [p.lat, p.lon, p.altFt])).toEqual(
				first.routes[0].points.map((p) => [p.lat, p.lon, p.altFt]),
			);
		}
	});
});
