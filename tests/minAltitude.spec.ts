/* Pure-logic coverage for the per-leg minimum safe altitude
 * (src/lib/route/minAltitude.ts): the rounding formula, the obstacle corridor
 * filter, and the terrain swath geometry, which is a CAPSULE (round ends, the
 * disc SERA.5015(b) sweeps along the leg) rather than a rectangle stopping at
 * each waypoint. The tile fetch needs a browser and is exercised manually;
 * the reduction that reads it is pinned in tests/terrain.spec.ts. */

import { describe, it, expect } from 'vitest';
import {
	MOUNTAINOUS_ELEV_FT,
	MOUNTAINOUS_RELIEF_FT,
	cellExceedsRoute,
	corridorAlongBins,
	corridorSamplePoints,
	legCorridorCells,
	maxObstacleTopFt,
	msaMarginForTerrainFt,
	msaMarginFt,
	profileObstacleMarks,
	projectPointToRoute,
	roundedMinAltFt,
	type LatLon,
} from '$lib/route/minAltitude';
import { pointToSegmentDistanceM } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import type { Obstacle } from '$lib/data/obstacles';

const ob = (lat: number, lon: number, elev: number | null, hgt: number | null): Obstacle => ({
	id: 'x',
	type: 'mast',
	name: 'test',
	lat,
	lon,
	elev,
	hgt,
	lit: false,
	group: false,
	rmk: '',
	source: 'fr',
});

describe('roundedMinAltFt', () => {
	it('rounds max + margin up to the next 100 ft', () => {
		expect(roundedMinAltFt(1234, null)).toBe(1800); // 1734 -> 1800
		expect(roundedMinAltFt(1000, null)).toBe(1500); // 1500 already a multiple
		expect(roundedMinAltFt(1501, null)).toBe(2100); // 2001 -> 2100
	});

	it('takes the higher of ground and obstacle top', () => {
		expect(roundedMinAltFt(1000, 3000)).toBe(3500); // obstacle taller
		expect(roundedMinAltFt(4000, 1000)).toBe(4500); // ground taller
		expect(roundedMinAltFt(null, 2000)).toBe(2500); // obstacle only
	});

	it('honours a custom margin', () => {
		expect(roundedMinAltFt(1000, null, 1000)).toBe(2000);
	});

	it('applies the IFR margin through msaMarginFt (SERA.5015(b))', () => {
		expect(roundedMinAltFt(1234, null, msaMarginFt(false))).toBe(2300); // 2234 -> 2300
		expect(roundedMinAltFt(1000, 3000, msaMarginFt(false))).toBe(4000); // obstacle + 1000
	});

	it('applies the mountainous 2000 ft IFR margin through msaMarginForTerrainFt', () => {
		// Relief 3421 ft -> mountainous -> 4321 + 2000 = 6321 -> 6400.
		expect(roundedMinAltFt(4321, null, msaMarginForTerrainFt(false, 4321, 900))).toBe(6400);
	});

	it('is null when there is no data', () => {
		expect(roundedMinAltFt(null, null)).toBeNull();
	});
});

describe('msaMarginFt', () => {
	it('is 500 ft for VFR (terrain-clearance planning aid)', () => {
		expect(msaMarginFt(true)).toBe(500);
	});

	it('is 1000 ft for IFR (SERA.5015(b) minimum IFR level)', () => {
		expect(msaMarginFt(false)).toBe(1000);
	});
});

