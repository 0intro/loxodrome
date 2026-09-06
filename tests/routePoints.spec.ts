/* The points a route hands a file (docs/route-files.md): who is an aerodrome,
 * what each point is called, and which level it states.
 *
 * The identifier rules are the ones every writer then depends on, so they are
 * pinned here once rather than four times: a name folds to ASCII, is capped,
 * and is bound to the POSITION it names, which is what makes "one identifier,
 * one place, one table row" true by construction in the Garmin file. */

import { describe, it, expect } from 'vitest';
import { planExportPoints, routeExportPoints, levelsFlown } from '$lib/route/routePoints';
import type { Route, Waypoint } from '$lib/state/route.svelte';

function wp(extra: Partial<Waypoint>): Waypoint {
	return { id: 't', lat: 0, lon: 0, kind: 'free', alt: 2000, altAuto: true, ...extra };
}

const ap = (ident: string, lat: number, lon: number, label?: string): Waypoint =>
	wp({ kind: 'airport', ident, lat, lon, label });
const nav = (ident: string, lat: number, lon: number, label?: string): Waypoint =>
	wp({ kind: 'navaid', ident, lat, lon, label });
const free = (label: string | undefined, lat: number, lon: number): Waypoint =>
	wp({ kind: 'free', label, lat, lon });

const route = (waypoints: Waypoint[], alternate = false): Route => ({
	id: 'r',
	name: null,
	waypoints,
	selectedWaypointId: null,
	...(alternate ? { alternate } : {}),
});

const LFPL = ap('LFPL', 48.821944, 2.622778, 'Lognes Emerainville');
const LFPK = ap('LFPK', 48.8375, 3.014444, 'Coulommiers Voisins');
const OBELISQUE = free("L'obélisque", 48.791601, 2.869171);

describe('routeExportPoints', () => {
	it('keeps an aerodrome under its own ICAO identifier', () => {
		const [p] = routeExportPoints([LFPL, LFPK]);
		expect(p.ident).toBe('LFPL');
		expect(p.code).toBe('LFPL');
		expect(p.aerodrome).toBe(true);
		expect(p.name).toBe('Lognes Emerainville');
	});

	it('folds a free point name to six ASCII characters and keeps the original', () => {
		const [, p] = routeExportPoints([LFPL, OBELISQUE, LFPK]);
		expect(p.ident).toBe('LOBELI');
		expect(p.code).toBeNull();
		expect(p.aerodrome).toBe(false);
		expect(p.name).toBe("L'obélisque");
	});

	it('separates two different places whose names fold alike', () => {
		const points = routeExportPoints([
			LFPL,
			free('Château de Chantilly', 49.194444, 2.487222),
			free('Château de Nesle', 49.204167, 3.569167),
			LFPK,
		]);
		expect(points.map((p) => p.ident)).toEqual(['LFPL', 'CHATEA', 'CHATE2', 'LFPK']);
	});

	it('gives one place one identifier however often it is flown over', () => {
		const points = routeExportPoints([LFPL, nav('CLM', 48.860556, 3.005833), LFPL]);
		expect(points.map((p) => p.ident)).toEqual(['LFPL', 'CLM', 'LFPL']);
	});

	it('demotes a second aerodrome row claiming an identifier at another place', () => {
		// One identifier at two positions (a stale row beside its replacement)
		// would put two rows under one name in the Garmin table, which the
		// schema refuses: the second keeps a name of its own and stops being
		// an aerodrome the reader may resolve from its database.
		const stale = ap('LFPK', 47.5, 1.5, 'Elsewhere');
		const points = routeExportPoints([LFPL, LFPK, stale]);
		expect(points.map((p) => p.ident)).toEqual(['LFPL', 'LFPK', 'LFPK2']);
		expect(points[1].aerodrome).toBe(true);
		expect(points[2].aerodrome).toBe(false);
	});

	it('leaves a field the caller does not vouch for as a user waypoint', () => {
		const [p] = routeExportPoints([LFPL, LFPK], { knownAerodrome: () => false });
		expect(p.aerodrome).toBe(false);
		expect(p.ident).toBe('LFPL');
	});

	it('names a point that folds to nothing after its place in the route', () => {
		const points = routeExportPoints([LFPL, free(undefined, 48.9, 2.9), LFPK]);
		expect(points[1].ident).toBe('WP2');
		expect(points[1].name).toBe('48.900, 2.900');
	});

	it('states the leaving leg altitude, and none at the arrival', () => {
		const points = routeExportPoints([
			wp({ ...LFPL, alt: 1500 }),
			wp({ ...OBELISQUE, alt: 2000 }),
			wp({ ...LFPK, alt: 3500 }),
		]);
		expect(points.map((p) => p.altFt)).toEqual([1500, 2000, null]);
	});

	it('wraps a longitude carried off a panned world copy', () => {
		const [, p] = routeExportPoints([LFPL, free('Est', 48.8, 362.869171), LFPK]);
		expect(p.lon).toBeCloseTo(2.869171, 6);
	});

	it('names an unnamed point after the position it will be written at', () => {
		// Not the raw one: a point dropped on a panned world copy would then be
		// called "48.900, 362.900" while the file states 2.900.
		const [, p] = routeExportPoints([LFPL, free(undefined, 48.9, 362.9), LFPK]);
		expect(p.name).toBe('48.900, 2.900');
	});

	it('writes the aerodrome two legs share once, at the leaving leg altitude', () => {
		const points = planExportPoints([
			route([wp({ ...LFPL, alt: 1500 }), wp({ ...LFPK, alt: 4500 })]),
			route([wp({ ...LFPK, alt: 2500 }), wp({ ...LFPL, alt: 3500 })]),
		]);
		expect(points.map((p) => p.ident)).toEqual(['LFPL', 'LFPK', 'LFPL']);
		// 4500 is the arrival row's stale value; 2500 is the leg actually flown
		// out of the junction.
		expect(points.map((p) => p.altFt)).toEqual([1500, 2500, null]);
	});

	it('leaves an alternate and a scratch route out of a plan', () => {
		const points = planExportPoints([
			route([LFPL, LFPK]),
			route([LFPK, ap('LFAI', 48.596944, 3.008056)], true),
			route([OBELISQUE]),
		]);
		expect(points.map((p) => p.ident)).toEqual(['LFPL', 'LFPK']);
	});
});

describe('levelsFlown', () => {
	it('gives the arrival the level it arrives on', () => {
		const points = routeExportPoints([
			wp({ ...LFPL, alt: 1500 }),
			wp({ ...OBELISQUE, alt: 2000 }),
			wp({ ...LFPK, alt: 3500 }),
		]);
		expect(levelsFlown(points)).toEqual([1500, 2000, 2000]);
	});
});
