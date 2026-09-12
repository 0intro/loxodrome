import { describe, it, expect } from 'vitest';
import { computePolygonArea } from '$lib/notam';
import {
	bboxContainsLon,
	bboxIntersectsRing,
	bboxesOverlap,
	destinationPoint,
	equirectangularDistanceM,
	FIR_WIDE_RADIUS_NM,
	initialBearingDeg,
	M_PER_DEG,
	hasDrawnExtent,
	notamBbox,
	notamFocusBbox,
	sampleArcPoints,
	segmentCircleCrossings,
	segmentIntersectionT,
	segmentRingCrossings,
	tagArcCenter,
} from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import type { Notam, NotamCoordinate } from '$lib/notam/types';

describe('computePolygonArea', () => {
	it('should compute area of a unit square', () => {
		const coords = [
			{ lat: 0, lon: 0 },
			{ lat: 1, lon: 0 },
			{ lat: 1, lon: 1 },
			{ lat: 0, lon: 1 },
		];
		expect(computePolygonArea(coords)).toBeCloseTo(1.0, 2);
	});

	it('should return larger area for larger polygon', () => {
		const small = [
			{ lat: 0, lon: 0 }, { lat: 0.1, lon: 0 },
			{ lat: 0.1, lon: 0.1 }, { lat: 0, lon: 0.1 },
		];
		const large = [
			{ lat: 0, lon: 0 }, { lat: 1, lon: 0 },
			{ lat: 1, lon: 1 }, { lat: 0, lon: 1 },
		];
		expect(computePolygonArea(large) > computePolygonArea(small)).toBeTruthy();
	});
});

describe('destinationPoint', () => {
	const ONE_DEG_M = (6371000 * Math.PI) / 180;

	it('moves one arc-degree north and east from the equator', () => {
		const n = destinationPoint(0, 0, 0, ONE_DEG_M);
		expect(n.lat).toBeCloseTo(1, 6);
		expect(n.lon).toBeCloseTo(0, 6);
		const e = destinationPoint(0, 0, 90, ONE_DEG_M);
		expect(e.lat).toBeCloseTo(0, 6);
		expect(e.lon).toBeCloseTo(1, 6);
	});

	it('is the inverse of initialBearingDeg', () => {
		const from = { lat: 48.6, lon: 2.4 };
		const d = destinationPoint(from.lat, from.lon, 62, 6 * 1852);
		expect(initialBearingDeg(from.lat, from.lon, d.lat, d.lon)).toBeCloseTo(62, 4);
		const dist = equirectangularDistanceM(from.lat, from.lon, d.lat, d.lon);
		expect(dist).toBeGreaterThan(6 * 1852 * 0.99);
		expect(dist).toBeLessThan(6 * 1852 * 1.01);
	});
});

/* Antimeridian-straddling viewports keep a contiguous lon range past
 * +/-180 (viewportBbox's whole-world shift can also land both edges out
 * of frame, e.g. [-190, -170]); the wrap-aware tests must still find
 * dataset features stored in the standard [-180, 180] frame. */
