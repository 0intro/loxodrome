/* The point-profile chart core (src/lib/components/verticalProfile.ts): the
 * datum-aware column extents and the altitude window.
 *
 * The window is why this file exists. French structure puts a FIR, an LTA or a
 * UTA with a PUBLISHED finite top in nearly every stack, so an axis scaled to
 * the tallest column ran GND-FL 200+ and left a 0-1500 ft CTR at 7 % of the
 * plot. The rule frames the band being flown instead, crops what crosses it and
 * counts what it drops; every clause below is one of those decisions.
 *
 * No DOM here: the SVG itself is browser-verified (docs/map-profile.md). */

import { describe, it, expect } from 'vitest';
import { fromTriple, type VerticalLimit } from '$lib/vertical/limits';
import type { VerticalColumn } from '$lib/components/verticalProfile';
import { zoomWindow } from '$lib/route/routeProfile';
import {
	CEILING_CATEGORIES,
	WINDOW_MIN_SPAN_FT,
	airspaceAbove,
	chartPads,
	columnFeet,
	drawnBaseFt,
	levelLabel,
	overlayCoversWindow,
	profileBounds,
	profileWindow,
	shortLabel,
	tickStepFt,
	truncate,
	windowColumns,
	windowNoteText,
	windowTicks,
} from '$lib/components/verticalProfile';
import { wheelZoomFactor } from '$lib/ui/plotGestures';
import { detail as en } from '$lib/i18n/en/detail';
import { detail as fr } from '$lib/i18n/fr/detail';

function lim(code: string, val: string, uom: string): VerticalLimit {
	return [code, val, uom];
}

/** An airspace's vertical pair, the only part columnFeet reads. */
function extent(lower: VerticalLimit | null, upper: VerticalLimit | null) {
	return {
		vLower: lower ? fromTriple(lower) : null,
		vUpper: upper ? fromTriple(upper) : null,
	};
}

/** A column at [lowerFt, upperFt), known extent unless stated. */
function col(o: Partial<VerticalColumn> & { id: string }): VerticalColumn {
	return {
		label: o.id,
		color: 'var(--airspace-controlled)',
		lowerFt: 0,
		upperFt: 5000,
		knownExtent: true,
		...o,
	};
}

describe('columnFeet', () => {
	it('passes AMSL limits through as feet', () => {
		const f = columnFeet(extent(lim('ALT', '1000', 'FT'), lim('ALT', '4500', 'FT')), null);
		expect(f).toEqual({ lowerFt: 1000, upperFt: 4500, known: true, topOpen: false });
	});

	it('compares flight levels in feet', () => {
		const f = columnFeet(extent(lim('STD', '115', 'FL'), lim('STD', '195', 'FL')), null);
		expect(f.lowerFt).toBe(11500);
		expect(f.upperFt).toBe(19500);
	});

	it('converts metres', () => {
		const f = columnFeet(extent(lim('ALT', '600', 'M'), lim('ALT', '1000', 'M')), null);
		expect(f.lowerFt).toBeCloseTo(1968.5, 0);
	});

	it('resolves an ASFC floor against the point ground', () => {
		const f = columnFeet(extent(lim('HEI', '800', 'FT'), lim('ALT', '4500', 'FT')), 500);
		expect(f.lowerFt).toBe(1300);
	});

	it('draws an AGL limit at face value with no ground known', () => {
		const f = columnFeet(extent(lim('HEI', '800', 'FT'), lim('ALT', '4500', 'FT')), null);
		expect(f.lowerFt).toBe(800);
	});

	it('sits an SFC floor on the ground', () => {
		const f = columnFeet(extent(lim('SFC', '0', 'FT'), lim('ALT', '2500', 'FT')), 500);
		expect(f.lowerFt).toBe(500);
	});

	it('reports a published UNL ceiling as open-topped', () => {
		const f = columnFeet(extent(lim('SFC', '0', 'FT'), lim('UNL', '0', 'FT')), null);
		expect(f.topOpen).toBe(true);
		expect(f.upperFt).toBe(Infinity);
	});

	it('distinguishes an unknown ceiling from a published UNL one', () => {
		// The window rule depends on the difference: UNL states "continues
		// above", a missing limit states nothing at all.
		const f = columnFeet(extent(lim('ALT', '1000', 'FT'), null), null);
		expect(f.known).toBe(false);
		expect(f.topOpen).toBe(false);
		expect(f.upperFt).toBe(Infinity);
	});
});

