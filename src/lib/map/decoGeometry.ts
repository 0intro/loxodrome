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

/** Vertex stride for projecting an oversampled ring: keep roughly one vertex
 *  per 2.5 px of bbox half-perimeter, bounded so ordinary rings (median
 *  17-64 vertices) project whole and only monster rings (the 21k-vertex ES
 *  coastline row, 2k-vertex FAA rings) get decimated, with sub-pixel error
 *  at the zoom where the step exceeds 1. */
export function decimationStep(
	vertexCount: number,
	bboxW: number,
	bboxH: number,
): number {
	const maxVerts = Math.min(1500, Math.max(16, (bboxW + bboxH) / 2.5));
	return Math.max(1, Math.floor(vertexCount / maxVerts));
}