describe('dateline-aware bbox tests', () => {
	const straddleEast = { minLat: -20, minLon: 170, maxLat: -10, maxLon: 190 };
	const straddleWest = { minLat: -20, minLon: -190, maxLat: -10, maxLon: -170 };

	it('bboxesOverlap matches far-side candidates for out-of-frame boxes', () => {
		const fiji = { minLat: -19, minLon: 177, maxLat: -16, maxLon: 180 };
		const samoa = { minLat: -15, minLon: -173, maxLat: -13, maxLon: -171 };
		expect(bboxesOverlap(straddleEast, fiji)).toBe(true);
		expect(bboxesOverlap(straddleEast, { ...samoa, minLat: -16, maxLat: -14 })).toBe(true);
		expect(bboxesOverlap(straddleWest, fiji)).toBe(true);
		// A far-away in-frame box still misses.
		expect(bboxesOverlap(straddleEast, { minLat: -20, minLon: 0, maxLat: -10, maxLon: 10 })).toBe(false);
	});

	it('keeps the plain planar test for two in-frame boxes', () => {
		// Boxes on opposite sides of the seam, both in frame: the planar
		// convention (dataset boxes never wrap) still reports no overlap.
		const west = { minLat: 0, minLon: -179, maxLat: 10, maxLon: -170 };
		const east = { minLat: 0, minLon: 170, maxLat: 10, maxLon: 179 };
		expect(bboxesOverlap(west, east)).toBe(false);
		expect(bboxesOverlap(east, { minLat: 0, minLon: 172, maxLat: 5, maxLon: 175 })).toBe(true);
	});

	it('bboxContainsLon lifts the candidate a world either way', () => {
		expect(bboxContainsLon(straddleEast, 178)).toBe(true);
		expect(bboxContainsLon(straddleEast, -178)).toBe(true);
		expect(bboxContainsLon(straddleEast, 0)).toBe(false);
		expect(bboxContainsLon(straddleWest, 178)).toBe(true);
		expect(bboxContainsLon(straddleWest, -178)).toBe(true);
		expect(bboxContainsLon({ minLat: 0, minLon: -10, maxLat: 1, maxLon: 10 }, 178)).toBe(false);
	});

	it('bboxIntersectsRing retries an out-of-frame box a world over', () => {
		const farSideRing: [number, number][] = [
			[-16, -175],
			[-16, -172],
			[-13, -172],
			[-13, -175],
		];
		expect(bboxIntersectsRing(straddleEast, farSideRing)).toBe(true);
		expect(bboxIntersectsRing(straddleWest, [
			[-16, 175],
			[-16, 178],
			[-13, 178],
			[-13, 175],
		])).toBe(true);
		expect(bboxIntersectsRing(straddleEast, [
			[-16, 0],
			[-16, 3],
			[-13, 3],
			[-13, 0],
		])).toBe(false);
	});
});

describe('equirectangularDistanceM across the antimeridian', () => {
	it('measures the short way across the dateline', () => {
		const d = equirectangularDistanceM(0, 179.5, 0, -179.5);
		// 1 degree of longitude at the equator, not 359.
		expect(d / 1852).toBeGreaterThan(55);
		expect(d / 1852).toBeLessThan(65);
	});

	it('keeps the in-range case bit-identical to the plain delta', () => {
		const lat1 = 48.1234, lon1 = 2.5678, lat2 = 48.9876, lon2 = 3.4321;
		const meanLatRad = (((lat1 + lat2) / 2) * Math.PI) / 180;
		const dLatM = (lat2 - lat1) * M_PER_DEG;
		const dLonM = (lon2 - lon1) * M_PER_DEG * Math.cos(meanLatRad);
		const plain = Math.sqrt(dLatM * dLatM + dLonM * dLonM);
		expect(equirectangularDistanceM(lat1, lon1, lat2, lon2)).toBe(plain);
	});
});

describe('segmentIntersectionT', () => {
	it('returns the parametric position of a strict crossing', () => {
		// p1-p2 runs west-east through lon 0.5; the edge runs south-north at
		// lon 0.5 offset so the crossing sits at t = 0.25 by construction.
		const t = segmentIntersectionT(
			{ lat: 0.5, lon: 0 },
			{ lat: 0.5, lon: 2 },
			{ lat: 0, lon: 0.5 },
			{ lat: 1, lon: 0.5 },
		);
		expect(t).toBeCloseTo(0.25, 12);
	});

	it('returns null for parallel and for endpoint-touching segments', () => {
		expect(segmentIntersectionT(
			{ lat: 0, lon: 0 },
			{ lat: 0, lon: 1 },
			{ lat: 1, lon: 0 },
			{ lat: 1, lon: 1 },
		)).toBeNull();
		// p2 lands exactly on the other segment: not a strict crossing.
		expect(segmentIntersectionT(
			{ lat: 0, lon: 0 },
			{ lat: 0.5, lon: 0.5 },
			{ lat: 0, lon: 1 },
			{ lat: 1, lon: 0 },
		)).toBeNull();
	});
});

