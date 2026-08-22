/* Per-leg minimum safe altitude for the navigation log: the highest ground or
 * obstacle within a 5 NM corridor of the leg, plus a flight-rules-aware margin
 * (`msaMarginFt`: 500 ft VFR, 1000 ft IFR; over mountainous terrain the IFR
 * margin grows to 2000 ft via `msaMarginForTerrainFt`), rounded up to the next
 * 100 ft. The geometry + formula are pure (unit-tested); the ground sampling
 * pulls async terrain elevation from terrain.ts. Pure module: callers pass the
 * flight rules (`opts.vfr`, deriving a terrain-aware per-leg margin) or a
 * fixed `opts.marginFt`; state stays outside. */

import { M_PER_DEG, pointToSegmentDistanceM } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import { routeCorridorBbox } from '$lib/route/notamCorridor';
import { elevationAt, metresToFeet } from '$lib/map/terrain';
import type { Obstacle, ObstacleType } from '$lib/data/obstacles';

export interface LatLon {
	lat: number;
	lon: number;
}

export interface MinAltitudeOpts {
	/** Corridor half-width (NM) each side of the leg. */
	halfWidthNM?: number;
	/** Along-track terrain sample step (NM). */
	alongStepNM?: number;
	/** Cross-track terrain sample step (NM). */
	crossStepNM?: number;
	/** Clearance added above the highest ground / obstacle (ft). Ignored when
	 *  `vfr` is set (the terrain-aware per-leg margin takes over). */
	marginFt?: number;
	/** Flight rules for the terrain-aware margin: when set, each leg's margin
	 *  comes from `msaMarginForTerrainFt` over its own corridor ground stats
	 *  (2000 ft IFR over mountainous legs) instead of the fixed `marginFt`. */
	vfr?: boolean;
	signal?: AbortSignal;
}

const HALF_WIDTH_NM = 5;
const ALONG_STEP_NM = 1;
const CROSS_STEP_NM = 1;
const MARGIN_FT = 500;

/** Clearance margin (ft) above the highest ground / obstacle in the MSA
 *  corridor, by flight rules. IFR: 1000 ft, the SERA.5015(b) minimum IFR
 *  level over the highest obstacle within 8 km of the estimated position
 *  (its 2000 ft mountainous figure is applied per leg by
 *  `msaMarginForTerrainFt`). VFR: 500 ft, a planning aid echoing the
 *  SERA.5005(f) minimum height over obstacles; VFR has no en-route
 *  obstacle-clearance minimum, terrain clearance stays the pilot's visual
 *  responsibility. */
export function msaMarginFt(vfr: boolean): number {
	return vfr ? 500 : 1000;
}

/** Mountainous-terrain heuristic threshold: a corridor whose highest ground
 *  reaches this elevation (ft AMSL) counts as mountainous. */
export const MOUNTAINOUS_ELEV_FT = 5000;
/** Mountainous-terrain heuristic threshold: a corridor whose ground spans at
 *  least this relief (max - min ground, ft) counts as mountainous. */
export const MOUNTAINOUS_RELIEF_FT = 3000;

/** Flight-rules margin (ft) made terrain-aware per SERA.5015(b), whose IFR
 *  minimum level is 1000 ft above the highest obstacle within 8 km but
 *  2000 ft 'over high terrain or in mountainous areas'. Mountainous is a
 *  HEURISTIC over the leg's 5 NM-corridor ground samples: max ground >=
 *  `MOUNTAINOUS_ELEV_FT` (5000 ft), or relief (max - min ground, both known)
 *  >= `MOUNTAINOUS_RELIEF_FT` (3000 ft); official mountainous-area polygons
 *  would supersede these thresholds if ever added as a dataset. VFR stays
 *  500 ft always (a planning aid, not a SERA minimum). Null ground stats
 *  fall back to the flat `msaMarginFt`. Pure. */
export function msaMarginForTerrainFt(
	vfr: boolean,
	maxGroundFt: number | null,
	minGroundFt: number | null,
): number {
	if (vfr || maxGroundFt == null) {
		return msaMarginFt(vfr);
	}
	const mountainous =
		maxGroundFt >= MOUNTAINOUS_ELEV_FT ||
		(minGroundFt != null && maxGroundFt - minGroundFt >= MOUNTAINOUS_RELIEF_FT);
	return mountainous ? 2000 : 1000;
}
/** Cap on along-track samples across the whole route (cross-track count is fixed
 *  by the corridor width); the step widens for very long routes so the elevation
 *  fan-out stays bounded. */
