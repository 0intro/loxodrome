/* decoGeometry.ts holds the pure screen-space geometry behind
 * airspaceDecoLayer.ts: ring orientation metrics (which way is "inside"),
 * an arc-length walker that places evenly spaced samples along a projected
 * ring (FIR comb ticks, SIV squares), an interior anchor for glyphs and
 * labels, and the vertex decimation step for oversampled rings. Operates on
 * flat [x0, y0, x1, y1, ...] arrays of container-pixel coordinates; no
 * Leaflet, no DOM, so tests/decoGeometry.spec.ts runs it in node. */

export interface RingMetrics {
	/** Shoelace signed area in screen coordinates (y grows downward). */
	signedArea: number;
	/** Multiplier turning the left normal of the travel direction into the
	 *  inward normal; robust to either ring winding. */
	inwardSign: 1 | -1;
	perimeter: number;
}

/** Signed area, inward sign and perimeter of a closed ring. */
export function ringMetrics(pts: ArrayLike<number>): RingMetrics {
	const n = pts.length;
	let area2 = 0;
	let perimeter = 0;
	for (let i = 0; i < n; i += 2) {
		const x0 = pts[i];
		const y0 = pts[i + 1];
		const x1 = pts[(i + 2) % n];
		const y1 = pts[(i + 3) % n];
		area2 += x0 * y1 - x1 * y0;
		perimeter += Math.hypot(x1 - x0, y1 - y0);
	}
	// In y-down screen space a screen-clockwise ring has positive shoelace
	// area, and its inward normal is the LEFT normal (-ty, tx) of the travel
	// direction; a counter-clockwise ring flips it.
	return {
		signedArea: area2 / 2,
		inwardSign: area2 >= 0 ? 1 : -1,
		perimeter,
	};
}

export interface WalkSample {
	x: number;
	y: number;
	/** Unit tangent along the travel direction. */
	tx: number;
	ty: number;
	/** Unit inward normal (uses RingMetrics.inwardSign). */
	nx: number;
	ny: number;
}

export interface ClipRect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** Visit evenly spaced samples along a closed ring. `phase` offsets the
 *  first sample from the ring start. Segments entirely outside `clipRect`
 *  are skipped without emitting, but their length still advances the
 *  accumulator, so spacing stays globally even across the skip and the
 *  emitted samples are identical to an unclipped walk. The sample object is
 *  reused between visits (callers must not retain it). */
export function walkRing(
	pts: ArrayLike<number>,
	spacing: number,
	phase: number,
	inwardSign: 1 | -1,
	visit: (s: WalkSample) => void,
	clipRect?: ClipRect,
): void {
	const n = pts.length;
	if (n < 6 || spacing <= 0) {
		return;
	}
	const s: WalkSample = { x: 0, y: 0, tx: 0, ty: 0, nx: 0, ny: 0 };
	// Distance along the ring of the next sample to emit.
	let next = phase;
	let travelled = 0;
	for (let i = 0; i < n; i += 2) {
		const x0 = pts[i];
		const y0 = pts[i + 1];
		const x1 = pts[(i + 2) % n];
		const y1 = pts[(i + 3) % n];
		const dx = x1 - x0;
		const dy = y1 - y0;
		const len = Math.hypot(dx, dy);
		if (len === 0) {
			continue;
		}
		const end = travelled + len;
		if (next < end || next === end) {
			const outside =
				clipRect !== undefined &&
				((x0 < clipRect.x0 && x1 < clipRect.x0) ||
					(x0 > clipRect.x1 && x1 > clipRect.x1) ||
					(y0 < clipRect.y0 && y1 < clipRect.y0) ||
					(y0 > clipRect.y1 && y1 > clipRect.y1));
			if (outside) {
				// Advance past every sample this segment would carry.
				while (next <= end) {
					next += spacing;
				}
			} else {
				const tx = dx / len;
				const ty = dy / len;
				while (next <= end) {
					const d = next - travelled;
					s.x = x0 + tx * d;
					s.y = y0 + ty * d;
					s.tx = tx;
					s.ty = ty;
					s.nx = inwardSign * -ty;
					s.ny = inwardSign * tx;
					visit(s);
					next += spacing;
				}
			}
		}
		travelled = end;
	}
}