describe('profileWindow', () => {
	const band = { floor: 0, ceiling: 10000 }; // the app's default filter

	it('clamps to the data rather than to the filter ceiling', () => {
		const win = profileWindow({
			columns: [col({ id: 'ctr', lowerFt: 0, upperFt: 1500 }), col({ id: 'tma', lowerFt: 1500, upperFt: 4500 })],
			band,
		});
		expect(win).toEqual({ floorFt: 0, ceilingFt: 5000 });
	});

	it('stops at the filter ceiling when the stack runs past it', () => {
		// The case the whole change is about: a FIR published to FL 195 pegged
		// the axis at 25000 ft and left the CTR at 7 % of the plot.
		const win = profileWindow({
			columns: [
				col({ id: 'ctr', lowerFt: 0, upperFt: 1500 }),
				col({ id: 'fir', lowerFt: 0, upperFt: 19500 }),
			],
			band,
		});
		expect(win).toEqual({ floorFt: 0, ceilingFt: 10000 });
	});

	it('falls back to the VFR top with the filter off', () => {
		const win = profileWindow({
			columns: [col({ id: 'fir', lowerFt: 0, upperFt: 19500 })],
			band: null,
		});
		expect(win).toEqual({ floorFt: 0, ceilingFt: 10000 });
	});

	it('still clamps to a low stack with the filter off', () => {
		const win = profileWindow({
			columns: [col({ id: 'ctr', lowerFt: 0, upperFt: 1500 })],
			band: null,
		});
		expect(win).toEqual({ floorFt: 0, ceilingFt: 2000 });
	});

	it('takes a raised filter floor as the window floor', () => {
		const win = profileWindow({
			columns: [col({ id: 'cta', lowerFt: 3500, upperFt: 7500 })],
			band: { floor: 3000, ceiling: 8000 },
		});
		expect(win).toEqual({ floorFt: 3000, ceilingFt: 8000 });
	});

	it('clamps a filter band far taller than the data', () => {
		const win = profileWindow({
			columns: [col({ id: 'fir', lowerFt: 0, upperFt: 19500 })],
			band: { floor: 0, ceiling: 60000 },
		});
		expect(win).toEqual({ floorFt: 0, ceilingFt: 20000 });
	});

	it('opens a single-level band to the minimum span, floor untouched', () => {
		const win = profileWindow({
			columns: [col({ id: 'cta', lowerFt: 2000, upperFt: 5000 })],
			band: { floor: 3000, ceiling: 3000 },
		});
		expect(win).toEqual({ floorFt: 3000, ceilingFt: 4000 });
	});

	it('takes only the floor of an open-topped column', () => {
		const win = profileWindow({
			columns: [col({ id: 'fir', lowerFt: 0, upperFt: Infinity, topOpen: true })],
			band,
		});
		expect(win.ceilingFt).toBe(10000);
	});

	it('takes nothing from an unknown-extent column', () => {
		const win = profileWindow({
			columns: [
				col({ id: 'ctr', lowerFt: 0, upperFt: 1500 }),
				col({ id: 'mystery', knownExtent: false, lowerFt: 0, upperFt: Infinity }),
			],
			band,
		});
		expect(win.ceilingFt).toBe(2000);
	});

	it('keeps a must-show band wholly inside, ceiling included', () => {
		// The NOTAM panel's F)/G) band IS the subject of that chart.
		const win = profileWindow({
			columns: [col({ id: 'ctr', lowerFt: 0, upperFt: 1500 })],
			band,
			mustShow: [{ floorFt: 9500, ceilingFt: 19500 }],
		});
		expect(win.ceilingFt).toBeGreaterThanOrEqual(19500);
	});

	it('pulls the floor back down to a must-show band below it', () => {
		const win = profileWindow({
			columns: [col({ id: 'cta', lowerFt: 5000, upperFt: 7500 })],
			band: { floor: 4000, ceiling: 8000 },
			mustShow: [{ floorFt: 1200, ceilingFt: 2500 }],
		});
		expect(win.floorFt).toBe(1200);
	});

	it('reads a null must-show side as unbounded', () => {
		const win = profileWindow({
			columns: [col({ id: 'ctr', lowerFt: 0, upperFt: 1500 })],
			band,
			mustShow: [{ floorFt: 4000, ceilingFt: null }],
		});
		expect(win.ceilingFt).toBeGreaterThan(4000);
		expect(win.ceilingFt).toBeLessThanOrEqual(10000);
	});

	it('keeps air above a known ground', () => {
		const win = profileWindow({
			columns: [col({ id: 'ctr', lowerFt: 9000, upperFt: 9500 })],
			band,
			groundFt: 9000,
		});
		expect(win.ceilingFt).toBeGreaterThanOrEqual(11000);
	});

	it('always reaches the focus column floor', () => {
		// The airspace panel re-adds its own subject even when the filter
		// excluded it; a chart of everything EXCEPT its subject is wrong.
		const win = profileWindow({
			columns: [
				col({ id: 'ctr', lowerFt: 0, upperFt: 1500 }),
				col({ id: 'uir', lowerFt: 19500, upperFt: 66000, highlight: true }),
			],
			band,
		});
		expect(win.ceilingFt).toBeGreaterThan(19500);
	});

	it('drops the floor to a focus column that sits entirely below it', () => {
		const win = profileWindow({
			columns: [col({ id: 'ctr', lowerFt: 0, upperFt: 1500, highlight: true })],
			band: { floor: 5000, ceiling: 9000 },
		});
		expect(win.floorFt).toBe(0);
	});

	it('never hides the whole stack', () => {
		const win = profileWindow({
			columns: [col({ id: 'lta', lowerFt: 11500, upperFt: 19500 })],
			band: null,
		});
		expect(win.ceilingFt).toBeGreaterThanOrEqual(19500);
		expect(win.floorFt).toBeLessThanOrEqual(11500);
	});

	it('keeps the default window for an empty stack', () => {
		expect(profileWindow({ columns: [], band })).toEqual({ floorFt: 0, ceilingFt: 10000 });
	});

	it('clamps to the published structure, on a labelled step', () => {
		// Past FL 660 is a data error, not a view; the axis keeps a labelled top
		// edge and the offending column perforates like any other crop.
		const win = profileWindow({
			columns: [col({ id: 'uir', lowerFt: 0, upperFt: 200000 })],
			band: { floor: 0, ceiling: 200000 },
		});
		expect(win.ceilingFt).toBeLessThanOrEqual(66000);
		expect(win.ceilingFt).toBe(60000);
	});
});