const MAX_ALONG_SAMPLES = 500;

/** One sample of the corridor swath: the centre point fed to the terrain probe
 *  plus the four corners of its grid cell (a quad oriented to the leg: half the
 *  along-spacing each way along the track, half the cross-step each way across
 *  it), so a caller can PAINT the cell, not just probe its centre. Pure. */
export interface CorridorCell {
	center: LatLon;
	corners: [LatLon, LatLon, LatLon, LatLon];
}

/** The corridor swath of leg a->b as tiled cells: along-track every
 *  `alongStepNM`, cross-track every `crossStepNM` from -halfWidth to +halfWidth
 *  perpendicular to the leg (cos(lat)-scaled lon/lat). Adjacent cells tile (half
 *  a step about each centre), so painting them fills the swath without gaps or
 *  overlap. `corridorSamplePoints` is just the centres of these. Pure. */
export function legCorridorCells(
	a: LatLon,
	b: LatLon,
	halfWidthNM = HALF_WIDTH_NM,
	alongStepNM = ALONG_STEP_NM,
	crossStepNM = CROSS_STEP_NM,
): CorridorCell[] {
	const cosLat = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)) || 1;
	// Leg vector in metres (lon scaled by cosLat), and its unit along / perp.
	const vx = (b.lon - a.lon) * cosLat * M_PER_DEG;
	const vy = (b.lat - a.lat) * M_PER_DEG;
	const legM = Math.hypot(vx, vy);
	const ux = legM > 0 ? vx / legM : 0;
	const uy = legM > 0 ? vy / legM : 0;
	const nx = legM > 0 ? -vy / legM : 0;
	const ny = legM > 0 ? vx / legM : 0;

	const legNM = legM / NM_TO_METERS;
	const nAlong = Math.max(1, Math.ceil(legNM / Math.max(0.1, alongStepNM)));
	const stepM = Math.max(0.1, crossStepNM) * NM_TO_METERS;
	const nCross = Math.floor((halfWidthNM * NM_TO_METERS) / stepM + 1e-9);

	// Cell half-extents (metres): half the actual along-spacing and half the
	// cross-step, so neighbouring cells abut.
	const halfAlongM = legM / nAlong / 2;
	const halfCrossM = stepM / 2;
	// An (along, cross) metre offset from (lat, lon) -> lat/lon, the same
	// cos(lat)-scaled mapping the centres use.
	const corner = (lat: number, lon: number, alongM: number, crossM: number): LatLon => ({
		lat: lat + (uy * alongM + ny * crossM) / M_PER_DEG,
		lon: lon + (ux * alongM + nx * crossM) / (M_PER_DEG * cosLat),
	});

	const out: CorridorCell[] = [];
	for (let i = 0; i <= nAlong; i++) {
		const f = i / nAlong;
		const clat = a.lat + (b.lat - a.lat) * f;
		const clon = a.lon + (b.lon - a.lon) * f;
		for (let c = -nCross; c <= nCross; c++) {
			const offM = c * stepM;
			const center: LatLon = {
				lat: clat + (ny * offM) / M_PER_DEG,
				lon: clon + (nx * offM) / (M_PER_DEG * cosLat),
			};
			out.push({
				center,
				corners: [
					corner(center.lat, center.lon, -halfAlongM, -halfCrossM),
					corner(center.lat, center.lon, halfAlongM, -halfCrossM),
					corner(center.lat, center.lon, halfAlongM, halfCrossM),
					corner(center.lat, center.lon, -halfAlongM, halfCrossM),
				],
			});
		}
	}
	return out;
}

/** Sample points filling the corridor swath of leg a->b (the cell centres of
 *  `legCorridorCells`): along-track every `alongStepNM`, cross-track every
 *  `crossStepNM` from -halfWidth to +halfWidth perpendicular to the leg
 *  (cos(lat)-scaled lon/lat). Pure. */
