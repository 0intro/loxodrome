/* Route-corridor NOTAM relevance: the pure geometry behind the "Show only
 * route NOTAMs" filter. Generalises the autorouter fetch's selection
 * (airports within corridorRadiusNM of the polyline + FIRs around it,
 * autorouter/viewport.ts) into an exact lateral test of every parsed NOTAM
 * geometry, so it also works on a pasted continent-wide briefing:
 *
 *  - polygon entries: does the corridor (every point within halfWidth of the
 *    route polyline) intersect the ring;
 *  - position / circle entries (PSN + RADIUS / RAYON, Q-line centre):
 *    distance(centre, polyline) <= halfWidth + radius;
 *  - FIR-wide entries (Q) radius 999, the ICAO whole-FIR sentinel, or no
 *    radius at all): per the pluggable FirWideRule; the default crosses the
 *    NOTAM's own FIR polygons against the corridor and FAILS OPEN when the
 *    FIR is unknown ("never hide a NOTAM on absence of a qualifier").
 *
 * Exact, not sampled: a 1 NM route sampler can step over a skinny ring, and
 * hiding a NOTAM on a sampling miss is not acceptable. The decomposition in
 * corridorIntersectsRing is complete under the planar cos(lat) approximation
 * every other proximity test here uses: a polyline touching the ring's
 * interior either has an endpoint inside (1) or crosses the boundary (2);
 * otherwise the sets are disjoint and their minimum distance is attained at
 * a vertex of one against a segment of the other (3 + 4).
 *
 * Lateral-only by design; the global altitude filter composes for the
 * vertical dimension. If a per-leg vertical test is ever wanted, it slots in
 * per route right before entryOnCorridor (keep an entry when its Q) lower
 * band starts below the route's highest planned leg altitude).
 *
 * Kept free of Svelte so it is unit-testable in Node; the reactive wrapper
 * lives in state/notamCorridor.svelte.ts. */

import { firIdent, pointInRing, type Airspace } from '$lib/data/airspaces';
import {
	M_PER_DEG,
	bboxesOverlap,
	isFirWideEntry,
	notamBbox,
	pointToPolylineDistanceM,
	pointToSegmentDistanceM,
	segmentsIntersect,
	type Bbox,
} from '$lib/notam/geometry';
import { radiusToNM } from '$lib/notam/radius';
import { NM_TO_METERS } from '$lib/notam/units';
import type { LatLon, Notam } from '$lib/notam/types';

/** How a FIR-wide entry passes the filter: 'fir-cross' keeps it iff the
 *  corridor crosses one of the NOTAM's own FIR polygons (unknown FIR keeps
 *  it), 'include' never hides FIR-wide NOTAMs, 'exclude' always does. */
export type FirWideRule = 'fir-cross' | 'include' | 'exclude';

export interface CorridorOptions {
	/** Corridor half-width, NM each side of the route polyline. */
	halfWidthNM: number;
	firWideRule: FirWideRule;
	/** Loaded airspace rows (FIR rings resolved via firIdent); null before
	 *  the dataset loads, which fails open for FIR-wide entries. */
	airspaces: Airspace[] | null;
	/** Airport index for entries with no geometry at all; null before load
	 *  (fails open). The parser currently always emits coordinates, so this
	 *  path is defensive. */
	lookupAirport: ((ident: string) => LatLon | null) | null;
}

/** Axis-aligned bounding box of the route polyline, padded by the corridor
 *  half-width (radiusNM) on every side. Null for a route of fewer than 2
 *  waypoints. Lives here (not in autorouter/viewport.ts, which re-exports
 *  it) so the pure route-math modules can use it without pulling in map
 *  state. */
export function routeCorridorBbox(
	waypoints: { lat: number; lon: number }[],
	radiusNM: number,
): Bbox | null {
	if (waypoints.length < 2) {
		return null;
	}
	let minLat = Infinity;
	let minLon = Infinity;
	let maxLat = -Infinity;
	let maxLon = -Infinity;
	for (const w of waypoints) {
		if (w.lat < minLat) minLat = w.lat;
		if (w.lat > maxLat) maxLat = w.lat;
		if (w.lon < minLon) minLon = w.lon;
		if (w.lon > maxLon) maxLon = w.lon;
	}
	const padLat = (radiusNM * NM_TO_METERS) / M_PER_DEG;
	const cosLat = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180) || 1;
	const padLon = padLat / cosLat;
	return {
		minLat: minLat - padLat,
		maxLat: maxLat + padLat,
		minLon: minLon - padLon,
		maxLon: maxLon + padLon,
	};
}