describe('segmentRingCrossings', () => {
	// Unit square in [lat, lon], vertices (0,0) (0,1) (1,1) (1,0).
	const square: [number, number][] = [
		[0, 0],
		[0, 1],
		[1, 1],
		[1, 0],
	];

	it('reports entry and exit of a through-and-through pass, sorted', () => {
		const ts = segmentRingCrossings(0.5, -0.5, 0.5, 1.5, square);
		expect(ts).toHaveLength(2);
		expect(ts[0]).toBeCloseTo(0.25, 12);
		expect(ts[1]).toBeCloseTo(0.75, 12);
	});

	it('reports a single crossing for an entering segment', () => {
		const ts = segmentRingCrossings(0.5, -0.5, 0.5, 0.5, square);
		expect(ts).toHaveLength(1);
		expect(ts[0]).toBeCloseTo(0.5, 12);
	});

	it('keeps parametric positions at high latitude', () => {
		// The planar sign test is affine-invariant, so the compressed
		// longitude at 60 degrees north changes nothing about t.
		const north: [number, number][] = square.map(([la, lo]) => [la + 60, lo]);
		const ts = segmentRingCrossings(60.5, -0.5, 60.5, 1.5, north);
		expect(ts).toHaveLength(2);
		expect(ts[0]).toBeCloseTo(0.25, 12);
		expect(ts[1]).toBeCloseTo(0.75, 12);
	});

	it('yields no crossing for a vertex graze or an edge run (documented strictness)', () => {
		// Diagonal exactly through the (0, 0) corner.
		expect(segmentRingCrossings(-0.5, -0.5, 0.5, 0.5, square)).toHaveLength(0);
		// Collinear run along the lon 0 edge.
		expect(segmentRingCrossings(-0.5, 0, 1.5, 0, square)).toHaveLength(0);
	});

	it('reports two disjoint traversals of a concave ring in order', () => {
		// A U shape: the segment at lat 0.5 crosses four edges.
		const u: [number, number][] = [
			[0, 0],
			[0, 3],
			[1, 3],
			[1, 2],
			[0.25, 2],
			[0.25, 1],
			[1, 1],
			[1, 0],
		];
		const ts = segmentRingCrossings(0.5, -1, 0.5, 4, u);
		expect(ts).toHaveLength(4);
		expect(ts[0]).toBeCloseTo(0.2, 12);
		expect(ts[1]).toBeCloseTo(0.4, 12);
		expect(ts[2]).toBeCloseTo(0.6, 12);
		expect(ts[3]).toBeCloseTo(0.8, 12);
	});
});

describe('segmentCircleCrossings', () => {
	// One degree of latitude in metres under the planar model.
	const DEG_M = M_PER_DEG;

	it('reports entry and exit through the centre', () => {
		const ts = segmentCircleCrossings(0, -2, 0, 2, 0, 0, DEG_M);
		expect(ts).toHaveLength(2);
		expect(ts[0]).toBeCloseTo(0.25, 9);
		expect(ts[1]).toBeCloseTo(0.75, 9);
	});

	it('reports one crossing when the segment ends inside', () => {
		const ts = segmentCircleCrossings(0, -2, 0, 0, 0, 0, DEG_M);
		expect(ts).toHaveLength(1);
		expect(ts[0]).toBeCloseTo(0.5, 9);
	});

	it('yields none for a miss, a tangent, and a zero-length segment', () => {
		expect(segmentCircleCrossings(2, -2, 2, 2, 0, 0, DEG_M)).toHaveLength(0);
		expect(segmentCircleCrossings(1, -2, 1, 2, 0, 0, DEG_M)).toHaveLength(0);
		expect(segmentCircleCrossings(0.5, 0.5, 0.5, 0.5, 0, 0, DEG_M)).toHaveLength(0);
	});
});