export function corridorSamplePoints(
	a: LatLon,
	b: LatLon,
	halfWidthNM = HALF_WIDTH_NM,
	alongStepNM = ALONG_STEP_NM,
	crossStepNM = CROSS_STEP_NM,
): LatLon[] {
	return legCorridorCells(a, b, halfWidthNM, alongStepNM, crossStepNM).map((c) => c.center);
}

/** Highest obstacle TOP elevation (AMSL ft) within `halfWidthNM` of leg a->b, or
 *  null when none qualify. The dataset's `elev` is ALREADY the top of the
 *  obstacle AMSL (`hgt` is its height above ground and must not be added);
 *  obstacles missing `elev` are skipped. Pure. */
export function maxObstacleTopFt(
	a: LatLon,
	b: LatLon,
	obstacles: Obstacle[],
	halfWidthNM = HALF_WIDTH_NM,
): number | null {
	const limitM = halfWidthNM * NM_TO_METERS;
	let max: number | null = null;
	for (const o of obstacles) {
		if (o.elev == null) {
			continue;
		}
		if (pointToSegmentDistanceM(o.lat, o.lon, a.lat, a.lon, b.lat, b.lon) > limitM) {
			continue;
		}
		if (max == null || o.elev > max) {
			max = o.elev;
		}
	}
	return max;
}

/** One obstacle placed along the route for the vertical profile: its
 *  along-track distance (anchored to the caller's cumulative leg distances,
 *  the chart's x basis) plus what the glyph and tooltip need. `topFt` is the
 *  dataset's `elev` (top AMSL); `baseFt` = top - height when the height is
 *  known, else null (no stem to draw). */
export interface ObstacleMark {
	id: string;
	distNM: number;
	/** Obstacle top, ft AMSL (`elev`; `hgt` is never added to it). */
	topFt: number;
	/** Obstacle base, ft AMSL (top - `hgt`), null when the height is unknown. */
	baseFt: number | null;
	type: ObstacleType;
	/** Height above ground (ft AGL), null when unknown. */
	hgt: number | null;
	lit: boolean;
	name: string;
	/** Unsigned lateral offset from the track (NM). */
	offsetNM: number;
}

/** Project one point onto its nearest route leg within `halfWidthNM`: the
 *  clamped projection parameter anchors it to the caller's cumulative leg
 *  distances `cumNM` (length pts.length, cumNM[0] = 0, the nav-log
 *  distances the chart draws), so projected marks and waypoints share one
 *  x axis. Null when the point is farther than the half-width from every
 *  leg. Same flat-earth idiom as `legCorridorCells` (cos(lat)-scaled
 *  metres); `pointToSegmentDistanceM` is not reused because the
 *  along-track parameter is needed too. Shared by the profile's permanent
 *  obstacle marks and the NOTAM temporary-obstacle marks
 *  (route/notamProfile.ts). Pure. */
export function projectPointToRoute(
	pts: LatLon[],
	cumNM: number[],
	lat: number,
	lon: number,
	halfWidthNM = HALF_WIDTH_NM,
): { distNM: number; offsetNM: number } | null {
	const n = pts.length;
	if (n < 2 || cumNM.length !== n) {
		return null;
	}
	const limitM = halfWidthNM * NM_TO_METERS;
	// Nearest leg by perpendicular distance; keep its clamped projection
	// parameter for the along-track anchor.
	let best: { distM: number; leg: number; t: number } | null = null;
	for (let i = 0; i + 1 < n; i++) {
		const a = pts[i];
		const b = pts[i + 1];
		const cosLat = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)) || 1;
		const vx = (b.lon - a.lon) * cosLat * M_PER_DEG;
		const vy = (b.lat - a.lat) * M_PER_DEG;
		const wx = (lon - a.lon) * cosLat * M_PER_DEG;
		const wy = (lat - a.lat) * M_PER_DEG;
		const len2 = vx * vx + vy * vy;
		const t = len2 > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
		const distM = Math.hypot(wx - t * vx, wy - t * vy);
		if (distM <= limitM && (best == null || distM < best.distM)) {
			best = { distM, leg: i, t };
		}
	}
	if (!best) {
		return null;
	}
	return {
		distNM: cumNM[best.leg] + best.t * (cumNM[best.leg + 1] - cumNM[best.leg]),
		offsetNM: best.distM / NM_TO_METERS,
	};
}

