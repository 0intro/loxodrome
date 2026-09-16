/* Per-leg minimum safe altitude for the navigation log: the highest ground or
 * obstacle within a 5 NM corridor of the leg, plus a flight-rules-aware margin
 * (`msaMarginFt`: 500 ft VFR, 1000 ft IFR; over mountainous terrain the IFR
 * margin grows to 2000 ft via `msaMarginForTerrainFt`), rounded up to the next
 * 100 ft. The geometry + formula are pure (unit-tested); the ground comes from
 * terrain.ts. Pure module: callers pass the flight rules (`opts.vfr`, deriving
 * a terrain-aware per-leg margin) or a fixed `opts.marginFt`; state stays
 * outside.
 *
 * The corridor is a CAPSULE, the disc SERA.5015(b) draws around "the estimated
 * position of the aircraft" swept along the leg, so terrain around a turn
 * point counts exactly as the obstacles there already did
 * (`maxObstacleTopFt` / `projectPointToRoute` use `pointToSegmentDistanceM`,
 * and minAltCorridorLayer has always DRAWN a round-capped band). And the
 * ground in it is read pixel by pixel through terrain.ts's capsule reduction,
 * not probed once per cell: a 1 NM cell holds ~4700 DEM pixels, and one point
 * per cell under-read a real Alpine leg's corridor maximum by 609 ft.
 *
 * `computeCorridorGround` is the one pass; the MSA column and the danger
 * patches are pure folds of its result, so the number and the picture cannot
 * disagree. */

import {
	equirectangularDistanceM,
	M_PER_DEG,
	pointToSegmentDistanceM,
} from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import { routeCorridorBbox } from '$lib/route/notamCorridor';
import { binMax, binMin, metresToFeet, pickLevel, reduceCapsule } from '$lib/map/terrain';
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
/** Cap on along-track CELLS across the whole route (the cross-track count is
 *  fixed by the corridor width); the step widens for very long routes so the
 *  painted patch count stays bounded. It is no longer a sampling budget: every
 *  pixel is read whatever the step, so a long route loses granularity in the
 *  patches, never accuracy in the answer. */
const MAX_ALONG_SAMPLES = 500;

/** One cell of the corridor swath: its centre plus the four corners of its
 *  quad (a rectangle oriented to the leg, half the along-spacing each way
 *  along the track and half the cross-step each way across it), so a caller
 *  can PAINT the cell, and the bin indices it occupies in the leg's grid, so
 *  a caller can read the terrain reduction's answer for it. Pure. */
export interface CorridorCell {
	center: LatLon;
	corners: [LatLon, LatLon, LatLon, LatLon];
	/** Along-track index: 0 on the first waypoint, `alongBins` on the second,
	 *  negative or beyond inside the end caps. */
	alongIdx: number;
	/** Cross-track index, 0 on the centreline, positive to the left. */
	crossIdx: number;
}

/** The leg's flat-frame geometry and cell grid, shared by `legCorridorCells`
 *  and the terrain reduction so the cells and the bins are the same grid. */
interface LegGeometry {
	cosLat: number;
	ux: number;
	uy: number;
	nx: number;
	ny: number;
	legM: number;
	halfWidthM: number;
	/** Cells along the leg: cell i sits at i * alongCellM. */
	alongBins: number;
	alongCellM: number;
	crossCellM: number;
	/** Outermost cross index, and how far the caps reach in along indices. */
	crossMax: number;
	capBins: number;
}