describe('windowColumns', () => {
	const win = { floorFt: 0, ceilingFt: 10000 };

	it('draws a column crossing the top, perforates it, and counts it as shown', () => {
		// A perforated edge is the statement that it continues, so the header has
		// nothing to disclose about it.
		const out = windowColumns([col({ id: 'fir', lowerFt: 0, upperFt: 19500 })], win, null);
		expect(out.drawn).toHaveLength(1);
		expect(out.drawn[0].cutTop).toBe(true);
		expect(out.drawn[0].cutBottom).toBe(false);
		expect(out.hiddenAbove).toBe(0);
	});

	it('perforates a published UNL column the same way', () => {
		const out = windowColumns(
			[col({ id: 'fir', lowerFt: 0, upperFt: Infinity, topOpen: true })],
			win,
			null,
		);
		expect(out.drawn[0].cutTop).toBe(true);
		expect(out.hiddenAbove).toBe(0);
	});

	it('perforates a column crossing the floor', () => {
		const out = windowColumns(
			[col({ id: 'cta', lowerFt: 1000, upperFt: 8000 })],
			{ floorFt: 3000, ceilingFt: 10000 },
			null,
		);
		expect(out.drawn[0].cutBottom).toBe(true);
		expect(out.hiddenBelow).toBe(0);
	});

	it('does not call a terrain-clamped base a crop', () => {
		// The ground IS the real floor of an SFC volume, so there is nothing
		// below the window to point at.
		const out = windowColumns([col({ id: 'ctr', lowerFt: 0, upperFt: 2500 })], win, 1200);
		expect(out.drawn[0].cutBottom).toBe(false);
		expect(out.hiddenBelow).toBe(0);
	});

	it('drops a column entirely above the window and counts it', () => {
		const out = windowColumns(
			[
				col({ id: 'ctr', lowerFt: 0, upperFt: 1500 }),
				col({ id: 'lta', lowerFt: 11500, upperFt: 19500 }),
			],
			win,
			null,
		);
		expect(out.drawn.map((c) => c.id)).toEqual(['ctr']);
		expect(out.hiddenAbove).toBe(1);
	});

	it('drops a column entirely below the window and counts it', () => {
		const out = windowColumns(
			[col({ id: 'ctr', lowerFt: 0, upperFt: 2000 })],
			{ floorFt: 3000, ceilingFt: 10000 },
			null,
		);
		expect(out.drawn).toHaveLength(0);
		expect(out.hiddenBelow).toBe(1);
	});

	it('drops a column whose floor is exactly the window top', () => {
		const out = windowColumns([col({ id: 'lta', lowerFt: 10000, upperFt: 19500 })], win, null);
		expect(out.drawn).toHaveLength(0);
		expect(out.hiddenAbove).toBe(1);
	});

	it('counts only what it left out, not what it perforated', () => {
		const out = windowColumns(
			[
				col({ id: 'fir', lowerFt: 0, upperFt: 19500 }),
				col({ id: 'lta', lowerFt: 11500, upperFt: 19500 }),
			],
			win,
			null,
		);
		expect(out.hiddenAbove).toBe(1);
		expect(out.drawn.map((c) => c.id)).toEqual(['fir']);
	});

	it('never crops, drops or counts an unknown-extent column', () => {
		const out = windowColumns(
			[col({ id: 'mystery', knownExtent: false, lowerFt: 0, upperFt: Infinity })],
			win,
			null,
		);
		expect(out.drawn).toHaveLength(1);
		expect(out.drawn[0].cutTop).toBe(false);
		expect(out.drawn[0].cutBottom).toBe(false);
		expect(out.hiddenAbove).toBe(0);
	});

	it('keeps the caller order and the other column fields', () => {
		const out = windowColumns(
			[
				col({ id: 'a', lowerFt: 0, upperFt: 3000, badge: 'D', shortLabel: 'CTR A' }),
				col({ id: 'b', lowerFt: 3000, upperFt: 6000 }),
			],
			win,
			null,
		);
		expect(out.drawn.map((c) => c.id)).toEqual(['a', 'b']);
		expect(out.drawn[0].badge).toBe('D');
		expect(out.drawn[0].shortLabel).toBe('CTR A');
	});
});