/** Obstacles within `halfWidthNM` of the route, placed along it for the
 *  vertical profile via `projectPointToRoute`. The half-width defaults to
 *  the min-alt corridor, the nav-log MSA basis, so the chart shows the
 *  obstacles that drive the MSA column. Pure. */
export function profileObstacleMarks(
	pts: LatLon[],
	cumNM: number[],
	obstacles: Obstacle[],
	halfWidthNM = HALF_WIDTH_NM,
): ObstacleMark[] {
	const n = pts.length;
	if (n < 2 || cumNM.length !== n) {
		return [];
	}
	const bbox = routeCorridorBbox(pts, halfWidthNM);
	if (!bbox) {
		return [];
	}
	const out: ObstacleMark[] = [];
	for (const o of obstacles) {
		if (o.elev == null) {
			continue;
		}
		if (o.lat < bbox.minLat || o.lat > bbox.maxLat || o.lon < bbox.minLon || o.lon > bbox.maxLon) {
			continue;
		}
		const proj = projectPointToRoute(pts, cumNM, o.lat, o.lon, halfWidthNM);
		if (!proj) {
			continue;
		}
		out.push({
			id: o.id,
			distNM: proj.distNM,
			topFt: o.elev,
			baseFt: o.hgt != null ? o.elev - o.hgt : null,
			type: o.type,
			hgt: o.hgt,
			lit: o.lit,
			name: o.name,
			offsetNM: proj.offsetNM,
		});
	}
	out.sort((a, b) => a.distNM - b.distNM);
	return out;
}

/** `max(ground, obstacle-top) + margin`, rounded UP to the next 100 ft. Null when
 *  both inputs are null (no terrain and no obstacle data). Pure. */
export function roundedMinAltFt(
	maxGroundFt: number | null,
	maxObstacleFt: number | null,
	marginFt = MARGIN_FT,
): number | null {
	if (maxGroundFt == null && maxObstacleFt == null) {
		return null;
	}
	const base = Math.max(maxGroundFt ?? 0, maxObstacleFt ?? 0);
	return Math.ceil((base + marginFt) / 100) * 100;
}

/** Per-leg minimum safe altitude (ft), one entry per leg (waypoints.length - 1).
 *  Ground is the max of the terrain corridor swath (async); obstacles are the
 *  tallest top within the corridor. A leg with neither terrain nor obstacle data
 *  is null. */
export async function computeMinAltitudes(
	waypoints: LatLon[],
	obstacles: Obstacle[],
	opts: MinAltitudeOpts = {},
): Promise<(number | null)[]> {
	const halfWidthNM = opts.halfWidthNM ?? HALF_WIDTH_NM;
	const crossStepNM = opts.crossStepNM ?? CROSS_STEP_NM;
	const marginFt = opts.marginFt ?? MARGIN_FT;
	const n = waypoints.length;
	if (n < 2) {
		return [];
	}

	// Adapt the along-track step so the whole-route sample count stays bounded.
	let totalNM = 0;
	for (let i = 0; i + 1 < n; i++) {
		const a = waypoints[i];
		const b = waypoints[i + 1];
		const cosLat = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)) || 1;
		totalNM +=
			Math.hypot((b.lon - a.lon) * cosLat * M_PER_DEG, (b.lat - a.lat) * M_PER_DEG) / NM_TO_METERS;
	}
	const alongStepNM = Math.max(opts.alongStepNM ?? ALONG_STEP_NM, totalNM / MAX_ALONG_SAMPLES);

	// Pre-cull obstacles to the route corridor bbox once (one flat scan of the
	// full ~200k set), so the per-leg distance test runs on a small candidate set.
	const bbox = routeCorridorBbox(waypoints, halfWidthNM);
	const candidates = bbox
		? obstacles.filter(
				(o) =>
					o.elev != null &&
					o.lat >= bbox.minLat &&
					o.lat <= bbox.maxLat &&
					o.lon >= bbox.minLon &&
					o.lon <= bbox.maxLon,
			)
		: [];

	// Build every leg's swath points in one flat list (tagged by leg) so a single
	// elevationAt batch maximises tile-fetch concurrency and cache reuse.
	const flat: LatLon[] = [];
	const legOf: number[] = [];
	for (let i = 0; i + 1 < n; i++) {
		const pts = corridorSamplePoints(waypoints[i], waypoints[i + 1], halfWidthNM, alongStepNM, crossStepNM);
		for (const p of pts) {
			flat.push(p);
			legOf.push(i);
		}
	}

	const elevsM = await Promise.all(flat.map((p) => elevationAt(p.lat, p.lon)));
	if (opts.signal?.aborted) {
		return [];
	}

	// Per-leg max AND min ground (ft) from the swath samples (null samples
	// skipped for both); the min feeds the mountainous-relief heuristic only.
	const groundFt: (number | null)[] = new Array<number | null>(n - 1).fill(null);
	const groundMinFt: (number | null)[] = new Array<number | null>(n - 1).fill(null);
	for (let k = 0; k < flat.length; k++) {
		const m = elevsM[k];
		if (m == null) {
			continue;
		}
		const ft = metresToFeet(m);
		const leg = legOf[k];
		const cur = groundFt[leg];
		if (cur == null || ft > cur) {
			groundFt[leg] = ft;
		}
		const curMin = groundMinFt[leg];
		if (curMin == null || ft < curMin) {
			groundMinFt[leg] = ft;
		}
	}

	const out: (number | null)[] = [];
	for (let i = 0; i + 1 < n; i++) {
		const obst = maxObstacleTopFt(waypoints[i], waypoints[i + 1], candidates, halfWidthNM);
		// Terrain-aware margin from the leg's GROUND stats only (never the
		// obstacle top: SERA.5015(b)'s mountainous figure is about terrain).
		const legMarginFt =
			opts.vfr !== undefined
				? msaMarginForTerrainFt(opts.vfr, groundFt[i], groundMinFt[i])
				: marginFt;
		out.push(roundedMinAltFt(groundFt[i], obst, legMarginFt));
	}
	return out;
}