function legGeometry(
	a: LatLon,
	b: LatLon,
	halfWidthNM: number,
	alongStepNM: number,
	crossStepNM: number,
): LegGeometry {
	const cosLat = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)) || 1;
	// Leg vector in metres (lon scaled by cosLat), and its unit along / perp.
	const vx = (b.lon - a.lon) * cosLat * M_PER_DEG;
	const vy = (b.lat - a.lat) * M_PER_DEG;
	const legM = Math.hypot(vx, vy);
	const ux = legM > 0 ? vx / legM : 0;
	const uy = legM > 0 ? vy / legM : 0;
	const halfWidthM = halfWidthNM * NM_TO_METERS;
	const crossCellM = Math.max(0.1, crossStepNM) * NM_TO_METERS;
	const alongBins = Math.max(1, Math.ceil(legM / NM_TO_METERS / Math.max(0.1, alongStepNM)));
	const alongCellM = legM / alongBins;
	return {
		cosLat,
		ux,
		uy,
		nx: legM > 0 ? -vy / legM : 0,
		ny: legM > 0 ? vx / legM : 0,
		legM,
		halfWidthM,
		alongBins,
		alongCellM,
		crossCellM,
		crossMax: Math.floor(halfWidthM / crossCellM + 1e-9),
		capBins: alongCellM > 0 ? Math.ceil(halfWidthM / alongCellM) : 0,
	};
}

/** How many cells the leg is cut into along track, the count the terrain
 *  reduction bins into. Pure. */
export function corridorAlongBins(a: LatLon, b: LatLon, alongStepNM = ALONG_STEP_NM): number {
	return legGeometry(a, b, HALF_WIDTH_NM, alongStepNM, CROSS_STEP_NM).alongBins;
}

/** Shortest distance (m) from an axis-aligned box in the leg frame to the leg
 *  itself, i.e. the segment from (0,0) to (legM,0). Pure. */
function boxToLegM(a0: number, a1: number, c0: number, c1: number, legM: number): number {
	const dAlong = a0 > legM ? a0 - legM : a1 < 0 ? -a1 : 0;
	const dCross = c0 > 0 ? c0 : c1 < 0 ? -c1 : 0;
	return Math.hypot(dAlong, dCross);
}

/** The corridor swath of leg a->b as tiled cells: along-track every
 *  `alongStepNM`, cross-track every `crossStepNM` out to `halfWidthNM`, and
 *  ROUND ENDS, the grid running half a corridor width past each waypoint and
 *  keeping the cells whose quad still reaches the leg. Adjacent cells tile
 *  (half a step about each centre), so painting them fills the swath without
 *  gaps; the caps of consecutive legs overlap at a turn, which the danger
 *  layer absorbs by filling every quad as one path. `corridorSamplePoints` is
 *  just the centres of these. Pure. */
export function legCorridorCells(
	a: LatLon,
	b: LatLon,
	halfWidthNM = HALF_WIDTH_NM,
	alongStepNM = ALONG_STEP_NM,
	crossStepNM = CROSS_STEP_NM,
): CorridorCell[] {
	const g = legGeometry(a, b, halfWidthNM, alongStepNM, crossStepNM);
	// Cell half-extents (metres): half the actual along-spacing and half the
	// cross-step, so neighbouring cells abut.
	const halfAlongM = g.alongCellM / 2;
	const halfCrossM = g.crossCellM / 2;
	// An (along, cross) metre offset from (lat, lon) -> lat/lon, the same
	// cos(lat)-scaled mapping the centres use.
	const corner = (lat: number, lon: number, alongM: number, crossM: number): LatLon => ({
		lat: lat + (g.uy * alongM + g.ny * crossM) / M_PER_DEG,
		lon: lon + (g.ux * alongM + g.nx * crossM) / (M_PER_DEG * g.cosLat),
	});

	const out: CorridorCell[] = [];
	for (let i = -g.capBins; i <= g.alongBins + g.capBins; i++) {
		const alongM = i * g.alongCellM;
		const f = g.alongBins > 0 ? i / g.alongBins : 0;
		const clat = a.lat + (b.lat - a.lat) * f;
		const clon = a.lon + (b.lon - a.lon) * f;
		for (let c = -g.crossMax; c <= g.crossMax; c++) {
			const offM = c * g.crossCellM;
			if (
				boxToLegM(
					alongM - halfAlongM,
					alongM + halfAlongM,
					offM - halfCrossM,
					offM + halfCrossM,
					g.legM,
				) > g.halfWidthM
			) {
				continue; // the quad never reaches the leg: outside the capsule
			}
			const center: LatLon = {
				lat: clat + (g.ny * offM) / M_PER_DEG,
				lon: clon + (g.nx * offM) / (M_PER_DEG * g.cosLat),
			};
			out.push({
				center,
				corners: [
					corner(center.lat, center.lon, -halfAlongM, -halfCrossM),
					corner(center.lat, center.lon, halfAlongM, -halfCrossM),
					corner(center.lat, center.lon, halfAlongM, halfCrossM),
					corner(center.lat, center.lon, -halfAlongM, halfCrossM),
				],
				alongIdx: i,
				crossIdx: c,
			});
		}
	}
	return out;
}