describe('tickStepFt / levelLabel / windowTicks', () => {
	it('labels the datum GND and everything above it as a level', () => {
		expect(levelLabel(0)).toBe('GND');
		expect(levelLabel(6500)).toBe('FL 065');
		expect(levelLabel(19500)).toBe('FL 195');
	});

	it('steps from the SPAN, not from the ceiling', () => {
		// The old rule keyed on the ceiling alone and gave 5000 ft rungs here.
		expect(tickStepFt(5000)).toBe(1000);
		expect(tickStepFt(10000)).toBe(2000);
		expect(tickStepFt(20000)).toBe(5000);
	});

	it('never steps finer than 1000 ft, so no label is a non-level', () => {
		expect(tickStepFt(1000)).toBe(1000);
		expect(windowTicks({ floorFt: 0, ceilingFt: 1000 }).map((t) => t.label)).toEqual([
			'GND',
			'FL 010',
		]);
	});

	it('starts at the first step at or above a raised floor', () => {
		const ticks = windowTicks({ floorFt: 3000, ceilingFt: 8000 });
		expect(ticks[0].ft).toBe(3000);
		expect(ticks.map((t) => t.label)).not.toContain('GND');
	});

	it('always makes the window top a tick', () => {
		for (const ceiling of [2000, 5000, 10000, 20000, 40000, 66000]) {
			const win = profileWindow({
				columns: [col({ id: 'x', lowerFt: 0, upperFt: ceiling })],
				band: { floor: 0, ceiling },
			});
			const ticks = windowTicks(win);
			expect(ticks[ticks.length - 1].ft).toBe(win.ceilingFt);
		}
	});

	it('thins the ladder for a short chart, keeping the 1000 ft grid', () => {
		const ticks = windowTicks({ floorFt: 0, ceilingFt: 10000 }, 3);
		expect(ticks.length).toBeLessThanOrEqual(3);
		for (const t of ticks) {
			expect(t.ft % 1000).toBe(0);
		}
	});
});