/** The chains of a ring NOT covered by the given arcs (which are
 *  vertex-aligned sub-paths of the ring, e.g. Airspace.arcs from cmd/fr):
 *  the INTERNAL French FIR boundary runs. Works on [lat, lon] pairs (or
 *  any 2-tuples); segments match by exact value, which holds because the
 *  arcs copy the ring's own vertices. Chains merge across the ring seam. */
export function ringComplement(
	ring: [number, number][],
	arcs: [number, number][][],
): [number, number][][] {
	const n = ring.length;
	if (n < 3) {
		return [];
	}
	const seg = (a: [number, number], b: [number, number]): string =>
		`${a[0]},${a[1]}|${b[0]},${b[1]}`;
	const covered = new Set<string>();
	for (const arc of arcs) {
		for (let i = 0; i + 1 < arc.length; i++) {
			covered.add(seg(arc[i], arc[i + 1]));
		}
	}
	const internal: boolean[] = new Array<boolean>(n);
	let any = false;
	for (let i = 0; i < n; i++) {
		internal[i] = !covered.has(seg(ring[i], ring[(i + 1) % n]));
		any = any || internal[i];
	}
	if (!any) {
		return [];
	}
	if (internal.every(Boolean)) {
		return [[...ring, ring[0]]];
	}
	// Start each chain at an internal edge whose predecessor is external
	// so a run spanning the ring seam comes out as one chain.
	let start = 0;
	for (let i = 0; i < n; i++) {
		if (internal[i] && !internal[(i + n - 1) % n]) {
			start = i;
			break;
		}
	}
	const chains: [number, number][][] = [];
	let i = start;
	let consumed = 0;
	while (consumed < n) {
		if (internal[i]) {
			const chain: [number, number][] = [ring[i]];
			while (consumed < n && internal[i]) {
				chain.push(ring[(i + 1) % n]);
				i = (i + 1) % n;
				consumed++;
			}
			chains.push(chain);
		} else {
			i = (i + 1) % n;
			consumed++;
		}
	}
	return chains;
}

/** Visit evenly spaced samples along an OPEN polyline: the walkRing
 *  sibling for the FIR external arcs. Same phase / clipping semantics,
 *  but no closing chord: the walk ends at the last vertex, so a tick can
 *  never bridge the arc's endpoints. The sample object is reused between
 *  visits (callers must not retain it). */
export function walkPolyline(
	pts: ArrayLike<number>,
	spacing: number,
	phase: number,
	inwardSign: 1 | -1,
	visit: (s: WalkSample) => void,
	clipRect?: ClipRect,
): void {
	const n = pts.length;
	if (n < 4 || spacing <= 0) {
		return;
	}
	const s: WalkSample = { x: 0, y: 0, tx: 0, ty: 0, nx: 0, ny: 0 };
	let next = phase;
	let travelled = 0;
	for (let i = 0; i + 3 < n; i += 2) {
		const x0 = pts[i];
		const y0 = pts[i + 1];
		const x1 = pts[i + 2];
		const y1 = pts[i + 3];
		const dx = x1 - x0;
		const dy = y1 - y0;
		const len = Math.hypot(dx, dy);
		if (len === 0) {
			continue;
		}
		const end = travelled + len;
		if (next < end || next === end) {
			const outside =
				clipRect !== undefined &&
				((x0 < clipRect.x0 && x1 < clipRect.x0) ||
					(x0 > clipRect.x1 && x1 > clipRect.x1) ||
					(y0 < clipRect.y0 && y1 < clipRect.y0) ||
					(y0 > clipRect.y1 && y1 > clipRect.y1));
			if (outside) {
				while (next <= end) {
					next += spacing;
				}
			} else {
				const tx = dx / len;
				const ty = dy / len;
				while (next <= end) {
					const d = next - travelled;
					s.x = x0 + tx * d;
					s.y = y0 + ty * d;
					s.tx = tx;
					s.ty = ty;
					s.nx = inwardSign * -ty;
					s.ny = inwardSign * tx;
					visit(s);
					next += spacing;
				}
			}
		}
		travelled = end;
	}
}

