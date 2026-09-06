/* The printed nav log's PAPER: the two geometries the split is packed
 * against, and the sheet's own lockstep between the page rendition and the
 * print stylesheet.
 *
 * Both are cross-file agreements a type checker cannot see. The geometries
 * (navlogCards.ts) are numbers in TypeScript; the boxes they describe are
 * `padding` and `gap` declarations in NavLogModal's print CSS, and a
 * measure taken against the wrong box packs a page that does not fit,
 * which prints as a spilled fragment on a sheet of its own. The sheet's
 * `.portrait` block and its `@media print` block state the same grid on
 * purpose (the class is what makes the geometry media-independent, so the
 * measuring mount lays out on screen exactly what the page prints); if
 * they drift, every band is measured at a column width the page never
 * uses. readFileSync per the paletteSync.spec.ts / aircraftData.spec.ts
 * precedent. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KNEEBOARD_CARD, PORTRAIT_PAGE } from '$lib/components/navlogCards';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const modal = read('src/lib/components/NavLogModal.svelte');
const sheet = read('src/lib/components/NavLogSheet.svelte');
const schedule = read('src/lib/components/NavLogSchedule.svelte');
const measure = read('src/lib/components/navlogMeasure.ts');

const PX_PER_MM = 96 / 25.4;
const mm = (v: number): number => v * PX_PER_MM;

/** The block of declarations a selector opens, as raw text. */
function block(css: string, selector: string): string {
	const at = css.indexOf(selector);
	expect(at, `selector ${selector} is missing`).toBeGreaterThan(0);
	const open = css.indexOf('{', at);
	const close = css.indexOf('}', open);
	return css.slice(open + 1, close);
}

/** One millimetre length declared in a block, e.g. `padding: 12mm`. A
 *  multi-value shorthand (`padding: 12mm 10mm`) is refused: the geometry
 *  assumes one margin on every side, and reading the first value alone
 *  would let an asymmetric box pass with a wrong width. */
function mmOf(css: string, selector: string, prop: string): number {
	const m = new RegExp(`${prop}:\\s*([\\d.]+)mm\\s*;`).exec(block(css, selector));
	expect(m, `${selector} { ${prop} } is not one length stated in mm`).not.toBeNull();
	return Number(m![1]);
}

describe('the A4 portrait page geometry matches the page CSS', () => {
	it('is A4 portrait less the printed margin the page carries as padding', () => {
		// The margin is a content padding, not an @page margin: a print
		// dialog can strip the latter (NavLogModal's own comment).
		const pad = mmOf(modal, ':global(html.navlog-paged) .pg-page', 'padding');
		expect(PORTRAIT_PAGE.widthPx).toBeCloseTo(mm(210 - 2 * pad), 6);
		// The height allowance keeps a slack under the box; it must be real
		// but small enough to cost no band (a band runs ~30mm).
		const slackMm = (mm(297 - 2 * pad) - PORTRAIT_PAGE.budgetPx) / PX_PER_MM;
		expect(slackMm).toBeGreaterThan(0);
		expect(slackMm).toBeLessThanOrEqual(5);
	});

	it('prints on the portrait sheet the geometry assumes', () => {
		expect(/@page\s*\{[^}]*size:\s*a4 portrait/i.test(modal)).toBe(true);
		expect(/@page\s*\{[^}]*margin:\s*0/i.test(modal)).toBe(true);
	});

	it('mounts the page document with the rendition prop it was measured at', () => {
		expect(PORTRAIT_PAGE.rendition).toBe('portrait');
		const mount = /<div class="pg-page">\s*<NavLogSheet([\s\S]*?)\/>/.exec(modal);
		expect(mount, 'the paged document mounts no NavLogSheet').not.toBeNull();
		expect(mount![1]).toMatch(/\bportrait\b/);
	});
});

describe('the A5 kneeboard card geometry matches the sheet CSS', () => {
	it('is half a landscape sheet less its padding and central gap', () => {
		const pad = mmOf(modal, ':global(html.navlog-kneeboard) .kb-sheet', 'padding');
		const gap = mmOf(modal, ':global(html.navlog-kneeboard) .kb-sheet', 'gap');
		expect(KNEEBOARD_CARD.widthPx).toBeCloseTo(mm((297 - 2 * pad - gap) / 2), 6);
		expect(KNEEBOARD_CARD.budgetPx).toBeCloseTo(mm(210 - 2 * pad), 6);
		expect(KNEEBOARD_CARD.rendition).toBe('kneeboard');
		// The card's own flex basis states the gap a second time (half of it
		// per card); the geometry is wrong the moment the two disagree.
		const basis = /flex:\s*0 0 calc\(50% - ([\d.]+)mm\)/.exec(
			block(modal, ':global(html.navlog-kneeboard) .kb-card'),
		);
		expect(basis, '.kb-card states no calc(50% - <half gap>) basis').not.toBeNull();
		expect(Number(basis![1])).toBeCloseTo(gap / 2, 6);
	});
});

describe('the schedule prints the layout it is measured at', () => {
	// A continuation part of the A4 schedule must lay its columns out as
	// the full table the parts were measured on: the page rendition pins
	// the table layout, and both the page mount and the measuring mount
	// carry it.
	it('pins the page rendition to a slice-invariant table', () => {
		const b = block(schedule, '.portrait table.nav');
		expect(b).toMatch(/table-layout:\s*fixed/);
		expect(block(schedule, '.portrait .scroll')).toMatch(/overflow:\s*visible/);
	});

	it('mounts the page document and the measuring mount with it', () => {
		const mount = /<div class="pg-page">\s*<NavLogSchedule([\s\S]*?)\/>/.exec(modal);
		expect(mount, 'the paged document mounts no NavLogSchedule').not.toBeNull();
		expect(mount![1]).toMatch(/\bportrait\b/);
		// The measuring mount spreads the geometry's rendition props whole.
		const measuring = /mount\(NavLogSchedule,([\s\S]*?)\}\);/.exec(measure);
		expect(measuring, 'navlogMeasure mounts no NavLogSchedule').not.toBeNull();
		expect(measuring![1]).toMatch(/\.\.\.renditionProps\(geom\)/);
	});
});

describe('the sheet prints the geometry it is measured at', () => {
	// The `.portrait` class exists so the measuring mount renders the print
	// grid ON SCREEN; the @media print block states it for the print that
	// was never prepared. Same declarations, two carriers.
	const declarations = (b: string): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const [, prop, value] of b.matchAll(/([a-z-]+):\s*([^;]+);/g)) {
			out[prop] = value.replace(/\s+/g, ' ').trim();
		}
		return out;
	};
	const printBlock = sheet.slice(sheet.lastIndexOf('@media print'));

	it('states one grid for the page rendition and the print stylesheet', () => {
		const byClass = declarations(block(sheet, '.portrait .navlog'));
		const byMedia = declarations(block(printBlock, '.navlog'));
		expect(byClass['grid-template-columns']).toBeDefined();
		expect(byClass).toEqual(byMedia);
	});

	it('unclips the scroller in both', () => {
		expect(declarations(block(sheet, '.portrait .scroll'))).toEqual(
			declarations(block(printBlock, '.scroll')),
		);
	});
});