describe('overlayCoversWindow', () => {
	const win = { floorFt: 0, ceilingFt: 10000 };

	it('is true when the band spans the window, so the chart drops it', () => {
		expect(overlayCoversWindow({ floorFt: 0, ceilingFt: 10000 }, win)).toBe(true);
		expect(overlayCoversWindow({ floorFt: 0, ceilingFt: 60000 }, win)).toBe(true);
	});

	it('reads a null side as unbounded, so SFC-UNL spans everything', () => {
		expect(overlayCoversWindow({ floorFt: null, ceilingFt: null }, win)).toBe(true);
	});

	it('is false for a genuine sub-band on either side', () => {
		expect(overlayCoversWindow({ floorFt: 2000, ceilingFt: 10000 }, win)).toBe(false);
		expect(overlayCoversWindow({ floorFt: 0, ceilingFt: 8000 }, win)).toBe(false);
	});
});

describe('wheelZoomFactor', () => {
	it('normalises the three deltaMode units to the same travel', () => {
		expect(wheelZoomFactor(100, 0)).toBeCloseTo(Math.exp(0.2), 9);
		expect(wheelZoomFactor(100 / 16, 1)).toBeCloseTo(Math.exp(0.2), 9);
		expect(wheelZoomFactor(1, 2)).toBeCloseTo(Math.exp(0.2), 9);
	});

	it('zooms out on a positive delta and is symmetric', () => {
		expect(wheelZoomFactor(50, 0)).toBeGreaterThan(1);
		expect(wheelZoomFactor(50, 0) * wheelZoomFactor(-50, 0)).toBeCloseTo(1, 9);
	});

	it('clamps a trackpad fling to the same step as the cap', () => {
		expect(wheelZoomFactor(9999, 0)).toBe(wheelZoomFactor(300, 0));
		expect(wheelZoomFactor(-9999, 2)).toBe(wheelZoomFactor(-3, 2));
	});
});

/* The surfaces' zoom policy, on the shared pure window helper: the wheel and
 * `+` / `-` anchor at the window's own FLOOR (VerticalProfileModal's applyZoom),
 * so the ceiling is what moves and the ground, the datum every column stands on,
 * keeps the bottom of the frame. docs/map-profile.md. */
describe('floor-anchored zoom', () => {
	const zoomAtFloor = (lo: number, hi: number, factor: number, maxFt: number): [number, number] =>
		zoomWindow(lo, hi, lo, factor, 0, maxFt, WINDOW_MIN_SPAN_FT);

	it('holds the ground on the frame and moves the ceiling', () => {
		expect(zoomAtFloor(0, 10000, 0.5, 10000)).toEqual([0, 5000]);
	});

	it('holds a panned window on its own floor, so a deliberate pan survives a wheel', () => {
		expect(zoomAtFloor(4000, 8000, 0.5, 20000)).toEqual([4000, 6000]);
	});

	it('lands back on the ground once zooming out reaches the bounds', () => {
		expect(zoomAtFloor(4000, 8000, 100, 20000)).toEqual([0, 20000]);
	});

	it('is a no-op at the minimum span, so a pinned wheel cannot latch the view', () => {
		expect(zoomAtFloor(0, WINDOW_MIN_SPAN_FT, 0.5, 10000)).toEqual([0, WINDOW_MIN_SPAN_FT]);
	});
});