/** Sample points filling the corridor swath of leg a->b (the cell centres of
 *  `legCorridorCells`). Pure. */
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

/** How one route's corridor is cut up, before any terrain is read: the
 *  along-track step after the whole-route cap, the cross-track cell, and the
 *  per-leg bin count. Pure.
 *
 *  It exists so the OFFLINE PIN and the reduction cannot disagree about which
 *  tiles a plan needs. The pin runs at the desk and the reduction in the air,
 *  and the tiles a reduction asks for depend on the level it picks, which
 *  depends on the bin size, which is this. Two computations of it that agreed
 *  today would be one silent divergence away from a pinned plan that answers
 *  "no data" over the Alps. */
export interface CorridorPlan {
	alongStepNM: number;
	crossCellM: number;
	halfWidthM: number;
	/** Per leg: its two ends and how many bins it is cut into. */
	legs: { a: LatLon; b: LatLon; alongBins: number }[];
}

export function corridorPlan(waypoints: LatLon[], opts: MinAltitudeOpts = {}): CorridorPlan {
	const halfWidthNM = opts.halfWidthNM ?? HALF_WIDTH_NM;
	const crossStepNM = opts.crossStepNM ?? CROSS_STEP_NM;
	const crossCellM = Math.max(0.1, crossStepNM) * NM_TO_METERS;
	const halfWidthM = halfWidthNM * NM_TO_METERS;
	const n = waypoints.length;
	if (n < 2) {
		return { alongStepNM: opts.alongStepNM ?? ALONG_STEP_NM, crossCellM, halfWidthM, legs: [] };
	}
	// Adapt the along-track step so the whole-route CELL count stays bounded.
	let totalNM = 0;
	for (let i = 0; i + 1 < n; i++) {
		totalNM +=
			equirectangularDistanceM(
				waypoints[i].lat,
				waypoints[i].lon,
				waypoints[i + 1].lat,
				waypoints[i + 1].lon,
			) / NM_TO_METERS;
	}
	const alongStepNM = Math.max(opts.alongStepNM ?? ALONG_STEP_NM, totalNM / MAX_ALONG_SAMPLES);
	return {
		alongStepNM,
		crossCellM,
		halfWidthM,
		legs: waypoints.slice(0, -1).map((a, i) => ({
			a,
			b: waypoints[i + 1],
			alongBins: corridorAlongBins(a, waypoints[i + 1], alongStepNM),
		})),
	};
}

/** The terrain LEVELS reading this route's corridor will ask for: what the
 *  offline pin must hold beside the deepest level the point queries use.
 *  Pure, and derived from the same `corridorPlan` the reduction runs on. */
export function corridorTerrainLevels(
	waypoints: LatLon[],
	opts: MinAltitudeOpts = {},
): number[] {
	const plan = corridorPlan(waypoints, opts);
	const out = new Set<number>();
	for (const leg of plan.legs) {
		const legM = equirectangularDistanceM(leg.a.lat, leg.a.lon, leg.b.lat, leg.b.lon);
		const binM = Math.min(legM / Math.max(1, leg.alongBins) || Infinity, plan.crossCellM);
		out.add(pickLevel(binM, (leg.a.lat + leg.b.lat) / 2));
	}
	return [...out].sort((x, y) => x - y);
}

/** Ground extremes of one corridor cell, feet AMSL. */
export interface CorridorCellGround {
	cell: CorridorCell;
	/** Index of the leg the cell belongs to. */
	leg: number;
	maxFt: number;
	minFt: number;
}

