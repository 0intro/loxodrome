import { beforeEach, describe, expect, it } from 'vitest';
import {
	areaOfPoints,
	coverage,
	coverageWants,
	setCoverageArea,
	setForcedPublishers,
	unionArea,
	type CoverageArea,
} from '$lib/state/coverage.svelte';
import type { DatasetBBox } from '$lib/data/meta';

// [minLon, minLat, maxLon, maxLat], the order internal/aip/bbox.go writes.
const FRANCE: DatasetBBox = [-5.2, 41.3, 9.6, 51.1];
const AUSTRIA: DatasetBBox = [9.5, 46.3, 17.2, 49.1];
const GEORGIA: DatasetBBox = [40.0, 41.0, 46.8, 43.6];

const PARIS: CoverageArea = { minLat: 48.5, minLon: 2.0, maxLat: 49.1, maxLon: 2.8 };
const BUDAPEST: CoverageArea = { minLat: 47.2, minLon: 18.7, maxLat: 47.7, maxLon: 19.4 };

describe('coverage gate', () => {
	beforeEach(() => {
		setCoverageArea(null);
		setForcedPublishers([]);
	});

	it('loads a dataset whose sidecar carries no envelope', () => {
		// Absent means "unknown", never "empty": a dataset built before the
		// field existed, or one with no coordinates, must not be gated out.
		setCoverageArea(PARIS);
		expect(coverageWants('at', undefined)).toBe(true);
		expect(coverageWants('at', [] as unknown as DatasetBBox)).toBe(true);
	});

	it('loads only what the area reaches', () => {
		setCoverageArea(PARIS);
		expect(coverageWants('fr', FRANCE)).toBe(true);
		expect(coverageWants('at', AUSTRIA)).toBe(false);
	});

	it('loads a forced publisher wherever the map is', () => {
		// A loaded NOTAM points at Austria; its panel must be able to list
		// the affected airspaces even with the map over Paris.
		setCoverageArea(PARIS);
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
		setCoverageArea({ minLat: 47.0, minLon: 8.4, maxLat: 47.5, maxLon: 8.6 });
		expect(coverageWants('at', AUSTRIA)).toBe(true);
		// Far away stays out.
		expect(coverageWants('ge', GEORGIA)).toBe(false);
	});

	it('takes a route into the area through the union', () => {
		const routeArea = areaOfPoints([
			{ lat: 48.8, lon: 2.4 },
			{ lat: 47.3, lon: 11.4 }, // Innsbruck
		]);
		setCoverageArea(unionArea(PARIS, routeArea));
		expect(coverageWants('fr', FRANCE)).toBe(true);
		expect(coverageWants('at', AUSTRIA)).toBe(true);
	});

	it('ignores points with no usable position', () => {
		expect(areaOfPoints([])).toBeNull();
		expect(areaOfPoints([{ lat: NaN, lon: 3 }])).toBeNull();
	});

	it('settles identical updates without churning the state', () => {
		setCoverageArea(PARIS);
		const first = coverage.area;
		setCoverageArea({ ...PARIS });
		expect(coverage.area).toBe(first);

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

		setCoverageArea(BUDAPEST);
		expect(coverageWants('fr', FR_ENVELOPE)).toBe(true);
		expect(coverageWants('fr', FR_ENVELOPE, FR_PIECES)).toBe(false);

		setCoverageArea(PARIS);
		expect(coverageWants('fr', FR_ENVELOPE, FR_PIECES)).toBe(true);

		// Reunion is one of the pieces, so flying there loads France.
		setCoverageArea({ minLat: -21.4, minLon: 55.3, maxLat: -20.8, maxLon: 55.9 });
		expect(coverageWants('fr', FR_ENVELOPE, FR_PIECES)).toBe(true);
	});

	it('falls back to the envelope when no pieces are published', () => {
		setCoverageArea(PARIS);
		expect(coverageWants('fr', FRANCE, [])).toBe(true);
		expect(coverageWants('fr', FRANCE, undefined)).toBe(true);
	});
});