function coord(
	type: 'psn' | 'qualifierLine',
	lat: number,
	lon: number,
	radius?: number,
): NotamCoordinate {
	return {
		lat,
		lon,
		original: '',
		type,
		...(radius != null ? { radius, radiusUnit: 'NM' as const } : {}),
	};
}

function entry(over: Partial<Notam>): Notam {
	return {
		id: 'A0001/26',
		icaoCodes: ['LFFF'],
		qCode: 'QWULW',
		isPolygon: false,
		coordinates: [],
		qualifier: null,
		...over,
	} as unknown as Notam;
}

/* notamFocusBbox is the extent the map frames when centring on one entry:
 * notamBbox minus the whole-FIR Q) sentinel, which marks a FIR-wide NOTAM
 * rather than a drawn area. */
describe('notamFocusBbox', () => {
	const PAD_10NM_DEG = (10 * NM_TO_METERS) / M_PER_DEG;

	it('pads a position by its own radius', () => {
		const b = notamFocusBbox(
			entry({ coordinates: [coord('psn', 48, 2, 10)] }),
		);
		expect(b?.maxLat).toBeCloseTo(48 + PAD_10NM_DEG, 6);
		expect(b?.minLat).toBeCloseTo(48 - PAD_10NM_DEG, 6);
		// Longitude degrees shrink with the cosine of the latitude.
		const padLon = PAD_10NM_DEG / Math.cos((48 * Math.PI) / 180);
		expect(b?.maxLon).toBeCloseTo(2 + padLon, 6);
	});

	it('takes a polygon entry as its raw vertices', () => {
		const b = notamFocusBbox(
			entry({
				isPolygon: true,
				coordinates: [
					coord('psn', 48, 2, 10),
					coord('psn', 49, 2),
					coord('psn', 49, 3),
				],
			}),
		);
		expect(b).toEqual({ minLat: 48, minLon: 2, maxLat: 49, maxLon: 3 });
	});

	it('frames a large-but-finite Q-line circle', () => {
		const b = notamFocusBbox(
			entry({ coordinates: [coord('qualifierLine', 48, 2, 400)] }),
		);
		expect(b?.maxLat).toBeCloseTo(48 + 40 * PAD_10NM_DEG, 6);
	});

	it('leaves the whole-FIR sentinel out, where notamBbox keeps it', () => {
		const n = entry({
			coordinates: [coord('qualifierLine', 48, 2, FIR_WIDE_RADIUS_NM)],
		});
		// A point box (the 1e-4 nudge): the map centres instead of framing.
		expect(notamFocusBbox(n)?.maxLat).toBeCloseTo(48 + 1e-4, 8);
		// The viewport fetch gate still reaches across the whole FIR.
		expect(notamBbox(n).maxLat).toBeCloseTo(48 + 99.9 * PAD_10NM_DEG, 6);
	});

	it('is null for an entry with no coordinates', () => {
		expect(notamFocusBbox(entry({}))).toBeNull();
	});
});

/* hasDrawnExtent says whether that box spans anything at all, which is what
 * decides how wide the map frames it (focusNotam in map/notamLayer.ts). */
