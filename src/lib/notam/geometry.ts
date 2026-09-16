import { NM_TO_METERS } from './units';
import { radiusToNM } from './radius';
import type { LatLon, Notam, NotamCoordinate, RadiusUnit } from './types';
import { pointInRing } from '$lib/data/airspaces';

/** Metres per degree of latitude, and metres per degree of longitude at the
 *  equator. Used wherever a quick planar approximation is good enough
 *  (NOTAM areas, obstacle proximity, viewport bbox padding). */
export const M_PER_DEG = 111320;

/** Axis-aligned bounding box in lat/lon degrees. */
export interface Bbox {
	minLat: number;
	minLon: number;
	maxLat: number;
	maxLon: number;
}

/** Bounding box of a [[lat, lon], …] ring (single pass min/max). */
export function ringBbox(ring: [number, number][]): Bbox {
	let minLat = Infinity;
	let minLon = Infinity;
	let maxLat = -Infinity;
	let maxLon = -Infinity;
	for (const [lat, lon] of ring) {
		if (lat < minLat) minLat = lat;
		if (lat > maxLat) maxLat = lat;
		if (lon < minLon) minLon = lon;
		if (lon > maxLon) maxLon = lon;
	}
	return { minLat, minLon, maxLat, maxLon };
}

/** True if the two boxes share any area (touching edges count). A box whose
 *  longitude range runs past +/-180 (an antimeridian-straddling viewport
 *  keeps its range contiguous, e.g. [170, 190] or [-190, -170]) also
 *  matches candidates stored on the far side of the seam in the standard
 *  [-180, 180] frame; two in-frame boxes keep the plain planar test. */
export function bboxesOverlap(a: Bbox, b: Bbox): boolean {
	if (a.minLat > b.maxLat || a.maxLat < b.minLat) {
		return false;
	}
	if (a.minLon <= b.maxLon && a.maxLon >= b.minLon) {
		return true;
	}
	if (a.maxLon > 180 || b.maxLon > 180) {
		if (a.minLon - 360 <= b.maxLon && a.maxLon - 360 >= b.minLon) {
			return true;
		}
		if (b.minLon - 360 <= a.maxLon && b.maxLon - 360 >= a.minLon) {
			return true;
		}
	}
	if (a.minLon < -180 || b.minLon < -180) {
		if (a.minLon + 360 <= b.maxLon && a.maxLon + 360 >= b.minLon) {
			return true;
		}
		if (b.minLon + 360 <= a.maxLon && b.maxLon + 360 >= a.minLon) {
			return true;
		}
	}
	return false;
}

/** True if `lon` (standard [-180, 180] frame) falls inside the box's
 *  longitude range, including when the box runs past +/-180: the candidate
 *  is also tested shifted a world either way. */
export function bboxContainsLon(box: Bbox, lon: number): boolean {
	return (
		(lon >= box.minLon && lon <= box.maxLon) ||
		(lon + 360 >= box.minLon && lon + 360 <= box.maxLon) ||
		(lon - 360 >= box.minLon && lon - 360 <= box.maxLon)
	);
}

/**
 * Polygon-polygon overlap test for two [[lat, lon], …] rings. Returns true if
 * either ring has a vertex inside the other or any pair of edges cross.
 * Approximate (no full polygon-clipping) but sufficient for aviation rings,
 * which are small and roughly convex.
 */