describe('msaMarginForTerrainFt', () => {
	it('keeps the flat 1000 ft IFR margin over ordinary terrain', () => {
		expect(msaMarginForTerrainFt(false, 2000, 500)).toBe(1000);
	});

	it('is 2000 ft IFR at the mountainous elevation threshold (max ground >= 5000 ft, inclusive)', () => {
		expect(msaMarginForTerrainFt(false, 6500, 4500)).toBe(2000);
		expect(msaMarginForTerrainFt(false, MOUNTAINOUS_ELEV_FT, 4500)).toBe(2000); // exactly 5000
		expect(msaMarginForTerrainFt(false, MOUNTAINOUS_ELEV_FT - 1, 4500)).toBe(1000);
		expect(msaMarginForTerrainFt(false, 5000, null)).toBe(2000); // elevation rule alone, min unknown
	});

	it('is 2000 ft IFR at the mountainous relief threshold (max - min >= 3000 ft, inclusive)', () => {
		expect(msaMarginForTerrainFt(false, 4500, 1000)).toBe(2000); // relief 3500
		expect(msaMarginForTerrainFt(false, 4000, 4000 - MOUNTAINOUS_RELIEF_FT)).toBe(2000); // exactly 3000
		expect(msaMarginForTerrainFt(false, 4000, 1001)).toBe(1000); // relief 2999
	});

	it('stays 500 ft VFR always (planning aid, not a SERA minimum)', () => {
		expect(msaMarginForTerrainFt(true, 6500, 500)).toBe(500); // mountainous by elevation
		expect(msaMarginForTerrainFt(true, 4500, 1000)).toBe(500); // mountainous by relief
		expect(msaMarginForTerrainFt(true, 2000, 500)).toBe(500);
		expect(msaMarginForTerrainFt(true, null, null)).toBe(500);
	});

	it('falls back to the flat msaMarginFt on null ground stats (both rules need the max)', () => {
		expect(msaMarginForTerrainFt(false, null, null)).toBe(1000);
		expect(msaMarginForTerrainFt(false, null, 200)).toBe(1000); // relief needs both bounds
		expect(msaMarginForTerrainFt(false, 4000, null)).toBe(1000); // no relief test without the min
	});
});

describe('maxObstacleTopFt', () => {
	// North-south leg along the 2.0 meridian (~60 NM).
	const a: LatLon = { lat: 48.0, lon: 2.0 };
	const b: LatLon = { lat: 49.0, lon: 2.0 };
	// One NM of longitude at lat 48.5.
	const nmLon = NM_TO_METERS / (111320 * Math.cos((48.5 * Math.PI) / 180));

	it('counts obstacles within 5 NM and skips those beyond (top = elev AMSL)', () => {
		const near = ob(48.5, 2.0 + 4 * nmLon, 1000, 200); // ~4 NM off -> top 1000
		const far = ob(48.5, 2.0 + 6 * nmLon, 5000, 500); // ~6 NM off -> skipped
		expect(maxObstacleTopFt(a, b, [near, far])).toBe(1000);
	});

	it('picks the tallest top (elev) in range', () => {
		const lowOb = ob(48.5, 2.0, 1000, 100); // top 1000, on the leg
		const highOb = ob(48.6, 2.0 + 1 * nmLon, 1500, 400); // top 1500, ~1 NM off
		expect(maxObstacleTopFt(a, b, [lowOb, highOb])).toBe(1500);
	});

	it('needs elev (the top AMSL) but not hgt; never adds hgt to elev', () => {
		expect(maxObstacleTopFt(a, b, [ob(48.5, 2.0, null, 300)])).toBeNull(); // no elev -> skipped
		expect(maxObstacleTopFt(a, b, [ob(48.5, 2.0, 800, null)])).toBe(800); // elev only -> counts
		expect(maxObstacleTopFt(a, b, [ob(48.5, 2.0, 800, 700)])).toBe(800); // hgt is NOT added
	});

	it('is null when none are in the corridor', () => {
		expect(maxObstacleTopFt(a, b, [ob(48.5, 2.0 + 10 * nmLon, 9000, 100)])).toBeNull();
	});
});