/** Exact lateral test: does the corridor (all points within halfWidthM of
 *  the waypoint polyline) intersect the ring? See the module header for the
 *  completeness argument behind the four branches. */
export function corridorIntersectsRing(
	waypoints: LatLon[],
	halfWidthM: number,
	ring: [number, number][],
): boolean {
	if (waypoints.length < 2 || ring.length < 3) {
		return false;
	}
	// 1. A route waypoint inside the ring (covers rings enclosing the route).
	for (const w of waypoints) {
		if (pointInRing(w.lat, w.lon, ring)) {
			return true;
		}
	}
	// 3. A ring vertex within the corridor half-width of the polyline.
	for (const [lat, lon] of ring) {
		if (pointToPolylineDistanceM(lat, lon, waypoints) <= halfWidthM) {
			return true;
		}
	}
	const n = ring.length;
	for (let i = 0; i < n; i++) {
		const a = { lat: ring[i][0], lon: ring[i][1] };
		const b = { lat: ring[(i + 1) % n][0], lon: ring[(i + 1) % n][1] };
		for (let j = 0; j + 1 < waypoints.length; j++) {
			// 2. A ring edge crossing a route segment (catches a skinny ring
			// slicing between two distant waypoints).
			if (segmentsIntersect(a, b, waypoints[j], waypoints[j + 1])) {
				return true;
			}
		}
		// 4. A route waypoint within the half-width of a ring edge (the
		// nearest approach lands mid-edge against a route vertex).
		for (const w of waypoints) {
			if (
				pointToSegmentDistanceM(w.lat, w.lon, a.lat, a.lon, b.lat, b.lon) <=
				halfWidthM
			) {
				return true;
			}
		}
	}
	return false;
}

/** Exact circle test: the circle meets the corridor iff its centre is within
 *  halfWidth + radius of the polyline. The radius-0 case is precisely the
 *  fetch's airport selection (routeAirportIdents). */
export function corridorIntersectsCircle(
	waypoints: LatLon[],
	halfWidthM: number,
	lat: number,
	lon: number,
	radiusM: number,
): boolean {
	return pointToPolylineDistanceM(lat, lon, waypoints) <= halfWidthM + radiusM;
}

/** Real-geometry lateral test of one entry against one route: the polygon
 *  ring, or each position / Q-line coordinate as a circle (a radius-less PSN
 *  is a point). Mirrors the per-coordinate map draw, so what the filter
 *  keeps is what the map shows. The Q) circle is used as-is here, unlike the
 *  panel-link tolerance (QLINE_TOLERANCE_M in notamLinks): "is this NOTAM
 *  relevant to my route" wants the inclusive published radius, consistent
 *  with the notamIntersectsBbox fetch gate. */
export function entryOnCorridor(
	n: Notam,
	waypoints: LatLon[],
	halfWidthM: number,
): boolean {
	if (n.isPolygon && n.coordinates.length >= 3) {
		const ring = n.coordinates.map((c) => [c.lat, c.lon] as [number, number]);
		return corridorIntersectsRing(waypoints, halfWidthM, ring);
	}
	for (const c of n.coordinates) {
		const radiusM =
			c.radius != null && c.radiusUnit
				? radiusToNM(c.radius, c.radiusUnit) * NM_TO_METERS
				: 0;
		if (corridorIntersectsCircle(waypoints, halfWidthM, c.lat, c.lon, radiusM)) {
			return true;
		}
	}
	return false;
}

/** Ids of the source NOTAMs relevant to ANY route's corridor. Per-id
 *  semantics: one on-corridor entry passes every entry sharing its id, so a
 *  multi-area NOTAM draws whole and the panels (which dedupe by id) agree
 *  with the map. Routes shorter than 2 waypoints are ignored; with no usable
 *  route the set is empty (the caller treats the filter as inert instead). */
