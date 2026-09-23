/* Pins the pure resolvers of navaidSymbols.ts: the per-family colour table
 * (chart-sampled inks; see docs/airspace-symbology.md), the glyph
 * half-extents that drive hit-testing and the cue rings, and the NDB
 * stipple structure (legend-measured ring radii / dot counts). The Path2D
 * builders and drawNavaidSymbol need a canvas runtime and stay untested
 * here (tests/symbolCoverage.spec.ts pins the type routing). */

import { describe, expect, it } from 'vitest';
import {
	NAVAID_COLOR,
	NDB_CIRCLE_R,
	NDB_RINGS,
	navaidSymbolSize,
	ndbRingCounts,
} from '$lib/map/navaidSymbols';
import type { NavaidType } from '$lib/data/navaids';

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