describe('corridorSamplePoints', () => {
	const a: LatLon = { lat: 48.0, lon: 2.0 };
	const b: LatLon = { lat: 48.5, lon: 2.5 };
	const dist = (p: LatLon): number =>
		pointToSegmentDistanceM(p.lat, p.lon, a.lat, a.lon, b.lat, b.lon);
	// A cell is kept while its QUAD still reaches the leg, so a centre may sit
	// up to half a cell diagonal outside the capsule. ~1% slack on top: the
	// planar cos(lat) offset uses the leg's mid-latitude, so the corridor edge
	// is fuzzy by ~0.5% (erring slightly wide, which is safe).
	const halfDiagM = Math.hypot((5 / 2) * NM_TO_METERS, (2.5 / 2) * NM_TO_METERS);

	it('keeps every sample within half a cell of the corridor', () => {
		const pts = corridorSamplePoints(a, b, 5, 5, 2.5);
		expect(pts.length).toBeGreaterThan(0);
		const limit = 5 * NM_TO_METERS * 1.01 + halfDiagM;
		for (const p of pts) {
			expect(dist(p)).toBeLessThanOrEqual(limit);
		}
	});

	it('includes centerline samples (distance ~0 to the leg)', () => {
		const pts = corridorSamplePoints(a, b, 5, 5, 2.5);
		const onLine = pts.filter((p) => dist(p) < 1);
		expect(onLine.length).toBeGreaterThan(0);
	});

	it('reaches past both waypoints: the corridor has round ends', () => {
		const cells = legCorridorCells(a, b, 5, 1, 1);
		expect(cells.some((c) => c.alongIdx < 0)).toBe(true);
		const alongBins = corridorAlongBins(a, b, 1);
		expect(cells.some((c) => c.alongIdx > alongBins)).toBe(true);
		// Everything past an end is inside the cap, not in a squared-off
		// corner: a cell 4 cells beyond the end cannot also be 4 abeam.
		for (const c of cells) {
			if (c.alongIdx > alongBins) {
				const beyond = c.alongIdx - alongBins;
				expect(Math.hypot(beyond - 0.5, Math.abs(c.crossIdx) - 0.5)).toBeLessThanOrEqual(5);
			}
		}
	});

	it('covers the ground the obstacle test has always covered', () => {
		// maxObstacleTopFt uses pointToSegmentDistanceM, a capsule; before the
		// round ends, an obstacle 3 NM beyond the turn counted while the
		// terrain under it was never sampled.
		const cells = legCorridorCells(a, b, 5, 1, 1);
		const nmLat = NM_TO_METERS / 111320;
		const beyondB: LatLon = { lat: b.lat + 3 * nmLat * Math.SQRT1_2, lon: b.lon + 3 * nmLat * Math.SQRT1_2 / Math.cos((b.lat * Math.PI) / 180) };
		expect(dist(beyondB)).toBeLessThan(5 * NM_TO_METERS);
		const near = cells.some(
			(c) =>
				Math.abs(c.center.lat - beyondB.lat) < 0.02 && Math.abs(c.center.lon - beyondB.lon) < 0.03,
		);
		expect(near).toBe(true);
	});

	it('lays the cells out on one grid, (2*cross+1) lanes wide at the body', () => {
		// 5 NM half-width at a 2.5 NM cross step -> 2 each side -> 5 lanes.
		const cells = legCorridorCells(a, b, 5, 5, 2.5);
		const alongBins = corridorAlongBins(a, b, 5);
		const body = cells.filter((c) => c.alongIdx >= 0 && c.alongIdx <= alongBins);
		expect(body.length).toBe(5 * (alongBins + 1));
		for (const c of body) {
			expect(Math.abs(c.crossIdx)).toBeLessThanOrEqual(2);
		}
	});
});

describe('cellExceedsRoute', () => {
	it('is true only when the rounded MSA tops the planned altitude', () => {
		// ground 1234 -> MSA 1800 (1734 rounded up to the next 100 ft).
		expect(cellExceedsRoute(1234, 1700)).toBe(true); // 1800 > 1700
		expect(cellExceedsRoute(1234, 1800)).toBe(false); // 1800 not strictly > 1800
		expect(cellExceedsRoute(1234, 1900)).toBe(false); // 1800 < 1900
	});

	it('never conflicts without terrain data', () => {
		expect(cellExceedsRoute(null, 0)).toBe(false);
	});

	it('honours a custom margin', () => {
		expect(cellExceedsRoute(1000, 1900, 1000)).toBe(true); // MSA 2000 > 1900
		expect(cellExceedsRoute(1000, 1900)).toBe(false); // default 500 -> MSA 1500
	});
});

describe('projectPointToRoute', () => {
	const pts: LatLon[] = [
		{ lat: 48.0, lon: 2.0 },
		{ lat: 48.0, lon: 3.0 },
	];
	const cumNM = [0, 40];

	it('anchors a mid-leg point to the caller cumNM with its lateral offset', () => {
		const p = projectPointToRoute(pts, cumNM, 48.0 + 3 / 60, 2.5, 5);
		expect(p).not.toBeNull();
		expect(p?.distNM).toBeCloseTo(20, 1);
		expect(p?.offsetNM).toBeCloseTo(3, 1);
	});

	it('is null beyond the half-width and for degenerate inputs', () => {
		expect(projectPointToRoute(pts, cumNM, 48.0 + 7 / 60, 2.5, 5)).toBeNull();
		expect(projectPointToRoute([pts[0]], [0], 48, 2, 5)).toBeNull();
		expect(projectPointToRoute(pts, [0], 48, 2.5, 5)).toBeNull();
	});
});