describe('profileBounds', () => {
	it('reaches the data top so zooming out can see everything', () => {
		expect(
			profileBounds([col({ id: 'fir', lowerFt: 0, upperFt: 19500 })]),
		).toEqual({ minFt: 0, maxFt: 19500 });
	});

	it('ignores an open-topped or unknown column', () => {
		expect(
			profileBounds([
				col({ id: 'fir', lowerFt: 0, upperFt: Infinity, topOpen: true }),
				col({ id: 'mystery', knownExtent: false, lowerFt: 0, upperFt: Infinity }),
			]),
		).toEqual({ minFt: 0, maxFt: 10000 });
	});

	it('floors at the default window, so zooming out always has somewhere to go', () => {
		expect(profileBounds([col({ id: 'ctr', lowerFt: 0, upperFt: 1500 })]).maxFt).toBe(10000);
	});

	it('folds in an overlay ceiling the chart draws', () => {
		expect(
			profileBounds([col({ id: 'ctr', lowerFt: 0, upperFt: 1500 })], {
				overlayCeilingFt: 19500,
			}).maxFt,
		).toBe(19500);
	});

	it('rounds up to 500 ft and clamps to the published structure', () => {
		expect(profileBounds([col({ id: 'x', lowerFt: 0, upperFt: 12345 })]).maxFt).toBe(12500);
		expect(profileBounds([col({ id: 'x', lowerFt: 0, upperFt: 90000 })]).maxFt).toBe(66000);
	});
});

describe('chartPads', () => {
	const labelled = col({ id: 'a', shortLabel: 'TMA PARIS', badge: 'D' });

	it('reserves the label row only when labels are on and a column has one', () => {
		expect(chartPads([labelled], { showLabels: true, colW: 40 }).padB).toBe(14 + 110);
		expect(chartPads([col({ id: 'a' })], { showLabels: true, colW: 40 }).padB).toBe(14);
	});

	it('reserves the chip row when the columns are wide enough for a chip', () => {
		expect(chartPads([labelled], { showLabels: false, colW: 40 }).padB).toBe(14 + 18);
		expect(chartPads([labelled], { showLabels: false, colW: 8 }).padB).toBe(14);
	});

	it('matches the chart top gutter', () => {
		expect(chartPads([labelled], { showLabels: false, colW: 40 }).padT).toBe(8);
	});
});

describe('windowNoteText', () => {
	const win = { floorFt: 0, ceilingFt: 10000 };

	it('says nothing when the window left nothing out', () => {
		expect(windowNoteText(win, { hiddenAbove: 0, hiddenBelow: 0 }, en)).toBeUndefined();
	});

	it('states the count and the level it applies to, compactly, in both locales', () => {
		expect(windowNoteText(win, { hiddenAbove: 3, hiddenBelow: 0 }, en)).toBe('+3 above FL 100');
		expect(windowNoteText(win, { hiddenAbove: 3, hiddenBelow: 0 }, fr)).toBe(
			'+3 au-dessus de FL 100',
		);
	});

	it('joins both clauses', () => {
		const note = windowNoteText(
			{ floorFt: 3000, ceilingFt: 8000 },
			{ hiddenAbove: 2, hiddenBelow: 1 },
			en,
		);
		expect(note).toBe('+2 above FL 080 · +1 below FL 030');
	});
});

describe('drawnBaseFt', () => {
	it('clamps a below-ground base up to the terrain', () => {
		expect(drawnBaseFt({ lowerFt: 0 }, 1200)).toBe(1200);
	});

	it('passes a base above the ground through', () => {
		expect(drawnBaseFt({ lowerFt: 2500 }, 1200)).toBe(2500);
		expect(drawnBaseFt({ lowerFt: 2500 }, null)).toBe(2500);
	});
});

describe('CEILING_CATEGORIES', () => {
	it('counts controlled and restricted only', () => {
		// A product decision, so changing it has to be a deliberate spec edit:
		// the others publish conditional limits, not a ceiling to stay below.
		expect([...CEILING_CATEGORIES].sort()).toEqual(['controlled', 'restricted']);
	});
});

