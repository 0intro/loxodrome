/* Pure adapter: a recorded GPS trace -> a draw-ready vertical-profile doc,
 * reusing the route-profile pipeline (buildBands + the PlacedBand / AltitudePath
 * / ProfileWaypoint types) and the airspace corridor walk. The trace's recorded
 * altitude is drawn directly (bypassing the route's synthesised climb / cruise /
 * descent path), and nearby airports / navaids / VFR reporting points plus the
 * active route's own waypoints are surfaced as "features flown over". No Svelte,
 * no I/O; unit-tested in tests/navTraceProfile.spec.ts.
 *
 * thinTrace is the single source of X coordinates: it decimates the raw trace by
 * arc length and everything downstream (terrain, airspace bands, altitude line,
 * feature placement) measures distance over the SAME thinned polyline with the
 * same equirectangularDistanceM, so every X axis lines up. A raw multi-thousand
 * point trace MUST be thinned before it reaches any sampler (sampleProfile emits
 * at least one tile read per input leg). */

import { equirectangularDistanceM, M_PER_DEG } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import { computeAirspaceCorridorSpans, type AirspaceCorridorBand } from '$lib/route/airspaces';
import { buildBands, type AltitudePath, type PlacedBand, type ProfileWaypoint } from '$lib/route/routeProfile';
import type { Airspace } from '$lib/data/airspaces';
import type { TerrainSample } from '$lib/map/terrain';
import type { Airport } from '$lib/data/airports';
import type { Navaid, NavaidType } from '$lib/data/navaids';
import type { Waypoint } from '$lib/state/route.svelte';
import type { TrackPoint } from './trace';

/** A trace vertex carrying its cumulative along-track distance (NM). */
export interface ThinnedPoint {
	lat: number;
	lon: number;
	altFt: number | null;
	timeMs: number;
	cumNM: number;
}

/** One (timeMs, cumNM) pair; both monotonic non-decreasing, so replay time maps
 *  to a distance and back. */
export interface TimelinePoint {
	timeMs: number;
	cumNM: number;
}

export interface TraceProfileDoc {
	altitudePath: AltitudePath;
	corridorBands: AirspaceCorridorBand[];
	placedBands: PlacedBand[];
	features: ProfileWaypoint[];
	/** Index-parallel to `features`: the identity each label navigates to. */
	featureRefs: TraceFeatureRef[];
	totalNM: number;
	fitCeilingFt: number;
	timeline: TimelinePoint[];
}

export interface TraceProfileInput {
	thinned: ThinnedPoint[];
	airspaces: Airspace[] | null;
	terrain: TerrainSample[];
	/** The active route's waypoints, labelled as features flown over; null when
	 *  no route is planned. */
	route: Waypoint[] | null;
	airports: Airport[] | null;
	navaids: Navaid[] | null;
	typeLabels: Record<string, string>;
}

/** Closest-approach radius (NM) per feature kind. */
const AIRPORT_RADIUS_NM = 3;
const VFR_RADIUS_NM = 1.5;
const NAVAID_RADIUS_NM = 2;
const ROUTE_RADIUS_NM = 2;

/** Navaid types worth labelling (RNAV WAYPOINT and the ILS/DME family are
 *  omitted as clutter). */
const FEATURE_NAVAID_TYPES: ReadonlySet<NavaidType> = new Set<NavaidType>([
	'VOR',
	'VOR-DME',
	'VORTAC',
	'NDB',
	'VFR_REPORTING_POINT',
]);

/** Decimate the raw trace to at most `maxSamples` vertices by arc length,
 *  keeping the first and last, and carry each vertex's cumulative distance.
 *
 *  `altMslFt` converts a fix's stored altitude to mean sea level, which is the
 *  datum the airspace bands drawn behind the trace are on; without it the
 *  recorded value is plotted as-is. Injected rather than imported so the
 *  module stays pure and datum-free (the vocab-pack idiom). */
export function thinTrace(
	points: TrackPoint[],
	maxSamples = 600,
	altMslFt?: (p: TrackPoint) => number | null,
): ThinnedPoint[] {
	const n = points.length;
	if (n === 0) {
		return [];
	}
	const cum = new Array<number>(n);
	cum[0] = 0;
	for (let i = 1; i < n; i++) {
		cum[i] =
			cum[i - 1] +
			equirectangularDistanceM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon) /
				NM_TO_METERS;
	}
	const total = cum[n - 1];
	const spacing = total > 0 ? total / Math.max(1, maxSamples) : Infinity;
	const at = (i: number): ThinnedPoint => ({
		lat: points[i].lat,
		lon: points[i].lon,
		altFt: altMslFt ? altMslFt(points[i]) : points[i].altFt,
		timeMs: points[i].timeMs,
		cumNM: cum[i],
	});
	const out: ThinnedPoint[] = [at(0)];
	let lastCum = cum[0];
	for (let i = 1; i < n - 1; i++) {
		if (cum[i] - lastCum >= spacing) {
			out.push(at(i));
			lastCum = cum[i];
		}
	}
	if (n > 1) {
		out.push(at(n - 1));
	}
	return out;
}

