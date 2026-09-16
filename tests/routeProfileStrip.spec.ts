/* Pins the phone strip's pure scale rules (route/routeProfile.ts): the
 * px-per-NM floor, the follow scroll, the pinch anchor, and the pad argument
 * that lets the strip draw its axes inside the plot while every existing
 * call keeps the desktop gutters. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	MIN_PX_PER_NM,
	PAD_L,
	PAD_T,
	followScrollLeft,
	stripPlotWidth,
	xOf,
	xTicks,
	yOf,
	zoomScrollLeft,
} from '$lib/route/routeProfile';

describe('stripPlotWidth', () => {
	it('is the box when the plan fits at the floor', () => {
		expect(stripPlotWidth(10, 392)).toBe(392);
	});
	it('holds the floor when the plan is longer than the box', () => {
		expect(stripPlotWidth(52.4, 392)).toBe(Math.ceil(52.4 * MIN_PX_PER_NM));
	});
	it('multiplies by the pinch zoom, never below one', () => {
		expect(stripPlotWidth(52.4, 392, 2)).toBe(Math.ceil(52.4 * MIN_PX_PER_NM * 2));
		expect(stripPlotWidth(52.4, 392, 0.5)).toBe(Math.ceil(52.4 * MIN_PX_PER_NM));
	});
});

describe('followScrollLeft', () => {
	it('centres the aircraft in the box', () => {
		expect(followScrollLeft(600, 392, 1048)).toBe(600 - 196);
	});
	it('clamps at both ends of the strip', () => {
		expect(followScrollLeft(50, 392, 1048)).toBe(0);
		expect(followScrollLeft(1040, 392, 1048)).toBe(1048 - 392);
	});
	it('rests at zero when the box is wider than the strip', () => {
		expect(followScrollLeft(100, 500, 392)).toBe(0);
	});
});

describe('zoomScrollLeft', () => {
	it('keeps the anchor NM under the same box pixel after a scale change', () => {
		// 30 NM under x=200 at 40 px/NM: scrollLeft = 1200 - 200.
		expect(zoomScrollLeft(30, 200, 40, 2096, 392)).toBe(1000);
	});
	it('clamps to the strip', () => {
		expect(zoomScrollLeft(1, 300, 20, 1048, 392)).toBe(0);
		expect(zoomScrollLeft(52, 0, 40, 2096, 392)).toBe(2096 - 392);
	});
});

describe('the pad argument', () => {
	it('defaults to the desktop gutters, so existing calls are unchanged', () => {
		expect(xOf(0, 0, 10, 100)).toBe(PAD_L);
		expect(yOf(1000, 0, 1000, 100)).toBe(PAD_T);
	});
	it('maps the strip onto [0, innerW] and [0, innerH] with zero pads', () => {
		expect(xOf(0, 0, 10, 100, 0)).toBe(0);
		expect(xOf(10, 0, 10, 100, 0)).toBe(100);
		expect(yOf(1000, 0, 1000, 100, 0)).toBe(0);
		expect(yOf(0, 0, 1000, 100, 0)).toBe(100);
	});
});

describe('legibility at the floor', () => {
	it('labels the distance axis at most every 5 NM at the floor, both ends kept', () => {
		const total = 52.4;
		const ticks = xTicks(0, total, stripPlotWidth(total, 392));
		expect(ticks[0]).toBe(0);
		expect(ticks[ticks.length - 1]).toBe(total);
		for (let i = 1; i < ticks.length; i += 1) {
			expect(ticks[i] - ticks[i - 1]).toBeLessThanOrEqual(5 + 1e-9);
		}
	});
});

/* The rendition itself is a Svelte component; what a unit test can pin is
 * the wiring that keeps paper untouched: the flag is honoured on the
 * interactive instances only, the dossier mount never passes it, and the
 * two modals still build the print chart at the page width. */
describe('the compact rendition wiring', () => {
	const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

	it('is gated on the interactive instances in RouteProfile', () => {
		const src = read('src/lib/components/RouteProfile.svelte');
		expect(src).toContain('const compactMode = $derived(compact && interactive);');
		expect(src).toContain('const padL = $derived(compactMode ? 0 : PAD_L);');
		expect(src).toContain('const padT = $derived(compactMode ? 0 : PAD_T);');
		// One finger scrolls the strip; the chart keeps the vertical pan.
		expect(src).toMatch(/\.plot\.compact \{\s*touch-action: pan-x;/);
	});

	it('is never passed by the dossier print mount', () => {
		const src = read('src/lib/components/flightprep/PrintDoc.svelte');
		const mount = src.slice(src.indexOf('<RouteProfile'));
		expect(mount.slice(0, mount.indexOf('/>'))).not.toContain('compact');
	});

	it('is off while a modal prints, which keeps the page-width chart', () => {
		for (const rel of ['src/lib/components/RouteProfileModal.svelte', 'src/lib/components/NavProfileModal.svelte']) {
			const src = read(rel);
			expect(src, rel).toContain('const compact = $derived(ui.isMobile && !printing);');
			expect(src, rel).toMatch(/widthPx=\{printing \? PRINT_PLOT_W : compact \? stripW : win\.plotW\}/);
			expect(src, rel).toContain('fromNM={compact ? 0 : win.viewFromNM}');
			expect(src, rel).toContain('toNM={compact ? totalNM : win.viewToNM}');
		}
	});
});
