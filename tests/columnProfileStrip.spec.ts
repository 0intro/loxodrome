/* The column profiles' phone strip (docs/map-profile.md "Phones: the strip"):
 * VerticalProfile's `compact` rendition rendered on the server, the labels the
 * surface pins over it, and the wiring that keeps it off paper and off the
 * inline detail chart. The gestures themselves (the pinch, the long press) are
 * browser-verified; what a unit test can pin is that they hang off the flag
 * and that a long press never also clicks. */

import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { beforeEach, describe, expect, it } from 'vitest';
import VerticalProfile from '$lib/components/VerticalProfile.svelte';
import ProfileAxisOverlay from '$lib/components/ProfileAxisOverlay.svelte';
import { PAD_L, chartPads, columnAxisMarks, type VerticalColumn } from '$lib/components/verticalProfile';
import { i18n } from '$lib/state/i18n.svelte';

beforeEach(() => {
	i18n.locale = 'en';
});

const read = (file: string): string => readFileSync(file, 'utf8');

/** Eight 0-5000 ft columns carrying a class chip: wide enough at 23 px for
 *  the chip row, which both renditions reserve. */
const COLUMNS: VerticalColumn[] = Array.from({ length: 8 }, (_, i) => ({
	id: `c${i}`,
	label: `Column ${i}`,
	color: 'var(--airspace-controlled)',
	lowerFt: 0,
	upperFt: 5000,
	knownExtent: true,
	badge: 'D',
}));
const COL_W = 23;
const HEIGHT = 300;
const WIN = { floorFt: 0, ceilingFt: 10000 };

function chart(compact: boolean): string {
	return render(VerticalProfile, {
		props: {
			columns: COLUMNS,
			overlays: [],
			floorFt: WIN.floorFt,
			ceilingFt: WIN.ceilingFt,
			minColumnPx: COL_W,
			maxColumnPx: COL_W,
			heightPx: HEIGHT,
			onPan: () => {},
			onZoom: () => {},
			compact,
		},
	}).body;
}

/** Every element `tag` carrying `cls`, as its attribute map. */
function elements(html: string, tag: string, cls: string): Record<string, string>[] {
	const out: Record<string, string>[] = [];
	for (const m of html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))) {
		const attrs = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
		if ((attrs.class ?? '').split(/\s+/).includes(cls)) {
			out.push(attrs);
		}
	}
	return out;
}

/** Each column's left edge, in drawing order. */
function columnXs(html: string): number[] {
	return [...html.matchAll(/<g\b[^>]*class="column[^"]*"[^>]*>\s*(?:<!--[^>]*-->\s*)*<rect\b[^>]*\bx="([^"]+)"/g)].map((m) => Number(m[1]));
}

/** The marks the chart draws its gridlines from, at its own pads. */
function marksFor(compact: boolean): ReturnType<typeof columnAxisMarks> {
	const pads = chartPads(COLUMNS, { showLabels: false, colW: COL_W, compact });
	const plotH = HEIGHT - pads.padT - pads.padB;
	return columnAxisMarks(WIN, plotH, pads.padT, Math.max(2, Math.floor(plotH / 16)));
}

describe('the strip rendition', () => {
	it('draws no gutter: the svg is the plot, edge to edge', () => {
		const svg = chart(true).match(/<svg\b[^>]*>/)![0];
		expect(svg).toContain(`width="${COLUMNS.length * COL_W}"`);
		expect(svg).toContain(`viewBox="0 0 ${COLUMNS.length * COL_W} ${HEIGHT}"`);
		// The first column starts at the box's edge, its gap halved; the
		// desktop's sits past the FL gutter.
		const gap = Math.max(1, Math.min(4, COL_W * 0.15));
		expect(columnXs(chart(true))[0]).toBeCloseTo(gap / 2, 9);
		expect(columnXs(chart(false))[0]).toBeCloseTo(PAD_L + gap / 2, 9);
	});

	it('leaves its level labels to the overlay, and keeps the gridlines', () => {
		const html = chart(true);
		expect(elements(html, 'text', 'grid-label')).toEqual([]);
		const lines = elements(html, 'line', 'grid');
		const marks = marksFor(true);
		expect(lines.map((l) => Number(l.y1))).toEqual(marks.map((m) => m.y));
		for (const l of lines) {
			expect(Number(l.x1)).toBe(0);
		}
	});

	it('changes nothing on the desktop chart: labels in the gutter, on their lines', () => {
		const html = chart(false);
		const marks = marksFor(false);
		const lines = elements(html, 'line', 'grid');
		const labels = elements(html, 'text', 'grid-label');
		expect(lines.map((l) => Number(l.y1))).toEqual(marks.map((m) => m.y));
		expect(labels.map((l) => Number(l.y))).toEqual(marks.map((m) => m.y + 3));
		for (const l of labels) {
			expect(Number(l.x)).toBe(PAD_L - 4);
		}
	});
});

describe('the strip labels', () => {
	it('draws the marks it is given above their lines, the top one under it', () => {
		const html = render(ProfileAxisOverlay, {
			props: {
				floorFt: 0,
				ceilingFt: 10000,
				heightPx: 282,
				marks: [
					{ ft: 0, label: 'GND', y: 282 },
					{ ft: 5000, label: 'FL 050', y: 141 },
					{ ft: 10000, label: 'FL 100', y: 0 },
				],
			},
		}).body;
		const texts = [...html.matchAll(/<text\b[^>]*\by="([^"]+)"[^>]*>([^<]*)<\/text>/g)].map((m) => [Number(m[1]), m[2]]);
		expect(texts).toEqual([
			[279, 'GND'],
			[138, 'FL 050'],
			[11, 'FL 100'],
		]);
	});
});

describe('the strip wiring', () => {
	const modal = read('src/lib/components/VerticalProfileModal.svelte');
	const chartSrc = read('src/lib/components/VerticalProfile.svelte');

	it('is the phone layout, never while the surface prints', () => {
		expect(modal).toContain('const printing = $derived(isPrintingSurface(id));');
		expect(modal).toContain('const compact = $derived(ui.isMobile && !printing);');
		// The slider gives way to the pinch, Fit moves to the actions sheet.
		expect(modal).toContain('const showSlider = $derived(chartH >= SLIDER_MIN_H && !compact);');
		expect(modal).toContain('actions={compact ? stripActions : undefined}');
	});

	it('reaches the chart as a prop, so the inline detail chart keeps its gutter', () => {
		expect(chartSrc).not.toMatch(/\$lib\/state\/ui\.svelte/);
		const inline = read('src/lib/components/detail/AltitudeProfile.svelte');
		const mount = inline.slice(inline.indexOf('<VerticalProfile'));
		const props = mount.slice(0, mount.indexOf('/>'));
		expect(props).not.toContain('compact');
		expect(props).not.toContain('onColumnPress');
	});

	it('pinches only on the strip, the flag read at each press', () => {
		expect(chartSrc).toMatch(/get pinch\(\) \{\s*return compact;\s*\}/);
	});

	it('swallows the click a long press may end on, cleared by the next press', () => {
		expect(chartSrc).toContain('onclick={() => columnClick(p.column.id)}');
		expect(chartSrc).toContain('oncontextmenu={(e) => columnContextMenu(e, p.column.id)}');
		expect(chartSrc).toMatch(/function gestureDown\(e: PointerEvent\): void \{\s*pressRead = false;/);
		expect(modal).toContain('onColumnPress={compact ? onColumnPress : undefined}');
	});
});