/** Perpendicular distance (m) from P to segment A-B, plus the clamped
 *  projection parameter t in [0, 1] (cos-lat planar, matching geometry.ts). */
function projectToSegment(
	pLat: number,
	pLon: number,
	aLat: number,
	aLon: number,
	bLat: number,
	bLon: number,
): { distM: number; t: number } {
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
	return { distM: Math.sqrt(cx * cx + cy * cy) * M_PER_DEG, t };
}

/** Closest approach of a point to the thinned polyline: minimum perpendicular
 *  distance (m) over all segments and the along-track distance (NM) there. */
function closestApproach(
	lat: number,
	lon: number,
	thinned: ThinnedPoint[],
): { distM: number; distNM: number } {
	if (thinned.length === 1) {
		return {
			distM: equirectangularDistanceM(lat, lon, thinned[0].lat, thinned[0].lon),
			distNM: thinned[0].cumNM,
		};
	}
	let bestD = Infinity;
	let bestNM = 0;
	for (let i = 0; i + 1 < thinned.length; i++) {
		const a = thinned[i];
		const b = thinned[i + 1];
		const { distM, t } = projectToSegment(lat, lon, a.lat, a.lon, b.lat, b.lon);
		if (distM < bestD) {
			bestD = distM;
			bestNM = a.cumNM + t * (b.cumNM - a.cumNM);
		}
	}
	return { distM: bestD, distNM: bestNM };
}

interface Bbox {
	minLat: number;
	minLon: number;
	maxLat: number;
	maxLon: number;
}

function traceBbox(thinned: ThinnedPoint[], padNM: number): Bbox {
	let minLat = Infinity;
	let minLon = Infinity;
	let maxLat = -Infinity;
	let maxLon = -Infinity;
	for (const p of thinned) {
		if (p.lat < minLat) minLat = p.lat;
		if (p.lat > maxLat) maxLat = p.lat;
		if (p.lon < minLon) minLon = p.lon;
		if (p.lon > maxLon) maxLon = p.lon;
	}
	const padDeg = (padNM * NM_TO_METERS) / M_PER_DEG;
	const cosLat = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180) || 1;
	return {
		minLat: minLat - padDeg,
		maxLat: maxLat + padDeg,
		minLon: minLon - padDeg / cosLat,
		maxLon: maxLon + padDeg / cosLat,
	};
}

function inBbox(lat: number, lon: number, b: Bbox): boolean {
	return lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
}

function coordName(lat: number, lon: number): string {
	return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
}

/** Identity behind one detected feature label, for click-through navigation:
 *  a dataset airport / navaid opens its panel, anything else is only a
 *  position to fly the map to. Parallel to the features array (same index). */
export type TraceFeatureRef =
	| { kind: 'airport'; id: string }
	| { kind: 'navaid'; id: string }
	| { kind: 'point'; lat: number; lon: number };

export interface TraceFeatures {
	features: ProfileWaypoint[];
	refs: TraceFeatureRef[];
}

/** Airports / navaids / VFR points near the track, plus the route's own
 *  waypoints, each placed at its closest-approach distance and de-duplicated by
 *  ident (the route waypoint wins). Sorted by along-track distance; `refs` is
 *  index-parallel to `features`. */
export function detectFeatures(
	thinned: ThinnedPoint[],
	route: Waypoint[] | null,
	airports: Airport[] | null,
	navaids: Navaid[] | null,
): TraceFeatures {
	if (thinned.length === 0) {
		return { features: [], refs: [] };
	}
	const bbox = traceBbox(thinned, AIRPORT_RADIUS_NM);
	const seen = new Set<string>();
	const out: { f: ProfileWaypoint; ref: TraceFeatureRef }[] = [];

	const add = (
		lat: number,
		lon: number,
		radiusNM: number,
		label: string,
		name: string,
		ident: string,
		ref: TraceFeatureRef,
	): void => {
		if (!inBbox(lat, lon, bbox)) {
			return;
		}
		const key = ident.toUpperCase();
		if (key && seen.has(key)) {
			return;
		}
		const ca = closestApproach(lat, lon, thinned);
		if (ca.distM > radiusNM * NM_TO_METERS) {
			return;
		}
		if (key) {
			seen.add(key);
		}
		out.push({ f: { distNM: ca.distNM, altFt: 0, label, name }, ref });
	};

	// Route waypoints first, so they win the ident dedup (a departure airport is
	// both a route waypoint and a dataset airport).
	if (route) {
		for (const wp of route) {
			const label = wp.ident ?? wp.label ?? '';
			const name = wp.ident ?? wp.label ?? coordName(wp.lat, wp.lon);
			const ref: TraceFeatureRef =
				wp.kind === 'airport' && wp.refId
					? { kind: 'airport', id: wp.refId.toUpperCase() }
					: wp.kind === 'navaid' && wp.refId
						? { kind: 'navaid', id: wp.refId }
						: { kind: 'point', lat: wp.lat, lon: wp.lon };
			add(wp.lat, wp.lon, ROUTE_RADIUS_NM, label, name, wp.refId ?? wp.ident ?? '', ref);
		}
	}
	if (airports) {
		for (const a of airports) {
			add(a.lat, a.lon, AIRPORT_RADIUS_NM, a.ident, a.name || a.ident, a.ident, {
				kind: 'airport',
				id: a.ident,
			});
		}
	}
	if (navaids) {
		for (const nav of navaids) {
			if (!FEATURE_NAVAID_TYPES.has(nav.type)) {
				continue;
			}
			const radius = nav.type === 'VFR_REPORTING_POINT' ? VFR_RADIUS_NM : NAVAID_RADIUS_NM;
			add(nav.lat, nav.lon, radius, nav.ident, nav.name || nav.ident, nav.ident, {
				kind: 'navaid',
				id: nav.id,
			});
		}
	}

	out.sort((p, q) => p.f.distNM - q.f.distNM);
	return { features: out.map((e) => e.f), refs: out.map((e) => e.ref) };
}