/** Ray-casting point-in-ring test on a flat screen-space ring. */
export function pointInRingXY(
	pts: ArrayLike<number>,
	x: number,
	y: number,
): boolean {
	const n = pts.length;
	let inside = false;
	for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
		const xi = pts[i];
		const yi = pts[i + 1];
		const xj = pts[j];
		const yj = pts[j + 1];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}

/** Interior anchor for a glyph / label: the ring centroid when it lies
 *  inside, else the midpoint of the widest interior run on the horizontal
 *  scanline through the bbox vertical centre (concave U / L shapes), else
 *  the bbox centre. Deterministic and O(n); full pole-of-inaccessibility is
 *  overkill at map-symbol sizes. */
export function anchorPoint(pts: ArrayLike<number>): { x: number; y: number } {
	const n = pts.length;
	let area2 = 0;
	let cx = 0;
	let cy = 0;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (let i = 0; i < n; i += 2) {
		const x0 = pts[i];
		const y0 = pts[i + 1];
		const x1 = pts[(i + 2) % n];
		const y1 = pts[(i + 3) % n];
		const w = x0 * y1 - x1 * y0;
		area2 += w;
		cx += (x0 + x1) * w;
		cy += (y0 + y1) * w;
		if (x0 < minX) minX = x0;
		if (x0 > maxX) maxX = x0;
		if (y0 < minY) minY = y0;
		if (y0 > maxY) maxY = y0;
	}
	if (area2 !== 0) {
		cx /= 3 * area2;
		cy /= 3 * area2;
		if (pointInRingXY(pts, cx, cy)) {
			return { x: cx, y: cy };
		}
	}
	// Scanline fallback: intersect the ring with y = bbox centre, take the
	// midpoint of the widest [crossing, crossing] interval.
	const y = (minY + maxY) / 2;
	const xs: number[] = [];
	for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
		const xi = pts[i];
		const yi = pts[i + 1];
		const xj = pts[j];
		const yj = pts[j + 1];
		if (yi > y !== yj > y) {
			xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
		}
	}
	if (xs.length >= 2) {
		xs.sort((a, b) => a - b);
		let bestW = -1;
		let bestX = (minX + maxX) / 2;
		for (let i = 0; i + 1 < xs.length; i += 2) {
			const w = xs[i + 1] - xs[i];
			if (w > bestW) {
				bestW = w;
				bestX = (xs[i] + xs[i + 1]) / 2;
			}
		}
		return { x: bestX, y };
	}
	return { x: (minX + maxX) / 2, y };
}

/** One 45-degree fringe stripe in screen space (see hatchStripes). */
export interface HatchStripe {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	/** Signed distance of the line from the screen origin along the stripe
	 *  normal (1, sign)/sqrt2; k * pitch - c0 by construction. */
	c: number;
}

/** Phase constant anchoring a 45-degree stripe family to PROJECTED map
 *  space: the normal coordinate of the viewport top-left in projected
 *  pixels (Leaflet's origin + topLeft; the pixel origin alone is
 *  pan-invariant, which would leave the stripes screen-anchored and
 *  re-phasing against the zones on every pan). With this c0 every stripe's
 *  PROJECTED normal coordinate is an exact multiple of the pitch, so the
 *  pattern stays put while panning (pinned in tests/decoGeometry.spec.ts). */
export function hatchPhase(
	topLeftProjX: number,
	topLeftProjY: number,
	sign: 1 | -1,
): number {
	return (topLeftProjX + sign * topLeftProjY) * Math.SQRT1_2;
}

/** The stripe family covering a (sizeX x sizeY) viewport: lines along
 *  (1, -sign)/sqrt2 (135 degrees y-down for sign 1, the chart's "/"
 *  stripes) every `pitch` px along the normal (1, sign)/sqrt2, phased by
 *  `c0` (hatchPhase). The normal-coordinate range is the min/max over ALL
 *  FOUR viewport corners: for sign -1 the extremes sit at (0, H) and
 *  (W, 0), which a min/max of only (0, 0) and (W, H) never reaches,
 *  leaving most of the crosshatch's second family undrawn (the old bug,
 *  pinned as a regression case in tests/decoGeometry.spec.ts). */