describe('airspaceAbove', () => {
	it('reports the lowest counted base and the free height under it', () => {
		const out = airspaceAbove(
			[
				col({ id: 'tma', category: 'controlled', lowerFt: 3000, upperFt: 6500 }),
				col({ id: 'cta', category: 'controlled', lowerFt: 5500, upperFt: 9500 }),
			],
			500,
		);
		expect(out.column?.id).toBe('tma');
		expect(out.baseFt).toBe(3000);
		expect(out.freeFt).toBe(2500);
	});

	it('clamps a surface base to the ground and reports nothing free', () => {
		const out = airspaceAbove(
			[col({ id: 'ctr', category: 'controlled', lowerFt: 0, upperFt: 2500 })],
			1200,
		);
		expect(out.baseFt).toBe(1200);
		expect(out.freeFt).toBe(0);
	});

	it('ignores the categories whose limits are conditional', () => {
		const out = airspaceAbove(
			[
				col({ id: 'tsa', category: 'transit', lowerFt: 1500, upperFt: 6000 }),
				col({ id: 'rmz', category: 'trafficmgmt', lowerFt: 2000, upperFt: 4000 }),
				col({ id: 'siv', category: 'siv', lowerFt: 2500, upperFt: 19500 }),
				col({ id: 'tma', category: 'controlled', lowerFt: 3000, upperFt: 6500 }),
			],
			0,
		);
		expect(out.column?.id).toBe('tma');
	});

	it('never counts the FIR it is inside', () => {
		const out = airspaceAbove(
			[
				col({ id: 'fir', category: 'fir', lowerFt: 0, upperFt: 19500 }),
				col({ id: 'tma', category: 'controlled', lowerFt: 3000, upperFt: 6500 }),
			],
			0,
		);
		expect(out.column?.id).toBe('tma');
	});

	it('never counts an activity zone a panel re-added', () => {
		const out = airspaceAbove(
			[col({ id: 'para', category: 'activity', lowerFt: 1000, upperFt: 5000 })],
			0,
		);
		expect(out.column).toBeNull();
	});

	it('skips a volume the reference is already inside', () => {
		const out = airspaceAbove(
			[
				col({ id: 'ctr', category: 'controlled', lowerFt: 0, upperFt: 2500 }),
				col({ id: 'tma', category: 'controlled', lowerFt: 2500, upperFt: 6500 }),
			],
			0,
			1500,
		);
		expect(out.column?.id).toBe('tma');
		expect(out.freeFt).toBe(1000);
	});

	it('skips an unknown-extent column, which can state no base', () => {
		const out = airspaceAbove(
			[
				col({
					id: 'mystery',
					category: 'controlled',
					knownExtent: false,
					lowerFt: 0,
					upperFt: Infinity,
				}),
			],
			0,
		);
		expect(out.column).toBeNull();
	});

	it('counts an open-topped volume by its base', () => {
		const out = airspaceAbove(
			[
				col({
					id: 'p',
					category: 'restricted',
					lowerFt: 2000,
					upperFt: Infinity,
					topOpen: true,
				}),
			],
			0,
		);
		expect(out.baseFt).toBe(2000);
		expect(out.freeFt).toBe(2000);
	});

	it('defaults the reference to the ground and honours an explicit one', () => {
		const stack = [col({ id: 'tma', category: 'controlled', lowerFt: 4000, upperFt: 6500 })];
		expect(airspaceAbove(stack, 1000).freeFt).toBe(3000);
		expect(airspaceAbove(stack, 1000, 2000).freeFt).toBe(2000);
	});

	it('reports nothing above as unbounded free height', () => {
		const out = airspaceAbove([col({ id: 'fir', category: 'fir', lowerFt: 0 })], 0);
		expect(out.column).toBeNull();
		expect(out.baseFt).toBeNull();
		expect(out.freeFt).toBe(Infinity);
	});

	it('keeps the first of two volumes sharing a base', () => {
		const out = airspaceAbove(
			[
				col({ id: 'cta', category: 'controlled', lowerFt: 3000, upperFt: 9500 }),
				col({ id: 'r', category: 'restricted', lowerFt: 3000, upperFt: 5000 }),
			],
			0,
		);
		expect(out.column?.id).toBe('cta');
	});
});

describe('shortLabel / truncate', () => {
	it('passes a short label through', () => {
		expect(truncate('TMA PARIS', 16)).toBe('TMA PARIS');
	});

	it('truncates at a word boundary in the latter part of the budget', () => {
		expect(truncate('TMA RENNES SECTOR 1', 16)).toBe('TMA RENNES…');
	});

	it('hard-cuts when no boundary is late enough', () => {
		expect(truncate('ABCDEFGHIJKLMNOPQRST', 8)).toBe('ABCDEFG…');
	});

	it('builds the type + name label', () => {
		expect(
			shortLabel({ type: 'TMA', name: 'PARIS 9' } as Parameters<typeof shortLabel>[0]),
		).toBe('TMA PARIS 9');
	});
});