/** The thinned trace as minimal free Waypoints: the shape sampleRoute and the
 *  NOTAM track walk read (lat/lon only; the altitude is ignored by the
 *  lateral-only walks). Shared by buildTraceProfileDoc and the modal's NOTAM
 *  derivations so every walk measures the same polyline. */
export function traceAsWaypoints(thinned: ThinnedPoint[]): Waypoint[] {
	return thinned.map((p, i) => ({
		id: `t${i}`,
		lat: p.lat,
		lon: p.lon,
		kind: 'free',
		alt: 0,
		altAuto: false,
	}));
}

export function buildTraceProfileDoc(input: TraceProfileInput): TraceProfileDoc {
	const { thinned, airspaces, terrain, typeLabels } = input;

	// Lateral airspace bands over the shared minimal-Waypoint wrapping.
	const asWaypoints = traceAsWaypoints(thinned);
	const corridorBands = airspaces ? computeAirspaceCorridorSpans(asWaypoints, airspaces) : [];
	const placedBands = buildBands(corridorBands, terrain, typeLabels);

	// Recorded-altitude line: straight from the trace vertices (no synthesised
	// climb/cruise/descent). Points without a GPS altitude are skipped.
	const vertices = thinned
		.filter((p) => p.altFt != null)
		.map((p) => ({ distNM: p.cumNM, altFt: p.altFt as number }));
	const altitudePath: AltitudePath = { vertices, markers: [] };

	const { features, refs: featureRefs } = detectFeatures(
		thinned,
		input.route,
		input.airports,
		input.navaids,
	);

	const totalNM = thinned.length ? thinned[thinned.length - 1].cumNM : 0;
	let peak = 0;
	for (const v of vertices) {
		if (v.altFt > peak) peak = v.altFt;
	}
	for (const s of terrain) {
		if (s.elevFt != null && s.elevFt > peak) peak = s.elevFt;
	}
	const fitCeilingFt = Math.max(1000, peak / 0.75);

	const timeline: TimelinePoint[] = thinned.map((p) => ({ timeMs: p.timeMs, cumNM: p.cumNM }));

	return {
		altitudePath,
		corridorBands,
		placedBands,
		features,
		featureRefs,
		totalNM,
		fitCeilingFt,
		timeline,
	};
}

/** Along-track distance (NM) at replay time `ms` (binary search + lerp over the
 *  monotonic timeline). */
export function distNMAtTime(timeline: TimelinePoint[], ms: number): number {
	const n = timeline.length;
	if (n === 0) {
		return 0;
	}
	if (ms <= timeline[0].timeMs) {
		return timeline[0].cumNM;
	}
	if (ms >= timeline[n - 1].timeMs) {
		return timeline[n - 1].cumNM;
	}
	let lo = 0;
	let hi = n - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (timeline[mid].timeMs <= ms) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	const a = timeline[lo];
	const b = timeline[lo + 1];
	const span = b.timeMs - a.timeMs;
	const f = span > 0 ? (ms - a.timeMs) / span : 0;
	return a.cumNM + (b.cumNM - a.cumNM) * f;
}

/** Replay time (ms) at along-track distance `nm` (the inverse mapping, for a
 *  click / drag on the profile). */
export function timeMsAtDistNM(timeline: TimelinePoint[], nm: number): number {
	const n = timeline.length;
	if (n === 0) {
		return 0;
	}
	if (nm <= timeline[0].cumNM) {
		return timeline[0].timeMs;
	}
	if (nm >= timeline[n - 1].cumNM) {
		return timeline[n - 1].timeMs;
	}
	let lo = 0;
	let hi = n - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (timeline[mid].cumNM <= nm) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	const a = timeline[lo];
	const b = timeline[lo + 1];
	const span = b.cumNM - a.cumNM;
	const f = span > 0 ? (nm - a.cumNM) / span : 0;
	return a.timeMs + (b.timeMs - a.timeMs) * f;
}