export function hatchStripes(
	sizeX: number,
	sizeY: number,
	sign: 1 | -1,
	pitch: number,
	c0: number,
): HatchStripe[] {
	const inv = Math.SQRT1_2;
	const cCorners = [0, sizeX * inv, sign * sizeY * inv, (sizeX + sign * sizeY) * inv];
	const cMin = Math.min(...cCorners) - pitch;
	const cMax = Math.max(...cCorners) + pitch;
	const kMin = Math.floor((cMin + c0) / pitch);
	const kMax = Math.ceil((cMax + c0) / pitch);
	const ext = sizeX + sizeY;
	const out: HatchStripe[] = [];
	for (let k = kMin; k <= kMax; k++) {
		const c = k * pitch - c0;
		const px = c * inv;
		const py = c * inv * sign;
		out.push({
			x0: px - ext * inv,
			y0: py + ext * inv * sign,
			x1: px + ext * inv,
			y1: py - ext * inv * sign,
			c,
		});
	}
	return out;
}

/** The repeating tile a CanvasPattern paints the hatch with, instead of
 *  stroking every hatchStripes line across the canvas.
 *
 *  A 45-degree family `pitch` px apart along its normal repeats every
 *  pitch * sqrt2 px along BOTH screen axes, and the crosshatch's two
 *  families share that period, so a square tile of a whole number of periods
 *  holds the pattern. The period is rarely a whole number of device pixels
 *  (z8 is 2 * sqrt2 px), and a resampled tile blurs these sub-pixel strokes
 *  (measured: the P crosshatch went pink at DPR 2.75), so the tile is drawn
 *  1:1 in device pixels and spans the number of periods that lands closest
 *  to a whole pixel size within HATCH_TILE_MAX. `error` is what one repeat
 *  of the tile is off the true lattice by; it accumulates across repeats
 *  from the canvas origin, and at the sizes the layer uses it stays under a
 *  few hundredths of a pixel per tile. `pitch` is in device pixels. */
export interface HatchTile {
	/** Tile side in device pixels, a whole number. */
	size: number;
	/** How many stripe periods the tile spans on each axis. */
	periods: number;
	/** |size - periods * period|, device px: the drift one repeat adds. */
	error: number;
}

const HATCH_TILE_MAX = 512;

export function hatchTileSize(pitch: number): HatchTile {
	const period = pitch * Math.SQRT2;
	const first = Math.max(1, Math.round(period));
	let best: HatchTile = { size: first, periods: 1, error: Math.abs(first - period) };
	for (let m = 2; m * period <= HATCH_TILE_MAX && best.error > 1e-9; m++) {
		const exact = m * period;
		const size = Math.round(exact);
		const error = Math.abs(size - exact);
		if (error < best.error - 1e-12) {
			best = { size, periods: m, error };
		}
	}
	return best;
}

/** Where a canvas sits in the projected stripe lattice: its top-left corner
 *  (topLeftProjX, topLeftProjY, projected map pixels in CSS px, i.e.
 *  Leaflet's pixel origin plus the canvas's layer position) in device
 *  pixels modulo one period. Both families are periodic in x and y alike, so
 *  the corner reduced this way gives the same stripes as the corner itself;
 *  `pitch` in device px. */
export function hatchTilePhase(
	topLeftProjX: number,
	topLeftProjY: number,
	dpr: number,
	pitch: number,
): { x: number; y: number } {
	const period = pitch * Math.SQRT2;
	const wrap = (v: number) => ((v % period) + period) % period;
	return { x: wrap(topLeftProjX * dpr), y: wrap(topLeftProjY * dpr) };
}

/** The tile's stripes in device pixels for a canvas at `phase`
 *  (hatchTilePhase): exactly the stripes hatchPhase + hatchStripes put on
 *  the canvas's own first tile, so the pattern repeated from the canvas
 *  origin lights the lines the stroked pass lit, anchored to PROJECTED map
 *  space and so still while panning. A stripe leaving one edge re-enters at
 *  the opposite one, the tile spanning whole periods. */