/** The corridor's ground extremes at one along-track station, on the route's
 *  own cumulative distance axis: the terrain envelope the vertical profile
 *  fills. Null where no tile arrived. */
export interface CorridorStation {
	distNM: number;
	maxFt: number | null;
	minFt: number | null;
}

/** Everything one pass over the corridor's terrain pixels knows. */
export interface CorridorGround {
	/** Cells that hold ground, leg by leg; a cell whose tiles all failed is
	 *  absent rather than zero. */
	cells: CorridorCellGround[];
	stations: CorridorStation[];
	legMaxFt: (number | null)[];
	legMinFt: (number | null)[];
	/** The terrain level each leg was answered at, which is what the offline
	 *  pin must have held for it (state/offlineTerrain pinLevels). */
	legZ: number[];
}

/** Nothing read: a route too short to have a corridor, or an aborted pass.
 *  A fresh object each time, since a caller may fold over its arrays. */
function emptyGround(): CorridorGround {
	return { cells: [], stations: [], legMaxFt: [], legMinFt: [], legZ: [] };
}

/** Read every terrain pixel of the route's minimum-altitude corridor, once.
 *  Each leg's capsule is reduced into the SAME cell grid `legCorridorCells`
 *  lays out (`corridorAlongBins` fixes the along count for both), so a cell's
 *  answer is the highest and lowest ground inside that quad rather than one
 *  interpolated point in the middle of it.
 *
 *  Distances accumulate with `equirectangularDistanceM`, the metric
 *  `computeNavLog` and `sampleProfile` use, so `stations` land on the nav
 *  log's own axis. Cap cells fold into the end stations: the corridor reaches
 *  half a width past each waypoint, and so does the answer for it. A leg that
 *  lost ANY tile comes back null, never the extremes of the rest: the cells
 *  and stations it did read stay (a patch drawn from real ground is true
 *  where it is drawn), but the leg's own figure is unknown. */