describe('hasDrawnExtent', () => {
	it('is true for a ring', () => {
		expect(
			hasDrawnExtent(
				entry({
					isPolygon: true,
					coordinates: [
						coord('psn', 48, 2),
						coord('psn', 49, 2),
						coord('psn', 49, 3),
					],
				}),
			),
		).toBe(true);
	});

	it('is true for a position carrying a radius circle', () => {
		expect(
			hasDrawnExtent(entry({ coordinates: [coord('psn', 48, 2, 1)] })),
		).toBe(true);
		expect(
			hasDrawnExtent(entry({ coordinates: [coord('qualifierLine', 48, 2, 5)] })),
		).toBe(true);
	});

	it('is false for a bare position, an obstacle NOTAM as the SIA files it', () => {
		expect(hasDrawnExtent(entry({ coordinates: [coord('psn', 48, 2)] }))).toBe(
			false,
		);
	});

	it('is false for the whole-FIR sentinel, whose circle is not drawn', () => {
		expect(
			hasDrawnExtent(
				entry({
					coordinates: [coord('qualifierLine', 48, 2, FIR_WIDE_RADIUS_NM)],
				}),
			),
		).toBe(false);
	});

	it('follows the ring fallback: under three vertices is positions again', () => {
		// isPolygon with two vertices draws as positions, per isPolygonEntry.
		expect(
			hasDrawnExtent(
				entry({
					isPolygon: true,
					coordinates: [coord('psn', 48, 2), coord('psn', 49, 2)],
				}),
			),
		).toBe(false);
	});
});

describe('tagArcCenter', () => {
	const coord = () => ({ original: 'x', lat: 49, lon: 4, type: 'psn' as const });

	it('tags the English radius-first form, ARCUS included (R1129/26 EN)', () => {
		const c = coord();
		const e = '..., 0.8NM RADIUS CLOCKWISE ARCUS CENTRED ON 490801N 0042112E,';
		tagArcCenter(c, e, e.indexOf('490801N'));
		expect(c).toMatchObject({ arcRadius: 0.8, arcRadiusUnit: 'NM' });
		expect('arcCcw' in c && (c as { arcCcw?: boolean }).arcCcw).toBeFalsy();
	});

	it('tags the English arc-first form (R1841/26)', () => {
		const c = coord();
		const e = 'CLOCKWISE ARC OF A 4.6NM RADIUS CENTRED AT 492747N 0010708E';
		tagArcCenter(c, e, e.indexOf('492747N'));
		expect(c).toMatchObject({ arcRadius: 4.6, arcRadiusUnit: 'NM' });
	});

	it('flags REVERSE CLOCKWISE as anticlockwise (R1579/26)', () => {
		const c = coord();
		const e = '6NM RADIUS REVERSE CLOCKWISE ARC CENTERED OVER 455323N 0005905W';
		tagArcCenter(c, e, e.indexOf('455323N'));
		expect(c).toMatchObject({ arcRadius: 6, arcCcw: true });
	});

	it('still tags the French form, ANTI-HORAIRE mirrored', () => {
		const c = coord();
		const e = 'ARC ANTI-HORAIRE DE 5NM DE RAYON CENTRE SUR 490801N 0042112E';
		tagArcCenter(c, e, e.indexOf('490801N'));
		expect(c).toMatchObject({ arcRadius: 5, arcCcw: true });
	});
});

describe('sampleArcPoints direction', () => {
	// prev due east of the centre, next due north: the clockwise sweep runs
	// the long way round through the southern half; anticlockwise takes the
	// north-east quarter directly.
	const center = { lat: 49, lon: 4 };
	const prev = { lat: 49, lon: 4.1 };
	const next = { lat: 49.0655, lon: 4 };

	it('keeps an anticlockwise arc in the near quadrant', () => {
		const pts = sampleArcPoints(prev, center, next, 4, 'NM', true);
		expect(pts).toHaveLength(15);
		for (const p of pts) {
			expect(p.lat).toBeGreaterThanOrEqual(49 - 1e-6);
			expect(p.lon).toBeGreaterThanOrEqual(4 - 1e-6);
		}
	});

	it('sends the clockwise arc the long way round', () => {
		const pts = sampleArcPoints(prev, center, next, 4, 'NM');
		expect(pts).toHaveLength(15);
		expect(pts.some((p) => p.lat < 49)).toBe(true);
	});
});
