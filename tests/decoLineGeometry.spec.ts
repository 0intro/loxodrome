/* The boundary lines the decoration paint strokes (decoPaint.ts, its line
 * pass) against the ones Leaflet 1.9.4 strokes, run on Leaflet itself in
 * Node (tests/helpers/leafletNode.ts):
 *   - the same dash as Leaflet's canvas renderer sets for a path's
 *     `dashArray` (Canvas._updateDashArray, then _fillStroke's fallback to a
 *     solid line), for every dash the symbology publishes at every zoom
 *     factor, the factor applied the way the resting style applied it, part
 *     by part through a string;
 *   - the same simplification as LineUtil.simplify, vertex for vertex, on
 *     rings of every shape a dataset carries: repeated vertices, straight
 *     runs, spikes, a coastline of 21 000 vertices; and that coastline's line
 *     within the distance Leaflet's own two stages allow of every vertex. */

import { describe, expect, it } from 'vitest';
import { installLeafletNode } from './helpers/leafletNode';

installLeafletNode();
const L = (await import('leaflet')).default;
const { parseDash, simplifyLine } = await import('$lib/map/decoGeometry');
const { lineZoomFactor, symbolFor } = await import('$lib/map/airspaceSymbology');

/** The dash Leaflet's canvas renderer strokes a path with. */
function leafletDash(dashArray: string | undefined): number[] {
	const layer: { options: { dashArray?: string | undefined; _dashArray?: number[] | undefined } } = { options: { dashArray } };
	(L.Canvas.prototype as unknown as { _updateDashArray(l: unknown): void })._updateDashArray(layer);
	return layer.options._dashArray ?? [];
}

/** The resting style's dash at a zoom factor, as it was written: each part
 *  scaled through a string (airspaceLayer's baseStyle). */
function scaledStyleDash(dash: string, factor: number): string {
	return dash
		.split(' ')
		.map((v) => String(Number(v) * factor))
		.join(' ');
}

describe('parseDash', () => {
	it('reads a dash as Leaflet does, a malformed one as a solid line', () => {
		for (const dash of ['21 4', '0.1 7', '10 4 3 4', '12 4 2 4 2 4', '5,5', '5, 5', '6  2', 'x 4', '4 y', undefined]) {
			expect(parseDash(dash), String(dash)).toEqual(leafletDash(dash));
		}
		expect(parseDash('x 4')).toEqual([]);
	});

	it('scales every published dash exactly as the scaled style string did, at every zoom', () => {
		const dashes = new Set<string>();
		for (const type of ['CTR', 'ATZ', 'TMZ', 'RMZ', 'TMZ-RMZ', 'ADIZ', 'TMA', 'R', 'P', 'FIR', 'TRA']) {
			const d = symbolFor({ type, airClass: 'D', subtype: '', source: 'fr', id: 'X', upper: null }).line?.dashArray;
			if (d) {
				dashes.add(d);
			}
		}
		expect(dashes.size).toBeGreaterThanOrEqual(4);
		for (const dash of dashes) {
			for (let zoom = 5; zoom <= 15; zoom++) {
				const f = lineZoomFactor(zoom);
				const style = f === 1 ? dash : scaledStyleDash(dash, f);
				expect(parseDash(dash, f), `${dash} z${zoom}`).toEqual(leafletDash(style));
			}
		}
	});
});

/** A seeded generator, so a failing ring can be looked at again. */
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A closed ring of `n` whole-pixel vertices round (cx, cy): a radius that
 *  wanders, the way a coastline does, with a vertex repeated now and then. */
function coastline(n: number, radius: number, seed: number): Float64Array {
	const rnd = prng(seed);
	const out = new Float64Array(n * 2);
	let r = radius;
	for (let i = 0; i < n; i++) {
		r = Math.max(radius * 0.5, Math.min(radius * 1.5, r + (rnd() - 0.5) * radius * 0.02));
		const a = (2 * Math.PI * i) / n;
		const repeat = i > 0 && rnd() < 0.05;
		out[2 * i] = repeat ? out[2 * i - 2] : Math.round(50_000 + r * Math.cos(a));
		out[2 * i + 1] = repeat ? out[2 * i - 1] : Math.round(40_000 + r * Math.sin(a));
	}
	return out;
}

/** Leaflet's own simplification of a flat ring, flat. */
function leafletSimplify(pts: Float64Array, tolerance: number): number[] {
	const points: L.Point[] = [];
	for (let i = 0; i < pts.length; i += 2) {
		points.push(L.point(pts[i], pts[i + 1]));
	}
	return L.LineUtil.simplify(points, tolerance).flatMap((p) => [p.x, p.y]);
}

/** The largest distance of any vertex of `ring` from the closed polyline `line`. */
function farthest(ring: Float64Array, line: Float64Array): number {
	let worst = 0;
	const m = line.length / 2;
	for (let i = 0; i < ring.length; i += 2) {
		let best = Infinity;
		for (let k = 0; k < m; k++) {
			const ax = line[2 * k];
			const ay = line[2 * k + 1];
			const bx = line[(2 * k + 2) % line.length];
			const by = line[(2 * k + 3) % line.length];
			const dx = bx - ax;
			const dy = by - ay;
			const dot = dx * dx + dy * dy;
			const t = dot > 0 ? Math.max(0, Math.min(1, ((ring[i] - ax) * dx + (ring[i + 1] - ay) * dy) / dot)) : 0;
			best = Math.min(best, Math.hypot(ring[i] - (ax + t * dx), ring[i + 1] - (ay + t * dy)));
		}
		worst = Math.max(worst, best);
	}
	return worst;
}

describe('simplifyLine', () => {
	it('keeps the very vertices LineUtil.simplify keeps', () => {
		const rings: Float64Array[] = [
			// A square with a straight run along one side and a spike.
			Float64Array.from([0, 0, 10, 0, 20, 0, 30, 0, 30, 30, 15, 31, 16, 60, 17, 31, 0, 30]),
			// Repeated vertices, and a vertex within the tolerance of the last kept.
			Float64Array.from([5, 5, 5, 5, 6, 5, 40, 5, 40, 5, 40, 41, 5, 40, 5, 6]),
			// Too short to simplify.
			Float64Array.from([0, 0, 1, 1]),
		];
		for (let seed = 1; seed <= 12; seed++) {
			rings.push(coastline(50 + seed * 97, 30 + seed * 40, seed));
		}
		for (const ring of rings) {
			for (const tolerance of [1, 2.5]) {
				expect([...simplifyLine(ring, tolerance)], `${ring.length / 2} vertices, ${tolerance}`).toEqual(leafletSimplify(ring, tolerance));
			}
		}
	});

	it('draws a 21 000 vertex coastline close to every vertex, as Leaflet does', () => {
		// Some 600 px across, as the Cadiz row is at a planning zoom: several
		// vertices to a pixel of its outline.
		const ring = coastline(21_131, 600, 7);
		const line = simplifyLine(ring, 1);
		expect([...line]).toEqual(leafletSimplify(ring, 1));
		expect(line.length / 2).toBeLessThan(ring.length / 4);
		// The two stages each move a vertex by up to the tolerance.
		expect(farthest(ring, line)).toBeLessThanOrEqual(2);
	});
});
