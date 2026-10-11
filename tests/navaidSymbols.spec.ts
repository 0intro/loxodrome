/* Pins the pure resolvers of navaidSymbols.ts: the per-family colour table
 * (chart-sampled inks; see docs/airspace-symbology.md), the glyph
 * half-extents that drive hit-testing and the cue rings, and the NDB
 * stipple structure (legend-measured ring radii / dot counts); and, drawn
 * through a recording context, that the key of a look names every input of
 * the painter and that every shape it draws stays inside the reach its
 * sprite is sized by (map/symbolSprites.ts). tests/symbolCoverage.spec.ts
 * pins the type routing. */

import { describe, expect, it, vi } from 'vitest';
import {
	NAVAID_COLOR,
	NDB_CIRCLE_R,
	NDB_RINGS,
	drawNavaidSymbol,
	navaidSymbolKey,
	navaidSymbolReach,
	navaidSymbolSize,
	ndbRingCounts,
} from '$lib/map/navaidSymbols';
import type { NavaidType } from '$lib/data/navaids';
import { extentOf, FakePath } from './helpers/paint2d';

vi.stubGlobal('Path2D', FakePath);

describe('NAVAID_COLOR', () => {
	it('prints the whole radionav family in the Legende2026 navy', () => {
		for (const type of ['VOR', 'VOR-DME', 'VORTAC', 'TACAN', 'DME', 'NDB'] as const) {
			expect(NAVAID_COLOR[type]).toBe('#164194');
		}
		// The VFR reporting triangle prints in the same ink.
		expect(NAVAID_COLOR.VFR_REPORTING_POINT).toBe('#164194');
	});

	it('keeps the documented deviations: ILS orange, waypoint slate', () => {
		expect(NAVAID_COLOR.ILS).toBe('#d2691e');
		expect(NAVAID_COLOR['ILS-DME']).toBe('#d2691e');
		expect(NAVAID_COLOR.LOC).toBe('#d2691e');
		expect(NAVAID_COLOR.WAYPOINT).toBe('#5a6470');
	});
});

describe('navaidSymbolSize', () => {
	it('sizes radio navaids biggest, ILS smaller, points smallest', () => {
		const size = (t: NavaidType) => navaidSymbolSize(t);
		for (const t of ['VOR', 'VOR-DME', 'VORTAC', 'TACAN', 'DME'] as const) {
			expect(size(t)).toBe(8);
		}
		// NDB draws biggest of all: the chart's stipple disc dwarfs the VOR
		// hexagon, and the rings need the room (see ndbRingCounts).
		expect(size('NDB')).toBe(11);
		for (const t of ['ILS', 'ILS-DME', 'LOC'] as const) {
			expect(size(t)).toBe(7);
		}
		expect(size('WAYPOINT')).toBe(6);
		expect(size('VFR_REPORTING_POINT')).toBe(6);
	});
});

describe('NDB structure (Legende2026, measured on the 600 dpi scan)', () => {
	it('wraps the open circle in three stipple rings of 16 / 22 / 32 dots', () => {
		expect(NDB_CIRCLE_R).toBe(0.31);
		expect(NDB_RINGS).toEqual([
			[0.42, 16],
			[0.58, 22],
			[0.75, 32],
		]);
	});
	it('thins each ring to the pitch floor at canvas scale', () => {
		// At the drawn half-extent (11 px) the legend counts cannot resolve,
		// so the rings thin to the ~1/3 duty cycle the legend prints;
		// grading stays outward-increasing like the legend's 16 / 22 / 32.
		const counts = ndbRingCounts(navaidSymbolSize('NDB'));
		expect(counts).toEqual([9, 12, 16]);
		// Every drawn pitch respects the floor.
		for (let k = 0; k < counts.length; k++) {
			const pitch = (2 * Math.PI * 11 * NDB_RINGS[k][0]) / counts[k];
			expect(pitch).toBeGreaterThanOrEqual(3.2);
		}
	});

	it('converges to the legend counts at print-like extents', () => {
		expect(ndbRingCounts(40)).toEqual([16, 22, 32]);
	});

	it('keeps a near-uniform along-ring dot pitch, like the legend print', () => {
		// Legend pitch measures 16.5 / 16.6 / 14.8 px across the rings at
		// 600 dpi: the same dot spacing on every ring, within ~12 %.
		const pitches = NDB_RINGS.map(([rf, n]) => (2 * Math.PI * rf) / n);
		const [min, max] = [Math.min(...pitches), Math.max(...pitches)];
		expect(max / min).toBeLessThan(1.15);
	});
});

describe('the look of a navaid glyph', () => {
	const TYPES = Object.keys(NAVAID_COLOR) as NavaidType[];

	it('keys every input the painter reads', () => {
		const keys = new Set<string>();
		for (const type of TYPES) {
			for (const s of [navaidSymbolSize(type), navaidSymbolSize(type) + 3]) {
				for (const selected of [false, true]) {
					for (const dimmed of [false, true]) {
						keys.add(navaidSymbolKey(type, s, selected, dimmed));
					}
				}
			}
		}
		expect(keys.size).toBe(TYPES.length * 2 * 2 * 2);
	});

	it('stays inside its reach, halo and a pixel of fringe included', () => {
		for (const type of TYPES) {
			for (const s of [navaidSymbolSize(type), navaidSymbolSize(type) + 3]) {
				for (const selected of [false, true]) {
					for (const dimmed of [false, true]) {
						const e = extentOf((ctx) => {
							drawNavaidSymbol(ctx, type, 0, 0, s, selected, dimmed);
						});
						const r = navaidSymbolReach(type, s);
						const at = `${type} ${s} ${selected} ${dimmed}`;
						for (const side of ['left', 'top', 'right', 'bottom'] as const) {
							expect(e[side] + 1, `${at} ${side}`).toBeLessThanOrEqual(r[side]);
						}
						// And not far past it: a sprite pays for every pixel.
						expect(Math.min(r.left - e.left, r.right - e.right), at).toBeLessThan(4);
					}
				}
			}
		}
	});
});
