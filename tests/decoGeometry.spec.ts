/* Unit tests for the decoration-layer geometry: the arc-length ring walker
 * (even spacing across vertices, inward normals for either winding, phase
 * continuity across viewport-clipped segments), the interior anchor, and the
 * vertex decimation step. */

import { describe, it, expect } from 'vitest';
import {
	ringMetrics,
	ringComplement,
	walkRing,
	walkPolyline,
	anchorPoint,
	pointInRingXY,
	decimationStep,
	hatchPhase,
	hatchStripes,
	type WalkSample,
} from '$lib/map/decoGeometry';

// A 40x40 square at (0,0)..(40,40), screen-clockwise (y grows downward).
const SQUARE_CW = [0, 0, 40, 0, 40, 40, 0, 40];
// The same square wound the other way.
const SQUARE_CCW = [0, 0, 0, 40, 40, 40, 40, 0];

function collect(
	pts: number[],
	spacing: number,
	phase: number,
	clip?: { x0: number; y0: number; x1: number; y1: number },
): WalkSample[] {
	const m = ringMetrics(pts);
	const out: WalkSample[] = [];
	walkRing(pts, spacing, phase, m.inwardSign, (s) => out.push({ ...s }), clip);
	return out;
}

describe('ringMetrics', () => {
	it('signs the shoelace area by winding and measures the perimeter', () => {
		const cw = ringMetrics(SQUARE_CW);
		expect(cw.signedArea).toBe(1600);
		expect(cw.inwardSign).toBe(1);
		expect(cw.perimeter).toBe(160);
		const ccw = ringMetrics(SQUARE_CCW);
		expect(ccw.signedArea).toBe(-1600);
		expect(ccw.inwardSign).toBe(-1);
		expect(ccw.perimeter).toBe(160);
	});
});

describe('walkRing', () => {
	it('places evenly spaced samples across corners', () => {
		const samples = collect(SQUARE_CW, 10, 5);
		// Perimeter 160, spacing 10, phase 5 -> 16 samples.
		expect(samples).toHaveLength(16);
		// The 4th sample (arc length 35) sits on the top edge; the 5th (45)
		// has wrapped the (40,0) corner onto the right edge at y=5.
		expect(samples[3]).toMatchObject({ x: 35, y: 0 });
		expect(samples[4]).toMatchObject({ x: 40, y: 5 });
	});
	it('points the normal inward for either winding', () => {
		// Top edge of the CW square: travel +x, inside is +y (down).
		const cw = collect(SQUARE_CW, 10, 5)[0];
		expect(cw.y).toBe(0);
		expect(cw.nx).toBeCloseTo(0);
		expect(cw.ny).toBeCloseTo(1);
		// Same square CCW: the top edge is travelled -x; inward must still
		// be +y.
		const top = collect(SQUARE_CCW, 10, 5).filter((s) => s.y === 0);
		expect(top.length).toBeGreaterThan(0);
		for (const s of top) {
			expect(s.nx).toBeCloseTo(0);
			expect(s.ny).toBeCloseTo(1);
		}
	});
	it('keeps phase across clipped-out segments', () => {
		const all = collect(SQUARE_CW, 10, 5);
		// Clip rect excluding the right and bottom edges entirely (the left
		// edge shares a corner with the kept top edge, so the conservative
		// segment-level test keeps it). The surviving samples must sit
		// exactly where the unclipped walk put them.
		const clipped = collect(SQUARE_CW, 10, 5, { x0: -5, y0: -5, x1: 38, y1: 38 });
		const kept = all.filter((s) => s.y === 0 || s.x === 0);
		expect(clipped).toEqual(kept);
		expect(clipped).toHaveLength(8);
	});
	it('emits floor(perimeter / spacing) samples regardless of vertex layout', () => {
		// The same square with a redundant mid-edge vertex.
		const split = [0, 0, 20, 0, 40, 0, 40, 40, 0, 40];
		expect(collect(split, 10, 5)).toHaveLength(16);
		expect(collect(split, 7, 0).length).toBe(Math.floor(160 / 7) + 1);
	});
});

describe('anchorPoint', () => {
	it('uses the centroid when it lies inside', () => {
		expect(anchorPoint(SQUARE_CW)).toEqual({ x: 20, y: 20 });
	});
	it('falls back inside concave rings whose centroid is outside', () => {
		// A U shape: 40 wide, 40 tall, with a 20-wide notch cut from the top
		// down to y=30. The centroid sits in the notch (outside).
		const u = [0, 0, 10, 0, 10, 30, 30, 30, 30, 0, 40, 0, 40, 40, 0, 40];
		const a = anchorPoint(u);
		expect(pointInRingXY(u, a.x, a.y)).toBe(true);
	});
});