/** A corridor cell whose minimum safe altitude tops the route's planned leg
 *  altitude: the quad to paint as a terrain / obstacle conflict patch. */
export interface DangerCell {
	corners: [LatLon, LatLon, LatLon, LatLon];
}

/** A small square cell (~0.3 NM across) centred on a point, to mark one
 *  violating obstacle (a point feature, unlike the terrain grid). Pure. */
function obstacleDangerCell(lat: number, lon: number): DangerCell {
	const halfM = 0.15 * NM_TO_METERS;
	const cosLat = Math.cos((lat * Math.PI) / 180) || 1;
	const dLat = halfM / M_PER_DEG;
	const dLon = halfM / (M_PER_DEG * cosLat);
	return {
		corners: [
			{ lat: lat - dLat, lon: lon - dLon },
			{ lat: lat - dLat, lon: lon + dLon },
			{ lat: lat + dLat, lon: lon + dLon },
			{ lat: lat + dLat, lon: lon - dLon },
		],
	};
}

/** Whether a cell's minimum safe altitude (ground or obstacle top + margin,
 *  rounded the same as `computeMinAltitudes`) is strictly HIGHER than the route's
 *  planned altitude there, i.e. flying `routeAltFt` busts the clearance floor.
 *  Null ground (no terrain data) is not a conflict. Pure. */
export function cellExceedsRoute(
	groundFt: number | null,
	routeAltFt: number,
	marginFt = MARGIN_FT,
): boolean {
	const minAlt = roundedMinAltFt(groundFt, null, marginFt);
	return minAlt != null && minAlt > routeAltFt;
}

/** The corridor cells whose minimum safe altitude is higher than the active
 *  route's planned altitude on that leg, i.e. the precise patches where flying
 *  the planned level busts the `marginFt` clearance floor. Terrain cells come
 *  from the swath grid (async elevation); each in-corridor obstacle whose top
 *  alone exceeds the leg altitude adds a small marker cell. One entry per
 *  offending cell; empty for a route under two waypoints. Mirrors
 *  `computeMinAltitudes`'s sampling so the two stay consistent. */