export function hatchTileStripes(
	tile: HatchTile,
	pitch: number,
	signs: readonly (1 | -1)[],
	phase: { x: number; y: number },
): HatchStripe[] {
	const out: HatchStripe[] = [];
	for (const sign of signs) {
		out.push(...hatchStripes(tile.size, tile.size, sign, pitch, hatchPhase(phase.x, phase.y, sign)));
	}
	return out;
}

/** How oversampled a ring is on screen: the stride that would keep roughly
 *  one vertex per 2.5 px of its bbox half-perimeter, at most 1500. Ordinary
 *  rings (median 17-64 vertices) come out at 1 and are projected whole; above
 *  1 (the 21k-vertex ES coastline row, the 2k-vertex FAA rings, a detailed
 *  ring shrunk by a low zoom) the paint takes the ring's line simplified at
 *  1 px instead (simplifyLine), which keeps its shape where a stride would
 *  cut through it. */
export function decimationStep(
	vertexCount: number,
	bboxW: number,
	bboxH: number,
): number {
	const maxVerts = Math.min(1500, Math.max(16, (bboxW + bboxH) / 2.5));
	return Math.max(1, Math.floor(vertexCount / maxVerts));
}

/** A path's `dashArray` as Leaflet's canvas renderer reads it
 *  (Canvas._updateDashArray): split on commas and spaces, each part a number,
 *  and a part that is not one makes the whole line solid. Each length comes
 *  back multiplied by `factor`, the zoom's line factor, which is the number
 *  a style scaled part by part (String(Number(part) * factor)) parsed back
 *  to: a double survives its shortest string exactly. */
export function parseDash(dash: string | undefined, factor = 1): number[] {
	if (dash === undefined) {
		return [];
	}
	const out: number[] = [];
	for (const part of dash.split(/[, ]+/)) {
		const v = Number(part);
		if (Number.isNaN(v)) {
			return [];
		}
		out.push(v * factor);
	}
	return out;
}

/** A ring's line as Leaflet's canvas draws a polygon (Polyline._update):
 *  the vertices in pixels, then simplified at `tolerance` px, first by
 *  dropping each vertex within the tolerance of the last one kept, then by
 *  Douglas-Peucker (LineUtil.simplify, whose every comparison this repeats,
 *  in its order). The first and the last vertex always stay, so a ring keeps
 *  its first vertex, where its dash starts. Leaflet simplifies what its clip
 *  left of the ring; this simplifies the whole ring, in WORLD pixels at the
 *  zoom, so the line does not change as the map pans (a pan only translates
 *  it) and one simplification serves every painting at that zoom. The
 *  Douglas-Peucker split is walked with a stack, not recursion: a 21 000
 *  vertex ring may split deep. Flat [x0, y0, ...] in and out. */
export function simplifyLine(pts: ArrayLike<number>, tolerance = 1): Float64Array {
	const n = pts.length / 2;
	if (n < 3 || tolerance <= 0) {
		return Float64Array.from(pts);
	}
	const sq = tolerance * tolerance;
	// Stage 1, vertex reduction (LineUtil._reducePoints).
	const keep: number[] = [0];
	let prev = 0;
	for (let i = 1; i < n; i++) {
		const dx = pts[2 * i] - pts[2 * prev];
		const dy = pts[2 * i + 1] - pts[2 * prev + 1];
		if (dx * dx + dy * dy > sq) {
			keep.push(i);
			prev = i;
		}
	}
	if (prev < n - 1) {
		keep.push(n - 1);
	}
	// Stage 2, Douglas-Peucker over what stage 1 kept (LineUtil._simplifyDP).
	const m = keep.length;
	const marked = new Uint8Array(m);
	marked[0] = 1;
	marked[m - 1] = 1;
	const stack: number[] = [0, m - 1];
	while (stack.length > 0) {
		const last = stack.pop() as number;
		const first = stack.pop() as number;
		const ax = pts[2 * keep[first]];
		const ay = pts[2 * keep[first] + 1];
		const bx = pts[2 * keep[last]];
		const by = pts[2 * keep[last] + 1];
		let maxSq = 0;
		let index = -1;
		for (let i = first + 1; i <= last - 1; i++) {
			const d = sqSegmentDistance(pts[2 * keep[i]], pts[2 * keep[i] + 1], ax, ay, bx, by);
			if (d > maxSq) {
				index = i;
				maxSq = d;
			}
		}
		if (maxSq > sq) {
			marked[index] = 1;
			stack.push(first, index, index, last);
		}
	}
	let count = 0;
	for (let i = 0; i < m; i++) {
		count += marked[i];
	}
	const out = new Float64Array(count * 2);
	for (let i = 0, o = 0; i < m; i++) {
		if (marked[i]) {
			out[o++] = pts[2 * keep[i]];
			out[o++] = pts[2 * keep[i] + 1];
		}
	}
	return out;
}

