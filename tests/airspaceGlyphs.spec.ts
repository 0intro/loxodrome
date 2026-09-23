/* Pins for the generated activity-glyph artwork (activityGlyphData.ts,
 * extracted from the SIA's vector chart by local/glyphs/extract.py): every
 * kind present, every path parseable and inside the unit frame, the per-kind
 * part inventory stable. Shape fidelity itself is verified visually against
 * the source chart (docs/airspace-symbology.md); these tests catch a broken
 * or accidentally edited regeneration. */

import { describe, it, expect } from 'vitest';
import { GLYPH_ART, type GlyphPart } from '$lib/map/activityGlyphData';

const KINDS = [
	'parachute',
	'aerobatics',
	'glider',
	'paraglider',
	'balloon',
	'modelAircraft',
	'drone',
	'ulm',
] as const;

/** Tokenize and sample the generator's path data (absolute M/L/C/Z only):
 *  points ON the outline, cubics sampled, control points excluded (a Bezier
 *  hull may legitimately bow past the curve). */
function samplePath(d: string): number[] {
	const pts: number[] = [];
	let consumed = 0;
	let cx = 0;
	let cy = 0;
	for (const m of d.matchAll(/([MLCZ])([^MLCZ]*)/g)) {
		consumed += m[0].length;
		const args = (m[2].trim().match(/-?\d+\.?\d*/g) ?? []).map(Number);
		const cmd = m[1] as 'M' | 'L' | 'C' | 'Z';
		const want = { M: 2, L: 2, C: 6, Z: 0 }[cmd];
		expect(
			want === 0 ? args.length : args.length % want,
			`${cmd} args in ${d.slice(0, 30)}`,
		).toBe(0);
		if (cmd !== 'Z') {
			expect(args.length).toBeGreaterThan(0);
		}
		if (cmd === 'M' || cmd === 'L') {
			for (let i = 0; i < args.length; i += 2) {
				cx = args[i]!;
				cy = args[i + 1]!;
				pts.push(cx, cy);
			}
		} else if (cmd === 'C') {
			for (let i = 0; i < args.length; i += 6) {
				const [x1, y1, x2, y2, x3, y3] = args.slice(i, i + 6) as [
					number, number, number, number, number, number,
				];
				for (const t of [0.25, 0.5, 0.75, 1]) {
					const u = 1 - t;
					pts.push(
						u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
						u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
					);
				}
				cx = x3;
				cy = y3;
			}
		}
	}
	expect(consumed, 'unparsed path data').toBe(d.length);
	return pts;
}

function bound(parts: GlyphPart[]): number {
	let b = 0;
	for (const p of parts) {
		for (const v of samplePath(p.d)) {
			b = Math.max(b, Math.abs(v));
		}
	}
	return b;
}

describe('activity glyph artwork', () => {
	it('carries every kind', () => {
		expect(Object.keys(GLYPH_ART).sort()).toEqual([...KINDS].sort());
	});

	it.each(KINDS)('%s parses and stays in the unit frame', (kind) => {
		const art = GLYPH_ART[kind];
		const ink = art.parts.filter((p) => !p.knockout);
		const knock = art.parts.filter((p) => p.knockout);
		expect(ink.length).toBeGreaterThan(0);
		expect(ink.some((p) => p.op === 'fill')).toBe(true);
		// The frame is normalized to the ink; backing whites may overflow it
		// a little (control points may also bow slightly past the extrema).
		expect(bound(ink)).toBeLessThanOrEqual(1.05);
		if (knock.length) {
			expect(bound(knock)).toBeLessThanOrEqual(1.25);
		}
		for (const p of art.parts) {
			if (p.op === 'stroke') {
				expect(p.lw, 'stroke width').toBeGreaterThan(0);
				expect(p.lw).toBeLessThanOrEqual(0.2);
			} else {
				expect(p.lw).toBeUndefined();
			}
		}
		expect(art.halfW).toBeGreaterThan(0);
		expect(art.halfH).toBeGreaterThan(0);
		expect(Math.max(art.halfW, art.halfH)).toBeCloseTo(1, 2);
	});

	it('keeps the extracted part inventory (fills / strokes / knockouts)', () => {
		const inventory = Object.fromEntries(
			Object.entries(GLYPH_ART).map(([kind, art]) => [
				kind,
				{
					fills: art.parts.filter((p) => p.op === 'fill' && !p.knockout).length,
					strokes: art.parts.filter((p) => p.op === 'stroke' && !p.knockout).length,
					knockouts: art.parts.filter((p) => p.knockout).length,
				},
			]),
		);
		// The five Legende2026 pictograms are 600 dpi raster traces: ONE
		// even-odd fill each (outer contours plus interior holes in a single
		// part). The 250k-sourced paraglider / drone / ulm keep their vector
		// parts.
		expect(inventory).toEqual({
			parachute: { fills: 1, strokes: 0, knockouts: 0 },
			aerobatics: { fills: 1, strokes: 0, knockouts: 0 },
			glider: { fills: 1, strokes: 0, knockouts: 0 },
			paraglider: { fills: 6, strokes: 8, knockouts: 3 },
			balloon: { fills: 1, strokes: 0, knockouts: 0 },
			modelAircraft: { fills: 1, strokes: 0, knockouts: 0 },
			drone: { fills: 4, strokes: 0, knockouts: 0 },
			ulm: { fills: 4, strokes: 1, knockouts: 4 },
		});
	});
});