export async function computeMinAltDangerCells(
	waypoints: (LatLon & { alt: number })[],
	obstacles: Obstacle[],
	opts: MinAltitudeOpts = {},
): Promise<DangerCell[]> {
	const halfWidthNM = opts.halfWidthNM ?? HALF_WIDTH_NM;
	const crossStepNM = opts.crossStepNM ?? CROSS_STEP_NM;
	const marginFt = opts.marginFt ?? MARGIN_FT;
	const n = waypoints.length;
	if (n < 2) {
		return [];
	}

	// Adapt the along-track step so the whole-route sample count stays bounded
	// (mirrors computeMinAltitudes).
	let totalNM = 0;
	for (let i = 0; i + 1 < n; i++) {
		const a = waypoints[i];
		const b = waypoints[i + 1];
		const cosLat = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)) || 1;
		totalNM +=
			Math.hypot((b.lon - a.lon) * cosLat * M_PER_DEG, (b.lat - a.lat) * M_PER_DEG) / NM_TO_METERS;
	}
	const alongStepNM = Math.max(opts.alongStepNM ?? ALONG_STEP_NM, totalNM / MAX_ALONG_SAMPLES);

	// Every leg's swath cells in one flat list (tagged by leg), so a single
	// elevationAt batch maximises tile-fetch concurrency and cache reuse.
	const cells: CorridorCell[] = [];
	const legOf: number[] = [];
	for (let i = 0; i + 1 < n; i++) {
		const legCells = legCorridorCells(
			waypoints[i],
			waypoints[i + 1],
			halfWidthNM,
			alongStepNM,
			crossStepNM,
		);
		for (const cell of legCells) {
			cells.push(cell);
			legOf.push(i);
		}
	}

	const elevsM = await Promise.all(cells.map((c) => elevationAt(c.center.lat, c.center.lon)));
	if (opts.signal?.aborted) {
		return [];
	}

	// Per-leg ground stats over the same samples (null samples skipped), so
	// each leg's margin matches computeMinAltitudes' terrain-aware one: the
	// mountainous test reads GROUND min/max only, never obstacle tops.
	const legMarginFt: number[] = new Array<number>(n - 1).fill(marginFt);
	if (opts.vfr !== undefined) {
		const maxFt: (number | null)[] = new Array<number | null>(n - 1).fill(null);
		const minFt: (number | null)[] = new Array<number | null>(n - 1).fill(null);
		for (let k = 0; k < cells.length; k++) {
			const m = elevsM[k];
			if (m == null) {
				continue;
			}
			const ft = metresToFeet(m);
			const leg = legOf[k];
			const curMax = maxFt[leg];
			if (curMax == null || ft > curMax) {
				maxFt[leg] = ft;
			}
			const curMin = minFt[leg];
			if (curMin == null || ft < curMin) {
				minFt[leg] = ft;
			}
		}
		for (let i = 0; i + 1 < n; i++) {
			legMarginFt[i] = msaMarginForTerrainFt(opts.vfr, maxFt[i], minFt[i]);
		}
	}

	const out: DangerCell[] = [];

	// Terrain: a cell offends when its ground + margin tops the leg's altitude.
	for (let k = 0; k < cells.length; k++) {
		const m = elevsM[k];
		if (m == null) {
			continue;
		}
		if (cellExceedsRoute(metresToFeet(m), waypoints[legOf[k]].alt, legMarginFt[legOf[k]])) {
			out.push({ corners: cells[k].corners });
		}
	}

	// Obstacles: a point feature whose top alone exceeds the leg altitude (the
	// terrain at a cell centre can miss the structure). Pre-cull to the corridor
	// bbox once, then the per-leg distance gate as in maxObstacleTopFt.
	const bbox = routeCorridorBbox(waypoints, halfWidthNM);
	const candidates = bbox
		? obstacles.filter(
				(o) =>
					o.elev != null &&
					o.lat >= bbox.minLat &&
					o.lat <= bbox.maxLat &&
					o.lon >= bbox.minLon &&
					o.lon <= bbox.maxLon,
			)
		: [];
	const limitM = halfWidthNM * NM_TO_METERS;
	for (let i = 0; i + 1 < n; i++) {
		const a = waypoints[i];
		const b = waypoints[i + 1];
		for (const o of candidates) {
			if (o.elev == null) {
				continue;
			}
			const minAlt = roundedMinAltFt(null, o.elev, legMarginFt[i]);
			if (minAlt == null || minAlt <= a.alt) {
				continue;
			}
			if (pointToSegmentDistanceM(o.lat, o.lon, a.lat, a.lon, b.lat, b.lon) > limitM) {
				continue;
			}
			out.push(obstacleDangerCell(o.lat, o.lon));
		}
	}

	return out;
}