export function ringsOverlap(
	a: [number, number][],
	b: [number, number][],
): boolean {
	for (const [lat, lon] of a) {
		if (pointInRing(lat, lon, b)) {
			return true;
		}
	}
	for (const [lat, lon] of b) {
		if (pointInRing(lat, lon, a)) {
			return true;
		}
	}
	const na = a.length;
	const nb = b.length;
	for (let i = 0; i < na; i++) {
		const a1 = { lat: a[i][0], lon: a[i][1] };
		const a2 = { lat: a[(i + 1) % na][0], lon: a[(i + 1) % na][1] };
		for (let j = 0; j < nb; j++) {
			const b1 = { lat: b[j][0], lon: b[j][1] };
			const b2 = { lat: b[(j + 1) % nb][0], lon: b[(j + 1) % nb][1] };
			if (segmentsIntersect(a1, a2, b1, b2)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * True if an axis-aligned box overlaps a [[lat, lon], …] ring, tested against
 * the ring itself (via ringsOverlap on the box's 4 corners), not just the ring's
 * bounding box. So a box that clips only a lopsided ring's bounding rectangle
 * (e.g. the London FIR, whose Western-Approaches arm drops its bbox to ~48.8N
 * far from the polygon) is correctly rejected. Callers should still gate on the
 * cheap bboxesOverlap first; this is the exact follow-up.
 */
export function bboxIntersectsRing(box: Bbox, ring: [number, number][]): boolean {
	if (rectIntersectsRing(box, 0, ring)) {
		return true;
	}
	// An out-of-frame box (dateline-straddling viewport) retried a world
	// over, so rings stored in the standard [-180, 180] frame still hit.
	if (box.maxLon > 180 && rectIntersectsRing(box, -360, ring)) {
		return true;
	}
	return box.minLon < -180 && rectIntersectsRing(box, 360, ring);
}

function rectIntersectsRing(box: Bbox, lonShift: number, ring: [number, number][]): boolean {
	return ringsOverlap(
		[
			[box.minLat, box.minLon + lonShift],
			[box.minLat, box.maxLon + lonShift],
			[box.maxLat, box.maxLon + lonShift],
			[box.maxLat, box.minLon + lonShift],
		],
		ring,
	);
}

/**
 * True if a circle (lat/lon centre, radius in metres) overlaps the ring:
 * either the centre is inside, or some ring edge passes within the radius.
 * Uses cos(lat) longitude scaling; fine at the few-NM scale of NOTAM circles.
 */
export function pointCircleInRing(
	lat: number,
	lon: number,
	radiusM: number,
	ring: [number, number][],
): boolean {
	if (pointInRing(lat, lon, ring)) {
		return true;
	}
	if (radiusM <= 0) {
		return false;
	}
	for (let i = 0; i < ring.length; i++) {
		const j = (i + 1) % ring.length;
		const distM = pointToSegmentDistanceM(
			lat,
			lon,
			ring[i][0],
			ring[i][1],
			ring[j][0],
			ring[j][1],
		);
		if (distM <= radiusM) {
			return true;
		}
	}
	return false;
}

/** Test whether the segments (p1-p2) and (p3-p4) cross. */
export function segmentsIntersect(
	p1: LatLon,
	p2: LatLon,
	p3: LatLon,
	p4: LatLon,
): boolean {
	const d1 =
		(p4.lon - p3.lon) * (p1.lat - p3.lat) - (p4.lat - p3.lat) * (p1.lon - p3.lon);
	const d2 =
		(p4.lon - p3.lon) * (p2.lat - p3.lat) - (p4.lat - p3.lat) * (p2.lon - p3.lon);
	const d3 =
		(p2.lon - p1.lon) * (p3.lat - p1.lat) - (p2.lat - p1.lat) * (p3.lon - p1.lon);
	const d4 =
		(p2.lon - p1.lon) * (p4.lat - p1.lat) - (p2.lat - p1.lat) * (p4.lon - p1.lon);
	return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Parametric position t in (0, 1) along p1-p2 where it strictly crosses
 *  p3-p4, or null when the segments do not cross. Same planar sign test as
 *  segmentsIntersect; t is invariant under any affine scaling of the plane,
 *  so the unscaled lat/lon frame the sign test uses is exact for t too. */
export function segmentIntersectionT(
	p1: LatLon,
	p2: LatLon,
	p3: LatLon,
	p4: LatLon,
): number | null {
	const d1 =
		(p4.lon - p3.lon) * (p1.lat - p3.lat) - (p4.lat - p3.lat) * (p1.lon - p3.lon);
	const d2 =
		(p4.lon - p3.lon) * (p2.lat - p3.lat) - (p4.lat - p3.lat) * (p2.lon - p3.lon);
	const d3 =
		(p2.lon - p1.lon) * (p3.lat - p1.lat) - (p2.lat - p1.lat) * (p3.lon - p1.lon);
	const d4 =
		(p2.lon - p1.lon) * (p4.lat - p1.lat) - (p2.lat - p1.lat) * (p4.lon - p1.lon);
	if (d1 * d2 < 0 && d3 * d4 < 0) {
		return d1 / (d1 - d2);
	}
	return null;
}

/** Sorted parametric positions in (0, 1) along the segment a-b where it
 *  strictly crosses the ring's boundary, one per crossed edge. The live
 *  airspace-alert lookahead reads exact entry/exit chainage from these,
 *  where a 1 NM route sampler would step over a sliver. Crossings are the
 *  strict sign changes of segmentsIntersect: a graze through a vertex or a
 *  run along an edge contributes none, so consumers classify the intervals
 *  between crossings by midpoint containment (pointInRing), which stays
 *  correct in exactly those cases. */
export function segmentRingCrossings(
	aLat: number,
	aLon: number,
	bLat: number,
	bLon: number,
	ring: [number, number][],
): number[] {
	const a = { lat: aLat, lon: aLon };
	const b = { lat: bLat, lon: bLon };
	const ts: number[] = [];
	for (let i = 0; i < ring.length; i++) {
		const j = (i + 1) % ring.length;
		const t = segmentIntersectionT(
			a,
			b,
			{ lat: ring[i][0], lon: ring[i][1] },
			{ lat: ring[j][0], lon: ring[j][1] },
		);
		if (t !== null) {
			ts.push(t);
		}
	}
	ts.sort((x, y) => x - y);
	return ts;
}

/** Sorted parametric positions in (0, 1) along the segment a-b where it
 *  strictly crosses the circle boundary (centre cLat/cLon, radius in
 *  metres). Planar with cos(lat) longitude scaling around the centre, the
 *  pointToSegmentDistanceM convention; a tangent segment yields none, the
 *  ring primitive's strictness. */
export function segmentCircleCrossings(
	aLat: number,
	aLon: number,
	bLat: number,
	bLon: number,
	cLat: number,
	cLon: number,
	radiusM: number,
): number[] {
	if (radiusM <= 0) {
		return [];
	}
	const cosLat = Math.cos((cLat * Math.PI) / 180);
	const ax = (aLon - cLon) * cosLat * M_PER_DEG;
	const ay = (aLat - cLat) * M_PER_DEG;
	const bx = (bLon - cLon) * cosLat * M_PER_DEG;
	const by = (bLat - cLat) * M_PER_DEG;
	const dx = bx - ax;
	const dy = by - ay;
	const a2 = dx * dx + dy * dy;
	if (a2 === 0) {
		return [];
	}
	const b2 = 2 * (ax * dx + ay * dy);
	const c2 = ax * ax + ay * ay - radiusM * radiusM;
	const disc = b2 * b2 - 4 * a2 * c2;
	if (disc <= 0) {
		return [];
	}
	const sq = Math.sqrt(disc);
	const ts: number[] = [];
	for (const t of [(-b2 - sq) / (2 * a2), (-b2 + sq) / (2 * a2)]) {
		if (t > 0 && t < 1) {
			ts.push(t);
		}
	}
	return ts;
}

/** True if a polygon has any self-intersecting edges. */
export function isSelfIntersecting(coordinates: LatLon[]): boolean {
	const n = coordinates.length;
	for (let i = 0; i < n; i++) {
		for (let j = i + 2; j < n; j++) {
			if (i === 0 && j === n - 1) {
				continue; // adjacent (wrap-around)
			}
			if (
				segmentsIntersect(
					coordinates[i],
					coordinates[(i + 1) % n],
					coordinates[j],
					coordinates[(j + 1) % n],
				)
			) {
				return true;
			}
		}
	}
	return false;
}

/** Sort polygon vertices by angle from the centroid to form a simple polygon. */
export function makeSimplePolygon<T extends LatLon>(coordinates: T[]): T[] {
	const n = coordinates.length;
	const centroidLat = coordinates.reduce((s, c) => s + c.lat, 0) / n;
	const centroidLon = coordinates.reduce((s, c) => s + c.lon, 0) / n;
	return coordinates
		.slice()
		.sort(
			(a, b) =>
				Math.atan2(a.lat - centroidLat, a.lon - centroidLon) -
				Math.atan2(b.lat - centroidLat, b.lon - centroidLon),
		);
}

/** Approximate polygon area using the shoelace formula. */
export function computePolygonArea(coordinates: LatLon[]): number {
	let area = 0;
	const n = coordinates.length;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		area += coordinates[i].lat * coordinates[j].lon;
		area -= coordinates[j].lat * coordinates[i].lon;
	}
	return Math.abs(area) / 2;
}

/**
 * Mark a coord as an arc centre if it is immediately preceded in the E section
 * by an arc phrase naming its radius: the French "ARC [ANTI-]HORAIRE DE
 * <num><unit> DE RAYON CENTRE [SUR]", or the English forms in either order,
 * "<num><unit> RADIUS [REVERSE ]CLOCKWISE ARC CENTRED ON" and "CLOCKWISE ARC
 * OF A <num><unit> RADIUS CENTRED AT" (ARCUS, CENTERED and "REVERSE
 * CLOCKWISE" for anticlockwise are real corpus texts). The centre point is
 * not on the polygon boundary; the adjacent vertices sit on the arc; so
 * expandArcs() later replaces it with arc points.
 */
export function tagArcCenter(
	coord: NotamCoordinate,
	eContent: string,
	matchIndex: number,
): void {
	const before = eContent.substring(Math.max(0, matchIndex - 100), matchIndex);
	// Every pattern captures (ccw?)(value)(unit) or (value)(unit)(ccw?); the
	// numeric group identifies which order matched.
	const m =
		before.match(
			/\bARC\s+(ANTI[- ]?)?HORAIRE\s+DE\s+(\d+(?:[.,]\d+)?)\s*(NM|KM|METRES?|M)\s+DE\s+RAYON\s+CENTRE[E]?\s+SUR[\s,]*$/i,
		) ??
		before.match(
			/(\d+(?:[.,]\d+)?)\s*(NM|KM|METRES?|M)\s+RADIUS\s+((?:REVERSE|ANTI[- ]?|COUNTER[- ]?)\s*)?CLOCKWISE\s+ARC(?:US)?\s+CENT(?:ER|RE)E?D?\s+(?:ON|AT|OVER)[\s,]*$/i,
		) ??
		before.match(
			/\b((?:REVERSE|ANTI[- ]?|COUNTER[- ]?)\s*)?CLOCKWISE\s+ARC(?:US)?\s+OF\s+(?:AN?\s+)?(\d+(?:[.,]\d+)?)\s*(NM|KM|METRES?|M)\s+RADIUS\s+CENT(?:ER|RE)E?D?\s+(?:ON|AT|OVER)[\s,]*$/i,
		);
	if (!m) {
		return;
	}
	const numFirst = m[1] != null && /^[\d.,]+$/.test(m[1]);
	const value = numFirst ? m[1] : m[2];
	const unitRaw = numFirst ? m[2] : m[3];
	const ccw = Boolean(numFirst ? m[3] : m[1]);
	let unit = unitRaw.toUpperCase();
	if (unit === 'METRES' || unit === 'METRE') {
		unit = 'M';
	}
	coord.arcRadius = parseFloat(value.replace(',', '.'));
	coord.arcRadiusUnit = unit as RadiusUnit;
	if (ccw) {
		coord.arcCcw = true;
	}
	// The centre is not a position to draw a circle around; clear any radius
	// the local "X DE RAYON" pattern may have attached.
	delete coord.radius;
	delete coord.radiusUnit;
}

/**
 * Sample 15 intermediate points along the arc from `prev` to `next`, centred
 * on `center`; clockwise unless `ccw`. Endpoints are not duplicated. Planar
 * approximation, fine at the few-NM scale of French ZRT arcs.
 */
export function sampleArcPoints(
	prev: LatLon,
	center: LatLon,
	next: LatLon,
	radius: number,
	unit: RadiusUnit,
	ccw = false,
): NotamCoordinate[] {
	const r = radius * (unit === 'NM' ? NM_TO_METERS : unit === 'KM' ? 1000 : 1);
	const cosLat = Math.cos((center.lat * Math.PI) / 180);
	const t1 = Math.atan2(prev.lat - center.lat, (prev.lon - center.lon) * cosLat);
	const t2 = Math.atan2(next.lat - center.lat, (next.lon - center.lon) * cosLat);
	// HORAIRE = clockwise. atan2 is CCW-positive, so a clockwise sweep is
	// modelled as a positive (t1 - t2) wrapping into (0, 2π]; anticlockwise
	// ("REVERSE CLOCKWISE ARC") is the mirror.
	let sweep = ccw ? t2 - t1 : t1 - t2;
	while (sweep <= 0) {
		sweep += 2 * Math.PI;
	}
	const k = 16;
	const out: NotamCoordinate[] = [];
	for (let i = 1; i < k; i++) {
		const angle = ccw ? t1 + sweep * (i / k) : t1 - sweep * (i / k);
		out.push({
			original: 'arc',
			lat: center.lat + (Math.sin(angle) * r) / M_PER_DEG,
			lon: center.lon + (Math.cos(angle) * r) / (cosLat * M_PER_DEG),
			type: 'psn',
		});
	}
	return out;
}

/**
 * Replace any arc-centre coord in a polygon vertex list with sampled arc
 * points. For closed polygons the prev/next of the first/last arc centre wraps
 * around through the closure.
 */
export function expandArcs(coords: NotamCoordinate[]): NotamCoordinate[] {
	if (!coords.some((c) => c.arcRadius != null)) {
		return coords;
	}
	const n = coords.length;
	const out: NotamCoordinate[] = [];
	for (let i = 0; i < n; i++) {
		const c = coords[i];
		if (c.arcRadius == null) {
			out.push(c);
			continue;
		}
		const prev = coords[(i - 1 + n) % n];
		const next = coords[(i + 1) % n];
		out.push(
			...sampleArcPoints(
				prev,
				c,
				next,
				c.arcRadius,
				c.arcRadiusUnit ?? 'NM',
				c.arcCcw ?? false,
			),
		);
	}
	return out;
}

/**
 * Normalise polygon longitudes so consecutive vertices never jump more than
 * 180°. Fixes rendering of polygons that cross the antimeridian (±180°).
 */
export function normalizePolygonLongitudes(coordinates: LatLon[]): void {
	for (let i = 1; i < coordinates.length; i++) {
		while (coordinates[i].lon - coordinates[i - 1].lon > 180) {
			coordinates[i].lon -= 360;
		}
		while (coordinates[i].lon - coordinates[i - 1].lon < -180) {
			coordinates[i].lon += 360;
		}
	}
}

/** Equirectangular distance approximation in metres. Good to ~0.5% over the
 *  few-NM scales used in NOTAM proximity checks and obstacle linking. */
export function equirectangularDistanceM(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
): number {
	const meanLatRad = (((lat1 + lat2) / 2) * Math.PI) / 180;
	const dLatM = (lat2 - lat1) * M_PER_DEG;
	// Wrap the longitude delta into [-180, 180] so a leg crossing the
	// antimeridian measures the short way; the guard keeps the in-range
	// case bit-identical (a blanket modulo would wobble the last ulp).
	let dLonDeg = lon2 - lon1;
	if (dLonDeg > 180 || dLonDeg < -180) {
		dLonDeg = ((dLonDeg + 540) % 360) - 180;
	}
	const dLonM = dLonDeg * M_PER_DEG * Math.cos(meanLatRad);
	return Math.sqrt(dLatM * dLatM + dLonM * dLonM);
}

/** Great-circle initial bearing from (lat1, lon1) to (lat2, lon2) in degrees
 *  true, normalised to [0, 360). Returns 0 for coincident points. */
export function initialBearingDeg(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
): number {
	const lat1Rad = (lat1 * Math.PI) / 180;
	const lat2Rad = (lat2 * Math.PI) / 180;
	const dLonRad = ((lon2 - lon1) * Math.PI) / 180;
	const y = Math.sin(dLonRad) * Math.cos(lat2Rad);
	const x =
		Math.cos(lat1Rad) * Math.sin(lat2Rad) -
		Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLonRad);
	if (x === 0 && y === 0) {
		return 0;
	}
	return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Earth mean radius in metres (sphere); matches internal/geodesy. */
const EARTH_RADIUS_M = 6371000;

/** Destination point reached from (lat, lon) by travelling distanceM metres along
 *  the great circle on initial true bearing bearingDeg. The spherical direct
 *  geodesic, inverse of initialBearingDeg. Output lon normalised to [-180, 180). */
export function destinationPoint(
	lat: number,
	lon: number,
	bearingDeg: number,
	distanceM: number,
): LatLon {
	const d = distanceM / EARTH_RADIUS_M;
	const brng = (bearingDeg * Math.PI) / 180;
	const lat1 = (lat * Math.PI) / 180;
	const lon1 = (lon * Math.PI) / 180;
	const sinLat2 =
		Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng);
	const lat2 = Math.asin(sinLat2);
	const y = Math.sin(brng) * Math.sin(d) * Math.cos(lat1);
	const x = Math.cos(d) - Math.sin(lat1) * sinLat2;
	const lon2 = lon1 + Math.atan2(y, x);
	return {
		lat: (lat2 * 180) / Math.PI,
		lon: ((((lon2 * 180) / Math.PI + 540) % 360) - 180),
	};
}

/** Distance in metres from point P to the segment A-B, using cos(lat)
 *  longitude scaling (planar; fine at the few-NM scales used here). Shared by
 *  pointCircleInRing and the route corridor / airspace-traversal helpers. */
export function pointToSegmentDistanceM(
	pLat: number,
	pLon: number,
	aLat: number,
	aLon: number,
	bLat: number,
	bLon: number,
): number {
	const cosLat = Math.cos((pLat * Math.PI) / 180);
	const ax = (aLon - pLon) * cosLat;
	const ay = aLat - pLat;
	const bx = (bLon - pLon) * cosLat;
	const by = bLat - pLat;
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
	const cx = ax + t * dx;
	const cy = ay + t * dy;
	return Math.sqrt(cx * cx + cy * cy) * M_PER_DEG;
}

/** Minimum distance in metres from point P to a [{lat, lon}, …] polyline
 *  (over its consecutive segments). Infinity for a polyline of < 2 points. */
export function pointToPolylineDistanceM(
	pLat: number,
	pLon: number,
	polyline: { lat: number; lon: number }[],
): number {
	let min = Infinity;
	for (let i = 0; i + 1 < polyline.length; i++) {
		const d = pointToSegmentDistanceM(
			pLat,
			pLon,
			polyline[i].lat,
			polyline[i].lon,
			polyline[i + 1].lat,
			polyline[i + 1].lon,
		);
		if (d < min) {
			min = d;
		}
	}
	return min;
}

/** Approximate polygon area in m²; the shoelace deg² area scaled by
 *  cos(meanLat). Used to sort features smallest-first so per-layer click
 *  resolution lands on the smallest containing feature. */
export function polygonAreaM2(coords: LatLon[]): number {
	const degArea = computePolygonArea(coords);
	const meanLat = coords.reduce((s, c) => s + c.lat, 0) / coords.length;
	return degArea * M_PER_DEG * M_PER_DEG * Math.cos((meanLat * Math.PI) / 180);
}

/** ICAO Doc 10066 sentinel: a Q) radius of 999 NM means "the whole FIR". */
export const FIR_WIDE_RADIUS_NM = 999;

/** True for a Q-line-fallback entry with no real lateral extent: a single
 *  qualifier coordinate whose radius is the whole-FIR sentinel (>= 999) or
 *  absent. A 400 NM GNSS-outage circle stays a circle. The radius compares
 *  raw against a sentinel in NM, which the `qualifierLine` guard makes safe:
 *  the parser always tags those coordinates 'NM'. */
export function isFirWideEntry(n: Notam): boolean {
	if (n.isPolygon || n.coordinates.length !== 1) {
		return false;
	}
	const c = n.coordinates[0];
	return (
		c.type === 'qualifierLine' &&
		(c.radius == null || c.radius >= FIR_WIDE_RADIUS_NM)
	);
}

/** A NOTAM entry drawn as a ring rather than as positions + circles: the
 *  parser splits multi-area NOTAMs into one entry per ring, and an
 *  isPolygon entry short of three vertices falls back to positions. */
function isPolygonEntry(notam: Notam): boolean {
	return notam.isPolygon && notam.coordinates.length >= 3;
}

/** Bounding box of a coordinate list, each vertex expanded by its own radius
 *  when `padRadius`. A degenerate (single-point, no-radius) box is nudged out
 *  so bbox edge-equality doesn't bite. */
function coordsBbox(coords: NotamCoordinate[], padRadius: boolean): Bbox {
	let minLat = Infinity;
	let minLon = Infinity;
	let maxLat = -Infinity;
	let maxLon = -Infinity;
	for (const c of coords) {
		let padLat = 0;
		let padLon = 0;
		if (padRadius && c.radius != null && c.radiusUnit) {
			const rM = radiusToNM(c.radius, c.radiusUnit) * NM_TO_METERS;
			const cosLat = Math.cos((c.lat * Math.PI) / 180) || 1;
			padLat = rM / M_PER_DEG;
			padLon = rM / (M_PER_DEG * cosLat);
		}
		if (c.lat - padLat < minLat) minLat = c.lat - padLat;
		if (c.lat + padLat > maxLat) maxLat = c.lat + padLat;
		if (c.lon - padLon < minLon) minLon = c.lon - padLon;
		if (c.lon + padLon > maxLon) maxLon = c.lon + padLon;
	}
	if (minLat === maxLat && minLon === maxLon) {
		minLat -= 1e-4;
		maxLat += 1e-4;
		minLon -= 1e-4;
		maxLon += 1e-4;
	}
	return { minLat, minLon, maxLat, maxLon };
}

/** Radius-padded bounding box of a NOTAM. Polygon NOTAMs use raw vertices;
 *  point-plus-radius NOTAMs expand each vertex by its radius so a bbox
 *  pre-filter never rejects a circle that reaches into a neighbouring
 *  airspace, the whole-FIR sentinel included: notamIntersectsBbox below
 *  keeps a FIR-wide NOTAM whose radius covers the viewport. */
export function notamBbox(notam: Notam): Bbox {
	return coordsBbox(notam.coordinates, !isPolygonEntry(notam));
}

/** The extent a map frames when centring on one NOTAM entry: notamBbox with
 *  the whole-FIR Q) sentinel contributing NO radius, since it marks a
 *  FIR-wide NOTAM rather than a drawn area and framing it would throw the
 *  map to a continental view. Null for an entry with no coordinates, whose
 *  empty box would project to NaN. */
export function notamFocusBbox(notam: Notam): Bbox | null {
	if (notam.coordinates.length === 0) {
		return null;
	}
	return coordsBbox(
		notam.coordinates,
		!isPolygonEntry(notam) && !isFirWideEntry(notam),
	);
}

/** True when that focus bbox spans something the map draws: a polygon ring,
 *  or a position carrying a radius circle. False for an entry that is
 *  nothing but its pin(s), whose box is the bare point coordsBbox nudges
 *  open, so a fit lands on its cap rather than on any extent; the caller
 *  frames those wider (focusNotam in map/notamLayer.ts). The guards mirror
 *  notamFocusBbox's own, in the same order: the whole-FIR sentinel's 999 NM
 *  is not padded there and must not read as a drawn circle here. */
export function hasDrawnExtent(notam: Notam): boolean {
	if (isPolygonEntry(notam)) {
		return true;
	}
	if (isFirWideEntry(notam)) {
		return false;
	}
	return notam.coordinates.some(
		(c) => c.radius != null && c.radiusUnit != null,
	);
}

/** True iff the NOTAM's (radius-padded) area of effect reaches into `bbox`.
 *  A viewport fetch pulls in every FIR overlapping the view, and each FIR
 *  returns NOTAMs spread across its whole extent; this is the test the
 *  display filter uses to keep only the ones whose drawn area actually
 *  reaches the fetched viewport (see visibleNotams in
 *  state/notam.svelte.ts). A genuinely FIR-wide NOTAM whose radius still
 *  covers the viewport is kept; a point or polygon sitting far outside is
 *  dropped. */
export function notamIntersectsBbox(notam: Notam, bbox: Bbox): boolean {
	return bboxesOverlap(notamBbox(notam), bbox);
}

/** Rough drawn area of a NOTAM in m². Polygons get their shoelace area;
 *  point-plus-radius NOTAMs return the smallest circle's area. Q-line
 *  radius circles are excluded. Returns Infinity for NOTAMs with no
 *  drawable area (defensive; callers usually pre-filter via
 *  notamContainsPoint). */
export function notamAreaSize(notam: Notam): number {
	if (isPolygonEntry(notam)) {
		return polygonAreaM2(notam.coordinates);
	}
	let smallest = Infinity;
	for (const c of notam.coordinates) {
		if (c.radius == null || !c.radiusUnit || c.type === 'qualifierLine') {
			continue;
		}
		const rM = radiusToNM(c.radius, c.radiusUnit) * NM_TO_METERS;
		const a = Math.PI * rM * rM;
		if (a < smallest) {
			smallest = a;
		}
	}
	return smallest;
}

/** True iff (lat, lon) is inside the NOTAM's drawn area. Polygons use
 *  pointInRing; point-plus-radius NOTAMs use Euclidean distance against
 *  the radius. Q-line radius circles are excluded; they only render when
 *  selected and would otherwise blanket the map with thousands of
 *  square-km hits. */
export function notamContainsPoint(
	notam: Notam,
	lat: number,
	lon: number,
): boolean {
	if (isPolygonEntry(notam)) {
		const ring = notam.coordinates.map(
			(c) => [c.lat, c.lon] as [number, number],
		);
		return pointInRing(lat, lon, ring);
	}
	for (const c of notam.coordinates) {
		if (c.radius == null || !c.radiusUnit || c.type === 'qualifierLine') {
			continue;
		}
		const rM = radiusToNM(c.radius, c.radiusUnit) * NM_TO_METERS;
		const cosLat = Math.cos((c.lat * Math.PI) / 180) || 1;
		const dy = (lat - c.lat) * M_PER_DEG;
		const dx = (lon - c.lon) * M_PER_DEG * cosLat;
		if (dx * dx + dy * dy <= rM * rM) {
			return true;
		}
	}
	return false;
}