export function corridorNotamIds(
	notams: Notam[],
	routes: LatLon[][],
	opts: CorridorOptions,
): Set<string> {
	const ids = new Set<string>();
	const halfWidthM = opts.halfWidthNM * NM_TO_METERS;
	const routesData: { wps: LatLon[]; bbox: Bbox }[] = [];
	for (const wps of routes) {
		const bbox = routeCorridorBbox(wps, opts.halfWidthNM);
		if (bbox) {
			routesData.push({ wps, bbox });
		}
	}
	if (routesData.length === 0) {
		return ids;
	}

	// FIR rows by ICAO indicator, built lazily: only FIR-wide / no-geometry
	// entries need it. firIdent absorbs the suffixed national ids (EGTT001).
	let firRows: Map<string, Airspace[]> | null = null;
	const firIndex = (): Map<string, Airspace[]> => {
		if (!firRows) {
			firRows = new Map();
			for (const a of opts.airspaces ?? []) {
				const ident = firIdent(a);
				if (!ident) {
					continue;
				}
				const arr = firRows.get(ident);
				if (arr) {
					arr.push(a);
				} else {
					firRows.set(ident, [a]);
				}
			}
		}
		return firRows;
	};

	// Whether the corridor crosses the FIR answering to `ident`: true / false
	// when rows exist, null when the ident matches no loaded FIR. Memoised
	// per call, so 10k FIR-wide entries over a continent cost a few dozen
	// ring tests, not thousands.
	const firCrossCache = new Map<string, boolean>();
	const firCrossed = (ident: string): boolean | null => {
		const rows = firIndex().get(ident);
		if (!rows) {
			return null;
		}
		const cached = firCrossCache.get(ident);
		if (cached !== undefined) {
			return cached;
		}
		let hit = false;
		outer: for (const a of rows) {
			for (const r of routesData) {
				if (
					bboxesOverlap(a.bbox, r.bbox) &&
					corridorIntersectsRing(r.wps, halfWidthM, a.ring)
				) {
					hit = true;
					break outer;
				}
			}
		}
		firCrossCache.set(ident, hit);
		return hit;
	};

	const firWidePasses = (n: Notam): boolean => {
		if (opts.firWideRule === 'include') {
			return true;
		}
		if (opts.firWideRule === 'exclude') {
			return false;
		}
		if (!opts.airspaces) {
			return true; // dataset not loaded yet: fail open
		}
		// Candidate indicators: the Q) FIR plus every A) ident (multi-FIR
		// NOTAMs list each FIR; the Q) field may be the LFXX placeholder).
		let known = false;
		const seen = new Set<string>();
		const candidates = [n.qualifier?.fir ?? '', ...n.icaoCodes];
		for (const raw of candidates) {
			const ident = raw.toUpperCase();
			if (!ident || seen.has(ident)) {
				continue;
			}
			seen.add(ident);
			const crossed = firCrossed(ident);
			if (crossed === true) {
				return true;
			}
			if (crossed === false) {
				known = true;
			}
		}
		// Every known FIR missed, or none resolved at all: hide only in the
		// former case; an unresolvable NOTAM is kept rather than hidden on
		// absent data.
		return !known;
	};

	// Defensive: entries without any coordinate cannot currently be produced
	// by the parser, but cost one branch to handle via their A) idents.
	const noGeometryPasses = (n: Notam): boolean => {
		let known = false;
		for (const raw of n.icaoCodes) {
			const ident = raw.toUpperCase();
			const pos = opts.lookupAirport?.(ident) ?? null;
			if (pos) {
				known = true;
				for (const r of routesData) {
					if (corridorIntersectsCircle(r.wps, halfWidthM, pos.lat, pos.lon, 0)) {
						return true;
					}
				}
			}
			if (opts.airspaces) {
				const crossed = firCrossed(ident);
				if (crossed === true) {
					return true;
				}
				if (crossed === false) {
					known = true;
				}
			}
		}
		return !known;
	};

	for (const n of notams) {
		if (ids.has(n.id)) {
			continue;
		}
		let pass: boolean;
		if (n.coordinates.length === 0) {
			pass = noGeometryPasses(n);
		} else if (isFirWideEntry(n)) {
			pass = firWidePasses(n);
		} else {
			pass = false;
			const bb = notamBbox(n);
			for (const r of routesData) {
				if (bboxesOverlap(bb, r.bbox) && entryOnCorridor(n, r.wps, halfWidthM)) {
					pass = true;
					break;
				}
			}
		}
		if (pass) {
			ids.add(n.id);
		}
	}
	return ids;
}