describe('profileObstacleMarks', () => {
	// Two legs along the 48th parallel: A (2.0E) -> B (3.0E) -> C (3.0E, 48.5N).
	// cumNM is the caller's chart basis; use round numbers to pin anchoring.
	const pts: LatLon[] = [
		{ lat: 48.0, lon: 2.0 },
		{ lat: 48.0, lon: 3.0 },
		{ lat: 48.5, lon: 3.0 },
	];
	const cumNM = [0, 40, 70];
	// One NM of longitude at lat 48.
	const nmLon = NM_TO_METERS / (111320 * Math.cos((48.0 * Math.PI) / 180));

	it('projects an on-track obstacle to the leg fraction of the caller cumNM', () => {
		// Mid-leg 1 (lon 2.5) -> t = 0.5 -> distNM = 20 on the caller's basis.
		const marks = profileObstacleMarks(pts, cumNM, [ob(48.0, 2.5, 1200, 300)], 5);
		expect(marks).toHaveLength(1);
		expect(marks[0].distNM).toBeCloseTo(20, 1);
		expect(marks[0].topFt).toBe(1200);
		expect(marks[0].baseFt).toBe(900); // top - hgt
		expect(marks[0].offsetNM).toBeCloseTo(0, 2);
	});

	it('keeps obstacles within the half-width and drops those beyond', () => {
		const near = ob(48.0 + 4 / 60, 2.5, 1000, null); // ~4 NM north of leg 1
		const far = ob(48.0 + 7 / 60, 2.5, 5000, null); // ~7 NM north -> out at 5 NM
		const marks = profileObstacleMarks(pts, cumNM, [near, far], 5);
		expect(marks).toHaveLength(1);
		expect(marks[0].topFt).toBe(1000);
		expect(marks[0].baseFt).toBeNull(); // unknown height -> no stem
		expect(marks[0].offsetNM).toBeCloseTo(4, 1);
	});

	it('anchors an obstacle near the corner to its nearest leg only (no duplicate)', () => {
		// Just east of the corner waypoint B: within 5 NM of BOTH legs, nearest
		// to leg 2 (the north-bound one). One mark, anchored past cumNM[1].
		const marks = profileObstacleMarks(pts, cumNM, [ob(48.05, 3.0 + 1 * nmLon, 900, 100)], 5);
		expect(marks).toHaveLength(1);
		expect(marks[0].distNM).toBeGreaterThan(40);
	});

	it('skips obstacles without a top elevation', () => {
		expect(profileObstacleMarks(pts, cumNM, [ob(48.0, 2.5, null, 400)], 5)).toHaveLength(0);
	});

	it('sorts marks by along-track distance', () => {
		const marks = profileObstacleMarks(
			pts,
			cumNM,
			[ob(48.2, 3.0, 800, null), ob(48.0, 2.2, 700, null)],
			5,
		);
		expect(marks.map((m) => m.topFt)).toEqual([700, 800]);
	});

	it('returns nothing for a degenerate route or mismatched cumNM', () => {
		expect(profileObstacleMarks([pts[0]], [0], [ob(48, 2, 1000, null)], 5)).toHaveLength(0);
		expect(profileObstacleMarks(pts, [0, 40], [ob(48, 2.5, 1000, null)], 5)).toHaveLength(0);
	});
});

describe('legCorridorCells', () => {
	const a: LatLon = { lat: 48.0, lon: 2.0 };
	const b: LatLon = { lat: 48.5, lon: 2.5 };

	it('centres are exactly corridorSamplePoints (same grid)', () => {
		const centres = legCorridorCells(a, b, 5, 5, 2.5).map((c) => c.center);
		expect(centres).toEqual(corridorSamplePoints(a, b, 5, 5, 2.5));
	});

	it('gives each cell four corners whose centroid is its centre', () => {
		const cells = legCorridorCells(a, b, 5, 5, 2.5);
		expect(cells.length).toBeGreaterThan(0);
		for (const cell of cells) {
			expect(cell.corners).toHaveLength(4);
			const cLat = cell.corners.reduce((s, p) => s + p.lat, 0) / 4;
			const cLon = cell.corners.reduce((s, p) => s + p.lon, 0) / 4;
			expect(cLat).toBeCloseTo(cell.center.lat, 9);
			expect(cLon).toBeCloseTo(cell.center.lon, 9);
		}
	});

	it('builds non-degenerate cells on a real leg', () => {
		const cells = legCorridorCells(a, b, 5, 5, 2.5);
		const cell = cells[Math.floor(cells.length / 2)];
		const lats = cell.corners.map((p) => p.lat);
		const lons = cell.corners.map((p) => p.lon);
		expect(Math.max(...lats) - Math.min(...lats)).toBeGreaterThan(0);
		expect(Math.max(...lons) - Math.min(...lons)).toBeGreaterThan(0);
	});
});