/** The squared distance of (px, py) from the segment (ax, ay)-(bx, by),
 *  computed as Leaflet's LineUtil._sqClosestPointOnSegment computes it. */
function sqSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	let x = ax;
	let y = ay;
	let dx = bx - x;
	let dy = by - y;
	const dot = dx * dx + dy * dy;
	if (dot > 0) {
		const t = ((px - x) * dx + (py - y) * dy) / dot;
		if (t > 1) {
			x = bx;
			y = by;
		} else if (t > 0) {
			x += dx * t;
			y += dy * t;
		}
	}
	dx = px - x;
	dy = py - y;
	return dx * dx + dy * dy;
}

/** The length along a closed ring (flat) from its first vertex to each
 *  vertex, and last to the first vertex again, round the closing segment:
 *  n + 1 values, the last the perimeter. Where the dash of a stroke from the
 *  first vertex stands at each vertex. */
export function cumulativeLengths(pts: ArrayLike<number>): Float64Array {
	const n = pts.length / 2;
	const out = new Float64Array(n + 1);
	for (let i = 1; i <= n; i++) {
		const a = i - 1;
		const b = i % n;
		out[i] = out[i - 1] + Math.hypot(pts[2 * b] - pts[2 * a], pts[2 * b + 1] - pts[2 * a + 1]);
	}
	return out;
}

/** The runs of a closed ring (flat) that reach `clip`: the maximal chains of
 *  consecutive segments whose bounding box meets the rectangle, each as the
 *  vertex it starts at and the one it ends at, the end counted past the last
 *  vertex when the run goes round the ring's seam (vertex i + n is vertex
 *  i). A run's ends lie outside the rectangle, being the far vertices of
 *  segments that miss it, so a stroke's caps there never show. Null when
 *  every segment reaches it: stroke the ring whole. */
export function clipRuns(pts: ArrayLike<number>, clip: ClipRect): [number, number][] | null {
	const n = pts.length / 2;
	const reaches = (i: number): boolean => {
		const x0 = pts[2 * i];
		const y0 = pts[2 * i + 1];
		const x1 = pts[2 * ((i + 1) % n)];
		const y1 = pts[2 * ((i + 1) % n) + 1];
		return !(
			(x0 < clip.x0 && x1 < clip.x0) ||
			(x0 > clip.x1 && x1 > clip.x1) ||
			(y0 < clip.y0 && y1 < clip.y0) ||
			(y0 > clip.y1 && y1 > clip.y1)
		);
	};
	let away = -1;
	for (let i = 0; i < n && away < 0; i++) {
		if (!reaches(i)) {
			away = i;
		}
	}
	if (away < 0) {
		return null;
	}
	const runs: [number, number][] = [];
	let start = -1;
	// From the segment after one that misses, round to it: no run is cut
	// by where the walk starts.
	for (let k = 1; k <= n; k++) {
		const i = (away + k) % n;
		const seg = away + k;
		if (reaches(i)) {
			if (start < 0) {
				start = seg;
			}
		} else if (start >= 0) {
			runs.push(norm(start, seg, n));
			start = -1;
		}
	}
	return runs;
}

/** A run from segment `first` (a vertex) to vertex `end`, both counted from
 *  an arbitrary walk start, brought to a start in [0, n). */
function norm(first: number, end: number, n: number): [number, number] {
	const s = first % n;
	return [s, s + (end - first)];
}