export async function computeCorridorGround(
	waypoints: LatLon[],
	opts: MinAltitudeOpts = {},
): Promise<CorridorGround> {
	const halfWidthNM = opts.halfWidthNM ?? HALF_WIDTH_NM;
	const crossStepNM = opts.crossStepNM ?? CROSS_STEP_NM;
	const n = waypoints.length;
	if (n < 2) {
		return emptyGround();
	}

	const plan = corridorPlan(waypoints, opts);
	const { alongStepNM, crossCellM, halfWidthM } = plan;
	const legNM: number[] = plan.legs.map(
		(leg) => equirectangularDistanceM(leg.a.lat, leg.a.lon, leg.b.lat, leg.b.lon) / NM_TO_METERS,
	);

	// Every leg at once: one flat fetch front, so the tile concurrency cap is
	// the only limit and legs sharing tiles share the cache. Each reduction
	// picks its own level from its bins (map/terrain.ts pickLevel).
	const reduced = await Promise.all(
		plan.legs.map((leg) =>
			reduceCapsule(
				leg.a,
				leg.b,
				{
					halfWidthM,
					alongBins: leg.alongBins,
					crossBinM: crossCellM,
					crossMax: Math.floor(halfWidthM / crossCellM + 1e-9),
				},
				opts.signal,
			),
		),
	);
	if (opts.signal?.aborted) {
		return emptyGround();
	}

	const cells: CorridorCellGround[] = [];
	const stations: CorridorStation[] = [];
	const legMaxFt: (number | null)[] = [];
	const legMinFt: (number | null)[] = [];
	let cumNM = 0;
	for (let i = 0; i + 1 < n; i++) {
		const a = waypoints[i];
		const b = waypoints[i + 1];
		const alongBins = corridorAlongBins(a, b, alongStepNM);
		const ground = reduced[i];
		// Per-station extremes, cap cells folded into the end they hang off.
		const stationMax: (number | null)[] = new Array<number | null>(alongBins + 1).fill(null);
		const stationMin: (number | null)[] = new Array<number | null>(alongBins + 1).fill(null);
		let lMax: number | null = null;
		let lMin: number | null = null;
		for (const cell of legCorridorCells(a, b, halfWidthNM, alongStepNM, crossStepNM)) {
			const maxM = binMax(ground.bins, cell.alongIdx, cell.crossIdx);
			const minM = binMin(ground.bins, cell.alongIdx, cell.crossIdx);
			if (maxM == null || minM == null) {
				continue; // no tile, or no pixel of it inside the capsule
			}
			const maxFt = metresToFeet(maxM);
			const minFt = metresToFeet(minM);
			cells.push({ cell, leg: i, maxFt, minFt });
			if (lMax == null || maxFt > lMax) {
				lMax = maxFt;
			}
			if (lMin == null || minFt < lMin) {
				lMin = minFt;
			}
			const k = Math.min(alongBins, Math.max(0, cell.alongIdx));
			const sMax = stationMax[k];
			if (sMax == null || maxFt > sMax) {
				stationMax[k] = maxFt;
			}
			const sMin = stationMin[k];
			if (sMin == null || minFt < sMin) {
				stationMin[k] = minFt;
			}
		}
		// A leg whose tiles did not all arrive is UNKNOWN, not the extremes of
		// the ones that did: an MSA computed from half a corridor is lower than
		// the corridor, and nothing downstream could tell. Null is the path
		// every consumer already has (roundedMinAltFt, the nav-log column).
		const lost = ground.missing > 0;
		legMaxFt.push(lost ? null : lMax);
		legMinFt.push(lost ? null : lMin);
		for (let k = 0; k <= alongBins; k++) {
			const distNM = cumNM + (legNM[i] * k) / alongBins;
			// The leg boundary is one station, not two: merge into the entry
			// the previous leg already pushed there.
			const prev = k === 0 ? stations[stations.length - 1] : undefined;
			if (prev && Math.abs(prev.distNM - distNM) < 1e-9) {
				prev.maxFt = maxOf(prev.maxFt, stationMax[k]);
				prev.minFt = minOf(prev.minFt, stationMin[k]);
				continue;
			}
			stations.push({ distNM, maxFt: stationMax[k], minFt: stationMin[k] });
		}
		cumNM += legNM[i];
	}
	return { cells, stations, legMaxFt, legMinFt, legZ: reduced.map((r) => r.z) };
}

function maxOf(a: number | null, b: number | null): number | null {
	if (a == null) {
		return b;
	}
	if (b == null) {
		return a;
	}
	return Math.max(a, b);
}

function minOf(a: number | null, b: number | null): number | null {
	if (a == null) {
		return b;
	}
	if (b == null) {
		return a;
	}
	return Math.min(a, b);
}

/** Obstacles culled to the route's corridor bbox once (one flat scan of the
 *  full ~200k set), so the per-leg distance test runs on a small candidate
 *  set. Pure. */
function corridorObstacles(
	waypoints: LatLon[],
	obstacles: Obstacle[],
	halfWidthNM: number,
): Obstacle[] {
	const bbox = routeCorridorBbox(waypoints, halfWidthNM);
	if (!bbox) {
		return [];
	}
	return obstacles.filter(
		(o) =>
			o.elev != null &&
			o.lat >= bbox.minLat &&
			o.lat <= bbox.maxLat &&
			o.lon >= bbox.minLon &&
			o.lon <= bbox.maxLon,
	);
}

/** Each leg's clearance margin (ft): the flight-rules figure made
 *  terrain-aware from the corridor's own ground stats when `opts.vfr` is set,
 *  else the caller's flat margin. Pure. */
function legMargins(ground: CorridorGround, legs: number, opts: MinAltitudeOpts): number[] {
	const marginFt = opts.marginFt ?? MARGIN_FT;
	const out = new Array<number>(legs).fill(marginFt);
	if (opts.vfr === undefined) {
		return out;
	}
	for (let i = 0; i < legs; i++) {
		out[i] = msaMarginForTerrainFt(opts.vfr, ground.legMaxFt[i] ?? null, ground.legMinFt[i] ?? null);
	}
	return out;
}

