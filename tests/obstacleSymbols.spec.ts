/* Pins for the Legende2026 obstacle symbology: the traced glyph inventory
 * and unit-frame containment (like tests/airspaceGlyphs.spec.ts), the
 * type/height routing, and the single legend ink. Shape fidelity is
 * verified against the legend raster by local/verify-legend. */

import { describe, expect, it } from 'vitest';

import { OBSTACLE_GLYPH_ART } from '../src/lib/map/obstacleGlyphData';
import {
	OBSTACLE_INK,
	obstacleGlyphKind,
	obstacleSymbolSize,
	profileObstacleGlyphPath,
	profileObstacleRaysPath,
} from '../src/lib/map/obstacleSymbols';

describe('obstacle glyph artwork', () => {
	it('keeps the traced part inventory (one even-odd fill per glyph)', () => {
		for (const [kind, art] of Object.entries(OBSTACLE_GLYPH_ART)) {
			expect(art.parts.length, kind).toBe(1);
			expect(art.parts[0].op, kind).toBe('fill');
			expect(art.parts[0].eo, kind).toBe(true);
		}
	});

	it('stays inside the unit frame', () => {
		const NUM = /-?\d+(?:\.\d+)?/g;
		for (const [kind, art] of Object.entries(OBSTACLE_GLYPH_ART)) {
			expect(art.halfW, kind).toBeGreaterThan(0);
			expect(art.halfH, kind).toBeGreaterThan(0);
			expect(Math.max(art.halfW, art.halfH), kind).toBeCloseTo(1, 2);
			for (const part of art.parts) {
				const nums = part.d.match(NUM)!.map(Number);
				for (const v of nums) {
					expect(Math.abs(v), kind).toBeLessThanOrEqual(1.05);
				}
			}
		}
	});
});

describe('obstacle glyph routing', () => {
	it('routes types and heights to the legend glyphs', () => {
		expect(obstacleGlyphKind({ type: 'windturbine', hgt: 800 })).toBe('turbine');
		expect(obstacleGlyphKind({ type: 'lighthouse', hgt: 90 })).toBe('groundLight');
		expect(obstacleGlyphKind({ type: 'pylon', hgt: 350 })).toBe('caret');
		expect(obstacleGlyphKind({ type: 'mast', hgt: 500 })).toBe('towerHigh');
		expect(obstacleGlyphKind({ type: 'antenna', hgt: 1200 })).toBe('towerHigh');
		// Unknown height stays on the low form.
		expect(obstacleGlyphKind({ type: 'chimney', hgt: null })).toBe('caret');
	});

	it('prints in the single legend obstacle ink', () => {
		expect(OBSTACLE_INK).toBe('#164194');
		expect(obstacleSymbolSize()).toBeGreaterThan(0);
	});
});

describe('profile obstacle glyph paths (RouteProfile SVG cousins)', () => {
	// Literal pins: the profile builders live beside the canvas art in
	// obstacleSymbols.ts so the two surfaces cannot drift apart silently;
	// any proportion change must consciously touch these strings.
	it('pins each kind at a fixed anchor', () => {
		expect(profileObstacleGlyphPath('caret', 100, 50)).toBe(
			'M 96.5 55 L 100 50 L 103.5 55');
		expect(profileObstacleGlyphPath('towerHigh', 100, 50)).toBe(
			'M 95.5 57 L 100 50 L 104.5 57');
		expect(profileObstacleGlyphPath('turbine', 100, 50)).toBe(
			'M 100 54.5 L 100 50 M 100 54.5 L 96.5 57.5 M 100 54.5 L 103.5 57.5');
		expect(profileObstacleGlyphPath('groundLight', 100, 50)).toBe(
			'M 96.5 53.5 L 103.5 53.5 M 100 50 L 100 57 M 97.5 51 L 102.5 56 M 97.5 56 L 102.5 51');
	});

	it('pins the lit-obstacle rays', () => {
		expect(profileObstacleRaysPath(100, 50)).toBe(
			'M 95.5 46 L 98 48.5 M 104.5 46 L 102 48.5');
	});
});