describe('hatchStripes', () => {
	const INV = Math.SQRT1_2;
	const W = 800;
	const H = 600;
	const PITCH = 7;

	/** Normal coordinate of a point for the given stripe family. */
	const nCoord = (x: number, y: number, sign: 1 | -1) => (x + sign * y) * INV;

	it('runs each stripe at 45 degrees with the family orientation', () => {
		for (const sign of [1, -1] as const) {
			for (const l of hatchStripes(W, H, sign, PITCH, 0)) {
				// Direction (1, -sign)/sqrt2: equal |dx| and |dy|, opposite
				// slope between the two families.
				expect(Math.abs(l.x1 - l.x0)).toBeCloseTo(Math.abs(l.y1 - l.y0), 9);
				expect(Math.sign(l.y1 - l.y0)).toBe(-sign * Math.sign(l.x1 - l.x0));
				// Both endpoints share the stripe's normal coordinate c.
				expect(nCoord(l.x0, l.y0, sign)).toBeCloseTo(l.c, 6);
				expect(nCoord(l.x1, l.y1, sign)).toBeCloseTo(l.c, 6);
			}
		}
	});

	it('covers all four viewport corners for either sign (the old bug)', () => {
		// The regression: ranging over only the (0, 0) and (W, H) corners
		// left the sign -1 family's extremes at (0, H) and (W, 0) unreached,
		// so most of the crosshatch's second diagonal never drew.
		for (const sign of [1, -1] as const) {
			const cs = hatchStripes(W, H, sign, PITCH, 3.21).map((l) => l.c);
			const corners = [
				nCoord(0, 0, sign),
				nCoord(W, 0, sign),
				nCoord(0, H, sign),
				nCoord(W, H, sign),
			];
			expect(Math.min(...cs)).toBeLessThanOrEqual(Math.min(...corners));
			expect(Math.max(...cs)).toBeGreaterThanOrEqual(Math.max(...corners));
			// Consecutive stripes sit exactly one pitch apart, so the whole
			// corner range is tiled, not just straddled.
			const sorted = [...cs].sort((a, b) => a - b);
			for (let i = 1; i < sorted.length; i++) {
				expect(sorted[i] - sorted[i - 1]).toBeCloseTo(PITCH, 6);
			}
		}
	});

	it('anchors the phase to projected space, pan-invariantly', () => {
		// For any viewport top-left T (projected px), every stripe's
		// PROJECTED normal coordinate is an exact multiple of the pitch:
		// panning changes T and the on-screen stripe positions, but the
		// stripes stay put relative to the map (and to the zones).
		const tops: [number, number][] = [
			[0, 0],
			[12345.5, -678.25],
			[-91.75, 44222],
		];
		for (const sign of [1, -1] as const) {
			for (const [tx, ty] of tops) {
				const c0 = hatchPhase(tx, ty, sign);
				for (const l of hatchStripes(W, H, sign, PITCH, c0)) {
					const projected = nCoord(l.x0 + tx, l.y0 + ty, sign);
					const mod = ((projected % PITCH) + PITCH) % PITCH;
					expect(Math.min(mod, PITCH - mod)).toBeLessThan(1e-6);
				}
			}
		}
	});
});

describe('decimationStep', () => {
	it('projects ordinary rings whole', () => {
		expect(decimationStep(64, 200, 150)).toBe(1);
		expect(decimationStep(1200, 4000, 3000)).toBe(1);
	});
	it('decimates monster rings on small screen extents', () => {
		expect(decimationStep(21307, 40, 40)).toBeGreaterThan(600);
		expect(decimationStep(2281, 100, 80)).toBeGreaterThan(20);
	});
});

describe('walkPolyline (open arcs)', () => {
	it('samples a straight open line at even spacing from the phase', () => {
		const xs: number[] = [];
		walkPolyline([0, 0, 100, 0], 10, 5, 1, (s) => xs.push(s.x));
		expect(xs).toEqual([5, 15, 25, 35, 45, 55, 65, 75, 85, 95]);
	});

	it('crosses corners but never wraps past the last vertex', () => {
		// L-shape 100 + 50 px, spacing 40, phase 20: the 140 px sample lands
		// on the second leg; nothing bridges the open ends.
		const got: Array<[number, number]> = [];
		walkPolyline([0, 0, 100, 0, 100, 50], 40, 20, 1, (s) => got.push([s.x, s.y]));
		expect(got).toEqual([
			[20, 0],
			[60, 0],
			[100, 0],
			[100, 40],
		]);
	});

	it('keeps the walkRing normal convention', () => {
		const ns: Array<[number, number]> = [];
		walkPolyline([0, 0, 100, 0], 50, 25, 1, (s) => ns.push([s.nx, s.ny]));
		expect(ns).toEqual([
			[-0, 1],
			[-0, 1],
		]);
	});

	it('skips clipped segments without losing the accumulated phase', () => {
		const clip = { x0: 150, y0: -10, x1: 250, y1: 10 };
		const xs: number[] = [];
		walkPolyline([0, 0, 100, 0, 200, 0], 30, 15, 1, (s) => xs.push(s.x), clip);
		// 15 / 45 / 75 fall on the fully-clipped first segment and are
		// skipped; the phase continues so the visible run starts at 105.
		expect(xs).toEqual([105, 135, 165, 195]);
	});
});

describe('ringComplement (internal FIR chains)', () => {
	const ring: [number, number][] = [[1, 0], [1, 1], [0, 1], [0, 0]];
	it('returns the chains the arcs do not cover, seam-merged', () => {
		// One arc covering edges 2, 3, 0 (the LFRR shape): the complement is
		// the single shared edge 1.
		const arcs: [number, number][][] = [[[0, 1], [0, 0], [1, 0], [1, 1]]];
		expect(ringComplement(ring, arcs)).toEqual([[[1, 1], [0, 1]]]);
	});
	it('splits into several chains around separate arcs', () => {
		// Two opposite external edges -> two internal chains.
		const arcs: [number, number][][] = [
			[[1, 0], [1, 1]],
			[[0, 1], [0, 0]],
		];
		expect(ringComplement(ring, arcs)).toEqual([
			[[1, 1], [0, 1]],
			[[0, 0], [1, 0]],
		]);
	});
	it('covers the whole ring when there are no arcs', () => {
		expect(ringComplement(ring, [])).toEqual([
			[[1, 0], [1, 1], [0, 1], [0, 0], [1, 0]],
		]);
	});
	it('is empty when the arcs cover everything', () => {
		const arcs: [number, number][][] = [
			[[1, 0], [1, 1], [0, 1], [0, 0], [1, 0]],
		];
		expect(ringComplement(ring, arcs)).toEqual([]);
	});
});
