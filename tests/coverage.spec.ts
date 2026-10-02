import { beforeEach, describe, expect, it } from 'vitest';
import {
	areaOfPoints,
	coverage,
	coverageAreas,
	coverageStamp,
	coverageWants,
	setCoverageViewport,
	setForcedPublishers,
	publisherInCoverage,
	wrapArea,
	type CoverageArea,
} from '$lib/state/coverage.svelte';
import { planScope } from '$lib/state/planScope.svelte';
import type { DatasetBBox } from '$lib/data/meta';

// [minLon, minLat, maxLon, maxLat], the order internal/aip/bbox.go writes.
const FRANCE: DatasetBBox = [-5.2, 41.3, 9.6, 51.1];
const AUSTRIA: DatasetBBox = [9.5, 46.3, 17.2, 49.1];
const GEORGIA: DatasetBBox = [40.0, 41.0, 46.8, 43.6];

const PARIS: CoverageArea = { minLat: 48.5, minLon: 2.0, maxLat: 49.1, maxLon: 2.8 };
const BUDAPEST: CoverageArea = { minLat: 47.2, minLon: 18.7, maxLat: 47.7, maxLon: 19.4 };

describe('coverage gate', () => {
	beforeEach(() => {
		setCoverageViewport(null);
		setForcedPublishers([]);
		planScope.extent = null;
	});

	it('loads a dataset whose sidecar carries no envelope', () => {
		// Absent means "unknown", never "empty": a dataset built before the
		// field existed, or one with no coordinates, must not be gated out.
		setCoverageViewport(PARIS);
		expect(coverageWants('at', undefined)).toBe(true);
		expect(coverageWants('at', [] as unknown as DatasetBBox)).toBe(true);
	});

	it('loads only what the area reaches', () => {
		setCoverageViewport(PARIS);
		expect(coverageWants('fr', FRANCE)).toBe(true);
		expect(coverageWants('at', AUSTRIA)).toBe(false);
	});

	it('loads a forced publisher wherever the map is', () => {
		// A loaded NOTAM points at Austria; its panel must be able to list
		// the affected airspaces even with the map over Paris.
		setCoverageViewport(PARIS);
		setForcedPublishers(['at']);
		expect(coverageWants('at', AUSTRIA)).toBe(true);
	});

	it('loads nothing but forced publishers before the map reports a view', () => {
		expect(coverageWants('fr', FRANCE)).toBe(false);
		setForcedPublishers(['fr']);
		expect(coverageWants('fr', FRANCE)).toBe(true);
	});

	it('reaches a neighbour across the margin', () => {
		// Just west of the Austrian border: within the slack, so Austria
		// loads before the pan actually crosses it.
		setCoverageViewport({ minLat: 47.0, minLon: 8.4, maxLat: 47.5, maxLon: 8.6 });
		expect(coverageWants('at', AUSTRIA)).toBe(true);
		// Far away stays out.
		expect(coverageWants('ge', GEORGIA)).toBe(false);
	});

	it("takes the plan's areas in beside the viewport", () => {
		const routeArea = areaOfPoints([
			{ lat: 48.8, lon: 2.4 },
			{ lat: 47.3, lon: 11.4 }, // Innsbruck
		]);
		setCoverageViewport(PARIS);
		expect(coverageWants('at', AUSTRIA)).toBe(false);
		planScope.extent = () => (routeArea ? [routeArea] : []);
		expect(coverageWants('fr', FRANCE)).toBe(true);
		expect(coverageWants('at', AUSTRIA)).toBe(true);
	});

	it('loads a plan with no view at all, as a boot does before the map lays out', () => {
		planScope.extent = () => [PARIS];
		expect(coverageWants('fr', FRANCE)).toBe(true);
		expect(coverageWants('at', AUSTRIA)).toBe(false);
	});

	it('tests each area apart, never the envelope that spans them', () => {
		// A French plan with Foligno added on the performance page: one
		// envelope over both would reach Austria (and Switzerland, and
		// southern Germany), megabytes nobody asked for.
		const ITALY: DatasetBBox = [6.6, 36.6, 18.5, 47.1];
		const FOLIGNO: CoverageArea = { minLat: 42.93, minLon: 12.71, maxLat: 42.93, maxLon: 12.71 };
		setCoverageViewport(PARIS);
		planScope.extent = () => [FOLIGNO];
		expect(coverageWants('it', ITALY)).toBe(true);
		expect(coverageWants('at', AUSTRIA)).toBe(false);
	});

	it('keeps the area list and its stamp while nothing moves', () => {
		// An altitude edit rebuilds the routes and moves no rectangle: the
		// watcher must not wake, and a store must not judge its gate again.
		setCoverageViewport(PARIS);
		planScope.extent = () => [{ ...BUDAPEST }];
		const list = coverageAreas();
		const stamp = coverageStamp();
		planScope.extent = () => [{ ...BUDAPEST }];
		expect(coverageAreas()).toBe(list);
		expect(coverageStamp()).toBe(stamp);
		setCoverageViewport(BUDAPEST);
		expect(coverageAreas()).not.toBe(list);
		expect(coverageStamp()).not.toBe(stamp);
		const moved = coverageStamp();
		setForcedPublishers(['at']);
		expect(coverageStamp()).not.toBe(moved);
	});

	it('ignores a viewport with no finite bounds', () => {
		setCoverageViewport(PARIS);
		setCoverageViewport({ minLat: NaN, minLon: 2, maxLat: 49, maxLon: 3 });
		expect(coverage.viewport).toEqual(PARIS);
	});

	it('ignores points with no usable position', () => {
		expect(areaOfPoints([])).toBeNull();
		expect(areaOfPoints([{ lat: NaN, lon: 3 }])).toBeNull();
	});

	it('settles identical updates without churning the state', () => {
		setCoverageViewport(PARIS);
		const first = coverage.viewport;
		setCoverageViewport({ ...PARIS });
		expect(coverage.viewport).toBe(first);

		setForcedPublishers(['at', 'de']);
		const forced = coverage.forced;
		setForcedPublishers(['de', 'at', 'de']);
		expect(coverage.forced).toBe(forced);
	});

	it('tests the disjoint pieces, not the envelope that spans them', () => {
		// France's AIP covers the metropole, the Antilles, Reunion,
		// Polynesia and New Caledonia, so its single envelope is true of
		// almost any viewport and would defeat the gate on the largest
		// dataset in the repository.
		const FR_ENVELOPE: DatasetBBox = [-157, -44.574, 170.5, 53];
		const FR_PIECES: DatasetBBox[] = [
			[-157, -30, -145, 3.5], // Polynesia
			[-65, 2.34, -35, 22.3], // Antilles and Guyane
			[-8.75, 39, 10.7, 51.117], // the metropole
			[52.835, -30, 57, -10], // Reunion
			[161.25, -24.005, 170.5, -14], // New Caledonia
		];

		setCoverageViewport(BUDAPEST);
		expect(coverageWants('fr', FR_ENVELOPE)).toBe(true);
		expect(coverageWants('fr', FR_ENVELOPE, FR_PIECES)).toBe(false);

		setCoverageViewport(PARIS);
		expect(coverageWants('fr', FR_ENVELOPE, FR_PIECES)).toBe(true);

		// Reunion is one of the pieces, so flying there loads France.
		setCoverageViewport({ minLat: -21.4, minLon: 55.3, maxLat: -20.8, maxLon: 55.9 });
		expect(coverageWants('fr', FR_ENVELOPE, FR_PIECES)).toBe(true);
	});

	it('falls back to the envelope when no pieces are published', () => {
		setCoverageViewport(PARIS);
		expect(coverageWants('fr', FRANCE, [])).toBe(true);
		expect(coverageWants('fr', FRANCE, undefined)).toBe(true);
	});

	it('reads a view panned across the dateline in the longitudes the pieces use', () => {
		// Neither map copies the world back: panned east past 180 it reports
		// Tahiti at 209.5 E, which compared raw loaded nothing French.
		const POLYNESIA: DatasetBBox[] = [[-157, -30, -145, 3.5]];
		setCoverageViewport({ minLat: -18, minLon: 209.5, maxLat: -17, maxLon: 211 });
		expect(coverageWants('fr', FRANCE, POLYNESIA)).toBe(true);
		setCoverageViewport({ minLat: -18, minLon: -510.5, maxLat: -17, maxLon: -509 });
		expect(coverageWants('fr', FRANCE, POLYNESIA)).toBe(true);
	});

	it('splits a view astride the antimeridian in two', () => {
		expect(wrapArea({ minLat: -20, minLon: 175, maxLat: -15, maxLon: 185 })).toEqual([
			{ minLat: -20, minLon: 175, maxLat: -15, maxLon: 180 },
			{ minLat: -20, minLon: -180, maxLat: -15, maxLon: -175 },
		]);
		expect(wrapArea({ minLat: 0, minLon: -400, maxLat: 1, maxLon: 10 })).toEqual([
			{ minLat: 0, minLon: -180, maxLat: 1, maxLon: 180 },
		]);
		setCoverageViewport({ minLat: -20, minLon: 175, maxLat: -15, maxLon: 185 });
		expect(coverageAreas()).toHaveLength(2);
	});

	it('reaches across the antimeridian with its margin', () => {
		// A piece ending at 180 (the FAA's Aleutians, Wallis and Futuna's
		// east) and an area just past it at -179.8: the margin was added to
		// the raw longitudes, so it never reached across.
		const EAST: DatasetBBox[] = [[172, -15, 180, -12]];
		setCoverageViewport({ minLat: -14.5, minLon: -179.8, maxLat: -13.5, maxLon: -179.2 });
		expect(coverageWants('faa', FRANCE, EAST)).toBe(true);
		const WEST: DatasetBBox[] = [[-180, -15, -176, -12]];
		setCoverageViewport({ minLat: -14.5, minLon: 179.2, maxLat: -13.5, maxLon: 179.8 });
		expect(coverageWants('faa', FRANCE, WEST)).toBe(true);
		// A pose snapped onto 180 wraps to -180 (wrapArea), and still sees
		// the pieces on both sides.
		setCoverageViewport({ minLat: -14, minLon: 180, maxLat: -14, maxLon: 180 });
		expect(coverageWants('faa', FRANCE, EAST)).toBe(true);
		expect(coverageWants('faa', FRANCE, WEST)).toBe(true);
		// Out of the margin on either side, still nothing.
		setCoverageViewport({ minLat: -14.5, minLon: -170, maxLat: -13.5, maxLon: -169 });
		expect(coverageWants('faa', FRANCE, EAST)).toBe(false);
	});

	it('judges a publisher on its own territory when its envelope is unknown', () => {
		setCoverageViewport(PARIS);
		expect(publisherInCoverage('fr')).toBe(true);
		expect(publisherInCoverage('is')).toBe(false);
		setCoverageViewport(BUDAPEST);
		expect(publisherInCoverage('fr')).toBe(false);
		// Reunion is France's too.
		setCoverageViewport({ minLat: -21.4, minLon: 55.3, maxLat: -20.8, maxLon: 55.9 });
		expect(publisherInCoverage('fr')).toBe(true);
		setForcedPublishers(['is']);
		expect(publisherInCoverage('is')).toBe(true);
	});
});