/** Per-leg minimum safe altitude (ft) from an already-read corridor: the
 *  highest ground in the capsule, the tallest obstacle top in it, and the
 *  flight-rules margin, rounded up to the next 100 ft. Pure. */
export function minAltitudesFrom(
	waypoints: LatLon[],
	obstacles: Obstacle[],
	ground: CorridorGround,
	opts: MinAltitudeOpts = {},
): (number | null)[] {
	const halfWidthNM = opts.halfWidthNM ?? HALF_WIDTH_NM;
	const n = waypoints.length;
	if (n < 2) {
		return [];
	}
	const candidates = corridorObstacles(waypoints, obstacles, halfWidthNM);
	const margins = legMargins(ground, n - 1, opts);
	const out: (number | null)[] = [];
	for (let i = 0; i + 1 < n; i++) {
		const obst = maxObstacleTopFt(waypoints[i], waypoints[i + 1], candidates, halfWidthNM);
		out.push(roundedMinAltFt(ground.legMaxFt[i] ?? null, obst, margins[i]));
	}
	return out;
}

/** Per-leg minimum safe altitude (ft), one entry per leg (waypoints.length - 1).
 *  Ground is the highest pixel of the leg's capsule (async); obstacles are the
 *  tallest top within it. A leg with neither terrain nor obstacle data is
 *  null. */
export async function computeMinAltitudes(
	waypoints: LatLon[],
	obstacles: Obstacle[],
	opts: MinAltitudeOpts = {},
): Promise<(number | null)[]> {
	if (waypoints.length < 2) {
		return [];
	}
	const ground = await computeCorridorGround(waypoints, opts);
	if (opts.signal?.aborted) {
		return [];
	}
	return minAltitudesFrom(waypoints, obstacles, ground, opts);
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
 *  the planned level busts the `marginFt` clearance floor. A terrain cell
 *  offends on the HIGHEST ground inside its own quad, not on the point in the
 *  middle of it; each in-corridor obstacle whose top alone exceeds the leg
 *  altitude adds a small marker cell. Pure fold of `computeCorridorGround`, so
 *  the patches and the MSA column read the same pass. */
export function dangerCellsFrom(
	waypoints: (LatLon & { alt: number })[],
	obstacles: Obstacle[],
	ground: CorridorGround,
	opts: MinAltitudeOpts = {},
): DangerCell[] {
	const halfWidthNM = opts.halfWidthNM ?? HALF_WIDTH_NM;
	const n = waypoints.length;
	if (n < 2) {
		return [];
	}
	const margins = legMargins(ground, n - 1, opts);
	const out: DangerCell[] = [];

	// Terrain: a cell offends when its ground + margin tops the leg's altitude.
	for (const c of ground.cells) {
		if (cellExceedsRoute(c.maxFt, waypoints[c.leg].alt, margins[c.leg])) {
			out.push({ corners: c.cell.corners });
		}
	}

	// Obstacles: a point feature whose top alone exceeds the leg altitude (the
	// terrain in a cell can miss the structure).
	const candidates = corridorObstacles(waypoints, obstacles, halfWidthNM);
	const limitM = halfWidthNM * NM_TO_METERS;
	for (let i = 0; i + 1 < n; i++) {
		const a = waypoints[i];
		const b = waypoints[i + 1];
		for (const o of candidates) {
			if (o.elev == null) {
				continue;
			}
			const minAlt = roundedMinAltFt(null, o.elev, margins[i]);
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

/** The offending corridor cells, reading the terrain for them. Mirrors
 *  `computeMinAltitudes` by construction: both fold the same pass. */
export async function computeMinAltDangerCells(
	waypoints: (LatLon & { alt: number })[],
	obstacles: Obstacle[],
	opts: MinAltitudeOpts = {},
): Promise<DangerCell[]> {
	if (waypoints.length < 2) {
		return [];
	}
	const ground = await computeCorridorGround(waypoints, opts);
	if (opts.signal?.aborted) {
		return [];
	}
	return dangerCellsFrom(waypoints, obstacles, ground, opts);
}
